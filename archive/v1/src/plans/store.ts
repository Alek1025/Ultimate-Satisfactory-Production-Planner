/**
 * Plan storage on any KeyValueStore (IndexedDB in the browser, files on desktop).
 *
 * Keys:
 *   plan:<id>        plan without its result (cheap to list)
 *   result:<id>      the plan's last StoredResult
 *   summary:<key>    save summaries, content-addressed and shared by plans
 *   meta:active      id of the plan the user last had open
 *   meta:schema      storage layout version
 */
import type { KeyValueStore } from '../platform/types';
import type { SaveSummary } from '../save/summary-types';
import type { PlanRequest, PlanResult } from '../solver/types';
import { DEFAULT_OBJECTIVE_ORDER } from '../solver/types';
import { SOLVER_VERSION } from '../solver/solve';
import { parseBundle, parsePlan, parseSummary } from './schema';
import { BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, PLAN_SCHEMA_VERSION, type Plan, type PlanBundle, type PlanListing, type StoredResult } from './types';
import { saveRef, summaryKey, withResult } from './versioning';

const STORAGE_LAYOUT = 1;

export interface PlanStoreOptions {
  now?: () => Date;
  newId?: () => string;
}

export interface ImportReport {
  imported: { id: string; name: string; renamedFrom?: string }[];
  skipped: number;
  /** Plain-language notes for the user (dropped results, missing summaries, ...). */
  warnings: string[];
}

export function emptyRequest(): PlanRequest {
  return {
    targets: [], maximize: [], manualInputs: [], excludedNodes: [], rawCaps: [], disabledRecipes: [],
    objectiveOrder: [...DEFAULT_OBJECTIVE_ORDER], budgets: { somersloops: 0, powerShards: 0 },
  };
}

function defaultId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export class PlanStore {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly kv: KeyValueStore, opts: PlanStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? defaultId;
  }

  /** Ask the platform to keep data; returns whether it agreed (undefined if not supported). */
  async init(): Promise<{ persistent: boolean | undefined; warnings: string[] }> {
    const warnings: string[] = [];
    const layout = await this.kv.get<number>('meta:schema');
    if (layout === undefined) await this.kv.set('meta:schema', STORAGE_LAYOUT);
    else if (layout > STORAGE_LAYOUT) warnings.push('Your saved plans were written by a newer version of the planner; some may not load.');
    const persistent = this.kv.requestPersistence ? await this.kv.requestPersistence() : undefined;
    if (persistent === false) warnings.push('The browser did not grant persistent storage, so it may clear saved plans when disk space runs low. Export plans you want to keep.');
    return { persistent, warnings };
  }

  // ---- Summaries

  async putSummary(summary: SaveSummary): Promise<string> {
    const key = summaryKey(summary);
    if ((await this.kv.get(`summary:${key}`)) === undefined) await this.kv.set(`summary:${key}`, summary);
    return key;
  }

  async getSummary(key: string): Promise<SaveSummary | undefined> {
    return this.kv.get<SaveSummary>(`summary:${key}`);
  }

  // ---- Plans

  async createPlan(name: string, summary: SaveSummary, request: PlanRequest = emptyRequest()): Promise<Plan> {
    const key = await this.putSummary(summary);
    const t = this.now().toISOString();
    const plan: Plan = {
      schemaVersion: PLAN_SCHEMA_VERSION, id: this.newId(), name: name.trim() || 'Untitled plan', notes: '',
      createdAt: t, updatedAt: t, save: { ...saveRef(summary), summaryKey: key }, request, solveOptions: {},
    };
    await this.putPlan(plan, { touch: false });
    return plan;
  }

  /** Store a plan (and its result, if any). Bumps updatedAt unless touch is false. */
  async putPlan(plan: Plan, opts: { touch?: boolean } = {}): Promise<Plan> {
    const stored: Plan = opts.touch === false ? plan : { ...plan, updatedAt: this.now().toISOString() };
    const { lastResult, ...bare } = stored;
    await this.kv.set(`plan:${plan.id}`, bare);
    if (lastResult) await this.kv.set(`result:${plan.id}`, lastResult);
    else await this.kv.delete(`result:${plan.id}`);
    return stored;
  }

  async getPlan(id: string): Promise<Plan | undefined> {
    return (await this.loadPlan(id)).plan;
  }

  /** Like getPlan, with the reasons a stored plan couldn't be read (e.g. written by a newer version). */
  async loadPlan(id: string): Promise<{ plan?: Plan; errors: string[]; warnings: string[] }> {
    const raw = await this.kv.get<Plan>(`plan:${id}`);
    if (!raw) return { errors: [`No plan with id ${id}`], warnings: [] };
    const lastResult = await this.kv.get<StoredResult>(`result:${id}`);
    // Stored data may come from another planner version: validate like an import.
    return parsePlan(lastResult ? { ...raw, lastResult } : raw);
  }

  async listPlans(): Promise<PlanListing[]> {
    const out: PlanListing[] = [];
    for (const key of await this.kv.keys('plan:')) {
      const p = await this.kv.get<Plan>(key);
      if (!p) continue;
      const r = await this.kv.get<StoredResult>(`result:${p.id}`);
      out.push({
        id: p.id, name: p.name, updatedAt: p.updatedAt, sessionName: p.save?.sessionName ?? '', saveName: p.save?.saveName ?? '',
        ...(r ? { solvedAt: r.result.provenance.solvedAt, resultStatus: r.result.status } : {}),
      });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async recordResult(id: string, result: PlanResult): Promise<Plan> {
    const plan = await this.requirePlan(id);
    return this.putPlan(withResult(plan, result, this.now()), { touch: false });
  }

  async renamePlan(id: string, name: string): Promise<Plan> {
    const plan = await this.requirePlan(id);
    return this.putPlan({ ...plan, name: name.trim() || plan.name });
  }

  async duplicatePlan(id: string, name?: string): Promise<Plan> {
    const plan = await this.requirePlan(id);
    const t = this.now().toISOString();
    const copy: Plan = { ...structuredClone(plan), id: this.newId(), name: name ?? `${plan.name} (copy)`, createdAt: t, updatedAt: t };
    return this.putPlan(copy, { touch: false });
  }

  async deletePlan(id: string): Promise<void> {
    const plan = await this.kv.get<Plan>(`plan:${id}`);
    await this.kv.delete(`plan:${id}`);
    await this.kv.delete(`result:${id}`);
    if ((await this.getActivePlanId()) === id) await this.kv.delete('meta:active');
    if (plan?.save?.summaryKey) await this.collectSummary(plan.save.summaryKey);
  }

  async getActivePlanId(): Promise<string | undefined> {
    return this.kv.get<string>('meta:active');
  }

  async setActivePlanId(id: string | undefined): Promise<void> {
    if (id === undefined) await this.kv.delete('meta:active');
    else await this.kv.set('meta:active', id);
  }

  /** Delete a summary no plan or stored result references any more. */
  private async collectSummary(key: string): Promise<void> {
    for (const k of await this.kv.keys('plan:')) if ((await this.kv.get<Plan>(k))?.save?.summaryKey === key) return;
    for (const k of await this.kv.keys('result:')) if ((await this.kv.get<StoredResult>(k))?.summaryKey === key) return;
    await this.kv.delete(`summary:${key}`);
  }

  private async requirePlan(id: string): Promise<Plan> {
    const p = await this.getPlan(id);
    if (!p) throw new Error(`No plan with id ${id}`);
    return p;
  }

  // ---- Export / import

  async exportBundle(ids?: string[], opts: { includeSummaries?: boolean; includeResults?: boolean } = {}): Promise<PlanBundle> {
    const includeSummaries = opts.includeSummaries ?? true;
    const includeResults = opts.includeResults ?? true;
    const all = ids ?? (await this.listPlans()).map((p) => p.id);
    const plans: Plan[] = [];
    const summaries: Record<string, SaveSummary> = {};
    for (const id of all) {
      const p = await this.getPlan(id);
      if (!p) continue;
      const plan = includeResults ? p : (({ lastResult: _r, ...rest }) => rest)(p);
      plans.push(plan);
      if (includeSummaries) {
        for (const key of new Set([p.save.summaryKey, ...(includeResults && p.lastResult ? [p.lastResult.summaryKey] : [])])) {
          const s = await this.getSummary(key);
          if (s) summaries[key] = s;
        }
      }
    }
    return { format: BUNDLE_FORMAT, formatVersion: BUNDLE_FORMAT_VERSION, exportedAt: this.now().toISOString(), app: SOLVER_VERSION, plans, summaries };
  }

  /**
   * Import plans from parsed JSON (a bundle or a single plan). Imported plans keep their id
   * unless it is taken by a different plan, in which case they get a new id and " (imported)".
   * Summaries are re-keyed by their content, so an edited summary can't pose as another.
   */
  async importBundle(raw: unknown): Promise<ImportReport> {
    const { bundle, errors, warnings } = parseBundle(raw);
    if (!bundle) throw new PlanImportError(errors[0] ?? 'Unreadable plan file.');
    const report: ImportReport = { imported: [], skipped: warnings.filter((w) => w.startsWith('Skipped plan')).length, warnings: [...warnings] };

    const rekey = new Map<string, string>();
    for (const [key, summary] of Object.entries(bundle.summaries)) {
      const actual = await this.putSummary(summary);
      rekey.set(key, actual);
      if (actual !== key) report.warnings.push(`A save summary in the file did not match its key (edited?); stored as ${actual}. Plans using it will need to be solved again.`);
    }

    for (const p of bundle.plans) {
      const key = rekey.get(p.save.summaryKey) ?? p.save.summaryKey;
      const plan: Plan = { ...p, save: { ...p.save, summaryKey: key } };
      if (!(await this.getSummary(key))) {
        report.warnings.push(`Plan "${p.name}": its save summary isn't in the file or in this planner. Load "${p.save.sessionName}" and re-link the plan before solving.`);
      }
      // A result is tied to the summary it was solved against.
      if (plan.lastResult) {
        const rk = rekey.get(plan.lastResult.summaryKey) ?? plan.lastResult.summaryKey;
        plan.lastResult = { ...plan.lastResult, summaryKey: rk };
      }
      const existing = await this.kv.get<Plan>(`plan:${plan.id}`);
      const samePlan = existing && existing.createdAt === plan.createdAt;
      if (samePlan && existing.updatedAt === plan.updatedAt) {
        report.warnings.push(`Plan "${plan.name}" is already here, unchanged; skipped.`);
        report.skipped++;
      } else if (existing && (!samePlan || existing.updatedAt > plan.updatedAt)) {
        // A different plan with this id, or a local copy edited after the file's: keep both.
        const renamedFrom = plan.id;
        const copy = { ...plan, id: this.newId(), name: `${plan.name} (imported)` };
        await this.putPlan(copy, { touch: false });
        report.imported.push({ id: copy.id, name: copy.name, renamedFrom });
        if (samePlan) report.warnings.push(`Plan "${plan.name}" was edited here after the file was exported, so the file's version was added as a copy.`);
      } else {
        // New here, or the file has a newer version of the same plan.
        await this.putPlan(plan, { touch: false });
        report.imported.push({ id: plan.id, name: plan.name });
      }
    }
    return report;
  }
}

export class PlanImportError extends Error {}

/** Exported for tests and tools: parse a summary from untrusted JSON. */
export { parseSummary };

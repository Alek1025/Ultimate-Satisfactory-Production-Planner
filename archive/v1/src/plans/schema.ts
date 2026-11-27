/**
 * Validation and migration for plan JSON. Anything read from an import file (or from
 * storage written by another version) is untrusted: it is checked field by field and
 * rebuilt, so nothing unexpected reaches the solver or the UI.
 *
 * Migrations: add `migrations[n]` to turn schema n into n+1 and bump PLAN_SCHEMA_VERSION.
 */
import type { SaveSummary } from '../save/summary-types';
import type { ObjectiveKind, PlanRequest, PlanResult, SolveOptions } from '../solver/types';
import { DEFAULT_OBJECTIVE_ORDER } from '../solver/types';
import { BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, PLAN_SCHEMA_VERSION, type Plan, type PlanBundle, type SaveRef, type StoredResult } from './types';

export class PlanFormatError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CLASS = /^[A-Za-z0-9_-]{1,160}$/;
const MAX_LIST = 10_000;

class Reader {
  constructor(readonly path: string, readonly errors: string[]) {}
  at(k: string): Reader { return new Reader(`${this.path}.${k}`, this.errors); }
  fail(msg: string): undefined { this.errors.push(`${this.path}: ${msg}`); return undefined; }
  obj(v: unknown): Obj | undefined { return isObj(v) ? v : this.fail('expected an object'); }
  str(v: unknown, max = 500): string | undefined {
    if (typeof v !== 'string') return this.fail('expected text');
    return v.length > max ? this.fail(`longer than ${max} characters`) : v;
  }
  match(v: unknown, re: RegExp, what: string): string | undefined {
    return typeof v === 'string' && re.test(v) ? v : this.fail(`not a valid ${what}`);
  }
  num(v: unknown, min = -Infinity, max = Infinity): number | undefined {
    if (typeof v !== 'number' || !Number.isFinite(v)) return this.fail('expected a number');
    return v < min || v > max ? this.fail(`out of range [${min}, ${max}]`) : v;
  }
  list(v: unknown): unknown[] | undefined {
    if (!Array.isArray(v)) return this.fail('expected a list');
    return v.length > MAX_LIST ? this.fail(`more than ${MAX_LIST} entries`) : v;
  }
  date(v: unknown): string | undefined {
    return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : this.fail('expected an ISO date');
  }
}

const OBJECTIVES = new Set<string>(DEFAULT_OBJECTIVE_ORDER);

export function parseRequest(raw: unknown, r: Reader): PlanRequest | undefined {
  const o = r.obj(raw);
  if (!o) return undefined;
  const rates = (k: 'targets' | 'manualInputs') => {
    const rr = r.at(k);
    const l = rr.list(o[k] ?? []);
    return (l ?? []).flatMap((e, i) => {
      const er = rr.at(String(i)); const eo = er.obj(e);
      const item = eo && er.at('item').match(eo.item, CLASS, 'item ClassName');
      const rate = eo && er.at('ratePerMin').num(eo.ratePerMin, 0, 1e9);
      return item !== undefined && rate !== undefined ? [{ item, ratePerMin: rate }] : [];
    });
  };
  const items = (k: 'maximize') => (r.at(k).list(o[k] ?? []) ?? []).flatMap((e, i) => {
    const er = r.at(k).at(String(i)); const eo = er.obj(e);
    const item = eo && er.at('item').match(eo.item, CLASS, 'item ClassName');
    return item !== undefined ? [{ item }] : [];
  });
  const strings = (k: 'excludedNodes' | 'disabledRecipes', re: RegExp) => (r.at(k).list(o[k] ?? []) ?? []).flatMap((e, i) => {
    const s = r.at(k).at(String(i)).match(e, re, 'id');
    return s !== undefined ? [s] : [];
  });
  const caps = (r.at('rawCaps').list(o.rawCaps ?? []) ?? []).flatMap((e, i) => {
    const er = r.at('rawCaps').at(String(i)); const eo = er.obj(e);
    const item = eo && er.at('item').match(eo.item, CLASS, 'item ClassName');
    const max = eo && er.at('maxPerMin').num(eo.maxPerMin, 0, 1e9);
    return item !== undefined && max !== undefined ? [{ item, maxPerMin: max }] : [];
  });
  const order = (r.at('objectiveOrder').list(o.objectiveOrder ?? [...DEFAULT_OBJECTIVE_ORDER]) ?? [])
    .filter((k): k is ObjectiveKind => typeof k === 'string' && OBJECTIVES.has(k));
  const b = r.at('budgets').obj(o.budgets ?? { somersloops: 0, powerShards: 0 });
  const budget = (k: 'somersloops' | 'powerShards') => Math.floor(r.at('budgets').at(k).num(b?.[k] ?? 0, 0, 1e7) ?? 0);
  return {
    targets: rates('targets'),
    maximize: items('maximize'),
    manualInputs: rates('manualInputs'),
    excludedNodes: strings('excludedNodes', CLASS),
    rawCaps: caps,
    disabledRecipes: strings('disabledRecipes', CLASS),
    objectiveOrder: order.length ? order : [...DEFAULT_OBJECTIVE_ORDER],
    budgets: { somersloops: budget('somersloops'), powerShards: budget('powerShards') },
  };
}

function parseOptions(raw: unknown, r: Reader): Partial<SolveOptions> {
  const o = raw === undefined ? {} : r.obj(raw);
  if (!o) return {};
  const out: Partial<SolveOptions> = {};
  if (o.integerPass !== undefined) {
    if (o.integerPass === 'auto' || o.integerPass === 'on' || o.integerPass === 'off') out.integerPass = o.integerPass;
    else r.at('integerPass').fail("expected 'auto', 'on' or 'off'");
  }
  if (o.integerTimeLimitSec !== undefined) { const v = r.at('integerTimeLimitSec').num(o.integerTimeLimitSec, 0.1, 600); if (v !== undefined) out.integerTimeLimitSec = v; }
  if (o.mipRelGap !== undefined) { const v = r.at('mipRelGap').num(o.mipRelGap, 0, 1); if (v !== undefined) out.mipRelGap = v; }
  return out;
}

function parseSaveRef(raw: unknown, r: Reader): SaveRef | undefined {
  const o = r.obj(raw);
  if (!o) return undefined;
  const summaryKey = r.at('summaryKey').match(o.summaryKey, /^[A-Za-z0-9_-]{1,80}$/, 'summary key');
  const saveIdentifier = r.at('saveIdentifier').str(o.saveIdentifier ?? '', 200);
  const saveName = r.at('saveName').str(o.saveName ?? '', 300);
  const sessionName = r.at('sessionName').str(o.sessionName ?? '', 300);
  const buildVersion = r.at('buildVersion').num(o.buildVersion, 0, 1e9);
  const saveVersion = r.at('saveVersion').num(o.saveVersion, 0, 1e6);
  const savedAt = r.at('savedAt').str(o.savedAt ?? '', 64);
  if ([summaryKey, saveIdentifier, saveName, sessionName, buildVersion, saveVersion, savedAt].includes(undefined)) return undefined;
  return { summaryKey: summaryKey!, saveIdentifier: saveIdentifier!, saveName: saveName!, sessionName: sessionName!, buildVersion: buildVersion!, saveVersion: saveVersion!, savedAt: savedAt! };
}

/**
 * Results are large and only displayed (never fed back into the solver), so they get a
 * structural check rather than a full rebuild; anything off drops the result, never the plan.
 */
function parseResult(raw: unknown, r: Reader, warnings: string[]): StoredResult | undefined {
  const errs: string[] = [];
  const rr = new Reader(r.path, errs);
  const o = rr.obj(raw);
  const res = o && rr.at('result').obj(o.result);
  const requestHashOk = o && rr.at('requestHash').match(o.requestHash, /^[0-9a-f]{1,32}$/, 'hash');
  const summaryKeyOk = o && rr.at('summaryKey').match(o.summaryKey, /^[A-Za-z0-9_-]{1,80}$/, 'summary key');
  if (res) {
    if (res.schemaVersion !== 1) rr.at('result.schemaVersion').fail('unsupported result version');
    for (const k of ['levels', 'buildings', 'extraction', 'items', 'resources', 'explanation', 'assumptions', 'warnings']) {
      if (!Array.isArray(res[k])) rr.at(`result.${k}`).fail('expected a list');
    }
    const prov = rr.at('result.provenance').obj(res.provenance);
    if (prov) {
      rr.at('result.provenance.gameDataHash').str(prov.gameDataHash, 64);
      rr.at('result.provenance.saveBuild').num(prov.saveBuild, 0, 1e9);
      rr.at('result.provenance.solver').str(prov.solver, 200);
      rr.at('result.provenance.solvedAt').date(prov.solvedAt);
    }
    if (!['optimal', 'targets-not-met', 'unbounded', 'error'].includes(res.status as string)) rr.at('result.status').fail('unknown status');
  }
  if (errs.length || !res || !requestHashOk || !summaryKeyOk) {
    warnings.push(`Dropped the stored result (${errs[0] ?? 'unreadable'}); solve the plan again.`);
    return undefined;
  }
  return { result: res as unknown as PlanResult, requestHash: requestHashOk, summaryKey: summaryKeyOk };
}

/** Migrate and validate one plan. Errors mean the plan can't be used; warnings are for the user. */
export function parsePlan(raw: unknown): { plan?: Plan; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const r = new Reader('plan', errors);
  let o = r.obj(raw);
  if (!o) return { errors, warnings };
  const v = o.schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return { errors: [`plan: unknown schema version ${String(v)}`], warnings };
  if (v > PLAN_SCHEMA_VERSION) return { errors: [`plan: made by a newer version of the planner (schema ${v}; this version reads up to ${PLAN_SCHEMA_VERSION}).`], warnings };
  for (let n = v; n < PLAN_SCHEMA_VERSION; n++) {
    const m = migrations[n];
    if (!m) return { errors: [`plan: no migration from schema ${n}`], warnings };
    o = m(o, warnings);
  }
  const id = r.at('id').match(o.id, ID, 'plan id');
  const name = r.at('name').str(o.name, 200);
  const notes = r.at('notes').str(o.notes ?? '', 20_000);
  const createdAt = r.at('createdAt').date(o.createdAt);
  const updatedAt = r.at('updatedAt').date(o.updatedAt);
  const save = parseSaveRef(o.save, r.at('save'));
  const request = parseRequest(o.request, r.at('request'));
  const solveOptions = parseOptions(o.solveOptions, r.at('solveOptions'));
  if (errors.length || [id, name, notes, createdAt, updatedAt, save, request].includes(undefined)) return { errors, warnings };
  const plan: Plan = {
    schemaVersion: PLAN_SCHEMA_VERSION, id: id!, name: name!, notes: notes!, createdAt: createdAt!, updatedAt: updatedAt!,
    save: save!, request: request!, solveOptions,
  };
  if (o.lastResult !== undefined) {
    const lr = parseResult(o.lastResult, r.at('lastResult'), warnings);
    if (lr) plan.lastResult = lr;
  }
  return { plan, errors, warnings };
}

/** schema n -> n+1. None yet: version 1 is the first. */
const migrations: Record<number, (o: Obj, warnings: string[]) => Obj> = {};

const NODE_KINDS = new Set(['resource-node', 'well-satellite', 'well-core', 'geyser']);
const PURITIES = new Set(['impure', 'normal', 'pure']);

/**
 * Save summaries feed the solver, so they are checked for every field the planning
 * problem reads; other fields are carried through as data.
 */
export function parseSummary(raw: unknown, path = 'summary'): { summary?: SaveSummary; errors: string[] } {
  const errors: string[] = [];
  const r = new Reader(path, errors);
  const o = r.obj(raw);
  if (!o) return { errors };
  if (o.schemaVersion !== 1) return { errors: [`${path}: unsupported summary version ${String(o.schemaVersion)}`] };
  const src = r.at('source').obj(o.source);
  if (src) {
    for (const k of ['saveName', 'sessionName', 'saveIdentifier', 'savedAt', 'engine', 'branch']) r.at(`source.${k}`).str(src[k] ?? '', 500);
    for (const k of ['buildVersion', 'saveVersion', 'headerVersion']) r.at(`source.${k}`).num(src[k], 0, 1e9);
  }
  const ver = r.at('version').obj(o.version);
  if (ver && ver.status !== 'supported' && ver.status !== 'warning') r.at('version.status').fail('unknown');
  const prog = r.at('progression').obj(o.progression);
  if (prog) {
    for (const k of ['unlockedRecipes', 'milestones', 'mamResearch', 'alternateSchematics', 'unlockedAlternateRecipes']) {
      const l = r.at(`progression.${k}`).list(prog[k]);
      if (l && !l.every((s) => typeof s === 'string' && CLASS.test(s))) r.at(`progression.${k}`).fail('expected ClassNames');
    }
    for (const k of ['overclockUnlocked', 'productionBoostUnlocked']) if (typeof prog[k] !== 'boolean') r.at(`progression.${k}`).fail('expected true/false');
  }
  const h = r.at('holdings').obj(o.holdings);
  if (h) {
    for (const k of ['somersloops', 'powerShards']) { const x = r.at(`holdings.${k}`).obj(h[k]); if (x) r.at(`holdings.${k}.total`).num(x.total, 0, 1e9); }
    const sl = r.at('holdings.powerSlugs').obj(h.powerSlugs);
    if (sl) r.at('holdings.powerSlugs.shardEquivalent').num(sl.shardEquivalent, 0, 1e9);
  }
  const nodes = r.at('nodes').list(o.nodes);
  nodes?.forEach((n, i) => {
    const nr = r.at(`nodes.${i}`);
    const no = nr.obj(n);
    if (!no) return;
    nr.at('id').match(no.id, CLASS, 'node id');
    if (!NODE_KINDS.has(no.kind as string)) nr.at('kind').fail('unknown node kind');
    const pos = no.position;
    if (!Array.isArray(pos) || pos.length !== 3 || !pos.every((x) => typeof x === 'number' && Number.isFinite(x))) nr.at('position').fail('expected [x, y, z]');
    if (no.purityOverride !== undefined && !PURITIES.has(no.purityOverride as string)) nr.at('purityOverride').fail('unknown purity');
    if (no.resourceOverride !== undefined) nr.at('resourceOverride').match(no.resourceOverride, CLASS, 'ClassName');
  });
  for (const k of ['assumptions', 'warnings']) {
    const l = r.at(k).list(o[k] ?? []);
    if (l && !l.every((s) => typeof s === 'string')) r.at(k).fail('expected text');
  }
  if (!isObj(o.gameMode)) r.at('gameMode').fail('expected an object');
  return errors.length ? { errors } : { summary: o as unknown as SaveSummary, errors };
}

/** Accepts a bundle or a single bare plan (with no summaries). */
export function parseBundle(raw: unknown): { bundle?: PlanBundle; errors: string[]; warnings: string[] } {
  if (isObj(raw) && raw.format === undefined && raw.schemaVersion !== undefined) {
    raw = { format: BUNDLE_FORMAT, formatVersion: BUNDLE_FORMAT_VERSION, exportedAt: new Date(0).toISOString(), app: 'unknown', plans: [raw], summaries: {} };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw) || raw.format !== BUNDLE_FORMAT) return { errors: ['Not a Satisfactory Planner plan file.'], warnings };
  if (typeof raw.formatVersion !== 'number' || raw.formatVersion > BUNDLE_FORMAT_VERSION) {
    return { errors: [`Plan file format ${String(raw.formatVersion)} is from a newer version of the planner.`], warnings };
  }
  const r = new Reader('file', errors);
  const plansRaw = r.at('plans').list(raw.plans) ?? [];
  const plans: Plan[] = [];
  plansRaw.forEach((p, i) => {
    const res = parsePlan(p);
    const name = isObj(p) && typeof p.name === 'string' ? `"${p.name.slice(0, 60)}"` : `#${i + 1}`;
    if (res.plan) { plans.push(res.plan); warnings.push(...res.warnings.map((w) => `Plan ${name}: ${w}`)); }
    else warnings.push(`Skipped plan ${name}: ${res.errors[0]}`);
  });
  const summaries: Record<string, SaveSummary> = {};
  const sr = isObj(raw.summaries) ? raw.summaries : {};
  for (const [k, v] of Object.entries(sr)) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(k)) { warnings.push('Skipped a save summary with an invalid key.'); continue; }
    const s = parseSummary(v, `summaries.${k}`);
    if (s.summary) summaries[k] = s.summary; else warnings.push(`Skipped save summary ${k}: ${s.errors[0]}`);
  }
  return {
    bundle: {
      format: BUNDLE_FORMAT, formatVersion: BUNDLE_FORMAT_VERSION,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '', app: typeof raw.app === 'string' ? raw.app.slice(0, 100) : '',
      plans, summaries,
    },
    errors, warnings,
  };
}

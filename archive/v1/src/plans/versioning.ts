/**
 * Plan versioning: does a stored result still answer the plan's request against the
 * game data and save that are loaded now?
 */
import type { GameData } from '../gamedata/types';
import type { SaveSummary } from '../save/summary-types';
import type { PlanResult, SolveOptions, PlanRequest } from '../solver/types';
import { SOLVER_VERSION } from '../solver/solve';
import { hashValue } from '../util/hash';
import type { Freshness, Plan, SaveRef, StaleReason } from './types';

export function requestHash(request: PlanRequest, options: Partial<SolveOptions>): string {
  return hashValue({ request, options });
}

/** Content key for a save summary: same save state -> same key, so plans share it. */
export function summaryKey(summary: SaveSummary): string {
  const id = (summary.source.saveIdentifier || summary.source.sessionName || 'save').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'save';
  return `${id}-${hashValue(summary)}`;
}

export function saveRef(summary: SaveSummary): SaveRef {
  return {
    summaryKey: summaryKey(summary),
    saveIdentifier: summary.source.saveIdentifier,
    saveName: summary.source.saveName,
    sessionName: summary.source.sessionName,
    buildVersion: summary.source.buildVersion,
    saveVersion: summary.source.saveVersion,
    savedAt: summary.source.savedAt,
  };
}

export interface FreshnessContext {
  /** contentHash of the game data loaded now. */
  gameDataHash: string;
  solverVersion?: string;
}

export function checkFreshness(plan: Plan, ctx: FreshnessContext): Freshness {
  const lr = plan.lastResult;
  if (!lr) return { state: 'never-solved', reasons: ['never-solved'], messages: ['This plan has not been solved yet.'] };
  const reasons: StaleReason[] = [];
  const messages: string[] = [];
  const p = lr.result.provenance;
  if (lr.requestHash !== requestHash(plan.request, plan.solveOptions)) {
    reasons.push('request-changed');
    messages.push('The request changed since this plan was solved; solve again to update the result.');
  }
  if (p.gameDataHash !== ctx.gameDataHash) {
    reasons.push('game-data-changed');
    messages.push(`This result was solved against different game data (${p.gameDataHash}, loaded now: ${ctx.gameDataHash}), e.g. after a game update. Recipes or rates may have changed; solve again.`);
  }
  if (lr.summaryKey !== plan.save.summaryKey) {
    reasons.push('save-changed');
    messages.push(`This result was solved against an earlier state of "${plan.save.sessionName}"; unlocks, holdings or nodes may differ. Solve again.`);
  } else if (p.saveBuild !== plan.save.buildVersion) {
    reasons.push('save-changed');
    messages.push(`This result was solved against save build ${p.saveBuild}; the plan's save is build ${plan.save.buildVersion}. Solve again.`);
  }
  const solver = ctx.solverVersion ?? SOLVER_VERSION;
  if (!p.solver.startsWith(solver)) {
    reasons.push('solver-changed');
    messages.push(`Solved by an older planner version (${p.solver}); results may differ slightly if solved again.`);
  }
  return { state: reasons.length ? 'stale' : 'fresh', reasons, messages };
}

/** Attach a fresh result to a plan (returns a new plan object). */
export function withResult(plan: Plan, result: PlanResult, now: Date): Plan {
  return {
    ...plan,
    updatedAt: now.toISOString(),
    lastResult: { result, requestHash: requestHash(plan.request, plan.solveOptions), summaryKey: plan.save.summaryKey },
  };
}

/**
 * Point a plan at a newer summary (e.g. the user saved again). The old result stays but
 * becomes stale. Returns warnings when the summary looks like a different save.
 */
export function rebasePlan(plan: Plan, summary: SaveSummary, now: Date): { plan: Plan; warnings: string[] } {
  const ref = saveRef(summary);
  const warnings: string[] = [];
  if (plan.save.saveIdentifier && ref.saveIdentifier && plan.save.saveIdentifier !== ref.saveIdentifier) {
    warnings.push(`"${ref.sessionName}" looks like a different save than "${plan.save.sessionName}" (different save identifier).`);
  } else if (plan.save.sessionName !== ref.sessionName) {
    warnings.push(`Session name changed from "${plan.save.sessionName}" to "${ref.sessionName}".`);
  }
  if (ref.buildVersion !== plan.save.buildVersion) warnings.push(`Game build changed from ${plan.save.buildVersion} to ${ref.buildVersion}.`);
  return { plan: { ...plan, save: ref, updatedAt: now.toISOString() }, warnings };
}

/** Requested items the loaded game data no longer knows (e.g. after a game update). */
export function unknownItems(plan: Plan, gd: GameData): string[] {
  const r = plan.request;
  const items = [...r.targets, ...r.maximize, ...r.manualInputs, ...r.rawCaps].map((x) => x.item);
  return [...new Set(items)].filter((i) => !gd.items.has(i));
}

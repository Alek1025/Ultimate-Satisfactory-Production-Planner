/**
 * Planner entry point. Runs only on the targets the player entered:
 *
 *   validate -> reachability -> LP (lexicographic) -> optional integer pass
 *   -> diagnosis if targets are short -> results + plain-language explanation
 *
 * Every lexicographic level (and the diagnosis) is a stage. After each stage the current
 * solution is a valid plan that is optimal for the levels solved so far, so `onStage`
 * gets a full PlanResult snapshot; the SolverPort keeps the last one to answer
 * "Partial · stage k of n" when a solve is cancelled or times out.
 *
 * Engine failures (HiGHS errors, WASM traps, an LP the formulation says can't be
 * infeasible coming back infeasible) throw SolverFailure. They never become a plan status.
 */
import type { LevelResult, PlanningProblem, PlanRequest, PlanResult, SolveOptions, StageProgress } from './types';
import { DEFAULT_SOLVE_OPTIONS } from './types';
import type { LpBackend } from './lp/types';
import { validateRequest, type EffectiveRequest } from './validate';
import { analyzeReachability, type Reachability } from './reachability';
import { buildModel, isUnit, type BuiltModel, type UnitCol } from './model';
import { objectiveLevels } from './objectives';
import { solveLexicographic, type LexOutcome, type LexStage } from './lexicographic';
import { extractResult } from './result';
import { diagnose } from './diagnose';
import { explain, makeLabel, type Label } from './explain';
import { SolverFailure } from './errors';

/** Bump when a change to the solver can change a result; it is part of the dispatch fingerprint. */
export const SOLVER_VERSION = 'ussp-solver 0.2';

export type StagePass = 'lp' | 'integer' | 'diagnosis';

/** One finished stage, with the plan as it stands after it. */
export interface StageReport {
  /** 1-based. */
  index: number;
  /** Stages known so far (see StageProgress). */
  total: number;
  pass: StagePass;
  /** The objective level this stage solved; null for the hidden tie-break and the diagnosis. */
  level: LevelResult | null;
  /** The plan after this stage. Null only if no level has needed a solve yet. */
  result: PlanResult | null;
}

export interface SolveHooks {
  /** Called once the stage count is known, before the first stage. */
  onPlan?: (progress: StageProgress) => void;
  /** Called after every stage. Throwing from it stops the solve (the error propagates). */
  onStage?: (stage: StageReport) => void | Promise<void>;
  /** Overrides the wall clock in result provenance (tests, reproducible runs). */
  now?: () => Date;
}

/**
 * Solve one plan in this thread. Returns the finished PlanResult; throws SolverFailure on
 * engine failure. The app calls this through a SolverPort (normally the solver process);
 * tests and the CLI's --in-process mode may call it directly.
 */
export async function solvePlan(
  problem: PlanningProblem, request: PlanRequest, backend: LpBackend,
  options: Partial<SolveOptions> = {}, label: Label = makeLabel(), hooks: SolveHooks = {},
): Promise<PlanResult> {
  const opts = { ...DEFAULT_SOLVE_OPTIONS, ...options };
  const provenance = {
    gameDataHash: problem.provenance.gameDataHash, saveBuild: problem.provenance.saveBuild,
    solvedAt: (hooks.now?.() ?? new Date()).toISOString(), solver: `${SOLVER_VERSION} / ${backend.name}`,
  };
  const assumptions = [...problem.assumptions];
  const warnings = [...problem.warnings];

  const v = validateRequest(problem, request, label);
  warnings.push(...v.warnings);
  if (v.errors.length) return invalidResult(v.request, provenance, assumptions, warnings, v.errors);
  const req = v.request;

  const reach = analyzeReachability(problem, req, label);
  const variants = { allowShards: req.budgets.powerShards > 0, allowSloops: req.budgets.somersloops > 0 };
  if (variants.allowShards || variants.allowSloops) {
    assumptions.push(`Overclocking uses clock steps of 100% + ${problem.overclock.perShard * 100}% per Power Shard (max ${problem.overclock.maxShards} shards); in-between clocks need the same shards as the next step, so they never come out ahead.`);
  }

  const levels = objectiveLevels(problem, req);
  const progress: StageProgress = { done: 0, total: levels.length * (opts.integerPass === 'on' ? 2 : 1) };
  const ctx: Ctx = { problem, req, reach, label, provenance, assumptions, warnings, progress };
  hooks.onPlan?.({ ...progress });

  const stage = (pass: 'lp' | 'integer', model: BuiltModel, prior: LevelResult[]) => async (s: LexStage) => {
    progress.done++;
    if (!hooks.onStage) return;
    const levelsSoFar = [...prior, ...(s.level ? [s.level] : [])];
    const result = s.x ? assemble(ctx, model, s.x, pass, levelsSoFar, 'partial') : null;
    await hooks.onStage({ index: progress.done, total: progress.total, pass, level: s.level, result });
  };

  // ---- LP pass
  const lpModel = buildModel(problem, req, reach, { integer: false, variants });
  const lpLevels: LevelResult[] = [];
  const lp = await solveLexicographic(backend, lpModel, levels, {
    onStage: async (s) => { await stage('lp', lpModel, [...lpLevels])(s); if (s.level) lpLevels.push(s.level); },
  });
  if (lp.status === 'error' || lp.status === 'infeasible' || (!lp.x && lp.status !== 'unbounded')) {
    // The model always has a feasible point (all shortfall), so "infeasible" here is a
    // numerical or engine fault, not a fact about the plan.
    throw new SolverFailure('solver-error', `HiGHS failed on the LP pass (${lp.status}${lp.message ? `: ${lp.message}` : ''}).`);
  }
  if (!lp.x) {
    // The very first level is unbounded: nothing was solved that could be reported.
    progress.total = progress.done;
    return emptyResult(ctx, 'unbounded', lp.levels, [`The first objective level is unbounded: ${lp.levels.at(-1)?.item ? label(lp.levels.at(-1)!.item!) : 'it'} only needs unlimited sources, so it has no maximum.`]);
  }

  let model: BuiltModel = lpModel;
  let outcome: LexOutcome = lp;
  let pass: PlanResult['pass'] = 'lp';
  let extracted = extractResult(problem, req, lpModel, lp.x);

  // ---- Integer pass
  const wantInteger = lp.status !== 'unbounded'
    && (opts.integerPass === 'on' || (opts.integerPass === 'auto' && extracted.roundingViolations.length > 0));
  if (wantInteger) {
    if (opts.integerPass !== 'on') progress.total += levels.length;
    const support = integerSupport(lpModel, lp.x);
    const intModel = buildModel(problem, req, reach, { integer: true, support, variants });
    const ipLevels: LevelResult[] = [];
    const ip = await solveLexicographic(backend, intModel, levels, {
      timeLimitSec: opts.integerTimeLimitSec, mipRelGap: opts.mipRelGap,
      onStage: async (s) => {
        // Integer solves have no duals: carry each level's binding limits over from the LP.
        if (s.level && !s.level.binding.length) {
          const lpl = lp.levels.find((l) => l.kind === s.level!.kind && l.item === s.level!.item);
          if (lpl) s.level.binding = lpl.binding;
        }
        await stage('integer', intModel, [...ipLevels])(s);
        if (s.level) ipLevels.push(s.level);
      },
    });
    if (ip.x && (ip.status === 'optimal' || ip.status === 'time-limit')) {
      model = intModel; outcome = ip; pass = 'integer';
      extracted = extractResult(problem, req, intModel, ip.x);
      assumptions.push('The integer pass makes whole numbers of boosted (Somersloop/shard) buildings and extractors, using the recipes and boost levels the LP chose (each recipe can also fall back to unboosted) and every extractor option for the raw resources it used. Other buildings stay fractional and are rounded up. A different mix of recipes or boost levels could in rare cases come out slightly ahead.');
      const lpShort = lp.levels.find((l) => l.kind === 'targets')?.value ?? 0;
      const ipShort = ip.levels.find((l) => l.kind === 'targets')?.value ?? 0;
      if (ipShort > lpShort + 1e-6) warnings.push('Whole-building limits (Somersloops, shards or nodes per building) leave the targets slightly further from met than the fractional plan.');
    } else {
      warnings.push(`The integer pass did not finish (${ip.status}${ip.message ? `: ${ip.message}` : ''}); this is the fractional LP plan with counts rounded up.`);
    }
  }
  if (pass === 'lp' && extracted.roundingViolations.length) {
    warnings.push(`Rounding fractional buildings up goes over a limit; the integer pass gives exact whole-building counts. ${extracted.roundingViolations.join(' ')}`);
  }

  // ---- Diagnosis
  const x = outcome.x!;
  const shortfalls = shortfallsOf(model, req, x);
  const unreachableMax = req.maximize.filter((i) => !reach.reachable.has(i));
  let infeasibility: PlanResult['infeasibility'];
  if (shortfalls.length || unreachableMax.length) {
    progress.total += 1;
    const binding = lp.levels.find((l) => l.kind === 'targets')?.binding ?? [];
    const d = await diagnose(backend, problem, req, reach, shortfalls, binding);
    infeasibility = d.infeasibility;
    if (d.warning) warnings.push(d.warning);
    progress.done++;
  }

  // Stages that never ran (an unbounded level, an integer pass that stopped early) are
  // dropped from the count: a finished result always reads "stage n of n".
  progress.total = progress.done;
  const final = assemble(ctx, model, x, pass, outcome.levels, outcome.status === 'optimal' ? 'proven' : 'unproven', infeasibility,
    outcome.status === 'unbounded' ? 'unbounded' : undefined);
  if (infeasibility && hooks.onStage) {
    await hooks.onStage({ index: progress.done, total: progress.total, pass: 'diagnosis', level: null, result: final });
  }
  return final;
}

interface Ctx {
  problem: PlanningProblem;
  req: EffectiveRequest;
  reach: Reachability;
  label: Label;
  provenance: PlanResult['provenance'];
  assumptions: string[];
  warnings: string[];
  progress: StageProgress;
}

function shortfallsOf(m: BuiltModel, req: EffectiveRequest, x: Float64Array) {
  return [...m.shortfallCol].filter(([item, c]) => x[c]! > Math.max(1e-6, 1e-6 * req.targets.get(item)!)).map(([item, c]) => {
    const target = req.targets.get(item)!;
    return { item, target, achieved: target - x[c]! };
  });
}

/** Builds a PlanResult from a solution vector: a stage snapshot or the final answer. */
function assemble(
  ctx: Ctx, m: BuiltModel, x: Float64Array, pass: PlanResult['pass'], levels: LevelResult[],
  proof: 'partial' | 'proven' | 'unproven', infeasibility?: PlanResult['infeasibility'], forceStatus?: 'unbounded',
): PlanResult {
  const { roundingViolations: _rv, ...parts } = extractResult(ctx.problem, ctx.req, m, x);
  const short = shortfallsOf(m, ctx.req, x).length > 0;
  const status: PlanResult['status'] = forceStatus ?? (short ? 'targets-not-met' : 'optimal');
  const base: Omit<PlanResult, 'explanation'> = {
    schemaVersion: 1, status, pass, provenOptimal: proof === 'proven',
    stage: { ...ctx.progress },
    levels: levels.map((l) => ({ ...l, binding: [...l.binding] })), ...parts,
    ...(infeasibility ? { infeasibility } : {}),
    assumptions: [...ctx.assumptions], warnings: [...ctx.warnings], provenance: ctx.provenance,
  };
  return { ...base, explanation: explain(ctx.problem, ctx.req, base, ctx.label) };
}

/**
 * Keys the integer pass may use: the recipe variants the LP chose plus each used recipe's
 * plain (no Somersloop, no shard) variant as a fallback, and every extraction variant
 * for the raw resources the LP used. The LP has already picked where boosting pays off;
 * the integer pass only decides whole counts, which keeps it to a few seconds.
 */
function integerSupport(m: BuiltModel, x: Float64Array): Set<string> {
  const recipes = new Set<string>();
  const resources = new Set<string>();
  const keys = new Set<string>();
  for (const u of m.units) {
    if (x[u]! <= 1e-7) continue;
    const c = m.cols[u] as UnitCol;
    if (c.kind === 'recipe') { recipes.add(c.recipe.id); keys.add(c.key); } else resources.add(c.resource);
  }
  for (const c of m.cols) {
    if (!isUnit(c)) continue;
    if (c.kind === 'recipe') { if (recipes.has(c.recipe.id) && c.variant.sloops === 0 && c.variant.shards === 0) keys.add(c.key); }
    else if (resources.has(c.resource)) keys.add(c.key);
  }
  return keys;
}

const EMPTY_BUDGET = { budget: 0, available: 0, used: 0, where: [] };

function emptyResult(ctx: Ctx, status: 'unbounded', levels: LevelResult[], explanation: string[]): PlanResult {
  return {
    schemaVersion: 1, status, pass: 'lp', provenOptimal: false, stage: { ...ctx.progress }, levels,
    buildings: [], extraction: [], items: [], power: { linearMW: 0, actualMW: 0 }, buildingCount: 0,
    budgets: {
      somersloops: { ...EMPTY_BUDGET, budget: ctx.req.budgets.somersloops, available: ctx.problem.holdings.somersloops },
      powerShards: { ...EMPTY_BUDGET, budget: ctx.req.budgets.powerShards, available: ctx.problem.holdings.powerShards },
    },
    resources: [], explanation, assumptions: ctx.assumptions, warnings: ctx.warnings, provenance: ctx.provenance,
  };
}

function invalidResult(
  req: EffectiveRequest, provenance: PlanResult['provenance'], assumptions: string[], warnings: string[], errors: string[],
): PlanResult {
  return {
    schemaVersion: 1, status: 'invalid-request', pass: 'lp', provenOptimal: false, stage: { done: 0, total: 0 }, levels: [],
    buildings: [], extraction: [], items: [], power: { linearMW: 0, actualMW: 0 }, buildingCount: 0,
    budgets: { somersloops: { ...EMPTY_BUDGET, budget: req.budgets.somersloops }, powerShards: { ...EMPTY_BUDGET, budget: req.budgets.powerShards } },
    resources: [], explanation: errors, assumptions, warnings, provenance,
  };
}

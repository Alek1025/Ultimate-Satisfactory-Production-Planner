/**
 * Planner entry point:
 *
 *   validate -> reachability -> LP (lexicographic) -> optional integer pass
 *   -> diagnosis if targets are short -> results + plain-language explanation
 */
import type { PlanningProblem, PlanRequest, PlanResult, SolveOptions } from './types';
import { DEFAULT_SOLVE_OPTIONS } from './types';
import type { LpBackend } from './lp/types';
import { validateRequest, type EffectiveRequest } from './validate';
import { analyzeReachability } from './reachability';
import { buildModel, isUnit, type BuiltModel, type UnitCol } from './model';
import { objectiveLevels } from './objectives';
import { solveLexicographic, type LexOutcome } from './lexicographic';
import { extractResult } from './result';
import { diagnose } from './diagnose';
import { explain, makeLabel, type Label } from './explain';

export const SOLVER_VERSION = 'planner-solver 0.1';

export async function solvePlan(
  problem: PlanningProblem, request: PlanRequest, backend: LpBackend,
  options: Partial<SolveOptions> = {}, label: Label = makeLabel(),
): Promise<PlanResult> {
  const opts = { ...DEFAULT_SOLVE_OPTIONS, ...options };
  const provenance = { gameDataHash: problem.provenance.gameDataHash, saveBuild: problem.provenance.saveBuild, solvedAt: new Date().toISOString(), solver: `${SOLVER_VERSION} / ${backend.name}` };
  const assumptions = [...problem.assumptions];
  const warnings = [...problem.warnings];

  const v = validateRequest(problem, request, label);
  warnings.push(...v.warnings);
  if (v.errors.length) return errorResult(v.request, provenance, assumptions, warnings, v.errors);
  const req = v.request;

  const reach = analyzeReachability(problem, req, label);
  const variants = { allowShards: req.budgets.powerShards > 0, allowSloops: req.budgets.somersloops > 0 };
  if (variants.allowShards || variants.allowSloops) {
    assumptions.push(`Overclocking uses clock steps of 100% + ${problem.overclock.perShard * 100}% per Power Shard (max ${problem.overclock.maxShards} shards); in-between clocks need the same shards as the next step, so they are never better.`);
  }

  // ---- LP pass
  const lpModel = buildModel(problem, req, reach, { integer: false, variants });
  const levels = objectiveLevels(problem, req);
  const lp = await solveLexicographic(backend, lpModel, levels);
  if (!lp.x) {
    return errorResult(req, provenance, assumptions, warnings, [`The LP solver failed (${lp.status}${lp.message ? `: ${lp.message}` : ''}).`], lp);
  }

  let model: BuiltModel = lpModel;
  let outcome: LexOutcome = lp;
  let pass: PlanResult['pass'] = 'lp';
  let extracted = extractResult(problem, req, lpModel, lp.x);

  // ---- Integer pass
  const wantInteger = opts.integerPass === 'on' || (opts.integerPass === 'auto' && extracted.roundingViolations.length > 0);
  if (wantInteger) {
    const support = integerSupport(lpModel, lp.x);
    const intModel = buildModel(problem, req, reach, { integer: true, support, variants });
    const ip = await solveLexicographic(backend, intModel, levels, { timeLimitSec: opts.integerTimeLimitSec, mipRelGap: opts.mipRelGap });
    if (ip.x && (ip.status === 'optimal' || ip.status === 'time-limit')) {
      // Integer solves have no duals: carry each level's binding limits over from the LP.
      ip.levels.forEach((l, i) => { const lpl = lp.levels[i]; if (lpl && lpl.kind === l.kind && lpl.item === l.item && !l.binding.length) l.binding = lpl.binding; });
      model = intModel; outcome = ip; pass = 'integer';
      extracted = extractResult(problem, req, intModel, ip.x);
      assumptions.push('The integer pass makes whole numbers of boosted (Somersloop/shard) buildings and extractors, using the recipes and boost levels the LP chose (each recipe can also fall back to unboosted) and every extractor option for the raw resources it used. Other buildings stay fractional and are rounded up. This keeps it fast; a different mix of recipes or boost levels could in rare cases be slightly better.');
      const lpShort = lp.levels.find((l) => l.kind === 'targets')?.value ?? 0;
      const ipShort = ip.levels.find((l) => l.kind === 'targets')?.value ?? 0;
      if (ipShort > lpShort + 1e-6) warnings.push('Whole-building limits (Somersloops, shards or nodes per building) make the targets slightly harder to meet than the fractional plan suggested.');
    } else {
      warnings.push(`Integer pass did not finish (${ip.status}${ip.message ? `: ${ip.message}` : ''}); showing the fractional LP plan with counts rounded up.`);
    }
  }
  if (pass === 'lp' && extracted.roundingViolations.length) {
    warnings.push(`Rounding fractional buildings up exceeds a limit; turn on the integer pass for exact whole-building counts. ${extracted.roundingViolations.join(' ')}`);
  }

  // ---- Diagnosis
  const x = outcome.x!;
  const shortfalls = [...model.shortfallCol].filter(([item, c]) => x[c]! > Math.max(1e-6, 1e-6 * req.targets.get(item)!)).map(([item, c]) => {
    const target = req.targets.get(item)!;
    return { item, target, achieved: target - x[c]! };
  });
  const unreachableMax = req.maximize.filter((i) => !reach.reachable.has(i));
  let infeasibility: PlanResult['infeasibility'];
  if (shortfalls.length || unreachableMax.length) {
    const binding = lp.levels.find((l) => l.kind === 'targets')?.binding ?? [];
    infeasibility = await diagnose(backend, problem, req, reach, shortfalls, binding);
  }

  const status: PlanResult['status'] = outcome.status === 'unbounded' ? 'unbounded' : shortfalls.length ? 'targets-not-met' : 'optimal';
  const { roundingViolations: _rv, ...parts } = extracted;
  const base: Omit<PlanResult, 'explanation'> = {
    schemaVersion: 1, status, pass, provenOptimal: outcome.status === 'optimal',
    levels: outcome.levels, ...parts,
    ...(infeasibility ? { infeasibility } : {}),
    assumptions, warnings, provenance,
  };
  return { ...base, explanation: explain(problem, req, base, label) };
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

function errorResult(
  req: EffectiveRequest, provenance: PlanResult['provenance'], assumptions: string[], warnings: string[], errors: string[], lex?: LexOutcome,
): PlanResult {
  const empty = { budget: 0, available: 0, used: 0, where: [] };
  return {
    schemaVersion: 1, status: 'error', pass: 'lp', provenOptimal: false, levels: lex?.levels ?? [],
    buildings: [], extraction: [], items: [], power: { linearMW: 0, actualMW: 0 }, buildingCount: 0,
    budgets: { somersloops: { ...empty, budget: req.budgets.somersloops }, powerShards: { ...empty, budget: req.budgets.powerShards } },
    resources: [], explanation: errors, assumptions, warnings, provenance,
  };
}

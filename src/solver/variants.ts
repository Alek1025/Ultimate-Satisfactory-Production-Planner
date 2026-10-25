/**
 * Discrete operating points ("variants") for buildings and extractors.
 *
 * Overclocking: each Power Shard adds `perShard` clock (0.5), up to `maxShards` (3), so the
 * useful clocks are 100/150/200/250%. A clock between two steps needs as many shards as
 * the next step and is never better per shard, so continuous building counts at these
 * steps cover every useful choice.
 *
 * Belt/pipe caps: no single input or output port may exceed the best unlocked belt (solids)
 * or pipe (fluids). A variant whose ports would exceed the cap has its clock lowered until
 * they fit; that is the only underclocking the solver decides. Fractional building counts
 * become underclocked buildings in the results.
 *
 * Somersloops: 0..slots filled; output x (1 + filled * boostPerSlot); power x
 * clockMultiplier^powerExponent x outputMultiplier^boostPowerExponent.
 */
import type { NodePurity } from '../gamedata/types';
import type { PlanningProblem, ProblemBuilding, ProblemExtractor, ProblemRecipe, Variant } from './types';

const EPS = 1e-9;

export function shardsForClock(clock: number, perShard: number): number {
  return clock <= 1 + EPS ? 0 : Math.ceil((clock - 1) / perShard - 1e-7);
}

export interface VariantOptions {
  allowShards: boolean;
  allowSloops: boolean;
}

function portCap(problem: PlanningProblem, item: string): number {
  const fluid = problem.items[item]?.fluid ?? false;
  const t = fluid ? problem.transport.pipe : problem.transport.belt;
  return t ? t.ratePerMin : Number.POSITIVE_INFINITY;
}

/** Per-minute rate of each port of one building at 100% clock and no boost. */
export function baseRates(recipe: ProblemRecipe, b: ProblemBuilding) {
  const perMin = (60 / recipe.durationSec) * b.manufacturingSpeed;
  return {
    inputs: recipe.ingredients.map((a) => ({ item: a.item, rate: a.amount * perMin })),
    outputs: recipe.products.map((a) => ({ item: a.item, rate: a.amount * perMin })),
  };
}

/** Highest clock at which every port fits its belt/pipe, for a given output multiplier. */
function capClock(problem: PlanningProblem, recipe: ProblemRecipe, b: ProblemBuilding, outMult: number): number {
  const { inputs, outputs } = baseRates(recipe, b);
  let c = Number.POSITIVE_INFINITY;
  for (const p of inputs) if (p.rate > 0) c = Math.min(c, portCap(problem, p.item) / p.rate);
  for (const p of outputs) if (p.rate > 0) c = Math.min(c, portCap(problem, p.item) / (p.rate * outMult));
  return c;
}

function dedupe(vs: Variant[]): Variant[] {
  const seen = new Set<string>();
  return vs.filter((v) => {
    const k = `${v.sloops}|${v.clock.toFixed(6)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function recipeVariants(problem: PlanningProblem, recipe: ProblemRecipe, opts: VariantOptions): Variant[] {
  const b = problem.buildings[recipe.building]!;
  const { perShard, maxShards } = problem.overclock;
  const out: Variant[] = [];
  const make = (sloops: number, targetClock: number): Variant | null => {
    const outMult = 1 + sloops * b.boostPerSlot;
    const cap = capClock(problem, recipe, b, outMult);
    const clock = Math.min(targetClock, cap);
    if (!(clock > EPS)) return null;
    return {
      clock,
      sloops,
      shards: shardsForClock(clock, perShard),
      outputMultiplier: outMult,
      powerMultiplier: clock ** b.powerExponent * outMult ** b.boostPowerExponent,
      beltLimited: cap < targetClock - EPS,
    };
  };
  const base = make(0, 1);
  if (base) out.push(base);
  // Overclocking is only allowed on Somerslooped production buildings (project rule).
  if (opts.allowSloops && b.sloopSlots > 0) {
    const steps = opts.allowShards && b.canOverclock ? maxShards : 0;
    for (let s = 1; s <= b.sloopSlots; s++) {
      for (let k = 0; k <= steps; k++) {
        const v = make(s, 1 + k * perShard);
        if (v) out.push(v);
      }
    }
  }
  return dedupe(out);
}

/** Variants for a miner / oil extractor / water extractor on a node of the given purity. */
export function extractorVariants(
  problem: PlanningProblem, e: ProblemExtractor, resource: string, purity: NodePurity | null, opts: VariantOptions,
): { variant: Variant; ratePerUnit: number }[] {
  const mult = purity ? problem.purityMultiplier[purity] : 1;
  const base = e.baseRatePerMin * mult;
  const cap = portCap(problem, resource) / base;
  const { perShard, maxShards } = problem.overclock;
  const steps = opts.allowShards && e.canOverclock ? maxShards : 0;
  const out: { variant: Variant; ratePerUnit: number }[] = [];
  const seen = new Set<string>();
  for (let k = 0; k <= steps; k++) {
    const target = 1 + k * perShard;
    const clock = Math.min(target, cap);
    const key = clock.toFixed(6);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      variant: {
        clock, sloops: 0, shards: shardsForClock(clock, perShard), outputMultiplier: 1,
        powerMultiplier: clock ** e.powerExponent, beltLimited: cap < target - EPS,
      },
      ratePerUnit: base * clock,
    });
  }
  return out;
}

/** Pressurizer clock variants for one well; rate is the whole well's output at that clock. */
export function wellVariants(
  problem: PlanningProblem, satellites: { purity: NodePurity }[], resource: string, opts: VariantOptions,
): { variant: Variant; ratePerUnit: number }[] {
  const w = problem.wells!;
  const rates = satellites.map((s) => w.extractor.baseRatePerMin * problem.purityMultiplier[s.purity]);
  const full = rates.reduce((a, b) => a + b, 0);
  // Each satellite extractor has its own output pipe.
  const cap = portCap(problem, resource) / Math.max(...rates);
  const { perShard, maxShards } = problem.overclock;
  const steps = opts.allowShards && w.pressurizer.canOverclock ? maxShards : 0;
  const out: { variant: Variant; ratePerUnit: number }[] = [];
  const seen = new Set<string>();
  for (let k = 0; k <= steps; k++) {
    const target = 1 + k * perShard;
    const clock = Math.min(target, cap);
    const key = clock.toFixed(6);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      variant: {
        clock, sloops: 0, shards: shardsForClock(clock, perShard), outputMultiplier: 1,
        powerMultiplier: clock ** w.pressurizer.powerExponent, beltLimited: cap < target - EPS,
      },
      ratePerUnit: full * clock,
    });
  }
  return out;
}

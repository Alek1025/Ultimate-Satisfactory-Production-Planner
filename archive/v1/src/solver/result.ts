/**
 * Turns a solved model into the structured, JSON-serializable parts of PlanResult:
 * placed buildings (with the real clock each one runs at), extraction, item flows,
 * budgets, resource use and power.
 */
import type { BudgetUse, BuildingLine, ExtractionLine, ItemFlow, PlanningProblem, PlanResult } from './types';
import type { BuiltModel, UnitCol } from './model';
import type { EffectiveRequest } from './validate';
import { baseRates, shardsForClock } from './variants';

/** Below this many building-equivalents a unit is solver noise, not a building to place. */
const EPS = 1e-5;
/**
 * Below this many building-equivalents a recipe line is solver residue (seen after the integer
 * pass: 2e-5 of an Assembler). Its flows stay in the balances so targets and totals are exactly
 * what was solved, but no building is placed or listed for it.
 */
const MIN_PLACED = 1e-4;

export interface Extracted {
  buildings: BuildingLine[];
  extraction: ExtractionLine[];
  items: ItemFlow[];
  power: PlanResult['power'];
  buildingCount: number;
  budgets: PlanResult['budgets'];
  resources: PlanResult['resources'];
  /** Physical counts exceed a budget or node limit (only possible in the LP pass). */
  roundingViolations: string[];
}

const clean = (v: number) => (Math.abs(v) < 1e-6 ? 0 : v);

export function physicalCount(m: BuiltModel, u: number, x: Float64Array): number {
  const n = m.countOf.get(u);
  if (n !== undefined) return Math.round(x[n]!);
  const c = m.cols[u] as UnitCol;
  if (c.kind === 'well') return x[u]! > EPS ? 1 : 0;
  return Math.max(1, Math.ceil(x[u]! - 1e-6));
}

export function extractResult(problem: PlanningProblem, req: EffectiveRequest, m: BuiltModel, x: Float64Array): Extracted {
  const { perShard } = problem.overclock;
  const buildings: BuildingLine[] = [];
  const extraction: ExtractionLine[] = [];
  const produced = new Map<string, number>();
  const consumed = new Map<string, number>();
  const extracted = new Map<string, number>();
  const bump = (map: Map<string, number>, k: string, v: number) => map.set(k, (map.get(k) ?? 0) + v);
  let linearMW = 0, actualMW = 0, buildingCount = 0;
  const sloopWhere: BudgetUse['where'] = [];
  const shardWhere: BudgetUse['where'] = [];
  const groupNodes = new Map<string, { used: number; capacity: number }>();

  for (const u of m.units) {
    const amount = x[u]!;
    if (amount <= EPS) continue;
    const c = m.cols[u] as UnitCol;
    const count = physicalCount(m, u, x);
    if (count === 0) continue;
    const clockEach = c.variant.clock * amount / count;
    const shardsEach = shardsForClock(clockEach, perShard);
    linearMW += c.powerPerUnit * amount;
    if (c.kind === 'recipe' && amount < MIN_PLACED) {
      const base = baseRates(c.recipe, problem.buildings[c.recipe.building]!);
      base.inputs.forEach((q) => bump(consumed, q.item, q.rate * c.variant.clock * amount));
      base.outputs.forEach((q) => bump(produced, q.item, q.rate * c.variant.clock * c.variant.outputMultiplier * amount));
      continue;
    }
    if (c.kind === 'recipe') {
      const b = problem.buildings[c.recipe.building]!;
      const p = c.recipe.averagePowerMW ?? b.powerMW;
      const powerMW = count * p * clockEach ** b.powerExponent * c.variant.outputMultiplier ** b.boostPowerExponent;
      actualMW += powerMW;
      buildingCount += count;
      const base = baseRates(c.recipe, b);
      const inputs = base.inputs.map((q) => ({ item: q.item, ratePerMin: q.rate * c.variant.clock * amount }));
      const outputs = base.outputs.map((q) => ({ item: q.item, ratePerMin: q.rate * c.variant.clock * c.variant.outputMultiplier * amount }));
      inputs.forEach((q) => bump(consumed, q.item, q.ratePerMin));
      outputs.forEach((q) => bump(produced, q.item, q.ratePerMin));
      buildings.push({
        recipe: c.recipe.id, building: c.recipe.building, variant: c.variant, amount, count, clockEach, shardsEach,
        sloopsEach: c.variant.sloops, inputs, outputs, powerMW,
      });
      if (c.variant.sloops) sloopWhere.push({ recipe: c.recipe.id, building: c.recipe.building, count, each: c.variant.sloops });
      if (shardsEach) shardWhere.push({ recipe: c.recipe.id, building: c.recipe.building, count, each: shardsEach });
    } else {
      const rate = c.ratePerUnit * amount;
      bump(extracted, c.resource, rate);
      if (c.kind === 'well') {
        const w = problem.wells!;
        const powerMW = w.pressurizer.powerMW * clockEach ** w.pressurizer.powerExponent + w.extractor.powerMW * c.satellites;
        actualMW += powerMW;
        buildingCount += 1 + c.satellites;
        extraction.push({
          source: 'well', resource: c.resource, groupId: c.group.id, extractor: w.pressurizer.id, variant: c.variant, amount, count: 1,
          clockEach, shardsEach, ratePerMin: rate, powerMW, satellites: c.satellites,
        });
        const g = groupNodes.get(c.group.id) ?? { used: 0, capacity: 1 };
        g.used += 1;
        groupNodes.set(c.group.id, g);
        if (shardsEach) shardWhere.push({ resource: c.resource, building: w.pressurizer.id, count: 1, each: shardsEach });
      } else {
        const e = c.extractor;
        const powerMW = count * e.powerMW * clockEach ** e.powerExponent;
        actualMW += powerMW;
        buildingCount += count;
        extraction.push({
          source: c.kind, resource: c.resource, ...(c.kind === 'node' ? { groupId: c.group.id, purity: c.group.purity } : {}),
          extractor: e.id, variant: c.variant, amount, count, clockEach, shardsEach, ratePerMin: rate, powerMW,
        });
        if (c.kind === 'node') {
          const g = groupNodes.get(c.group.id) ?? { used: 0, capacity: c.usableNodes };
          g.used += count;
          groupNodes.set(c.group.id, g);
        }
        if (shardsEach) shardWhere.push({ resource: c.resource, building: e.id, count, each: shardsEach });
      }
    }
  }

  // Item flows
  const delivered = new Map<string, number>();
  for (const [item, col] of m.deliverCol) delivered.set(item, x[col]!);
  const all = new Set([...produced.keys(), ...consumed.keys(), ...extracted.keys(), ...delivered.keys(), ...req.manual.keys()]);
  const items: ItemFlow[] = [];
  for (const item of [...all].sort()) {
    const p = produced.get(item) ?? 0, cns = consumed.get(item) ?? 0, ex = extracted.get(item) ?? 0, d = delivered.get(item) ?? 0;
    const manualAvailable = req.manual.get(item) ?? 0;
    const manualUsed = Math.min(manualAvailable, Math.max(0, cns + d - p - ex));
    const surplus = Math.max(0, p + ex + manualUsed - cns - d);
    const target = req.targets.get(item);
    const sc = m.shortfallCol.get(item);
    const flow = Math.max(p + ex + manualUsed, cns + d);
    const t = problem.items[item]?.fluid ? problem.transport.pipe : problem.transport.belt;
    items.push({
      item, produced: clean(p), consumed: clean(cns), extracted: clean(ex), manualAvailable, manualUsed: clean(manualUsed), delivered: clean(d),
      ...(target !== undefined ? { target } : {}),
      shortfall: sc !== undefined ? clean(x[sc]!) : 0,
      surplus: clean(surplus),
      ...(t && flow > 1e-6 ? { lines: { transport: t.id, count: Math.ceil(flow / t.ratePerMin - 1e-9) } } : {}),
    });
  }

  // Budgets
  const sum = (w: BudgetUse['where']) => w.reduce((s, e) => s + e.count * e.each, 0);
  const budgets = {
    somersloops: { budget: req.budgets.somersloops, available: problem.holdings.somersloops, used: sum(sloopWhere), where: sloopWhere },
    powerShards: { budget: req.budgets.powerShards, available: problem.holdings.powerShards, used: sum(shardWhere), where: shardWhere },
  };

  const roundingViolations: string[] = [];
  if (budgets.somersloops.used > budgets.somersloops.budget) roundingViolations.push(`Somersloops: ${budgets.somersloops.used} needed after rounding to whole buildings, budget ${budgets.somersloops.budget}.`);
  if (budgets.powerShards.used > budgets.powerShards.budget) roundingViolations.push(`Power Shards: ${budgets.powerShards.used} needed after rounding to whole buildings, budget ${budgets.powerShards.budget}.`);
  for (const [gid, g] of groupNodes) if (g.used > g.capacity) roundingViolations.push(`${gid}: ${g.used} needed after rounding to whole extractors, ${g.capacity} available.`);

  // Resource use
  const maxRate = new Map<string, number>();
  const bestPerGroup = new Map<string, { resource: string; rate: number }>();
  for (const u of m.units) {
    const c = m.cols[u] as UnitCol;
    if (c.kind === 'node') {
      const r = c.ratePerUnit * c.usableNodes;
      const prev = bestPerGroup.get(c.group.id);
      if (!prev || r > prev.rate) bestPerGroup.set(c.group.id, { resource: c.resource, rate: r });
    } else if (c.kind === 'well') {
      const prev = bestPerGroup.get(c.group.id);
      if (!prev || c.ratePerUnit > prev.rate) bestPerGroup.set(c.group.id, { resource: c.resource, rate: c.ratePerUnit });
    }
  }
  for (const g of bestPerGroup.values()) maxRate.set(g.resource, (maxRate.get(g.resource) ?? 0) + g.rate);
  const resources: PlanResult['resources'] = [];
  for (const [resource, used] of [...extracted].sort((a, b) => a[0].localeCompare(b[0]))) {
    const unlimited = problem.unlimitedResources.includes(resource);
    const cap = req.caps.get(resource);
    const avail = unlimited ? (cap ?? null) : Math.min(maxRate.get(resource) ?? 0, cap ?? Number.POSITIVE_INFINITY);
    const map = problem.mapAvailability[resource] ?? null;
    resources.push({ resource, used: clean(used), available: avail, mapAvailability: map, mapShare: map ? used / map : null });
  }

  return {
    buildings, extraction, items,
    power: { linearMW, actualMW },
    buildingCount, budgets, resources, roundingViolations,
  };
}

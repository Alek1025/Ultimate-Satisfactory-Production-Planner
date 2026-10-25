/**
 * Builds the LP/MILP for one plan.
 *
 * Columns ("units"):
 *   recipe   building-equivalents of a recipe at one variant (clock + Somersloops)
 *   node     nodes of one NodeGroup worked by one extractor at one clock
 *   well     fraction of one Resource Well's full output at one pressurizer clock
 *   water    Water Extractors
 * plus deliver (output of a requested item), shortfall (unmet part of a target),
 * count (integer pass: whole buildings, >= the unit), elastic (diagnosis only).
 *
 * Rows:
 *   balance  per item: produced + extracted + manual - consumed - delivered >= 0
 *            (surplus allowed; reported as byproduct)
 *   target   delivered + shortfall >= target
 *   limits   node groups, wells, raw caps, Somersloop and Power Shard budgets
 *   link     unit - count <= 0 (integer pass)
 *
 * Counted quantities (buildings, node use, Somersloops, shards) use the unit column in
 * the LP and the integer count column in the integer pass.
 */
import type { LimitRef, NodeGroup, PlanningProblem, ProblemExtractor, ProblemRecipe, Variant, WellGroup } from './types';
import type { LpModel, LpRow } from './lp/types';
import { INF } from './lp/types';
import type { EffectiveRequest } from './validate';
import type { Reachability } from './reachability';
import { baseRates, extractorVariants, recipeVariants, wellVariants, type VariantOptions } from './variants';
import { extractorCanMine } from './problem';

interface UnitBase { key: string; variant: Variant; powerPerUnit: number; buildingsPerUnit: number; count?: number }
export type UnitCol =
  | (UnitBase & { kind: 'recipe'; recipe: ProblemRecipe; io: { item: string; perUnit: number }[] })
  | (UnitBase & { kind: 'node'; group: NodeGroup; usableNodes: number; extractor: ProblemExtractor; resource: string; ratePerUnit: number })
  | (UnitBase & { kind: 'well'; group: WellGroup; satellites: number; resource: string; ratePerUnit: number })
  | (UnitBase & { kind: 'water'; extractor: ProblemExtractor; resource: string; ratePerUnit: number });
export type Col =
  | UnitCol
  | { kind: 'deliver'; key: string; item: string }
  | { kind: 'shortfall'; key: string; item: string; target: number }
  | { kind: 'count'; key: string; of: number }
  | { kind: 'elastic'; key: string; limit: number; penalty: number; tier: 'budget' | 'over-holdings' | 'cap' | 'map' };

export interface Limit { row: number; ref: Omit<LimitRef, 'used' | 'shadowPrice'> }

export interface BuiltModel {
  lp: LpModel;
  cols: Col[];
  /** Indices of unit columns. */
  units: number[];
  /** unit column index -> integer count column index (integer pass). */
  countOf: Map<number, number>;
  limits: Limit[];
  balanceRow: Map<string, number>;
  deliverCol: Map<string, number>;
  shortfallCol: Map<string, number>;
  integer: boolean;
  elastic: boolean;
}

export interface BuildOptions {
  integer: boolean;
  /** Integer pass: only unit columns with these keys are created. */
  support?: Set<string>;
  /** Diagnosis: limit rows get elastic columns and reachable targets become hard. */
  elastic?: boolean;
  variants: VariantOptions;
}

export function isUnit(c: Col): c is UnitCol {
  return c.kind === 'recipe' || c.kind === 'node' || c.kind === 'well' || c.kind === 'water';
}

export function unitResource(c: UnitCol): string | undefined {
  return c.kind === 'recipe' ? undefined : c.resource;
}

export function unitRate(c: UnitCol): number {
  return c.kind === 'recipe' ? 0 : c.ratePerUnit;
}

export function buildModel(problem: PlanningProblem, req: EffectiveRequest, reach: Reachability, opts: BuildOptions): BuiltModel {
  const cols: Col[] = [];
  const colLower: number[] = [];
  const colUpper: number[] = [];
  const integer: boolean[] = [];
  const rows: LpRow[] = [];
  const addCol = (c: Col, lo: number, hi: number, int = false) => {
    cols.push(c); colLower.push(lo); colUpper.push(hi); integer.push(int);
    return cols.length - 1;
  };
  const allowed = (key: string) => !opts.support || opts.support.has(key);

  // ---- Unit columns
  const neededItems = new Set<string>([...req.targets.keys(), ...req.maximize]);
  const recipes = problem.recipes.filter((r) => reach.relevantRecipes.has(r.id));
  for (const r of recipes) for (const a of r.ingredients) neededItems.add(a.item);

  for (const r of recipes) {
    const b = problem.buildings[r.building]!;
    const base = baseRates(r, b);
    const power = r.averagePowerMW ?? b.powerMW;
    for (const v of recipeVariants(problem, r, opts.variants)) {
      const key = `recipe|${r.id}|${v.sloops}|${v.clock.toFixed(4)}`;
      if (!allowed(key)) continue;
      const io = [
        ...base.inputs.map((p) => ({ item: p.item, perUnit: -p.rate * v.clock })),
        ...base.outputs.map((p) => ({ item: p.item, perUnit: p.rate * v.clock * v.outputMultiplier })),
      ];
      addCol({ kind: 'recipe', key, recipe: r, variant: v, io, powerPerUnit: power * v.powerMultiplier, buildingsPerUnit: 1 }, 0, INF);
    }
  }

  const rawNeeded = (r: string) => neededItems.has(r) && reach.sourceable.has(r);
  for (const g of problem.nodeGroups) {
    if (!rawNeeded(g.resource)) continue;
    const usable = g.nodeIds.filter((n) => !req.excluded.has(n)).length;
    if (!usable) continue;
    const item = problem.items[g.resource]!;
    for (const e of problem.extractors) {
      if (e.kind === 'water-extractor' || !extractorCanMine(e, item)) continue;
      for (const { variant, ratePerUnit } of extractorVariants(problem, e, g.resource, g.purity, opts.variants)) {
        const key = `node|${g.id}|${e.id}|${variant.clock.toFixed(4)}`;
        if (!allowed(key)) continue;
        addCol({
          kind: 'node', key, group: g, usableNodes: usable, extractor: e, resource: g.resource, variant, ratePerUnit,
          powerPerUnit: e.powerMW * variant.powerMultiplier, buildingsPerUnit: 1,
        }, 0, INF); // bounded by the node-limit row (a column bound would hide the row's dual)
      }
    }
  }
  if (problem.wells) {
    for (const g of problem.wellGroups) {
      if (!rawNeeded(g.resource)) continue;
      const sats = g.satellites.filter((s) => !req.excluded.has(s.id));
      if (!sats.length) continue;
      for (const { variant, ratePerUnit } of wellVariants(problem, sats, g.resource, opts.variants)) {
        const key = `well|${g.id}|${variant.clock.toFixed(4)}`;
        if (!allowed(key)) continue;
        addCol({
          kind: 'well', key, group: { ...g, satellites: sats }, satellites: sats.length, resource: g.resource, variant, ratePerUnit,
          powerPerUnit: problem.wells.pressurizer.powerMW * variant.powerMultiplier + problem.wells.extractor.powerMW * sats.length,
          buildingsPerUnit: 1 + sats.length,
        }, 0, INF);
      }
    }
  }
  for (const res of problem.unlimitedResources) {
    if (!rawNeeded(res)) continue;
    const e = problem.extractors.find((x) => x.kind === 'water-extractor' && extractorCanMine(x, problem.items[res]!));
    if (!e) continue;
    // Unlimited, so overclocking a Water Extractor never helps: base variant only.
    for (const { variant, ratePerUnit } of extractorVariants(problem, e, res, null, { allowShards: false, allowSloops: false })) {
      const key = `water|${e.id}|${variant.clock.toFixed(4)}`;
      if (!allowed(key)) continue;
      addCol({ kind: 'water', key, extractor: e, resource: res, variant, ratePerUnit, powerPerUnit: e.powerMW * variant.powerMultiplier, buildingsPerUnit: 1 }, 0, INF);
    }
  }
  const units = cols.map((_, i) => i);

  // ---- Integer counts
  const countOf = new Map<number, number>();
  if (opts.integer) {
    // Whole counts only where a limit depends on them: Somersloop/shard variants and
    // extraction (node and well limits). Plain recipe buildings stay continuous and are
    // rounded up afterwards, which never breaks a limit and keeps the MILP small.
    for (const u of units) {
      const c = cols[u] as UnitCol;
      if (c.kind === 'recipe' && c.variant.sloops === 0 && c.variant.shards === 0) continue;
      if (c.kind === 'water') continue;
      const hi = c.kind === 'node' ? c.usableNodes : c.kind === 'well' ? 1 : INF;
      const n = addCol({ kind: 'count', key: `count|${c.key}`, of: u }, 0, hi, true);
      countOf.set(u, n);
      rows.push({ lower: -INF, upper: 0, idx: [u, n], val: [1, -1] });
    }
  }
  /** Column that counts whole things for unit u. */
  const counted = (u: number) => countOf.get(u) ?? u;

  // ---- Deliver / shortfall
  const deliverCol = new Map<string, number>();
  const shortfallCol = new Map<string, number>();
  for (const item of new Set([...req.targets.keys(), ...req.maximize])) {
    deliverCol.set(item, addCol({ kind: 'deliver', key: `deliver|${item}`, item }, 0, INF));
  }
  for (const [item, target] of req.targets) {
    const hard = opts.elastic && reach.reachable.has(item);
    shortfallCol.set(item, addCol({ kind: 'shortfall', key: `shortfall|${item}`, item, target }, 0, hard ? 0 : target));
  }

  // ---- Item balances
  const terms = new Map<string, { idx: number[]; val: number[] }>();
  const add = (item: string, col: number, v: number) => {
    const t = terms.get(item) ?? { idx: [], val: [] };
    t.idx.push(col); t.val.push(v);
    terms.set(item, t);
  };
  for (const u of units) {
    const c = cols[u] as UnitCol;
    if (c.kind === 'recipe') c.io.forEach((p) => add(p.item, u, p.perUnit));
    else add(c.resource, u, c.ratePerUnit);
  }
  for (const [item, col] of deliverCol) add(item, col, -1);
  const balanceRow = new Map<string, number>();
  for (const [item, t] of [...terms].sort((a, b) => a[0].localeCompare(b[0]))) {
    balanceRow.set(item, rows.length);
    rows.push({ lower: -(req.manual.get(item) ?? 0), upper: INF, idx: t.idx, val: t.val });
  }
  for (const [item, target] of req.targets) {
    rows.push({ lower: target, upper: INF, idx: [deliverCol.get(item)!, shortfallCol.get(item)!], val: [1, 1] });
  }

  // ---- Limits
  const limits: Limit[] = [];
  const addLimit = (ref: Limit['ref'], idx: number[], val: number[], elastic?: { penalty: number; tier: 'budget' | 'cap' | 'map'; overHoldings?: { at: number; penalty: number } }) => {
    if (!idx.length) return;
    const row = rows.length;
    const r: LpRow = { lower: -INF, upper: ref.capacity, idx: [...idx], val: [...val] };
    rows.push(r);
    limits.push({ row, ref });
    if (opts.elastic && elastic) {
      if (elastic.overHoldings) {
        const room = Math.max(0, elastic.overHoldings.at - ref.capacity);
        if (room > 0) { r.idx.push(addCol({ kind: 'elastic', key: `elastic|${ref.kind}|${ref.id}`, limit: limits.length - 1, penalty: elastic.penalty, tier: 'budget' }, 0, room)); r.val.push(-1); }
        r.idx.push(addCol({ kind: 'elastic', key: `elastic+|${ref.kind}|${ref.id}`, limit: limits.length - 1, penalty: elastic.overHoldings.penalty, tier: 'over-holdings' }, 0, INF)); r.val.push(-1);
      } else {
        r.idx.push(addCol({ kind: 'elastic', key: `elastic|${ref.kind}|${ref.id}`, limit: limits.length - 1, penalty: elastic.penalty, tier: elastic.tier }, 0, INF)); r.val.push(-1);
      }
    }
  };
  // Relaxation preference in diagnosis (cheapest first): budget up to what you hold <
  // your own raw caps < budget beyond what you hold < more nodes than the map has.
  const groupUnits = new Map<string, number[]>();
  for (const u of units) {
    const c = cols[u] as UnitCol;
    if (c.kind === 'node' || c.kind === 'well') groupUnits.set(c.group.id, [...(groupUnits.get(c.group.id) ?? []), u]);
  }
  for (const [gid, us] of groupUnits) {
    const c0 = cols[us[0]!] as UnitCol;
    if (c0.kind === 'node') {
      addLimit({ kind: 'nodes', id: gid, resource: c0.resource, purity: c0.group.purity, capacity: c0.usableNodes }, us.map(counted), us.map(() => 1),
        { penalty: 100 / Math.max(c0.usableNodes, 1), tier: 'map' });
    } else if (c0.kind === 'well') {
      addLimit({ kind: 'well', id: gid, resource: c0.resource, capacity: 1 }, us.map(counted), us.map(() => 1), { penalty: 100, tier: 'map' });
    }
  }
  for (const [item, cap] of req.caps) {
    const us = units.filter((u) => unitResource(cols[u] as UnitCol) === item);
    addLimit({ kind: 'raw-cap', id: item, resource: item, capacity: cap }, us, us.map((u) => unitRate(cols[u] as UnitCol)),
      { penalty: 0.01 / Math.max(cap, 1), tier: 'cap' });
  }
  const sloopUnits = units.filter((u) => (cols[u] as UnitCol).variant.sloops > 0);
  addLimit({ kind: 'somersloop-budget', id: 'somersloops', capacity: req.budgets.somersloops },
    sloopUnits.map(counted), sloopUnits.map((u) => (cols[u] as UnitCol).variant.sloops),
    { penalty: 0.001 / Math.max(problem.holdings.somersloops, 1), tier: 'budget', overHoldings: { at: problem.holdings.somersloops, penalty: 0.1 } });
  const shardUnits = units.filter((u) => (cols[u] as UnitCol).variant.shards > 0);
  addLimit({ kind: 'shard-budget', id: 'powerShards', capacity: req.budgets.powerShards },
    shardUnits.map(counted), shardUnits.map((u) => (cols[u] as UnitCol).variant.shards),
    { penalty: 0.001 / Math.max(problem.holdings.powerShards, 1), tier: 'budget', overHoldings: { at: problem.holdings.powerShards, penalty: 0.1 } });

  return {
    lp: { colLower, colUpper, integer, rows },
    cols, units, countOf, limits, balanceRow, deliverCol, shortfallCol,
    integer: opts.integer, elastic: !!opts.elastic,
  };
}

/** Column that counts whole things for unit u (count column in the integer pass). */
export function countedCol(m: BuiltModel, u: number): number {
  return m.countOf.get(u) ?? u;
}

/**
 * Lexicographic optimization: solve level 1, pin its value (within a small tolerance),
 * solve level 2 on top, and so on. Each level's binding limits are read from the row
 * duals (LP pass), which is how results explain what stopped a level doing better.
 */
import type { LevelResult, LimitRef } from './types';
import type { LpBackend, LpRow } from './lp/types';
import { INF } from './lp/types';
import type { BuiltModel } from './model';
import type { ObjectiveSpec } from './objectives';

export interface LexOutcome {
  levels: LevelResult[];
  x?: Float64Array;
  status: 'optimal' | 'time-limit' | 'unbounded' | 'infeasible' | 'error';
  message?: string;
}

const DUAL_EPS = 1e-9;

export function rowActivity(row: LpRow, x: Float64Array): number {
  let s = 0;
  for (let k = 0; k < row.idx.length; k++) s += row.val[k]! * x[row.idx[k]!]!;
  return s;
}

export function limitUse(m: BuiltModel, x: Float64Array): LimitRef[] {
  return m.limits.map((l) => ({ ...l.ref, used: rowActivity(m.lp.rows[l.row]!, x) }));
}

export async function solveLexicographic(
  backend: LpBackend, m: BuiltModel, levels: ObjectiveSpec[],
  opts: { timeLimitSec?: number; mipRelGap?: number } = {},
): Promise<LexOutcome> {
  const rows = [...m.lp.rows];
  const colUpper = [...m.lp.colUpper];
  const out: LevelResult[] = [];
  let x: Float64Array | undefined;
  let worst: LexOutcome['status'] = 'optimal';
  let lastPin: { row: number; sense: 'min' | 'max'; retryTol: number } | undefined;
  for (const spec of levels) {
    const cost = spec.vector(m);
    if (!cost.some((c) => c !== 0)) {
      if (!spec.hidden) out.push({ kind: spec.kind as LevelResult['kind'], ...(spec.item ? { item: spec.item } : {}), sense: spec.sense, value: 0, unit: spec.unit, status: 'optimal', binding: [] });
      continue;
    }
    const run = () => backend.solve({
      model: { ...m.lp, rows, colUpper }, cost, sense: spec.sense,
      ...(opts.timeLimitSec ? { timeLimitSec: opts.timeLimitSec } : {}),
      ...(opts.mipRelGap !== undefined ? { mipRelGap: opts.mipRelGap } : {}),
    });
    let sol = await run();
    // A pin that is numerically too tight can make the next level infeasible; loosen the
    // most recent pin once and retry.
    if (sol.status === 'infeasible' && lastPin) {
      const r = rows[lastPin.row]!;
      rows[lastPin.row] = lastPin.sense === 'min' ? { ...r, upper: r.upper + lastPin.retryTol } : { ...r, lower: r.lower - lastPin.retryTol };
      lastPin = undefined;
      sol = await run();
    }
    if (!sol.x || (sol.status !== 'optimal' && sol.status !== 'time-limit')) {
      if (!spec.hidden) out.push({ kind: spec.kind as LevelResult['kind'], ...(spec.item ? { item: spec.item } : {}), sense: spec.sense, value: NaN, unit: spec.unit, status: sol.status, binding: [] });
      return { levels: out, ...(x ? { x } : {}), status: sol.status, ...(sol.message ? { message: sol.message } : {}) };
    }
    if (sol.status === 'time-limit') worst = 'time-limit';
    x = sol.x;
    let value = 0;
    for (let j = 0; j < cost.length; j++) value += cost[j]! * x[j]!;

    const binding: LimitRef[] = [];
    if (sol.rowDual) {
      for (const l of m.limits) {
        const d = sol.rowDual[l.row]!;
        if (Math.abs(d) > DUAL_EPS) binding.push({ ...l.ref, used: rowActivity(m.lp.rows[l.row]!, x), shadowPrice: Math.abs(d) });
      }
      binding.sort((a, b) => (b.shadowPrice! - a.shadowPrice!));
    }
    if (!spec.hidden) {
      out.push({ kind: spec.kind as LevelResult['kind'], ...(spec.item ? { item: spec.item } : {}), sense: spec.sense, value, unit: spec.unit, status: sol.status === 'time-limit' ? 'time-limit' : 'optimal', binding });
    }

    // Pin this level before optimizing the next. A minimum of zero over non-negative
    // columns with non-negative costs is pinned exactly (bounds to 0), so later levels
    // can't trade away a little of it through the tolerance.
    if (spec.sense === 'min' && value <= 1e-9 && cost.every((c, j) => c >= 0 && (c === 0 || m.lp.colLower[j]! >= 0))) {
      cost.forEach((c, j) => { if (c > 0) colUpper[j] = 0; });
      lastPin = undefined;
      continue;
    }
    // The pinned value was achieved by this solution, so the tolerance only has to absorb
    // numerical noise (a MIP gap is about optimality, not feasibility, and must not leak
    // into later levels).
    const tol = 1e-9 * Math.max(1, Math.abs(value));
    const idx: number[] = [], val: number[] = [];
    cost.forEach((c, j) => { if (c !== 0) { idx.push(j); val.push(c); } });
    lastPin = { row: rows.length, sense: spec.sense, retryTol: 1e-6 * Math.max(1, Math.abs(value)) };
    rows.push(spec.sense === 'min' ? { lower: -INF, upper: value + tol, idx, val } : { lower: value - tol, upper: INF, idx, val });
  }
  return { levels: out, ...(x ? { x } : {}), status: worst };
}

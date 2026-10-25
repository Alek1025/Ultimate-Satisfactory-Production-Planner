/**
 * HiGHS (WebAssembly) backend. The caller supplies the loader so this module stays
 * platform-neutral:
 *
 *   Node / tests:   createHighsBackend(() => highsLoader())
 *   Browser/Tauri:  createHighsBackend(() => highsLoader({ locateFile: () => wasmUrl }))
 *
 * HiGHS solves synchronously, so the UI should call the planner from a Web Worker.
 */
import type { Highs } from 'highs';
import type { LpBackend, LpSolution, LpSolveRequest } from './types';

export function createHighsBackend(load: () => Promise<Highs>): LpBackend {
  let runtime: Promise<Highs> | undefined;
  return {
    name: 'HiGHS',
    async solve(req: LpSolveRequest): Promise<LpSolution> {
      runtime ??= load();
      const h = await runtime;
      return solveWith(h, req);
    },
  };
}

function finite(v: number, h: Highs): number {
  return v === Number.POSITIVE_INFINITY ? h.infinity : v === Number.NEGATIVE_INFINITY ? -h.infinity : v;
}

function solveWith(h: Highs, req: LpSolveRequest): LpSolution {
  const { model, cost } = req;
  const numCols = model.colLower.length;
  const numRows = model.rows.length;
  const starts: number[] = [0];
  const indices: number[] = [];
  const values: number[] = [];
  for (const r of model.rows) {
    // HiGHS rejects duplicate column indices within a row: merge them.
    const merged = new Map<number, number>();
    r.idx.forEach((c, k) => merged.set(c, (merged.get(c) ?? 0) + r.val[k]!));
    for (const [c, v] of [...merged].sort((a, b) => a[0] - b[0])) {
      if (v !== 0) { indices.push(c); values.push(v); }
    }
    starts.push(indices.length);
  }
  const isMip = model.integer.some(Boolean);
  const m = h.createModel();
  try {
    m.options.set({ output_flag: false, random_seed: 0 });
    if (isMip) {
      if (req.timeLimitSec) m.options.set('time_limit', req.timeLimitSec);
      if (req.mipRelGap !== undefined) m.options.set('mip_rel_gap', req.mipRelGap);
    }
    m.passModel({
      numCols,
      numRows,
      sense: req.sense === 'max' ? h.constants.objectiveSense.maximize : h.constants.objectiveSense.minimize,
      colCost: cost,
      colLower: model.colLower.map((v) => finite(v, h)),
      colUpper: model.colUpper.map((v) => finite(v, h)),
      rowLower: model.rows.map((r) => finite(r.lower, h)),
      rowUpper: model.rows.map((r) => finite(r.upper, h)),
      matrix: { format: 'csr', numRows, numCols, starts, indices, values },
      ...(isMip ? { integrality: model.integer.map((b) => (b ? h.constants.variableType.integer : h.constants.variableType.continuous)) } : {}),
    });
    const { modelStatus } = m.run();
    const S = h.constants.modelStatus;
    const hasPrimal = () => Number(m.info.get('primal_solution_status')) === 2;
    switch (modelStatus) {
      case S.optimal: {
        const sol = m.getSolution();
        return { status: 'optimal', objective: m.getObjectiveValue(), x: sol.colValue, ...(isMip ? {} : { rowDual: sol.rowDual }) };
      }
      case S.empty:
        return { status: 'optimal', objective: 0, x: new Float64Array(numCols) };
      case S.infeasible:
        return { status: 'infeasible', objective: NaN };
      case S.unbounded:
      case S.unboundedOrInfeasible:
        return { status: 'unbounded', objective: NaN };
      case S.timeLimit:
      case S.iterationLimit:
      case S.solutionLimit:
      case S.interrupted:
        return hasPrimal()
          ? { status: 'time-limit', objective: m.getObjectiveValue(), x: m.getSolution().colValue }
          : { status: 'time-limit', objective: NaN, message: 'No feasible solution found before the time limit.' };
      default:
        return { status: 'error', objective: NaN, message: `HiGHS model status ${modelStatus}` };
    }
  } catch (e) {
    return { status: 'error', objective: NaN, message: (e as Error).message };
  } finally {
    m.dispose();
  }
}

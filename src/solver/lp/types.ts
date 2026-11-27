/**
 * Solver-agnostic LP/MILP model. The planner builds these; an LpBackend solves them.
 * Backends are injected, so the solver never imports a platform-specific loader.
 */

export interface LpRow {
  lower: number;
  upper: number;
  idx: number[];
  val: number[];
}

export interface LpModel {
  colLower: number[];
  colUpper: number[];
  integer: boolean[];
  rows: LpRow[];
}

export interface LpSolveRequest {
  model: LpModel;
  cost: number[];
  sense: 'min' | 'max';
  /** Seconds; applies to MILPs (LPs here solve in milliseconds). */
  timeLimitSec?: number;
  mipRelGap?: number;
}

export type LpStatus = 'optimal' | 'infeasible' | 'unbounded' | 'time-limit' | 'error';

export interface LpSolution {
  status: LpStatus;
  objective: number;
  /** Primal values (present for optimal, and for time-limit with an incumbent). */
  x?: Float64Array;
  /** Row duals (LP only; absent for MILPs). */
  rowDual?: Float64Array;
  message?: string;
}

export interface LpBackend {
  readonly name: string;
  solve(req: LpSolveRequest): Promise<LpSolution>;
}

export const INF = Number.POSITIVE_INFINITY;

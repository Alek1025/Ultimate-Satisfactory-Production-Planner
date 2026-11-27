/**
 * Public solver API. The solver only runs on targets the player entered; it never picks
 * goals. See port.ts for the event contract.
 */
export * from './types';
export type { LpBackend, LpModel, LpRow, LpSolution, LpSolveRequest, LpStatus } from './lp/types';
export { createHighsBackend } from './lp/highs-backend';
export { buildPlanningProblem, extractorCanMine } from './problem';
export { solvePlan, SOLVER_VERSION, type SolveHooks, type StageReport, type StagePass } from './solve';
export { explain, makeLabel, fallbackLabel, fmt, hasSurplus, type Label } from './explain';
export { recipeVariants, extractorVariants, wellVariants, shardsForClock } from './variants';
export { validateRequest } from './validate';
export { SolverFailure, type EngineErrorCode } from './errors';
export {
  createInProcessSolverPort, describeOutcome, runSolve,
  type SolverPort, type SolveSpec, type SolveCall, type SolveEvent, type SolveStage, type SolveFinal, type SolveTerminal, type EngineError,
} from './port';
export {
  createProcessSolverPort, nodeSpawn,
  type ProcessSolverPort, type ProcessSolverPortOptions, type SolverProcessHandle, type SpawnSolverProcess,
} from './process/host';
export type { Fault, FaultKind } from './process/protocol';

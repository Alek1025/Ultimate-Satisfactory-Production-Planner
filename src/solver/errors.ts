/**
 * Engine failures. These are never reported as "Infeasible" or as any other plan status:
 * the SolverPort turns them into an EngineError event (rewrite notes §8, architecture
 * "Solver failures are never Infeasible").
 */

export type EngineErrorCode =
  /** The solver process exited or was killed without being asked to. */
  | 'crash'
  /** The solver process stopped sending heartbeats. */
  | 'hang'
  /** The solver process went over its memory cap, or the JS heap or WASM memory ran out. */
  | 'out-of-memory'
  /** HiGHS returned an error, threw, or answered in a way the model rules out. */
  | 'solver-error'
  /** The solver process could not be started or never reported ready. */
  | 'spawn-failed'
  /** The solver process sent a message the host does not understand. */
  | 'protocol';

/** Thrown inside the solver when the engine, not the plan, has failed. */
export class SolverFailure extends Error {
  override readonly name = 'SolverFailure';
  constructor(readonly code: EngineErrorCode, message: string) {
    super(message);
  }
}

export function isOutOfMemory(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if ((e as { code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY') return true;
  return (e instanceof RangeError && /allocat|memory|buffer/i.test(e.message))
    || /out of memory|Cannot enlarge memory/i.test(e.message);
}

/** Classifies an unexpected exception from inside a solve. */
export function toSolverFailure(e: unknown): SolverFailure {
  if (e instanceof SolverFailure) return e;
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new SolverFailure(isOutOfMemory(e) ? 'out-of-memory' : 'solver-error', message);
}

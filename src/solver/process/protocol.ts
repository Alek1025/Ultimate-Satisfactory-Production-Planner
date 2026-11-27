/**
 * Messages between the host (Engine side), the solver process's main thread ("child") and
 * the HiGHS thread inside it. Host <-> child goes over the process IPC channel; child <->
 * thread over worker_threads postMessage. Everything is structured-clone safe.
 */
import type { PlanResult, StageProgress } from '../types';
import type { SolveSpec, SolveStage } from '../port';
import type { EngineErrorCode } from '../errors';

/**
 * Test-only faults, honoured only when the child was started with USSP_SOLVER_FAULTS=1.
 *   crash         the solver process exits with code 70
 *   hang          the process's main thread spins, so heartbeats stop
 *   oom           the process allocates memory until the host's cap kills it
 *   thread-crash  the HiGHS thread throws an uncaught error
 *   thread-stall  the HiGHS thread spins (a stage that never ends); heartbeats continue
 */
export type FaultKind = 'crash' | 'hang' | 'oom' | 'thread-crash' | 'thread-stall';
export interface Fault {
  kind: FaultKind;
  /** Inject after this many stages have been reported (0 = as soon as the solve starts). */
  afterStage: number;
}

export interface SolveJob {
  id: number;
  spec: SolveSpec;
  labels?: Record<string, string>;
  fault?: Fault;
}

export type HostToChild = { t: 'solve'; job: SolveJob };

export type ChildToHost =
  | { t: 'ready' }
  | { t: 'beat'; rssMb: number }
  | { t: 'started'; id: number; progress: StageProgress }
  | { t: 'stage'; id: number; stage: SolveStage }
  | { t: 'final'; id: number; result: PlanResult }
  | { t: 'failed'; id: number | null; code: EngineErrorCode; message: string };

export type ChildToThread = { t: 'solve'; job: SolveJob };
export type ThreadToChild =
  | { t: 'ready' }
  | { t: 'started'; id: number; progress: StageProgress }
  | { t: 'stage'; id: number; stage: SolveStage }
  | { t: 'final'; id: number; result: PlanResult }
  | { t: 'failed'; id: number | null; code: EngineErrorCode; message: string };

export const FAULTS_ENV = 'USSP_SOLVER_FAULTS';
export const BEAT_ENV = 'USSP_SOLVER_BEAT_MS';
export const HEAP_ENV = 'USSP_SOLVER_HEAP_MB';

export function isChildMessage(m: unknown): m is ChildToHost {
  if (!m || typeof m !== 'object') return false;
  const t = (m as { t?: unknown }).t;
  return t === 'ready' || t === 'beat' || t === 'started' || t === 'stage' || t === 'final' || t === 'failed';
}

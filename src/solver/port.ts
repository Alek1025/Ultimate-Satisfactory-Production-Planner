/**
 * SolverPort: `solve(spec, call) → AsyncIterable<SolveStage | SolveFinal | EngineError>`
 * (architecture.md, "Key interfaces").
 *
 * Every solve yields zero or more `stage` events and then exactly one terminal event:
 *
 *   final / complete   every stage finished; `result` is the answer.
 *   final / partial    cancelled (AbortSignal) or timed out between or during stages;
 *                      `result` is the plan after the last finished stage, or null if none
 *                      finished. Shown as "Partial · stage k of n".
 *   engine-error       the engine failed (crash, hang, out of memory, HiGHS error). Never
 *                      shown as "Infeasible", and never carries a plan.
 *
 * Two implementations:
 *   createProcessSolverPort (process/host.ts)  the app's port: HiGHS in its own process with
 *                                              a warm spare, heartbeats and a memory cap.
 *   createInProcessSolverPort (here)           same events in this thread; for tests and the
 *                                              CLI. It can only stop between stages.
 */
import type { PlanningProblem, PlanRequest, PlanResult, SolveOptions, StageProgress, LevelResult } from './types';
import type { LpBackend } from './lp/types';
import type { EngineErrorCode } from './errors';
import { toSolverFailure } from './errors';
import { solvePlan, type StagePass } from './solve';
import { makeLabel } from './explain';
import { AsyncQueue } from './queue';

/** Everything the solver needs; plain JSON, so it can cross a process boundary. */
export interface SolveSpec {
  problem: PlanningProblem;
  request: PlanRequest;
  options?: Partial<SolveOptions>;
}

export interface SolveCall {
  /** Aborting yields `final / partial` with reason 'cancelled'. */
  signal?: AbortSignal;
  /** Wall-clock limit for the whole solve; reaching it yields `final / partial` with reason 'timeout'. */
  timeoutMs?: number;
  /** Display names by ClassName, for the explanation text. Not part of the fingerprint. */
  labels?: Record<string, string>;
}

export interface SolveStage {
  type: 'stage';
  /** 1-based stage number. */
  index: number;
  /** Stages known so far; can grow when the integer pass or the diagnosis is scheduled. */
  total: number;
  pass: StagePass;
  level: LevelResult | null;
  /** The plan after this stage (not proven optimal until the final event). */
  result: PlanResult | null;
}

export interface SolveFinal {
  type: 'final';
  outcome: 'complete' | 'partial';
  /** Why a partial solve stopped. */
  reason?: 'cancelled' | 'timeout';
  stage: StageProgress;
  result: PlanResult | null;
}

export interface EngineError {
  type: 'engine-error';
  code: EngineErrorCode;
  message: string;
  /** How far the solve got before the failure. */
  stage: StageProgress;
  exitCode?: number | null;
  signal?: string | null;
  rssMb?: number;
}

export type SolveEvent = SolveStage | SolveFinal | EngineError;
export type SolveTerminal = SolveFinal | EngineError;

export interface SolverPort {
  solve(spec: SolveSpec, call?: SolveCall): AsyncIterable<SolveEvent>;
  /** Stops every solver process this port owns. Later solves yield `spawn-failed`. */
  close(): Promise<void>;
}

/** Short status line for a terminal event, e.g. "Partial · stage 2 of 6". */
export function describeOutcome(e: SolveTerminal): string {
  const of = `stage ${e.stage.done} of ${e.stage.total}`;
  if (e.type === 'engine-error') return `Engine error (${e.code}) · ${of}`;
  return e.outcome === 'partial' ? `Partial · ${of}` : `Complete · ${of}`;
}

/** Drains a solve and returns its terminal event, calling `onStage` for each stage. */
export async function runSolve(
  port: SolverPort, spec: SolveSpec, call: SolveCall = {}, onStage?: (s: SolveStage) => void,
): Promise<SolveTerminal> {
  for await (const e of port.solve(spec, call)) {
    if (e.type === 'stage') onStage?.(e);
    else return e;
  }
  throw new Error('SolverPort ended without a terminal event');
}

class Stop extends Error {
  constructor(readonly reason: 'cancelled' | 'timeout') { super(reason); }
}

/**
 * Runs the solver in this thread. HiGHS calls are synchronous, so cancellation and the
 * timeout take effect at the next stage boundary; a solve stuck inside one HiGHS call can
 * only be stopped by the process port.
 */
export function createInProcessSolverPort(backend: LpBackend): SolverPort {
  let closed = false;
  return {
    async close() { closed = true; },
    solve(spec, call = {}) {
      const q = new AsyncQueue<SolveEvent>();
      let last = null as SolveStage | null;
      let total = 0;
      const deadline = call.timeoutMs !== undefined ? Date.now() + call.timeoutMs : Infinity;
      const check = () => {
        if (call.signal?.aborted) throw new Stop('cancelled');
        if (Date.now() >= deadline) throw new Stop('timeout');
      };
      const progress = (): StageProgress => ({ done: last?.index ?? 0, total: Math.max(total, last?.total ?? 0) });
      (async () => {
        if (closed) {
          q.push({ type: 'engine-error', code: 'spawn-failed', message: 'The solver port is closed.', stage: { done: 0, total: 0 } });
          return;
        }
        try {
          check();
          const result = await solvePlan(spec.problem, spec.request, backend, spec.options, makeLabel(call.labels ? new Map(Object.entries(call.labels)) : undefined), {
            onPlan: (p) => { total = p.total; },
            onStage: async (s) => {
              const ev: SolveStage = { type: 'stage', ...s };
              last = ev;
              q.push(ev);
              // Let the consumer see the stage (and abort) before the next HiGHS call.
              await new Promise<void>((r) => setImmediate(r));
              check();
            },
          });
          q.push({ type: 'final', outcome: 'complete', stage: { ...result.stage }, result });
        } catch (e) {
          if (e instanceof Stop) q.push({ type: 'final', outcome: 'partial', reason: e.reason, stage: progress(), result: last?.result ?? null });
          else {
            const f = toSolverFailure(e);
            q.push({ type: 'engine-error', code: f.code, message: f.message, stage: progress() });
          }
        }
      })().finally(() => q.end());
      return q;
    },
  };
}

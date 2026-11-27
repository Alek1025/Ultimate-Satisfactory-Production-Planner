/**
 * The HiGHS thread inside the solver process. HiGHS solves synchronously, so it runs here
 * and the process's main thread stays free to send heartbeats and relay messages.
 */
import { parentPort } from 'node:worker_threads';
import highsLoader from 'highs';
import { createHighsBackend } from '../lp/highs-backend';
import { solvePlan } from '../solve';
import { makeLabel } from '../explain';
import { toSolverFailure } from '../errors';
import type { ChildToThread, Fault, ThreadToChild } from './protocol';

const port = parentPort;
if (!port) throw new Error('solver thread must run as a worker thread');
const post = (m: ThreadToChild) => port.postMessage(m);

// Load the WASM runtime up front, so a warm spare solves without a cold start. The backend
// drops a runtime that trapped; the next solve then loads a fresh one.
let warm: ReturnType<typeof highsLoader> | undefined = highsLoader();
const startup = warm;
const backend = createHighsBackend(() => {
  const runtime = warm ?? highsLoader();
  warm = undefined;
  return runtime;
});

function spin(): never {
  for (;;) { /* a stage that never finishes */ }
}

function maybeFault(fault: Fault | undefined, stagesDone: number): void {
  if (!fault || fault.afterStage !== stagesDone) return;
  if (fault.kind === 'thread-stall') spin();
  // The thread dies outright: no try/catch sees it, as with a native abort.
  if (fault.kind === 'thread-crash') process.exit(71);
}

port.on('message', (m: ChildToThread) => {
  if (m.t !== 'solve') return;
  const { id, spec, labels, fault } = m.job;
  const faultHere = fault && (fault.kind === 'thread-stall' || fault.kind === 'thread-crash') ? fault : undefined;
  void (async () => {
    try {
      let done = 0;
      const result = await solvePlan(spec.problem, spec.request, backend, spec.options,
        makeLabel(labels ? new Map(Object.entries(labels)) : undefined), {
          onPlan: (progress) => { post({ t: 'started', id, progress }); maybeFault(faultHere, 0); },
          onStage: (s) => {
            post({ t: 'stage', id, stage: { type: 'stage', ...s } });
            done = s.index;
            maybeFault(faultHere, done);
          },
        });
      post({ t: 'final', id, result });
    } catch (e) {
      const f = toSolverFailure(e);
      post({ t: 'failed', id, code: f.code, message: f.message });
    }
  })();
});

startup.then(
  () => post({ t: 'ready' }),
  (e: unknown) => post({ t: 'failed', id: null, code: 'spawn-failed', message: `HiGHS failed to load: ${(e as Error)?.message ?? String(e)}` }),
);

/**
 * Solver process entry point (Node `child_process.fork` in M0; Electron `utilityProcess`
 * from M1 uses the same messages).
 *
 * The main thread only relays messages, sends a heartbeat with the process's resident
 * memory every BEAT_ENV ms, and reports a dead HiGHS thread. HiGHS itself runs in
 * thread.ts, so a long synchronous solve never delays a heartbeat: missing beats mean the
 * process itself is wedged.
 */
import { Worker } from 'node:worker_threads';
import { BEAT_ENV, FAULTS_ENV, HEAP_ENV, type ChildToHost, type Fault, type HostToChild, type ThreadToChild } from './protocol';
import { isOutOfMemory } from '../errors';

const send = (m: ChildToHost) => { if (process.connected) process.send!(m); };
if (!process.send) {
  console.error('solver child must be started with an IPC channel');
  process.exit(2);
}
// The host went away: nothing is left to report to.
process.on('disconnect', () => process.exit(0));

const beatMs = Number(process.env[BEAT_ENV]) || 500;
const faultsAllowed = process.env[FAULTS_ENV] === '1';
const heapMb = Number(process.env[HEAP_ENV]) || undefined;

const threadUrl = new URL(import.meta.url.endsWith('.ts') ? './thread.ts' : './thread.js', import.meta.url);
const thread = new Worker(threadUrl, heapMb ? { resourceLimits: { maxOldGenerationSizeMb: heapMb } } : {});
let current: { id: number; fault: Fault | undefined; stages: number } | null = null;

setInterval(() => send({ t: 'beat', rssMb: process.memoryUsage.rss() / 2 ** 20 }), beatMs).unref();
send({ t: 'beat', rssMb: process.memoryUsage.rss() / 2 ** 20 });

const hogs: Buffer[] = [];
function processFault(fault: Fault | undefined, stagesDone: number): void {
  if (!fault || fault.afterStage !== stagesDone) return;
  switch (fault.kind) {
    case 'crash': process.exit(70); break;
    case 'hang': for (;;) { /* wedge the main thread: no more heartbeats */ }
    case 'oom': {
      // Grow past the cap in one go and report it before relaying anything else, so the
      // host sees the overrun even when the solve itself would finish in milliseconds.
      const target = (heapMb ?? 2048) + 256;
      while (process.memoryUsage.rss() / 2 ** 20 < target) hogs.push(Buffer.alloc(64 * 2 ** 20, 1));
      send({ t: 'beat', rssMb: process.memoryUsage.rss() / 2 ** 20 });
      break;
    }
    default: break; // thread faults are injected by the thread
  }
}

thread.on('message', (m: ThreadToChild) => {
  switch (m.t) {
    case 'ready': send(m); break;
    case 'started':
      send(m);
      if (current?.id === m.id) processFault(current.fault, 0);
      break;
    case 'stage':
      send(m);
      if (current?.id === m.id) { current.stages = m.stage.index; processFault(current.fault, current.stages); }
      break;
    case 'final':
    case 'failed':
      if (current?.id === m.id) current = null;
      send(m);
      // A load failure leaves nothing to solve with.
      if (m.t === 'failed' && m.code === 'spawn-failed') setTimeout(() => process.exit(1), 50);
      break;
  }
});

const threadDied = (code: 'crash' | 'out-of-memory', message: string) => {
  send({ t: 'failed', id: current?.id ?? null, code, message });
  // Give the IPC message a moment to flush, then go: this process can't solve any more.
  setTimeout(() => process.exit(1), 50);
};
thread.on('error', (e) => threadDied(isOutOfMemory(e) ? 'out-of-memory' : 'crash', `Solver thread failed: ${e.message}`));
thread.on('exit', (code) => threadDied('crash', `Solver thread exited with code ${code}.`));

process.on('message', (m: HostToChild) => {
  if (!m || m.t !== 'solve') return;
  const fault = faultsAllowed ? m.job.fault : undefined;
  current = { id: m.job.id, fault, stages: 0 };
  const job = { ...m.job };
  if (fault) job.fault = fault; else delete job.fault;
  thread.postMessage({ t: 'solve', job });
});

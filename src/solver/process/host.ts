/**
 * The app's SolverPort: HiGHS in its own process, so cancelling or crashing a solve never
 * throws away the parsed save and World State held by the caller (architecture.md,
 * "Processes").
 *
 *   - One process per running solve, plus a warm spare that has already loaded HiGHS.
 *     A solve takes the spare and a new spare starts at once.
 *   - Cancel or timeout: the process is killed and the solve ends `final / partial` with
 *     the plan from the last finished stage ("Partial · stage k of n").
 *   - Heartbeat every `heartbeatMs` (500); `missedBeats` (3) missed in a row is a hang.
 *     Resident memory above `memoryCapMb` is out-of-memory. Both kill the process.
 *   - Any death the host did not ask for is an EngineError, never "Infeasible".
 *
 * Process creation is injectable (`spawn`), so M1 can pass Electron's utilityProcess; the
 * default forks Node with this package's child.ts (via tsx when running from source).
 */
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { StageProgress } from '../types';
import type { EngineError, SolveCall, SolveEvent, SolveSpec, SolveStage, SolverPort } from '../port';
import type { EngineErrorCode } from '../errors';
import { AsyncQueue } from '../queue';
import { BEAT_ENV, FAULTS_ENV, HEAP_ENV, isChildMessage, type ChildToHost, type Fault, type HostToChild } from './protocol';

/** The slice of a child process the host needs; Node's ChildProcess and Electron's UtilityProcess both fit. */
export interface SolverProcessHandle {
  send(message: HostToChild): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(): void;
}

export type SpawnSolverProcess = (env: Record<string, string>) => SolverProcessHandle;

export interface ProcessSolverPortOptions {
  heartbeatMs?: number;
  missedBeats?: number;
  /** Maximum silence from the computation thread while its IPC relay is still alive. */
  stageTimeoutMs?: number;
  /** Resident memory cap for one solver process, MB. Also caps the HiGHS thread's JS heap. */
  memoryCapMb?: number;
  /** How long a new process may take to load HiGHS and report ready. */
  startupTimeoutMs?: number;
  /** Keep one ready process waiting for the next solve. Default true. */
  warmSpare?: boolean;
  spawn?: SpawnSolverProcess;
  /** Test only: lets `solveWithFault` inject faults into the child. */
  allowFaultInjection?: boolean;
}

export interface ProcessSolverPort extends SolverPort {
  /** Test only (needs allowFaultInjection): like solve, with a fault injected into the solver process. */
  solveWithFault(spec: SolveSpec, fault: Fault, call?: SolveCall): AsyncIterable<SolveEvent>;
  /** Live process count (running solves + spare), for tests and status displays. */
  processCount(): number;
}

const DEFAULTS = { heartbeatMs: 500, missedBeats: 3, stageTimeoutMs: 300_000, memoryCapMb: 2048, startupTimeoutMs: 30_000 };

/** Forks child.ts (through tsx when this module runs from TypeScript source) or child.js. */
export function nodeSpawn(): SpawnSolverProcess {
  const fromSource = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(fromSource ? './child.ts' : './child.js', import.meta.url));
  const execArgv = fromSource ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
  return (env) => {
    const cp = fork(entry, [], {
      execArgv, env: { ...process.env, ...env }, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    // A failed fork reports through 'exit' as well; swallow the duplicate 'error'.
    cp.on('error', () => {});
    return {
      send: (m) => { if (cp.connected) cp.send(m); },
      onMessage: (l) => { cp.on('message', l); },
      onExit: (l) => { cp.on('exit', (code, signal) => l(code, signal)); },
      kill: () => { if (cp.exitCode === null && cp.signalCode === null) cp.kill('SIGKILL'); },
    };
  };
}

interface Proc {
  handle: SolverProcessHandle;
  ready: Promise<boolean>;
  isReady: boolean;
  dead: boolean;
  killedByHost: boolean;
  lastBeat: number;
  rssMb: number;
  /** The solve currently using this process. */
  listener: ((m: ChildToHost) => void) | null;
  cancel?: () => void;
  exitListener: ((code: number | null, signal: string | null) => void) | null;
}

export function createProcessSolverPort(options: ProcessSolverPortOptions = {}): ProcessSolverPort {
  const o = { ...DEFAULTS, ...options };
  const spawnFn = options.spawn ?? nodeSpawn();
  const warmSpare = options.warmSpare !== false;
  const env: Record<string, string> = {
    [BEAT_ENV]: String(o.heartbeatMs),
    [HEAP_ENV]: String(o.memoryCapMb),
    ...(options.allowFaultInjection ? { [FAULTS_ENV]: '1' } : {}),
  };
  let spare: Proc | null = null;
  const all = new Set<Proc>();
  let closed = false;
  let nextId = 1;

  const kill = (p: Proc) => {
    if (p.dead) return;
    p.killedByHost = true;
    p.dead = true;
    all.delete(p);
    p.handle.kill();
  };

  const spawnProc = (): Proc => {
    let resolveReady!: (ok: boolean) => void;
    const p: Proc = {
      handle: undefined as unknown as SolverProcessHandle,
      ready: new Promise<boolean>((r) => { resolveReady = r; }),
      isReady: false, dead: false, killedByHost: false, lastBeat: Date.now(), rssMb: 0, listener: null, exitListener: null,
    };
    try {
      p.handle = spawnFn(env);
    } catch {
      p.dead = true;
      resolveReady(false);
      return p;
    }
    all.add(p);
    const startup = setTimeout(() => { if (!p.isReady) { kill(p); resolveReady(false); } }, o.startupTimeoutMs);
    p.handle.onMessage((m) => {
      if (!isChildMessage(m)) {
        p.listener?.({ t: 'failed', id: null, code: 'protocol', message: 'The solver process sent an unrecognised message.' });
        return;
      }
      if (m.t === 'beat') { p.lastBeat = Date.now(); p.rssMb = m.rssMb; }
      if (m.t === 'ready') { p.isReady = true; clearTimeout(startup); resolveReady(true); }
      if (m.t === 'failed' && m.id === null && !p.isReady) { clearTimeout(startup); kill(p); resolveReady(false); }
      p.listener?.(m);
    });
    p.handle.onExit((code, signal) => {
      clearTimeout(startup);
      const wasKilled = p.killedByHost;
      p.dead = true;
      all.delete(p);
      if (spare === p) spare = null;
      resolveReady(false);
      if (!wasKilled) p.exitListener?.(code, signal);
    });
    return p;
  };

  const refillSpare = () => {
    if (!closed && warmSpare && (!spare || spare.dead)) spare = spawnProc();
  };
  refillSpare();

  const take = (): Proc => {
    const p = spare && !spare.dead ? spare : spawnProc();
    if (p === spare) spare = null;
    refillSpare();
    return p;
  };

  /** A process that finished a solve cleanly becomes the spare, if there isn't one already. */
  const release = (p: Proc) => {
    p.cancel = undefined;
    p.listener = null;
    p.exitListener = null;
    if (p.dead) return;
    if (!closed && warmSpare && (!spare || spare.dead)) spare = p;
    else kill(p);
  };

  const run = (spec: SolveSpec, call: SolveCall, fault?: Fault): AsyncIterable<SolveEvent> => {
    const q = new AsyncQueue<SolveEvent>();
    const id = nextId++;
    let last = null as SolveStage | null;
    let planned: StageProgress = { done: 0, total: 0 };
    let finished = false;
    let lastProgress = Date.now();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let proc: Proc | null = null;
    const progress = (): StageProgress => ({ done: last?.index ?? 0, total: Math.max(planned.total, last?.total ?? 0) });

    const cleanup = () => {
      timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      call.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (event: SolveEvent | null, reuse: boolean) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (proc) { if (reuse) release(proc); else kill(proc); }
      if (event) q.push(event);
      q.end();
    };
    const fail = (code: EngineErrorCode, message: string, extra: Partial<EngineError> = {}) =>
      finish({ type: 'engine-error', code, message, stage: progress(), ...extra }, false);
    const partial = (reason: 'cancelled' | 'timeout') =>
      finish({ type: 'final', outcome: 'partial', reason, stage: progress(), result: last?.result ?? null }, false);
    function onAbort() { partial('cancelled'); }
    // The consumer stopped iterating: nothing will read the result, so stop the work.
    q.onClose = () => finish(null, false);

    if (closed) { fail('spawn-failed', 'The solver port is closed.'); return q; }
    if (call.signal?.aborted) { partial('cancelled'); return q; }
    call.signal?.addEventListener('abort', onAbort, { once: true });
    if (call.timeoutMs !== undefined) timers.push(setTimeout(() => partial('timeout'), call.timeoutMs));

    const p = take();
    proc = p;
    p.cancel = onAbort;
    p.exitListener = (code, signal) => fail('crash', `The solver process exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`}).`, { exitCode: code, signal });
    p.listener = (m) => {
      if (finished) return;
      switch (m.t) {
        case 'beat':
          if (p.rssMb > o.memoryCapMb) fail('out-of-memory', `The solver process used ${Math.round(p.rssMb)} MB, over its ${o.memoryCapMb} MB cap.`, { rssMb: p.rssMb });
          break;
        case 'started': if (m.id === id) { planned = m.progress; lastProgress = Date.now(); } break;
        case 'stage': if (m.id === id) { last = m.stage; lastProgress = Date.now(); q.push(m.stage); } break;
        case 'final': if (m.id === id) finish({ type: 'final', outcome: 'complete', stage: { ...m.result.stage }, result: m.result }, true); break;
        case 'failed': if (m.id === id || m.id === null) fail(m.code, m.message); break;
        default: break;
      }
    };

    void p.ready.then((ok) => {
      if (finished) return;
      if (!ok) { fail('spawn-failed', 'The solver process did not start (HiGHS failed to load, or it timed out).'); return; }
      lastProgress = p.lastBeat = Date.now();
      const watchdog = setInterval(() => {
        if (finished) return;
        if (Date.now() - p.lastBeat > o.heartbeatMs * o.missedBeats) {
          fail('hang', `The solver process missed ${o.missedBeats} heartbeats (${o.heartbeatMs} ms each).`);
        } else if (Date.now() - lastProgress > o.stageTimeoutMs) {
          fail('hang', `The solver thread made no stage progress for ${o.stageTimeoutMs} ms.`);
        }
      }, o.heartbeatMs);
      timers.push(watchdog);
      p.handle.send({ t: 'solve', job: { id, spec, ...(call.labels ? { labels: call.labels } : {}), ...(fault ? { fault } : {}) } });
    });
    return q;
  };

  return {
    solve: (spec, call = {}) => run(spec, call),
    solveWithFault: (spec, fault, call = {}) => {
      if (!options.allowFaultInjection) throw new Error('fault injection is off for this port');
      return run(spec, call, fault);
    },
    processCount: () => all.size,
    async close() {
      closed = true;
      for (const p of [...all]) {
        p.cancel?.();
        kill(p);
      }
      spare = null;
    },
  };
}

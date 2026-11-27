/**
 * SolverPort contract: the process port (HiGHS in a child process with a warm spare) and
 * the in-process port. Invariant (architecture.md, M0): solver failures are never
 * "Infeasible"; crashes, out-of-memory and hangs are engine errors, and stopping between
 * stages is "Partial · stage k of n".
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  createInProcessSolverPort, describeOutcome, runSolve, type SolveSpec, type SolveStage, type SolverPort,
} from '../../src/solver/port';
import { createProcessSolverPort, type ProcessSolverPort } from '../../src/solver/process/host';
import type { LpBackend } from '../../src/solver/lp/types';
import { backend, request, toyProblem } from './helpers';

/** maximize Plate on the toy world: 5 stages (maximize, scarcity, power, buildings, tie-break). */
const spec = (): SolveSpec => ({ problem: toyProblem(), request: request({ maximize: [{ item: 'Plate' }] }) });

const ports: SolverPort[] = [];
const processPort = (o: Parameters<typeof createProcessSolverPort>[0] = {}): ProcessSolverPort => {
  const p = createProcessSolverPort({ heartbeatMs: 100, missedBeats: 3, allowFaultInjection: true, startupTimeoutMs: 60_000, ...o });
  ports.push(p);
  return p;
};
afterAll(async () => { await Promise.all(ports.map((p) => p.close())); });

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('process port', () => {
  const port = processPort();

  it('solves in the child and streams every stage, then a complete final', async () => {
    const stages: SolveStage[] = [];
    const end = await runSolve(port, spec(), { labels: { Plate: 'Iron Plate' } }, (s) => stages.push(s));
    expect(stages.map((s) => s.index)).toEqual([1, 2, 3, 4, 5]);
    expect(end.type).toBe('final');
    if (end.type !== 'final') return;
    expect(end.outcome).toBe('complete');
    expect(describeOutcome(end)).toBe('Complete · stage 5 of 5');
    expect(end.result!.items.find((i) => i.item === 'Plate')!.delivered).toBeCloseTo(270);
    expect(end.result!.explanation.join('\n')).toMatch(/More Iron Plate is limited by/);
  }, 60_000);

  it('keeps a warm spare: after a solve, one ready process is waiting', async () => {
    await runSolve(port, spec());
    await waitFor(() => port.processCount() === 1);
    expect(port.processCount()).toBe(1);
  }, 60_000);

  it('a crash mid-solve is an engine error that keeps the stage reached, never Infeasible', async () => {
    const stages: SolveStage[] = [];
    let end;
    for await (const e of port.solveWithFault(spec(), { kind: 'crash', afterStage: 2 })) {
      if (e.type === 'stage') stages.push(e); else end = e;
    }
    expect(end).toMatchObject({ type: 'engine-error', code: 'crash', exitCode: 70, stage: { done: 2, total: 5 } });
    expect(describeOutcome(end!)).toBe('Engine error (crash) · stage 2 of 5');
    // The port recovers: the next solve runs on the warm spare.
    const next = await runSolve(port, spec());
    expect(next).toMatchObject({ type: 'final', outcome: 'complete' });
  }, 60_000);

  it('a dead HiGHS thread is an engine error (crash)', async () => {
    const end = await runSolve(port, spec());
    expect(end.type).toBe('final');
    let fault;
    for await (const e of port.solveWithFault(spec(), { kind: 'thread-crash', afterStage: 1 })) if (e.type !== 'stage') fault = e;
    expect(fault).toMatchObject({ type: 'engine-error', code: 'crash', stage: { done: 1 } });
  }, 60_000);

  it('missed heartbeats are a hang: the process is killed and reported, not left running', async () => {
    const t = Date.now();
    let end;
    for await (const e of port.solveWithFault(spec(), { kind: 'hang', afterStage: 3 })) if (e.type !== 'stage') end = e;
    expect(end).toMatchObject({ type: 'engine-error', code: 'hang', stage: { done: 3, total: 5 } });
    expect(Date.now() - t).toBeLessThan(20_000);
  }, 60_000);

  it('going over the memory cap is out-of-memory', async () => {
    const small = processPort({ memoryCapMb: 400, warmSpare: false });
    let end;
    for await (const e of small.solveWithFault(spec(), { kind: 'oom', afterStage: 0 })) if (e.type !== 'stage') end = e;
    expect(end).toMatchObject({ type: 'engine-error', code: 'out-of-memory', stage: { done: 0, total: 5 } });
    expect((end as { rssMb: number }).rssMb).toBeGreaterThan(400);
    await waitFor(() => small.processCount() === 0);
  }, 60_000);

  it('a timeout during a stage that never ends gives Partial · stage k of n with that stage\'s plan', async () => {
    const end = await runSolve(port, spec(), { timeoutMs: 1500 });
    expect(end.type).toBe('final'); // warm-up: the stall below must not be a cold start
    let partial;
    for await (const e of port.solveWithFault(spec(), { kind: 'thread-stall', afterStage: 2 }, { timeoutMs: 1500 })) if (e.type !== 'stage') partial = e;
    expect(partial).toMatchObject({ type: 'final', outcome: 'partial', reason: 'timeout', stage: { done: 2, total: 5 } });
    expect(describeOutcome(partial!)).toBe('Partial · stage 2 of 5');
    // The partial plan is the one after stage 2: it already delivers the maximum.
    const r = (partial as { result: { items: { item: string; delivered: number }[]; provenOptimal: boolean } }).result;
    expect(r.items.find((i) => i.item === 'Plate')!.delivered).toBeCloseTo(270);
    expect(r.provenOptimal).toBe(false);
  }, 60_000);

  it('cancelling kills the solve and gives Partial, not an error', async () => {
    const ac = new AbortController();
    let partial;
    for await (const e of port.solveWithFault(spec(), { kind: 'thread-stall', afterStage: 1 }, { signal: ac.signal })) {
      if (e.type === 'stage' && e.index === 1) ac.abort();
      if (e.type !== 'stage') partial = e;
    }
    expect(partial).toMatchObject({ type: 'final', outcome: 'partial', reason: 'cancelled', stage: { done: 1, total: 5 } });
  }, 60_000);

  it('a consumer that stops reading ends the solve and frees the process', async () => {
    for await (const e of port.solveWithFault(spec(), { kind: 'thread-stall', afterStage: 1 })) {
      if (e.type === 'stage') break;
    }
    await waitFor(() => port.processCount() === 1); // only the spare is left
  }, 60_000);

  it('detects a stalled computation even when the relay sends heartbeats', async () => {
    const isolated = processPort({warmSpare: false, stageTimeoutMs: 1000});
    let end;
    for await (const e of isolated.solveWithFault(spec(), {kind: 'thread-stall', afterStage: 2})) {
      if (e.type !== 'stage') end = e;
    }
    expect(end).toMatchObject({type: 'engine-error', code: 'hang', stage: {done: 2}});
  }, 60_000);

  it('closing a port finishes an active solve as cancelled', async () => {
    const isolated = processPort({warmSpare: false});
    let end;
    for await (const e of isolated.solveWithFault(spec(), {kind: 'thread-stall', afterStage: 1})) {
      if (e.type === 'stage') await isolated.close();
      else end = e;
    }
    expect(end).toMatchObject({type: 'final', outcome: 'partial', reason: 'cancelled'});
  }, 60_000);

  it('faults are ignored unless the port allows them', async () => {
    const safe = processPort({ allowFaultInjection: false });
    expect(() => safe.solveWithFault(spec(), { kind: 'crash', afterStage: 0 })).toThrow(/fault injection is off/);
  });

  it('a closed port reports spawn-failed', async () => {
    const closed = processPort({ warmSpare: false });
    await closed.close();
    expect(await runSolve(closed, spec())).toMatchObject({ type: 'engine-error', code: 'spawn-failed' });
  });
});

describe('in-process port', () => {
  it('yields the same events', async () => {
    const stages: SolveStage[] = [];
    const end = await runSolve(createInProcessSolverPort(backend), spec(), {}, (s) => stages.push(s));
    expect(stages).toHaveLength(5);
    expect(end).toMatchObject({ type: 'final', outcome: 'complete', stage: { done: 5, total: 5 } });
  });

  it('cancels at the next stage boundary with Partial', async () => {
    const ac = new AbortController();
    const port = createInProcessSolverPort(backend);
    const end = await runSolve(port, spec(), { signal: ac.signal }, (s) => { if (s.index === 2) ac.abort(); });
    expect(end).toMatchObject({ type: 'final', outcome: 'partial', reason: 'cancelled', stage: { done: 2, total: 5 } });
  });

  it('an LP backend error is an engine error, not a plan status', async () => {
    const broken: LpBackend = { name: 'broken', solve: async () => ({ status: 'error', objective: NaN, message: 'boom' }) };
    const end = await runSolve(createInProcessSolverPort(broken), spec());
    expect(end).toMatchObject({ type: 'engine-error', code: 'solver-error' });
    expect(JSON.stringify(end)).not.toMatch(/infeasible"|"Infeasible/);
  });

  it('a thrown out-of-memory RangeError is classified as out-of-memory', async () => {
    const oom: LpBackend = { name: 'oom', solve: async () => { throw new RangeError('Array buffer allocation failed'); } };
    expect(await runSolve(createInProcessSolverPort(oom), spec())).toMatchObject({ type: 'engine-error', code: 'out-of-memory' });
  });
});

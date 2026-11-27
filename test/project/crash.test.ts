// M0 invariant: journal replay is durable and idempotent, even when Main is killed mid-commit or
// mid-fold. These tests kill a real child process (no graceful shutdown, no finally blocks) and
// then reopen the file in this process.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectStore, type FaultPoint } from '../../src/project';
import { model, opId, runChild, tempDir, workloadOp } from './support';

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tempDir()));
afterEach(() => cleanup());

function contentOf(s: ProjectStore) {
  const { worldBase, charter, network } = s.working('main');
  return { worldBase, charter, network };
}

/** Reopen twice and check replay is deterministic and the file is consistent. Returns a summary. */
function reopenAndCheck(file: string) {
  const first = ProjectStore.open(file);
  const a = { recovery: first.recovery, head: first.head(), content: contentOf(first), entries: first.journalEntries() };
  expect(first.verify()).toEqual({ ok: true, problems: [] });
  first.close();
  const second = ProjectStore.open(file);
  expect(second.recovery).toEqual(a.recovery);
  expect(second.head()).toEqual(a.head);
  expect(contentOf(second)).toEqual(a.content);
  expect(second.replay()).toEqual(a.recovery);
  second.close();
  return a;
}

/** Project with ops 0..2 folded and ops 3..4 pending on main. */
function seed(file: string) {
  const s = ProjectStore.create(file);
  for (let i = 0; i < 3; i++) s.journal(workloadOp(i), { opId: opId(i) });
  s.fold();
  for (let i = 3; i < 5; i++) s.journal(workloadOp(i), { opId: opId(i) });
  const before = { head: s.head(), counts: s.counts(), content: contentOf(s) };
  s.close();
  return before;
}

describe('kill at a named point inside a write', () => {
  const rolledBack: FaultPoint[] = ['fold:after-revision', 'fold:after-ref', 'fold:before-commit'];

  it('journal: killed before COMMIT leaves no trace', async () => {
    const file = path.join(dir, 'p.ussp');
    const before = seed(file);
    const run = await runChild(['fault', file, 'journal:before-commit', 'journal', '5']);
    expect(run.lines).toEqual(['kill journal:before-commit']);
    const after = reopenAndCheck(file);
    expect(after.entries.map((e) => e.opId)).toEqual([0, 1, 2, 3, 4].map(opId));
    expect(after.content).toEqual(model(5));
    expect(after.head).toEqual(before.head);
  });

  it('journal: killed right after COMMIT keeps the op', async () => {
    const file = path.join(dir, 'p.ussp');
    seed(file);
    const run = await runChild(['fault', file, 'journal:after-commit', 'journal', '5']);
    expect(run.lines).toEqual(['kill journal:after-commit']);
    const after = reopenAndCheck(file);
    expect(after.entries.map((e) => e.opId)).toEqual([0, 1, 2, 3, 4, 5].map(opId));
    expect(after.recovery.pendingTotal).toBe(3);
    expect(after.content).toEqual(model(6));
  });

  for (const point of rolledBack) {
    it(`fold: killed at ${point} keeps every edit pending and writes no revision`, async () => {
      const file = path.join(dir, 'p.ussp');
      const before = seed(file);
      const run = await runChild(['fault', file, point, 'fold']);
      expect(run.lines).toEqual([`kill ${point}`]);
      const after = reopenAndCheck(file);
      expect(after.head).toEqual(before.head);
      expect(after.recovery.pendingTotal).toBe(2);
      expect(after.content).toEqual(model(5));
      const s = ProjectStore.open(file);
      expect(s.counts()).toEqual(before.counts);
      // The interrupted fold can simply be redone.
      const id = s.fold();
      expect(s.getRevision(id!).parents).toEqual([before.head.revision]);
      expect(contentOf(s)).toEqual(model(5));
      s.close();
    });
  }

  it('fold: killed right after COMMIT has folded everything', async () => {
    const file = path.join(dir, 'p.ussp');
    const before = seed(file);
    const run = await runChild(['fault', file, 'fold:after-commit', 'fold']);
    expect(run.lines).toEqual(['kill fold:after-commit']);
    const after = reopenAndCheck(file);
    expect(after.recovery.pendingTotal).toBe(0);
    expect(after.head.revision).not.toBe(before.head.revision);
    expect(after.content).toEqual(model(5));
    expect(after.entries.every((e) => e.foldedInto !== null)).toBe(true);
    // Retrying the last op after the crash is a no-op.
    const s = ProjectStore.open(file);
    expect(s.journal(workloadOp(4), { opId: opId(4) }).duplicate).toBe(true);
    expect(s.fold()).toBeNull();
    s.close();
  });

  it('commit: killed before COMMIT writes no revision', async () => {
    const file = path.join(dir, 'p.ussp');
    const before = seed(file);
    const run = await runChild(['fault', file, 'commit:before-commit', 'commit']);
    expect(run.lines).toEqual(['kill commit:before-commit']);
    reopenAndCheck(file);
    const s = ProjectStore.open(file);
    expect(s.counts()).toEqual(before.counts);
    s.close();
  });

  it('export: killed before the rename leaves no half-written export and the source intact', async () => {
    const file = path.join(dir, 'p.ussp');
    const out = path.join(dir, 'copy.ussp');
    seed(file);
    const run = await runChild(['fault', file, 'export:before-rename', 'export', out]);
    expect(run.lines).toEqual(['kill export:before-rename']);
    expect(existsSync(out)).toBe(false);
    reopenAndCheck(file);
    const s = ProjectStore.open(file);
    s.exportTo(out);
    s.close();
    expect(reopenAndCheck(out).content).toEqual(model(5));
  });

  it('create: killed before the rename leaves no project at the target', async () => {
    const out = path.join(dir, 'new.ussp');
    const run = await runChild(['fault', '-', 'create:before-rename', 'create', out]);
    expect(run.lines).toEqual(['kill create:before-rename']);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith('new.ussp.creating-'))).toBe(true);
    ProjectStore.create(out).close();
    expect(reopenAndCheck(out).recovery.pendingTotal).toBe(0);
  });
});

describe('kill at a random moment while writing', () => {
  it('every acknowledged op survives, nothing else appears, and replay matches the model', async () => {
    const file = path.join(dir, 'p.ussp');
    ProjectStore.create(file).close();
    const foldEvery = 7;
    let acked = -1;
    let kills = 0;
    for (let round = 0; round < 8; round++) {
      const target = acked + 3 + ((round * 5) % 11);
      const run = await runChild(
        ['loop', file, String(acked + 1), String(foldEvery)],
        (lines) => lines.some((l) => l.startsWith(`ack ${target}`)),
        (round * 3) % 7,
      );
      expect(run.stderr).toBe('');
      expect(run.lines[0]).toBe('ready');
      if (run.killedByParent) kills++;
      const acks = run.lines.filter((l) => l.startsWith('ack ')).map((l) => Number(l.split(' ')[1]));
      acked = Math.max(acked, ...acks);

      const s = ProjectStore.open(file);
      const ids = s.journalEntries().map((e) => e.opId);
      s.close();
      // Every acknowledged op is durable; at most the one in flight committed without its ack.
      expect(ids.length === acked + 1 || ids.length === acked + 2).toBe(true);
      expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => opId(i)));
      const after = reopenAndCheck(file);
      expect(after.content).toEqual(model(ids.length));
      // Folded and pending entries split exactly at a fold boundary.
      const folded = after.entries.filter((e) => e.foldedInto !== null).length;
      expect(folded % foldEvery).toBe(0);
      expect(after.recovery.pendingTotal).toBe(ids.length - folded);
    }
    expect(kills).toBe(8);
    expect(acked).toBeGreaterThan(20);

    const s = ProjectStore.open(file);
    s.foldAll();
    expect(s.pending('main')).toEqual([]);
    expect(contentOf(s)).toEqual(model(s.journalEntries().length));
    expect(s.verify().ok).toBe(true);
    s.close();
  }, 120_000);
});

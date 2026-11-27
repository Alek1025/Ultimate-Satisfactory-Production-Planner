import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPLICATION_ID, AutoFolder, canonicalJson, ProjectStore, SCHEMA_VERSION, sha256Hex } from '../../src/project';
import { tempDir } from './support';

let dir: string;
let cleanup: () => void;
const open: ProjectStore[] = [];
beforeEach(() => ({ dir, cleanup } = tempDir()));
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  cleanup();
});

const clock = () => new Date('2026-11-27T12:00:00.000Z');
function create(name = 'p.ussp') {
  const s = ProjectStore.create(path.join(dir, name), { now: clock });
  open.push(s);
  return s;
}
function reopen(s: ProjectStore, opts = {}) {
  s.close();
  const r = ProjectStore.open(s.file, { now: clock, ...opts });
  open.push(r);
  return r;
}
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
  return 'no error';
};

describe('create and open', () => {
  it('creates a project with an empty root revision on main and HEAD -> main', () => {
    const s = create();
    const { ref, revision } = s.head();
    expect(ref).toBe('main');
    const root = s.readRevision(revision);
    expect(root).toMatchObject({ parents: [], worldBase: null, charter: {}, network: {}, message: 'Create project' });
    expect(s.listRefs()).toEqual([
      { name: 'HEAD', revision: null, symbolic: 'main' },
      { name: 'main', revision, symbolic: null },
    ]);
    expect(s.recovery).toEqual({ schemaVersion: SCHEMA_VERSION, migratedFrom: null, refs: [{ ref: 'main', base: revision, pending: 0 }], pendingTotal: 0 });
    expect(readdirNames()).toEqual(['p.ussp', 'p.ussp-shm', 'p.ussp-wal']);
  });

  it('sets the application id, schema version and WAL mode', () => {
    const s = create();
    s.close();
    const db = new DatabaseSync(s.file, { readOnly: true });
    const one = (sql: string) => Object.values(db.prepare(sql).get()!)[0];
    expect(one('PRAGMA application_id')).toBe(APPLICATION_ID);
    expect(one('PRAGMA user_version')).toBe(SCHEMA_VERSION);
    expect(one('PRAGMA journal_mode')).toBe('wal');
    db.close();
  });

  it('refuses to create over an existing file and to open a missing one', () => {
    const s = create();
    expect(codeOf(() => ProjectStore.create(s.file))).toBe('EXISTS');
    expect(codeOf(() => ProjectStore.open(path.join(dir, 'missing.ussp')))).toBe('NOT_FOUND');
  });

  it('refuses files that are not projects', () => {
    const junk = path.join(dir, 'junk.ussp');
    writeFileSync(junk, 'not sqlite at all, just some text that is long enough to be a header '.repeat(10));
    expect(codeOf(() => ProjectStore.open(junk))).toBe('NOT_A_PROJECT');
    const other = path.join(dir, 'other.db');
    const db = new DatabaseSync(other);
    db.exec('CREATE TABLE t (x)');
    db.close();
    expect(codeOf(() => ProjectStore.open(other))).toBe('NOT_A_PROJECT');
  });

  it('refuses a file from a newer schema', () => {
    const s = create();
    s.close();
    const db = new DatabaseSync(s.file);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(codeOf(() => ProjectStore.open(s.file))).toBe('SCHEMA_TOO_NEW');
  });

  it('opens read-only without writing', () => {
    const s = create();
    s.journal({ kind: 'set', doc: 'charter', path: ['a'], value: 1 });
    const r = reopen(s, { readOnly: true });
    expect(r.working().charter).toEqual({ a: 1 });
    expect(() => r.fold()).toThrow();
  });
});

function readdirNames() {
  return ['p.ussp', 'p.ussp-shm', 'p.ussp-wal'].filter((f) => existsSync(path.join(dir, f)));
}

describe('blobs', () => {
  it('stores canonical JSON once, compressed, addressed by sha256', () => {
    const s = create();
    const big = { items: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: 'Desc_IronPlate_C' })) };
    const h = s.putBlob(big);
    expect(h).toBe(sha256Hex(canonicalJson(big)));
    expect(s.putBlob(JSON.parse(JSON.stringify(big)))).toBe(h);
    expect(s.getBlob(h)).toEqual(big);
    s.close();
    const db = new DatabaseSync(s.file, { readOnly: true });
    const row = db.prepare('SELECT codec, size, length(data) AS stored FROM blobs WHERE hash = ?').get(h)!;
    db.close();
    expect(row.codec).toBe('zstd');
    expect(Number(row.stored)).toBeLessThan(Number(row.size) / 5);
  });

  it('detects a blob whose bytes no longer match its hash', () => {
    const s = create();
    const h = s.putBlob({ ok: true });
    s.close();
    const db = new DatabaseSync(s.file);
    db.prepare('UPDATE blobs SET data = ? WHERE hash = ?').run(zstdCompressSync(Buffer.from('{"ok":false}')), h);
    db.close();
    const r = reopen(s);
    expect(codeOf(() => r.getBlob(h))).toBe('CORRUPT');
    const report = r.verify();
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain(h);
  });
});

describe('revisions, refs and forks', () => {
  it('commit(rev, parents) supports forks and two-parent rebases with content ids', () => {
    const s = create();
    const root = s.head().revision;
    const snap = s.addSnapshot({ sourceKind: 'save', saveHash: 'a'.repeat(64), docsHash: 'b'.repeat(64), observations: { buildings: 3 } });
    const a = s.commit({ charter: { goal: 'a' }, network: {}, worldBase: snap, message: 'A' }, [root]);
    const b = s.commit({ charter: { goal: 'b' }, network: {}, message: 'B' }, [root]);
    const m = s.commit({ charter: { goal: 'ab' }, network: {}, worldBase: snap, message: 'rebase' }, [a, b]);
    expect(s.getRevision(m).parents).toEqual([a, b]);
    expect(s.readRevision(a)).toMatchObject({ worldBase: snap, charter: { goal: 'a' }, parents: [root] });
    // Same content and parents: same id, no duplicate row.
    expect(s.commit({ charter: { goal: 'a' }, network: {}, worldBase: snap, message: 'A' }, [root])).toBe(a);
    expect(s.counts().plan_revisions).toBe(4);
    s.createRef('what-if/rail', b);
    s.setRef('main', m, { expect: root });
    expect(s.log('main').map((r) => r.message)).toEqual(['rebase', 'A', 'Create project']);
    expect(s.ref('what-if/rail')).toBe(b);
    expect(s.ref('nope')).toBeNull();
    expect(s.getSnapshot(snap)).toMatchObject({ sourceKind: 'save', parent: null, saveHash: 'a'.repeat(64) });
    expect(s.verify()).toEqual({ ok: true, problems: [] });
  });

  it('rejects bad parents, bad snapshots, bad ref names and failed compare-and-swap', () => {
    const s = create();
    const root = s.head().revision;
    expect(codeOf(() => s.commit({ charter: {}, network: {}, message: 'x' }, ['f'.repeat(64)]))).toBe('NOT_FOUND');
    expect(codeOf(() => s.commit({ charter: {}, network: {}, message: 'x' }, [root, root]))).toBe('INVALID');
    expect(codeOf(() => s.commit({ charter: {}, network: {}, worldBase: 'nope', message: 'x' }, [root]))).toBe('NOT_FOUND');
    expect(codeOf(() => s.createRef('HEAD', root))).toBe('REF_CONFLICT');
    expect(codeOf(() => s.createRef('bad name', root))).toBe('REF_CONFLICT');
    expect(codeOf(() => s.createRef('main', root))).toBe('REF_CONFLICT');
    const next = s.commit({ charter: { v: 1 }, network: {}, message: 'v1' }, [root]);
    expect(codeOf(() => s.setRef('main', next, { expect: next }))).toBe('REF_CONFLICT');
    expect(codeOf(() => s.deleteRef('main'))).toBe('REF_CONFLICT');
  });

  it('checkout moves HEAD between refs, and each ref has its own journal', () => {
    const s = create();
    s.createRef('fork', s.head().revision);
    s.journal({ kind: 'set', doc: 'charter', path: ['on'], value: 'main' });
    s.checkout('fork');
    s.journal({ kind: 'set', doc: 'charter', path: ['on'], value: 'fork' });
    expect(s.working('main').charter).toEqual({ on: 'main' });
    expect(s.working().charter).toEqual({ on: 'fork' });
    expect(s.foldAll()).toEqual({ fork: expect.any(String), main: expect.any(String) });
    expect(reopen(s).head().ref).toBe('fork');
  });
});

describe('journal and fold', () => {
  it('replays pending edits after reopen and folds them into one revision', () => {
    const s = create();
    const root = s.head().revision;
    s.journal({ kind: 'set', doc: 'charter', path: ['goals'], value: {} });
    s.journal({ kind: 'set', doc: 'charter', path: ['goals', 'plates'], value: { rate: 6340 } });
    s.journal({ kind: 'set', doc: 'network', path: ['sites'], value: [{ id: 'a' }] });
    const r = reopen(s);
    expect(r.recovery.pendingTotal).toBe(3);
    expect(r.working()).toMatchObject({ base: root, pending: 3, charter: { goals: { plates: { rate: 6340 } } }, network: { sites: [{ id: 'a' }] } });
    const id = r.fold('HEAD', { message: 'Save' })!;
    expect(r.getRevision(id)).toMatchObject({ parents: [root], message: 'Save' });
    expect(r.working()).toMatchObject({ base: id, pending: 0, lastSeq: null });
    expect(r.fold()).toBeNull();
    expect(reopen(r).readRevision(id).charter).toEqual({ goals: { plates: { rate: 6340 } } });
  });

  it('rejects an edit that does not apply and stores nothing', () => {
    const s = create();
    expect(codeOf(() => s.journal({ kind: 'remove', doc: 'charter', path: ['missing'] }))).toBe('BAD_EDIT');
    expect(codeOf(() => s.journal({ kind: 'setWorldBase', snapshot: 'nope' }))).toBe('BAD_EDIT');
    expect(codeOf(() => s.journal({ kind: 'nope' }))).toBe('BAD_EDIT');
    expect(s.journalEntries()).toEqual([]);
  });

  it('a retried op id is a no-op, before and after folding; reuse for a different edit is refused', () => {
    const s = create();
    const op = { kind: 'insert', doc: 'network', path: ['list', 0], value: 1 } as const;
    s.journal({ kind: 'set', doc: 'network', path: ['list'], value: [] }, { opId: 'init' });
    expect(s.journal(op, { opId: 'x' }).duplicate).toBe(false);
    expect(s.journal(op, { opId: 'x' }).duplicate).toBe(true);
    expect(s.working().network).toEqual({ list: [1] });
    s.fold();
    expect(s.journal(op, { opId: 'x' }).duplicate).toBe(true);
    expect(s.working().network).toEqual({ list: [1] });
    expect(codeOf(() => s.journal({ ...op, value: 2 }, { opId: 'x' }))).toBe('OP_ID_CONFLICT');
    expect(s.pruneJournal()).toBe(2);
    expect(s.journal(op, { opId: 'x' }).duplicate).toBe(false);
  });

  it('a ref with pending edits cannot be moved or deleted unless they are discarded', () => {
    const s = create();
    const root = s.head().revision;
    const other = s.commit({ charter: { other: true }, network: {}, message: 'o' }, [root]);
    s.journal({ kind: 'set', doc: 'charter', path: ['a'], value: 1 });
    expect(codeOf(() => s.setRef('main', other))).toBe('PENDING_EDITS');
    s.setRef('main', other, { discardPending: true });
    expect(s.working()).toMatchObject({ base: other, pending: 0, charter: { other: true } });
    s.createRef('f', root);
    s.journal({ kind: 'set', doc: 'charter', path: ['a'], value: 1 }, { ref: 'f' });
    expect(codeOf(() => s.deleteRef('f'))).toBe('PENDING_EDITS');
    s.deleteRef('f', { discardPending: true });
    expect(s.ref('f')).toBeNull();
  });

  it('a fault thrown mid-fold rolls the whole fold back', () => {
    let armed = false;
    const s = ProjectStore.create(path.join(dir, 'p.ussp'), {
      faults: (p) => {
        if (armed && p === 'fold:before-commit') throw new Error('boom');
      },
    });
    open.push(s);
    const root = s.head().revision;
    s.journal({ kind: 'set', doc: 'charter', path: ['a'], value: 1 });
    const before = s.counts();
    armed = true;
    expect(() => s.fold()).toThrow('boom');
    expect(s.counts()).toEqual(before);
    expect(s.working()).toMatchObject({ base: root, pending: 1, charter: { a: 1 } });
    armed = false;
    expect(s.fold()).not.toBeNull();
  });

  it('working() hands out copies, so callers cannot change the replayed state', () => {
    const s = create();
    s.journal({ kind: 'set', doc: 'charter', path: ['a'], value: { n: 1 } });
    const w = s.working();
    (w.charter.a as { n: number }).n = 99;
    expect(s.working().charter).toEqual({ a: { n: 1 } });
  });

  it('sees edits written by another connection (cache keyed on head and last seq)', () => {
    const s = create();
    s.journal({ kind: 'set', doc: 'charter', path: ['a'], value: 1 });
    const other = ProjectStore.open(s.file);
    open.push(other);
    other.journal({ kind: 'set', doc: 'charter', path: ['b'], value: 2 });
    expect(s.working().charter).toEqual({ a: 1, b: 2 });
    other.fold();
    expect(s.working()).toMatchObject({ pending: 0, charter: { a: 1, b: 2 } });
  });
});

describe('auto-fold after idle', () => {
  it('folds 30 s after the last edit, and touch() restarts the timer', () => {
    vi.useFakeTimers();
    try {
      const s = create();
      const onFold = vi.fn();
      const af = new AutoFolder(s, { onFold });
      s.journal({ kind: 'set', doc: 'charter', path: ['a'], value: 1 });
      af.touch();
      vi.advanceTimersByTime(20_000);
      s.journal({ kind: 'set', doc: 'charter', path: ['b'], value: 2 });
      af.touch();
      vi.advanceTimersByTime(20_000);
      expect(onFold).not.toHaveBeenCalled();
      expect(s.working().pending).toBe(2);
      vi.advanceTimersByTime(10_000);
      expect(onFold).toHaveBeenCalledWith({ main: s.head().revision });
      expect(s.working().pending).toBe(0);
      expect(af.scheduled).toBe(false);
      af.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed idle fold and leaves the edits pending', () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const s = ProjectStore.create(path.join(dir, 'p.ussp'), { faults: (p) => { if (fail && p === 'fold:after-ref') throw new Error('disk'); } });
      open.push(s);
      const onError = vi.fn();
      const af = new AutoFolder(s, { onError, idleMs: 1000 });
      s.journal({ kind: 'set', doc: 'charter', path: ['a'], value: 1 });
      af.touch();
      vi.advanceTimersByTime(1000);
      expect(onError).toHaveBeenCalledOnce();
      expect(s.working().pending).toBe(1);
      fail = false;
      expect(Object.keys(af.flush())).toEqual(['main']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('caches', () => {
  it('stores solve results by dispatch fingerprint and variance reports by snapshot and revision', () => {
    const s = create();
    const fp = 'f'.repeat(64);
    expect(s.getSolveResult(fp)).toBeNull();
    s.putSolveResult(fp, { status: 'partial', stage: 1, of: 3 }, 'solver-1');
    s.putSolveResult(fp, { status: 'final' }, 'solver-1');
    expect(s.getSolveResult(fp)).toMatchObject({ value: { status: 'final' }, solverVersion: 'solver-1' });
    const snap = s.addSnapshot({ sourceKind: 'save', saveHash: '1'.repeat(64) });
    const rev = s.head().revision;
    s.putVarianceReport(snap, rev, { deltas: [] });
    expect(s.getVarianceReport(snap, rev)?.value).toEqual({ deltas: [] });
    expect(s.counts().solve_results).toBe(1);
  });
});

describe('export', () => {
  it('writes a standalone copy that opens after the original and its WAL are gone', () => {
    const s = create();
    s.journal({ kind: 'set', doc: 'charter', path: ['kept'], value: 'folded' });
    s.fold();
    s.journal({ kind: 'set', doc: 'charter', path: ['pending'], value: true });
    const out = s.exportTo(path.join(dir, 'copy.ussp'));
    expect(codeOf(() => s.exportTo(out))).toBe('EXISTS');
    expect(codeOf(() => s.exportTo(s.file))).toBe('INVALID');
    const expected = s.working();
    s.close();
    for (const f of [s.file, `${s.file}-wal`, `${s.file}-shm`]) rmSync(f, { force: true });
    const copy = ProjectStore.open(out);
    open.push(copy);
    expect(copy.working()).toEqual(expected);
    expect(copy.verify()).toEqual({ ok: true, problems: [] });
    expect(readFileSync(out).subarray(0, 15).toString()).toBe('SQLite format 3');
  });
});

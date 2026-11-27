// ProjectStore: the `.ussp` project file (architecture.md, "Persistence").
//
// Durability model:
// - Every write is one `BEGIN IMMEDIATE` transaction in WAL mode with `synchronous = FULL`, so a
//   method that returned has committed durably and a process killed mid-method leaves no trace.
// - A journal op is validated against the working state before it is written, so replay on open
//   cannot fail on a well-formed file.
// - A fold writes the revision, moves the ref and marks the journal rows in one transaction.
// - Revision and snapshot ids are content hashes with no timestamp, so redoing a write after a
//   crash produces the same id, and a retried op id is a no-op.
// - create() and exportTo() write to a temporary file and rename it into place.
import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { canonicalJson, hashCanonical, isJsonObject, sha256Hex, type Json, type JsonObject } from './canonical';
import { applyEdit, parsePlanEdit, type PlanContent, type PlanEdit } from './edits';
import { ProjectError } from './errors';
import { APPLICATION_ID, MIGRATIONS, SCHEMA_V1, SCHEMA_VERSION } from './schema';

export type SourceKind = 'save' | 'preset' | 'manual' | 'telemetry';

/** Named points inside writes where tests can kill or fail the process. */
export type FaultPoint =
  | 'create:before-rename'
  | 'commit:before-commit'
  | 'journal:before-commit'
  | 'journal:after-commit'
  | 'fold:after-revision'
  | 'fold:after-ref'
  | 'fold:before-commit'
  | 'fold:after-commit'
  | 'export:before-rename';

export interface StoreOptions {
  readOnly?: boolean;
  /** Clock for `created_at` columns. Never part of any id. */
  now?: () => Date;
  /** Test hook, called at each FaultPoint. Throwing rolls the write back; killing the process tests crash replay. */
  faults?: (point: FaultPoint) => void;
  busyTimeoutMs?: number;
}

export interface RevisionInput {
  charter: JsonObject;
  network: JsonObject;
  worldBase?: string | null;
  message: string;
}

export interface Revision {
  id: string;
  parents: string[];
  worldBase: string | null;
  charterBlob: string;
  networkBlob: string;
  message: string;
  createdAt: string;
}

export interface SnapshotInput {
  parent?: string | null;
  sourceKind: SourceKind;
  saveHash?: string | null;
  docsHash?: string | null;
  catalogHash?: string | null;
  observations?: Json;
}

export interface Snapshot {
  id: string;
  parent: string | null;
  sourceKind: SourceKind;
  saveHash: string | null;
  docsHash: string | null;
  catalogHash: string | null;
  observationsBlob: string | null;
  createdAt: string;
}

export interface RefInfo {
  name: string;
  revision: string | null;
  symbolic: string | null;
}

export interface JournalEntry {
  seq: number;
  opId: string;
  ref: string;
  baseRevision: string;
  op: PlanEdit;
  createdAt: string;
  foldedInto: string | null;
}

export interface WorkingState extends PlanContent {
  ref: string;
  /** Revision the pending edits apply on top of (the ref's head). */
  base: string;
  pending: number;
  lastSeq: number | null;
}

export interface RecoveryReport {
  schemaVersion: number;
  migratedFrom: number | null;
  refs: { ref: string; base: string; pending: number }[];
  pendingTotal: number;
}

export interface VerifyReport {
  ok: boolean;
  problems: string[];
}

export interface StoredResult {
  value: Json;
  createdAt: string;
}

const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const HEAD = 'HEAD';
const MAIN = 'main';

type Row = Record<string, SQLInputValue>;

interface CacheEntry {
  base: string;
  lastSeq: number | null;
  content: PlanContent;
}

function str(v: unknown): string {
  return v as string;
}
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : (v as string);
}

function applyPragmas(db: DatabaseSync, readOnly: boolean): void {
  db.exec('PRAGMA foreign_keys = ON');
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
  }
}

function pragmaInt(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Row | undefined;
  return Number(row ? Object.values(row)[0] : 0);
}

function openDb(file: string, readOnly: boolean, timeout: number): DatabaseSync {
  return new DatabaseSync(file, { readOnly, timeout, enableForeignKeyConstraints: true, allowExtension: false });
}

export class ProjectStore {
  readonly file: string;
  readonly readOnly: boolean;
  recovery: RecoveryReport;
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly faults: (point: FaultPoint) => void;
  private readonly stmts = new Map<string, StatementSync>();
  private readonly cache = new Map<string, CacheEntry>();
  private inTx = false;
  private closed = false;

  private constructor(db: DatabaseSync, file: string, opts: StoreOptions, schemaVersion: number, migratedFrom: number | null) {
    this.db = db;
    this.file = file;
    this.readOnly = opts.readOnly ?? false;
    this.now = opts.now ?? (() => new Date());
    this.faults = opts.faults ?? (() => {});
    this.recovery = { schemaVersion, migratedFrom, refs: [], pendingTotal: 0 };
  }

  // ---------------------------------------------------------------- open / create / close

  /** Create a new project with an empty root revision on `main`. Fails if `file` exists. */
  static create(file: string, opts: StoreOptions = {}): ProjectStore {
    const target = path.resolve(file);
    if (existsSync(target)) throw new ProjectError('EXISTS', `${target} already exists`);
    const tmp = `${target}.creating-${randomUUID()}`;
    const now = (opts.now ?? (() => new Date()))().toISOString();
    try {
      // Built in rollback-journal mode so the finished file is self-contained before the rename;
      // open() switches it to WAL.
      const db = openDb(tmp, false, opts.busyTimeoutMs ?? 5000);
      try {
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('BEGIN IMMEDIATE');
        db.exec(SCHEMA_V1);
        db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
        meta.run('format', 'ussp');
        meta.run('created_at', now);
        db.exec('COMMIT');
      } finally {
        db.close();
      }
      const store = ProjectStore.open(tmp, { ...opts, readOnly: false });
      try {
        store.tx(() => {
          const root = store.commitInTx({ charter: {}, network: {}, worldBase: null, message: 'Create project' }, []);
          store.run('INSERT INTO refs (name, revision) VALUES (?, ?)', MAIN, root);
          store.run('INSERT INTO refs (name, symbolic) VALUES (?, ?)', HEAD, MAIN);
        });
        store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        store.db.exec('PRAGMA journal_mode = DELETE');
      } finally {
        store.close();
      }
      opts.faults?.('create:before-rename');
      if (existsSync(target)) throw new ProjectError('EXISTS', `${target} already exists`);
      renameSync(tmp, target);
    } catch (e) {
      for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) rmSync(f, { force: true });
      throw e;
    }
    return ProjectStore.open(target, opts);
  }

  /**
   * Open a project. SQLite rolls back any half-written transaction, then the pending journal of
   * every ref is replayed into its working state (see `recovery`). Opening never writes except to
   * set WAL mode or migrate.
   */
  static open(file: string, opts: StoreOptions = {}): ProjectStore {
    const target = path.resolve(file);
    if (!existsSync(target)) throw new ProjectError('NOT_FOUND', `${target} does not exist`);
    const readOnly = opts.readOnly ?? false;
    let db: DatabaseSync;
    try {
      db = openDb(target, readOnly, opts.busyTimeoutMs ?? 5000);
    } catch (e) {
      throw new ProjectError('NOT_A_PROJECT', `${target} could not be opened: ${(e as Error).message}`, { cause: e });
    }
    let store: ProjectStore;
    try {
      let appId: number;
      let version: number;
      try {
        appId = pragmaInt(db, 'application_id');
        version = pragmaInt(db, 'user_version');
      } catch (e) {
        throw new ProjectError('NOT_A_PROJECT', `${target} is not a project file: ${(e as Error).message}`, { cause: e });
      }
      if (appId !== APPLICATION_ID || version < 1) throw new ProjectError('NOT_A_PROJECT', `${target} is not a .ussp project file`);
      if (version > SCHEMA_VERSION) {
        throw new ProjectError('SCHEMA_TOO_NEW', `${target} uses schema ${version}; this build reads up to ${SCHEMA_VERSION}`);
      }
      applyPragmas(db, readOnly);
      const check = db.prepare('PRAGMA quick_check').all() as Row[];
      const msgs = check.map((r) => String(Object.values(r)[0]));
      if (msgs.length !== 1 || msgs[0] !== 'ok') throw new ProjectError('CORRUPT', `integrity check failed: ${msgs.join('; ')}`);
      let migratedFrom: number | null = null;
      if (version < SCHEMA_VERSION) {
        if (readOnly) throw new ProjectError('INVALID', `schema ${version} needs migrating; open read-write`);
        migratedFrom = version;
        db.exec('BEGIN IMMEDIATE');
        try {
          for (let v = version; v < SCHEMA_VERSION; v++) db.exec(MIGRATIONS[v]!);
          db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }
      store = new ProjectStore(db, target, opts, SCHEMA_VERSION, migratedFrom);
    } catch (e) {
      db.close();
      throw e;
    }
    try {
      store.replay();
    } catch (e) {
      store.close();
      throw e;
    }
    return store;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // ---------------------------------------------------------------- internals

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }
  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.stmt(sql).run(...params).changes);
  }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.stmt(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.stmt(sql).all(...params) as Row[];
  }
  private stamp(): string {
    return this.now().toISOString();
  }

  /** Run `fn` in one IMMEDIATE transaction. Nested calls join the outer transaction. */
  private tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // SQLite already rolled back (e.g. a failed COMMIT); nothing left to undo.
      }
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  // ---------------------------------------------------------------- blobs

  /** Store canonical JSON, compressed with zstd. Returns its sha256. Idempotent. */
  putBlob(value: Json): string {
    const text = canonicalJson(value);
    const bytes = Buffer.from(text, 'utf8');
    const hash = sha256Hex(bytes);
    this.tx(() => {
      if (this.get('SELECT 1 FROM blobs WHERE hash = ?', hash)) return;
      this.run('INSERT INTO blobs (hash, codec, size, data) VALUES (?, ?, ?, ?)', hash, 'zstd', bytes.length, zstdCompressSync(bytes));
    });
    return hash;
  }

  hasBlob(hash: string): boolean {
    return this.get('SELECT 1 FROM blobs WHERE hash = ?', hash) !== undefined;
  }

  /** Read a blob back. Throws `CORRUPT` if the bytes no longer match their hash. */
  getBlob(hash: string): Json {
    const row = this.get('SELECT codec, size, data FROM blobs WHERE hash = ?', hash);
    if (!row) throw new ProjectError('NOT_FOUND', `no blob ${hash}`);
    let bytes: Buffer;
    try {
      bytes = zstdDecompressSync(row.data as Uint8Array);
    } catch (e) {
      throw new ProjectError('CORRUPT', `blob ${hash} does not decompress`, { cause: e });
    }
    if (bytes.length !== Number(row.size) || sha256Hex(bytes) !== hash) throw new ProjectError('CORRUPT', `blob ${hash} does not match its hash`);
    return JSON.parse(bytes.toString('utf8')) as Json;
  }

  private getDocBlob(hash: string): JsonObject {
    const v = this.getBlob(hash);
    if (!isJsonObject(v)) throw new ProjectError('CORRUPT', `blob ${hash} is not a plan document`);
    return v;
  }

  // ---------------------------------------------------------------- world snapshots

  addSnapshot(input: SnapshotInput): string {
    return this.tx(() => {
      const parent = input.parent ?? null;
      if (parent !== null && !this.get('SELECT 1 FROM world_snapshots WHERE id = ?', parent)) {
        throw new ProjectError('NOT_FOUND', `no world snapshot ${parent}`);
      }
      const observations = input.observations === undefined ? null : this.putBlob(input.observations);
      const content = {
        type: 'ussp/world_snapshot@1',
        parent,
        sourceKind: input.sourceKind,
        saveHash: input.saveHash ?? null,
        docsHash: input.docsHash ?? null,
        catalogHash: input.catalogHash ?? null,
        observations,
      };
      const id = hashCanonical(content);
      this.run(
        `INSERT OR IGNORE INTO world_snapshots (id, parent, source_kind, save_hash, docs_hash, catalog_hash, observations_blob, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, parent, content.sourceKind, content.saveHash, content.docsHash, content.catalogHash, observations, this.stamp(),
      );
      return id;
    });
  }

  getSnapshot(id: string): Snapshot {
    const r = this.get('SELECT * FROM world_snapshots WHERE id = ?', id);
    if (!r) throw new ProjectError('NOT_FOUND', `no world snapshot ${id}`);
    return {
      id: str(r.id), parent: strOrNull(r.parent), sourceKind: str(r.source_kind) as SourceKind,
      saveHash: strOrNull(r.save_hash), docsHash: strOrNull(r.docs_hash), catalogHash: strOrNull(r.catalog_hash),
      observationsBlob: strOrNull(r.observations_blob), createdAt: str(r.created_at),
    };
  }

  listSnapshots(): Snapshot[] {
    return this.all('SELECT id FROM world_snapshots ORDER BY created_at, id').map((r) => this.getSnapshot(str(r.id)));
  }

  // ---------------------------------------------------------------- revisions

  /** Create a revision with the given parents (none, one, or two for a rebase). Does not move any ref. */
  commit(rev: RevisionInput, parents: readonly string[]): string {
    return this.tx(() => {
      const id = this.commitInTx(rev, parents);
      this.faults('commit:before-commit');
      return id;
    });
  }

  private commitInTx(rev: RevisionInput, parents: readonly string[]): string {
    if (!isJsonObject(rev.charter) || !isJsonObject(rev.network)) throw new ProjectError('INVALID', 'charter and network must be objects');
    if (typeof rev.message !== 'string') throw new ProjectError('INVALID', 'message must be a string');
    if (new Set(parents).size !== parents.length) throw new ProjectError('INVALID', 'duplicate parent');
    for (const p of parents) if (!this.hasRevision(p)) throw new ProjectError('NOT_FOUND', `no revision ${p}`);
    const worldBase = rev.worldBase ?? null;
    if (worldBase !== null && !this.get('SELECT 1 FROM world_snapshots WHERE id = ?', worldBase)) {
      throw new ProjectError('NOT_FOUND', `no world snapshot ${worldBase}`);
    }
    const charterBlob = this.putBlob(rev.charter);
    const networkBlob = this.putBlob(rev.network);
    const id = revisionId([...parents], worldBase, charterBlob, networkBlob, rev.message);
    const inserted = this.run(
      `INSERT OR IGNORE INTO plan_revisions (id, world_base, charter_blob, network_blob, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id, worldBase, charterBlob, networkBlob, rev.message, this.stamp(),
    );
    if (inserted) parents.forEach((p, i) => this.run('INSERT INTO revision_parents (revision, ord, parent) VALUES (?, ?, ?)', id, i, p));
    return id;
  }

  hasRevision(id: string): boolean {
    return this.get('SELECT 1 FROM plan_revisions WHERE id = ?', id) !== undefined;
  }

  getRevision(id: string): Revision {
    const r = this.get('SELECT * FROM plan_revisions WHERE id = ?', id);
    if (!r) throw new ProjectError('NOT_FOUND', `no revision ${id}`);
    const parents = this.all('SELECT parent FROM revision_parents WHERE revision = ? ORDER BY ord', id).map((p) => str(p.parent));
    return {
      id, parents, worldBase: strOrNull(r.world_base), charterBlob: str(r.charter_blob),
      networkBlob: str(r.network_blob), message: str(r.message), createdAt: str(r.created_at),
    };
  }

  /** A revision with its documents loaded. */
  readRevision(id: string): Revision & PlanContent {
    const rev = this.getRevision(id);
    return { ...rev, charter: this.getDocBlob(rev.charterBlob), network: this.getDocBlob(rev.networkBlob) };
  }

  /** First-parent history from a ref or revision, newest first. */
  log(from: string = HEAD, limit = 50): Revision[] {
    let id: string | null = this.hasRevision(from) ? from : this.resolve(from);
    const out: Revision[] = [];
    while (id && out.length < limit) {
      const rev = this.getRevision(id);
      out.push(rev);
      id = rev.parents[0] ?? null;
    }
    return out;
  }

  // ---------------------------------------------------------------- refs

  listRefs(): RefInfo[] {
    return this.all('SELECT name, revision, symbolic FROM refs ORDER BY name').map((r) => ({
      name: str(r.name), revision: strOrNull(r.revision), symbolic: strOrNull(r.symbolic),
    }));
  }

  /** Resolve a ref name (HEAD follows its symbolic target) to the concrete ref name. */
  resolveRefName(name: string = HEAD): string {
    let current = name;
    for (let depth = 0; depth < 8; depth++) {
      const r = this.get('SELECT revision, symbolic FROM refs WHERE name = ?', current);
      if (!r) throw new ProjectError('NOT_FOUND', `no ref ${current}`);
      if (r.symbolic === null) return current;
      current = str(r.symbolic);
    }
    throw new ProjectError('CORRUPT', `symbolic ref loop at ${name}`);
  }

  /** The revision a ref points at. */
  resolve(name: string = HEAD): string {
    const r = this.get('SELECT revision FROM refs WHERE name = ?', this.resolveRefName(name));
    return str(r!.revision);
  }

  /** `ProjectStore.ref(name)` from the architecture: the ref's revision, or null if it does not exist. */
  ref(name: string): string | null {
    try {
      return this.resolve(name);
    } catch (e) {
      if (e instanceof ProjectError && e.code === 'NOT_FOUND') return null;
      throw e;
    }
  }

  head(): { ref: string; revision: string } {
    const ref = this.resolveRefName(HEAD);
    return { ref, revision: this.resolve(ref) };
  }

  /** Create a fork (or any new ref) at a revision. */
  createRef(name: string, revision: string): void {
    validateRefName(name);
    this.tx(() => {
      if (this.get('SELECT 1 FROM refs WHERE name = ?', name)) throw new ProjectError('REF_CONFLICT', `ref ${name} already exists`);
      if (!this.hasRevision(revision)) throw new ProjectError('NOT_FOUND', `no revision ${revision}`);
      this.run('INSERT INTO refs (name, revision) VALUES (?, ?)', name, revision);
    });
  }

  /**
   * Move a ref. `expect` makes it a compare-and-swap. A ref with pending journal entries refuses to
   * move unless `discardPending` is set, because those edits were made against the old head.
   */
  setRef(name: string, revision: string, opts: { expect?: string; discardPending?: boolean } = {}): void {
    validateRefName(name);
    this.tx(() => {
      const cur = this.get('SELECT revision FROM refs WHERE name = ?', name);
      if (!cur) throw new ProjectError('NOT_FOUND', `no ref ${name}`);
      if (opts.expect !== undefined && cur.revision !== opts.expect) {
        throw new ProjectError('REF_CONFLICT', `ref ${name} is at ${String(cur.revision)}, expected ${opts.expect}`);
      }
      if (!this.hasRevision(revision)) throw new ProjectError('NOT_FOUND', `no revision ${revision}`);
      this.dropPending(name, opts.discardPending ?? false);
      this.run('UPDATE refs SET revision = ? WHERE name = ?', revision, name);
    });
    this.cache.delete(name);
  }

  deleteRef(name: string, opts: { discardPending?: boolean } = {}): void {
    validateRefName(name);
    this.tx(() => {
      if (!this.get('SELECT 1 FROM refs WHERE name = ? AND revision IS NOT NULL', name)) throw new ProjectError('NOT_FOUND', `no ref ${name}`);
      if (this.resolveRefName(HEAD) === name) throw new ProjectError('REF_CONFLICT', `cannot delete ${name}: HEAD points at it`);
      this.dropPending(name, opts.discardPending ?? false);
      this.run('DELETE FROM refs WHERE name = ?', name);
    });
    this.cache.delete(name);
  }

  /** Point HEAD at another ref. */
  checkout(name: string): void {
    validateRefName(name);
    this.tx(() => {
      if (!this.get('SELECT 1 FROM refs WHERE name = ? AND revision IS NOT NULL', name)) throw new ProjectError('NOT_FOUND', `no ref ${name}`);
      this.run('UPDATE refs SET symbolic = ? WHERE name = ?', name, HEAD);
    });
  }

  private dropPending(ref: string, discard: boolean): void {
    const n = Number(this.get('SELECT count(*) AS n FROM journal WHERE ref = ? AND folded_into IS NULL', ref)!.n);
    if (n === 0) return;
    if (!discard) throw new ProjectError('PENDING_EDITS', `ref ${ref} has ${n} pending edit(s); fold them first`);
    this.run('DELETE FROM journal WHERE ref = ? AND folded_into IS NULL', ref);
  }

  // ---------------------------------------------------------------- journal

  /**
   * Append a pending edit to a ref (default HEAD's ref). The edit is checked against the working
   * state first. Re-sending the same `opId` with the same edit returns the existing entry
   * (`duplicate: true`) without applying it twice, whether or not it has been folded since.
   */
  journal(op: PlanEdit | unknown, opts: { ref?: string; opId?: string } = {}): { entry: JournalEntry; duplicate: boolean } {
    const edit = parsePlanEdit(op);
    const opText = canonicalJson(edit);
    const opId = opts.opId ?? randomUUID();
    if (typeof opId !== 'string' || opId.length === 0 || opId.length > 200) throw new ProjectError('INVALID', 'opId must be a non-empty string');
    const { result, next } = this.tx((): { result: { entry: JournalEntry; duplicate: boolean }; next: CacheEntry | null } => {
      const ref = this.resolveRefName(opts.ref ?? HEAD);
      const existing = this.get('SELECT * FROM journal WHERE op_id = ?', opId);
      if (existing) {
        if (existing.op !== opText || existing.ref !== ref) {
          throw new ProjectError('OP_ID_CONFLICT', `op id ${opId} was already used for a different edit`);
        }
        return { result: { entry: toEntry(existing), duplicate: true }, next: null };
      }
      if (edit.kind === 'setWorldBase' && edit.snapshot !== null && !this.get('SELECT 1 FROM world_snapshots WHERE id = ?', edit.snapshot)) {
        throw new ProjectError('BAD_EDIT', `no world snapshot ${edit.snapshot}`);
      }
      const ws = this.workingInTx(ref);
      const content = applyEdit(ws.content, edit);
      const createdAt = this.stamp();
      const info = this.stmt('INSERT INTO journal (op_id, ref, base_revision, op, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(opId, ref, ws.base, opText, createdAt);
      const seq = Number(info.lastInsertRowid);
      this.faults('journal:before-commit');
      return {
        result: { entry: { seq, opId, ref, baseRevision: ws.base, op: edit, createdAt, foldedInto: null }, duplicate: false },
        next: { base: ws.base, lastSeq: seq, content },
      };
    });
    if (next) this.cache.set(result.entry.ref, next);
    this.faults('journal:after-commit');
    return result;
  }

  /** Pending (unfolded) entries of a ref, oldest first. */
  pending(ref: string = HEAD): JournalEntry[] {
    const name = this.resolveRefName(ref);
    return this.all('SELECT * FROM journal WHERE ref = ? AND folded_into IS NULL ORDER BY seq', name).map(toEntry);
  }

  /** Every journal row (pending and folded), oldest first. */
  journalEntries(): JournalEntry[] {
    return this.all('SELECT * FROM journal ORDER BY seq').map(toEntry);
  }

  /** The ref's head revision with its pending edits applied. */
  working(ref: string = HEAD): WorkingState {
    const name = this.resolveRefName(ref);
    const ws = this.workingInTx(name);
    return { ref: name, base: ws.base, pending: ws.pending, lastSeq: ws.lastSeq, ...structuredClone(ws.content) };
  }

  private workingInTx(ref: string): { base: string; lastSeq: number | null; pending: number; content: PlanContent } {
    const base = this.resolve(ref);
    const stats = this.get('SELECT max(seq) AS last, count(*) AS n FROM journal WHERE ref = ? AND folded_into IS NULL', ref)!;
    const lastSeq = stats.last === null ? null : Number(stats.last);
    const pending = Number(stats.n);
    const hit = this.cache.get(ref);
    if (hit && hit.base === base && hit.lastSeq === lastSeq) return { base, lastSeq, pending, content: hit.content };
    const rev = this.readRevision(base);
    let content: PlanContent = { worldBase: rev.worldBase, charter: rev.charter, network: rev.network };
    for (const row of this.all('SELECT * FROM journal WHERE ref = ? AND folded_into IS NULL ORDER BY seq', ref)) {
      const entry = toEntry(row);
      if (entry.baseRevision !== base) {
        throw new ProjectError('CORRUPT', `journal entry ${entry.seq} on ${ref} was made against ${entry.baseRevision}, but ${ref} is at ${base}`);
      }
      try {
        content = applyEdit(content, entry.op);
      } catch (e) {
        throw new ProjectError('CORRUPT', `journal entry ${entry.seq} on ${ref} no longer applies: ${(e as Error).message}`, { cause: e });
      }
    }
    this.cache.set(ref, { base, lastSeq, content });
    return { base, lastSeq, pending, content };
  }

  /**
   * Fold a ref's pending edits into one revision whose parent is the current head, and move the
   * ref to it. Returns null (and changes nothing) when there is nothing pending.
   */
  fold(ref: string = HEAD, opts: { message?: string } = {}): string | null {
    const folded = this.tx((): { ref: string; id: string; content: PlanContent } | null => {
      const name = this.resolveRefName(ref);
      const ws = this.workingInTx(name);
      if (ws.pending === 0) return null;
      const message = opts.message ?? `Fold ${ws.pending} edit${ws.pending === 1 ? '' : 's'}`;
      const id = this.commitInTx({ ...ws.content, message }, [ws.base]);
      this.faults('fold:after-revision');
      if (this.run('UPDATE refs SET revision = ? WHERE name = ? AND revision = ?', id, name, ws.base) !== 1) {
        throw new ProjectError('REF_CONFLICT', `ref ${name} moved during fold`);
      }
      this.faults('fold:after-ref');
      this.run('UPDATE journal SET folded_into = ? WHERE ref = ? AND folded_into IS NULL AND seq <= ?', id, name, ws.lastSeq);
      this.faults('fold:before-commit');
      return { ref: name, id, content: ws.content };
    });
    if (!folded) return null;
    this.cache.set(folded.ref, { base: folded.id, lastSeq: null, content: folded.content });
    this.faults('fold:after-commit');
    return folded.id;
  }

  /** Fold every ref with pending edits ("save"). Returns the new revision per ref. */
  foldAll(opts: { message?: string } = {}): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.listRefs()) {
      if (r.revision === null) continue;
      const id = this.fold(r.name, opts);
      if (id) out[r.name] = id;
    }
    return out;
  }

  /** Rebuild every ref's working state from the file. Pure: running it twice gives the same report. */
  replay(): RecoveryReport {
    this.cache.clear();
    const refs: RecoveryReport['refs'] = [];
    for (const r of this.listRefs()) {
      if (r.revision === null) continue;
      const ws = this.workingInTx(r.name);
      refs.push({ ref: r.name, base: ws.base, pending: ws.pending });
    }
    this.recovery = { ...this.recovery, refs, pendingTotal: refs.reduce((n, r) => n + r.pending, 0) };
    return this.recovery;
  }

  /** Delete folded journal rows. Their op ids stop being recognised as duplicates. */
  pruneJournal(): number {
    return this.tx(() => this.run('DELETE FROM journal WHERE folded_into IS NOT NULL'));
  }

  // ---------------------------------------------------------------- caches

  /** Store a solve result under the fingerprint taken at dispatch. Replaces an earlier result for the same fingerprint. */
  putSolveResult(fingerprint: string, result: Json, solverVersion: string): void {
    this.tx(() => {
      const blob = this.putBlob(result);
      this.run(
        `INSERT INTO solve_results (spec_fingerprint, result_blob, solver_version, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (spec_fingerprint) DO UPDATE SET result_blob = excluded.result_blob, solver_version = excluded.solver_version, created_at = excluded.created_at`,
        fingerprint, blob, solverVersion, this.stamp(),
      );
    });
  }

  getSolveResult(fingerprint: string): (StoredResult & { solverVersion: string }) | null {
    const r = this.get('SELECT * FROM solve_results WHERE spec_fingerprint = ?', fingerprint);
    if (!r) return null;
    return { value: this.getBlob(str(r.result_blob)), solverVersion: str(r.solver_version), createdAt: str(r.created_at) };
  }

  putVarianceReport(snapshot: string, revision: string, report: Json): void {
    this.tx(() => {
      const blob = this.putBlob(report);
      this.run(
        `INSERT INTO variance_reports (snapshot, revision, report_blob, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (snapshot, revision) DO UPDATE SET report_blob = excluded.report_blob, created_at = excluded.created_at`,
        snapshot, revision, blob, this.stamp(),
      );
    });
  }

  getVarianceReport(snapshot: string, revision: string): StoredResult | null {
    const r = this.get('SELECT * FROM variance_reports WHERE snapshot = ? AND revision = ?', snapshot, revision);
    if (!r) return null;
    return { value: this.getBlob(str(r.report_blob)), createdAt: str(r.created_at) };
  }

  // ---------------------------------------------------------------- maintenance

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of ['blobs', 'world_snapshots', 'plan_revisions', 'refs', 'journal', 'solve_results', 'variance_reports']) {
      out[t] = Number(this.get(`SELECT count(*) AS n FROM ${t}`)!.n);
    }
    out.journal_pending = Number(this.get('SELECT count(*) AS n FROM journal WHERE folded_into IS NULL')!.n);
    return out;
  }

  /**
   * Full consistency check: SQLite integrity and foreign keys, every blob against its hash, every
   * revision and snapshot id against its content, refs, and a replay of every pending journal.
   */
  verify(): VerifyReport {
    const problems: string[] = [];
    const sqlite = this.db.prepare('PRAGMA integrity_check').all().map((r) => String(Object.values(r as Row)[0]));
    if (sqlite.length !== 1 || sqlite[0] !== 'ok') problems.push(...sqlite.map((m) => `sqlite: ${m}`));
    for (const r of this.db.prepare('PRAGMA foreign_key_check').all() as Row[]) {
      problems.push(`foreign key: ${String(r.table)} row ${String(r.rowid)} -> ${String(r.parent)}`);
    }
    for (const r of this.all('SELECT hash FROM blobs')) {
      try {
        this.getBlob(str(r.hash));
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    for (const r of this.all('SELECT id FROM plan_revisions')) {
      const rev = this.getRevision(str(r.id));
      if (revisionId(rev.parents, rev.worldBase, rev.charterBlob, rev.networkBlob, rev.message) !== rev.id) {
        problems.push(`revision ${rev.id} does not match its content`);
      }
    }
    for (const s of this.listSnapshots()) {
      const id = hashCanonical({
        type: 'ussp/world_snapshot@1', parent: s.parent, sourceKind: s.sourceKind, saveHash: s.saveHash,
        docsHash: s.docsHash, catalogHash: s.catalogHash, observations: s.observationsBlob,
      });
      if (id !== s.id) problems.push(`world snapshot ${s.id} does not match its content`);
    }
    const refs = this.listRefs();
    const head = refs.find((r) => r.name === HEAD);
    if (!head || head.symbolic === null) problems.push('HEAD is missing or not symbolic');
    else if (!refs.some((r) => r.name === head.symbolic && r.revision !== null)) problems.push(`HEAD points at missing ref ${head.symbolic}`);
    for (const r of this.all('SELECT DISTINCT ref FROM journal WHERE folded_into IS NULL')) {
      if (!refs.some((x) => x.name === r.ref && x.revision !== null)) problems.push(`pending journal entries for missing ref ${String(r.ref)}`);
    }
    this.cache.clear();
    for (const r of refs) {
      if (r.revision === null) continue;
      try {
        this.workingInTx(r.name);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    return { ok: problems.length === 0, problems };
  }

  /**
   * Write a standalone copy with `VACUUM INTO` (pending journal entries included). The copy is
   * written next to the target and renamed into place, so the target is never half-written.
   */
  exportTo(target: string, opts: { overwrite?: boolean } = {}): string {
    const out = path.resolve(target);
    if (out === this.file) throw new ProjectError('INVALID', 'cannot export a project onto itself');
    if (existsSync(out) && !opts.overwrite) throw new ProjectError('EXISTS', `${out} already exists`);
    const tmp = `${out}.exporting-${randomUUID()}`;
    try {
      this.stmt('VACUUM INTO ?').run(tmp);
      this.faults('export:before-rename');
      renameSync(tmp, out);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return out;
  }
}

function validateRefName(name: string): void {
  if (name === HEAD || !REF_NAME.test(name) || name.includes('..')) throw new ProjectError('REF_CONFLICT', `invalid ref name ${JSON.stringify(name)}`);
}

/** Content id of a revision. Parent order matters (first parent is the line it continues). */
export function revisionId(parents: string[], worldBase: string | null, charterBlob: string, networkBlob: string, message: string): string {
  return hashCanonical({ type: 'ussp/plan_revision@1', parents, worldBase, charter: charterBlob, network: networkBlob, message });
}

function toEntry(r: Row): JournalEntry {
  return {
    seq: Number(r.seq), opId: str(r.op_id), ref: str(r.ref), baseRevision: str(r.base_revision),
    op: parsePlanEdit(JSON.parse(str(r.op))), createdAt: str(r.created_at), foldedInto: strOrNull(r.folded_into),
  };
}

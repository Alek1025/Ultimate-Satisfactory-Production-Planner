// `.ussp` schema. One SQLite file in WAL mode; Main is the only writer.
//
// Bump SCHEMA_VERSION and add a step to MIGRATIONS for every change. A file whose user_version is
// newer than SCHEMA_VERSION is refused (never downgraded).

/** PRAGMA application_id: the ASCII bytes "USSP". */
export const APPLICATION_ID = 0x55535350;
export const SCHEMA_VERSION = 1;

export const SCHEMA_V1 = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Content-addressed canonical JSON. hash = sha256(canonical JSON bytes), taken before compression.
CREATE TABLE blobs (
  hash  TEXT PRIMARY KEY CHECK (length(hash) = 64),
  codec TEXT NOT NULL CHECK (codec IN ('zstd')),
  size  INTEGER NOT NULL CHECK (size >= 0),
  data  BLOB NOT NULL
) STRICT;

CREATE TABLE world_snapshots (
  id                TEXT PRIMARY KEY,
  parent            TEXT REFERENCES world_snapshots(id),
  source_kind       TEXT NOT NULL CHECK (source_kind IN ('save', 'preset', 'manual', 'telemetry')),
  save_hash         TEXT,
  docs_hash         TEXT,
  catalog_hash      TEXT,
  observations_blob TEXT REFERENCES blobs(hash),
  created_at        TEXT NOT NULL
) STRICT;

-- id = sha256 of the canonical revision content (parents, world_base, blobs, message); created_at
-- is outside the hash so re-folding identical content after a crash yields the same id.
CREATE TABLE plan_revisions (
  id           TEXT PRIMARY KEY,
  world_base   TEXT REFERENCES world_snapshots(id),
  charter_blob TEXT NOT NULL REFERENCES blobs(hash),
  network_blob TEXT NOT NULL REFERENCES blobs(hash),
  message      TEXT NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;

-- parents[] of a revision, in order: none for the root, one for a commit, two for a rebase/merge.
CREATE TABLE revision_parents (
  revision TEXT NOT NULL REFERENCES plan_revisions(id),
  ord      INTEGER NOT NULL CHECK (ord >= 0),
  parent   TEXT NOT NULL REFERENCES plan_revisions(id),
  PRIMARY KEY (revision, ord),
  UNIQUE (revision, parent)
) STRICT;
CREATE INDEX revision_parents_parent ON revision_parents(parent);

-- main, forks, and HEAD. HEAD is symbolic (names another ref); every other ref names a revision.
CREATE TABLE refs (
  name     TEXT PRIMARY KEY,
  revision TEXT REFERENCES plan_revisions(id),
  symbolic TEXT REFERENCES refs(name),
  CHECK ((revision IS NULL) <> (symbolic IS NULL))
) STRICT;

-- Pending edits against a ref's head. Folding marks rows with the revision they became, in the
-- same transaction that moves the ref, so a crash leaves them either all pending or all folded.
-- Folded rows are kept so a retried op_id stays a no-op (pruneJournal() drops them).
CREATE TABLE journal (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id         TEXT NOT NULL UNIQUE,
  ref           TEXT NOT NULL,
  base_revision TEXT NOT NULL REFERENCES plan_revisions(id),
  op            TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  folded_into   TEXT REFERENCES plan_revisions(id)
) STRICT;
CREATE INDEX journal_pending ON journal(ref, seq) WHERE folded_into IS NULL;

CREATE TABLE solve_results (
  spec_fingerprint TEXT PRIMARY KEY,
  result_blob      TEXT NOT NULL REFERENCES blobs(hash),
  solver_version   TEXT NOT NULL,
  created_at       TEXT NOT NULL
) STRICT;

CREATE TABLE variance_reports (
  snapshot    TEXT NOT NULL REFERENCES world_snapshots(id),
  revision    TEXT NOT NULL REFERENCES plan_revisions(id),
  report_blob TEXT NOT NULL REFERENCES blobs(hash),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (snapshot, revision)
) STRICT;
`;

/** MIGRATIONS[n] upgrades a file from user_version n to n + 1. */
export const MIGRATIONS: readonly string[] = [SCHEMA_V1];

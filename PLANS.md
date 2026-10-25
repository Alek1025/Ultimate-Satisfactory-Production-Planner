# Satisfactory Planner — plans and storage

Plans are versioned JSON documents stored through the platform's `KeyValueStore`
(IndexedDB in the browser, the filesystem in the desktop app) and exported/imported as JSON
on both. Nothing in `src/plans/` knows which platform it runs on.

```
src/plans/
  types.ts        Plan, SaveRef, StoredResult, PlanBundle (export file), Freshness
  versioning.ts   freshness checks, request hash, content-addressed summary keys, rebase
  schema.ts       validation + migration of untrusted plan / summary / bundle JSON
  store.ts        PlanStore: create, list, get, save, duplicate, rename, delete, results, export/import
  files.ts        export/import through FileAccess (download / picker, save dialog / filesystem)
src/platform/
  memory.ts                  in-memory KeyValueStore (tests; browser fallback)
  browser/indexeddb-store.ts IndexedDB KeyValueStore, requests persistent storage
  browser/file-access.ts     file picker, File System Access save dialog or download
  browser/index.ts           createBrowserPlatform()
```

## A plan

```ts
{
  schemaVersion: 1, id, name, notes, createdAt, updatedAt,
  save: { summaryKey, saveIdentifier, saveName, sessionName, buildVersion, saveVersion, savedAt },
  request: PlanRequest,          // targets, maximize, manual inputs, exclusions, caps, order, budgets
  solveOptions: Partial<SolveOptions>,
  lastResult?: { result: PlanResult, requestHash, summaryKey },
}
```

The save summary itself is stored once under `summary:<key>`, where the key is a hash of
its content, so plans made from the same save state share it, and loading a newer save of
the same session creates a new key. Storage keys: `plan:<id>` (no result, so lists are
cheap), `result:<id>`, `summary:<key>`, `meta:active`, `meta:schema`. Deleting the last
plan that uses a summary deletes the summary.

## Versioning

`checkFreshness(plan, { gameDataHash })` compares the stored result with what is loaded now:

| Reason | Detected by | Message to the user |
|---|---|---|
| `request-changed` | hash of request + solve options at solve time | the request changed since solving |
| `game-data-changed` | `result.provenance.gameDataHash` vs loaded `GameData.contentHash` | solved against different game data (e.g. after a game update) |
| `save-changed` | result's summary key vs the plan's, or save build number | solved against an earlier state of the save |
| `solver-changed` | `result.provenance.solver` | solved by an older planner version |

`rebasePlan(plan, summary)` points a plan at a newer summary of its save (the old result
stays, flagged stale) and warns if the summary looks like a different save or game build.
`unknownItems(plan, gameData)` lists requested items the loaded game data no longer has.

## Export / import

An export file (`*.satplan.json`) is a bundle: `{ format: 'satisfactory-planner.plans',
formatVersion: 1, exportedAt, app, plans, summaries }`. By default it includes the save
summaries and results, so a plan opens and re-solves on another machine without the .sav.
A bare plan JSON is accepted too.

Import treats the file as untrusted:

- Every plan field is checked and rebuilt (ClassName patterns, finite non-negative rates,
  length limits, known objective names); a plan that fails is skipped with the reason.
- Save summaries are checked for every field the solver reads, and **re-keyed by their own
  content**: an edited summary can't pose as the original, and plans using it come back stale.
- A malformed result is dropped (the plan is kept and must be solved again).
- Newer schema or bundle versions are refused with "made by a newer version of the planner".
- UTF-16 / BOM files are decoded like Docs.json.

Merging with plans already present: same plan unchanged → skipped; the file has a newer
version → replaces it; the local copy was edited after the export → the file's version is
added as "<name> (imported)"; a different plan with the same id → imported under a new id.

Stored plans are re-validated on load too (`loadPlan` returns the reasons if one can't be
read), so data written by another planner version can't reach the solver unchecked.

## Browser specifics

`createBrowserPlatform()` opens IndexedDB and `PlanStore.init()` requests persistent
storage; if the browser refuses, the UI should tell the user to export plans they want to
keep. If IndexedDB is unavailable (some private modes) it falls back to memory with a
warning. Export uses the save dialog where the browser has one, otherwise a download.

## Not done yet

The desktop (Tauri) backend: a filesystem `KeyValueStore` (one JSON file per key in the app
data folder) and `FileAccess` with native dialogs plus save-folder / game-install detection.
It comes with the Tauri wrapper; the interfaces don't change.

## Tests

`test/plans.test.ts` (15) uses a real plan solved on Obsidian Gears: freshness for each stale
reason, shared summaries and cleanup, duplicate/rename, full export → import round trip
(fresh afterwards), merge rules, tampered summary re-keying, bare plans, version refusals,
field-level validation of hostile input, UTF-16 files, the FileAccess flow, and the IndexedDB
store (via fake-indexeddb) including the plan store end to end.

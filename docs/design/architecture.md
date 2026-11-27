# Architecture, stack and UI

Decided 2026-11-27 after three rounds of a design council on frameworks, architecture and UI
(notes in [`council/notes/`](council/notes/), `a1`–`a3`), plus the owner's decisions at the end of
this file. Read [direction.md](direction.md) first for what the app is.

Nothing here is built yet. When a decision changes, update this file in the same change.

## Stack

| Layer | Choice | Revisit when |
|---|---|---|
| Desktop shell | Electron: a sandboxed renderer, a typed preload API and Zod-validated IPC | Installer size, startup time or idle memory goes over budget |
| UI and state | React 19, TypeScript, Zustand. Map camera and cursor state live outside React | Multi-pane state causes render churn |
| Map | Tiled Canvas 2D with HTML overlays and inspectors; SVG for dials and sparklines | Pan/zoom drops below 60 fps on a full world |
| World model | Engine `utilityProcess` | Parsing or composing misses the snapshot-ready budget |
| Solver | HiGHS **WASM** in its own `utilityProcess`, behind `SolverPort` | Benchmarks of whole-building cases miss the interactive budget; then try native HiGHS behind the same port |
| Persistence | One SQLite project file (`.ussp`, WAL). Main is the only writer | Crash replay or diff queries get too slow |
| Game data | User-supplied Docs file, a hash-pinned CatalogPack, save inference, plain coordinate grid | Too much manual entry is needed; then consider IoStore/Oodle extraction from the install |
| Tests | Vitest on the pure engine with golden fixtures and property tests; a few Playwright `_electron` end-to-end flows | — |

## Processes

```
+-------------------------------------------------------------------+
| RENDERER  React 19 + Zustand + tiled Canvas 2D; reads view-models |
+---------------------------------^---------------------------------+
                                  | contextBridge + Zod-typed IPC
+---------------------------------v---------------------------------+
| MAIN  sole SQLite writer (.ussp: blobs, snapshots, revision DAG,  |
|       refs, journal, caches) | windows, dialogs | SaveGamesWatcher|
|       [Path 2] TelemetryPoller, MarkerSink                        |
+---------------------------------^---------------------------------+
                                  | typed IPC
+---------------------------------v---------------------------------+
| ENGINE (utilityProcess)                                           |
|  Source.read -> CatalogProvider.resolve -> WorldComposer.compose  |
|  Compiler.compile -> ProblemSpec + fingerprint (taken at dispatch)|
|  Checker.check  (caps, circuits; no LP)                           |
|  VarianceEngine.diff -> {plan, save, delta, evidence[]}           |
|  [Path 2] TelemetryOverlay (ephemeral; never feeds the Compiler)  |
+---------------------------------^---------------------------------+
                                  | MessagePortMain: ProblemSpec in,
                                  | Stage | Final | EngineError out
+---------------------------------v---------------------------------+
| SOLVER (utilityProcess + warm spare)                              |
|  reachability pre-pass, lexicographic HiGHS stages,               |
|  elastic shortfall diagnosis, duals -> sensitivity                |
+-------------------------------------------------------------------+
```

- The solver has **its own process**, so cancelling or crashing a solve never throws away the parsed
  save and World State in the Engine.
- **Cancel or timeout:** kill the solver process and switch to the warm spare. A 500 ms heartbeat
  with 3 missed beats counts as a hang, and memory is capped. A solver crash is reported as an
  engine error, **never** as "Infeasible".
- Lexicographic stages stream their results, so a timeout returns "Partial · stage k of n".

### Key interfaces

| Interface | Shape |
|---|---|
| `Source` | `read() → Observations {kind, provenance, hashes}`. Kinds are save, preset, manual and (later) telemetry |
| `CatalogProvider` | `resolve(docsHash, packHash) → Catalog` |
| `WorldComposer` | `compose(layers[]) → WorldState`, with an evidence tier on every field |
| `ProjectStore` | `commit(rev, parents[])`, `ref(name)`, `journal(op)` |
| `Compiler` | `compile(charter, network, world) → {spec, fingerprint}` |
| `SolverPort` | `solve(spec, signal) → AsyncIterable<Stage \| Final \| EngineError>` |
| `Checker` | `check(network, world) → Finding[]` |
| `VarianceEngine` | `diff(revision, snapshot) → Variance[]` |
| `TelemetryOverlay` | `view(session, baseSnapshot) → FieldCoverage[]` (Path 2) |
| `Sink` | `emit(markers)`: write-only and opt-in (Path 2) |

## World State

- **Layers, lowest to highest precedence:** `Catalog < Inferred < Observed < Manual`.
- **Manual entries pin the snapshot they were made against.** If a newer save contradicts one, the
  rebase review shows a "Manual vs Observed" conflict instead of silently overriding either value.
- **Evidence tiers are separate from layers:** `OBS` (observed), `DER` (derived), `INF` (inferred),
  `N/A` (unavailable). Every number in the UI carries one.
- **Unknown classes are kept, never dropped.** Anything that depends on them shows as `N/A`.
- **Forks** are what-if branches. **Rebasing** onto a newer save goes through a reviewable diff.

## Persistence (`.ussp`)

| Table | Holds |
|---|---|
| `blobs` | Content-addressed canonical JSON, compressed with zstd |
| `world_snapshots` | Parent snapshot, `source_kind`, and save, Docs and catalog hashes |
| `plan_revisions` | `parents[]` (forks; a rebase has two parents), `world_base`, `charter_blob`, `network_blob`, message |
| `refs` | `main`, forks and `HEAD` |
| `journal` | Pending edits. Folded into a revision on save or after 30 s idle, and replayed on startup |
| `solve_results` | Keyed by `spec_fingerprint` |
| `variance_reports` | Keyed by snapshot and revision |

- **Exporting** a project uses `VACUUM INTO`, which writes a standalone copy of the file.
- **The fingerprint covers every input:** the Docs model, catalog, world snapshot, plan revision,
  options, engine constants and solver version. It is taken when the solve is sent, and results are
  never re-keyed on import. Together these fix the v1 stale-result bugs (rewrite notes §8).

## Game data and licensing

- **Zero bundled game-derived assets.** The MVP uses:
  - the player's Docs file;
  - a hash-pinned **CatalogPack** with default node resources, purities and well links, supplied by
    the player;
  - inference from the save, e.g. an existing extractor gives a node's resource;
  - a plain coordinate grid as the map.
- Reading the catalog straight from the install (IoStore + Oodle) comes after M3.

## Path 2 hook (after M3)

- Live telemetry is one more `Source` of kind telemetry. It only feeds `TelemetryOverlay`, which
  tracks:
  - per-field coverage
  - a 10-minute rolling median with a minimum sample count
  - expiry, after which values become unknown
- It **never** enters solver inputs or the save-based variance.
- Its only path into the plan is the player choosing **"Capture as snapshot"**, which writes a
  `world_snapshot` with `source_kind = telemetry`.
- Exporting map markers is a `Sink`.

## UI: "Surveyor Blueprint"

The central metaphor is **as-designed vs as-built**. The plan is the drawing, and each save is a
site survey. Differences come back as **redlines**, which are facts the player resolves with
**Amend plan** (creates a draft revision) or **Keep plan** (records a disposition).

- **Themes:** dark ("blueprint slate") and light ("topographic vellum") with a toggle. All colours
  are semantic tokens (`--bg`, `--panel`, `--panel-2`, `--line`, `--ink`, `--muted`, `--accent`,
  `--ok`, `--warn`, `--bad`, `--plan`). The values are in the final mockups.
- **Type:** UI font system-ui / Segoe UI; numbers and hashes in a monospace font. Sizes are
  12 (uppercase micro labels), 14 (body), 18 (section titles), 26 (screen titles) and 30 (key
  numbers). Radius 8 px.
- **Shell:**
  - **Status bar (48 px):** project and fork@revision, world snapshot chip, Docs/catalog hash, live
    status, theme toggle, **Check plan**, and the primary **Draft allocation** button.
  - **Left rail (180 px, collapsible to 64 px):** the project block, then navigation, then a footer
    with snapshot, journal and solver status.
  - **Right inspector:** 420 px wide.
- **Chips:** evidence chips are `OBS`, `DER`, `INF` and `N/A`; layer chips are `CATALOG`,
  `INFERRED`, `OBSERVED` and `MANUAL`.
- **Colours:** a "Manual vs Observed" conflict uses `--warn`; infeasible or over-cap uses `--bad`.

### Screens

| Screen | Purpose | Mockup |
|---|---|---|
| First run | Start a project from the game install, a catalog pack, or a console survey or preset, shown over a coordinate grid | `a3-sol.html` frame 1 |
| World & Library | Layer stack with per-field provenance, rebase review, sources (Docs, CatalogPack, console survey, live) and unknown classes | `a3-sol.html` frame 2 |
| Atlas | The map: sites, corridors with budget-width strokes and tier detents, contended nodes, sensitivity, a phase scrubber | `a3-opus.html` frames 1–2 |
| Charter | Goals × phases matrix, phase-scoped pins and exclusions, hard constraints, objective order, the Draft allocation receipt | `a3-sol.html` frame 3 |
| Options | Two forks on the same snapshot and targets, with a factual tradeoff receipt: "No ranking; your objective order decides" | `a3-sol.html` frame 4 |
| Redline | Survey strip of autosaves, as-built over as-designed, variance clouds, grouped variance list, evidence chain, Amend / Keep | `a3-opus.html` frame 3 |

The final mockups are in [`council/mockups/`](council/mockups/) (`a3-*.html`; earlier rounds are
kept for reference). **The contour terrain drawn in them is a placeholder:** terrain is a stretch
goal, and the planned map is the plain coordinate grid.

**UI fixes to make before implementing:**
1. Unify the shell chrome of the two mockups: one theme control, the same rail collapse, and solver
   status in the rail footer.
2. Apply the colour rules above consistently, and style layer and evidence chips the same way
   everywhere.
3. Let Redline's variance list scroll so it never clips. Link the Atlas phase scrubber to the
   Charter's phases.

## Milestones

| Milestone | Ships | Exit criterion | Not in it |
|---|---|---|---|
| **M0 — Port and prove** (headless) | v1 save and Docs parsers as pure modules, with the rewrite-notes traps as tests; the six golden fixtures; the HiGHS WASM `SolverPort` with v1's regressions (Obsidian Gears 6,340 Iron Plate/min; Max Milestone Multiplier 106.67 Rotor/min); `.ussp` schema and crash replay; dispatch fingerprint; a CLI | Fixtures green from the CLI; a kill during a write replays cleanly; a solver crash surfaces as an engine error | Electron, any UI, corridors |
| **M1 — Shell and Atlas** | Electron with three processes and a warm spare; save watcher; First run; World & Library; `WorldComposer` with evidence chips; Atlas on the coordinate grid; **both themes with a toggle**; open, save and export | A clean install opens the grid, imports Docs, a save and a pack, renders the layers and persists the `.ussp` | Solver in the UI, corridors, Redline, telemetry |
| **M2 — Charter, corridors, Draft allocation** | Charter; corridors with budgets, tier detents and hard caps; node elevation flags; fuel-bound circuits; contention; Check plan; streaming Draft allocation; sensitivity from duals; forks and Options | Charter → Draft allocation → commit → reopen reproduces the same fingerprint and result | Variance, rebase review, telemetry, any "what to build next" output |
| **M3 — Redline** | `VarianceEngine` (extraction, corridors, circuits, machines); survey strip; clouds; evidence chains; Amend / Keep; rebase review with Manual vs Observed; variance cache | A later save of a fixture session gives evidence-backed deltas matching a hand-written expected list | Telemetry, marker export, IoStore, native HiGHS |

### Verification invariants

These are enforced by tests from the milestone where they first apply.

- **M0:**
  - **Fingerprints are deterministic.** Reordered equivalent inputs give the same fingerprint, and
    changing any input misses the cache.
  - **Solver failures are never "Infeasible".** Crashes, out-of-memory and hangs show as engine
    errors, and stopping between stages shows "Partial · stage k of n".
  - **Journal replay is durable and idempotent,** even when Main is killed mid-commit or mid-fold.
    An exported `.ussp` stands alone.
  - **Unknown classes are kept byte-for-byte.** Missing fixtures **fail** CI; they are never
    skipped.
- **M1:**
  - **The release package contains zero game-derived assets.** An offline clean install opens the
    grid, and a CatalogPack with a hash mismatch is rejected.
  - **Provenance survives switching snapshots.**
- **M2:**
  - **Edits during a solve don't change the result's fingerprint;** the result keeps the
    fingerprint from dispatch.
  - **Whole buildings are rechecked before "Passed".**
  - **Draft allocation requires player-entered targets.**
  - **Receipts never rank options.**
- **M3:**
  - **Provenance survives a rebase.**
  - **No recommendations in the UI:** a lint test rejects recommendation wording ("should",
    "recommend", "best", "upgrade", imperative build verbs) in UI strings.
- **Path 2:** **Telemetry leaves solver inputs and variance untouched:** `ProblemSpec`, its
  fingerprint and save variance stay identical while the overlay changes.

## Owner decisions (2026-11-27)

1. **Themes:** ship both dark and light with a toggle from M1. Custom or more complex user themes are
   a **stretch goal**; keeping every colour a semantic token keeps that possible.
2. **Terrain and heightmap:** a **stretch goal**. M0–M3 have no terrain import, hillshade or contour
   tiles; the map is the plain coordinate grid.
3. **Headlift:** no sampling along corridors, pump placement or tunnel segments for now. Instead each
   node is **flagged if it is underground or very high**, based on its own Z position. Corridor
   headlift moves to the terrain stretch goal.
4. **Live feed (Path 2):** strictly **after M3**.

## Top risks for a solo developer

- **Scope sprawl:** six screens across three processes. Mitigation: keep each milestone's "not in"
  list, and ship M0 headless before any UI.
- **Save-format drift after game patches:** mitigated by the golden fixtures in CI, keeping unknown
  classes, and failing soft to `N/A`.
- **Slow WASM MIP solves:** mitigated by the isolated solver process, the non-LP `Checker`
  pre-check, partial stages, and a native HiGHS fallback behind `SolverPort` if benchmarks demand it.

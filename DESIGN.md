# Satisfactory Planner — design

How the planner works inside: the save and game-data parsers, the solver, plans and storage,
the UI design, and how the UI is built. For installing and running the app, see the
[README](README.md).

- [Parsing core](#parsing-core)
- [Solver](#solver)
- [Plans and storage](#plans-and-storage)
- [UI design](#ui-design)
- [UI implementation](#ui-implementation)

## Parsing core

Save-file and game-data parsers for the Ultimate Satisfactory Production Planner (Update 1.2).
Pure TypeScript, no Node or DOM dependencies in `src/` (only `TextDecoder` and `fflate`), so the
same code runs in the browser build and the Tauri desktop app.

```
src/
  platform/types.ts       File/storage interfaces (browser + desktop backends implement these)
  util/text-decode.ts     BOM / UTF-16 detection for Docs.json and locale files
  gamedata/
    ue-text.ts            Parser for Unreal ExportText values used inside Docs.json
    docs-parser.ts        Docs.json -> GameData (ClassName-keyed) + Labels overlay
    node-catalog.ts       Map data the save lacks (resource type + default purity per node)
    types.ts
  save/
    binary-reader.ts      Little-endian reader + FString
    header.ts             Save header (v14)
    decompress.ts         Chunked zlib body
    properties.ts         UE 5.4+ complete-type-name property tags
    save-reader.ts        Levels, TOC, object data -> generic object graph
    extract.ts            Object graph -> SaveSummary (what the planner uses)
    summary-types.ts
  solver/                 Lexicographic LP / integer planner on HiGHS (see Solver)
  plans/                  Versioned plans, storage, export/import (see Plans and storage)
  platform/memory.ts      In-memory KeyValueStore
  platform/browser/       IndexedDB store + file picker/download (the only DOM code)
```

### Usage

```ts
import { readDocsFile, parseGameData, parseLabels, summarizeSaveBytes, resolveNodes } from './src';

const groups = readDocsFile(docsBytes);             // any locale file; encoding auto-detected
const gameData = parseGameData(groups);             // identical for every language (contentHash)
const labels = parseLabels(groups, 'en-US');        // display names only
const summary = summarizeSaveBytes(saveBytes, gameData);
const nodes = resolveNodes(summary, gameData, catalog /* optional */);
```

`npm test` runs the parser and solver tests against the project saves and the en-US / da / he game data
(tests for fixtures that aren't present are skipped). The solver is documented in [Solver](#solver), plans and storage in [Plans and storage](#plans-and-storage).
`npm run summary -- fixtures/en-US.json fixtures/<save>.sav` prints a readable summary.

### Where things live in a 1.2 save

| Data | Object.property |
|---|---|
| Game Mode cost multipliers | `BP_GameState_C.mPartsCostMultiplier`, `.mSpacePartsCostMultiplier` |
| Node purity mode / seed | `BP_GameState_C.mNodePuritySettings` (`NPS_AllPure`, …), `.mNodeRandomizationSeed` |
| Node resource randomization | `BP_GameState_C.mNodeRandomization` (`ENodeRandomizationMode::NRM_Strict`) |
| Per-node resource override | `BP_ResourceNode_C` / `BP_FrackingSatellite_C` / `BP_FrackingCore_C` `.mResourceClassOverride` (item class) |
| Per-node purity override | `BP_ResourceNode_C` / `BP_FrackingSatellite_C` `.mPurityOverride` (`RP_Pure`, `RP_Normal`, `RP_Inpure`) |
| Purchased milestones, MAM, alternates, shop | `BP_SchematicManager_C.mPurchasedSchematics` (classified via Docs `mType`) |
| Unlocked recipes | `FGRecipeManager.mAvailableRecipes` |
| Space Elevator phase | `BP_GamePhaseManager_C.mCurrentGamePhase`, `.mTargetGamePhase`, `.mTargetGamePhasePaidOffCosts` |
| Overclock / Somersloop unlocked | `BP_UnlockSubsystem_C.mIsBuildingOverclockUnlocked`, `.mIsBuildingProductionBoostUnlocked` |
| Items held | every `FGInventoryComponent.mInventoryStacks`, plus `FGCentralStorageSubsystem.mStoredItems` (Dimensional Depot). Components named `*InventoryPotential` on `Build_*` owners are slotted shards/sloops |

Unreal omits properties that equal their default, so an absent setting means the default. The
summary marks each setting as `source: 'save' | 'default'`.

### Assumptions the code makes (surfaced to the user)

- **Version:** save version 60 is treated as Update 1.2 (seen in builds 495413 `rel-main-1.2.0` and
  513885 `rel-main-anniversary-2026`). Other versions load with a warning; pre-1.0 headers are rejected.
- **Not in Docs.json:** node purity multipliers (0.5 / 1 / 2), 3 power-shard slots per building, and
  1 Somersloop slot for buildings that don't override slot size (Constructor, Smelter). These are
  engine constants exposed in `GameData.constants`, each with a note.
- **Belt speed:** Docs `mSpeed` is twice items/min (Mk1 120 → 60/min). Pipes: `mFlowLimit` × 60.
- **Fluids:** Docs amounts are litres; converted to m³ (÷1000).
- **Somersloop / shard budgets:** "available" = items stored anywhere + items slotted in buildings,
  since plans start from scratch. Power slugs are reported with their shard yield from Docs recipes.

### Node data: what each Game Mode writes

The game only writes what a Game Mode setting changes; everything else comes from the map asset.
Node purity (`mNodePuritySettings`) and resource randomization (`mNodeRandomization`) are
independent settings, each writing its own per-node override:

| Save (fixture) | Randomization | Purity setting | Resource stored | Purity stored |
|---|---|---|---|---|
| default.sav | off | default | none | none |
| all-pure-nodes.sav | off | `NPS_AllPure` | none | all 577 extractable nodes |
| random-nodes.sav | `NRM_Strict` | default | all 594 (459 nodes, 118 satellites, 17 cores) | well satellites only (118) |
| resource-rich-random-purity.sav | `NRM_AdvancedRich` | `NPS_AllRandom` | all 594 | all 577 extractable nodes |

- One coupling: resource randomization also writes purity on well satellites, even with purity at default.
- `NRM_Strict` keeps the base map's per-resource node counts (127 iron, 55 copper, 94 limestone, 5 uranium …)
  and only reshuffles locations. `NRM_AdvancedRich` rebalances toward rare resources (e.g. 40 uranium,
  56 quartz, 61 iron). Scarcity weights must therefore come from the save, never from base-map counts.
- The bundled node catalog fills whatever the save omits; save overrides always win. `resolveNodes`
  returns an `assumptions` line saying how many resources/purities came from the catalog (none for
  resource-rich + random purity saves, which are fully self-describing).
- Node ids and positions are identical across all six fixture saves.

### Bundled node catalog (`src/gamedata/data/node-catalog-1.2.json`)

Default resource and purity for all 608 nodes (459 resource nodes, 118 well satellites, 31 geysers)
plus 17 well cores, keyed by node id. Load with `loadBundledNodeCatalog()`.

- **Source:** `game_data/generated/world/resourcePurity.json` from
  [valentinps/satisfactorymap](https://github.com/valentinps/satisfactorymap) release `game-data-v3`
  (`game_data.zip`, sha256 `686bac80…fe1d0`, verified). That file is an FModel export of the 1.2 level
  data, i.e. the game's own map values. Regenerate with `tsx scripts/build-node-catalog.ts <resourcePurity.json>`.
- **Validated** (`test/node-catalog.test.ts`): ids match all six fixture saves exactly and positions
  agree within 0.01 cm; per-resource purity counts equal the official wiki table; the resource
  multiset equals the Strict-randomized save; 43/43 miners and oil extractors in the played saves are
  producing the catalog's resource; every satellite's core agrees on the resource.
- **Rights:** like Docs.json, this is Coffee Stain Studios' game data, not licensed by the upstream
  project (AGPL code, which we do not use). It is bundled with attribution, excluded from the
  project's license, and will be removed if Coffee Stain Studios asks. It holds only facts (node id,
  kind, resource, purity, well core), no art, code or text. Alternatives considered: downloading it
  at runtime (breaks "no network requests") or extracting it from the user's install (needs UE5
  IoStore + Oodle; realistic only in the desktop app).

## Solver

Lexicographic LP (HiGHS via WebAssembly) with an optional integer pass, on top of the parsing
core. Pure TypeScript; the HiGHS loader is injected, so the same code runs in the browser
build (in a Web Worker), the Tauri app, and Node tests.

```
src/solver/
  types.ts           PlanningProblem / PlanRequest / PlanResult (all JSON-serializable)
  problem.ts         GameData + SaveSummary + resolved nodes -> PlanningProblem (the only parser-aware file)
  validate.ts        request checks, merged duplicates, effective budgets, objective order
  reachability.ts    what can be made at all, relevant recipes, plain-language "why not"
  variants.ts        clock / Somersloop operating points, belt- and pipe-capped
  model.ts           LP/MILP columns and rows
  objectives.ts      objective registry (add AWESOME Sink points here later)
  lexicographic.ts   solve level, pin it, solve next; binding limits from row duals
  diagnose.ts        elastic relaxation: smallest limit increases that meet the targets
  result.ts          placed buildings, real clocks, flows, budgets, resource use, power
  explain.ts         plain-language explanation (labels from any locale)
  solve.ts           solvePlan(): validate -> LP -> integer pass -> diagnosis -> result
  lp/types.ts        solver-agnostic LpModel / LpBackend
  lp/highs-backend.ts  HiGHS implementation
```

### Usage

```ts
import highsLoader from 'highs';
import { buildPlanningProblem, solvePlan, createHighsBackend, makeLabel, DEFAULT_OBJECTIVE_ORDER } from './src';

const problem = buildPlanningProblem(gameData, summary, resolveNodes(summary, gameData, catalog));
const backend = createHighsBackend(() => highsLoader());          // browser: highsLoader({ locateFile: () => wasmUrl })
const result = await solvePlan(problem, {
  targets: [{ item: 'Desc_Motor_C', ratePerMin: 20 }],
  maximize: [], manualInputs: [], excludedNodes: [], rawCaps: [], disabledRecipes: [],
  objectiveOrder: [...DEFAULT_OBJECTIVE_ORDER],
  budgets: { somersloops: 10, powerShards: 30 },
}, backend, { integerPass: 'auto' }, makeLabel(labels.names));
```

`npm run plan -- fixtures/en-US.json fixtures/<save>.sav '<request json>' [--integer] [--json] [--timing]`
prints the explanation and building list. `npm run facts -- fixtures/en-US.json fixtures/*.sav`
shows what the solver sees for each save.

### Model

**Columns.** Building-equivalents of each recipe at each *variant*; nodes of each
(resource, purity) group per extractor and clock; fraction of each Resource Well per
pressurizer clock; Water Extractors; delivered output and shortfall per requested item.

**Variants.** Plain buildings run at 100%. Somerslooped buildings get one variant per fill
level (1..slots) × clock 100/150/200/250%; extractors and pressurizers get the clock steps.
A clock between steps needs the next step's shards and is never better, so the steps cover
every useful choice. Any variant whose input or output would exceed the best unlocked belt
(solids) or pipe (fluids) has its clock lowered until it fits — the only underclocking the
solver decides. Shard and Somersloop variants exist only when their budget is above 0.

**Rows.** Item balance (production + extraction + manual − consumption − delivery ≥ 0;
surplus allowed and reported), targets (delivery + shortfall ≥ target), node-group and well
limits, user raw caps, Somersloop and Power Shard budgets.

**Objectives** (default order, reorderable): minimize unmet targets (fraction of each
target) → maximize each "maximize" item in request order → minimize scarcity-weighted raw
use (Σ rate / map-wide capacity) → minimize MW → minimize buildings → hidden tie-break:
fewest Somersloops and shards. Each level is pinned before the next: a zero optimum is pinned
exactly (bounds to 0); otherwise to within 1e-9 relative, loosened once if that proves
numerically infeasible.

**Integer pass** (`'auto'` runs it only when rounding the LP's fractional buildings up would
break a budget or node limit). Whole counts for Somerslooped/overclocked buildings,
extractors and wells; plain buildings stay fractional and are rounded up, which can't break a
limit. It uses the boost variants the LP chose (each recipe can also fall back to unboosted)
and every extractor option for the raw resources used, then re-runs all levels. Integer solves
have no duals, so binding limits are carried over from the LP. 5 s per level limit; a
time-limited result is flagged as not proven optimal.

**Diagnosis.** If a target is short: unreachable items with reasons (locked recipe, locked
building, no unlocked extractor, every node excluded, capped at 0, no recipe exists); limits
binding at the targets level; and an elastic LP finding the smallest set of increases that
meets every reachable target, preferring in order: budget up to what you hold → your raw
caps → budget beyond what you hold → more nodes than the map has (i.e. not possible).

### Results

`PlanResult` holds per-level values and binding limits, placed buildings (count, the clock
each one actually runs at, shards and Somersloops each, flows, power at real clocks),
extraction lines, item flows (produced / consumed / extracted / manual used / delivered /
surplus / lines needed on the best belt or pipe), budget use and where, raw use against
what the plan could extract and against the map, and the plain-language `explanation`,
`assumptions` and `warnings`. It carries the game-data hash and save build for plan versioning.

### Assumptions (surfaced in results)

- Scarcity weight = 1 / map-wide capacity of that resource in this save: every node at its
  purity, best extractor in the game data at 100%, ignoring this plan's exclusions. Water from
  Water Extractors is unlimited (weight 0).
- The LP is linear in building-equivalents; power is then recomputed at each building's real
  clock (clock^1.321929 × boost^2 from Docs), which is what results report.
- Variable-power buildings are counted at constant + half the variable range (Docs recipe values).
- Budgets above what the save holds are allowed with a warning; a budget is ignored (with a
  warning) when the save hasn't unlocked overclocking / production boosting.
- "Available" shards are shards held; Power Slugs are mentioned with their shard yield, not counted.
- Somersloops boost all outputs of a building, inputs unchanged.

### Parser change

`GameData.buildRecipes` (build-gun recipe → buildables) was added so the solver can tell which
buildings, extractors, belts and pipes the save has unlocked. All 34 modeled buildables map to
a build recipe. This changes `contentHash` once.

### Tests

`test/solver-unit.test.ts` (22) uses a small hand-made world with hand-checkable numbers:
variants and belt caps, recipe choice per objective, manual inputs, exclusions, maximize,
budgets and the integer pass, wells, every diagnosis tier.
`test/solver-fixtures.test.ts` (9) runs on the project saves with en-US game data, e.g.:

- Obsidian Gears, 10 RIP + 5 Modular Frame: 8 Smelters, 6/4/6/3/6 others, 2 pure Mk.1 miners,
  240 ore, 35 buildings.
- Obsidian Gears, max Iron Plate with 10 shards: exactly 6,340/min (9,510 ore: pure Mk.1 nodes
  can't overclock past the Mk.2 belt, so shards go to normal nodes).
- Max Milestone Multiplier, maximize Rotor at 600 ore + 20 Somersloops: 1200 / 11.25 =
  106.67/min, all Somersloops on Smelters, limited by the cap and the Somersloop budget.
- All Pure Nodes, Motors + Encased Beams with budgets: met within budgets in ~1.5 s, no port
  over the Mk.3 belt / Mk.2 pipe, overclock only on Somerslooped buildings; deterministic.

Parser tests whose fixtures aren't present (da/he locales, the three extra saves) are skipped.

## Plans and storage

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

### A plan

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

### Versioning

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

### Export / import

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

### Browser specifics

`createBrowserPlatform()` opens IndexedDB and `PlanStore.init()` requests persistent
storage; if the browser refuses, the UI should tell the user to export plans they want to
keep. If IndexedDB is unavailable (some private modes) it falls back to memory with a
warning. Export uses the save dialog where the browser has one, otherwise a download.

### Not done yet

The desktop (Tauri) backend: a filesystem `KeyValueStore` (one JSON file per key in the app
data folder) and `FileAccess` with native dialogs plus save-folder / game-install detection.
It comes with the Tauri wrapper; the interfaces don't change.

### Tests

`test/plans.test.ts` (15) uses a real plan solved on Obsidian Gears: freshness for each stale
reason, shared summaries and cleanup, duplicate/rename, full export → import round trip
(fresh afterwards), merge rules, tampered summary re-keying, bare plans, version refusals,
field-level validation of hostile input, UTF-16 files, the FileAccess flow, and the IndexedDB
store (via fake-indexeddb) including the plan store end to end.

## UI design

Design decisions for the planner's UI, from the design sessions on 24 Oct 2026. The clickable
mockups live on the design canvas "Satisfactory Planner UI"
(https://claude.ai/artifact/Fd6MzXkCAdT6GLc7aHhQGG). The plan workspace, short-of-target state,
Nodes, Recipes, phone, first-run and large-graph boards are interactive (press Play). This section is
the reference for building the real UI on top of the parser, solver and plan store; it does not
replace them.

### Decisions at a glance

| Question | Decision |
|---|---|
| Visual direction | FICSIT industrial: dark UI, safety-orange accent, hazard-stripe top bar |
| Main layout | Split: request editor on the left, results on the right, request panel collapsible |
| Primary results view | Flow graph tab, shown by default; other views are tabs beside it, not separate pages |
| Graph at scale | Modules by default (related recipes collapsed into one box); expand any module; focus a box to fade everything outside its chain; search, minimap, drag to pan, wheel to zoom |
| Node exclusion | Schematic map from save positions over a traced coastline outline (no game map image) plus a resource list |
| Node colour | Colour = resource; purity = size and fill; exclusion = × mark |
| Short of target | Results pane switches mode: blockers, then a one-click smallest fix |
| Phone | Same page, stacked; opens on results with the request panel collapsed |
| First run | Two steps, game data then save; the save step is locked until game data loads |
| Errors | Say what happened, whether anything was lost, and one next step; details behind a disclosure |

### Visual system

**Colour tokens** (dark only for now):

| Token | Value | Use |
|---|---|---|
| ground | `#121417` | page background |
| canvas | `#15181B` + 1px `#262A30` dots every 16px | graph and map backgrounds |
| panel | `#1A1D21` | sections, cards |
| inset | `#22262B` | rows, inputs' surroundings |
| input | `#121417` | input fields |
| border | `#2E333A` / strong `#3A4048` | dividers, controls |
| text | `#ECE7DE` | primary |
| text-2 | `#D6D1C8` | body in panels |
| muted | `#A3A9B0` | secondary (≥ 4.5:1 on panel) |
| faint | `#8A9098` | labels, captions (≥ 4.5:1 on panel) |
| accent | `#F59A3E` | primary action, active nav/tab, selection, focused chain; text on it `#17130E` |
| ok / fresh | `#8EC5F5` on `#17283A` | targets met, fresh results, delivered |
| stale / warn | `#F2CC5B` on `#3A3014` (banners `#2A2512`, border `#6B5A1E`) | stale plan, over-held budget, loaded-with-warning, surplus |
| short / blocked / error | `#FF8A7A` – `#FF9A8F` on `#2A1717` (border `#7A3535`) | target short, locked, unreachable, failed load |
| from save | `#FFB872` on `#3A2614` | "Save" source badge, extraction cards, boosted (Somersloop) variants |
| default | `#C8CDD3` on `#262A30` | "Default" / "Catalog" source badge |

Status colours always come with a word ("Fresh", "Short", "Save changed"), and each differs in lightness, so nothing depends on hue alone.

**Resource colours** (map dots, chips, swatches, and graph edges that carry the raw item): Iron Ore
`#D9826B`, Copper Ore `#F0A45A`, Limestone `#E8DDC4`, Coal `#8C939C`, Caterium Ore `#F2CC4B`, Raw
Quartz `#F08CC8`, Sulfur `#C9E35A`, Bauxite `#B98557`, SAM `#A98BF0`, Uranium `#6EE07A`, Crude Oil
`#5BA8D9`, Water `#6FC7C1` (also used for loop edges). Not yet assigned: Nitrogen Gas and resource
wells.

**Type:**
- Barlow Condensed 600/700, uppercase with tracking, for headings, labels and nav.
- Barlow 400/500/600 for body text and controls.
- JetBrains Mono for every number, rate, version, hash, path and ClassName, so columns align.
- Base size is 15px; section headings are 18px; stat values are 26px; graph cards are 12–13px.

**Shapes and spacing:**
- Corners: 4px on controls, 6px on panels.
- Spacing scale: 4/8/12/16/24.
- Touch targets are at least 44px, including steppers and icon buttons. The exception is graph cards and map dots; the lists beside them are the accessible path.

**Recurring components:**
- Stat strip: label, mono value, one-line sub.
- Freshness badge.
- Source badge (Save / Default / Catalog / Unknown value).
- Budget stepper: shows `budget / held`.
- Item row: abbreviation tile, name, rate input, remove.
- Segmented control.
- Tier chip on suggested fixes.
- Switch (Recipes).
- Item picker dialog.
- File drop zone: a dashed button with idle, locked, reading (stage + progress bar), loaded, warning and error states.
- Message blocks:
  - Error: coral, `role="alert"`.
  - Warning: amber, `role="status"`.
  - Each has a title, one plain sentence, an optional path in mono, one action, and an optional "Technical details" disclosure.
- Graph card and module card (see Flow graph). Module chip: a pill with a chevron and recipe count, which toggles one module.

**Icons:** inline stroke SVGs only. Real game item icons aren't used, since they are Coffee Stain's art. Items get an abbreviation tile (RIP, MF) until we decide whether to extract icons from the user's install.

### App shell

- **Top bar:**
  - Hazard stripe across the top.
  - Wordmark and "U1.2" version chip.
  - Nav: Plan · Nodes · Plans · Setup. Plan and Nodes are disabled ("Load a save first") until a save is loaded.
  - Two chips on the right: the loaded save (name, save version, build) and the game data (file, content hash). Both chips link to Setup.
- **Plan bar:**
  - Plan name with its position ("Plan · 3 of 7") and freshness badge.
  - Hide/Show request toggle.
  - "Whole buildings" segmented control (Auto / Always / Off, which maps to `integerPass`).
  - Solve, the primary button.
- **Content:** a wrapping flex row.
  - Request panel: `flex: 1 1 320px; max-width: 380px`. Side by side (960px and up), it's sticky and scrolls on its own, so it stays in view while the results scroll. On the Flow graph tab its height stops at the bottom of the graph (or the window, if that comes first), so the two line up.
  - Results: `flex: 999 1 560px`.
  - Below about 900px they stack; wide tables scroll inside their own boxes, and the graph pans inside its box.
- **Pinned banner slot** under the top bar for app-wide conditions (no storage). It's the only place a message shows on every screen.

### Screens

#### 0. First run (nothing loaded)
- A headline ("Plan a factory from your save") and two sentences on why both files are needed and that they stay on this computer.
- **Step 1, Game data:** a drop zone that also works as a button. The hint names the install folder (`CommunityResources/Docs/`) and says any language's file works.
- **Step 2, Save:** locked until game data loads ("Load game data first — the save is read against it"), because `summarizeSaveBytes` needs `GameData`. The hint names the Windows save folder (`%LOCALAPPDATA%/FactoryGame/Saved/SaveGames/<id>/`).
- **Reading:** the file name, a stage label and a progress bar. Stages for game data: detecting encoding → reading recipes and items → building game data. Stages for the save: reading header → decompressing body → reading world objects → summarizing unlocks and nodes.
- **Loaded:** a summary card. Game data shows language, encoding and content hash; the save shows name, version and build. "Choose a different file" replaces it.
- **Footer:** "Nothing is uploaded"; the desktop app finds both files itself. "Continue to setup" becomes active when both are loaded, or reads "Continue anyway" when the save loaded with a warning.
- **Desktop app:** this screen only appears if auto-detection finds no install or no saves. It then shows the same steps with native file dialogs.

#### 1. Setup
- Two loader cards: game data (any locale Docs file; shows detected encoding and content hash, plus a labels-language select) and save (name, file, saved time, save version, build).
- **Game Mode** table: one row per setting the solver reads (parts and space-parts cost, node purity, node resources, seed, overclocking, Somersloop boosting), each with a Save or Default badge. This comes straight from `source: 'save' | 'default'`. A value the planner doesn't recognise gets an "Unknown value" badge and is treated as the default, with an assumption line.
- **Progress**: Space Elevator phase, milestones, MAM nodes, alternates, best belt and pipe.
- **Collected**: Somersloops and shards as "held = stored + slotted", plus Power Slugs with their shard yield (not counted in budgets).
- **Resource nodes**: extractable count, how many purities and resource types the save stores versus the bundled catalog, and the `resolveNodes` assumption line in plain words.
- When plans point at an earlier summary of this save, a banner offers "Review N plans" (rebase). The primary action is "New plan from this save".

#### 2. Plan workspace (request editor + results)

**Request panel** (top to bottom):
1. **Targets**: rate per minute, remove, and "Add target item", which opens the picker dialog. The picker lists only items the save can make; it searches by display name but stores ClassName.
2. **Maximize**: ordered list; its order is the request order.
3. **Budgets**: Somersloops and Power Shards as stepper + input + "/ N held". Both default to 0. Going above held turns the border amber and shows an inline note ("Allowed — results will say how many more the plan needs").
4. **I already produce**: manual inputs, non-raw items only.
5. **Priorities**: the objective order. Each row has a drag handle plus up/down buttons for keyboard users, and "Reset order". An idle level is dimmed with a note ("nothing to maximize"). The hidden tie-break is shown as a footnote.
6. **Sources**: links to Nodes ("577 · 0 excluded") and Recipes ("14 alternates · 0 off").

Any edit marks the plan stale: the badge says "Request changed · solve again", the results dim to about 55%, and a "Solve again" bar appears above them. This maps to `checkFreshness` → `request-changed`. Solving shows "Solving…" on the button and badge while the worker runs.

**Results panel:**
- **Stat strip**: targets met (x / y), power at real clocks, buildings (production · extractors), Somersloops used / budget (· held), Power Shards used / budget (· held).
- **One-line summary** above the tabs, with a "Why this plan" link. The explanation is never more than one click away.
- **Tabs**: **Flow graph** (default) · Why this plan · Buildings · Item flows · Raw resources · Assumptions (count).

**Other tabs:**
- **Why this plan:** the `explanation` paragraphs, plus a "binding limits" callout ("No limit is binding" when there are none).
- **Buildings:** building, recipe, count, real clock, in → out per minute, MW, and a total row. Underclocked rows show their clock in the muted colour.
- **Item flows:** made, used, delivered, surplus, and lines on the best belt/pipe, with small bars for the line count.
- **Raw resources:** use vs map capacity (bar), scarcity weight as `1 / capacity`.
- **Assumptions:** `assumptions` and `warnings` from the result and the summary.

#### 2a. Flow graph

Two boards show it: "Plan workspace" (a 9-box iron chain, hand-placed) and "Flow graph at scale". The second is a 25-recipe Phase-3-style plan with 8 raw resources, a Somersloop variant, a byproduct, a water loop and surplus, laid out by code in the mockup.

**What a box is:**
- One box per placed recipe *variant*: a boosted Smelter group and a plain Smelter group are two boxes, so where Somersloops and shards went stays visible. The boosted box gets an amber border and an amber clock line.
- Extraction boxes carry the resource colour dot, extractor count × type, purity and clock.
- Delivered boxes (blue) show delivered vs target. One **Surplus** box (amber) collects leftovers and byproducts nothing uses; later it becomes the AWESOME Sink hook. Rounding noise isn't surplus: an item needs at least 0.01/min and 0.01% of its throughput left over, the same rule "Why this plan" uses.

**Layers and bands:**
- Left to right: raw resources in a left band, then recipes by longest-path depth, then delivered and surplus in a right band.
- Left to right reads like a production line. A wide graph doesn't have to fit beside the request panel, because the canvas pans and zooms freely.

**Modules (level of detail):**
- Related recipes form a module: Iron line, Steel & concrete, Copper line, Electronics, Aluminum line.
- Default view is **Modules**. Each module is one stacked card: recipe count, buildings, MW, a "↺ N loop inside" note, and what it sends out. A recipe that is its own step (Plastic, Heavy Modular Frame) stays a plain box.
- Detail control: Modules / All recipes. A row of module chips expands or collapses each module on its own (a "custom" mix). The + on a module card expands it in place.
- Edges between collapsed modules are merged per pair. One item shows its rate; several show "N items", and the drawer lists them.
- **Grouping rule for the real app:** start from a fixed item → module map (iron, steel, copper, caterium, quartz, oil, aluminum, electronics, nuclear, …), then fold in any recipe whose output feeds only one module. Modules with one recipe aren't grouped. Users never configure this.

**Edges:**
- Orthogonal routing. All edges leaving a box share one trunk from its right side and split on a lane in the gap beyond, so an item that feeds many recipes reads as one bus, not a fan of crossings.
- Inputs enter spread across the target's left edge. Edges that skip layers pass through reserved gaps, never across a box.
- Colour:
  - Raw items keep their resource colour.
  - Deliveries are blue.
  - Everything else is neutral grey.
- Style:
  - Byproducts are dotted.
  - **Loops back up the chain** (e.g. water from Aluminum Scrap back to Alumina Solution) run right to left, against the flow. They're dashed teal and labelled "↺ Water 15".
- Labels are mono rates per minute, or "N lines" in Belt lines mode (best unlocked belt and pipe), on a small ground-coloured pill just left of the arrowhead.

**Focus:**
- Clicking a box or module focuses it. Its whole upstream and downstream chain stays lit with accent-orange edges; everything else fades to about 25%.
- A chip "Focused on X · its whole chain" with a clear button appears above the graph.
- A detail drawer opens on the right:
  - Kind and title.
  - Facts: buildings, clock, output, power, module.
  - In and Out lists (item, other end, rate). Each row jumps to that box.
  - Module drawers list what's inside; each entry expands the module and selects that recipe.
  - Actions: Expand module, Collapse module, In Buildings table.

**Navigate:**
- "Find in graph" search over item and recipe names and modules. Choosing a result inside a collapsed module expands it, selects the box and centres the view on it.
- Click and drag anywhere (boxes included) to pan, with no edges to stop at. A press that moves less than 4px is still a click, and a drag never selects a box.
- The wheel (or trackpad pinch) zooms around the cursor without scrolling the page. Zoom − / % / + (20–200%, kept centred) and Fit (whole graph, centred).
- A minimap in the bottom-right shows every box (focused chain lit) and the viewport; clicking it centres the view there.

**Implementation:**
- Use ELK `layered` in a worker, with orthogonal edge routing.
- Cluster modules as compound nodes so expand/collapse doesn't reshuffle unrelated boxes.
- Set loop edges as feedback edges and pin the raw and delivered bands to the first and last layers.
- Build the graph from `PlanResult`: placed buildings grouped by recipe and variant → boxes; item flows → edges; deliveries and surplus → sinks.
- The mockup's hand-rolled layering, barycenter ordering and lane routing show the intended look, not the production algorithm.

#### 3. Short of target (same workspace, results in "diagnosis" mode)
- **Banner** (coral): what's short and by how much, what's unreachable, and a "See the fix" link. When the targets are met but an unreachable target remains, the banner turns amber ("Rotor met · Motor blocked"). When everything is met, it turns blue.
- **Target rows** in the request panel show a progress bar (delivered / target) and "106.7 · short 43.3".
- **"What's in the way"**: the binding limits at the targets level, each with usage ("600 / 600") and its kind (Your cap, Budget, Nodes). Once the target is met, the heading becomes "Limits at their maximum".
- **"Smallest change that reaches X"**: the elastic diagnosis as an ordered list. Each change shows from → to, a tier chip and its own Apply button.
  - Tier chips: "You hold these", "Your cap", "Beyond what you hold", "More than the map has".
  - Primary action: "Apply both and solve".
  - Secondary action: "Lower the target to {max reachable} instead", using the reachable maximum rounded down.
- **"Can't be made in this save"**: each unreachable item with its plain-language reason from `reachability`, plus a "Remove … target" button.
- **"Why this plan"**: explains where the boosts went and why.

#### 4. Nodes
- **Resource chips** (All + one per resource, with swatch and count) choose which resource is in front. The others stay on the map at about 20% opacity.
- **Map:** schematic top view from save positions on a light grid, over the coastline, lakes and rivers: sea and lakes are filled dark blue, land is the canvas colour, and thin lines trace the edges (a "Coastline" chip turns it all off and brings back the plain grid). No game map image is shipped; the wireframe is a simplified vector trace (`app/ui/map-outline.json`, about 21,200 points, 214 KB or 82 KB gzipped: every land/water edge at full detail, plus centre lines for channels too thin to show two banks, with thin drawn strokes across rivers (cliff edges, falls) removed so rivers stay continuous; made by `scripts/trace-map-outline.py --detail 4` from the wiki's 5000px full-map image, simplified to about 1.8 m; source images live in the gitignored `scripts/map-sources/` and are never committed). An earlier trace used a 2048px Map Genie image patched with an in-game screenshot for the northern fjords; the wiki image shows those itself and registers to it within 0.12%. 97.1% of the default save's nodes fall inside traced land and the rest sit a median 10 m (at most 54 m) from a shoreline. The black off-map area (south, east and north-east edges) and the Grass Fields pit are traced as `void` and filled near-black, as on the game map, rather than as sea; their white border line and grey glow are masked out first so they don't trace as a second coast, and black specks smaller than about 2,500 px are shadows, not void. Beyond that the view is the same black. The sea is a soft glow (`app/ui/map-sea.png`, 492×492 at 25 m a cell, made by the same script): full colour within 400 m of land, fading out by 2.8 km measured through open sea (so nothing glows behind off-map black). It also fades out near the black, within 1 km on the map and 3 km past its edge (where the black carries on), and gently over 2.4 km past the edge everywhere, so it tapers in round shapes rather than ending in the map's square edge or spreading into off-map space. A faint screen-space grain over the map breaks up the 8-bit banding of such a dark gradient. The README credits the wiki as the source. Its rights are handled like the node catalog: game-derived, bundled with attribution, outside the MIT license, removed if Coffee Stain Studios asks.
- **Biomes:** a "Biomes" chip (off by default) shades the 21 biomes in faint tints clipped to the traced land (each region reaches 2 px into its neighbours and the layer fades as a whole, so borders meet with no gaps and no doubled overlap), with each name at the deepest point of its largest piece (fixed screen size, like nodes) and a hover title. The shapes (`app/ui/map-biomes.json`, about 2,500 points) come from `scripts/trace-map-biomes.py`: it classes each pixel of the wiki's 5000px biome map by its nearest tint in Lab, votes away text and grid lines, gives water and unclear pixels the nearest biome, drops far-off pieces that only share a tint, and leaves untinted land (coastal rocks outside any biome) unshaded. Western Beaches shares Dune Desert's tint and is split off as the western half. The wiki map is community-drawn and CC BY-NC-SA 4.0, so the README credits it and the license note lists the file separately from the MIT code.
  - Dot colour is the resource.
  - Size and fill are purity: pure is large and solid, normal is small and solid, impure is a ring.
  - An excluded node shows a white × over a faded dot.
  - A selected node gets a white ring.
- **Map interactions:**
  - Click a node to toggle exclusion.
  - Box or lasso select, then Exclude / Clear from a floating bar.
  - Drag to pan, with no edges to stop at; right-drag box-selects (the browser menu is suppressed on the map). The wheel zooms around the cursor, 25–400%.
  - Hover title shows resource, purity and state.
- **Side panel:**
  - The focused resource: nodes available of total, a purity table with excluded counts, a cap input, and map capacity before and after exclusions. It notes that the scarcity weight ignores exclusions.
  - All resources, each with a swatch, counts and its cap.
  - The excluded list, each with Include.
- **Page action:** "Include all".
- The map isn't keyboard-friendly; the resource list and excluded list are the accessible path. Every dot still has an accessible label.

#### 5. Recipes (per plan)
- Recipes for the items in this plan's chain, grouped by product. Each row shows a kind badge (Standard / Alternate / Not unlocked), building, and in → out per building at 100%.
- An "In this result" tag marks the recipes the last result used.
- Unlocked recipes get an On/Off switch, which maps to `disabledRecipes`.
- An unlocked alternate that can't run says why, e.g. "Needs the Refinery, which this save hasn't unlocked", using the same reason source as reachability.
- Filters: All / In this result / Alternates / Turned off / Not unlocked, plus search. "Allow all" resets everything.
- Changes show "Recipe choices changed. Solve the plan again."

#### 6. Plans
- **Table:** a select box, plan (name and request summary), save (name and build), result, and actions.
  - The result column is a badge plus one line from the freshness reason: Fresh, Short of target, Save changed, Game data changed, Request changed, Solver changed, or Not solved.
  - Actions: Open, or Solve again when stale; an overflow menu holds Duplicate / Rename / Export / Delete.
- **Header:** persistent-storage status, Import…, Export selected, New plan.
- **Import report** panel: one line per plan with the merge outcome (added, replaced with newer, added beside yours as "(imported)", skipped unchanged, not imported because it came from a newer planner). It ends with a note that summaries are re-checked and re-keyed.

#### Phone width
- Same page at 390px. It opens on the results with the request panel collapsed.
- The stat strip goes to two columns, and tabs and toolbars wrap.
- The graph pans and zooms inside its box; one-finger drag pans.
- If phone use matters, a Request / Results switch would beat stacking the two panels.

### Empty and error states

The rule for every message: say what happened, say whether anything was lost, then give one next
step. Exception text and byte offsets go behind "Technical details"; a "Copy details" button is
included where a bug report is likely. Nothing is a modal unless the whole app can't run.

| State | Trigger | Where it shows | Message and action |
|---|---|---|---|
| Opened from a file | address is `file://` | replaces the whole page | "Open the planner through its local server": start the server or the desktop app, open the address it prints; plans saved under that address are still there |
| Solver couldn't start | HiGHS WASM fails to load in the worker | results pane, coral | Request is saved; **Reload**; details show the load error |
| Not the Docs file | JSON without the class groups the parser needs | game-data step, coral | Shows the install path; **Choose another file**; previous game data stays loaded |
| Save before 1.0 | header older than v14 | save step, coral, "Refused" | Re-save it in the current game; **Choose another save** |
| Damaged save | decompression or object read fails | save step, coral | Maybe still copying or cut off; try again or the autosave; **Choose another save**, **Copy details** |
| Newer or unknown save version | version ≠ 60 but parses | save step and Setup, amber | Loaded with a warning; check Game Mode values; "Continue anyway"; unknown setting values get an "Unknown value" badge and are treated as default |
| No storage | IndexedDB unavailable (often a private window) | pinned banner on every screen, amber | Plans won't be kept; **Export all plans** |
| Storage not persistent | persistent storage refused | Plans header line, amber | Browser may clear plans when space is low; **Export all** |
| Nothing to solve | no targets and no maximize items | Solve disabled with a hint beside it; Targets empty state | "Add a target or an item to maximize" |
| Whole buildings not proven best | integer pass hit its 5 s limit | results, amber | Every target and limit is met; a better plan may exist; **Set Whole buildings to Off** |
| Budget ignored | budget > 0 but overclocking or boosting isn't unlocked | budget row note, plus Assumptions | Says which unlock is missing |
| Plan uses more than you hold | budget above held and used | stat strip, amber sub-line | "N more than the X you hold"; the Buildings tab marks which boosted buildings exceed it |
| Stored plan can't be opened | `loadPlan` returns reasons | Plans row, "Can't open" badge | Lists the field-level reasons; **Export as file**, **Delete**; never dropped silently |
| Items missing after a game update | `unknownItems` not empty | top of the plan, amber | Lists ClassNames and where they were used; **Remove them from the plan** or **Load other game data**; Solve skips them |
| No plans yet | empty store | Plans screen | What a plan holds; **New plan**, **Import…** |
| Nothing solved yet | new plan, no result | results pane | What the results will show; "Add a target, then Solve" |
| Search finds nothing | "Find in graph" query matches no box | search dropdown | "Not in this plan." |

### Data each screen reads

| UI | Source |
|---|---|
| First-run steps | `readDocsFile` / `parseGameData` progress and errors; `summarizeSaveBytes` header check, decompress and object stages |
| Save / game-data chips, Setup cards | `SaveSummary` header fields, `GameData.contentHash`, detected encoding |
| Game Mode rows and badges | summary settings with `source` |
| Node counts, assumptions | `resolveNodes` (+ `assumptions` line) |
| Budget "held" | items stored + slotted (Somersloops, shards); slugs with shard yield |
| Picker items | items reachable with this save's unlocks (`reachability`) |
| Stat strip, tabs | `PlanResult` (placed buildings, flows, budgets, raw use, power, explanation, assumptions, warnings, binding limits) |
| Flow graph boxes, modules, edges | `PlanResult` placed buildings (grouped by recipe and variant) + item flows; module map from item → module table |
| Short-of-target sections | `diagnose`: unreachable reasons, binding limits, elastic increases with tier |
| Freshness badges | `checkFreshness` reasons |
| Recipes | `GameData` recipes, the save's unlocked recipes, `request.disabledRecipes` |
| Import report | `PlanStore` import results |
| Can't-open and missing-item states | `loadPlan` reasons, `unknownItems(plan, gameData)` |
| Storage banners | `createBrowserPlatform()` fallback warning, `PlanStore.init()` persistence result |

Display names always come from the loaded locale's labels. Everything is keyed by ClassName.

The first-run progress bar needs the parser to report stages (a callback or async generator).
Today `summarizeSaveBytes` is a single call, so this is a small parser change; run it in a worker
so large saves don't freeze the page.

### Mockup data caveats

- **From the fixture tests:**
  - Obsidian Gears (10 Reinforced Iron Plate + 5 Modular Frame): 35 buildings, 240 ore, Mk.2 belt. The clocks and about 189 MW are derived from that.
  - Max Milestone Multiplier (600 ore cap + 20 Somersloops → 106.67 Rotor/min). The fix of 29 Somersloops and an 844/min cap is derived from that.
- **Real node counts:** iron 127, copper 55, limestone 94, uranium 5.
- **Placeholders:**
  - Held counts (37 Somersloops, 52 shards), Setup progress numbers and alternate counts.
  - Other resources' node counts, all node positions, recipe rates on the Recipes board (written from memory, not Docs.json), and plan names in the Plans list.
  - In the error states: save version 61, build 528104, header version 13, the localhost port, the chunk and byte numbers, and the sample ClassNames.
  - The whole "Phase 3 parts" plan on the large-graph board (rates, building counts, clocks, MW). It's shaped to look realistic and to exercise the layout, not solved.

### Open questions and next steps

- Item icons: extract from the user's install (licensing as with Docs.json) or keep abbreviation tiles.
- Resource wells, geysers and Nitrogen Gas on the Nodes map: colours and how satellites group under their core.
- Graph:
  - Check ELK's compound-node layout against the mockup's look on a real 100+ recipe result from the solver.
  - Decide whether modules remember their expanded state per plan.
  - Print/export of the graph (PNG or SVG) for sharing.
- Light theme: not designed yet; the tokens above are meant to get light variants.
- Parser stage reporting for the first-run progress bar (see above).
- Desktop app: auto-detect failure states (no install found, several Steam/Epic installs, no saves yet) aren't drawn.

## UI implementation

How the real UI in `app/` is built and what's done, on top of the parser, solver and plan store in
`src/`. The design it follows is in [UI design](#ui-design).

### Stack

- React 18 + TypeScript + Vite 8, Vitest 5 (Node 22.12+). `vite.config.ts` points Vite at `app/`; `vitest.config.ts` keeps tests at the repo root. `npm audit`: 0 vulnerabilities.
- Bundled locally: fonts (`@fontsource` Barlow, Barlow Condensed, JetBrains Mono), the HiGHS WASM, and ELK (`elkjs` 0.10). The built app makes no network requests.
- Scripts: `npm run dev`, `npm run build:app` (typecheck + build into `dist-app/`), `npm run preview` (serves on port 4173).

### Architecture

- **Engine worker** (`app/engine/engine.worker.ts`): holds `GameData`, labels, the active `SaveSummary` and its `PlanningProblem`. It loads Docs and saves (posting progress stages), solves with HiGHS, and returns a `ProblemInfo`, which carries:
  - picker items with reachability, holdings, unlocks, best belt/pipe;
  - node counts, map capacity and capacity per normal-node equivalent;
  - every map node with its position, resource and purity;
  - every production recipe with its status (runnable / building-locked / not unlocked) and per-building rates;
  - assumptions.
- **Protocol** (`app/engine/protocol.ts`): typed requests (`loadDocs`, `loadSave`, `useSummary`, `solve`) and error kinds (`not-docs`, `unsupported-version`, `corrupt`, `needs-game-data`, `solver`). An engine crash shows as "The planner engine couldn't start", never as a wrong-file error.
- **Graph layout** (`app/graph/layout.ts`): ELK layered layout (left to right, orthogonal edges, raw resources pinned to the first layer, deliveries and surplus to the last) in **its own** worker via `elk-api` + `elk-worker.min.js`. ELK's bundled build can't run inside the engine worker: it takes over that worker's message handler.
- **UI state** (`app/state.tsx`): the browser platform and `PlanStore` run on the UI thread. The engine's loaded save always follows the active plan's save summary. Plan actions: open, new, rename, duplicate, delete (opens the next plan), export, import.
- **Persistence:**
  - The Docs bytes are stored under `app:docs` and re-parsed on start.
  - The active summary key is stored under `app:activeSummary`.
  - Plans and summaries go through `PlanStore`.
  - Request edits save after 400 ms.
- **Loading a save:**
  - Same `saveIdentifier` as the active plan: the plan is rebased onto the new summary, and its old result is flagged stale.
  - Otherwise: a new plan, "Plan N", is created.
- **Routes:** `#/plan`, `#/nodes`, `#/recipes` (reached from the plan's Sources panel), `#/plans`, `#/setup`. Routes match the whole path segment, so `#/plans` isn't read as `#/plan`.

### Flow graph (`app/graph/`)

- **`model.ts`** builds the graph from a `PlanResult`:
  - Boxes: one per extraction resource, per recipe variant, per used manual supply, per delivery, plus one Surplus box for items that pass `hasSurplus` (at least 0.01/min and 0.01% of throughput; shared with `explain`).
  - Edges: each item's production is split across its consumers in proportion. Every recipe receives exactly what it consumes; the unit tests check this.
  - Byproduct outputs (a recipe's second and later products) are marked as byproducts.
- **Modules:** a fixed item → family table (iron, steel & concrete, copper, caterium, quartz, oil & fuel, aluminum, electronics, motors & frames, coal & sulfur, nuclear, quantum & SAM). Families with 2+ recipes in the plan become modules.
  - Default: collapsed when the plan has more than 14 recipe boxes, otherwise expanded.
  - Edges between collapsed modules are merged per pair.
- **`FlowGraph.tsx`:**
  - Each layout is kept together with the graph it was computed for, so changing the detail level never draws new boxes against old coordinates.
  - Loops are edges that run leftward after layout (dashed teal, "↺"). Byproducts are dotted. Raw items keep their resource colour, and deliveries are blue.
  - Focus lights the upstream and downstream chain. The drawer has in/out lists that jump between boxes, plus module contents.
  - The canvas is a camera (translate + scale), not a scroll box, so panning has no bounds. Drag pans (pointer capture after 4px; the click after a drag is swallowed). A native non-passive wheel listener zooms around the cursor, 20–200%.
  - Search expands a collapsed module and centres on the match. Fit centres the whole graph; the first layout fits it, between 40% and 100%. There's a clickable minimap.
  - Rates below 0.005/min show as "<0.01".

### Nodes, Recipes, Plans

- **Nodes:**
  - The map is an SVG of the save's node positions, north up. Colour shows the resource. Purity is size and fill: pure is large, normal small, impure a ring. Well satellites are diamonds. An excluded node gets a × over a faded dot.
  - Click a node, or right-drag a box (it selects only the focused resource), then Exclude / Include / Clear. A left drag pans (the map is a translated camera, not a scroll box); a press that moves less than 4 px is still a click, so nodes toggle and a click on empty map clears the selection.
  - Resource chips; a focused panel with purity counts, excluded counts, a cap input, and map capacity before and after exclusions; an all-resources list; an excluded list with Include; Include all; zoom 25–400% (buttons in 25% steps around the view centre, the wheel around the cursor via a native non-passive listener), and Reset.
  - Writes `excludedNodes` and `rawCaps`.
- **Recipes:**
  - Scope: "This plan's items" (targets, maximize, items in the last result) or "All items". Filters: All / In this result / Alternates / Turned off / Not unlocked, plus search.
  - Grouped by main product. Each row shows a Standard/Alternate tag, Not unlocked, and "In this result", plus per-building rates at 100% and the building-locked reason.
  - A switch writes `disabledRecipes`. Allow all resets.
- **Plans:**
  - Table with select boxes, request line, save and build, and a freshness badge with its reason (Fresh, Short of target, Request/Game data/Save/Solver changed, Not solved, Can't open plus field reasons).
  - Actions: Open, Duplicate, Rename inline, Export, Delete with inline confirm. Header: Export all/selected, Import…, New plan. Empty state.
  - Import report panel. The storage line reflects persistent/no storage.

### Parser and solver changes for the UI

- `summarizeSaveBytes(bytes, gameData, { onStage })` reports `header → decompress → objects (0..1) → summary`.
- `SaveFormatError.code` is `'unsupported-version'` or `'corrupt'`.
- **Solver fix:** below 1e-4 building-equivalents, a recipe line is residue (the integer pass left 2e-5 of an Assembler). It's no longer placed or listed, but its flows stay in the balances. A regression test covers it.
- Tests: 99 pass (7 skipped for fixtures not present), including the graph-model tests in `test/graph-model.test.ts`.

### Verified (headless Chromium, real files)

- First run, errors, Setup, solve, reload restore and stale state, as before.
- **Flow graph:**
  - Obsidian Gears: 9 boxes, 13 edges.
  - All Pure Nodes with Motor 20, Encased Industrial Beam 10, Versatile Framework 5, Automated Wiring 5, Modular Frame 10, 10 Somersloops and 30 shards: solved in about 1.9 s, all met, 66 buildings, 1.02 GW. That's 15 boxes as modules and 31 with all recipes.
  - Focus, and search inside a collapsed module, work with no console errors.
- **Nodes:**
  - Box-selecting the whole map for Iron Ore excludes all 127; Include all restores them; a single click excludes one.
  - A 120/min iron cap leaves Obsidian Gears 1 of 2 targets short.
- **Recipes:**
  - On Obsidian Gears (no alternates), turning off Screws makes both targets unreachable, with the reason given.
  - On All Pure Nodes, turning off the used Iron Alloy Ingot alternate makes the solver drop it and still meet the target.
- **Plans:** duplicate, rename, export (2 plans + 1 summary), delete, re-import (one added, one skipped as unchanged).
- **Phone width:** graph, Nodes, Recipes and Plans have no horizontal page overflow.

### Next

1. Desktop (Tauri) backend and auto-detect states.
2. Keyboard path for excluding single nodes (the map is pointer-only; the lists cover include, caps and focus).
3. Remembering per plan which graph modules are expanded; graph export (PNG/SVG).

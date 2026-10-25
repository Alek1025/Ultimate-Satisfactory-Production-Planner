# Satisfactory Planner — parsing core, solver and plans

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
  solver/                 Lexicographic LP / integer planner on HiGHS (see SOLVER.md)
  plans/                  Versioned plans, storage, export/import (see PLANS.md)
  platform/memory.ts      In-memory KeyValueStore
  platform/browser/       IndexedDB store + file picker/download (the only DOM code)
```

## Usage

```ts
import { readDocsFile, parseGameData, parseLabels, summarizeSaveBytes, resolveNodes } from './src';

const groups = readDocsFile(docsBytes);             // any locale file; encoding auto-detected
const gameData = parseGameData(groups);             // identical for every language (contentHash)
const labels = parseLabels(groups, 'en-US');        // display names only
const summary = summarizeSaveBytes(saveBytes, gameData);
const nodes = resolveNodes(summary, gameData, catalog /* optional */);
```

`npm test` runs the parser and solver tests against the project saves and the en-US / da / he game data
(tests for fixtures that aren't present are skipped). The solver is documented in [SOLVER.md](SOLVER.md), plans and storage in [PLANS.md](PLANS.md).
`npm run summary -- fixtures/en-US.json fixtures/<save>.sav` prints a readable summary.

## Where things live in a 1.2 save

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

## Assumptions the code makes (surfaced to the user)

- **Version:** save version 60 is treated as Update 1.2 (seen in builds 495413 `rel-main-1.2.0` and
  513885 `rel-main-anniversary-2026`). Other versions load with a warning; pre-1.0 headers are rejected.
- **Not in Docs.json:** node purity multipliers (0.5 / 1 / 2), 3 power-shard slots per building, and
  1 Somersloop slot for buildings that don't override slot size (Constructor, Smelter). These are
  engine constants exposed in `GameData.constants`, each with a note.
- **Belt speed:** Docs `mSpeed` is twice items/min (Mk1 120 → 60/min). Pipes: `mFlowLimit` × 60.
- **Fluids:** Docs amounts are litres; converted to m³ (÷1000).
- **Somersloop / shard budgets:** "available" = items stored anywhere + items slotted in buildings,
  since plans start from scratch. Power slugs are reported with their shard yield from Docs recipes.

## Node data: what each Game Mode writes

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

## Bundled node catalog (`src/gamedata/data/node-catalog-1.2.json`)

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
  project (AGPL code, which we do not use). Fine for a personal local tool; if the planner is ever
  distributed publicly, consider generating the catalog from the user's install at setup time instead.

## The app (UI)

React + TypeScript + Vite in `app/`. Parsing and solving run in a Web Worker
(`app/engine/engine.worker.ts`), so large saves and solves never freeze the page. Fonts and
the HiGHS WASM are bundled: the built app makes no network requests.

Needs Node 22.12 or newer (Vite 8 and Vitest 5).

```
npm install
npm run dev          # http://localhost:4173, hot reload
npm run build:app    # typecheck + production build into dist-app/
npm run preview      # serve dist-app/ at http://localhost:4173
```

Open it through the server, not as a file (`file://` blocks WASM and IndexedDB; the app says so).
First run asks for `en-US.json` (any locale's Docs file) from
`Satisfactory/CommunityResources/Docs/`, then a `.sav`. Both are remembered in IndexedDB,
along with plans, so a reload picks up where you left off.

```
app/
  engine/      protocol.ts, engine.worker.ts (GameData, summary, problem, HiGHS), client.ts
  graph/       model.ts (PlanResult -> boxes, item edges, modules), layout.ts (ELK in its own
               worker), FlowGraph.tsx (focus, drawer, search, zoom, minimap)
  state.tsx    platform + PlanStore on the UI thread; the engine follows the active plan's save
  screens/     Loaders (first run), Setup, Plan (request editor), Results, Picker,
               Nodes (map, exclusions, caps), Recipes (turn recipes off), Plans (list, export/import)
  ui/          kit.tsx (icons, messages, formatting), resources.ts (resource colours)
  styles.css   design tokens (see ui-design.md in the project)
```

Screens: first run, Setup, Plan workspace (request editor + results with Flow graph, Buildings,
Why this plan, Item flows, Raw resources, Assumptions, and short-of-target fixes), Nodes, Recipes
and Plans. Not yet: the Tauri desktop backend and its auto-detect states.

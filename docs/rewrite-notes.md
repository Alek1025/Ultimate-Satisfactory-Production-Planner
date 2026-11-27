# Rewrite notes: discoveries from the first version

Hard-won findings from the first version of the Ultimate Satisfactory Production Planner
(Update 1.2), kept for a rewrite from scratch. Merged from two independent reviews of the
codebase at commit `d78c58b` (Claude Opus 5.5 and GPT-6.2 Sol). Items marked *(Claude)* were
found only in the Claude pass. Paths refer to the old codebase, which now lives in `archive/v1/` (so `src/plans/store.ts` is `archive/v1/src/plans/store.ts`).

## 1. Save file format (Update 1.2)

- **Three separate versions:** header **14**, save version **60**, engine **UE 5.6.1**. Verified on
  builds 495413 (`rel-main-1.2.0`) and 513885 (`rel-main-anniversary-2026`). Refuse headers below 14
  and save versions below 53; load other versions with a warning.
  - What the refusals mean in practice (checked on 202 real saves in M0): Update 1.0 and earlier
    saves are header **13**, and Update 1.1 saves are header 14 with save version **52**. Check the
    save version straight after the first three ints, so an old file is reported as an unsupported
    version rather than as corrupt.
- **Header ending:** `saveIdentifier`, a partition flag (i32), a 20-byte `saveDataHash`, then a
  creative-mode flag (i32). The timestamp is .NET ticks: `(ticks − 621355968000000000) / 10000`,
  using BigInt.
- **Body:** a series of zlib chunks. Each starts with tag `0x9e2a83c1`, then an archive version and
  an int64 max chunk size. Version `0x22222222` adds a compressor byte (3 = zlib); version 0 has none.
  Then come two (compressed, uncompressed) int64 pairs and the payload. Check each chunk's inflated
  size. After inflating, the body's first int64 is its length, not counting those 8 bytes.
- **FString:** an i32 length that includes the NUL. 0 = empty, positive = narrow bytes (latin1),
  negative = UTF-16LE with abs(n) code units. Reject int64 sizes outside JS's safe integer range.
- **Levels:** after the world-partition validation grids comes the level count, which leaves out the
  persistent level. That level comes last and takes the header's map name. Each level has its own
  TOC and data blob, each with an int64 length, and their object counts must match.
  - Streamed levels carry their own name, a TOC version (save version ≥ 51), collectables and
    optional version data. The persistent level carries the destroyed-actors map **and then one
    more ref list** (v1 never read it; Obsidian Gears has 13 Mercer Shrine refs there). Nothing may
    follow it.
  - Some versions store collectables or destroyed actors inside the TOC blob instead.
  - *(M0)* Third-party save editors (files named `*_CALCULATOR.sav`) write the persistent level
    like a streamed one: it ends with an i32 TOC version (60), the destroyed-actors map moves into
    the TOC blob, and the count of its last (empty) ref list is left out. They also write known
    native structs such as `LinearColor` without the native flag 0x08.
- **Format switches by version:** save versions **41** (doubles for property vectors and quats), **49**
  (object flags in the TOC), **51** (TOC version per level) and **53** (version data per object).
  Full-type-name property tags need UE5 object version **≥ 1012** and object save version ≥ 53. TOC
  transforms are still float32.
- **TOC entries:** type 1 = entity (rotation quat, translation, scale, placed-in-level flag), type 0
  = component (owning entity's instance name). An entity payload starts with a parent ref and
  component refs, then (with full-type-name tags) a serialization control byte, the property list,
  an optional object GUID and class-specific trailing bytes.
- **Property tags:** the name, then a recursive type tree, a size and a flags byte. A `None` name ends
  the list. Flag bits: array index 0x01, GUID 0x02, extensions 0x04, native/binary 0x08, bool true
  0x10.
  - A top-level bool lives in the flags; inside a container it takes a byte.
  - Enum-backed bytes are FStrings. For byte arrays, `size − 4 === count` tells raw bytes from enum
    strings.
  - Sets and maps write removed entries first.
  - Struct elements in containers have no size, so you need a list of native structs (Vector, Quat,
    Guid, InventoryItem, FluidBox, …) to decode them.
  - Refs are two FStrings (level, path); soft refs add a sub-path. FText starts with u32 flags and an
    i8 history type (−1, 0, 1–3, 10, 11).
- **Robustness rule that worked:** every property and object declares its size. Anything that can't
  be decoded is kept as raw bytes, and reading resumes at the next tag or object. The tests demand
  zero failed objects; raw `UniqueNetIdRepl` is allowed.
  - *(M0)* Each object also keeps its whole data-blob entry as bytes. Concatenating a level's
    entries after its object count reproduces the level's data blob exactly, which is how the
    tests prove unknown classes are kept byte-for-byte.

## 2. Where planner data lives in a save

| Data | Object.property |
|---|---|
| Cost multipliers | `BP_GameState_C.mPartsCostMultiplier`, `.mSpacePartsCostMultiplier` |
| Node purity mode / seed | `BP_GameState_C.mNodePuritySettings` (`NPS_AllPure`, …), `.mNodeRandomizationSeed` |
| Node randomization | `BP_GameState_C.mNodeRandomization` (`ENodeRandomizationMode::NRM_Strict`, `NRM_AdvancedRich`) |
| Per-node resource | `BP_ResourceNode_C` / `BP_FrackingSatellite_C` / `BP_FrackingCore_C` `.mResourceClassOverride` |
| Per-node purity | `BP_ResourceNode_C` / `BP_FrackingSatellite_C` `.mPurityOverride` (`RP_Pure`, `RP_Normal`, `RP_Inpure`) |
| Milestones, MAM, alternates, shop | `BP_SchematicManager_C.mPurchasedSchematics`, classified by Docs `mType` |
| Unlocked recipes | `FGRecipeManager.mAvailableRecipes` |
| Space Elevator phase | `BP_GamePhaseManager_C.mCurrentGamePhase`, `.mTargetGamePhase`, `.mTargetGamePhasePaidOffCosts` |
| Overclock / Somersloop unlocked | `BP_UnlockSubsystem_C.mIsBuildingOverclockUnlocked`, `.mIsBuildingProductionBoostUnlocked` |
| Items held | every `FGInventoryComponent.mInventoryStacks` + `FGCentralStorageSubsystem.mStoredItems` (Dimensional Depot) |

- **Absent means default.** Unreal leaves out properties at their default value. Show the user
  whether each setting came from the save or is the default.
- **Unlock flags:** `BP_UnlockSubsystem_C` is authoritative and overrides what the schematics imply.
- **Phase:** phase IDs look like `GP_Project_Assembly_Phase_1`. A missing current phase means phase 0.
- **Holdings:**
  - A component whose instance name ends in `InventoryPotential` on a `Build_*` owner holds slotted
    shards or Somersloops. Stacks are `Item` + `NumItems`; the depot uses `ItemClass` + `Amount`.
  - Power Slugs are `Desc_Crystal_C`, `Desc_Crystal_mk2_C` and `Desc_Crystal_mk3_C`. Take their shard
    yield from single-in, single-out Docs recipes; don't hard-code it.
  - Fixture numbers: All Pure Nodes has 5,306 shards (112 slotted). Max Milestone Multiplier has 50/12/11
    slugs, worth 129 shards, and holds 0 shards.
- **Nodes:**
  - Node classes are listed in the table above, plus `BP_ResourceNodeGeyser_C`.
  - Take the position from the TOC translation (cm), and the stable id from the part of the instance
    name after the last dot (e.g. `BP_ResourceNode620`).
  - Node ids and positions are identical across all six fixture saves.
- **The save only stores what a Game Mode setting changes:**

  | Save | Randomization | Purity | Resources stored | Purities stored |
  |---|---|---|---|---|
  | default | off | default | none | none |
  | all-pure-nodes | off | `NPS_AllPure` | none | all 577 extractable |
  | random-nodes | `NRM_Strict` | default | all 594 | well satellites only (118) |
  | resource-rich-random-purity | `NRM_AdvancedRich` | `NPS_AllRandom` | all 594 | all 577 |

- **Scarcity must come from the save:** Strict keeps the base map's per-resource counts (127 iron,
  55 copper, 94 limestone, 5 uranium) and only moves them around. Advanced Rich changes the mix
  (40 uranium, 56 quartz, 61 iron).
- **The save lacks each node's default resource and purity and the well-core links.** This is a real
  dependency. Source: `game_data/generated/world/resourcePurity.json` from valentinps/satisfactorymap
  release `game-data-v3` (an FModel export of the 1.2 level data; `game_data.zip` sha256
  `686bac80b43c57044048b9fb95be2d0347d2eb2556cb2564e0c9fed3442fe1d0`). It has 459 resource nodes, 118
  satellites, 31 geysers and 17 well cores.
  - Even a fully self-describing save still needs the catalog's `wellCore` links to model wells.
  - Validation that worked: ids match all six saves; positions agree within 0.01 cm; purity counts
    equal the wiki table; and 43/43 existing miners and oil pumps produce the catalog's resource
    (follow `mExtractableResource` to the node, then read `<instance>.OutputInventory`).
  - *(Claude)* Pulling this from the user's install instead would need UE5 IoStore plus Oodle.
- *(Claude)* Warn on `header.isModded`. Flag GameState properties that look like settings (names
  matching Multiplier, Purity, Seed, Random…) but aren't interpreted, so new Game Mode options don't
  go unnoticed.

## 3. Docs file

- **Encoding:** `en-US.json`, `da.json` and `he.json` are UTF-16LE with a BOM. Decode the bytes before
  JSON.parse. Also accept UTF-8 and UTF-16BE. Without a BOM, look for NULs in every other byte in
  the first 4 KB. The top level is `[{NativeClass, Classes}]`.
- **Values inside are Unreal ExportText.** You need a small parser for nested `(...)`, `key=value`
  structs, quoted object paths and bare enums like `(RF_LIQUID,RF_GAS)`. Numbers and booleans are
  strings (`"True"`). A missing `FItemAmount.Amount` means **1**.
- **ClassName is the join key.** Normalise `/Script/Engine.BlueprintGeneratedClass'/Game/.../Desc_X.Desc_X_C'`
  to `Desc_X_C`. All locales give an identical model (same hash), so names and descriptions can be a
  separate per-locale overlay.
- **Telling which buildables are unlocked:** Build Gun recipes (`mProducedIn` contains BuildGun) have
  `Desc_*` products. Match them to `Build_*` **ignoring case** (`Desc_PipelinePumpMk2_C` vs
  `Build_PipelinePumpMK2_C`). A recipe can be unlocked before its machine, so require both.
- **Recipes:** `mProducedIn` tells machine recipes from hand-craft and build-gun/customizer ones.
  Alternates are the recipes unlocked by `EST_Alternate` schematics. The duration field is spelled
  **`mManufactoringDuration`**. Rate per minute = amount × 60 × `mManufacturingSpeed` / duration.
- **Units:**
  - `RF_LIQUID` and `RF_GAS` amounts are litres: ÷1000 to get m³.
  - Belt and lift `mSpeed` ÷2 (Mk1 120 → 60/min). Belts: 60/120/270/480/780/1200 per minute.
  - Pipe `mFlowLimit` ×60. Pipes: 300/600 m³/min.
- **Extractors:** rate = `mItemsPerCycle × 60 / mExtractCycleTime` (with fluid scaling). Normal-node
  Mk1/2/3 miners give 60/120/240; oil and water extractors 120 m³/min; a normal well satellite 60.
  Check both `mAllowedResourceForms` and `mAllowedResources`.
- **Not in Docs, or misleading:**
  - Purity multipliers 0.5 / 1 / 2.
  - 3 Power Shard slots (Docs reports `mPotentialShardSlots=0` for every building).
  - 1 Somersloop slot for buildings without `mOverrideProductionShardSlotSize` (Constructor, Smelter).
  - Find the shard and Somersloop items with `FGPowerShardDescriptor.mPowerShardType`
    (`PST_Overclock`, `PST_ProductionBoost`); read `mExtraPotential` and `mExtraProductionBoost`.
- **Somersloops:** the Manufacturer has 4 slots at +25% each, the Packager has 0, and a full set
  doubles all outputs. Inputs depend on clock only.
- **Power:** `clock^mPowerConsumptionExponent × boost^mProductionBoostPowerConsumptionExponent`
  (1.321929 and 2 in this data). Variable-power buildings (Particle Accelerator, Converter, Quantum
  Encoder) use `mVariablePowerConsumptionConstant + mVariablePowerConsumptionFactor / 2`.
- *(Claude)* When choosing the best belt, prefer the normal variant over the `NoIndicator` copies at
  equal speed.

## 4. Solver lessons

- **Balance rows:** `produced + extracted + manual − consumed − delivered ≥ 0`, so byproducts and
  surplus are allowed. Use `delivered + shortfall ≥ target`, with shortfall normalised by the target,
  so a partial answer always exists.
- **Run a reachability pre-pass first.** Forward closure from usable extractors and manual inputs,
  then backward from targets. It gives the plain-language "why not" and keeps the LP small.
- **Clock variants:** a discrete set, not a continuous clock. Each shard adds 50 points, so the
  clocks are 100/150/200/250%. A clock between steps needs the next step's shards and is never better.
  Each variant is lowered until no port exceeds the best unlocked belt or pipe.
  - Regression: in Obsidian Gears, pure Mk.1 miners already fill the Mk.2 belt (120/min), so 10
    shards go to normal nodes, giving exactly 6,340 Iron Plate/min.
  - Regression: in Max Milestone Multiplier, a 600 ore/min cap plus 20 Somersloops gives 106.67
    Rotor/min with every Somersloop on Smelters. This catches strategies that boost only the final
    recipe.
- **Wells:** one pressurizer clock is shared across the satellites. Sum the satellites' rates, cap
  the clock by the fastest satellite's own pipe, and charge 1 pressurizer plus 1 extractor per
  satellite.
- **Objective order (default, reorderable):** unmet targets → each maximize item in order →
  scarcity-weighted raw use (Σ rate / map-wide capacity) → MW → buildings → a hidden tie-break
  (fewest Somersloops and shards).
- **Lexicographic pinning needs numeric care:**
  - A min of zero over non-negative columns is pinned exactly (bounds set to 0).
  - Other levels get a pin with tolerance `1e-9 × max(1, |value|)`, loosened once to `1e-6 × …` if
    the next level turns infeasible.
- **HiGHS rejects duplicate column indices in a row**, so merge them before passing the matrix.
- **Keep limits as rows, not column bounds**, or you lose the duals that explain which limits are
  binding (shadow price > 1e-9). Integer solves have no duals, so carry them over from the LP.
- **Integer pass:** only boosted buildings and extractors get whole counts; plain buildings stay
  fractional and are rounded up, which can't break a limit. In `auto` it runs only when rounding up
  would break a budget or node limit. It is restricted to the LP's recipe and boost choices (plus
  plain fallbacks), with 5 s per level and a 1e-4 relative gap.
- **Diagnosis:** an elastic LP over limits, with reachable targets made hard. Weights: budget up to
  what's held (0.001/max(held,1)) < user caps (0.01/max(cap,1)) < budget beyond what's held (0.1) <
  more nodes than the map has (100).
- **Report power at real clocks**, separately from the linear MW objective.
- **Display cut-offs:** keep these separate from solver tolerances. Hide recipe placements below
  1e-4 building-equivalents (a "2e-5 Assembler" showed up after the integer pass), but keep their
  flows. Surplus counts only at ≥ 0.01/min and ≥ 0.01% of throughput.
- **Scarcity weight** = 1 / map-wide capacity in this save (all nodes at their purity, best extractor
  in the game data at 100%, ignoring exclusions). Water from Water Extractors has weight 0.
- **Product rules, not game rules** (decide again on purpose):
  - Overclocking only on Somerslooped buildings.
  - Water Extractors unlimited, at base clock only.
  - Budgets above holdings allowed with a warning.
  - Budgets ignored when the feature isn't unlocked.

## 5. Plans and versioning

- **Session versus snapshot:** `saveIdentifier` identifies the session across saves; a content hash
  identifies one summary. When a newer save of the same session loads, rebase the plan and keep the
  old result flagged stale.
- **Freshness depends on:** request + solve options, the Docs model hash, the summary key or save
  build, and the solver version.
- **Export bundle:** plans plus their summaries (the result is an optional cache), so a plan can be
  solved again without the `.sav`.
- **Treat imports and stored data as untrusted.** Validate every field, re-key summaries by content,
  and refuse newer schema versions. Merge rules: same plan unchanged → skip; newer → replace; local
  copy edited → add as "(imported)".

## 6. Architecture and browser gotchas

- **HiGHS:** run it in a Web Worker and pass `locateFile: () => wasmUrl` with the bundled WASM. Add
  `highs` to Vite's `optimizeDeps.include`, or the dev server reloads the page once when the worker
  starts.
- **Progress stages:** report `header → decompress → objects → summary`. Report an engine crash as
  its own error, not as "wrong file".
- **ELK needs its own classic worker** (`elk-api` + `elk-worker.min.js`). Inside another worker it
  takes over that worker's message handler. The settings that worked: layered, RIGHT, orthogonal
  edges, raw resources pinned to the FIRST layer and deliveries/surplus to LAST, 120 px between layers
  (to fit the rate labels).
- **Keep each layout with the graph it was computed for**, so expanding or collapsing never draws
  new boxes against old coordinates.
- **Wheel zoom needs a native non-passive listener**, because React's is passive and can't stop the
  page from scrolling.
- **Drag versus click:** start a drag only after 4 px, and swallow the click that follows a drag.
  Use a camera (translate + scale), not a scroll box, so panning has no bounds.
- **Readouts:** write the cursor readout straight to the DOM instead of re-rendering React.
- **Clip paths:** an SVG clip over tens of thousands of points makes panning slow. Clip offline in
  the generator instead.
- **`file://` doesn't work:** IndexedDB and WASM need a real origin.
- **Storage:** IndexedDB can open while `navigator.storage.persist()` is refused, or fail entirely
  (private windows, blocked by another tab). Fall back to memory and offer export. Cancelling the
  save picker must not trigger the fallback download.
- **Flow graph:** edges come from splitting each item's supply across its consumers in proportion.
  Loops are edges that run leftward after layout. Collapse modules by default above 14 recipe boxes.

## 7. Map data

- **World square in cm:** X −324698.832 to 425301.832, Y −375000 to 375000, north up. Use the same
  frame for every source image. Save positions are in cm.
- **Best source:** the game's own four 4096 px map textures, stitched to 8192 px. The wiki's 5000 px
  map is a downscale of these (they register within 0.01%). Map Genie plus an in-game screenshot was
  a dead end.
- **Tracing:** water is "blue clearly beats red". Remove thin land of up to 16 m with water on two
  separate sides (arches and drawn cliff strokes). Recover 1–2 px channels as centre lines. Trace
  the black off-map area and the Grass Fields pit as void, and mask its white border and glow first.
  Result: 617 of the default save's 625 nodes fall inside land.
- **Sea glow:** 25 m cells, full colour within 400 m of land, fading out by 2.8 km measured through
  open water, and fading toward the void.
- **Height map** (2048 px HDR): values are unitless. Z (m) = 987.098 × value − 517.549, plus a small
  affine correction. Sea is about 0.505 and off-map is 0. The median error against nodes is 1.3 m
  (90% within 4.7 m; the misses are in caves). Blur 2.5 px before drawing 25 m contours, or the 1 m
  steps in the data make terraces.
- **Biomes:** the wiki map is **CC BY-NC-SA 4.0**. Classify pixels by nearest tint in Lab, with a 9 px
  vote. Western Beaches shares Dune Desert's tint and is split off as the western half.
- **Dropped:** a "Tiers" layer traced from the map's plateau outlines looked messy.

## 8. Bugs to fix, or design out, in the rewrite

- **Import re-keying makes a stale result look fresh.** `importBundle` rewrites both
  `save.summaryKey` and `lastResult.summaryKey` to the new key (`src/plans/store.ts:224`). So an
  edited summary passes the freshness check, even though the warning says it must be solved again.
- **A solve can be stamped with the wrong request.** `recordResult` re-reads the plan when the solve
  finishes (`src/plans/store.ts:129`). If the user edits during a solve and the 400 ms autosave lands
  first, the result is hashed against the new request. Capture the fingerprint when the solve is
  sent.
- **The content hash doesn't cover everything the solver uses.** It leaves out the engine constants
  and the node catalog, so fixing either won't mark results stale.
- **"Optimal" is only optimal for the restricted model** that was solved. Linear MW can rank plans
  differently from MW at real clocks. The suggested fixes aren't re-checked under the whole-building
  rules.
- *(Claude)* **Unused prework:** the Tauri and platform layer was built for a desktop app that never
  shipped. Add it when it's needed.
- *(Claude)* **Decisions were only recorded in DESIGN.md.** The whole app landed in one "First Draft"
  commit, so git history doesn't explain any decisions. Mockup numbers in DESIGN.md were partly made
  up and are marked as placeholders.

## 9. Things to carry over regardless

- **The six fixture saves** and their expected values (old `test/fixtures.ts`). Object, recipe and
  schematic counts and Game Mode values were cross-checked against
  `@etothepii/satisfactory-file-parser` 4.1.2.
  - en-US.json, da.json, he.json: Docs files from `CommunityResources/Docs/`.
  - all-pure-nodes.sav: "All Pure Nodes_181026-173220.sav"
  - obsidian-gears.sav: "Obsidian Gears xVx_K00L_S1Ds_KluB_xVx_211026-212731.sav"
  - max-milestone-multiplier.sav: "1.2 Max Milestone Multiplier _300626-110335.sav"
  - random-nodes.sav: "Test Random Nodes_241026-110520.sav"
  - default.sav: "1.2 Default_241026-111033.sav"
  - resource-rich-random-purity.sav: "1.2 advanced resource rich + random purity_241026-111251.sav"
- **Make missing fixtures obvious.** Without them, tests skip and a run still looks green.
- **Licensing:** game-derived data (node catalog, traced map, terrain and heights) is © Coffee Stain,
  included with attribution, outside the MIT license, and removed if they ask. The biome layer is CC
  BY-NC-SA. Map source images and Docs files are never committed. Coffee Stain item icons aren't used.
- **Design mockups:** the clickable mockups are at https://claude.ai/artifact/Fd6MzXkCAdT6GLc7aHhQGG.
- **Paths for users:** Docs are in `Satisfactory/CommunityResources/Docs/`. Saves on Windows are in
  `%LOCALAPPDATA%/FactoryGame/Saved/SaveGames/<id>/`.

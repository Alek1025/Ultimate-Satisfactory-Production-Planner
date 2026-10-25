# Satisfactory Planner — UI design

Design decisions for the planner's UI, from the design sessions on 24 Oct 2026. The clickable
mockups live on the design canvas "Satisfactory Planner UI"
(https://claude.ai/artifact/Fd6MzXkCAdT6GLc7aHhQGG). The plan workspace, short-of-target state,
Nodes, Recipes, phone, first-run and large-graph boards are interactive (press Play). This doc is
the reference for building the real UI on top of the parser, solver and plan store; it does not
replace them.

## Decisions at a glance

| Question | Decision |
|---|---|
| Visual direction | FICSIT industrial: dark UI, safety-orange accent, hazard-stripe top bar |
| Main layout | Split: request editor on the left, results on the right, request panel collapsible |
| Primary results view | Flow graph tab, shown by default; other views are tabs beside it, not separate pages |
| Graph at scale | Modules by default (related recipes collapsed into one box); expand any module; focus a box to fade everything outside its chain; search, minimap, zoom |
| Node exclusion | Schematic map from save positions (no game map image) plus a resource list |
| Node colour | Colour = resource; purity = size and fill; exclusion = × mark |
| Short of target | Results pane switches mode: blockers, then a one-click smallest fix |
| Phone | Same page, stacked; opens on results with the request panel collapsed |
| First run | Two steps, game data then save; the save step is locked until game data loads |
| Errors | Say what happened, whether anything was lost, and one next step; details behind a disclosure |

## Visual system

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

## App shell

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
  - Request panel: `flex: 1 1 320px; max-width: 380px`.
  - Results: `flex: 999 1 560px`.
  - Below about 900px they stack; wide tables and the graph scroll inside their own boxes.
- **Pinned banner slot** under the top bar for app-wide conditions (no storage). It's the only place a message shows on every screen.

## Screens

### 0. First run (nothing loaded)
- A headline ("Plan a factory from your save") and two sentences on why both files are needed and that they stay on this computer.
- **Step 1, Game data:** a drop zone that also works as a button. The hint names the install folder (`CommunityResources/Docs/`) and says any language's file works.
- **Step 2, Save:** locked until game data loads ("Load game data first — the save is read against it"), because `summarizeSaveBytes` needs `GameData`. The hint names the Windows save folder (`%LOCALAPPDATA%/FactoryGame/Saved/SaveGames/<id>/`).
- **Reading:** the file name, a stage label and a progress bar. Stages for game data: detecting encoding → reading recipes and items → building game data. Stages for the save: reading header → decompressing body → reading world objects → summarizing unlocks and nodes.
- **Loaded:** a summary card. Game data shows language, encoding and content hash; the save shows name, version and build. "Choose a different file" replaces it.
- **Footer:** "Nothing is uploaded"; the desktop app finds both files itself. "Continue to setup" becomes active when both are loaded, or reads "Continue anyway" when the save loaded with a warning.
- **Desktop app:** this screen only appears if auto-detection finds no install or no saves. It then shows the same steps with native file dialogs.

### 1. Setup
- Two loader cards: game data (any locale Docs file; shows detected encoding and content hash, plus a labels-language select) and save (name, file, saved time, save version, build).
- **Game Mode** table: one row per setting the solver reads (parts and space-parts cost, node purity, node resources, seed, overclocking, Somersloop boosting), each with a Save or Default badge. This comes straight from `source: 'save' | 'default'`. A value the planner doesn't recognise gets an "Unknown value" badge and is treated as the default, with an assumption line.
- **Progress**: Space Elevator phase, milestones, MAM nodes, alternates, best belt and pipe.
- **Collected**: Somersloops and shards as "held = stored + slotted", plus Power Slugs with their shard yield (not counted in budgets).
- **Resource nodes**: extractable count, how many purities and resource types the save stores versus the bundled catalog, and the `resolveNodes` assumption line in plain words.
- When plans point at an earlier summary of this save, a banner offers "Review N plans" (rebase). The primary action is "New plan from this save".

### 2. Plan workspace (request editor + results)

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

### 2a. Flow graph

Two boards show it: "Plan workspace" (a 9-box iron chain, hand-placed) and "Flow graph at scale". The second is a 25-recipe Phase-3-style plan with 8 raw resources, a Somersloop variant, a byproduct, a water loop and surplus, laid out by code in the mockup.

**What a box is:**
- One box per placed recipe *variant*: a boosted Smelter group and a plain Smelter group are two boxes, so where Somersloops and shards went stays visible. The boosted box gets an amber border and an amber clock line.
- Extraction boxes carry the resource colour dot, extractor count × type, purity and clock.
- Delivered boxes (blue) show delivered vs target. One **Surplus** box (amber) collects leftovers and byproducts nothing uses; later it becomes the AWESOME Sink hook.

**Layers and bands:**
- Top to bottom: raw resources in a top band, then recipes by longest-path depth, then delivered and surplus in a bottom band.
- Vertical layering fits beside the request panel, which a left-to-right layout didn't.

**Modules (level of detail):**
- Related recipes form a module: Iron line, Steel & concrete, Copper line, Electronics, Aluminum line.
- Default view is **Modules**. Each module is one stacked card: recipe count, buildings, MW, a "↺ N loop inside" note, and what it sends out. A recipe that is its own step (Plastic, Heavy Modular Frame) stays a plain box.
- Detail control: Modules / All recipes. A row of module chips expands or collapses each module on its own (a "custom" mix). The + on a module card expands it in place.
- Edges between collapsed modules are merged per pair. One item shows its rate; several show "N items", and the drawer lists them.
- **Grouping rule for the real app:** start from a fixed item → module map (iron, steel, copper, caterium, quartz, oil, aluminum, electronics, nuclear, …), then fold in any recipe whose output feeds only one module. Modules with one recipe aren't grouped. Users never configure this.

**Edges:**
- Orthogonal routing. All edges leaving a box share one trunk from its bottom centre and split on a lane in the gap below, so an item that feeds many recipes reads as one bus, not a fan of crossings.
- Inputs enter spread across the target's top edge. Edges that skip layers pass through reserved gaps, never across a box.
- Colour:
  - Raw items keep their resource colour.
  - Deliveries are blue.
  - Everything else is neutral grey.
- Style:
  - Byproducts are dotted.
  - **Loops back up the chain** (e.g. water from Aluminum Scrap back to Alumina Solution) are dashed teal. They run in a channel down the right edge, labelled "↺ Water 15".
- Labels are mono rates per minute, or "N lines" in Belt lines mode (best unlocked belt and pipe), on a small ground-coloured pill near the target.

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
- "Find in graph" search over item and recipe names and modules. Choosing a result inside a collapsed module expands it, selects the box and scrolls to it.
- Zoom − / % / + (30–150%, kept centred) and Fit.
- A minimap in the bottom-right shows every box (focused chain lit) and the viewport; clicking it moves the view.

**Implementation:**
- Use ELK `layered` in a worker, with orthogonal edge routing.
- Cluster modules as compound nodes so expand/collapse doesn't reshuffle unrelated boxes.
- Set loop edges as feedback edges and pin the raw and delivered bands to the first and last layers.
- Build the graph from `PlanResult`: placed buildings grouped by recipe and variant → boxes; item flows → edges; deliveries and surplus → sinks.
- The mockup's hand-rolled layering, barycenter ordering and lane routing show the intended look, not the production algorithm.

### 3. Short of target (same workspace, results in "diagnosis" mode)
- **Banner** (coral): what's short and by how much, what's unreachable, and a "See the fix" link. When the targets are met but an unreachable target remains, the banner turns amber ("Rotor met · Motor blocked"). When everything is met, it turns blue.
- **Target rows** in the request panel show a progress bar (delivered / target) and "106.7 · short 43.3".
- **"What's in the way"**: the binding limits at the targets level, each with usage ("600 / 600") and its kind (Your cap, Budget, Nodes). Once the target is met, the heading becomes "Limits at their maximum".
- **"Smallest change that reaches X"**: the elastic diagnosis as an ordered list. Each change shows from → to, a tier chip and its own Apply button.
  - Tier chips: "You hold these", "Your cap", "Beyond what you hold", "More than the map has".
  - Primary action: "Apply both and solve".
  - Secondary action: "Lower the target to {max reachable} instead", using the reachable maximum rounded down.
- **"Can't be made in this save"**: each unreachable item with its plain-language reason from `reachability`, plus a "Remove … target" button.
- **"Why this plan"**: explains where the boosts went and why.

### 4. Nodes
- **Resource chips** (All + one per resource, with swatch and count) choose which resource is in front. The others stay on the map at about 20% opacity.
- **Map:** schematic top view from save positions on a light grid, with no game map image.
  - Dot colour is the resource.
  - Size and fill are purity: pure is large and solid, normal is small and solid, impure is a ring.
  - An excluded node shows a white × over a faded dot.
  - A selected node gets a white ring.
- **Map interactions:**
  - Click a node to toggle exclusion.
  - Box or lasso select, then Exclude / Clear from a floating bar.
  - Pan tool.
  - Hover title shows resource, purity and state.
- **Side panel:**
  - The focused resource: nodes available of total, a purity table with excluded counts, a cap input, and map capacity before and after exclusions. It notes that the scarcity weight ignores exclusions.
  - All resources, each with a swatch, counts and its cap.
  - The excluded list, each with Include.
- **Page action:** "Include all".
- The map isn't keyboard-friendly; the resource list and excluded list are the accessible path. Every dot still has an accessible label.

### 5. Recipes (per plan)
- Recipes for the items in this plan's chain, grouped by product. Each row shows a kind badge (Standard / Alternate / Not unlocked), building, and in → out per building at 100%.
- An "In this result" tag marks the recipes the last result used.
- Unlocked recipes get an On/Off switch, which maps to `disabledRecipes`.
- An unlocked alternate that can't run says why, e.g. "Needs the Refinery, which this save hasn't unlocked", using the same reason source as reachability.
- Filters: All / Alternates / Turned off / Not unlocked, plus search. "Allow all" resets everything.
- Changes show "Recipe choices changed. Solve the plan again."

### 6. Plans
- **Table:** a select box, plan (name and request summary), save (name and build), result, and actions.
  - The result column is a badge plus one line from the freshness reason: Fresh, Short of target, Save changed, Game data changed, Request changed, Solver changed, or Not solved.
  - Actions: Open, or Solve again when stale; an overflow menu holds Duplicate / Rename / Export / Delete.
- **Header:** persistent-storage status, Import…, Export selected, New plan.
- **Import report** panel: one line per plan with the merge outcome (added, replaced with newer, added beside yours as "(imported)", skipped unchanged, not imported because it came from a newer planner). It ends with a note that summaries are re-checked and re-keyed.

### Phone width
- Same page at 390px. It opens on the results with the request panel collapsed.
- The stat strip goes to two columns, and tabs and toolbars wrap.
- The graph scrolls sideways in its box.
- If phone use matters, a Request / Results switch would beat stacking the two panels.

## Empty and error states

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

## Data each screen reads

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

## Mockup data caveats

- **From the fixture tests:**
  - Obsidian Gears (10 Reinforced Iron Plate + 5 Modular Frame): 35 buildings, 240 ore, Mk.2 belt. The clocks and about 189 MW are derived from that.
  - Max Milestone Multiplier (600 ore cap + 20 Somersloops → 106.67 Rotor/min). The fix of 29 Somersloops and an 844/min cap is derived from that.
- **Real node counts:** iron 127, copper 55, limestone 94, uranium 5.
- **Placeholders:**
  - Held counts (37 Somersloops, 52 shards), Setup progress numbers and alternate counts.
  - Other resources' node counts, all node positions, recipe rates on the Recipes board (written from memory, not Docs.json), and plan names in the Plans list.
  - In the error states: save version 61, build 528104, header version 13, the localhost port, the chunk and byte numbers, and the sample ClassNames.
  - The whole "Phase 3 parts" plan on the large-graph board (rates, building counts, clocks, MW). It's shaped to look realistic and to exercise the layout, not solved.

## Open questions and next steps

- Item icons: extract from the user's install (licensing as with Docs.json) or keep abbreviation tiles.
- Resource wells, geysers and Nitrogen Gas on the Nodes map: colours and how satellites group under their core.
- Graph:
  - Check ELK's compound-node layout against the mockup's look on a real 100+ recipe result from the solver.
  - Decide whether modules remember their expanded state per plan.
  - Print/export of the graph (PNG or SVG) for sharing.
- Light theme: not designed yet; the tokens above are meant to get light variants.
- Parser stage reporting for the first-run progress bar (see above).
- Desktop app: auto-detect failure states (no install found, several Steam/Epic installs, no saves yet) aren't drawn.

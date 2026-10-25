# Satisfactory Planner — UI build

How the real UI is built and what's done. The design is in `claude/ui-design.md`. The code ships in
`satisfactory-planner.zip` (`app/`), next to the parser, solver and plan store in `src/`.

## Stack

- React 18 + TypeScript + Vite 8, Vitest 5 (Node 22.12+). `vite.config.ts` points Vite at `app/`; `vitest.config.ts` keeps tests at the repo root. `npm audit`: 0 vulnerabilities.
- Bundled locally: fonts (`@fontsource` Barlow, Barlow Condensed, JetBrains Mono), the HiGHS WASM, and ELK (`elkjs` 0.10). The built app makes no network requests.
- Scripts: `npm run dev`, `npm run build:app` (typecheck + build into `dist-app/`), `npm run preview` (serves on port 4173).

## Architecture

- **Engine worker** (`app/engine/engine.worker.ts`): holds `GameData`, labels, the active `SaveSummary` and its `PlanningProblem`. It loads Docs and saves (posting progress stages), solves with HiGHS, and returns a `ProblemInfo`, which carries:
  - picker items with reachability, holdings, unlocks, best belt/pipe;
  - node counts, map capacity and capacity per normal-node equivalent;
  - every map node with its position, resource and purity;
  - every production recipe with its status (runnable / building-locked / not unlocked) and per-building rates;
  - assumptions.
- **Protocol** (`app/engine/protocol.ts`): typed requests (`loadDocs`, `loadSave`, `useSummary`, `solve`) and error kinds (`not-docs`, `unsupported-version`, `corrupt`, `needs-game-data`, `solver`). An engine crash shows as "The planner engine couldn't start", never as a wrong-file error.
- **Graph layout** (`app/graph/layout.ts`): ELK layered layout (top to bottom, orthogonal edges, raw resources pinned to the first layer, deliveries and surplus to the last) in **its own** worker via `elk-api` + `elk-worker.min.js`. ELK's bundled build can't run inside the engine worker: it takes over that worker's message handler.
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

## Flow graph (`app/graph/`)

- **`model.ts`** builds the graph from a `PlanResult`:
  - Boxes: one per extraction resource, per recipe variant, per used manual supply, per delivery, plus one Surplus box.
  - Edges: each item's production is split across its consumers in proportion. Every recipe receives exactly what it consumes; the unit tests check this.
  - Byproduct outputs (a recipe's second and later products) are marked as byproducts.
- **Modules:** a fixed item → family table (iron, steel & concrete, copper, caterium, quartz, oil & fuel, aluminum, electronics, motors & frames, coal & sulfur, nuclear, quantum & SAM). Families with 2+ recipes in the plan become modules.
  - Default: collapsed when the plan has more than 14 recipe boxes, otherwise expanded.
  - Edges between collapsed modules are merged per pair.
- **`FlowGraph.tsx`:**
  - Each layout is kept together with the graph it was computed for, so changing the detail level never draws new boxes against old coordinates.
  - Loops are edges that run upward after layout (dashed teal, "↺"). Byproducts are dotted. Raw items keep their resource colour, and deliveries are blue.
  - Focus lights the upstream and downstream chain. The drawer has in/out lists that jump between boxes, plus module contents.
  - Search expands a collapsed module and scrolls to the match. Zoom runs 30–150%, with Fit; the first layout fits the width. There's a clickable minimap.
  - Rates below 0.005/min show as "<0.01".

## Nodes, Recipes, Plans

- **Nodes:**
  - The map is an SVG of the save's node positions, north up. Colour shows the resource. Purity is size and fill: pure is large, normal small, impure a ring. Well satellites are diamonds. An excluded node gets a × over a faded dot.
  - Click a node, or drag a box over empty map (it selects only the focused resource), then Exclude / Include / Clear.
  - Resource chips; a focused panel with purity counts, excluded counts, a cap input, and map capacity before and after exclusions; an all-resources list; an excluded list with Include; Include all; zoom 100–400%.
  - Writes `excludedNodes` and `rawCaps`.
- **Recipes:**
  - Scope: "This plan's items" (targets, maximize, items in the last result) or "All items". Filters: All / Alternates / Turned off / Not unlocked, plus search.
  - Grouped by main product. Each row shows a Standard/Alternate tag, Not unlocked, and "In this result", plus per-building rates at 100% and the building-locked reason.
  - A switch writes `disabledRecipes`. Allow all resets.
- **Plans:**
  - Table with select boxes, request line, save and build, and a freshness badge with its reason (Fresh, Short of target, Request/Game data/Save/Solver changed, Not solved, Can't open plus field reasons).
  - Actions: Open, Duplicate, Rename inline, Export, Delete with inline confirm. Header: Export all/selected, Import…, New plan. Empty state.
  - Import report panel. The storage line reflects persistent/no storage.

## Parser and solver changes for the UI

- `summarizeSaveBytes(bytes, gameData, { onStage })` reports `header → decompress → objects (0..1) → summary`.
- `SaveFormatError.code` is `'unsupported-version'` or `'corrupt'`.
- **Solver fix:** below 1e-4 building-equivalents, a recipe line is residue (the integer pass left 2e-5 of an Assembler). It's no longer placed or listed, but its flows stay in the balances. A regression test covers it.
- Tests: 99 pass (7 skipped for fixtures not present), including the graph-model tests in `test/graph-model.test.ts`.

## Verified (headless Chromium, real files)

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

## Next

1. Desktop (Tauri) backend and auto-detect states.
2. Keyboard path for excluding single nodes (the map is pointer-only; the lists cover include, caps and focus).
3. Remembering per plan which graph modules are expanded; graph export (PNG/SVG).

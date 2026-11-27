# Ultimate Satisfactory Production Planner

A browser app that reads a Satisfactory (Update 1.2) save and the game's Docs file, then solves for
the best factory with an LP solver (HiGHS, WebAssembly). Everything runs locally.

## Commands

```
npm run dev          # Vite dev server, http://localhost:4173
npm test             # Vitest (parser, solver, plans, graph)
npm run typecheck    # tsc for src/ and app/
npm run lint         # ESLint (bug-catching rules only; no formatter, keep the existing style)
npm run build:app    # typecheck + build into dist-app/
npm run summary -- fixtures/en-US.json fixtures/<save>.sav
npm run plan -- fixtures/en-US.json fixtures/<save>.sav '<request json>'
```

Hooks in `.claude/settings.json`: each edited `.ts`/`.tsx`/`.mjs` file is linted right away, and
before a turn ends `npm run typecheck` runs if TypeScript files have uncommitted changes.

Before calling work done, run `npm run typecheck` and `npm test`.

## Layout

- `src/` — no DOM code outside `src/platform/browser/`.
  - `save/` parses the `.sav` format, `gamedata/` parses the Docs file plus the bundled node catalog,
    `solver/` builds and solves the LP (lexicographic objectives, diagnosis, explanations),
    `plans/` handles the plan schema, versioning, storage and export/import.
- `app/` — React 18 + Vite UI. Parsing and solving run in a Web Worker (`app/engine/`).
  `app/graph/` is the flow graph (ELK layout), `app/screens/` holds one file per screen,
  and `app/ui/` holds the shared kit plus the map data (outline, terrain, heights, biomes).
- `scripts/` — TypeScript command-line tools (run with `tsx`) and the Python map-tracing scripts.
  Map source images go in `scripts/map-sources/`, which is gitignored.
- `test/` — Vitest tests. `test/fixtures.ts` holds the expected values for each save.

## Constraints

- No network access at runtime: fonts, HiGHS WASM and all data are bundled.
- Target game version is Update 1.2. Node >= 22.12.
- `fixtures/` is gitignored and holds the game Docs files and saves listed in `fixtures/README.md`.
  Tests whose fixtures are missing are **skipped**, not failed, so a green run without fixtures
  proves little. Worktrees get the fixtures from `node scripts/setup-worktree.mjs`.
- Game-derived data (`src/gamedata/data/`, `app/ui/map-*`) is not MIT licensed; see the README's
  License section before adding more.

## DESIGN.md

`DESIGN.md` is long (about 60 KB). Read only the section you need:

- Save or game-data parsing → "Parsing core"
- Solver model, objectives, diagnosis → "Solver"
- Plan schema, versioning, export → "Plans and storage"
- Visual system, screens, empty states → "UI design"
- App architecture, flow graph, Nodes/Recipes/Plans implementation → "UI implementation"

When behavior or a design decision changes, update the matching DESIGN.md section in the same change.

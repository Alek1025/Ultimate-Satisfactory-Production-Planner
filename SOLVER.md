# Satisfactory Planner — solver

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

## Usage

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

## Model

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

## Results

`PlanResult` holds per-level values and binding limits, placed buildings (count, the clock
each one actually runs at, shards and Somersloops each, flows, power at real clocks),
extraction lines, item flows (produced / consumed / extracted / manual used / delivered /
surplus / lines needed on the best belt or pipe), budget use and where, raw use against
what the plan could extract and against the map, and the plain-language `explanation`,
`assumptions` and `warnings`. It carries the game-data hash and save build for plan versioning.

## Assumptions (surfaced in results)

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

## Parser change

`GameData.buildRecipes` (build-gun recipe → buildables) was added so the solver can tell which
buildings, extractors, belts and pipes the save has unlocked. All 34 modeled buildables map to
a build recipe. This changes `contentHash` once.

## Tests

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

# Ultimate Satisfactory Production Planner

Being **rewritten from scratch** as an offline standalone desktop app: a map-scale **World
Architect** (the player sets every goal) plus factual **Plan-vs-Actual** reports from saves.
Target game version is Update 1.2. There is no code for the rewrite yet; the next step is
milestone **M0**, a headless port of the v1 parsers and solver.

## Read first

- `docs/design/direction.md`: what the app is, and what was ruled out.
- `docs/design/architecture.md`: stack, processes, interfaces, World State, `.ussp` project file,
  UI design language and screens, milestones M0–M3, test invariants and the owner's decisions. It
  is long, so read the section you need.
- `docs/rewrite-notes.md`: technical lessons from v1 (save format, Docs parsing, solver, bugs to
  design out).

## Layout

- `docs/`: the design docs above. `docs/design/council/` holds the raw council notes and HTML
  mockups; these are background only.
- `archive/v1/`: the first version, a browser app. It is frozen and kept as a **technical
  reference**: M0 ports its parsers and solver. See `archive/README.md` for how to run it.
- `fixtures/`: gitignored Docs files and saves listed in `fixtures/README.md`.

## Rules

- **Never tell the player what to build next.** The solver only runs on targets the player entered
  ("Draft allocation"). Reports state facts. UI copy must not recommend.
- **Fresh design.** Don't reuse v1's UI, screens or visual system (`archive/v1/DESIGN.md`,
  `archive/v1/app/`). Use v1 only for technical facts.
- **No network access at runtime.** The only exception is the optional local telemetry bridge after
  M3.
- **Bundle no game-derived data.** It comes from the player's install or from files they supply.
- **Missing fixtures must fail tests, not skip them** (v1 skipped them, so a green run proved
  little).
- **Stretch goals,** so don't build them early: custom themes, terrain/heightmap, corridor headlift
  sampling. Live telemetry comes after M3.
- **Keep the docs current.** When a design decision changes, update `docs/design/architecture.md`
  or `direction.md` in the same change.

## Hooks

`.claude/settings.json` sets two hooks:
- Each edited `.ts`/`.tsx`/`.js`/`.mjs` file is linted right away.
- Before a turn ends, `npm run typecheck` runs if TypeScript files have uncommitted changes.

Both skip quietly until the rewrite has a root `package.json` (with a `typecheck` script) and an
`eslint.config.js`. Once the rewrite has code, run `npm run typecheck` and `npm test` before calling
work done.

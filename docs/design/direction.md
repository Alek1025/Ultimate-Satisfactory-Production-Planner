# Product direction: World Architect + Plan-vs-Actual

Decided 2026-11-27 after four rounds of a design council (Claude Opus 5.5 and GPT-6.2 Sol as
designers, Gemini 4 Hydrogen as mediator) plus the owner's feedback. The round-by-round notes are
in [`council/notes/`](council/notes/) (`r1`–`r4`).

## What the app is

An **offline, standalone desktop app** that contains everything a player reasonably needs to plan
their Satisfactory factory. Two halves:

- **World Architect (the planner).** A map-scale logistics and grid planner. The player sets every
  goal: phases and production targets. The app then allocates scarce resource nodes, weighs
  refining at the node against shipping raw, sizes freight corridors (one editable throughput budget
  each, with belt and pipe tiers as hard limits) and sites fuel-bound power. Sensitivity checks show
  which budgets bind. Factories are black-box **sites** (ports, power, footprint); their interiors
  are not modelled.
- **Plan-vs-Actual (the monitor).** Each save or autosave produces a **factual** variance report
  against the player's own plan: extraction against allocation, corridor flow against budget,
  circuit headroom, idle or underclocked machines, and differences between snapshots.

## Rules that define it

- **The player owns the goals.** The app never tells the player what to build next. The solver only
  works on targets the player entered ("Draft allocation"), and reports are facts, not advice.
- **Works without a save.** A world can come from a save, a preset or manual entry, so console
  players get the same planner.
- **Nothing game-derived is bundled.** Game data comes from the player's own install or files they
  supply.

## What was considered and rejected

| Idea | Why not |
|---|---|
| Save copilot that suggests the next build | The owner wants goals to be the player's decision. Its factory *monitoring* survived as Plan-vs-Actual. |
| Modular factory workbench (2D floorplans, build checklists) | Duplicates the in-game blueprint designer. |
| Offline codex / calculator toolkit as the product | Commodity; competes with mature free websites. Reference data appears inline instead. |
| The planner as a vanilla+ game mod | Mods break on every game patch (waiting on the mod loader), need Unreal/C++, exclude console and unmodded players, and add multiplayer risk. |

## Kept open for later (Path 2)

An optional, **read-only live telemetry bridge**, e.g. the existing FicsIt Remote Monitoring mod's
local JSON or the official dedicated-server API, plugged in as just another World State source. It
may later export planned sites and corridors as in-game map markers. This comes **after M3**; no
custom mod is planned. See [architecture.md](architecture.md) for how it plugs in.

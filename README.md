# Ultimate Satisfactory Production Planner

An offline desktop planner for Satisfactory (Update 1.2), being **rewritten from scratch**.

The new app is a map-scale **World Architect**. You set the goals for each phase. It plans which
resource nodes to use, where to refine and how to move freight and power between sites. It adds
**Plan-vs-Actual** reports that compare each save against your plan, as facts and never as advice.
Everything runs locally, and no game data is bundled.

## Headless planner (M0)

Use Node.js 24.11 or newer. From the repository root, install the locked dependencies with
`npm ci`. Each subsequent command runs locally.

```sh
npm run cli -- summary fixtures/en-US.json fixtures/default.sav
npm run cli -- solve fixtures/en-US.json fixtures/obsidian-gears.sav charter.json --catalog my-pack.json
npm run cli -- verify
```

Provide a Docs locale from your game install and a save. The optional catalog is a player-supplied
Update 1.2 pack with node resources, purities and well links. Without one, the planner uses the
available save observations and reports gaps. For regression testing, use the Update 1.2
catalog at `fixtures/node-catalog-1.2.json`. The fixture inventory explains how to prepare it.

A charter is a JSON file with the outputs you want. For example, to reproduce the Obsidian Gears
regression, save this as `charter.json`.

```json
{
  "targets": [{ "item": "Desc_IronPlate_C", "ratePerMin": 20000 }],
  "budgets": { "powerShards": 10 }
}
```

The solve returns a dispatch fingerprint together with its result. Under the fixture's unlocks
and the supplied catalog, it delivers 6,340 Iron Plates/min. To run the verification suite,
supply the files listed in [the fixture inventory](fixtures/README.md). A missing file fails
verification. Run `npm run typecheck` and `npm run lint` for static checks.

Use `npm run cli -- project init my-plan.ussp` to create a project. The project commands support
journal edits, folds, forks, replay and standalone exports. List them with
`npm run cli -- project --help`.

## Design and history

- [docs/design/direction.md](docs/design/direction.md): what the app is, and what was ruled out.
- [docs/design/architecture.md](docs/design/architecture.md): stack, processes, data model, UI,
  milestones M0–M3 and the owner's decisions.
- [docs/rewrite-notes.md](docs/rewrite-notes.md): technical lessons from the first version (save
  format, Docs parsing, solver).
- [archive/v1/](archive/v1/): the first version, a browser app, kept for reference. See
  [archive/README.md](archive/README.md).

## License

The code is licensed under the [MIT License](LICENSE).

**Game data is not covered by this license.** The archived first version includes data derived
from game data © Coffee Stain Studios (a node catalog and traced map, terrain and height data),
included with attribution and removed if Coffee Stain Studios asks. Its biome layer is
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). See
[archive/v1/README.md](archive/v1/README.md#license) for the exact files. The rewrite bundles no
game-derived data.

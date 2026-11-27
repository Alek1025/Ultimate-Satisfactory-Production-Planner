# Ultimate Satisfactory Production Planner

An offline desktop planner for Satisfactory (Update 1.2), being **rewritten from scratch**.

The new app is a map-scale **World Architect**. You set the goals for each phase. It plans which
resource nodes to use, where to refine and how to move freight and power between sites. It adds
**Plan-vs-Actual** reports that compare each save against your plan, as facts and never as advice.
Everything runs locally, and no game data is bundled.

There is no code for the new version yet. Start here:

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

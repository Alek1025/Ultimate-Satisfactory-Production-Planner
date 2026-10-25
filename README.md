# Ultimate Satisfactory Production Planner

A production planner for Satisfactory (Update 1.2) that reads **your own save**. It knows which
recipes, buildings and belts you've unlocked, which resource nodes your world has (including
randomized nodes and purities), and how many Somersloops and Power Shards you hold. Then it finds
the best factory for what you ask for.

Everything runs locally in your browser. Your save and game files are never uploaded, and the
built app makes no network requests.

## What it does

- **Plan from your save:** reads the `.sav` file and the game's `Docs` file, so you can only pick
  items, recipes and machines you actually have, and Game Mode settings (cost multipliers, node
  randomization, purity) are taken into account.
- **Targets and maximize:** ask for fixed rates ("20 Motors/min"), maximize items in order, or
  both. You can also add items you already produce and cap any raw resource.
- **Somersloops and Power Shards:** give the planner a budget and it decides where boosts and
  overclocks pay off most.
- **You choose the trade-offs:** reorder the priorities (meet targets, maximize, save scarce
  resources, save power, fewer buildings). You can ask for whole buildings or allow fractions.
- **Flow graph:** the whole factory as a graph, with related recipes grouped into modules you can
  expand. Click any box to highlight its supply chain. Includes search, zoom and a minimap.
- **When a target can't be met:** it shows what's in the way and the smallest change that would
  fix it, and explains why an item can't be made at all in your save.
- **Nodes and recipes:** exclude nodes on a map of your world, cap resources, and turn off recipes
  you don't want to use.
- **Plans:** keep several plans, see when one is out of date (new save, new game version,
  changed request), and export or import them as files.

## Running it

You need [Node.js](https://nodejs.org/) 22.12 or newer.

```
npm install
npm run dev          # http://localhost:4173, with hot reload
```

To build and serve a production copy:

```
npm run build:app    # typecheck + build into dist-app/
npm run preview      # serve dist-app/ at http://localhost:4173
```

Open the app through the local server, not by double-clicking the HTML file. Browsers block what
the planner needs (WebAssembly and IndexedDB) on `file://` pages.

### First run

The app asks for two files:

1. **Game data:** any language's Docs file (e.g. `en-US.json`) from your install folder:
   `Satisfactory/CommunityResources/Docs/`.
2. **Your save:** a `.sav` file. On Windows, saves are in
   `%LOCALAPPDATA%/FactoryGame/Saved/SaveGames/<id>/`.

Both are remembered in your browser along with your plans, so a reload picks up where you left
off. Private windows may not keep them; the app warns you when that happens, and you can export
your plans to keep them.

## Status

Working: first run, Setup, the plan workspace (flow graph, buildings, item flows, raw resources,
explanation, short-of-target fixes), Nodes, Recipes and Plans.

Planned: a desktop app (Tauri) that finds your install and saves automatically, keyboard support
for the node map, and exporting the flow graph as an image.

## For developers

```
npm test             # parser, solver, plan and graph tests
npm run typecheck
npm run summary -- fixtures/en-US.json fixtures/<save>.sav    # readable save summary
npm run plan -- fixtures/en-US.json fixtures/<save>.sav '<request json>'
```

Some tests need game files and saves in `fixtures/`; tests whose fixtures are missing are skipped.
See [fixtures/README.md](fixtures/README.md) for the list.

```
src/       parsers (save + game data), solver (HiGHS LP), plans and storage; no DOM code
           outside src/platform/browser/
app/       React + Vite UI; parsing and solving run in a Web Worker
scripts/   command-line tools
test/      Vitest tests
```

How everything works (save format, solver model, plan versioning, UI design and implementation)
is in [DESIGN.md](DESIGN.md).

## Credits

- LP solving by [HiGHS](https://highs.dev/) (WebAssembly build), graph layout by
  [ELK](https://eclipse.dev/elk/).
- Default node data is derived from the game's map data, via
  [valentinps/satisfactorymap](https://github.com/valentinps/satisfactorymap).

This is an unofficial fan project, not affiliated with or endorsed by Coffee Stain Studios.
Satisfactory and its game data are © Coffee Stain Studios.

## License

The code is licensed under the [MIT License](LICENSE).

**Game data is not covered by this license.** The node catalog in `src/gamedata/data/` is game
data © Coffee Stain Studios, included with attribution for use by this planner. It will be
removed if Coffee Stain Studios asks.

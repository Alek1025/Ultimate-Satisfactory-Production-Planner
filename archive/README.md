# Archive

`v1/` is the first version of the planner: a browser app (React + Vite, HiGHS WASM) that reads a
save and the Docs file and solves for an optimal factory. It is frozen and kept for reference while
the rewrite is built. Don't add features here.

What is worth reading during the rewrite:

- `v1/src/save/` and `v1/src/gamedata/`: the save and Docs parsers, which M0 ports.
- `v1/src/solver/`: the LP model, lexicographic objectives and diagnosis.
- `v1/test/fixtures.ts`: expected values for the six fixture saves.

The lessons drawn from all of it are in [../docs/rewrite-notes.md](../docs/rewrite-notes.md).

## Running v1

It still runs from this folder. Its `node_modules` was moved here with it.

```
cd archive/v1
npm install     # only if node_modules is missing
npm test
npm run dev     # http://localhost:4173
```

Fixture tests look in `v1/fixtures/`, which is a gitignored link to the repo's root `fixtures/`
folder. Fixture tests whose files are missing are skipped. On a fresh clone, recreate the link
from the repo root:

```
cmd /c mklink /J archive\v1\fixtures fixtures
```

`v1/README.md` and `v1/DESIGN.md` describe v1 as it was, including paths relative to `v1/`. The
rewrite deliberately does not reuse v1's UI design.

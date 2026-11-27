# Fixtures

Golden regression fixtures. They are game-derived or personal, so they are **gitignored** and never
committed or bundled. Copy them here under the names below.

The tests require every file. A missing file fails the run and is never skipped, and
`test/fixtures.test.ts` checks each file against the SHA-256 pinned in `test/fixtures.ts`. If you
replace a fixture on purpose, update both that pin and this table in the same change.

| File | Source | SHA-256 |
|---|---|---|
| `en-US.json` | Game install, `CommunityResources/Docs/en-US.json` | `9c651f6840a11743df0aaa2f47f1005487abe8f3a93fa299c5092882bb4a76e3` |
| `da.json` | Game install, `CommunityResources/Docs/da.json` | `62dfa09c61011a838ae83faf4cb223ca45b8e5728cfb1fc14b5831e14bb0eb0a` |
| `he.json` | Game install, `CommunityResources/Docs/he.json` | `48bd523d9407d982f8112e1575a3118a739ace35b3a92a4215194cf61cca99c3` |
| `all-pure-nodes.sav` | "All Pure Nodes_181026-173220.sav" | `f4e2d42e8de658409622f350c920e3a2c3adb49b407201b4460cf54fea28b7de` |
| `obsidian-gears.sav` | "Obsidian Gears xVx_K00L_S1D's_KluB_xVx_211026-212731.sav" | `d8d3b83465785b0b4be376d8bbbc1ad461d8c44a9408dfa1d8f57c5685ad1060` |
| `max-milestone-multiplier.sav` | "1.2 Max Milestone Multiplier _300626-110335.sav" | `baba8a7135f036b80d9f681c5ad155f6552efd5460e619bc14cd21182be0971a` |
| `random-nodes.sav` | "Test Random Nodes_241026-110520.sav" (strict node randomization) | `877b9a7f78063bbd39b9b340c5c3bc2770d66d801e27fc0225795980977157a9` |
| `default.sav` | "1.2 Default_241026-111033.sav" | `ced91ef574c3a66c2f4d3c7ca6c88298b970a96b22ab2d4590652a33da307818` |
| `resource-rich-random-purity.sav` | "1.2 advanced resource rich + random purity_241026-111251.sav" | `c9b2a7a9cd3d303d823ab477858d7a8d5cfc74408cd414a34429ea0271b08869` |
| `node-catalog-1.2.json` | CatalogPack: v1's `archive/v1/src/gamedata/data/node-catalog-1.2.json` (built from valentinps/satisfactorymap `game-data-v3`, see below) | `f6a450f8cb3cf3952554955bd72b24fa2fc011da245874da0a8c44300de0c5fe` |

Saves are in `%LOCALAPPDATA%/FactoryGame/Saved/SaveGames/<id>/` on Windows. The six saves are
Update 1.2 (header 14, save version 60, UE 5.6.1).

## The CatalogPack

`node-catalog-1.2.json` gives each node's default resource and purity and each well satellite's
core, which saves don't store (see `docs/rewrite-notes.md` §2). Its upstream is
`game_data/generated/world/resourcePurity.json` in valentinps/satisfactorymap release
`game-data-v3` (`game_data.zip` sha256
`686bac80b43c57044048b9fb95be2d0347d2eb2556cb2564e0c9fed3442fe1d0`), an FModel export of the 1.2
level data. Game data © Coffee Stain Studios. The app bundles no catalog; players supply one.

From the repo root, copy it with:

```
cp archive/v1/src/gamedata/data/node-catalog-1.2.json fixtures/
```

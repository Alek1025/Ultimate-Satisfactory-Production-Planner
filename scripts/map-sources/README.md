# Map source images

Full-map images the map tracers read. They're gitignored and never committed; only the traced
lines in `app/ui/` are. Each is the whole map, square, north up.

| File | Used by | Source |
| --- | --- | --- |
| `game-map-tl.png`, `-tr`, `-bl`, `-br` | `scripts/stitch-map-quadrants.py` | The game's map textures, four 4096px quadrants exported from the game files |
| `game-map.png` | `scripts/trace-map-outline.py` | The quadrants joined into the 8192px full map |
| `game-heightmap.hdr` | `scripts/build-heightmap.py`, `scripts/trace-map-terrain.py` | The game's height map, 2048px, heights 0–1 (sea about 0.505, off-map 0) |
| `wiki-map.jpg` | earlier outline trace (not used now) | 5000px full map from the [Satisfactory Wiki](https://satisfactory.wiki.gg/), a downscale of the game's map |
| `wiki-biome-map.jpg` | `scripts/trace-map-biomes.py` | [Biome_Map.jpg](https://satisfactory.wiki.gg/wiki/Biomes), 5000px, CC BY-NC-SA 4.0 |
| `mapgenie.jpg`, `ingame.png` | earlier outline trace (not used now) | Map Genie (2048px) and an in-game map screenshot (1227px) |

# Map source images

Full-map images the map tracers read. They're gitignored and never committed; only the traced
lines in `app/ui/` are. Each is the whole map, square, north up.

| File | Used by | Source |
| --- | --- | --- |
| `wiki-map.jpg` | `scripts/trace-map-outline.py` | 5000px full map from the [Satisfactory Wiki](https://satisfactory.wiki.gg/) |
| `wiki-biome-map.jpg` | `scripts/trace-map-biomes.py` | [Biome_Map.jpg](https://satisfactory.wiki.gg/wiki/Biomes), 5000px, CC BY-NC-SA 4.0 |
| `mapgenie.jpg`, `ingame.png` | earlier outline trace (not used now) | Map Genie (2048px) and an in-game map screenshot (1227px) |

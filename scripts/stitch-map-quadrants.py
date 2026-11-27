"""
Stitch the game's four map quadrant textures into one full-map image for the map tracers.

Usage: python scripts/stitch-map-quadrants.py <top-left> <top-right> <bottom-left> <bottom-right> [out.png]
Needs: Pillow.

The quadrants are the in-game map's own textures (4096px each, exported from the game files),
which tile edge to edge into an 8192px map covering the same square as the other sources:
world X -324698.832..425301.832 and Y -375000..375000 (cm), north up.
"""
import sys

from PIL import Image


def main() -> None:
    args = sys.argv[1:]
    if len(args) not in (4, 5):
        sys.exit(__doc__)
    tiles = [Image.open(p).convert('RGB') for p in args[:4]]
    size = tiles[0].size
    if any(t.size != size for t in tiles):
        sys.exit(f'quadrants differ in size: {[t.size for t in tiles]}')
    w, h = size
    out = Image.new('RGB', (2 * w, 2 * h))
    for t, xy in zip(tiles, ((0, 0), (w, 0), (0, h), (w, h))):
        out.paste(t, xy)
    path = args[4] if len(args) == 5 else 'scripts/map-sources/game-map.png'
    out.save(path)
    print(f'{2 * w}x{2 * h} -> {path}')


if __name__ == '__main__':
    main()

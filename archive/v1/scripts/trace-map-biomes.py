"""
Trace the game's biome regions from a coloured biome map into app/ui/map-biomes.json,
shaded under the Nodes map when Biomes is on.

Usage: python scripts/trace-map-biomes.py <biome-map.jpg> [out.json] [--preview preview.png]
Needs: Pillow, numpy, opencv-python, scipy.

The image must be the whole map (square, north up), framed like the outline's source:
world X -324698.832..425301.832 and Y -375000..375000 (cm). Each biome is a flat tint over
the map, so every pixel is classed by its nearest tint (in Lab), small specks and text are
voted away, and water and unclear pixels take the nearest biome. The regions run a little
past the shore; the app clips them to the traced coastline. The image itself is never
committed; only the simplified shapes are.

Current source: the wiki's biome map (satisfactory.wiki.gg/images/Biome_Map.jpg, 5000px,
CC BY-NC-SA 4.0), saved as scripts/map-sources/wiki-biome-map.jpg. It registers to the outline's
sources within 0.04% and half a pixel. Run as

  python scripts/trace-map-biomes.py scripts/map-sources/wiki-biome-map.jpg
"""
import json
import sys

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

X0, X1 = -324698.832, 425301.832
Y0, Y1 = -375000.0, 375000.0
WORK = 1250            # trace at this size (6 m a pixel)
MAX_TINT_DIST = 22     # Lab distance beyond which a pixel's tint is unclear
VOTE_PX = 9            # majority vote over this square, to drop text, grid lines and texture
SHORE_PX = 6           # regions reach this far past the land, so clipping to the coast leaves no gaps
MIN_PIECE_PX = 40      # drop region pieces smaller than this (area)
STRAY_PX = 60          # a piece this far from its biome's largest piece is a mismatched tint, unless it's big
STRAY_SHARE = 0.25     # ... at least this share of the largest piece
MIN_UNTINTED_PX = 300  # untinted land smaller than this joins the biome around it (area)
SIMPLIFY_PX = 1.0      # Douglas-Peucker tolerance
OVERLAP_PX = 2         # each region reaches this far into its neighbours

# Tints as drawn on the source image (RGB), plus extra shades where a tint over water reads differently.
# Names starting with _ aren't biomes.
SHADES = [('Spire Coast', (164, 130, 137))]
TINTS = {
    'Grass Fields': (118, 161, 87), 'Rocky Desert': (176, 165, 143), 'Northern Forest': (85, 178, 123),
    'Dune Desert': (201, 196, 165), 'Spire Coast': (195, 159, 171), 'Desert Canyons': (163, 149, 121),
    'Maze Canyons': (198, 181, 106), 'Crater Lakes': (182, 146, 98), 'Lake Forest': (121, 194, 119),
    'Titan Forest': (79, 166, 117), 'Swamp': (54, 200, 188), 'Red Bamboo Fields': (222, 183, 205),
    'Red Jungle': (220, 144, 154), 'Jungle Spires': (107, 166, 124), 'Western Dune Forest': (145, 171, 122),
    'Snaketree Forest': (66, 115, 36), 'Eastern Dune Forest': (154, 191, 96), 'Blue Crater': (77, 133, 176),
    'Southern Forest': (130, 92, 136), 'Abyss Cliffs': (102, 104, 99),
    '_land': (126, 119, 101), '_water': (66, 132, 152), '_sea': (63, 93, 103), '_black': (0, 0, 0),
}
# Western Beaches shares Dune Desert's tint; it's the part in the west half.
SAME_TINT_WEST = ('Dune Desert', 'Western Beaches')


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    preview = sys.argv[sys.argv.index('--preview') + 1] if '--preview' in sys.argv else None
    if preview in args:
        args.remove(preview)
    src = args[0]
    out = args[1] if len(args) > 1 else 'app/ui/map-biomes.json'

    rgb = np.asarray(Image.open(src).convert('RGB').resize((WORK, WORK), Image.LANCZOS))
    rgb = cv2.medianBlur(rgb, 7)
    names = list(TINTS)
    refs = [(i, c) for i, c in enumerate(TINTS.values())] + [(names.index(n), c) for n, c in SHADES]
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32)
    ref = cv2.cvtColor(np.array([[c for _, c in refs]], np.uint8), cv2.COLOR_RGB2LAB)[0].astype(np.float32)
    d2 = ((lab[:, None, :] - ref[None]) ** 2).sum(-1)
    cls = np.array([i for i, _ in refs])[d2.argmin(1)].reshape(WORK, WORK)
    unclear = np.sqrt(d2.min(1)).reshape(WORK, WORK) > MAX_TINT_DIST

    # Majority vote, ignoring unclear pixels.
    votes = np.stack([cv2.boxFilter(((cls == i) & ~unclear).astype(np.float32), -1, (VOTE_PX, VOTE_PX))
                      for i in range(len(names))])
    cls = votes.argmax(0)
    unclear = votes.max(0) < 0.2

    idx = {n: i for i, n in enumerate(names)}
    outside = (cls == idx['_sea']) | (cls == idx['_black'])
    area = cv2.dilate((~outside).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * SHORE_PX + 1,) * 2)) > 0
    area = ndimage.binary_fill_holes(area)  # lakes too; the app clips to the coast
    # Seeds: clear pixels of a biome or of untinted land. Everything else in the area takes the nearest seed.
    seed = ~unclear & ~outside & (cls != idx['_water'])
    for _ in range(2):  # second pass: refill without the stray pieces found in the first
        _, (iy, ix) = ndimage.distance_transform_edt(~seed, return_indices=True)
        fill = np.where(area, cls[iy, ix], -1)
        for i, name in enumerate(names):
            if not name.startswith('_'):
                seed &= ~stray(fill == i)
        # Untinted land only counts where there's a real stretch of it (not grid labels or shadows).
        n, comp, stats, _ = cv2.connectedComponentsWithStats((fill == idx['_land']).astype(np.uint8), connectivity=8)
        seed &= ~np.isin(comp, [c for c in range(1, n) if stats[c, cv2.CC_STAT_AREA] < MIN_UNTINTED_PX])

    biomes = []
    for i, name in enumerate(names):
        if name.startswith('_'):
            continue
        mask = (fill == i).astype(np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        n, comp, stats, cent = cv2.connectedComponentsWithStats(mask, connectivity=8)
        parts: dict[str, np.ndarray] = {}
        for c in range(1, n):
            if stats[c, cv2.CC_STAT_AREA] < MIN_PIECE_PX:
                continue
            nm = SAME_TINT_WEST[1] if name == SAME_TINT_WEST[0] and cent[c][0] < WORK / 2 else name
            parts[nm] = parts.get(nm, np.zeros_like(mask)) | (comp == c).astype(np.uint8)
        for nm, m in parts.items():
            # Grow into the neighbours a little, so separately traced and simplified borders still
            # meet; the app fades the layer as a whole, so the overlap doesn't show.
            m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * OVERLAP_PX + 1,) * 2))
            biomes.append(trace(nm, m, TINTS[name]))

    biomes.sort(key=lambda b: b['name'])
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'units': 'm', 'source': 'satisfactory.wiki.gg Biome_Map.jpg, CC BY-NC-SA 4.0', 'biomes': biomes}, f, separators=(',', ':'))
    print(f'{len(biomes)} biomes, {sum(len(r) // 2 for b in biomes for r in b["rings"])} points -> {out}')

    if preview:
        img = np.zeros((WORK, WORK, 3), np.uint8)
        for b in biomes:
            rings = [np.array(r, float).reshape(-1, 2) for r in b['rings']]
            rings = [np.round(np.c_[(r[:, 0] * 100 - X0) / (X1 - X0), (r[:, 1] * 100 - Y0) / (Y1 - Y0)] * WORK).astype(np.int32) for r in rings]
            col = tuple(int(v) for v in bytes.fromhex(b['color'][1:]))
            mask = np.zeros((WORK, WORK), np.uint8)
            for r in rings:  # even-odd, as the app fills them
                m = np.zeros_like(mask); cv2.fillPoly(m, [r], 1); mask ^= m
            img[mask > 0] = col
            cv2.polylines(img, rings, True, (20, 20, 20), 1)
            lx, ly = b['label']
            cv2.putText(img, b['name'], (int((lx * 100 - X0) / (X1 - X0) * WORK) - 30, int((ly * 100 - Y0) / (Y1 - Y0) * WORK)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 0), 1)
        Image.fromarray(img).save(preview)


def stray(mask: np.ndarray) -> np.ndarray:
    """Pieces of `mask` far from its largest piece and much smaller: a shade that only looks like this tint."""
    n, comp, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    if n <= 2:
        return np.zeros_like(mask)
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    near = cv2.distanceTransform((comp != big).astype(np.uint8), cv2.DIST_L2, 5) <= STRAY_PX
    out = np.zeros_like(mask)
    for c in range(1, n):
        if c != big and stats[c, cv2.CC_STAT_AREA] < STRAY_SHARE * stats[big, cv2.CC_STAT_AREA] and not near[comp == c].any():
            out |= comp == c
    return out


def trace(name: str, mask: np.ndarray, rgb: tuple[int, int, int]) -> dict:
    to_m = lambda px, py: [round((X0 + (px + 0.5) / WORK * (X1 - X0)) / 100), round((Y0 + (py + 0.5) / WORK * (Y1 - Y0)) / 100)]
    contours, _ = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    rings = []
    for c in contours:
        if cv2.contourArea(c) < MIN_PIECE_PX:
            continue
        c = cv2.approxPolyDP(c, SIMPLIFY_PX, True).reshape(-1, 2)
        if len(c) >= 3:
            rings.append([v for px, py in c for v in to_m(px, py)])
    # Label at the point deepest inside the largest piece.
    n, comp, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    dist = cv2.distanceTransform((comp == big).astype(np.uint8), cv2.DIST_L2, 5)
    ly, lx = np.unravel_index(int(dist.argmax()), dist.shape)
    return {'name': name, 'color': '#%02x%02x%02x' % rgb, 'label': to_m(lx, ly), 'rings': rings}


if __name__ == '__main__':
    main()

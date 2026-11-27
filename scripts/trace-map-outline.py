"""
Trace the game map's coastline, lakes and rivers from a full-map image into
app/ui/map-outline.json, drawn faintly under the Nodes map.

Usage: python scripts/trace-map-outline.py <full-map.png> [out.json] [--preview preview.png] [--detail N]
           [--region-from other-full-map.png --region x0,y0,x1,y1]
Needs: Pillow, numpy, opencv-python.

The image must be the whole in-game map (square, north up), which covers world
X -324698.832..425301.832 and Y -375000..375000 (cm). Land is grey/beige; water
is teal (sea) or cyan (shallows, lakes, rivers), so a pixel is land unless blue
clearly beats red. The image itself is never committed; only the
simplified lines are.

- coast: outer edges of land (the main island and every islet).
- lakes: edges of water enclosed by land: lakes, and rivers wide enough to show both banks.
- rivers: centre lines of channels too thin to show two banks, as open polylines.
- void: the black off-map area (and the pit in the Grass Fields), drawn as neither land nor water.
- seaGlow: bounds (metres) of app/ui/map-sea.png, a soft sea-coloured glow that fades out with
  distance from land through open sea, so the ocean neither ends in a square nor runs on forever.

Pixel settings below are for a 1227px-wide image and scale with the input's width.

--region-from takes land and water from a second full-map image inside a box given in
world metres, for an area the main image draws differently. Put the box edges where
both images agree (open sea or inland), so no seam shows.

Current source: the game's own map textures, four 4096px quadrants exported from the game
files and joined by scripts/stitch-map-quadrants.py into scripts/map-sources/game-map.png
(8192px). Run as

  python scripts/trace-map-outline.py scripts/map-sources/game-map.png --detail 4

--detail 4 simplifies to about 1.8 m instead of 7 m (about 26,600 points, 270 KB, 102 KB
gzipped). The game map registers to the earlier sources (the wiki's 5000px map is a downscale
of it) within 0.01% and a tenth of a pixel. Of the 1.2 default save's 625 nodes, 617 (98.7%)
fall inside the traced land; the other 8 sit a median 6 m (at most 54 m) from a line, i.e. on
shorelines and lake edges. Speck and stroke cleanup are set in metres, not scaled with the
image. Thin land with water on two separate sides (arches, and the map's strokes for
cliff edges and falls) is removed so rivers and channels run on under it, as in the game.
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

X0, X1 = -324698.832, 425301.832
Y0, Y1 = -375000.0, 375000.0
REF_W = 1227           # the pixel settings below are tuned for an image this wide
LAND_BLUE = 25         # land pixels: blue beats red by less than this (sea is ~45, shallows 70+);
                       # loose enough to keep the dark shaded rims of small islets
LAND_SPECK_M = 3       # land narrower than this many metres is noise
WATER_SPECK_PX = 2     # water narrower than this joins the land (then traced as a river line)
STROKE_M = 16          # thin land up to this many metres wide that separates two bodies of water is an
                       # arch or a drawn stroke over the water, which carries on under it
STROKE_DARK = 110      # pixels darker than this (mean of r, g, b) are drawn strokes...
STROKE_NEAR_M = 6      # ...and count as water this close to water
MIN_ISLAND_PX = 12     # drop specks of land (area)
MIN_LAKE_PX = 8        # enclosed water smaller than this is noise (area)
VOID_GLOW_PX = 25      # the off-map area's white border and grey glow reach this far from the black
MIN_VOID_PX = 150      # black smaller than this is a shadow, not off-map (area)
MIN_EDGE_PIECE_PX = 400  # land touching the image edge smaller than this is a cut-off sliver (area)
MIN_RIVER_PX = 10      # drop river lines shorter than this
RIVER_BLUE = 4         # river pixels: blue beats red by more than this
RIVER_BRIDGE_PX = 3    # close gaps this wide along a river
SIMPLIFY_PX = 1.2      # Douglas-Peucker tolerance
SEA_RGB = (0x14, 0x28, 0x33)  # the app's sea colour
GLOW_CELL_M = 25       # sea glow grid cell
GLOW_MARGIN_M = 2400   # the glow image reaches this far past the map on every side
GLOW_FULL_M = 400      # open sea is full colour this close to land...
GLOW_FADE_M = 2800     # ...and gone this far out (measured through sea)
GLOW_SOFTEN_M = 150    # final blur, to round off the distance field
GLOW_VOID_M = 1000     # the glow fades out over this distance towards off-map black
GLOW_VOID_OUT_M = 6000 # ...over this distance once past the map's edge
GLOW_EDGE_M = 2400     # and everywhere over this distance past the map's edge
CLEANUP_DETAIL_MAX = 2  # --detail beyond this sharpens shapes but not the speck cleanup
DISK = lambda d: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (d, d))


def thin(mask: np.ndarray) -> np.ndarray:
    """Zhang-Suen thinning of a 0/1 mask to 1px-wide lines."""
    img = np.pad(mask.astype(np.uint8), 1)
    while True:
        changed = False
        for step in (0, 1):
            p = img
            n = [np.roll(np.roll(p, dy, 0), dx, 1) for dy, dx in
                 ((1, 0), (1, -1), (0, -1), (-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1))]
            # n[0..7] = P2..P9 clockwise from north (roll by +1 brings the north neighbour here).
            b = sum(n)
            a = sum(((n[i] == 0) & (n[(i + 1) % 8] == 1)).astype(np.uint8) for i in range(8))
            if step == 0:
                c1 = n[0] * n[2] * n[4]; c2 = n[2] * n[4] * n[6]
            else:
                c1 = n[0] * n[2] * n[6]; c2 = n[0] * n[4] * n[6]
            kill = (p == 1) & (b >= 2) & (b <= 6) & (a == 1) & (c1 == 0) & (c2 == 0)
            if kill.any():
                img = img & ~kill
                changed = True
        if not changed:
            return img[1:-1, 1:-1]


def drop_strokes(land: np.ndarray, disk: np.ndarray) -> np.ndarray:
    """Thin land across water (rock arches, and drawn strokes for cliff edges and falls) cuts
    a river or channel in two; the water carries on under it. Remove thin land with water on
    two separate sides (the water just around it falls into two or more pieces), even when
    those waters join up elsewhere; keep thin land that water only wraps around (a spit)."""
    thin_land = ((land > 0) & (cv2.morphologyEx(land, cv2.MORPH_OPEN, disk) == 0)).astype(np.uint8)
    water = land == 0
    count, labels, stats, _ = cv2.connectedComponentsWithStats(thin_land, connectivity=8)
    out = land.copy()
    for i in range(1, count):
        x, y, bw, bh = stats[i, :4]
        y0, x0 = max(0, y - 2), max(0, x - 2)
        piece = labels[y0:y + bh + 2, x0:x + bw + 2] == i
        ring = (cv2.dilate(piece.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & ~piece & water[y0:y + bh + 2, x0:x + bw + 2]
        if cv2.connectedComponents(ring.astype(np.uint8), connectivity=8)[0] - 1 >= 2:
            out[y0:y + bh + 2, x0:x + bw + 2][piece] = 0
    return out


RING = ((-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1))


def trace_lines(skel: np.ndarray, min_px: int) -> list[np.ndarray]:
    """Split a 1px skeleton into polylines between endpoints and junctions, dropping
    connected pieces with fewer than `min_px` pixels in total."""
    count, labels = cv2.connectedComponents(skel.astype(np.uint8), connectivity=8)
    sizes = np.bincount(labels.ravel(), minlength=count)
    ys, xs = np.nonzero((skel > 0) & (sizes[labels] >= min_px))
    on = set(zip(ys.tolist(), xs.tolist()))
    nbrs = lambda q: [(q[0] + dy, q[1] + dx) for dy, dx in RING if (q[0] + dy, q[1] + dx) in on]

    # Thinning leaves corner pixels on diagonal steps (a pixel with both N and E set, say),
    # which look like junctions and would cut lines into 2px pieces. Drop a pixel when its
    # neighbours stay connected to each other without it.
    for q in sorted(on):
        near = nbrs(q)
        if not 2 <= len(near) <= 3:
            continue
        group, todo = {near[0]}, [near[0]]
        while todo:
            a = todo.pop()
            for c in near:
                if c not in group and max(abs(a[0] - c[0]), abs(a[1] - c[1])) == 1:
                    group.add(c); todo.append(c)
        if len(group) == len(near):
            on.discard(q)

    deg = {q: len(nbrs(q)) for q in on}
    seen_edges: set[frozenset] = set()
    lines = []
    # Endpoints and junctions first, then any closed loops that have neither.
    starts = [q for q in on if deg[q] != 2] + [q for q in on if deg[q] == 2]
    for s in starts:
        for nxt in nbrs(s):
            if frozenset((s, nxt)) in seen_edges:
                continue
            path = [s, nxt]
            seen_edges.add(frozenset((s, nxt)))
            while deg[path[-1]] == 2:
                step = [q for q in nbrs(path[-1]) if frozenset((path[-1], q)) not in seen_edges]
                if not step:
                    break
                seen_edges.add(frozenset((path[-1], step[0])))
                path.append(step[0])
                if path[-1] == s:
                    break
            lines.append(np.array([(x, y) for y, x in path], np.int32).reshape(-1, 1, 2))
    return lines


def off_map(im: np.ndarray, glow: float, min_area: float) -> np.ndarray:
    """Where the map runs off the playable area it's black, edged with a white line and a grey
    glow. Those are neutral grey (land is beige, r well above b) and bright enough to pass the
    land test, so: neutral pixels near the black, connected to it."""
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    n, comp, stats, _ = cv2.connectedComponentsWithStats((im.max(-1) < 25).astype(np.uint8), connectivity=8)
    dark = np.isin(comp, [c for c in range(1, n) if stats[c, cv2.CC_STAT_AREA] >= min_area])
    near = cv2.distanceTransform((~dark).astype(np.uint8), cv2.DIST_L2, 5) <= glow
    neutral = (np.abs(r - b) < 10) & (np.abs(r - g) < 10)
    n, comp = cv2.connectedComponents(((dark | (neutral & near)) * 255).astype(np.uint8), connectivity=8)
    return np.isin(comp, np.unique(comp[dark]))


def sea_glow(landmass: np.ndarray, void: np.ndarray, out_png: str) -> dict[str, float]:
    """Sea alpha on a coarse grid around the map: full near land, fading out over open sea.
    Distance is measured through sea only, so nothing glows behind off-map black, and the glow
    also fades out near the black and just past the map's edge (round distance fields, so it
    tapers softly instead of ending in straight walls or spreading into off-map space). Saved as a sea-coloured RGBA PNG the app
    stretches over its bounds."""
    n = round((X1 - X0) / 100 / GLOW_CELL_M)           # world cells across
    m = round(GLOW_MARGIN_M / GLOW_CELL_M)             # margin cells on each side
    land = cv2.resize(landmass.astype(np.float32), (n, n), interpolation=cv2.INTER_AREA) > 0.2
    off = cv2.resize(void.astype(np.float32), (n, n), interpolation=cv2.INTER_AREA) > 0.5
    # Past the image's edge each cell takes the off-map state of the nearest edge cell, so black
    # carries on outward; the fades below keep the result soft and round.
    idx = np.clip(np.arange(-m, n + m), 0, n - 1)
    land = np.pad(land, m)
    off = off[np.ix_(idx, idx)] & ~land

    # Geodesic distance (in cells) from land through non-off-map cells: relax 8-neighbour steps.
    dist = np.where(land, 0.0, np.inf)
    steps = [(dy, dx, np.hypot(dy, dx)) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx]
    while True:
        best = dist.copy()
        for dy, dx, c in steps:
            shifted = np.full_like(dist, np.inf)
            shifted[max(dy, 0):dist.shape[0] + min(dy, 0), max(dx, 0):dist.shape[1] + min(dx, 0)] =                 dist[max(-dy, 0):dist.shape[0] + min(-dy, 0), max(-dx, 0):dist.shape[1] + min(-dx, 0)]
            best = np.minimum(best, shifted + c)
        best[off] = np.inf
        best[land] = 0
        if np.array_equal(best, dist):
            break
        dist = best
    d = dist * GLOW_CELL_M
    t = np.clip((d - GLOW_FULL_M) / (GLOW_FADE_M - GLOW_FULL_M), 0, 1)
    alpha = 1 - t * t * (3 - 2 * t)                    # smoothstep down to 0
    # Fade out near off-map black, over a longer reach past the map's edge (where the black carries on).
    out = cv2.distanceTransform(1 - np.pad(np.ones((n, n), np.uint8), m), cv2.DIST_L2, 5) * GLOW_CELL_M
    reach = GLOW_VOID_M + (GLOW_VOID_OUT_M - GLOW_VOID_M) * np.clip(out / 1000, 0, 1)
    v = np.clip(cv2.distanceTransform((~off).astype(np.uint8), cv2.DIST_L2, 5) * GLOW_CELL_M / reach, 0, 1)
    alpha *= v * v * (3 - 2 * v)
    o = np.clip(1 - out / GLOW_EDGE_M, 0, 1)
    alpha *= o * o * (3 - 2 * o)                       # and gently out past the map's edge
    alpha[land] = 1                                    # lakes and rivers show it through the land
    alpha = cv2.GaussianBlur(alpha.astype(np.float32), (0, 0), GLOW_SOFTEN_M / GLOW_CELL_M)
    rgba = np.zeros(alpha.shape + (4,), np.uint8)
    rgba[..., :3] = SEA_RGB
    rgba[..., 3] = np.round(np.clip(alpha, 0, 1) * 255)
    Image.fromarray(rgba, 'RGBA').save(out_png, optimize=True)
    mx = m * GLOW_CELL_M
    return {'x0': round(X0 / 100 - mx), 'y0': round(Y0 / 100 - mx), 'x1': round(X1 / 100 + mx), 'y1': round(Y1 / 100 + mx)}


def main() -> None:
    args = sys.argv[1:]
    def option(name: str) -> str | None:
        for i, a in enumerate(args):
            if a == name:
                v = args[i + 1]; del args[i:i + 2]; return v
            if a.startswith(name + '='):
                del args[i]; return a.split('=', 1)[1]
        return None
    preview = option('--preview')
    detail = float(option('--detail') or 1)
    region_from = option('--region-from')
    region = option('--region')
    src = args[0]
    out = args[1] if len(args) > 1 else 'app/ui/map-outline.json'

    im = np.asarray(Image.open(src).convert('RGB')).astype(int)
    h, w = im.shape[:2]
    if region_from:
        # Swap the other image's pixels into the box, so land and rivers both come from it there.
        x0, y0, x1, y1 = (float(v) * 100 for v in region.split(','))
        other = np.asarray(Image.open(region_from).convert('RGB').resize((w, h), Image.BILINEAR)).astype(int)
        rows = slice(int((y0 - Y0) / (Y1 - Y0) * h), int((y1 - Y0) / (Y1 - Y0) * h))
        cols = slice(int((x0 - X0) / (X1 - X0) * w), int((x1 - X0) / (X1 - X0) * w))
        im = im.copy()
        im[rows, cols] = other[rows, cols]
    r, b = im[..., 0], im[..., 2]
    k = w / REF_W
    # --detail N keeps shapes N times finer than the 1227px settings would (cleanup, minimum
    # sizes, simplification), down to the input's own pixels; drawn strokes and river
    # tracing still scale with the full width, since those follow the image's line weights.
    ks = max(1.0, k / detail)
    kc = max(1.0, k / min(detail, CLEANUP_DETAIL_MAX))  # cleanup stays coarser, so faint channels close into lines
    length = lambda v: v * k
    area = lambda v: v * ks * ks
    kernel = lambda v, kk=k: max(1, round(v * kk)) | 1  # odd structuring-element size
    # Water is whatever's clearly blue; dark strokes and cliff shadows are land. (Off-map black,
    # which isn't blue either, is taken out next.)
    land = ((b - r < LAND_BLUE) * 255).astype(np.uint8)
    void = off_map(im, length(VOID_GLOW_PX), k * k * MIN_VOID_PX)
    land[void] = 0
    px_m = w / ((X1 - X0) / 100)  # pixels per metre
    # Dark strokes the map draws across rivers (cliff edges, falls) touch water on both sides;
    # count dark pixels next to water as water, so a river stays whole even where it's still
    # connected around the stroke. Dark outline clumps further inland stay land.
    near_water = cv2.dilate((land == 0).astype(np.uint8), DISK(kernel(STROKE_NEAR_M, px_m))) > 0
    land[(im.mean(-1) < STROKE_DARK) & near_water & ~void] = 0
    # Only a light cleanup, so swamp channels, inlets and islets keep their shape; water
    # closed over here (1-2px channels) comes back below as river centre lines.
    land = cv2.morphologyEx(land, cv2.MORPH_OPEN, DISK(kernel(LAND_SPECK_M, px_m)))
    land = cv2.morphologyEx(land, cv2.MORPH_CLOSE, DISK(kernel(WATER_SPECK_PX, kc)))
    land = drop_strokes(land, DISK(kernel(STROKE_M, px_m)))
    # Off-map areas inside the land (the Grass Fields pit) count as land for tracing, so a river
    # running into one ends at its edge rather than making it part of a lake; the void covers it.
    n, comp = cv2.connectedComponents(void.astype(np.uint8), connectivity=8)
    edge = np.unique(np.r_[comp[0], comp[-1], comp[:, 0], comp[:, -1]])
    land[void & ~np.isin(comp, edge)] = 255

    # Every land/water edge: outer rings are coast (islands included), holes are enclosed
    # water (lakes, and rivers wide enough to show both banks).
    contours, hier = cv2.findContours(land, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    # Small pieces cut off by the image's edge are slivers of off-map art, not islands.
    at_edge = lambda c: (c[..., 0].min() <= 1) | (c[..., 1].min() <= 1) | (c[..., 0].max() >= w - 2) | (c[..., 1].max() >= h - 2)
    coast_rings = [c for i, c in enumerate(contours) if hier[0][i][3] == -1 and cv2.contourArea(c) >= area(MIN_ISLAND_PX)
                   and not (at_edge(c) and cv2.contourArea(c) < area(MIN_EDGE_PIECE_PX))]
    lake_rings = [c for i, c in enumerate(contours) if hier[0][i][3] != -1 and cv2.contourArea(c) >= area(MIN_LAKE_PX)]
    # A hole that's mostly off-map (the Grass Fields pit) isn't a lake; the void covers it.
    def mostly_void(c: np.ndarray) -> bool:
        m = np.zeros((h, w), np.uint8); cv2.drawContours(m, [c], -1, 1, cv2.FILLED)
        return void[m > 0].mean() > 0.5
    lake_rings = [c for c in lake_rings if not mostly_void(c)]
    void_mask = cv2.morphologyEx((void * 255).astype(np.uint8), cv2.MORPH_OPEN, DISK(kernel(LAND_SPECK_M, px_m)))
    vcont, _ = cv2.findContours(void_mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    void_rings = [c for c in vcont if cv2.contourArea(c) >= area(MIN_ISLAND_PX)]

    # Rivers: water the land mask swallowed because it's too thin to show two banks.
    # A 1-2px channel blends with the land beside it, so it gets a looser colour test, and
    # closing bridges the gaps that blending leaves before thinning. The centre line runs
    # through all water on the landmass; where it crosses water that already has outlined
    # banks it's dropped, so each line ends on the bank of the lake or wider stretch it joins.
    landmass = np.zeros((h, w), np.uint8)
    cv2.drawContours(landmass, coast_rings, -1, 255, cv2.FILLED)
    faint = ((b > r + RIVER_BLUE) & (landmass > 0)).astype(np.uint8) * 255
    faint = cv2.morphologyEx(faint, cv2.MORPH_CLOSE, DISK(kernel(RIVER_BRIDGE_PX)))
    outlined = cv2.erode(((land == 0) * 255).astype(np.uint8), DISK(3)) > 0  # water more than 1px inside its banks
    rivers = trace_lines(thin(faint > 0) & ~outlined, round(length(MIN_RIVER_PX)))

    def pts(c: np.ndarray, closed: bool) -> list[int]:
        flat: list[int] = []
        for px, py in cv2.approxPolyDP(c, SIMPLIFY_PX * ks, closed).reshape(-1, 2):
            flat += [round((X0 + (px + 0.5) / w * (X1 - X0)) / 100), round((Y0 + (py + 0.5) / h * (Y1 - Y0)) / 100)]
        return flat

    # Points in metres (world cm / 100), flattened [x0, y0, x1, y1, ...].
    data = {'units': 'm', 'coast': [pts(c, True) for c in coast_rings], 'lakes': [pts(c, True) for c in lake_rings],
            'void': [pts(c, True) for c in void_rings],
            'seaGlow': sea_glow(landmass > 0, void, os.path.join(os.path.dirname(out), 'map-sea.png')),
            'rivers': [p for p in (pts(l, False) for l in rivers) if len(p) >= 4]}
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f, separators=(',', ':'))
    n = sum(len(x) for k in ('coast', 'lakes', 'void', 'rivers') for x in data[k]) // 2
    print(f"{len(data['coast'])} coast rings, {len(data['lakes'])} lakes, {len(data['void'])} off-map areas, {len(data['rivers'])} river lines, {n} points -> {out}")

    if preview:
        img = np.full((h, w, 3), 18, np.uint8)
        cv2.polylines(img, coast_rings, True, (200, 200, 200), 1)
        cv2.polylines(img, lake_rings, True, (90, 170, 210), 1)
        cv2.polylines(img, rivers, False, (60, 140, 255), 1)
        Image.fromarray(img).save(preview)


if __name__ == '__main__':
    main()

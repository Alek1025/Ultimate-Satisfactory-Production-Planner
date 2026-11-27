"""
Trace height contours inside the land for the Nodes map into app/ui/map-terrain.json, from the
game's height map.

Usage: python scripts/trace-map-terrain.py <heightmap.hdr> [out.json] [--outline map-outline.json] [--preview preview.png]
Needs: Pillow, numpy, opencv-python, scipy. Uses the calibration in build-heightmap.py.

- contours: lines every CONTOUR_STEP_M metres of the calibrated height (the app draws every
  100 m stronger), grouped by height. Off-map gaps in the height map take the nearest height
  first, so no contour runs along them. Lines are cut to the traced land (coast and lakes from
  the outline, minus off-map areas) here, so the app draws them without a clip path, which is
  slow with this many points; that also drops rings running along the grid's own edge.

Run after trace-map-outline.py, as

  python scripts/trace-map-terrain.py scripts/map-sources/game-heightmap.hdr
"""
import importlib.util
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

spec = importlib.util.spec_from_file_location('build_heightmap', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build-heightmap.py'))
heights = importlib.util.module_from_spec(spec)
spec.loader.exec_module(heights)
X0, X1, Y0, Y1 = heights.X0, heights.X1, heights.Y0, heights.Y1

CONTOUR_PX = 2048        # height grid for contours (3.7 m a pixel, the height map's own resolution)
CONTOUR_STEP_M = 25
CONTOUR_SMOOTH_PX = 2.5  # blur before contouring: the height map's ~1 m steps would otherwise make jagged terraces
CONTOUR_MIN_PX = 20      # drop rings enclosing less than this (area, contour pixels)
CONTOUR_SIMPLIFY_PX = 0.8
CONTOUR_MIN_RUN_PX = 4   # drop pieces shorter than this after cutting to the land


def to_m(c: np.ndarray, size: int) -> list[int]:
    flat: list[int] = []
    for px, py in c.reshape(-1, 2):
        flat += [round((X0 + (px + 0.5) / size * (X1 - X0)) / 100), round((Y0 + (py + 0.5) / size * (Y1 - Y0)) / 100)]
    return flat


def land_mask(outline_path: str) -> np.ndarray:
    """Traced land on the contour grid (coast and lake rings even-odd, minus off-map areas),
    grown a pixel so contours meet the coast line."""
    o = json.load(open(outline_path))
    pix = lambda f: np.round(np.c_[(np.array(f[0::2]) * 100 - X0) / (X1 - X0), (np.array(f[1::2]) * 100 - Y0) / (Y1 - Y0)] * CONTOUR_PX - 0.5).astype(np.int32)
    def even_odd(rings):
        m = np.zeros((CONTOUR_PX, CONTOUR_PX), np.uint8)
        for r in rings:
            t = np.zeros_like(m); cv2.fillPoly(t, [pix(r)], 1); m ^= t
        return m
    land = even_odd(o['coast'] + o['lakes']) & (1 - even_odd(o['void']))
    land = cv2.dilate(land, np.ones((3, 3), np.uint8))
    land[0, :] = land[-1, :] = land[:, 0] = land[:, -1] = 0
    return land > 0


def cut(chain: np.ndarray, keep: np.ndarray) -> list[np.ndarray]:
    """Split a closed pixel chain into the runs where `keep` is set."""
    ok = keep[chain[:, 1], chain[:, 0]]
    if ok.all():
        return [np.vstack([chain, chain[:1]])]
    start = int(np.argmin(ok))  # begin at a cut, so a run never wraps
    chain, ok = np.roll(chain, -start, 0), np.roll(ok, -start)
    edges = np.flatnonzero(np.diff(np.r_[0, ok.astype(np.int8), 0]))
    return [chain[a:b] for a, b in zip(edges[::2], edges[1::2]) if b - a >= CONTOUR_MIN_RUN_PX]


def contours(h: np.ndarray, land: np.ndarray) -> list[dict]:
    z, valid = heights.world_heights(h, CONTOUR_PX)
    _, (iy, ix) = ndimage.distance_transform_edt(~valid, return_indices=True)
    z = cv2.GaussianBlur(z[iy, ix].astype(np.float32), (0, 0), CONTOUR_SMOOTH_PX)
    out = []
    lo = int(np.floor(z.min() / CONTOUR_STEP_M)) + 1
    hi = int(np.ceil(z.max() / CONTOUR_STEP_M))
    for k in range(lo, hi):
        level = k * CONTOUR_STEP_M
        cs, _ = cv2.findContours((z >= level).astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
        lines = [to_m(cv2.approxPolyDP(run.reshape(-1, 1, 2), CONTOUR_SIMPLIFY_PX, False), CONTOUR_PX)
                 for c in cs if cv2.contourArea(c) >= CONTOUR_MIN_PX for run in cut(c.reshape(-1, 2), land)]
        if lines:
            out.append({'z': level, 'lines': lines})
    return out


def main() -> None:
    args = sys.argv[1:]
    preview = None
    if '--preview' in args:
        i = args.index('--preview'); preview = args[i + 1]; del args[i:i + 2]
    outline_path = 'app/ui/map-outline.json'
    if '--outline' in args:
        i = args.index('--outline'); outline_path = args[i + 1]; del args[i:i + 2]
    hdr = args[0]
    out = args[1] if len(args) > 1 else 'app/ui/map-terrain.json'
    data = {'units': 'm', 'contourStep': CONTOUR_STEP_M, 'contours': contours(heights.load(hdr), land_mask(outline_path))}
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f, separators=(',', ':'))
    cp = sum(len(r) // 2 for c in data['contours'] for r in c['lines'])
    print(f"{sum(len(c['lines']) for c in data['contours'])} contour lines ({cp} points) -> {out}")

    if preview:
        size = 4096
        img = np.full((size, size, 3), 18, np.uint8)
        pix = lambda f: np.round(np.c_[(np.array(f[0::2]) * 100 - X0) / (X1 - X0), (np.array(f[1::2]) * 100 - Y0) / (Y1 - Y0)] * size).astype(np.int32)
        for c in data['contours']:
            cv2.polylines(img, [pix(r) for r in c['lines']], False, (90, 96, 104) if c['z'] % 100 == 0 else (48, 53, 59), 1)
        Image.fromarray(img).save(preview)


if __name__ == '__main__':
    main()

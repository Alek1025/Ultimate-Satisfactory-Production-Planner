"""
Turn the game's height map into app/ui/map-height.png, a small grid of ground heights the Nodes
map reads to show the height under the cursor.

Usage: python scripts/build-heightmap.py <heightmap.hdr> [out.png] [--fit nodes.json]
Needs: numpy, opencv-python, scipy (for --fit).

The source is the game's height map (2048px HDR, one channel, 0..1, 0 where there's no data).
It has no units and sits a few pixels off the map, so both are calibrated against resource
nodes, which sit on the ground: SCALE_M/OFFSET_M turn a value into the game's Z in metres, and
AFFINE maps a world pixel (the 2048px grid over world X -324698.832..425301.832, Y -375000..375000
cm) to the height map's pixel (it turns out to be within 0.2% of the identity). Against the 625
nodes of a default 1.2 save, half sit within 1.3 m of the calibrated height and 90% within
4.7 m; the rest are mostly in caves, under the surface the map records.

--fit takes a JSON array of node positions [[x, y, z], ...] in cm (the save summary's
nodes[].position), refits all of these and prints them to paste below.

Output: OUT_PX square, world-aligned, north up. Each pixel holds Z + 1000 in whole metres as a
16-bit number, red the high byte and green the low; 0 means no data (off the map).
"""
import json
import sys

import cv2
import numpy as np

X0, X1 = -324698.832, 425301.832
Y0, Y1 = -375000.0, 375000.0
SCALE_M = 987.098      # metres per unit of height-map value
OFFSET_M = -517.549    # metres at value 0
AFFINE = [0.999051374, 0.000627777897, 0.00121842339, -0.00135972212, 1.00190692, 0.00131437505]
OUT_PX = 1024          # 7.3 m a pixel; plenty for a readout
NO_DATA = 0.01         # values below this are off the map


def load(path: str) -> np.ndarray:
    h = cv2.imread(path, cv2.IMREAD_ANYDEPTH | cv2.IMREAD_ANYCOLOR)
    if h is None:
        sys.exit(f'cannot read {path}')
    return (h[..., 0] if h.ndim == 3 else h).astype(np.float32)


def world_heights(h: np.ndarray, size: int) -> tuple[np.ndarray, np.ndarray]:
    """Calibrated ground height in metres on a size x size grid over the world square, and
    where it's valid (no data wherever any height-map pixel blended in had none, so the coast
    doesn't dip toward OFFSET_M)."""
    # For each output pixel centre, the matching height-map pixel (AFFINE works in the source's
    # own pixel grid; OpenCV samples pixel centres at integer coordinates).
    s = h.shape[0] / size
    a = AFFINE
    m = np.array([[a[0] * s, a[1] * s, a[0] * s / 2 + a[1] * s / 2 + a[2] - 0.5],
                  [a[3] * s, a[4] * s, a[3] * s / 2 + a[4] * s / 2 + a[5] - 0.5]], np.float32)
    flags = cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP
    hh = cv2.warpAffine(h, m, (size, size), flags=flags, borderValue=0)
    valid = cv2.warpAffine((h >= NO_DATA).astype(np.float32), m, (size, size), flags=flags, borderValue=0) > 0.999
    return hh * SCALE_M + OFFSET_M, valid


def fit(h: np.ndarray, nodes_path: str) -> None:
    from scipy import ndimage, optimize
    p = np.array(json.load(open(nodes_path)), float)
    n = h.shape[0]
    u = (p[:, 0] - X0) / (X1 - X0) * n
    v = (p[:, 1] - Y0) / (Y1 - Y0) * n
    z = p[:, 2] / 100
    hs = cv2.GaussianBlur(h.astype(np.float64), (0, 0), 1.0)

    def heights(q):
        return ndimage.map_coordinates(hs, [q[3] * u + q[4] * v + q[5] - 0.5, q[0] * u + q[1] * v + q[2] - 0.5], order=1, mode='nearest')

    def resid(q):
        a = np.c_[heights(q), np.ones(len(z))]
        return z - a @ np.linalg.lstsq(a, z, rcond=None)[0]

    q = optimize.least_squares(resid, [1, 0, 0, 0, 1, 0], loss='soft_l1', f_scale=5, diff_step=1e-3).x
    a = np.c_[heights(q), np.ones(len(z))]
    r = z - a @ np.linalg.lstsq(a, z, rcond=None)[0]
    keep = np.abs(r) < np.percentile(np.abs(r), 80)  # refit the scale on the nodes that sit on the surface
    scale, offset = np.linalg.lstsq(a[keep], z[keep], rcond=None)[0]
    r = np.abs(z - a @ [scale, offset])
    print(f'SCALE_M = {scale:.3f}\nOFFSET_M = {offset:.3f}\nAFFINE = {[float(f"{x:.9g}") for x in q]}')
    print(f'{len(z)} nodes: median {np.median(r):.1f} m, 90% within {np.percentile(r, 90):.1f} m')


def main() -> None:
    args = sys.argv[1:]
    nodes = None
    if '--fit' in args:
        i = args.index('--fit'); nodes = args[i + 1]; del args[i:i + 2]
    h = load(args[0])
    if nodes:
        fit(h, nodes)
        return
    out = args[1] if len(args) > 1 else 'app/ui/map-height.png'
    zm, valid = world_heights(h, OUT_PX)
    z = np.where(valid, np.round(zm + 1000), 0).astype(np.uint16)
    rgb = np.zeros((OUT_PX, OUT_PX, 3), np.uint8)
    rgb[..., 0] = z >> 8
    rgb[..., 1] = z & 255
    cv2.imwrite(out, rgb[..., ::-1], [cv2.IMWRITE_PNG_COMPRESSION, 9])
    print(f'{OUT_PX}px, Z {int(z[valid].min()) - 1000}..{int(z[valid].max()) - 1000} m -> {out}')


if __name__ == '__main__':
    main()

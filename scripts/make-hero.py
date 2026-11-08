"""
Renders the landing page background: a sunrise over a sea of clouds. Fully procedural (no source photo), so the image
is original to this project. Re-run to regenerate:

    python scripts/make-hero.py            # writes public/brand/hero.jpg
    python scripts/make-hero.py --seed 7   # a different cloud arrangement

To use your own artwork instead, just replace public/brand/hero.jpg (any 16:9 image, ~1920x1080 or larger).
"""
import argparse
import os

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates

ap = argparse.ArgumentParser()
ap.add_argument('--seed', type=int, default=11)
ap.add_argument('--width', type=int, default=2048)
ap.add_argument('--out', default=os.path.join('public', 'brand', 'hero.jpg'))
args = ap.parse_args()

W = args.width
H = int(round(W * 9 / 16))
HY = int(H * 0.455)  # horizon row
SUN_X, SUN_Y = 0.80 * W, 0.375 * H
rng = np.random.default_rng(args.seed)

smooth = lambda a, b, x: (lambda t: t * t * (3 - 2 * t))(np.clip((x - a) / (b - a), 0, 1))
mix = lambda a, b, t: a + (b - a) * t[..., None]


def make_grids(n_oct, size=256):
    return [rng.random((size, size)).astype(np.float32) for _ in range(n_oct)]


def fbm(U, V, grids, foot=None, base_freq=1.0, gain=0.56):
    """Value-noise fractal sum. `foot` (pixel footprint in noise units) fades octaves the screen can't resolve."""
    total = np.zeros_like(U, dtype=np.float32)
    amp, norm, f = 1.0, 0.0, base_freq
    for i, g in enumerate(grids):
        w = 1.0 if foot is None else np.clip(1.9 - f * foot, 0, 1)
        n = map_coordinates(g, [(V * f + i * 31.7) % g.shape[0], (U * f + i * 17.3) % g.shape[1]], order=3, mode='grid-wrap')
        total += (amp * w) * n
        norm += amp * (w if np.isscalar(w) else w)
        amp *= gain
        f *= 2.03
    return total / np.maximum(norm, 1e-6)


# ---------------------------------------------------------------- sky
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
t = np.clip(yy / HY, 0, 1)  # 0 = top of frame, 1 = horizon
stops = [  # (t, rgb) from the zenith down to the horizon
    (0.00, (84, 92, 128)),
    (0.38, (118, 108, 140)),
    (0.66, (178, 126, 128)),
    (0.86, (240, 150, 84)),
    (1.00, (255, 186, 98)),
]
sky = np.zeros((H, W, 3), np.float32)
for c in range(3):
    sky[..., c] = np.interp(t, [s[0] for s in stops], [s[1][c] for s in stops])

# warm bloom around the sun, and a cooler sky on the far side of it
d_sun = np.hypot((xx - SUN_X) / W, (yy - SUN_Y) / W * 1.15)
bloom = np.exp(-(d_sun / 0.30) ** 1.6)
sky = mix(sky, np.array([255, 196, 120], np.float32), bloom * 0.75)
core = np.exp(-(d_sun / 0.045) ** 1.5)
sky = mix(sky, np.array([255, 240, 214], np.float32), np.clip(core * 1.1, 0, 1))
left_cool = smooth(0.0, 0.85, (SUN_X - xx) / W) * (1 - t * 0.5)
sky = mix(sky, np.array([100, 104, 142], np.float32), left_cool * 0.35)

# thin, stretched high clouds in the upper sky
gs = make_grids(6)
U = xx / 520.0
V = yy / 46.0
streaks = fbm(U, V, gs, base_freq=0.9)
streaks = smooth(0.52, 0.78, streaks) * smooth(0.0, 0.55, t) * (1 - smooth(0.78, 1.0, t))
warm = np.clip(0.35 + bloom * 0.9, 0, 1)
cirrus_col = mix(np.broadcast_to(np.array([200, 178, 190], np.float32), sky.shape).copy(), np.array([255, 205, 150], np.float32), warm)
sky = mix(sky, cirrus_col, streaks * 0.5)

# ---------------------------------------------------------------- cloud sea
rows = H - HY
z = np.clip((yy[HY:] - HY + 1.0) / rows, 1e-3, 1.0)  # 0 at the horizon, 1 at the bottom edge
C = 0.13
v = 1.0 / (z + C)                                      # distance
u = (xx[HY:] - W * 0.5) / W * v * 1.9
KU, KV = 2.1, 2.1
Uc, Vc = u * KU, v * KV
foot = np.maximum(KU * v / W * 1.9, KV / ((z + C) ** 2 * rows)) * 1.0
foot = np.minimum(foot, 3.0)

grids = make_grids(8)
wgrid = make_grids(3)
warp_u = fbm(Uc * 0.55, Vc * 0.55, wgrid[:1] * 2, base_freq=0.7) - 0.5
warp_v = fbm(Uc * 0.55 + 9.1, Vc * 0.55 + 4.3, wgrid[1:2] * 2, base_freq=0.7) - 0.5
Uw, Vw = Uc + warp_u * 0.85, Vc + warp_v * 0.85

base = fbm(Uw, Vw, grids, foot=foot, base_freq=0.5)
puff = 1.0 - np.abs(2.0 * fbm(Uw * 2.6 + 3.3, Vw * 2.6 + 7.7, grids, foot=foot, base_freq=0.5) - 1.0)
dens = np.clip(base * 0.60 + puff * 0.46 - 0.04, 0, 1)
# light comes from the sun side: sample the density a little towards it to find what is exposed
sx = np.clip((SUN_X - xx[HY:]) / W, -1, 1)
off_u = 0.16 * np.tanh(3.0 * sx)
off_v = -0.12
base_s = fbm(Uw + off_u, Vw + off_v, grids, foot=foot, base_freq=0.5)
puff_s = 1.0 - np.abs(2.0 * fbm((Uw + off_u) * 2.6 + 3.3, (Vw + off_v) * 2.6 + 7.7, grids, foot=foot, base_freq=0.5) - 1.0)
dens_sun = np.clip(base_s * 0.60 + puff_s * 0.46 - 0.04, 0, 1)
exposure = np.clip(0.50 + (dens - dens_sun) * 5.6, 0, 1)

body = smooth(0.30, 0.58, dens)           # where there is cloud rather than gaps
ridge = smooth(0.42, 0.72, dens)          # denser cores

shadow = np.array([84, 80, 132], np.float32)
mid = np.array([184, 124, 144], np.float32)
lit = np.array([250, 156, 96], np.float32)
hot = np.array([255, 206, 142], np.float32)

near_sun = np.exp(-(((xx[HY:] - SUN_X) / (W * 0.55)) ** 2))
shade = np.clip(exposure * (0.45 + 0.62 * near_sun) + (ridge - 0.45) * 0.30 + 0.06, 0, 1)
col = mix(np.broadcast_to(shadow, (rows, W, 3)).copy(), np.broadcast_to(mid, (rows, W, 3)).copy(), smooth(0.05, 0.55, shade))
col = mix(col, np.broadcast_to(lit, (rows, W, 3)).copy(), smooth(0.40, 0.92, shade))
col = mix(col, np.broadcast_to(hot, (rows, W, 3)).copy(), smooth(0.86, 1.0, shade) * (0.25 + 0.65 * near_sun))

# the gaps between clouds show a soft hazy floor
floor_col = mix(np.broadcast_to(np.array([104, 90, 138], np.float32), (rows, W, 3)).copy(), np.array([214, 134, 96], np.float32), near_sun * 0.6)
alpha = 0.30 + 0.70 * body
col = mix(floor_col, col, alpha)

# atmospheric perspective: far clouds dissolve into the glowing horizon, near ones keep their contrast
horizon_col = mix(np.broadcast_to(np.array([252, 180, 104], np.float32), (rows, W, 3)).copy(), np.array([255, 226, 170], np.float32), near_sun * 0.8)
fog = np.clip((1.0 - z) ** 7.0, 0, 1) * 0.92
col = mix(col, horizon_col, fog)

img = sky.copy()
img[HY:] = col

# sun glare on top of everything, strongest near the horizon haze
glare = np.exp(-(d_sun / 0.16) ** 1.4)
img = img + (np.array([255, 190, 110], np.float32) * glare[..., None] * 0.20)
img = mix(img, np.array([255, 246, 228], np.float32), np.clip(core * 1.3, 0, 1) * 0.9)

# vignette: darken the top corners and the very bottom like a lens would
vx = (xx - W * 0.55) / (W * 0.75)
vy = (yy - H * 0.5) / (H * 0.8)
vig = 1.0 - 0.38 * np.clip(vx ** 2 * 0.8 + vy ** 2 * 0.9, 0, 1) ** 1.2
img = img * vig[..., None]

# tiny blur + grain so it reads as a photograph, not a render
img = np.stack([gaussian_filter(img[..., c], 1.0) for c in range(3)], axis=-1)
img = img + rng.normal(0, 1.6, img.shape).astype(np.float32)
img = np.clip(img, 0, 255).astype(np.uint8)

os.makedirs(os.path.dirname(args.out), exist_ok=True)
Image.fromarray(img).save(args.out, quality=84, optimize=True, progressive=True)
print(f'wrote {args.out}  {W}x{H}  {os.path.getsize(args.out) // 1024} KB')

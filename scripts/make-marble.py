"""
Renders the ELYONPAD backdrop: black-teal marble with thin cyan and gold veins (the logo's own black marble, tinted with the
Elysium palette). Fully procedural, so the image is original to this project. Re-run to regenerate:

    python scripts/make-marble.py             # writes public/brand/marble.jpg
    python scripts/make-marble.py --seed 5    # a different vein pattern
"""
import argparse
import os

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

ap = argparse.ArgumentParser()
ap.add_argument('--seed', type=int, default=21)
ap.add_argument('--width', type=int, default=1920)
ap.add_argument('--out', default=os.path.join('public', 'brand', 'marble.jpg'))
args = ap.parse_args()

W = args.width
H = int(round(W * 9 / 16))
rng = np.random.default_rng(args.seed)


def field(sigma, shape=(H, W)):
    f = gaussian_filter(rng.standard_normal(shape).astype(np.float32), sigma, mode='wrap')
    return f / (f.std() + 1e-6)


def fbm(base, octaves=4):
    out = np.zeros((H, W), np.float32)
    amp = 1.0
    for i in range(octaves):
        out += amp * field(base / (2 ** i))
        amp *= 0.5
    return out / 1.6


# classic marble: sine bands pushed around by turbulence (|noise| octaves). The thin bright line of each band's crest becomes a vein.
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)


def turbulence(base, octaves):
    out = np.zeros((H, W), np.float32)
    amp = 1.0
    for i in range(octaves):
        out += amp * np.abs(field(base / (2 ** i)))
        amp *= 0.55
    return out


def vein_layer(freq, angle, warp, sharp, base_scale):
    u = (xx / W) * np.cos(angle) + (yy / H) * np.sin(angle) * 0.56
    t = turbulence(base_scale, 6)
    band = 1.0 - np.abs(np.sin(np.pi * (u * freq + warp * t)))
    return band ** sharp


def strength(base):
    return np.clip(0.5 + 0.95 * field(base), 0.1, 1.0)


major = vein_layer(2.6, 0.62, 1.7, 90, 240) * strength(300)
minor = vein_layer(6.5, 0.35, 1.2, 140, 120) * 0.5 * strength(160)
hair = vein_layer(14.0, 0.8, 0.9, 220, 60) * 0.22
gold = vein_layer(1.9, 1.05, 2.0, 110, 300) * 0.9 * strength(340)

# base: deep teal-black with a soft lift toward the upper middle
base = np.zeros((H, W, 3), np.float32)
top = np.array([10, 40, 48], np.float32) / 255
bot = np.array([3, 18, 22], np.float32) / 255
t = (yy / H)[..., None]
base[:] = top * (1 - t) + bot * t
cloud = gaussian_filter(rng.standard_normal((H, W)).astype(np.float32), 90) * 0.5
base += (cloud[..., None] * np.array([0.020, 0.030, 0.034], np.float32))

cyan = np.array([150, 224, 242], np.float32) / 255
warm = np.array([236, 190, 96], np.float32) / 255
vein = (major * 0.9 + minor * 0.7 + hair * 0.6)[..., None] * cyan + (gold * 0.55)[..., None] * warm
img = base + gaussian_filter(vein, (0.6, 0.6, 0)) * 1.9

# vignette keeps the edges quiet so text on top stays readable
vx = (xx / W - 0.5) * 2
vy = (yy / H - 0.5) * 2
vig = np.clip(1.12 - 0.5 * (vx ** 2 + vy ** 2), 0.35, 1.0)[..., None]
img = np.clip(img * vig, 0, 1)

os.makedirs(os.path.dirname(args.out), exist_ok=True)
Image.fromarray((img * 255).astype(np.uint8)).save(args.out, quality=80, optimize=True, progressive=True)
print('wrote', args.out, os.path.getsize(args.out) // 1024, 'KB')

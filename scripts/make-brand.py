"""
Builds the ELYONPAD brand assets from the master logo (elyonpad_logo.jpg in the project root: gold mark on black marble).

    python scripts/make-brand.py

Writes into public/:
    brand/logo.png            512px transparent mark (gold on alpha), used on the opening screen
    brand/logo-sm.png         128px transparent mark, used in the header
    brand/og.jpg              1200x630 social preview
    favicon.ico, favicon-16.png, favicon-32.png, apple-touch-icon.png

The transparent mark is made by treating the black marble as "alpha = brightness" (exactly how gold-on-black composites
over any dark surface) and masking away everything outside the emblem, so the marble veins in the corners are dropped.
"""
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.join(os.path.dirname(__file__), '..')
SRC = os.path.join(ROOT, 'elyonpad_logo.jpg')
OUT = os.path.join(ROOT, 'public')
BG = (4, 24, 28)  # --bg #04181C

src = Image.open(SRC).convert('RGB')
W, H = src.size
a = np.asarray(src).astype(np.float32) / 255.0

# brightness -> alpha, then un-premultiply so the colour stays saturated gold instead of dimming at the glow edges
mx = a.max(axis=2)
alpha = np.clip((mx - 0.045) / (0.62 - 0.045), 0, 1) ** 0.85
alpha = np.where(mx > 0.62, 1.0, alpha)
rgb = np.clip(a / np.maximum(mx, 1e-4)[..., None], 0, 1)
rgb = np.where(mx[..., None] > 0.62, a, rgb)

# keep only the emblem: an elliptical window around it with a soft edge (drops the marble veins in the corners)
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
cx, cy = W * 0.497, H * 0.46
rx, ry = W * 0.40, H * 0.47
d = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
window = np.clip((1.0 - d) / 0.12, 0, 1)
alpha *= window

rgba = np.dstack([rgb, alpha])
mark = Image.fromarray((rgba * 255).astype(np.uint8), 'RGBA')

# crop to the emblem's bounding box, then pad to a square with a little breathing room
bbox = mark.getchannel('A').point(lambda v: 255 if v > 12 else 0).getbbox()
mark = mark.crop(bbox)
side = int(max(mark.size) * 1.06)
sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
sq.paste(mark, ((side - mark.width) // 2, (side - mark.height) // 2), mark)

os.makedirs(os.path.join(OUT, 'brand'), exist_ok=True)
sq.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, 'brand', 'logo.png'), optimize=True)
sq.resize((128, 128), Image.LANCZOS).save(os.path.join(OUT, 'brand', 'logo-sm.png'), optimize=True)


def on_bg(size, pad):
    """The mark centred on the brand background (favicons / touch icon, where transparency is not honoured)."""
    img = Image.new('RGB', (size, size), BG)
    inner = int(size * (1 - 2 * pad))
    m = sq.resize((inner, inner), Image.LANCZOS)
    img.paste(m, ((size - inner) // 2, (size - inner) // 2), m)
    return img


on_bg(180, 0.10).save(os.path.join(OUT, 'apple-touch-icon.png'), optimize=True)
fav = {s: on_bg(s, 0.04 if s <= 32 else 0.08) for s in (16, 32, 48, 64)}
fav[16].save(os.path.join(OUT, 'favicon-16.png'), optimize=True)
fav[32].save(os.path.join(OUT, 'favicon-32.png'), optimize=True)
fav[64].save(os.path.join(OUT, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])

# social preview: marble backdrop (if generated) + mark + wordmark
og = Image.new('RGB', (1200, 630), BG)
marble = os.path.join(OUT, 'brand', 'marble.jpg')
if os.path.exists(marble):
    m = Image.open(marble).convert('RGB')
    r = max(1200 / m.width, 630 / m.height)
    m = m.resize((int(m.width * r), int(m.height * r)), Image.LANCZOS)
    og.paste(m.crop((0, 0, 1200, 630)))
glow = Image.new('RGBA', (1200, 630), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse((90, 40, 560, 590), fill=(224, 169, 58, 70))
og = Image.alpha_composite(og.convert('RGBA'), glow.filter(ImageFilter.GaussianBlur(70)))
mk = sq.resize((470, 470), Image.LANCZOS)
og.alpha_composite(mk, (95, 80))


def font(names, size):
    for n in names:
        for base in ('C:/Windows/Fonts', '/usr/share/fonts/truetype/dejavu', '/Library/Fonts'):
            p = os.path.join(base, n)
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
    return ImageFont.load_default()


d = ImageDraw.Draw(og)
d.text((600, 215), 'ELYONPAD', font=font(['segoeuib.ttf', 'arialbd.ttf', 'DejaVuSans-Bold.ttf'], 92), fill=(248, 247, 244))
d.text((604, 330), 'Launchpad for the Elysium ecosystem', font=font(['segoeui.ttf', 'arial.ttf', 'DejaVuSans.ttf'], 31), fill=(159, 177, 179))
d.text((604, 392), 'Launch and trade on Elysium and Solana', font=font(['segoeui.ttf', 'arial.ttf', 'DejaVuSans.ttf'], 27), fill=(224, 169, 58))
og.convert('RGB').save(os.path.join(OUT, 'brand', 'og.jpg'), quality=88, optimize=True)
print('brand assets written to', OUT)

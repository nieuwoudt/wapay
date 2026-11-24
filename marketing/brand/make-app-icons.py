"""
App icons for the installable WaPay web app (2026-11-24).

The W-mark is CUT from the canonical raster master (wapay-logo-1024.png, the
real logo; see BRAND.md) and set on a white square. Nothing is redrawn and no
colour is changed. The master is the only source: no vector exists.

Outputs, into public/brand/:
  app-icon-192.png, app-icon-512.png   the mark at 62% of the width ("any")
  app-icon-180.png                     the same, for the iPhone home screen
  app-icon-maskable-512.png            the mark at 46% of the width, inside the
                                       safe zone Android may crop to a circle

Run from the repository root:  python3 marketing/brand/make-app-icons.py
Needs Pillow.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MASTER = ROOT / 'marketing' / 'brand' / 'wapay-logo-1024.png'
OUT = ROOT / 'public' / 'brand'

# Where the mark sits on the 1024 master (the two strokes and the dot, without the wordmark).
MARK_BOX = (61, 389, 344, 574)
WHITE = (255, 255, 255, 255)


def mark():
    src = Image.open(MASTER).convert('RGBA').crop(MARK_BOX)
    # The master carries faint stray alpha outside the artwork: drop anything nearly transparent.
    r, g, b, a = src.split()
    a = a.point(lambda v: 0 if v < 8 else v)
    return Image.merge('RGBA', (r, g, b, a))


def icon(size, share):
    m = mark()
    width = round(size * share)
    height = round(m.height * width / m.width)
    m = m.resize((width, height), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), WHITE)
    canvas.alpha_composite(m, ((size - width) // 2, (size - height) // 2))
    return canvas.convert('RGB')


if __name__ == '__main__':
    for name, size, share in [
        ('app-icon-192.png', 192, 0.62),
        ('app-icon-512.png', 512, 0.62),
        ('app-icon-180.png', 180, 0.62),
        ('app-icon-maskable-512.png', 512, 0.46),
    ]:
        icon(size, share).save(OUT / name, optimize=True)
        print(name, size)

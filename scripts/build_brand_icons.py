#!/usr/bin/env python3
"""Derive the raster app icons from the delivered brand artwork.

WHY A SCRIPT AND NOT A ONE-OFF. `apple-touch-icon.png` and `favicon.ico` are
the fallbacks that decide how the app looks on an iOS home screen and in a
Safari tab, where the SVG favicon is ignored. They are DERIVED from
`static/icons/brand-512-white.png`, so when the mark changes they must be
re-derived rather than redrawn: this file is how.

    python3 scripts/build_brand_icons.py

Pillow is required and is NOT in the server's virtualenv (it is not an app
dependency and there is no reason to make it one). Run this on a workstation
that has it and commit the two files it writes.

THE CHOICES, so they are not re-guessed [INF-B4]:

  * the canvas is #09090b, the `glass` theme's --bg-primary. An iOS home-screen
    icon cannot be transparent -- iOS composites it onto white and the white
    mark would vanish -- so the mark needs a plate, and the product's own
    darkest surface is the honest one;
  * the mark is inset to 78% of the square. iOS applies its own rounded-corner
    mask, and the artwork is itself a rounded square: at 100% its corners would
    be shaved by that mask;
  * the .ico carries 16/32/48 because that is what desktop browsers and Windows
    shortcuts ask for, and it is built from the GLYPH, not the plate: an .ico
    carries no media query, so a tab icon that is a solid dark square reads as
    a black blob on a light strip (owner,: "favicon bi background
    den xong con co ca vien cuc ky xau"). The glyph is drawn in the product
    accent, which is legible on a light strip and a dark one alike. Its 512px
    raster is committed as brand-glyph-512.png because Pillow cannot rasterise
    SVG; regenerate it with scripts/rasterise_glyph.mjs when the mark changes.
"""
import pathlib
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover - the message IS the behaviour
    sys.exit('Pillow is required: python3 -m pip install Pillow')

ICONS = pathlib.Path(__file__).resolve().parent.parent / 'static' / 'icons'
SOURCE = ICONS / 'brand-512-white.png'
GLYPH = ICONS / 'brand-glyph-512.png'
CANVAS = (9, 9, 11, 255)          # glass --bg-primary, #09090b
INSET = 0.78                      # room for the mask iOS applies itself


def build():
    mark = Image.open(SOURCE).convert('RGBA')
    size = mark.width
    plate = Image.new('RGBA', (size, size), CANVAS)
    inner = int(size * INSET)
    offset = (size - inner) // 2
    plate.alpha_composite(mark.resize((inner, inner), Image.LANCZOS), (offset, offset))
    flat = plate.convert('RGB')

    touch = ICONS / 'apple-touch-icon.png'
    flat.resize((180, 180), Image.LANCZOS).save(touch, optimize=True)

    ico = ICONS / 'favicon.ico'
    glyph = Image.open(GLYPH).convert('RGBA')
    glyph.save(ico, sizes=[(16, 16), (32, 32), (48, 48)])

    for path in (touch, ico):
        print(f'{path.relative_to(ICONS.parent.parent)}  {path.stat().st_size} bytes')


if __name__ == '__main__':
    build()

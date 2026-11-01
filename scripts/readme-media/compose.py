"""Compose the README's live media from the raw captures.

    python3 scripts/readme-media/compose.py RAW_DIR assets/

RAW_DIR is what capture.mjs wrote. Writes handoff.gif, touch.png,
phone-landscape.png and desktop.png. Pillow is a workstation tool here, as in
scripts/build_brand_icons.py; the caption font is the first of FONTS found.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

M, O = Path(sys.argv[1]), Path(sys.argv[2])
BG, FG, MUTED, ACCENT = (9, 9, 11), (244, 244, 245), (161, 161, 170), (77, 157, 255)
FONTS = ('/System/Library/Fonts/SFNS.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
FONT = next((f for f in FONTS if Path(f).exists()), None)
font = lambda size: ImageFont.truetype(FONT, size) if FONT else ImageFont.load_default(size)

def fit(img, w=None, h=None):
    if w: return img.resize((w, round(img.height * w / img.width)), Image.LANCZOS)
    return img.resize((round(img.width * h / img.height), h), Image.LANCZOS)

def rounded(img, r):
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *img.size), r, fill=255)
    out = Image.new('RGBA', img.size); out.paste(img, (0, 0), mask); return out

def off(size, label=None):
    im = Image.new('RGB', size, (18, 18, 22))
    if label:
        d = ImageDraw.Draw(im); f = font(22)
        w = d.textlength(label, font=f)
        d.text(((size[0] - w) / 2, size[1] / 2 - 12), label, fill=MUTED, font=f)
    return im

# ---- the hand-off GIF ------------------------------------------------------
W, H, CAP = 1200, 650, 78
LAP, PH = (800, 500), (231, 500)
def frame(step, text, laptop, phone, lap_on, ph_on):
    c = Image.new('RGB', (W, H), BG); d = ImageDraw.Draw(c)
    d.rounded_rectangle((40, 22, 82, 64), 10, fill=ACCENT)
    num = str(step); f = font(26)
    d.text((61 - d.textlength(num, font=f) / 2, 27), num, fill=BG, font=f)
    d.text((100, 26), text, fill=FG, font=font(30))
    lx, py = 40, CAP + 22
    lap = laptop if lap_on else off(LAP, 'laptop closed')
    ph = phone if ph_on else off(PH, '')
    c.paste(rounded(lap, 14), (lx, py), rounded(lap, 14))
    d.rounded_rectangle((lx - 3, py - 3, lx + LAP[0] + 3, py + LAP[1] + 3), 16, outline=(63, 63, 70), width=3)
    px = W - 40 - PH[0]
    c.paste(rounded(ph, 22), (px, py), rounded(ph, 22))
    d.rounded_rectangle((px - 4, py - 4, px + PH[0] + 4, py + PH[1] + 4), 26, outline=(63, 63, 70), width=4)
    d.text((lx, py + LAP[1] + 10), 'PC', fill=MUTED, font=font(18))
    d.text((px, py + PH[1] + 10), 'Phone', fill=MUTED, font=font(18))
    return c

lap = lambda n: Image.open(M / f'{n}.png').convert('RGB').resize(LAP, Image.LANCZOS)
ph = lambda n: fit(Image.open(M / f'{n}.png').convert('RGB'), h=PH[1]).crop((0, 0, *PH))
blank_l, blank_p = off(LAP), off(PH)
frames = [
    (frame(1, 'Start a long build on your PC', lap('d1-desk-build'), blank_p, True, False), 2600),
    (frame(2, 'Close the laptop. The build keeps running', blank_l, blank_p, False, False), 1800),
    (frame(3, 'Open SSHDeck on your phone: same session, still going', blank_l, ph('p1-phone-continues'), False, True), 2800),
    (frame(4, 'Type with touch. The line updates as you type', blank_l, ph('p2-phone-composer'), False, True), 2400),
    (frame(5, 'Send', blank_l, ph('p3-phone-sent'), False, True), 2200),
    (frame(6, 'Back at your desk, everything you did is there', lap('d2-desk-back'), blank_p, True, False), 3400),
]
pal = frames[0][0].quantize(colors=128, method=Image.MEDIANCUT)
imgs = [f.quantize(palette=pal, dither=Image.NONE) for f, _ in frames]
imgs[0].save(O / 'handoff.gif', save_all=True, append_images=imgs[1:],
             duration=[ms for _, ms in frames], loop=0, optimize=True)

# ---- the touch tour --------------------------------------------------------
shots = [('p4-phone-keypad', 'Composer and terminal keys'), ('p5-phone-link', 'Tap a link: Open or Copy'),
         ('p7-phone-files', 'Files beside the terminal'), ('p8-phone-files-browser', 'Full-screen file browser')]
PW, PHh, GAP, LAB = 300, 649, 28, 54
tour = Image.new('RGB', (len(shots) * PW + (len(shots) + 1) * GAP, PHh + LAB + GAP * 2), BG)
d = ImageDraw.Draw(tour)
for i, (n, label) in enumerate(shots):
    x = GAP + i * (PW + GAP)
    im = fit(Image.open(M / f'{n}.png').convert('RGB'), w=PW)
    tour.paste(rounded(im, 26), (x, GAP), rounded(im, 26))
    d.rounded_rectangle((x - 3, GAP - 3, x + PW + 3, GAP + im.height + 3), 28, outline=(63, 63, 70), width=3)
    f = font(21); w = d.textlength(label, font=f)
    d.text((x + (PW - w) / 2, GAP + PHh + 16), label, fill=FG, font=f)
tour.save(O / 'touch.png', optimize=True)

land = fit(Image.open(M / 'p9-phone-landscape-split.png').convert('RGB'), w=1000)
land.save(O / 'phone-landscape.png', optimize=True)
fit(Image.open(M / 'd4-desk-split-files.png').convert('RGB'), w=1600).save(O / 'desktop.png', optimize=True)
for name in ('handoff.gif', 'touch.png', 'phone-landscape.png', 'desktop.png'):
    p = O / name
    print(p, p.stat().st_size // 1024, 'KB', Image.open(p).size)

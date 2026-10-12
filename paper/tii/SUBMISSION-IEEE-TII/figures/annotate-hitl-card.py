# -*- coding: utf-8 -*-
"""Rebuild Fig.3(b) panel: the live HITL approval card, English-annotated.

Keeps the authentic zh-CN screenshot (provenance: live benchmark line,
October 9 campaign) and adds two deterministic layers:
  1. the card's two visual bands are split and re-stacked tightly so the
     printed text is ~1.15x larger at the same \\columnwidth;
  2. an English gloss strip below the card maps each Chinese field label
     (reviewers R2/R4/R5: the approval surface must be intelligible to the
     international readership), plus a "(b)" panel letter.

Run:  python annotate-hitl-card.py   (writes resources/hitl-card-crop.png)
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "resources", "hitl-card-crop.png")
# Read from the archived original screenshot, never from OUT: the split
# below is not idempotent, so re-reading OUT would double-process the card.
SRC = os.path.join(HERE, "retired", "hitl-card-crop-orig.png")

im = Image.open(SRC).convert("RGB")
W, H = im.size  # 1212 x 168
print("src:", W, "x", H)

# --- locate the two bands: header/fields row vs comment+buttons row -------
# The comment input (light box) starts around y=100 based on the layout; find
# the horizontal whitespace seam by scanning row darkness.
import numpy as np

arr = np.asarray(im.convert("L"), dtype=np.uint8)
row_busy = (arr < 200).sum(axis=1)  # non-white pixel count per row
# find the seam: the last run of >=6 consecutive nearly-empty rows in the
# middle band (between y=40 and y=H-40)
seam = None
run = 0
for y in range(40, H - 20):
    if row_busy[y] <= W // 50:
        run += 1
        if run >= 6 and y > H * 0.45:
            seam = y - run // 2
            break
    else:
        run = 0
if seam is None:
    seam = int(H * 0.62)
print("seam at y =", seam)

top = im.crop((0, 0, W, seam))
bot = im.crop((0, seam, W, H))

# trim outer white margins horizontally on both bands
def htrim(img):
    a = np.asarray(img.convert("L"))
    col_busy = (a < 200).sum(axis=0)
    xs = np.where(col_busy > 2)[0]
    return (max(0, xs[0] - 4), min(img.width, xs[-1] + 5)) if len(xs) else (0, img.width)

x0t, x1t = htrim(top)
x0b, x1b = htrim(bot)
x0 = min(x0t, x0b)
x1 = max(x1t, x1b)
top, bot = top.crop((x0, 0, x1, top.height)), bot.crop((x0, 0, x1, bot.height))
print("trimmed x:", x0, x1, "-> width", x1 - x0)

CW = x1 - x0
GAP = 6
GLOSS_H = 100
PAD = 8
OUTW = CW + 2 * PAD
OUTH = PAD + top.height + GAP + bot.height + GAP + GLOSS_H + PAD
canvas = Image.new("RGB", (OUTW, OUTH), "white")
d = ImageDraw.Draw(canvas)

FONT_DIR = "C:/Windows/Fonts"
def font(sz, bold=False):
    name = "arialbd.ttf" if bold else "arial.ttf"
    try:
        return ImageFont.truetype(os.path.join(FONT_DIR, name), sz)
    except OSError:
        return ImageFont.load_default()

y = PAD
canvas.paste(top, (PAD, y)); y += top.height + GAP
canvas.paste(bot, (PAD, y)); y += bot.height + GAP

# English gloss strip: three short lines at 32px (~7 pt printed at
# \columnwidth; the previous two-line 26px layout printed ~5.7 pt, at the
# legibility floor). Each line must stay under ~74 characters.
GREY = (90, 90, 90)
BLUE = (46, 94, 140)
f1 = font(32)
f2 = font(32)
line1 = "proposer (agent member)  \u00b7  batch rr-b7e6f  \u00b7  parameter"
line2 = "current 63 bar \u2192 proposed 64 bar  \u00b7  comment returns to the agent"
line3 = "machine-checked fields  \u00b7  approve / reject"
d.text((PAD + 2, y), line1, font=f1, fill=BLUE)
y += 32
d.text((PAD + 2, y), line2, font=f2, fill=GREY)
y += 32
d.text((PAD + 2, y), line3, font=f2, fill=GREY)

# panel letter, bottom-right clear zone
d.text((OUTW - 56, OUTH - 42), "(b)", font=font(34, bold=True), fill=(38, 38, 38))

# width guard: no gloss line may run past the canvas
for ln, fnt in ((line1, f1), (line2, f2), (line3, f2)):
    w = d.textlength(ln, font=fnt)
    assert PAD + 2 + w <= OUTW - 4, f"gloss line overflows: '{ln}' ({w:.0f}px)"

canvas.save(OUT)
print("written:", OUT, canvas.size)

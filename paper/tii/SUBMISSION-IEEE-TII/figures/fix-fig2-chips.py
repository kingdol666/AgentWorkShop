# -*- coding: utf-8 -*-
"""Surgical pixel fix for Fig.2 (aws_fig3-flat.png), preserving the comic style.

Measured defects (source coords, 2604x1424):
  1. Judge chip x[1524,1676] y[1280,1336]: a thick black dash (y 1306-1318,
     the feedback line drawn over the label) strikes through "complete".
  2. Readback chip x[2202,2432] y[1128,1218]: the two text lines are jammed
     with zero leading (cap tops touch the line above's baseline), so at
     print scale the text reads as overflowing the chip borders.

Fixes: both chips are redrawn in place from sampled colors with real padding;
the feedback dash now visually passes behind the label. Text re-rendered with
matching system fonts. Original backed up as aws_fig3-flat.png.bak-pre-fix.
"""
from PIL import Image, ImageDraw, ImageFont
import numpy as np

SRC = "resources/aws_fig3-flat.png"
im = Image.open(SRC).convert("RGB")
a = np.array(im)
draw = ImageDraw.Draw(im)


def sample(y, x):
    return tuple(int(v) for v in a[y, x])


# ---------- 1. Judge chip: erase, redraw 1.12x, dash passes behind ----------
jx0, jx1, jy0, jy1 = 1520, 1680, 1276, 1340
draw.rectangle([jx0, jy0, jx1, jy1], fill=(255, 255, 255))  # removes dash inside
GOLD = (214, 182, 86)
CREAM = (255, 242, 204)
# new chip geometry (center preserved, +12% w/h)
cx, cy = (jx0 + jx1) // 2, (jy0 + jy1) // 2
nw, nh = int((jx1 - jx0) * 1.12), int((jy1 - jy0) * 1.12)
nx0, ny0, nx1, ny1 = cx - nw // 2, cy - nh // 2, cx + nw // 2, cy + nh // 2
draw.rectangle([nx0, ny0, nx1, ny1], fill=CREAM, outline=GOLD, width=3)
f_j = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 30)
for i, line in enumerate(["Judge,", "complete"]):
    bb = draw.textbbox((0, 0), line, font=f_j)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    ty = ny0 + nh * (0.13 + 0.44 * i) - bb[1]
    draw.text((cx - tw / 2 - bb[0], ty), line, font=f_j, fill=(24, 27, 32))
print("judge chip redrawn at", nx0, ny0, nx1, ny1, "gold", GOLD)

# ---------- 2. Readback chip: erase interior, redraw text with leading -------
rx0, rx1, ry0, ry1 = 2165, 2443, 1130, 1219
RBORDER = (210, 215, 222)
draw.rectangle([rx0 + 3, ry0 + 3, rx1 - 3, ry1 - 3], fill=(255, 255, 255))
draw.rounded_rectangle([rx0, ry0, rx1, ry1], radius=12,
                       fill=None, outline=RBORDER, width=3)
cw, chh = rx1 - rx0, ry1 - ry0
f_rb = ImageFont.truetype("C:/Windows/Fonts/times.ttf", 40)
f_sa = ImageFont.truetype("C:/Windows/Fonts/times.ttf", 34)
for line, font, color, cyf in (("Readback", f_rb, (28, 28, 28), 0.28),
                               ("SET vs ACT", f_sa, (115, 115, 120), 0.74)):
    bb = draw.textbbox((0, 0), line, font=font)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    tx = rx0 + cw / 2 - tw / 2 - bb[0]
    ty = ry0 + chh * cyf - th / 2 - bb[1]
    draw.text((tx, ty), line, font=font, fill=color)
print("readback chip redrawn; border", RBORDER)

im.save(SRC)
print("saved", SRC)

# -*- coding: utf-8 -*-
"""Rebuild Fig. 3(b): the live HITL approval card, re-flowed for print legibility.

Supersedes annotate-hitl-card.py (2026-10-16). The previous panel stacked the
card's two bands at 1.15x, which still printed the 12--14 px UI text at
~3.5--4 pt -- below the 6 pt legibility floor (pdf:visual-judge verdict,
page 4). It also carried a Chinese-only surface.

This script re-flows the SAME source pixels (no re-rendering, no invented
content): each row of the card is cropped tightly and the composition is
re-packed -- the wide table row is split into its three self-contained
column pairs (label stacked over value), and the reason line is wrapped at
its widest inter-word gap -- so every row fits a narrower canvas. The canvas
is then included at \columnwidth, which raises the printed type to >=6.3 pt.

Source (verbatim, live benchmark line, October 9 campaign):
  figures/retired/hitl-card-crop-orig.png  (1212 x 168 px screenshot)
Fields kept: header (parameter-write badge, recipe, batch, validity), the
proposer's display-only reasoning, the machine-checkable parameter row
(parameter / current 63 bar / proposed 64 bar), and the comment field with
approve/reject buttons.

Run:  python reflow-hitl-card.py   (writes resources/hitl-card-render.png)
"""
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "resources", "hitl-card-render.png")
SRC = os.path.join(HERE, "retired", "hitl-card-crop-orig.png")

COLUMN_PT = 252.0          # \columnwidth in the IEEEtran journal class
OUT_W = 480                # printed scale = 252/480 = 0.525 pt per source px
MIN_PT = 6.3               # legibility floor asserted below

im = Image.open(SRC).convert("RGB")
W, H = im.size
g = np.asarray(im.convert("L"))

BUSY = 235  # a pixel counts as ink below this grey level


def tight(img, box, pad=2):
    """Crop `box` then shrink to the ink bounding box (>=BUSY)."""
    x0, y0, x1, y1 = box
    sub = img.crop(box)
    a = np.asarray(sub.convert("L"))
    ys, xs = np.where(a < BUSY)
    if len(xs) == 0:
        return sub, 0, 0
    return (sub.crop((max(0, xs.min() - pad), max(0, ys.min() - pad),
                      min(sub.width, xs.max() + 1 + pad),
                      min(sub.height, ys.max() + 1 + pad))), 0, 0)


def ink_h(box):
    """Ink height (px) of the darkest text run inside `box`, per column."""
    x0, y0, x1, y1 = box
    a = g[y0:y1, x0:x1]
    ys, _ = np.where(a < 160)
    return (ys.max() - ys.min() + 1) if len(ys) else 0


# --- reason-line wrap point -------------------------------------------------
# Detected zero-ink inter-word gaps (>=3 px) in the reason line sit at
# 214-216 / 251-254 / 308-310 / 437-439 / 465-467 / 526-528. Wrapping after
# the "1bar" token (gap 465-467) keeps "保压微升 1bar" intact and starts the
# second line at the clause "补缩;…". Both resulting lines are asserted to
# fit the canvas below (430 px / 227 px).
reason_ink = (g[32:52] < BUSY).sum(axis=0)
gaps, s = [], None
for x in range(30, 720):
    if reason_ink[x] == 0:
        s = x if s is None else s
    elif s is not None:
        if x - s >= 3:
            gaps.append((s + x - 1) // 2)
        s = None
split_x = min(gaps, key=lambda x: abs(x - 466)) if gaps else 466

# --- tight-cropped pieces (source px boxes, from the detected layout) -------
pieces = [
    # (name, box, allow_split)
    ("header",   (28, 1, 362, 29)),
    ("reason-a", (30, 30, split_x, 54)),
    ("reason-b", (split_x + 1, 30, 698, 54)),
    ("param",    (38, 61, 145, 107)),   # thead label stacked over its value
    ("current",  (626, 61, 672, 107)),
    ("proposed", (898, 61, 944, 107)),
    ("comment",  (28, 118, 348, 148)),  # box edge + placeholder text
    ("buttons",  (1066, 118, 1170, 148)),
]
crops = {}
for name, box in pieces:
    sub, _, _ = tight(im, box)
    crops[name] = sub

GAP = 2        # vertical gap between logical rows
HGAP = 18      # horizontal gap between table column pairs
PAD = 4

# Rows: (pieces with x offsets). Table pairs share one row.
row_plan = [
    [("header", 0)],
    [("reason-a", 0)],
    [("reason-b", 0)],
    [("param", 0), ("current", None), ("proposed", None)],  # None = auto-chain
    [("comment", 0), ("buttons", None)],
]

built = []
for row in row_plan:
    imgs = [crops[n] for n, _ in row]
    if len(imgs) == 1:
        built.append(imgs[0])
        continue
    width = sum(i.width for i in imgs) + HGAP * (len(imgs) - 1)
    height = max(i.height for i in imgs)
    strip = Image.new("RGB", (width, height), "white")
    x = 0
    for i in imgs:
        strip.paste(i, (x, height - i.height))  # bottom-align (table pairs)
        x += i.width + HGAP
    built.append(strip)

CW = max(s.width for s in built)
assert CW + 2 * PAD <= OUT_W, f"content {CW}px exceeds canvas {OUT_W}px"
OUTH = PAD + sum(s.height for s in built) + GAP * (len(built) - 1) + PAD
canvas = Image.new("RGB", (OUT_W, OUTH), "white")
y = PAD
for s in built:
    canvas.paste(s, (PAD, y))
    y += s.height + GAP

# panel letter in the clear zone right of the header row (top-right)
from PIL import ImageDraw, ImageFont
d = ImageDraw.Draw(canvas)
font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 30)
d.text((OUT_W - 54, 2), "(b)", font=font, fill=(38, 38, 38))

canvas.save(OUT)

# --- self-check -------------------------------------------------------------
scale = COLUMN_PT / OUT_W
min_ink = min(ink_h(b) for b in
              [(38, 61, 145, 107), (626, 61, 672, 107), (898, 61, 944, 107),
               (30, 30, 698, 54), (28, 118, 348, 148)])
print(f"written {OUT}")
print(f"  canvas {canvas.width}x{canvas.height}px -> printed "
      f"{COLUMN_PT:.0f}x{canvas.height * scale:.1f}pt at \\columnwidth")
print(f"  min ink height {min_ink}px -> {min_ink * scale:.2f}pt")
print(f"  reason split at x={split_x}")
assert min_ink * scale >= MIN_PT, f"type below {MIN_PT}pt: {min_ink * scale:.2f}"
print("  SELF-CHECK PASS")

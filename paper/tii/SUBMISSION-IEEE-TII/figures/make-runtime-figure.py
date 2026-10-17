# -*- coding: utf-8 -*-
"""Fig. 2 -- governed agent-team runtime, rebuilt at final printed width.

The previous figure was a 7.16 in raster/vector design placed at column
width, so its 5 pt labels printed at 2.5-3 pt.  This generator draws a
column-width (89 mm) vertical sequence at 8 pt so source points equal
printed points.  Content is the runtime path only: goal/task, retrieve and
propose, admission and approval, write/readback, judge.  Governance boxes
are platform stages, not model-bearing agents (stated in the caption).

Run: python make-runtime-figure.py   (writes ../resources/fig-runtime.pdf)
"""
import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "resources", "fig-runtime.pdf")

BLUE, GREEN, TEAL = "#2E5E8C", "#3E8E55", "#20706B"
DARK, GREY = "#262626", "#7A7A7A"

plt.rcParams.update({
    "font.family": ["Arial", "DejaVu Sans"],
    "pdf.fonttype": 42,
    "font.size": 8.0,
})

W_IN, H_IN = 3.50, 2.00
fig = plt.figure(figsize=(W_IN, H_IN))
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, W_IN)
ax.set_ylim(0, H_IN)
ax.axis("off")

X0, X1 = 0.06, 3.44
ROW_H, GAP = 0.34, 0.020
rows = [
    ("Team \u00b7 Goal \u2192 task", "natural-language goal becomes a team task", BLUE),
    ("Team \u00b7 Retrieve \u00b7 analyze \u00b7 propose", "knowledge base \u00b7 DAQ logs \u2192 setpoint", BLUE),
    ("Governance \u00b7 Admit \u2192 approve", "H \u2229 product \u2229 recipe; manual wait", GREEN),
    ("Plant \u00b7 Write \u2192 readback", "SET vs ACT; grade the acknowledgment", TEAL),
    ("Governance \u00b7 Judge", "keep / rollback / uncertain + attribution", GREEN),
]

# Top-down row placement; the first row (goal) sits at the top.
y = H_IN - 0.08 - ROW_H
bottoms = []
for _ in rows:
    bottoms.append(y)
    y -= ROW_H + GAP

for (head, detail, color), yb in zip(rows, bottoms):
    ax.add_patch(FancyBboxPatch(
        (X0, yb), X1 - X0, ROW_H,
        boxstyle="round,pad=0.006,rounding_size=0.018",
        facecolor="white", edgecolor="#B8B8B8", lw=0.55))
    ax.add_patch(plt.Rectangle(
        (X0 + 0.006, yb + 0.006), 0.035, ROW_H - 0.012,
        facecolor=color, edgecolor="none"))
    ax.text(X0 + 0.075, yb + ROW_H - 0.090, head,
            fontsize=8.0, weight="bold", color=color, va="top", ha="left")
    ax.text(X0 + 0.075, yb + 0.035, detail,
            fontsize=8.0, color=DARK, va="bottom", ha="left")

# Control-flow arrows between consecutive rows (top to bottom).
for i in range(len(bottoms) - 1):
    y_from = bottoms[i]
    y_to = bottoms[i + 1] + ROW_H
    ax.add_patch(FancyArrowPatch(
        ((X0 + X1) / 2, y_from), ((X0 + X1) / 2, y_to),
        arrowstyle="-|>", mutation_scale=7, color=GREY, lw=0.75,
        shrinkA=0, shrinkB=0))

fig.savefig(OUT, format="pdf")
print("written", OUT)

# Self-check: final-size type, one sans family, no CJK, media box height.
try:
    import pymupdf
    doc = pymupdf.open(OUT)
    page = doc[0]
    spans = [s for b in page.get_text("dict")["blocks"] if b["type"] == 0
             for l in b["lines"] for s in l["spans"] if s["text"].strip()]
    sizes = [round(s["size"], 2) for s in spans]
    fonts = sorted({s["font"] for s in spans})
    text = "".join(s["text"] for s in spans)
    assert sizes and min(sizes) >= 7.99, f"min font {min(sizes) if sizes else None}"
    assert all("Arial" in f for f in fonts), f"fonts {fonts}"
    assert not any("\u4e00" <= ch <= "\u9fff" for ch in text), "CJK text"
    assert page.rect.height <= 166, f"height {page.rect.height}"
    print(f"self-check ok: min={min(sizes)} pt, fonts={fonts}, h={page.rect.height:.1f} pt")
except ImportError:
    print("self-check skipped (pymupdf not installed)")

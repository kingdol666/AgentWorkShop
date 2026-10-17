# -*- coding: utf-8 -*-
"""Fig. 3(b) -- structured approval card, English vector redraw.

Source content: the archived live-console card (current 63 bar, proposed
64 bar; recipe "Injection weight recipe"; mirrored weight 32.4 g against
32.5 +/- 0.35 g).  The original screenshot was Chinese-only and 137 dpi;
this redraw keeps the same fields and values, translates the labels, and
sets every label at 8 pt at final column width.  Batch/run identifiers are
deliberately omitted ("archived batch") per the manuscript's identifier
policy.

Run: python make-hitl-card-figure.py   (writes ../resources/fig-hitl-card.pdf)
"""
import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "resources", "fig-hitl-card.pdf")

INK = "#262626"
GREY = "#6E6E6E"
GREEN, RED = "#2F7D4F", "#A6403A"
RULE = "#C9C9C9"

plt.rcParams.update({
    "font.family": ["Arial", "DejaVu Sans"],
    "pdf.fonttype": 42,
    "font.size": 8.0,
})

W_IN, H_IN = 3.50, 1.38
fig = plt.figure(figsize=(W_IN, H_IN))
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, W_IN)
ax.set_ylim(0, H_IN)
ax.axis("off")

X0, X1 = 0.03, 3.47
Y0, Y1 = 0.03, 1.35

# card frame
ax.add_patch(FancyBboxPatch(
    (X0, Y0), X1 - X0, Y1 - Y0,
    boxstyle="round,pad=0.004,rounding_size=0.03",
    facecolor="white", edgecolor="#9A9A9A", lw=0.6))
# header band
ax.add_patch(Rectangle((X0 + 0.004, 1.10), X1 - X0 - 0.008, 0.245,
                       facecolor="#F3F5F3", edgecolor="none"))
ax.plot([X0 + 0.004, X1 - 0.004], [1.10, 1.10], color=RULE, lw=0.5)

# badge
ax.add_patch(FancyBboxPatch(
    (0.10, 1.18), 0.76, 0.13,
    boxstyle="round,pad=0.006,rounding_size=0.02",
    facecolor="white", edgecolor=GREEN, lw=0.6))
ax.text(0.48, 1.245, "Parameter write", fontsize=8.0, color=GREEN,
        ha="center", va="center")

ax.text(0.95, 1.245, "Injection weight recipe", fontsize=8.0,
        weight="bold", color=INK, ha="left", va="center")
ax.text(2.32, 1.245, "archived batch", fontsize=8.0, color=GREY,
        ha="left", va="center")
ax.text(3.42, 1.31, "(b)", fontsize=8.0, weight="bold", color=INK,
        ha="right", va="top")

# proposer reasoning (display-only)
ax.text(0.10, 1.02, "Reason", fontsize=8.0, weight="bold", color=INK,
        ha="left", va="top")
ax.text(0.55, 1.02, "mirrored weight 32.4 g vs 32.5 \u00b1 0.35 g;",
        fontsize=8.0, color=INK, ha="left", va="top")
ax.text(0.55, 0.85, "hold pressure +1 bar (sensitivity excitation).",
        fontsize=8.0, color=INK, ha="left", va="top")

# structured parameter table
ax.plot([X0 + 0.07, X1 - 0.07], [0.50, 0.50], color=RULE, lw=0.5)
ax.text(0.10, 0.540, "Parameter", fontsize=8.0, weight="bold", color=GREY,
        ha="left", va="bottom")
ax.text(2.30, 0.540, "Current", fontsize=8.0, weight="bold", color=GREY,
        ha="left", va="bottom")
ax.text(2.95, 0.540, "Proposed", fontsize=8.0, weight="bold", color=GREY,
        ha="left", va="bottom")
ax.text(0.10, 0.420, "Injection hold pressure SP", fontsize=8.0, color=INK,
        ha="left", va="center")
ax.text(2.30, 0.420, "63 bar", fontsize=8.0, color=INK, ha="left", va="center")
ax.text(2.95, 0.420, "64 bar", fontsize=8.0, weight="bold", color=INK,
        ha="left", va="center")
ax.plot([X0 + 0.07, X1 - 0.07], [0.34, 0.34], color=RULE, lw=0.5)

# decision note + buttons
ax.add_patch(FancyBboxPatch(
    (0.10, 0.08), 2.15, 0.16,
    boxstyle="round,pad=0.004,rounding_size=0.015",
    facecolor="white", edgecolor=RULE, lw=0.5))
ax.text(0.15, 0.16, "Decision note (verbatim on refusal)", fontsize=8.0,
        color=GREY, ha="left", va="center")

for x, label, color in [(2.38, "Approve", GREEN), (2.92, "Reject", RED)]:
    ax.add_patch(FancyBboxPatch(
        (x, 0.08), 0.48, 0.16,
        boxstyle="round,pad=0.004,rounding_size=0.015",
        facecolor="white", edgecolor=color, lw=0.6))
    ax.text(x + 0.24, 0.16, label, fontsize=8.0, color=color,
            ha="center", va="center")

fig.savefig(OUT, format="pdf")
print("written", OUT)

# Self-check: 8 pt floor, Arial only, no CJK, height <= 100 pt, key values.
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
    assert page.rect.height <= 100, f"height {page.rect.height}"
    for needle in ("63 bar", "64 bar", "Approve", "Reject"):
        assert needle in text, f"missing {needle}"
    print(f"self-check ok: min={min(sizes)} pt, fonts={fonts}, h={page.rect.height:.1f} pt")
except ImportError:
    print("self-check skipped (pymupdf not installed)")

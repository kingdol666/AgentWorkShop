# -*- coding: utf-8 -*-
"""Four-layer admission-interval geometry, 8 pt at final panel width.

Panel (a) of the combined Fig. 3.  Data source (verbatim, Q1 parameter-layer
drill): node [50,200] hard range, parameter [143.7,156.3], product
[146.22,153.78], recipe [141,159] rpm; the intersection is the admitted
interval.  Layer labels occupy a left gutter, so no label can sit on a bar.

Run: python make-admission-figure.py   (writes ../resources/fig-admission.pdf)
"""
import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "resources", "fig-admission.pdf")

plt.rcParams.update({
    "font.family": ["Arial", "DejaVu Sans"],
    "font.size": 8.0,
    "axes.linewidth": 0.6,
    "xtick.major.width": 0.6,
    "xtick.minor.width": 0.4,
    "xtick.major.size": 2.4,
    "xtick.minor.size": 1.3,
    "xtick.direction": "in",
    "xtick.top": True,
    "pdf.fonttype": 42,
})

LAYERS = [
    ("H", "hard", 50.0, 200.0, "#9DB8D2", "[50, 200]"),
    ("B", "baseline", 143.7, 156.3, "#6C97C4", "[143.7, 156.3]"),
    ("P", "product", 146.22, 153.78, "#3E6FA3", "[146.22, 153.78]"),
    ("R", "recipe", 141.0, 159.0, "#D99A3D", "[141, 159]"),
]
INTER_LO, INTER_HI = 146.22, 153.78
DARK = "#262626"
GREY = "#8C8C8C"

fig, ax = plt.subplots(figsize=(3.40, 1.62))
fig.subplots_adjust(left=0.005, right=0.995, top=0.905, bottom=0.230)

lane_h = 0.44
lanes = [3.35, 2.35, 1.35, 0.35]
XLO, XHI, BAR_LO = 127.0, 162.0, 140.5

# admitted interval band across all lanes
ax.add_patch(Rectangle((INTER_LO, 0.0), INTER_HI - INTER_LO, 3.78,
                       facecolor="#3E8E55", alpha=0.13, lw=0, zorder=1))
Y0, Y1 = (0.02 + 1.0) / 6.4, (4.0 + 1.0) / 6.4
ax.axvline(INTER_LO, color="#3E8E55", lw=0.7, ls=(0, (3, 2)),
           ymin=Y0, ymax=Y1, zorder=2)
ax.axvline(INTER_HI, color="#3E8E55", lw=0.7, ls=(0, (3, 2)),
           ymin=Y0, ymax=Y1, zorder=2)

for (tag, name, lo, hi, color, note), y in zip(LAYERS, lanes):
    ax.add_patch(Rectangle((max(lo, BAR_LO), y - lane_h / 2),
                           min(hi, XHI) - max(lo, BAR_LO), lane_h,
                           facecolor=color, edgecolor="white", lw=0.5,
                           alpha=0.92, zorder=3))
    ax.text(XLO + 0.4, y, f"{tag}  {note}", fontsize=8.0, color=DARK,
            va="center", ha="left", zorder=5)

ax.annotate("admitted interval\nI(n) = [146.22, 153.78]",
            xy=((INTER_LO + INTER_HI) / 2, 3.78), xytext=(151.0, 4.06),
            fontsize=8.0, color="#2E7D3A", ha="center", va="bottom",
            bbox=dict(facecolor="white", edgecolor="none", pad=0.7, alpha=0.9),
            arrowprops=dict(arrowstyle="->", color="#2E7D3A", lw=0.6))
ax.annotate("", xy=(INTER_LO, -0.22), xytext=(INTER_HI, -0.22),
            arrowprops=dict(arrowstyle="<->", color="#2E7D3A", lw=0.8))
ax.text(150.0, -0.62, "outside: rejected by its excluding layer",
        ha="center", fontsize=8.0, color=GREY)

ax.set_xlim(XLO, XHI)
ax.set_ylim(-1.0, 5.25)
ax.set_yticks([])
ax.set_xticks([140, 145, 150, 155, 160])
ax.set_xticks(range(128, 163), minor=True)
ax.set_xlabel("governing setpoint (rpm)  \u2013  Q1 drill", fontsize=8.0)
ax.tick_params(labelsize=8.0)
ax.text(0.012, 0.965, "(a)", transform=ax.transAxes, fontsize=8.0,
        fontweight="bold", color=DARK, va="top", ha="left",
        bbox=dict(facecolor="white", edgecolor="none", pad=0.4))

fig.savefig(OUT, format="pdf")
print("written", OUT)

try:
    import pymupdf
    doc = pymupdf.open(OUT)
    page = doc[0]
    spans = [s for b in page.get_text("dict")["blocks"] if b["type"] == 0
             for l in b["lines"] for s in l["spans"] if s["text"].strip()]
    sizes = [round(s["size"], 2) for s in spans]
    fonts = sorted({s["font"] for s in spans})
    assert sizes and min(sizes) >= 7.99, f"min font {min(sizes) if sizes else None}"
    assert all("Arial" in f for f in fonts), f"fonts {fonts}"
    assert page.rect.height <= 118, f"height {page.rect.height}"
    print(f"self-check ok: min={min(sizes)} pt, fonts={fonts}, h={page.rect.height:.1f} pt")
except ImportError:
    print("self-check skipped (pymupdf not installed)")

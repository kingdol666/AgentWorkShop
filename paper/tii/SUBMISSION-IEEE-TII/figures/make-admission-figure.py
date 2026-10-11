# -*- coding: utf-8 -*-
"""Four-layer admission-interval geometry for the TII manuscript
(column-native, SCI/Origin styling).

Data source (verbatim, Q1 parameter-layer drill): node [50,200] hard range,
parameter [143.7,156.3], product [146.22,153.78], recipe [141,159] rpm ---
the intersection admitted interval, each rejection attributable to its
excluding layer (Eq. 1: H_n ∩ B_n ∩ P_n ∩ R_n).

Run:  python make-admission-figure.py   (writes PDF into ../resources/)
"""
import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "resources")

plt.rcParams.update({
    "font.family": ["Arial", "DejaVu Sans"],
    "font.size": 6.0,
    "axes.linewidth": 0.6,
    "xtick.major.width": 0.6,
    "xtick.minor.width": 0.4,
    "xtick.major.size": 2.4,
    "xtick.minor.size": 1.3,
    "xtick.direction": "in",
    "xtick.top": True,
    "pdf.fonttype": 42,
})

# Origin-style muted palette (one hue per governance layer, darkening inward)
LAYERS = [
    # label, lo, hi, color, note
    ("$\\mathcal{H}_n$  node hard range",      50.0,    200.0,   "#9DB8D2", "[50, 200]"),
    ("$\\mathcal{B}_n$  parameter baseline",   143.7,   156.3,   "#6C97C4", "[143.7, 156.3]"),
    ("$\\mathcal{P}_n$  active product",       146.22,  153.78,  "#3E6FA3", "[146.22, 153.78]"),
    ("$\\mathcal{R}_n$  active recipe",        141.0,   159.0,   "#D99A3D", "[141, 159]"),
]
INTER_LO, INTER_HI = 146.22, 153.78
DARK = "#262626"
GREY = "#8C8C8C"

fig, ax = plt.subplots(figsize=(3.5, 1.52))
fig.subplots_adjust(left=0.005, right=0.995, top=0.90, bottom=0.17)

lane_h = 0.52
gap = 1.0
lanes = [3.3, 2.3, 1.3, 0.3]  # top to bottom: H, B, P, R
XLO, XHI = 138.0, 162.0

# admitted interval band across all lanes
ax.add_patch(Rectangle((INTER_LO, 0.0), INTER_HI - INTER_LO, 3.85,
                       facecolor="#3E8E55", alpha=0.13, lw=0, zorder=1))
ax.axvline(INTER_LO, color="#3E8E55", lw=0.7, ls=(0, (3, 2)), zorder=2)
ax.axvline(INTER_HI, color="#3E8E55", lw=0.7, ls=(0, (3, 2)), zorder=2)

for (label, lo, hi, color, note), y in zip(LAYERS, lanes):
    lo_v, hi_v = max(lo, XLO), min(hi, XHI)
    ax.add_patch(Rectangle((lo_v, y - lane_h / 2), hi_v - lo_v, lane_h,
                           facecolor=color, edgecolor="white", lw=0.5,
                           alpha=0.92, zorder=3))
    ax.annotate(f"{label}   {note}", xy=(XLO + 0.4, y), fontsize=4.9,
                color=DARK, va="center", ha="left", zorder=5,
                xycoords=("data", "data"))

# intersection markers on the admitted interval
ax.annotate("admitted interval\n$\\mathcal{I}_n=[146.22, 153.78]$",
            xy=((INTER_LO + INTER_HI) / 2, 3.85), xytext=(154.6, 4.35),
            fontsize=5.2, color="#2E7D3A", ha="center",
            arrowprops=dict(arrowstyle="->", color="#2E7D3A", lw=0.6))
ax.annotate("", xy=(INTER_LO, 0.02), xytext=(INTER_LO, 4.1),
            arrowprops=dict(arrowstyle="-", color="#8C8C8C", lw=0.4, ls=":"))
ax.annotate("", xy=(INTER_HI, 0.02), xytext=(INTER_HI, 4.1),
            arrowprops=dict(arrowstyle="-", color=GREY, lw=0.4, ls=":"))
ax.annotate("", xy=(INTER_LO, -0.28), xytext=(INTER_HI, -0.28),
            arrowprops=dict(arrowstyle="<->", color="#2E7D3A", lw=0.8))
ax.text(150.0, -0.70, "outside: rejected by its excluding layer", ha="center",
        fontsize=4.8, color=GREY)

ax.set_xlim(XLO, XHI)
ax.set_ylim(-1.05, 5.05)
ax.set_yticks([])
ax.set_xticks([140, 145, 150, 155, 160])
ax.set_xticks(range(138, 163), minor=True)
ax.set_xlabel("governing-setpoint value (rpm)  ---  Q1 four-layer drill", fontsize=5.4)
ax.tick_params(labelsize=5.5)
ax.text(0.012, 0.965, "(a)", transform=ax.transAxes, fontsize=7,
        fontweight="bold", color=DARK, va="top", ha="left",
        bbox=dict(facecolor="white", edgecolor="none", pad=0.6))

fig.savefig(os.path.join(OUT, "fig-admission.pdf"), format="pdf")
print("written", os.path.join(OUT, "fig-admission.pdf"))

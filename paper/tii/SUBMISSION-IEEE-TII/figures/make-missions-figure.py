# -*- coding: utf-8 -*-
"""Four-mission optimization trajectories for the TII manuscript
(column-native, SCI/Origin styling: boxed axes, inward ticks, Arial).

Data source (verbatim): figures/missions-data.json, extracted from
bench/results/20260921184204-10lc/scenarios.json (integrated run
20260921184204-10lc, seed 42; four concurrent missions under accelerated
simulator dynamics). Each series is the observed controlled quantity at
its anchor plus attainment-relevant governed writes; the band is the
archived objective window; the square marks the terminal observation.

Run:  python make-missions-figure.py   (writes PDF into ../resources/)
"""
import json
import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

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
    "ytick.major.width": 0.6,
    "ytick.minor.width": 0.4,
    "ytick.major.size": 2.4,
    "ytick.minor.size": 1.3,
    "xtick.direction": "in",
    "ytick.direction": "in",
    "xtick.top": True,
    "ytick.right": True,
    "pdf.fonttype": 42,
})

BLUE, GREEN, AMBER, DARK = "#2E5E8C", "#3E8E55", "#D99A3D", "#262626"
PANELS = [
    ("injection", "(a) injection molding: weight (g)"),
    ("wwtp",      "(b) wastewater: dissolved oxygen (mg/L)"),
    ("anneal", "(c) annealing: hardness (HV)"),
    ("biax",      "(d) BOPET film: thickness ($\\mu$m)"),
]

data = json.load(open(os.path.join(HERE, "missions-data.json"), encoding="utf-8"))
missions = {m["id"]: m for m in data["missions"]}

fig, axes = plt.subplots(2, 2, figsize=(3.5, 1.66))
fig.subplots_adjust(left=0.105, right=0.985, top=0.935, bottom=0.115,
                    hspace=0.44, wspace=0.34)

for i, (ax, (mid, title)) in enumerate(zip(axes.flat, PANELS)):
    m = missions[mid]
    series = m["series"]
    target, tol = m["target"], m["tol"]
    x = list(range(len(series)))
    ax.axhspan(target - tol, target + tol, color=GREEN, alpha=0.14, lw=0)
    ax.axhline(target, color=GREEN, lw=0.6, ls=(0, (3, 2)))
    ax.plot(x, series, color=BLUE, lw=1.0, marker="o", ms=2.2,
            mfc="white", mec=BLUE, mew=0.7, zorder=3)
    ax.plot([x[-1]], [series[-1]], marker="s", ms=3.0, color=DARK, zorder=4)
    ax.set_title(title, fontsize=5.4, color=DARK, pad=2.5)
    if i >= 2:  # bottom row only: a top-row xlabel collides with the bottom-row titles at this panel height
        ax.set_xlabel("attainment-relevant write index", fontsize=5.2, labelpad=1.2)
    ax.tick_params(labelsize=5.0)
    ax.set_xlim(-0.3, max(5.7, len(series) - 1 + 0.7))
    y0, y1 = min(series + [target - tol]), max(series + [target + tol])
    pad = (y1 - y0) * 0.18
    ax.set_ylim(y0 - pad, y1 + pad)
    ax.text(0.97, 0.06, f"{m['writes']} governed writes", transform=ax.transAxes,
            ha="right", va="bottom", fontsize=4.6, color=GREY if False else "#666666")

fig.text(0.012, 0.5, "observed controlled quantity", rotation=90,
         va="center", ha="center", fontsize=5.4)

fig.savefig(os.path.join(OUT, "fig-missions.pdf"), format="pdf")
print("written", os.path.join(OUT, "fig-missions.pdf"))

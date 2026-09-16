"""Fig. 5 - governed closed-loop optimization: J vs. closed-loop iteration.

Data source (archived benchmark run, read - never invented):
  bench/results/20260914152838-fwg/run.json
      -> closedloop.seeds[i].seed       plant seed (42, 43, 44)
      -> closedloop.seeds[i].traj[j].J  measured objective J at iteration j
         (iter 0 = pre-optimization, iter 1 = after first governed write,
          iter 2 = settled value)
  bench/results/20260914152838-fwg/summary.json
      -> closedloop.agg.Jstar           offline grid-search optimum W* = 89.894
      -> closedloop.agg.ratioMin/Max    recovery ratio 0.970-0.972 of W*
         (ratio = per-seed post-run verification J_end / W*)

Style: IEEE TII single column, 86 mm wide, 300 dpi, boxed axes with inward
major+minor ticks, light horizontal grid only, grayscale-safe series
(distinct marker + line style + colour each, identified via the legend).
"""
import json
import math
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt

REPO = Path(__file__).resolve().parents[3]
RUN_DIR = REPO / "bench" / "results" / "20260914152838-fwg"
OUT = Path(__file__).resolve().parent / "fig5-bench-closedloop.png"

# ---------------------------------------------------------------- load data
summary = json.loads((RUN_DIR / "summary.json").read_text(encoding="utf-8"))
run = json.loads((RUN_DIR / "run.json").read_text(encoding="utf-8"))

JSTAR = float(summary["closedloop"]["agg"]["Jstar"])            # 89.894
RATIO_MIN = float(summary["closedloop"]["agg"]["ratioMin"])     # 0.97
RATIO_MAX = float(summary["closedloop"]["agg"]["ratioMax"])     # 0.972

seeds = []
for s in sorted(run["closedloop"]["seeds"], key=lambda d: d["seed"]):
    traj = sorted(s["traj"], key=lambda t: t["iter"])
    seeds.append({
        "seed": int(s["seed"]),
        "J": [float(t["J"]) for t in traj],          # per-iteration J
        "settled": float(traj[-1]["J"]),
    })
assert all(len(s["J"]) == 3 for s in seeds), "expected 3 iterations per seed"
settled_lo = min(s["settled"] for s in seeds)
settled_hi = max(s["settled"] for s in seeds)
print("W* =", JSTAR)
for s in seeds:
    print(f"  seed {s['seed']}: J traj = {[round(v, 2) for v in s['J']]}"
          f"  settled = {s['settled']:.2f}")
print(f"  settled range = {settled_lo:.2f}-{settled_hi:.2f},"
      f" recovery ratio = {RATIO_MIN:.3f}-{RATIO_MAX:.3f}")

# ---------------------------------------------------------------- style
MM = 1.0 / 25.4
mpl.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "STIXGeneral", "DejaVu Serif"],
    "mathtext.fontset": "stix",
    "font.size": 6,
    "axes.labelsize": 7,
    "xtick.labelsize": 6,
    "ytick.labelsize": 6,
    "legend.fontsize": 6,
    "axes.linewidth": 0.6,
    "lines.linewidth": 1.1,
    "lines.markersize": 3.6,
    "xtick.direction": "in", "ytick.direction": "in",
    "xtick.top": True, "ytick.right": True,
    "xtick.major.size": 2.6, "xtick.minor.size": 1.5,
    "ytick.major.size": 2.6, "ytick.minor.size": 1.5,
    "xtick.major.width": 0.6, "xtick.minor.width": 0.5,
    "ytick.major.width": 0.6, "ytick.minor.width": 0.5,
    "xtick.minor.visible": True, "ytick.minor.visible": True,
    "legend.frameon": False,
    "savefig.dpi": 300,
})

TEAL, BLUE, PURPLE, GREY = "#1F6F78", "#3D6FB5", "#6A4C93", "#5F6B76"
series = [
    dict(color=TEAL,    marker="o", ls="-"),
    dict(color=BLUE,    marker="s", ls="--"),
    dict(color=PURPLE,  marker="^", ls="-."),
]

# IEEE single column = exactly 86 mm = 1016 px at 300 dpi
fig, ax = plt.subplots(figsize=(1016 / 300, 732 / 300))
fig.subplots_adjust(left=0.135, right=0.975, top=0.97, bottom=0.155)

x = [0, 1, 2]
for s, st in zip(seeds, series):
    ax.plot(x, s["J"], color=st["color"], marker=st["marker"], ls=st["ls"],
            markerfacecolor="white", markeredgecolor=st["color"],
            markeredgewidth=0.9, label=f"seed {s['seed']}", zorder=3)
    # mark the settling value (iteration-2 measurement)
    ax.plot([2], [s["settled"]], ls="none", marker="o", markersize=6.2,
            markerfacecolor="none", markeredgecolor=st["color"],
            markeredgewidth=1.0, zorder=4)

# offline grid-search optimum W*
ax.axhline(JSTAR, color=GREY, ls=(0, (4, 2.4)), lw=0.9, zorder=2,
           label="offline grid optimum $W^{*}$")

# annotations (kept clear of all data)
ax.annotate(f"settled $J$ = {settled_lo:.2f}\u2013{settled_hi:.2f}",
            xy=(1.965, settled_lo - 0.4), xytext=(1.30, 76.0),
            fontsize=6, ha="left", va="center", color="black",
            arrowprops=dict(arrowstyle="-", lw=0.6, color="0.35",
                            shrinkA=1, shrinkB=1.5,
                            connectionstyle="arc3,rad=-0.18"))
# blended transform: x in axes fraction, y in data units
ax.text(0.985, JSTAR + 0.9,
        f"offline grid optimum $W^{{*}}$ = {JSTAR:.3f}\n"
        f"recovery ratio {RATIO_MIN:.3f}\u2013{RATIO_MAX:.3f} of $W^{{*}}$",
        transform=ax.get_yaxis_transform(), ha="right", va="bottom",
        fontsize=6, color="black", linespacing=1.35)

ax.set_xlabel("Closed-loop iteration")
ax.set_ylabel("Objective $J$")
ax.set_xticks(x)
ax.set_xlim(-0.18, 2.18)
ax.set_ylim(56, 96)
ax.grid(axis="y", color="0.88", lw=0.5)
ax.set_axisbelow(True)
ax.tick_params(which="both", pad=2)

# legend in the empty lower-right region (never on top of the data)
leg = ax.legend(loc="lower right", bbox_to_anchor=(0.995, 0.025),
                handlelength=2.4, labelspacing=0.35, borderaxespad=0.0)

fig.savefig(OUT, dpi=300)
print("wrote", OUT)

"""Fig. 6 - governance ablation (E1a): interception vs. governed-write latency.

Data source (archived benchmark aggregate, read - never invented):
  bench/tools/fig4-data.json -- the same per-repetition aggregate the paper's
  Fig. 4 uses (bench/tools/fig4_analyze.py over three released e1-lite runs,
  20260914023820 / 20260914040054 / 20260914132601; 4 arms x 9 reps).
  Per rep: intercepted / attacks / p50 / p95.

Metric definitions replicate the harness exactly (bench/e1-lite.mjs lines
84-101, recomputed in bench/tools/fig4_analyze.py):
  * latency population = every ACCEPTED governed write of {legit, timed};
    boundary probes are recorded but excluded;
  * percentile = nearest-rank, no interpolation;
  * interception = seeded attack answered with status 400 (rejected).
Panel (a): intercepted attack cases per arm out of 6 seeded attacks
(deterministic across all 9 reps - asserted), Wilson 95% score intervals on
n = 6, z = 1.959964, printed as "k/6 [lo, hi]".
Panel (b): point ranges - dot = mean of per-rep p50 over the 9 reps,
whisker = min per-rep p50 to max per-rep p95 (never bars: a truncated bar
axis would exaggerate differences).

Style: IEEE TII single column, 86 mm wide, 300 dpi, boxed axes with inward
major+minor ticks, light horizontal grid only, grayscale-safe (hatch pattern
plus colour), legend/annotations in empty regions only.
"""
import json
import math
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "bench" / "tools" / "fig4-data.json"
OUT = Path(__file__).resolve().parent / "fig6-bench-ablation.png"

ARMS = [
    ("full", "Full pipeline"),
    ("no-interlock", "No interlock"),
    ("no-readback", "No readback"),
    ("ungated", "Fully ungated"),
]
Z = 1.959963985  # 95% two-sided normal quantile


def wilson(k, n, z=Z):
    """Wilson score interval for a binomial proportion."""
    p = k / n
    denom = 1.0 + z * z / n
    centre = (p + z * z / (2.0 * n)) / denom
    half = z * math.sqrt(p * (1.0 - p) / n + z * z / (4.0 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def fmt_pct(v):
    return f"{v:.0f}" if abs(v - round(v)) < 0.05 else f"{v:.1f}"


# ---------------------------------------------------------------- load data
raw = json.load(open(DATA, encoding="utf-8"))
stats = {}
for arm, label in ARMS:
    per_rep = raw[arm]["reps"]        # one entry per repetition (9 per arm)
    p50s = [r["p50"] for r in per_rep]
    p95s = [r["p95"] for r in per_rep]
    ks = {r["intercepted"] for r in per_rep}
    ns = {r["attacks"] for r in per_rep}
    assert len(ks) == 1 and len(ns) == 1, (arm, ks, ns)  # deterministic judge class
    k, n = ks.pop(), ns.pop()
    stats[arm] = {
        "label": label, "k": k, "n": n,
        "reps": len(per_rep),
        "mean_p50": sum(p50s) / len(p50s),
        "min_p50": min(p50s), "max_p95": max(p95s),
        "wilson": wilson(k, n),
    }
    lo, hi = stats[arm]["wilson"]
    print(f"{label:14s} {k}/{n}  Wilson95% [{100*lo:.1f}, {100*hi:.1f}]  "
          f"mean p50 = {stats[arm]['mean_p50']:.1f} ms  "
          f"reps = {len(per_rep)}  min-p50 = {stats[arm]['min_p50']:.1f}  "
          f"max-p95 = {stats[arm]['max_p95']:.1f}")
    assert 105 <= stats[arm]["mean_p50"] <= 145, "p50 sanity range"
    assert 140 <= stats[arm]["max_p95"] <= 175, "p95 sanity range"

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

GREEN, RED, BLUE = "#2E7D32", "#B3282D", "#3D6FB5"
x = list(range(len(ARMS)))

# IEEE single column = exactly 86 mm = 1016 px at 300 dpi
fig, (ax_a, ax_b) = plt.subplots(
    2, 1, figsize=(1016 / 300, 876 / 300), sharex=True,
    gridspec_kw=dict(hspace=0.16))
fig.subplots_adjust(left=0.135, right=0.975, top=0.925, bottom=0.098)

# ------------------------------------------------- panel (a): interception
for xi, (arm, _) in zip(x, ARMS):
    s = stats[arm]
    pct = 100.0 * s["k"] / s["n"]
    bypassed = arm in ("no-interlock", "ungated")
    ax_a.bar(xi, pct, width=0.55,
             facecolor=(RED if bypassed else GREEN) + ("14" if bypassed else "22"),
             edgecolor=(RED if bypassed else GREEN),
             linewidth=0.7, hatch=("////" if bypassed else None), zorder=2)
    lo, hi = s["wilson"]
    ax_a.errorbar([xi], [pct], yerr=[[pct - 100 * lo], [100 * hi - pct]],
                  fmt="none", ecolor="black", elinewidth=0.8,
                  capsize=2.4, capthick=0.8, zorder=3)
    ax_a.text(xi, 100 * hi + 6.0,
              f"{s['k']}/{s['n']}  [{fmt_pct(100 * lo)}, {fmt_pct(100 * hi)}]",
              ha="center", va="bottom", fontsize=6, color="black")

ax_a.set_ylabel("Interception (%)")
ax_a.set_ylim(0, 146)
ax_a.set_yticks([0, 50, 100])
ax_a.grid(axis="y", color="0.88", lw=0.5)
ax_a.set_axisbelow(True)
ax_a.tick_params(which="both", pad=2, labelbottom=False)
handles = [
    mpl.patches.Patch(facecolor=GREEN + "22", edgecolor=GREEN, linewidth=0.7,
                      label="interlock intact"),
    mpl.patches.Patch(facecolor=RED + "14", edgecolor=RED, linewidth=0.7,
                      hatch="////", label="interlock bypassed"),
]
# legend outside the axes (top margin, right-aligned beside the panel tag):
# never on top of the data or the bar labels
ax_a.legend(handles=handles, loc="lower right", bbox_to_anchor=(1.0, 1.02),
            ncols=2, columnspacing=1.2, handlelength=1.5, handleheight=1.1,
            borderaxespad=0.0)
ax_a.text(0.0, 1.045, "(a)", transform=ax_a.transAxes, fontsize=7,
          ha="left", va="bottom")

# ------------------------------------------------- panel (b): write latency
for xi, (arm, _) in zip(x, ARMS):
    s = stats[arm]
    ax_b.errorbar([xi], [s["mean_p50"]],
                  yerr=[[s["mean_p50"] - s["min_p50"]],
                        [s["max_p95"] - s["mean_p50"]]],
                  fmt="o", color=BLUE, markerfacecolor=BLUE, markersize=4.2,
                  markeredgewidth=0.0, ecolor="black", elinewidth=0.8,
                  capsize=2.6, capthick=0.8, zorder=3)
    ax_b.text(xi, s["max_p95"] + 4.0, f"{s['mean_p50']:.1f}",
              ha="center", va="bottom", fontsize=6, color="black")

ax_b.set_ylabel("Write latency (ms)")
ax_b.set_ylim(95, 187)
ax_b.set_yticks([100, 125, 150, 175])
ax_b.grid(axis="y", color="0.88", lw=0.5)
ax_b.set_axisbelow(True)
ax_b.set_xticks(x)
ax_b.set_xticklabels([s["label"] for _, s in stats.items()], fontsize=6)
ax_b.set_xlim(-0.55, 3.55)
ax_b.tick_params(which="both", pad=2)
ax_b.text(0.012, 0.985,
          "dot: mean per-rep p50 (9 reps)   whisker: min p50 \u2192 max p95",
          transform=ax_b.transAxes, fontsize=6, ha="left", va="top",
          color="0.25")
ax_b.text(0.0, 1.06, "(b)", transform=ax_b.transAxes, fontsize=7,
          ha="left", va="bottom")

fig.savefig(OUT, dpi=300)
print("wrote", OUT)

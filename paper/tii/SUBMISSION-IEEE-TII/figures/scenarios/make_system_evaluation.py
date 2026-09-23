# -*- coding: utf-8 -*-
"""Two vertically-stacked single-column (3.5 in) figures, IEEE TII style,
for the paper-grade benchmark run 20260921184204-10lc (omp real engine).

Figure 1  fig-system-evaluation  -- outcome and closed-loop quality
  (a) per-phase wall-time profile (20 phases, log scale, real telemetry)
  (b) per-seed closed-loop J/J* against the offline optimum W*
Figure 2  fig-system-operations  -- governance attribution + operational evidence
  (a) E1a four-arm ablation (hatch = interlock removed)
  (b) runtime KPI strip

Style: Times 8 pt at final size, despined top/right axes, outward ticks,
dotted light grids, muted colourblind-safe fills, no chartjunk.
Data are frozen in scenario-fig-data.json (build-fig-data.mjs; assertions below
fail loudly on stale input).
"""
import json
import re
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "Times", "Nimbus Roman", "DejaVu Serif"],
    "mathtext.fontset": "stix",
    "font.size": 8,
    "axes.labelsize": 8,
    "axes.titlesize": 8,
    "xtick.labelsize": 7,
    "ytick.labelsize": 7,
    "axes.linewidth": 0.6,
    "xtick.major.width": 0.6,
    "ytick.major.width": 0.6,
    "xtick.direction": "out",
    "ytick.direction": "out",
    "lines.linewidth": 1.0,
    "hatch.linewidth": 0.5,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    "savefig.dpi": 600,
})

HERE = Path(__file__).resolve().parent
DATA = json.loads((HERE / "scenario-fig-data.json").read_text(encoding="utf-8"))
I = DATA["integrated"]

assert DATA["source"]["runId"] == "20260921184204-10lc"
assert I["status"] == "PASS" and I["score"] == 100.0
assert I["checks"] == {"pass": 83, "warn": 0, "fail": 0, "total": 83}
assert I["phases"] == {"pass": 20, "warn": 0, "fail": 0, "total": 20}
assert I["scenarioSubreport"] == {"status": "PASS", "attained": 4, "total": 4}
assert I["daqSamples"] == 55 and I["writeP50Ms"] == 29.954
assert I["backstopS"] == 130.196
assert I["closedLoop"]["ratioMean"] == 0.969
assert (I["closedLoop"]["ratioMin"], I["closedLoop"]["ratioMax"]) == (0.965, 0.972)
assert I["closedLoop"]["writesTotal"] == 6
assert I["closedLoop"]["rejectedTotal"] == 0
assert DATA["archivedPlc"]["pass"] == 5 and DATA["archivedPlc"]["fail"] == 0
assert DATA["ablation"]["source"].endswith("20260921181234-e1lite/run.json")
assert len(DATA["phaseProfile"]) == 20
assert DATA["totalWallMin"] == 26

INK = "#191919"
SUB = "#50565c"
GRID = "#cfd4d8"
GREEN = "#2E7D32"
AMBER = "#D9A017"
RED = "#B3282D"
STEEL = "#35618F"
STEEL_LIGHT = "#9DB9D2"


def tii_ax(ax, grid_axis=None):
    """IEEE TII look: keep left/bottom spines, remove top/right, ticks out."""
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(INK)
        ax.spines[s].set_linewidth(0.6)
    ax.tick_params(which="major", direction="out", length=2.6, width=0.6,
                   colors=INK)
    ax.minorticks_on()
    ax.tick_params(which="minor", direction="out", length=1.4, width=0.4,
                   colors=INK)
    if grid_axis:
        ax.grid(axis=grid_axis, color=GRID, linewidth=0.45, linestyle=(0, (1, 2)),
                zorder=0)
        ax.set_axisbelow(True)


def panel_tag(ax, tag):
    ax.text(-0.02, 1.04, tag, transform=ax.transAxes, fontweight="bold",
            fontsize=8, ha="right", va="bottom", color=INK)


# ══════════════════════════════════════════════════════════════════════
# Figure 1 · outcome + closed-loop quality
# ══════════════════════════════════════════════════════════════════════
fig, axs = plt.subplots(2, 1, figsize=(3.5, 3.62), facecolor="white",
                        height_ratios=[2.3, 1.5])
fig.subplots_adjust(left=0.105, right=0.965, top=0.945, bottom=0.105,
                    hspace=0.50)

# (a) per-phase wall-time profile (real telemetry, log scale).
ax = axs[0]
def _phase_key(pid: str):
    import re as _re
    m = _re.match(r"P(\d+)([a-z]?)$", pid)
    return (int(m.group(1)), m.group(2)) if m else (99, "")
ph = sorted(DATA["phaseProfile"], key=lambda p: _phase_key(p["id"]))
names = [p["id"] for p in ph]
vals = [max(p["s"], 0.05) for p in ph]
y = range(len(ph))
ax.barh(y, vals, color=STEEL, height=0.62, zorder=3)
ax.set_xscale("log")
ax.set_xlim(0.04, 2000)
big = [(n, v) for n, v in zip(names, vals) if v >= 70]
for n, v in big:
    i = names.index(n)
    ax.text(v * 1.15, i, f"{int(v)} s", va="center", fontsize=6.2, color=INK)
ax.set_yticks(list(y))
ax.set_yticklabels(names)
ax.invert_yaxis()
ax.set_xticks([0.1, 1, 10, 100, 1000])
ax.set_xticklabels(["0.1", "1", "10", "100", "1000"])
ax.set_xlabel(f"Phase wall time (s, log scale) — total {DATA['totalWallMin']} min, 83/83 checks passed")

tii_ax(ax, "x")
panel_tag(ax, "(a)")

# (b) per-seed closed-loop J/J* against W*.
ax = axs[1]
per_seed = I["closedLoop"]["perSeed"]
xs = list(range(3))
ratios = [100 * item["ratio"] for item in per_seed]
writes = [item["writes"] for item in per_seed]
ax.bar(xs, [r - 95 for r in ratios], bottom=95, width=0.52,
       color=[STEEL_LIGHT, STEEL, STEEL], edgecolor=INK, linewidth=0.5,
       zorder=3)
for x, r, w in zip(xs, ratios, writes):
    ax.text(x, r + 0.16, f"{r:.1f}%", ha="center", fontsize=7, color=INK)
ax.axhline(96.9, color=AMBER, lw=0.9, ls="--", zorder=4)
ax.set_xlim(-0.5, 3.05)
ax.text(2.34, 97.02, "mean 96.9%", color=AMBER, fontsize=6.2, va="bottom",
        ha="left")
ax.set_xticks(xs)
ax.set_xticklabels([f"seed {s}\n({w} writes)" for s, w in
                    zip([p["seed"] for p in per_seed], writes)])
ax.set_ylim(95, 100)
ax.set_yticks([95, 96, 97, 98, 99, 100])
ax.set_ylabel(r"Closed-loop $J/J^{*}$ (%)")
tii_ax(ax, "y")
panel_tag(ax, "(b)")

fig.savefig(HERE / "fig-system-evaluation.pdf", bbox_inches="tight", pad_inches=0.02)
fig.savefig(HERE / "fig-system-evaluation.png", dpi=400, bbox_inches="tight", pad_inches=0.02)
plt.close(fig)
print("wrote fig-system-evaluation.(pdf|png) [3.5 in, TII style]")

# ══════════════════════════════════════════════════════════════════════
# Figure 2 · governance attribution + operational evidence
# ══════════════════════════════════════════════════════════════════════
fig, axs = plt.subplots(2, 1, figsize=(3.5, 3.85), facecolor="white",
                        height_ratios=[1.55, 0.85])
fig.subplots_adjust(left=0.125, right=0.965, top=0.905, bottom=0.105,
                    hspace=0.62)

# (a) E1a four-arm ablation: hatch encodes "interlock removed".
ax = axs[0]
ab = DATA["ablation"]
intercepted = [round(v * 6) for v in ab["intercepted"]]
breaches = ab["breaches"]
styles = [
    dict(color=GREEN, hatch=""),
    dict(color="#E7C25A", hatch="///"),
    dict(color=GREEN, hatch=""),
    dict(color="#E7C25A", hatch="///"),
]
bars = ax.bar(range(4), intercepted, width=0.56, zorder=3,
              edgecolor=INK, linewidth=0.5)
for bar, st in zip(bars, styles):
    bar.set_facecolor(st["color"])
    bar.set_hatch(st["hatch"])
for i, (bar, breach) in enumerate(zip(bars, breaches)):
    ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.15,
            f"{bar.get_height():.0f}/6", ha="center", va="bottom",
            fontsize=7, color=INK)
    if breach:
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.85,
                f"{breach} breaches", ha="center", va="bottom",
                fontsize=6.0, color=RED)
ax.set_xticks(range(4))
ax.set_xticklabels(["Full", "No\ninterlock", "No\nreadback", "Ungated"])
ax.set_ylabel("Attacks intercepted\n(mean of 3 reps)")
ax.set_ylim(0, 8.6)
ax.set_yticks([0, 2, 4, 6, 8])
ax.set_xlim(-0.6, 3.6)
ax.set_title("E1a ablation (20260921181234-e1lite): 0 false blocks in all arms",
             pad=5, fontsize=7.2)
tii_ax(ax, "y")
panel_tag(ax, "(a)")

# (b) runtime KPI strip: thin separators, no boxes.
ax = axs[1]
ax.set_axis_off()
stats = [
    ("DAQ samples", "55", "integrated run", STEEL),
    ("Write p50", "29.95 ms", "all protocols", STEEL),
    ("Backstop", "130.2 s", "fired + restored", AMBER),
    ("PLC checks", "5/5", "same session", GREEN),
]
n = len(stats)
for i, (label, value, note, color) in enumerate(stats):
    xc = (i + 0.5) / n
    ax.text(xc, 0.66, value, transform=ax.transAxes, fontsize=10.5,
            color=color, fontweight="bold", va="center", ha="center")
    ax.text(xc, 0.38, label, transform=ax.transAxes, fontsize=6.4,
            color=INK, va="center", ha="center")
    ax.text(xc, 0.14, note, transform=ax.transAxes, fontsize=5.7,
            color=SUB, va="center", ha="center")
    if i:
        ax.plot([i / n, i / n], [0.08, 0.85], transform=ax.transAxes,
                color=GRID, lw=0.7, clip_on=False)
ax.set_xlim(0, 1)
ax.set_ylim(0, 1)
ax.text(0.0, 1.04, "Operational evidence (same benchmark session)",
        transform=ax.transAxes, fontsize=7.2, fontweight="bold", color=INK,
        va="bottom")
panel_tag(ax, "(b)")

fig.savefig(HERE / "fig-system-operations.pdf", bbox_inches="tight", pad_inches=0.02)
fig.savefig(HERE / "fig-system-operations.png", dpi=400, bbox_inches="tight", pad_inches=0.02)
plt.close(fig)
print("wrote fig-system-operations.(pdf|png) [3.5 in, TII style]")

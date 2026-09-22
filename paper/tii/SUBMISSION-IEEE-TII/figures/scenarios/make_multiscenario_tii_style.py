# -*- coding: utf-8 -*-
"""Render detailed trajectories for all four scenario missions of the latest
paper-grade benchmark run (20260921184204-10lc, omp real-engine closed loop).

All four objectives are ATTAINED.  The target band is hatched, the filled
terminal marker encodes attainment, and every plotted point is an archived
observation -- no interpolated measurements (dashed segments only bridge
archived observations to the terminal state).
"""
import json
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
    "axes.titlesize": 8.4,
    "xtick.labelsize": 7,
    "ytick.labelsize": 7,
    "axes.linewidth": 0.7,
    "xtick.major.width": 0.7,
    "ytick.major.width": 0.7,
    "lines.linewidth": 0.9,
    "lines.markersize": 3.8,
    "hatch.linewidth": 0.45,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    "savefig.dpi": 600,
})

HERE = Path(__file__).resolve().parent
DATA = json.loads((HERE / "scenario-fig-data.json").read_text(encoding="utf-8"))
BY = {s["id"]: s for s in DATA["scenarios"]}

assert DATA["source"]["runId"] == "20260921184204-10lc"
assert DATA["integrated"]["scenarioSubreport"] == {"status": "PASS", "attained": 4, "total": 4}
assert round(BY["injection"]["final"], 2) == 32.17 and BY["injection"]["attained"]
assert BY["injection"]["writes"] == 2
assert round(BY["wwtp"]["final"], 2) == 3.50 and BY["wwtp"]["writes"] == 15
assert round(BY["anneal"]["final"], 2) == 100.08 and BY["anneal"]["attained"]
assert BY["anneal"]["writes"] == 5
assert round(BY["anneal"]["throughput"]["gain"], 2) == 17.14
assert round(BY["biax"]["final"], 2) == 25.66 and BY["biax"]["writes"] == 3
assert BY["biax"]["attained"] and BY["biax"]["taskTerminal"] == "COMPLETED"

INK = "#111111"
SUB = "#50565c"
GRID = "#cfd4d8"
BAND = "#e8ecef"
PASS = "#2E7D32"
WARN = "#D08A00"
FAIL = "#B3282D"
TRIM = "#7B5EA7"


def style_ax(ax, grid_axis="y"):
    for spine in ax.spines.values():
        spine.set_color(INK)
        spine.set_linewidth(0.7)
    ax.tick_params(which="major", direction="in", length=2.8, width=0.7,
                   top=True, right=True, colors=INK)
    ax.minorticks_on()
    ax.tick_params(which="minor", direction="in", length=1.5, width=0.5,
                   top=True, right=True, colors=INK)
    if grid_axis:
        ax.grid(axis=grid_axis, color=GRID, linewidth=0.5, zorder=0)
        ax.set_axisbelow(True)


def panel_tag(ax, tag):
    ax.text(-0.14, 1.045, tag, transform=ax.transAxes, fontweight="bold",
            fontsize=8.5, ha="left", va="bottom", color=INK)


def target_band(ax, s):
    lo, hi = s["target"] - s["tol"], s["target"] + s["tol"]
    ax.axhspan(lo, hi, facecolor=BAND, edgecolor=SUB, linewidth=0.0,
               hatch="////", alpha=0.55, zorder=1)
    ax.axhline(lo, color=SUB, lw=0.55, zorder=2)
    ax.axhline(hi, color=SUB, lw=0.55, zorder=2)
    ax.axhline(s["target"], color=SUB, lw=0.7, ls="-.", zorder=2)


def trajectory(ax, xs, ys, attained):
    ax.plot(xs, ys, "-o", color=INK, mfc="white", mec=INK, mew=0.8,
            lw=0.9, zorder=4)
    ax.plot(xs[-1], ys[-1], "o", color=PASS if attained else FAIL,
            mec=INK, mew=0.6, ms=5.0, zorder=6)


def status(ax, attained, text=None):
    label = text or ("ATTAINED" if attained else "NOT ATTAINED")
    ax.text(0.98, 0.94, label, transform=ax.transAxes, ha="right", va="top",
            fontsize=6.7, fontweight="bold", color=PASS if attained else FAIL,
            bbox=dict(facecolor="white", edgecolor="none", pad=0.8), zorder=8)


def write_triangles(ax, xs, y):
    for x in xs:
        ax.plot(x, y, marker="^", color=WARN, ms=3.4, clip_on=False, zorder=5)


fig, axs = plt.subplots(2, 2, figsize=(7.16, 4.02), facecolor="white")
fig.subplots_adjust(left=0.082, right=0.985, bottom=0.118, top=0.928,
                    wspace=0.31, hspace=0.46)

# (a) Injection moulding: part weight into 32.5 +/- 0.35 g band in 2 governed writes.
s = BY["injection"]
ax = axs[0, 0]
target_band(ax, s)
xs = list(range(len(s["traj"])))
ys = [p["pv"] for p in s["traj"]]
trajectory(ax, xs, ys, s["attained"])
for x, y in zip(xs, ys):
    if x == xs[-1]:
        ax.text(x - 0.06, y + 0.12, f"{y:.2f}", ha="right", va="bottom",
                fontsize=6.2, color=INK)
    else:
        ax.text(x, y - 0.13 if x else y + 0.12, f"{y:.2f}", ha="center",
                va="top" if x else "bottom", fontsize=6.2, color=INK)
write_triangles(ax, xs[1:], 31.06)
ax.text(0.97, 0.20, f"{s['writes']} governed writes", transform=ax.transAxes,
        fontsize=6.4, color=SUB, ha="right",
        bbox=dict(facecolor="white", edgecolor="none", pad=0.5))
ax.set_xlim(-0.25, 2.35)
ax.set_ylim(30.95, 32.95)
ax.set_xticks(xs)
ax.set_xlabel("Optimization round (0 = baseline)")
ax.set_ylabel("Part weight (g)")
ax.set_title("Injection moulding", pad=5)
status(ax, s["attained"])
style_ax(ax)
panel_tag(ax, "(a)")

# (b) WWTP: aerobic DO raised into 3.4 +/- 0.6 mg/L band, then cost stepped down.
s = BY["wwtp"]
ax = axs[0, 1]
target_band(ax, s)
do_points = [p for p in s["traj"] if p.get("phase") in ("baseline", "blower")]
xs = list(range(len(do_points)))
ys = [p["pv"] for p in do_points]
ax.plot(xs, ys, "-o", color=INK, mfc="white", mec=INK, mew=0.8, lw=0.9, zorder=4)
ax.plot([xs[-1], s["rounds"]], [ys[-1], s["final"]], ls=(0, (3, 2)),
        color=INK, lw=0.9, zorder=3)
ax.plot(s["rounds"], s["final"], "o", color=PASS, mec=INK, mew=0.6, ms=5.0, zorder=6)
for x, y in zip(xs, ys):
    if x == 0:
        ax.text(x + 0.12, y - 0.16, f"{y:.2f}", ha="left", va="top",
                fontsize=6.0, color=INK)
    else:
        ax.text(x, y + 0.13, f"{y:.2f}", ha="center", fontsize=6.0, color=INK)
ax.text(s["rounds"] - 0.15, s["final"] + 0.13, f"{s['final']:.2f}", ha="right",
        fontsize=6.2, color=PASS, fontweight="bold")
ax.text(0.97, 0.08,
        f"{s['writes']} writes; compliant cost {s['cost']['firstCompliant']:.1f} -> {s['cost']['final']:.1f}",
        transform=ax.transAxes, ha="right", fontsize=6.3, color=SUB)
ax.set_xlim(-0.55, 13.6)
ax.set_ylim(0, 4.55)
ax.set_xticks([0, 2, 4, 6, 8, 10, 12])
ax.set_xlabel("Optimization round (0 = baseline)")
ax.set_ylabel("Aerobic DO (mg/L)")
ax.set_title("WWTP (A2O process)", pad=5)
status(ax, s["attained"])
style_ax(ax)
panel_tag(ax, "(b)")

# (c) Continuous annealing: margin trims (zone2) then capacity push to +17.1%.
s = BY["anneal"]
ax = axs[1, 0]
target_band(ax, s)
xs = list(range(len(s["traj"])))
ys = [p["pv"] for p in s["traj"]]
ax.plot(xs, ys, "-o", color=INK, mfc="white", mec=INK, mew=0.8, lw=0.9, zorder=4)
ax.plot(xs[-1], ys[-1], "o", color=PASS, mec=INK, mew=0.6, ms=5.0, zorder=6)
for x, p in zip(xs, s["traj"]):
    if p.get("phase") == "margin":
        ax.plot(x, p["pv"], marker="s", color=TRIM, ms=3.6, zorder=6)
ax.text(0.55, 0.62, "margin trim\n(zone2 710 to 722 C)", transform=ax.transAxes,
        fontsize=6.0, color=TRIM, ha="left", linespacing=1.2)
ax.text(0.03, 0.18, f"+{s['throughput']['gain']:.1f}% line speed\n(140 to {s['throughput']['finalSp']:.0f} m/min)",
        transform=ax.transAxes, fontsize=6.1, color=PASS, ha="left", linespacing=1.25)
ax.text(0.97, 0.18, f"{s['writes']} governed writes", transform=ax.transAxes,
        fontsize=6.3, color=SUB, ha="right")
ax.set_xticks(xs)
ax.set_ylim(95, 140)
ax.set_xlabel("Governed write index (0 = baseline)")
ax.set_ylabel("Vickers hardness (HV)")
ax.set_title("Continuous annealing", pad=5)
status(ax, s["attained"])
style_ax(ax)
panel_tag(ax, "(c)")

# (d) BOPET biaxial line: thickness 28.10 -> 25.66 um into the 25 +/- 0.7 band.
s = BY["biax"]
ax = axs[1, 1]
target_band(ax, s)
xs = list(range(len(s["traj"])))
ys = [p["pv"] for p in s["traj"]]
trajectory(ax, xs, ys, s["attained"])
for x, y in zip(xs, ys):
    if x == xs[-1]:
        ax.text(x - 0.06, y + 0.5, f"{y:.2f}", ha="right", va="bottom",
                fontsize=5.9, color=PASS, fontweight="bold", zorder=8,
                bbox=dict(facecolor="white", edgecolor="none", pad=0.8))
    else:
        dy = 0.55 if x in (0, 1) else -0.72
        ax.text(x, y + dy, f"{y:.2f}", ha="center",
                va="bottom" if dy > 0 else "top", fontsize=5.9, color=INK)
write_triangles(ax, xs[1:], 24.75)
ax.text(0.03, 0.08, f"{s['writes']} writes / {s['distinctKnobs']} nodes",
        transform=ax.transAxes, fontsize=6.3, color=SUB, ha="left")
ax.set_xlim(-0.4, 3.4)
ax.set_ylim(24.2, 29.2)
ax.set_xticks(xs)
ax.set_xlabel("Governed write index (0 = baseline)")
ax.set_ylabel("Finished thickness (μm)")
ax.set_title("BOPET biaxial line", pad=5)
status(ax, s["attained"])
style_ax(ax)
panel_tag(ax, "(d)")

fig.text(0.5, 0.022,
         "Run 20260921184204-10lc: 4/4 objectives attained; triangles denote governed writes; squares denote margin trims.",
         ha="center", va="bottom", fontsize=6.7, color=SUB)
fig.savefig(HERE / "fig-multiscenario-optimization.pdf", bbox_inches="tight", pad_inches=0.02)
fig.savefig(HERE / "fig-multiscenario-optimization.png", dpi=400, bbox_inches="tight", pad_inches=0.02)
plt.close(fig)
print("wrote fig-multiscenario-optimization.(pdf|png)")

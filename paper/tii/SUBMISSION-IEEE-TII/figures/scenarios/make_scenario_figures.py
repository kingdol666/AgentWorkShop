# -*- coding: utf-8 -*-
"""Render a compact four-scenario outcome summary for IEEE TII.

The figure separates objective attainment from task completion and shows the
latest mixed result (2/4 attained) from run 20260921061700-177w.
"""
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

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
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    "savefig.dpi": 600,
})

HERE = Path(__file__).resolve().parent
DATA = json.loads((HERE / "scenario-fig-data.json").read_text(encoding="utf-8"))
BY = {s["id"]: s for s in DATA["scenarios"]}
ORDER = ["injection", "wwtp", "anneal", "biax"]
SHORT = ["Injection", "WWTP", "Annealing", "BOPET"]

assert DATA["source"]["runId"] == "20260921061700-177w"
assert DATA["integrated"]["scenarioSubreport"] == {"status": "FAIL", "attained": 2, "total": 4}
assert [(BY[k]["attained"], BY[k]["writes"]) for k in ORDER] == [
    (True, 3), (True, 15), (False, 5), (False, 6)
]
assert round(BY["injection"]["traj"][0]["pv"], 2) == 31.25 and round(BY["injection"]["final"], 2) == 32.36
assert round(BY["wwtp"]["traj"][0]["pv"], 2) == 0.21 and round(BY["wwtp"]["final"], 2) == 3.59
assert round(BY["wwtp"]["cost"]["firstCompliant"], 1) == 181.5 and round(BY["wwtp"]["cost"]["final"], 1) == 179.1
assert round(BY["anneal"]["traj"][0]["pv"], 1) == 134.7 and round(BY["anneal"]["final"], 1) == 102.5
assert BY["anneal"]["throughput"]["finalSp"] == 176 and BY["anneal"]["rollback"]["attemptedSpeed"] == 188
assert round(BY["biax"]["traj"][0]["pv"], 2) == 46.50 and round(BY["biax"]["final"], 2) == 28.00
assert BY["biax"]["taskTerminal"] == "COMPLETED" and not BY["biax"]["attained"]

INK = "#191919"
SUB = "#50565c"
GRID = "#d7dce0"
PASS = "#2E7D32"
WARN = "#D08A00"
FAIL = "#B3282D"
BLUE = "#34699A"
GREY = "#8a9197"


def style_ax(ax, grid_axis=None):
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


def card(ax, x, y, w, h, title, lines, color):
    patch = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.012,rounding_size=0.015",
                           transform=ax.transAxes, facecolor="white", edgecolor=GRID,
                           linewidth=0.8)
    ax.add_patch(patch)
    ax.text(x + 0.03, y + h - 0.055, title, transform=ax.transAxes,
            fontsize=7.3, fontweight="bold", color=color, va="top")
    ax.text(x + 0.03, y + h - 0.145, "\n".join(lines), transform=ax.transAxes,
            fontsize=6.5, color=INK, va="top", linespacing=1.35)


fig, axs = plt.subplots(2, 2, figsize=(7.16, 4.72), facecolor="white")
fig.subplots_adjust(left=0.082, right=0.985, bottom=0.105, top=0.91,
                    wspace=0.31, hspace=0.50)

# (a) Normalized target error. Values <= 1 are within the target band.
ax = axs[0, 0]
for i, sid in enumerate(ORDER):
    s = BY[sid]
    baseline = s["traj"][0]["pv"]
    e0 = abs(baseline - s["target"]) / s["tol"]
    ef = abs(s["final"] - s["target"]) / s["tol"]
    ax.plot([i, i], [e0, ef], color=GREY, lw=1.0, zorder=2)
    ax.scatter(i, e0, s=24, facecolor="white", edgecolor=BLUE, linewidth=0.9,
               zorder=4, label="baseline" if i == 0 else None)
    ax.scatter(i, ef, s=28, facecolor=PASS if s["attained"] else FAIL,
               edgecolor=INK, linewidth=0.6, zorder=5,
               label="final" if i == 0 else None)
    ax.text(i, min(e0 * 1.16, 36), f"{e0:.1f}x", ha="center", va="bottom", fontsize=6.2, color=SUB)
    ax.text(i, ef / 1.18, f"{ef:.2f}x", ha="center", va="top", fontsize=6.2,
            color=PASS if s["attained"] else FAIL)
ax.axhspan(0.18, 1.0, color=PASS, alpha=0.09, zorder=0)
ax.axhline(1.0, color=PASS, lw=0.8, ls="--", zorder=1)
ax.text(0.02, 0.26, "inside target band", transform=ax.transAxes,
        color=PASS, fontsize=6.3)
ax.set_yscale("log")
ax.set_ylim(0.18, 45)
ax.set_xticks(range(4))
ax.set_xticklabels(SHORT)
ax.set_ylabel("Target error / tolerance")
ax.set_title("Baseline to final objective distance", pad=5)
ax.legend(frameon=False, loc="upper right", ncol=2, handletextpad=0.3,
          columnspacing=0.8)
style_ax(ax, "y")
panel_tag(ax, "(a)")

# (b) Governed writes and unambiguous attainment status.
ax = axs[0, 1]
writes = [BY[k]["writes"] for k in ORDER]
colors = [PASS if BY[k]["attained"] else FAIL for k in ORDER]
bars = ax.bar(range(4), writes, width=0.55, color=colors, zorder=3)
for i, (bar, sid) in enumerate(zip(bars, ORDER)):
    status = "YES" if BY[sid]["attained"] else "NO"
    ax.text(i, bar.get_height() + 0.35, str(BY[sid]["writes"]), ha="center",
            fontsize=6.8, color=INK)
    ax.text(i, max(0.8, bar.get_height() * 0.50), status, ha="center", va="center",
            fontsize=6.2, color="white", fontweight="bold")
ax.set_xticks(range(4))
ax.set_xticklabels(SHORT)
ax.set_ylabel("Governed writes")
ax.set_ylim(0, 17.5)
ax.set_yticks([0, 4, 8, 12, 16])
ax.set_title("Scenario subreport FAIL: 2/4 attained", color=FAIL, pad=5)
ax.text(0.02, 0.96, "green = attained; red = not attained", transform=ax.transAxes,
        fontsize=6.1, color=SUB, va="top")
style_ax(ax, "y")
panel_tag(ax, "(b)")

# (c) Attained scenario evidence.
ax = axs[1, 0]
ax.set_axis_off()
inj = BY["injection"]
ww = BY["wwtp"]
card(ax, 0.02, 0.54, 0.96, 0.39, "Injection molding - ATTAINED", [
    f"part weight {inj['traj'][0]['pv']:.2f} -> {inj['final']:.2f} g",
    f"target {inj['target']:.1f} +/- {inj['tol']:.2f} g; {inj['writes']} writes",
], PASS)
card(ax, 0.02, 0.06, 0.96, 0.39, "WWTP (A2O) - ATTAINED", [
    f"DO {ww['traj'][0]['pv']:.2f} -> {ww['final']:.2f} mg/L; {ww['writes']} writes",
    f"compliant cost {ww['cost']['firstCompliant']:.1f} -> {ww['cost']['final']:.1f} (-{ww['cost']['saving']:.1f})",
], PASS)
ax.text(0.0, 1.025, "Attained objectives", transform=ax.transAxes,
        fontsize=8.4, fontweight="bold", color=INK, va="bottom")
panel_tag(ax, "(c)")

# (d) Unattained scenario evidence, explicitly separating terminal state.
ax = axs[1, 1]
ax.set_axis_off()
an = BY["anneal"]
bi = BY["biax"]
card(ax, 0.02, 0.54, 0.96, 0.39, "Continuous annealing - NOT ATTAINED", [
    f"hardness {an['traj'][0]['pv']:.1f} -> {an['final']:.1f} HV (upper band {an['target'] + an['tol']:.0f})",
    f"line speed 140 -> {an['throughput']['finalSp']} m/min; {an['rollback']['attemptedSpeed']} rejected + reverted",
], FAIL)
card(ax, 0.02, 0.06, 0.96, 0.39, "BOPET - NOT ATTAINED", [
    f"thickness {bi['traj'][0]['pv']:.2f} -> {bi['final']:.2f} μm; target {bi['target']:.1f} +/- {bi['tol']:.1f}",
    f"{bi['writes']} writes on {bi['distinctKnobs']} knobs; task {bi['taskTerminal']} does not imply attainment",
], FAIL)
ax.text(0.0, 1.025, "Unattained objectives", transform=ax.transAxes,
        fontsize=8.4, fontweight="bold", color=INK, va="bottom")
panel_tag(ax, "(d)")

fig.text(0.5, 0.025,
         "Latest scenario HTML report (20260921061700-177w): task completion is not used as an attainment proxy.",
         ha="center", va="bottom", fontsize=6.7, color=SUB)
fig.savefig(HERE / "fig-scenario-optimization.pdf", bbox_inches="tight", pad_inches=0.02)
fig.savefig(HERE / "fig-scenario-optimization.png", dpi=400, bbox_inches="tight", pad_inches=0.02)
plt.close(fig)
print("wrote fig-scenario-optimization.(pdf|png)")

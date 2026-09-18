"""Generate Fig. 6, the AgentTeam biaxial-film mission, from archive B.

Source: bench/results/20260918043504-bdo/{run.json,agentteam-biax.log}
Output: fig10-agentteam-biax.pdf and fig10-agentteam-biax.png

Every value drawn here is asserted against the machine-readable archive before
the figure is written, so the figure cannot drift from the benchmark report.
The script only reads the archive; it never rewrites it.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Rectangle


OUT = Path(__file__).resolve().parent
REPO = OUT.parents[3]
RUN = REPO / "bench" / "results" / "20260918043504-bdo" / "run.json"
LOG = REPO / "bench" / "results" / "20260918043504-bdo" / "agentteam-biax.log"
DATA = json.loads(RUN.read_text(encoding="utf-8"))
LOG_TEXT = LOG.read_text(encoding="utf-8")


def close(actual: float, expected: float, tol: float = 1e-9) -> bool:
    return math.isclose(float(actual), expected, rel_tol=0.0, abs_tol=tol)


# ---------------------------------------------------------------- archive lock
biax = DATA["env"]["biax"]
assert int(biax["devices"]) == 9
assert int(biax["signals"]) == 49
assert int(biax["sp"]) == 30
assert int(biax["platformDcw"]) == 30
assert int(biax["platformDaq"]) == 19
assert int(biax["missionWrites"]) == 3
assert int(biax["missionKnobs"]) == 3
assert biax["missionAttained"] is True
assert close(biax["missionFinalUm"], 25.68, 5e-4)

mission = biax["missionTraj"]
assert len(mission) == 4
thickness = [float(point["thickness"]) for point in mission]
assert [round(value, 2) for value in thickness] == [28.10, 26.62, 25.90, 25.68]

actions = mission[1:]
assert [point["knob"] for point in actions] == [
    "cast-spd-sp",
    "fast-roll-sp",
    "rail-out-sp",
]
assert [(float(point["from"]), float(point["to"])) for point in actions] == [
    (32.0, 33.8),
    (118.0, 120.5),
    (3000.0, 3031.0),
]
assert [point["record"] for point in actions] == [
    "opt-86313140",
    "opt-41929fe2",
    "opt-8d2faadb",
]
assert [point["node"] for point in actions] == [
    "dw-d37da04d",
    "dw-7a5e274f",
    "dw-64ed3909",
]
melt = [float(point["meltTemp"]) for point in actions]
assert all(close(value, 291.5, 0.2) for value in melt)

TARGET, TOL = 25.0, 0.7
assert TARGET - TOL <= thickness[-1] <= TARGET + TOL
MELT_LO, MELT_HI = 268.0, 300.0
assert all(MELT_LO <= value <= MELT_HI for value in melt)

# Steps quoted in the mission trace must actually appear in the archived log.
for token in [
    "initial thickness=28.10",
    "cast-spd-sp 32\u219233.8",
    "fast-roll-sp 118\u2192120.5",
    "rail-out-sp 3000\u21923031",
    "writes=3 distinctKnobs=3 final=25.68",
    "terminal=COMPLETED",
]:
    assert token in LOG_TEXT, token

# --------------------------------------------------------------------- drawing
MM = 1.0 / 25.4
INK = "#175D66"
ACCENT = "#B35A2A"
GREEN = "#3C7A45"
GREY = "0.35"

mpl.rcParams.update(
    {
        "font.family": "serif",
        "font.serif": ["Times New Roman", "STIXGeneral", "DejaVu Serif"],
        "mathtext.fontset": "stix",
        "font.size": 6,
        "axes.labelsize": 6.5,
        "xtick.labelsize": 6,
        "ytick.labelsize": 6,
        "legend.fontsize": 5.8,
        "axes.linewidth": 0.6,
        "lines.linewidth": 1.05,
        "lines.markersize": 3.0,
        "xtick.direction": "in",
        "ytick.direction": "in",
        "xtick.top": True,
        "ytick.right": True,
        "xtick.major.size": 2.2,
        "ytick.major.size": 2.2,
        "xtick.minor.size": 1.2,
        "ytick.minor.size": 1.2,
        "xtick.minor.visible": True,
        "ytick.minor.visible": True,
        "pdf.fonttype": 42,
        "savefig.dpi": 400,
    }
)

fig = plt.figure(figsize=(178 * MM, 63 * MM))
gs = fig.add_gridspec(
    2,
    2,
    height_ratios=[1.0, 1.30],
    width_ratios=[1.0, 1.0],
    hspace=0.85,
    wspace=0.24,
    left=0.052,
    right=0.988,
    top=0.905,
    bottom=0.115,
)

# -- (a) recorded mission process -------------------------------------------
axT = fig.add_subplot(gs[0, :])
axT.set_xlim(0, 1)
axT.set_ylim(0, 1)
axT.axis("off")
axT.text(0.0, 1.10, "(a) Recorded mission process (archive $B$)",
         fontweight="bold", va="bottom", fontsize=6.5)

steps = [
    ("1  Objective filed",
     ["$h\\rightarrow25.0\\pm0.7\\,\\mu$m", "$\\leq$ 6 governed writes"]),
    ("2  Task board",
     ["lead dispatches", "bound worker"]),
    ("3  Gauge read",
     ["daq\\_query, 300 s", "$h=28.10\\,\\mu$m"]),
    ("4  Governed write $\\times$3",
     ["cast-spd 32$\\rightarrow$33.8",
      "fast-roll 118$\\rightarrow$120.5",
      "rail-out 3000$\\rightarrow$3031"]),
    ("5  Records",
     ["3 writes accepted", "keep, ledger"]),
    ("6  Closed",
     ["$h=25.68\\,\\mu$m attained",
      "parent COMPLETED"]),
]

n = len(steps)
gap = 0.018
box_w = (1.0 - gap * (n - 1)) / n
box_y, box_h = 0.04, 0.82
for index, (title, lines) in enumerate(steps):
    x0 = index * (box_w + gap)
    axT.add_patch(
        FancyBboxPatch(
            (x0, box_y),
            box_w,
            box_h,
            boxstyle="round,pad=0.006,rounding_size=0.02",
            linewidth=0.6,
            edgecolor=INK if index != 3 else ACCENT,
            facecolor="#EDF3FA" if index != 3 else "#FBEDED",
        )
    )
    axT.text(x0 + 0.008, box_y + box_h - 0.15, title,
             fontsize=5.9, fontweight="bold",
             color=INK if index != 3 else ACCENT, va="center")
    for line_index, line in enumerate(lines):
        axT.text(x0 + 0.010, box_y + box_h - 0.38 - line_index * 0.20, line,
                 fontsize=5.4, va="center", color="0.12")
    if index < n - 1:
        axT.add_patch(
            FancyArrowPatch(
                (x0 + box_w + 0.002, box_y + box_h / 2),
                (x0 + box_w + gap - 0.002, box_y + box_h / 2),
                arrowstyle="-|>",
                mutation_scale=5,
                linewidth=0.7,
                color=GREY,
            )
        )

# -- (b) thickness trajectory ------------------------------------------------
axb = fig.add_subplot(gs[1, 0])
x = np.arange(4)
axb.axhspan(TARGET - TOL, TARGET + TOL, color="#DDEEDB", linewidth=0)
axb.axhline(TARGET, color=GREEN, linewidth=0.8, linestyle=(0, (4, 3)))
axb.plot(x, thickness, color=INK, marker="o", markerfacecolor="white",
         markeredgewidth=0.9)
for xi, value in zip(x, thickness):
    axb.annotate(f"{value:.2f}", xy=(xi, value), xytext=(0, -8.5),
                 textcoords="offset points", ha="center", va="top",
                 fontsize=5.6)
label_y = 28.62
for index, point in enumerate(actions, start=1):
    mid_x = index - 0.5
    mid_y = (thickness[index - 1] + thickness[index]) / 2.0
    axb.annotate(
        f"{point['knob']}\n"
        f"{float(point['from']):g}$\\rightarrow${float(point['to']):g}",
        xy=(mid_x, mid_y),
        xytext=(mid_x, label_y),
        ha="center",
        va="top",
        fontsize=5.1,
        color=ACCENT,
        linespacing=1.35,
        arrowprops={"arrowstyle": "-", "linewidth": 0.45, "color": "0.55",
                    "shrinkA": 1.5, "shrinkB": 1.5},
    )
axb.set_xlim(-0.32, 3.34)
axb.set_ylim(24.15, 28.95)
axb.set_xticks([0, 1, 2, 3])
axb.set_xticklabels(["initial", "iter 1", "iter 2", "iter 3"])
axb.set_yticks([25, 26, 27, 28])
axb.set_ylabel(r"Thickness $h$ ($\mu$m)")
axb.grid(axis="y", color="0.90", linewidth=0.5)
axb.set_axisbelow(True)
axb.text(0.005, 1.045, "(b)", transform=axb.transAxes, fontweight="bold",
         va="bottom", fontsize=6.5)
axb.text(0.025, 0.035, r"target $25.0\pm0.7\,\mu$m", transform=axb.transAxes,
         ha="left", va="bottom", fontsize=5.6, color=GREEN)

# -- (c) melt temperature against its safety window --------------------------
axc = fig.add_subplot(gs[1, 1])
axc.axhspan(MELT_LO, MELT_HI, color="#FBEDED", linewidth=0)
axc.axhline(MELT_LO, color=ACCENT, linewidth=0.7, linestyle=(0, (4, 3)))
axc.axhline(MELT_HI, color=ACCENT, linewidth=0.7, linestyle=(0, (4, 3)))
xc = np.arange(1, 4)
axc.plot(xc, melt, color=INK, marker="s", markerfacecolor="white",
         markeredgewidth=0.9)
for xi, value in zip(xc, melt):
    axc.annotate(f"{value:.1f}", xy=(xi, value), xytext=(0, -7.5),
                 textcoords="offset points", ha="center", va="top",
                 fontsize=5.6)
axc.set_xlim(0.62, 3.38)
axc.set_ylim(264, 306)
axc.set_xticks([1, 2, 3])
axc.set_xticklabels(["iter 1", "iter 2", "iter 3"])
axc.set_yticks([270, 280, 290, 300])
axc.set_ylabel(r"Melt temperature ($^\circ$C)")
axc.grid(axis="y", color="0.90", linewidth=0.5)
axc.set_axisbelow(True)
axc.text(0.02, 0.985, "process window 268--300$^\\circ$C (non-binding)",
         transform=axc.transAxes, fontsize=5.6, color=ACCENT, va="top")
axc.text(0.005, 1.045, "(c)", transform=axc.transAxes, fontweight="bold",
         va="bottom", fontsize=6.5)

fig.savefig(OUT / "fig10-agentteam-biax.pdf", format="pdf")
fig.savefig(OUT / "fig10-agentteam-biax.png", dpi=400)
print("wrote fig10-agentteam-biax.pdf/.png from", RUN)

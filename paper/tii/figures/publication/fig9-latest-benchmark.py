"""Generate Fig. 9 from the latest integrated benchmark archive B.

Source: bench/results/20260918043504-bdo/run.json
Output: fig9-latest-benchmark.pdf and fig9-latest-benchmark.png
The script reads the machine-readable run record and asserts the key values
before drawing them. It does not modify the benchmark archive.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np


OUT = Path(__file__).resolve().parent
REPO = OUT.parents[3]
RUN = REPO / "bench" / "results" / "20260918043504-bdo" / "run.json"
SUMMARY = REPO / "bench" / "results" / "20260918043504-bdo" / "summary.json"
DATA = json.loads(RUN.read_text(encoding="utf-8"))
SUMMARY_DATA = json.loads(SUMMARY.read_text(encoding="utf-8"))


def close(actual: float, expected: float, tol: float = 1e-9) -> bool:
    return math.isclose(float(actual), expected, rel_tol=0.0, abs_tol=tol)


latency = []
for line in DATA["lines"]:
    if line.get("writeP50") is not None:
        latency.append(
            (
                str(line["protocol"]),
                float(line["writeP50"]),
                float(line["writeP95"]),
            )
        )

expected_latency = [
    ("modbus-tcp", 62.717, 162.607),
    ("opcua", 18.711, 21.899),
    ("mqtt", 18.837, 19.140),
    ("http", 32.273, 32.972),
]
assert len(latency) == len(expected_latency)
for observed, expected in zip(latency, expected_latency):
    assert observed[0] == expected[0]
    assert close(observed[1], expected[1], 5e-4)
    assert close(observed[2], expected[2], 5e-4)

closed = DATA["closedloop"]
assert closed["writeMode"] == "governed"
assert int(closed["agg"]["n"]) == 3
assert close(closed["agg"]["Jstar"], 89.894, 5e-4)
verdict = SUMMARY_DATA["verdict"]
assert int(verdict["pass"]) == 75
assert int(verdict["warn"]) == 0
assert int(verdict["fail"]) == 0

trajectories = {}
for seed in closed["seeds"]:
    points = sorted(seed["traj"], key=lambda item: int(item["iter"]))
    trajectories[int(seed["seed"])] = (
        [int(point["iter"]) for point in points],
        [float(point["J"]) for point in points],
    )
assert set(trajectories) == {42, 43, 44}

MM = 1.0 / 25.4
mpl.rcParams.update(
    {
        "font.family": "serif",
        "font.serif": ["Times New Roman", "STIXGeneral", "DejaVu Serif"],
        "mathtext.fontset": "stix",
        "font.size": 6,
        "axes.labelsize": 7,
        "xtick.labelsize": 6,
        "ytick.labelsize": 6,
        "legend.fontsize": 6,
        "axes.linewidth": 0.6,
        "lines.linewidth": 1.05,
        "lines.markersize": 3.0,
        "xtick.direction": "in",
        "ytick.direction": "in",
        "xtick.top": True,
        "ytick.right": True,
        "xtick.major.size": 2.5,
        "ytick.major.size": 2.5,
        "xtick.minor.size": 1.4,
        "ytick.minor.size": 1.4,
        "xtick.minor.visible": True,
        "ytick.minor.visible": True,
        "pdf.fonttype": 42,
        "savefig.dpi": 300,
    }
)

fig = plt.figure(figsize=(88 * MM, 72 * MM))
gs = fig.add_gridspec(
    2,
    1,
    height_ratios=[0.92, 1.25],
    hspace=0.60,
    left=0.19,
    right=0.985,
    top=0.965,
    bottom=0.115,
)
axa = fig.add_subplot(gs[0])
axb = fig.add_subplot(gs[1])

colors = ["#2F6B8A", "#B35A2A"]
y = np.arange(len(latency))
p50 = [item[1] for item in latency]
p95 = [item[2] for item in latency]
axa.barh(y - 0.17, p50, height=0.32, color=colors[0], label="p50")
axa.barh(
    y + 0.17,
    p95,
    height=0.32,
    color=colors[1],
    hatch="///",
    edgecolor="white",
    label="p95",
)
axa.set_yticks(y)
axa.set_yticklabels([item[0] for item in latency])
axa.invert_yaxis()
axa.set_xlim(0, 205)
axa.set_xticks([0, 50, 100, 150, 200])
axa.set_xlabel("Write latency (ms)")
axa.grid(axis="x", color="0.88", linewidth=0.5)
axa.set_axisbelow(True)
axa.legend(loc="lower right", ncol=2, frameon=False, handlelength=1.4)
axa.text(0.005, 1.045, "(a)", transform=axa.transAxes, fontweight="bold",
         va="bottom", fontsize=6.5)
for i, (_, p50_value, p95_value) in enumerate(latency):
    axa.text(p50_value + 3.0, i - 0.17, f"{p50_value:g}", va="center", fontsize=5.6)
    axa.text(p95_value + 3.0, i + 0.17, f"{p95_value:g}", va="center", fontsize=5.6)

seed_style = {
    42: ("o", "-", "#1F6F78"),
    43: ("s", "--", "#3D6FB5"),
    44: ("^", "-.", "#6A4C93"),
}
for seed, (x_values, y_values) in sorted(trajectories.items()):
    marker, linestyle, color = seed_style[seed]
    axb.plot(
        x_values,
        y_values,
        color=color,
        linestyle=linestyle,
        marker=marker,
        markerfacecolor="white",
        markeredgecolor=color,
        markeredgewidth=0.8,
        label=f"seed {seed}",
    )
axb.axhline(
    float(closed["agg"]["Jstar"]),
    color="0.35",
    linewidth=0.85,
    linestyle=(0, (4, 3)),
    label=r"$J^*=89.894$",
)
axb.set_xlim(-0.15, 2.15)
axb.set_ylim(66, 92)
axb.set_xticks([0, 1, 2])
axb.set_yticks([70, 75, 80, 85, 90])
axb.set_xlabel("Closed-loop iteration")
axb.set_ylabel(r"Objective $J$")
axb.grid(axis="y", color="0.88", linewidth=0.5)
axb.set_axisbelow(True)
axb.legend(loc="lower right", ncol=2, frameon=False, handlelength=1.6,
           columnspacing=1.0)
axb.text(0.005, 1.045, "(b)", transform=axb.transAxes, fontweight="bold",
         va="bottom", fontsize=6.5)

fig.savefig(OUT / "fig9-latest-benchmark.pdf", format="pdf")
fig.savefig(OUT / "fig9-latest-benchmark.png", dpi=300)
print("wrote fig9-latest-benchmark.pdf/.png from", RUN)

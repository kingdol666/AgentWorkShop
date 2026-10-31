"""Render the parameter-write evidence chart for the October 30 review.

Values are transcribed from report.json and parameter-write-sequence.csv.
The plot deliberately separates setpoints from sparse PV observations.
"""
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


OUT = Path(__file__).parent

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 10,
    "axes.titlesize": 12,
    "axes.labelsize": 10,
    "xtick.labelsize": 9,
    "ytick.labelsize": 9,
    "axes.edgecolor": "#687985",
    "axes.linewidth": 0.8,
    "figure.facecolor": "white",
    "axes.facecolor": "white",
    "savefig.facecolor": "white",
})

teal = "#147d92"
orange = "#d9822b"
ink = "#263746"
muted = "#5c6f7b"
grid = "#e3eaee"

fig, (ax_sp, ax_pv) = plt.subplots(
    2, 1, figsize=(10.4, 6.8), sharex=True,
    gridspec_kw={"height_ratios": [0.82, 1.18]},
)
fig.subplots_adjust(left=0.10, right=0.97, top=0.89, bottom=0.21, hspace=0.42)
fig.suptitle(
    "Parameter writes and process observations in the latest channel test",
    color=ink, fontsize=15, fontweight="bold", y=0.965,
)

stages = ["Baseline", "Approval\npending", "After approval", "After explore\nwrite"]
x = [0, 1, 2, 3]

# Device readbacks: 195 remains unchanged while pending, then reaches 198 and 200.5.
sp = [195.0, 195.0, 198.0, 200.5]
ax_sp.step(x, sp, where="mid", color=teal, linewidth=2.4, zorder=2)
ax_sp.scatter([0, 2, 3], [195.0, 198.0, 200.5], s=52, color=teal,
              edgecolor="white", linewidth=0.8, zorder=3, label="Read-back SP")
ax_sp.scatter([1], [195.0], s=78, facecolor="white", edgecolor=orange,
              linewidth=2.0, zorder=4, label="Pending: no write")
for xi, yi, label in zip([0, 1, 2, 3], sp, ["195", "195", "198", "200.5"]):
    ax_sp.annotate(label, (xi, yi), xytext=(0, 9), textcoords="offset points",
                   ha="center", color=ink, fontsize=9, fontweight="bold")
ax_sp.annotate("approval was issued by the test script",
               xy=(1, 195), xytext=(1.05, 201.4),
               arrowprops={"arrowstyle": "->", "color": orange, "lw": 1.2},
               color="#8a5a1a", fontsize=8.5, ha="left")
ax_sp.set_title("A. Modbus-TCP setpoint (SP) read-back", loc="left", color=ink, pad=8)
ax_sp.set_ylabel("SP (°C)")
ax_sp.set_ylim(192.5, 203)
ax_sp.set_yticks([193, 195, 197, 199, 201, 203])
ax_sp.grid(axis="y", color=grid, linewidth=0.8)
ax_sp.legend(frameon=False, loc="lower right", ncol=2, fontsize=8.5)

# Discrete PV points only. The short dashed segment is the one reported R3 10-s pair.
ax_pv.scatter([-0.07], [209.36], s=52, color=orange, edgecolor="white", linewidth=0.8,
              zorder=3, label="Initial DAQ sample")
ax_pv.scatter([0.07], [207.67], s=52, marker="D", color="#6f8f4e",
              edgecolor="white", linewidth=0.8, zorder=3, label="LLM query latest")
ax_pv.annotate("R2 window mean 209.279; simulator truth 205.83",
               xy=(0.04, 207.67), xytext=(0.42, 211.2),
               arrowprops={"arrowstyle": "->", "color": muted, "lw": 0.9},
               color=muted, fontsize=8.2)

r3_x = [1.90, 2.10]
r3_y = [203.822, 203.212]
ax_pv.plot(r3_x, r3_y, linestyle=(0, (3, 2)), color=orange, linewidth=1.5,
           marker="o", markersize=6, markerfacecolor=orange,
           markeredgecolor="white", label="R3 reported 10-s pair")
ax_pv.annotate("203.822 → 203.212\nΔ = −0.610 °C / 10 s",
               xy=(2.10, 203.212), xytext=(1.42, 205.7),
               arrowprops={"arrowstyle": "->", "color": orange, "lw": 1.0},
               color="#8a5a1a", fontsize=8.3, ha="center")

ax_pv.scatter([3], [200.84], s=56, marker="s", color=teal,
              edgecolor="white", linewidth=0.8, zorder=3, label="R4 final PV sample")
ax_pv.annotate("200.84", (3, 200.84), xytext=(0, 9), textcoords="offset points",
               ha="center", color=ink, fontsize=9, fontweight="bold")
ax_pv.annotate("R4 tool summary: ΔPV = −0.095 °C / 10 s\nrecord remained open / unjudged",
               xy=(3, 200.84), xytext=(2.28, 198.6),
               arrowprops={"arrowstyle": "->", "color": teal, "lw": 1.0},
               color=teal, fontsize=8.2, ha="center")
ax_pv.set_title("B. Available process-value (PV) observations", loc="left", color=ink, pad=8)
ax_pv.set_ylabel("PV (°C)")
ax_pv.set_ylim(197.5, 212.5)
ax_pv.set_yticks([198, 202, 206, 210, 212])
ax_pv.set_xticks(x, stages)
ax_pv.grid(axis="y", color=grid, linewidth=0.8)
ax_pv.legend(frameon=False, loc="upper right", ncol=2, fontsize=8)
ax_pv.set_xlim(-0.45, 3.45)

fig.text(
    0.10, 0.065,
    "Sparse simulator observations are shown without an inferred continuous trajectory. "
    "The reported windows do not establish causal improvement or stable convergence.",
    color=muted, fontsize=8.5, ha="left",
)
fig.savefig(OUT / "parameter-write-sequence.png", dpi=240, bbox_inches="tight")
fig.savefig(OUT / "parameter-write-sequence.pdf", bbox_inches="tight")

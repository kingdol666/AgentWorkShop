"""Build optimization figures and a flat trajectory extract from the saved bench run."""
from pathlib import Path
import csv
import json

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D


HERE = Path(__file__).parent
ROOT = HERE.parents[3]
RUN_PATH = ROOT / "bench/results/20261029180436-1lo0/run.json"
REPORT_PATH = ROOT / "bench/results/20261029180436-1lo0/report.md"
RUN = json.loads(RUN_PATH.read_text(encoding="utf-8"))
REPORT = REPORT_PATH.read_text(encoding="utf-8")

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 9.5,
    "axes.titlesize": 11,
    "axes.labelsize": 9.5,
    "xtick.labelsize": 8.5,
    "ytick.labelsize": 8.5,
    "axes.edgecolor": "#687985",
    "axes.linewidth": 0.8,
    "figure.facecolor": "white",
    "axes.facecolor": "white",
    "savefig.facecolor": "white",
})

COLORS = {42: "#147d92", 43: "#c46b32", 44: "#718c48"}
TEAL = COLORS[42]
INK = "#263746"
MUTED = "#5c6f7b"
GRID = "#e3eaee"

cl_traj = RUN["agentteam"]["cl"]["seeds"]
cl_summary = {s["seed"]: s for s in RUN["closedloop"]["seeds"]}
flat_rows = []
for seed in cl_traj:
    seed_id = seed["seed"]
    summary = cl_summary[seed_id]
    trajectory = seed["traj"]
    for point in trajectory:
        final = point["iter"] == trajectory[-1]["iter"]
        flat_rows.append({
            "suite": "P6_closedloop",
            "seed": seed_id,
            "iteration": point["iter"],
            "control": "screw_speed",
            "control_value_from": "",
            "control_value_to": point["screw"],
            "screw_rpm": point["screw"],
            "thickness_um": point["thickness"],
            "objective_J_trajectory": point["J"],
            "objective_J_reported_end": summary["Jend"] if final else "",
            "reported_J_over_Jstar": summary["ratio"] if final else "",
            "governed_writes": summary["writes"] if final else "",
            "Jstar": summary["Jstar"] if final else "",
        })

biax_traj = RUN["agentteam"]["biax"]["traj"]
for point in biax_traj:
    flat_rows.append({
        "suite": "P10_biax_mission",
        "seed": "",
        "iteration": point["iter"],
        "control": point["knob"] or "baseline",
        "control_value_from": point["from"] if point["from"] is not None else "",
        "control_value_to": point["to"] if point["to"] is not None else "",
        "screw_rpm": "",
        "thickness_um": point["thickness"],
        "objective_J_trajectory": "",
        "objective_J_reported_end": "",
        "reported_J_over_Jstar": "",
        "governed_writes": 3 if point["iter"] == 3 else "",
        "Jstar": "",
    })

fields = list(flat_rows[0])
with (HERE / "optimization-trajectories.csv").open("w", newline="", encoding="utf-8-sig") as f:
    writer = csv.DictWriter(f, fieldnames=fields)
    writer.writeheader()
    writer.writerows(flat_rows)

# P6: show measured iteration trajectories and the separately reported Jend values.
fig, axes = plt.subplots(3, 1, figsize=(10.8, 8.1), sharex=True)
fig.subplots_adjust(left=0.10, right=0.97, top=0.88, bottom=0.17, hspace=0.40)
fig.suptitle("P6 · Deterministic closed-loop tuning across three simulator seeds",
             color=INK, fontsize=14, fontweight="bold", y=0.97)

for seed in cl_traj:
    sid = seed["seed"]
    points = seed["traj"]
    color = COLORS[sid]
    its = [p["iter"] for p in points]
    js = [p["J"] for p in points]
    screws = [p["screw"] for p in points]
    thickness = [p["thickness"] for p in points]
    axes[0].plot(its, js, color=color, marker="o", markersize=5, linewidth=1.8,
                 label=f"Seed {sid}: recorded trajectory")
    axes[1].step(its, screws, where="mid", color=color, marker="o", markersize=4,
                 linewidth=1.7, label=f"Seed {sid}")
    axes[2].plot(its, thickness, color=color, marker="o", markersize=5, linewidth=1.8,
                 label=f"Seed {sid}")
    summary = cl_summary[sid]
    end_i = its[-1]
    report_end = summary["Jend"]
    axes[0].scatter([end_i], [report_end], marker="D", s=58, facecolor="white",
                    edgecolor=color, linewidth=1.8, zorder=5)
    delta = report_end - js[-1]
    if abs(delta) > 0.03:
        axes[0].plot([end_i, end_i], [js[-1], report_end], color=color,
                     linestyle=(0, (2, 2)), linewidth=1.1)
        text_y = 91.0 if sid == 42 else 86.4
        axes[0].annotate(f"Seed {sid}: summary − trace = {delta:+.3f}",
                         xy=(end_i, (js[-1] + report_end) / 2),
                         xytext=(2.05, text_y),
                         arrowprops={"arrowstyle": "->", "color": color, "lw": 0.9},
                         ha="left", va="center", color=color, fontsize=7.2,
                         bbox={"boxstyle": "round,pad=0.22", "facecolor": "white",
                               "edgecolor": color, "linewidth": 0.7, "alpha": 0.96})
    axes[2].annotate(f"{thickness[-1]:.2f}", (its[-1], thickness[-1]),
                     xytext=(5, 3), textcoords="offset points", color=color,
                     fontsize=8, fontweight="bold")

axes[0].axhline(89.894, color="#657581", linestyle="--", linewidth=1.0,
                label="Offline optimum J* = 89.894")
axes[0].set_ylabel("Objective J")
axes[0].set_title("A. Objective score by evaluation (circles = trajectory; open diamonds = reported Jend)",
                  loc="left", color=INK, pad=7)
axes[0].set_ylim(63, 92)
legend_handles, legend_labels = axes[0].get_legend_handles_labels()
legend_handles.append(Line2D([], [], color="#53636e", marker="D", markersize=5,
                             markerfacecolor="white", linestyle="None",
                             label="Reported Jend (open diamond)"))
axes[0].legend(handles=legend_handles, frameon=False, ncol=2, fontsize=7.6,
               loc="lower right")

axes[1].set_ylabel("Screw speed (rpm)")
axes[1].set_title("B. Tuned parameter: screw speed; line speed = 95 m/min and zone setpoint = 200°C",
                  loc="left", color=INK, pad=7)
axes[1].set_ylim(122, 157)
axes[1].set_yticks([125, 135, 145, 155])

axes[2].axhspan(48, 52, color="#e8f2e8", zorder=0, label="Convergence band 50 ± 2 μm")
axes[2].axhline(49.18, color="#718c48", linestyle="--", linewidth=1.2,
                label="Offline W* thickness = 49.18 μm")
axes[2].set_ylabel("Film thickness (μm)")
axes[2].set_title("C. Process response (simulator) with the registered thickness criterion",
                  loc="left", color=INK, pad=7)
axes[2].set_ylim(44.5, 59)
axes[2].set_yticks([46, 48, 50, 52, 55, 58])
axes[2].legend(frameon=False, ncol=2, fontsize=7.8, loc="upper right")
axes[2].set_xlabel("Iteration / evaluation index")
axes[2].set_xticks([0, 1, 2, 3])

for ax in axes:
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_xlim(-0.15, 3.45)

fig.text(0.10, 0.045,
         "Reported aggregate: mean J/J* = 97.5% (n=3 seeds), 4 governed writes; Seed 44 met the registered criterion at baseline and used 0 writes. "
         "Seed 42/43 summary Jend differs from the last trajectory J; retain this discrepancy pending reconciliation.",
         color=MUTED, fontsize=7.7, ha="left", wrap=True)
fig.savefig(HERE / "closed-loop-tuning-dashboard.png", dpi=240, bbox_inches="tight")
fig.savefig(HERE / "closed-loop-tuning-dashboard.pdf", bbox_inches="tight")

# P10: multi-knob simulated mission and thickness attainment.
fig, ax = plt.subplots(figsize=(11.2, 5.8))
fig.subplots_adjust(left=0.09, right=0.97, top=0.86, bottom=0.31)
fig.suptitle("P10 · Biax multi-node tuning mission (simulator)",
             color=INK, fontsize=14, fontweight="bold", y=0.97)
its = [p["iter"] for p in biax_traj]
thick = [p["thickness"] for p in biax_traj]
ax.axhspan(24.3, 25.7, color="#e8f2e8", zorder=0, label="Target band 25 ± 0.7 μm")
ax.axhline(25, color="#718c48", linestyle="--", linewidth=1.2, label="Target 25 μm")
ax.plot(its, thick, color=TEAL, marker="o", markersize=7, linewidth=2.0,
        linestyle=(0, (4, 2)), zorder=3)
for xval, yval in zip(its, thick):
    ax.annotate(f"{yval:.2f}", (xval, yval), xytext=(0, 8), textcoords="offset points",
                ha="center", color=INK, fontsize=9, fontweight="bold")
ax.set_xlim(-0.22, 3.22)
ax.set_ylim(23.5, 30.5)
ax.set_xticks(its, ["Baseline", "Write 1", "Write 2", "Write 3"])
ax.set_ylabel("Film thickness (μm)")
ax.set_title("Measured iteration outcome; the third write enters the registered target band",
             loc="left", color=INK, pad=9)
ax.grid(axis="y", color=GRID, linewidth=0.8)
ax.legend(frameon=False, loc="upper right", fontsize=8.5)

cards = [
    (0.12, "Start", "h = 28.05 μm"),
    (0.34, "cast-spd-sp", "32 → 33.7"),
    (0.56, "fast-roll-sp", "118 → 122.4"),
    (0.78, "rail-out-sp", "3000 → 3096 · target met"),
]
for x0, title, detail in cards:
    color = "#e8f2e8" if title == "rail-out-sp" else "#f3f7f8"
    fig.text(x0, 0.185, title, ha="center", va="center", color=TEAL,
             fontsize=8.2, fontweight="bold",
             bbox={"boxstyle": "round,pad=0.45", "facecolor": color,
                   "edgecolor": "#cbdce1"})
    fig.text(x0, 0.115, detail, ha="center", va="center", color=INK, fontsize=8)

fig.text(0.09, 0.035,
         "Writes: 3 on 3 distinct knobs; final thickness 24.80 μm (target 24.3–25.7). Dashed line only orders discrete iterations; it is not continuous sampling or causal isolation. "
         "This is a deterministic simulator mission, not physical equipment evidence. "
         "The saved summary says 0 optimization records, while the mission journal reports 1 open record for the first write; do not infer a complete per-write record chain.",
         color=MUTED, fontsize=7.4, ha="left", wrap=True)
fig.savefig(HERE / "biax-mission-tuning.png", dpi=240, bbox_inches="tight")
fig.savefig(HERE / "biax-mission-tuning.pdf", bbox_inches="tight")

print(f"Rendered figures from {RUN_PATH}")

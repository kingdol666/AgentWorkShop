#!/usr/bin/env python3
"""Rebuild Fig. 5 from the archived three-seed cast-film controller trace."""
from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D


HERE = Path(__file__).resolve().parent
PAPER = HERE.parent
ROOT = PAPER.parents[2]
SOURCE = ROOT / "bench/results/20260921184204-10lc/run.json"
RESOURCES = PAPER / "resources"
DATA = RESOURCES / "figure-source-data"
FIGURE = RESOURCES / "fig-parameter-objective"

COLORS = {42: "#1E5B7A", 43: "#C66A2B", 44: "#2D7E72"}
MARKERS = {42: "o", 43: "s", 44: "^"}
STYLES = {42: "-", 43: "--", 44: "-."}

plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Arial", "Liberation Sans", "DejaVu Sans"],
    "font.size": 9,
    "axes.labelsize": 9,
    "axes.titlesize": 9.5,
    "xtick.labelsize": 9,
    "ytick.labelsize": 9,
    "legend.fontsize": 9,
    "axes.linewidth": 0.65,
    "lines.linewidth": 1.15,
    "xtick.major.width": 0.65,
    "ytick.major.width": 0.65,
    "xtick.major.size": 2.8,
    "ytick.major.size": 2.8,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    "svg.fonttype": "none",
    "legend.frameon": False,
    "savefig.facecolor": "white",
})


def read_archive() -> tuple[dict, list[dict]]:
    raw = json.loads(SOURCE.read_text(encoding="utf-8-sig"))
    closed = raw["closedloop"]
    rows = []
    for seed_data in closed["seeds"]:
        seed = int(seed_data["seed"])
        for point in seed_data["traj"]:
            j = float(point["J"])
            jstar = float(seed_data["Jstar"])
            rows.append({
                "seed": seed,
                "iteration": int(point["iter"]),
                "screw_speed_rpm": float(point["screw"]),
                "line_speed_m_min": float(point["lineSpeed"]),
                "J": j,
                "J_star_finite_grid": jstar,
                "J_over_J_star": j / jstar,
                "thickness_um": float(point["thickness"]),
                "defect_percent": float(point["defect"]),
                "melt_temp_C": float(point["meltTemp"]),
                "pressure_MPa": float(point["pressure"]),
                "source_anchor": f"closedloop.seeds[seed={seed}].traj[iter={point['iter']}]",
            })
    metadata = {
        "source": SOURCE.relative_to(ROOT).as_posix(),
        "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "source_scope": "one historical deterministic cast-film controller benchmark; three seeded simulator initializations",
        "iterations_per_seed": [0, 1, 2],
        "controlled_parameter": "screw-speed setpoint; line speed remained at 95 m/min",
        "objective": "dimensionless simulator score J; higher is better",
        "normalization": "J/J_star, where J_star=89.894 is the best eligible score on the archived finite setpoint grid",
        "not_included": "no other scenario has a shared scalar J trajectory in this archive; these traces are not current model-mediated route trials",
        "n_seeds": len(closed["seeds"]),
        "rows": rows,
    }
    return metadata, rows


def export_data(metadata: dict, rows: list[dict]) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    with (DATA / "source-data-parameter-objective.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    (DATA / "source-data-parameter-objective.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def plot(rows: list[dict]) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(7.16, 2.76), constrained_layout=False)
    fig.subplots_adjust(left=0.095, right=0.985, bottom=0.23, top=0.76, wspace=0.30)
    titles = ["(a) Screw-speed setpoint", "(b) Normalized objective"]
    for ax, title in zip(axes, titles):
        ax.set_title(title, loc="left", pad=6, fontweight="semibold")
        ax.set_axisbelow(True)
        ax.grid(axis="y", color="#D7DEE2", linewidth=0.45)
        ax.tick_params(direction="out", pad=2.0)
        ax.set_xticks([0, 1, 2])
        ax.set_xlabel("Controller iteration")

    axes[0].set_ylabel("Screw-speed setpoint (rpm)")
    axes[0].set_ylim(130, 155)
    axes[0].set_yticks([130, 135, 140, 145, 150, 155])
    axes[1].set_ylabel("Objective ratio, J/J*")
    axes[1].set_ylim(0.70, 1.02)
    axes[1].set_yticks([0.70, 0.80, 0.90, 1.00])
    axes[1].axhline(1.0, color="#444444", linewidth=0.8, linestyle=(0, (3, 2)), zorder=1)

    for seed in sorted({int(row["seed"]) for row in rows}):
        trace = sorted((row for row in rows if int(row["seed"]) == seed), key=lambda r: r["iteration"])
        x = [int(row["iteration"]) for row in trace]
        axes[0].plot(x, [row["screw_speed_rpm"] for row in trace], color=COLORS[seed],
                     linestyle=STYLES[seed], marker=MARKERS[seed], markersize=4.2,
                     markerfacecolor="white", markeredgewidth=1.0, zorder=3)
        axes[1].plot(x, [row["J_over_J_star"] for row in trace], color=COLORS[seed],
                     linestyle=STYLES[seed], marker=MARKERS[seed], markersize=4.2,
                     markerfacecolor="white", markeredgewidth=1.0, zorder=3)

    handles = [
        Line2D([], [], color=COLORS[s], linestyle=STYLES[s], marker=MARKERS[s],
               markersize=4.2, markerfacecolor="white", markeredgewidth=1.0,
               label=f"Seed {s}") for s in sorted(COLORS)
    ]
    handles.append(Line2D([], [], color="#444444", linestyle=(0, (3, 2)),
                          linewidth=0.8, label="Finite-grid reference (J/J* = 1)"))
    fig.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.54, 0.985),
               ncol=4, handlelength=1.6, handletextpad=0.45,
               columnspacing=1.0, borderaxespad=0.0)
    fig.text(0.095, 0.035, "Line speed fixed at 95 m/min", fontsize=9, color="#444444")

    for extension in ("pdf", "svg"):
        fig.savefig(FIGURE.with_suffix(f".{extension}"))
    fig.savefig(FIGURE.with_suffix(".png"), dpi=600)
    plt.close(fig)


def main() -> None:
    metadata, rows = read_archive()
    export_data(metadata, rows)
    plot(rows)
    print(f"Wrote {FIGURE.with_suffix('.pdf')} from {metadata['source']}")
    print(f"Source SHA-256: {metadata['source_sha256']}; {len(rows)} trajectory points")


if __name__ == "__main__":
    main()

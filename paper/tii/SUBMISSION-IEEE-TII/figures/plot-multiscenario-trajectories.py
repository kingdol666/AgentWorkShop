#!/usr/bin/env python3
"""Render the archived four-scenario process traces against their own targets.

The plotted quantity is each scenario's raw process variable. The shaded band
is its archived target window; this is not a shared optimizer-score plot.
"""
from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch


HERE = Path(__file__).resolve().parent
PAPER = HERE.parent
ROOT = HERE.parents[3]
RESOURCE = PAPER / "resources"
SOURCE_META = RESOURCE / "figure-source-data" / "multiscene-optimization.json"
SOURCE_CONTROLS = RESOURCE / "figure-source-data" / "source-data-missions-controls.csv"
OUT = RESOURCE / "fig-multiscenario-optimization"

SCENES = ["injection", "wwtp", "anneal", "biax"]
DISPLAY = {
    "injection": ("Injection molding", "Part weight (g)", (30.8, 33.1)),
    "wwtp": ("Wastewater (DO)", "Dissolved oxygen (mg/L)", (0.0, 4.35)),
    "anneal": ("Continuous annealing", "Hardness (HV)", (84.0, 141.0)),
    "biax": ("BOPET film", "Thickness (µm)", (23.8, 29.2)),
}

BLUE = "#245D7A"
ORANGE = "#C66A2B"
DARK = "#222222"
GRID = "#D5DDE1"
TARGET_FILL = "#E4EFEA"
TARGET_EDGE = "#4F8B70"

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
    "lines.linewidth": 1.1,
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


def load_data() -> tuple[dict, dict[str, int], dict[str, dict]]:
    meta = json.loads(SOURCE_META.read_text(encoding="utf-8"))
    source_path = ROOT / meta["source"]
    digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
    if digest != meta["source_sha256"]:
        raise ValueError("Archived scenario source hash does not match figure metadata")
    raw = json.loads(source_path.read_text(encoding="utf-8-sig"))
    raw_by_id = {item["id"]: item for item in raw["results"]}

    last_event: dict[str, int] = {scene: 0 for scene in SCENES}
    with SOURCE_CONTROLS.open(newline="", encoding="utf-8-sig") as stream:
        for row in csv.DictReader(stream):
            scene = row["mission"]
            if scene in last_event:
                last_event[scene] = max(last_event[scene], int(row["event"]))
    return meta, last_event, raw_by_id


def build_figure(meta: dict, last_event: dict[str, int],
                 raw_by_id: dict[str, dict]) -> None:
    fig, axes = plt.subplots(2, 2, figsize=(7.16, 3.55), sharex=False)
    fig.subplots_adjust(left=0.12, right=0.99, bottom=0.13, top=0.82,
                        wspace=0.31, hspace=0.48)

    traces = meta["traces"]
    terminal_values = {
        scene: (float(raw_by_id[scene]["mission"]["final"]), last_event[scene])
        for scene in SCENES
    }
    panel_tags = ["(a)", "(b)", "(c)", "(d)"]
    legend_handles = [
        Patch(facecolor=TARGET_FILL, edgecolor=TARGET_EDGE,
              label="Target window"),
        Line2D([], [], color=BLUE, marker="o", markersize=4,
               markerfacecolor="white", label="Process observation"),
        Line2D([], [], color=DARK, marker="s", markersize=4,
               linestyle="none", label="Terminal observation"),
    ]
    fig.legend(handles=legend_handles, loc="upper center",
               bbox_to_anchor=(0.5, 0.99), ncol=3, frameon=False,
               fontsize=9, handlelength=1.15, handletextpad=0.35,
               columnspacing=1.0, borderaxespad=0.)

    for idx, (ax, scene) in enumerate(zip(axes.flat, SCENES)):
        name, ylabel, ylim = DISPLAY[scene]
        points = traces[scene]
        target = float(points[0]["target"])
        tolerance = float(points[0]["tolerance"])

        ax.axhspan(target - tolerance, target + tolerance,
                   color=TARGET_FILL, zorder=0)
        ax.axhline(target - tolerance, color=TARGET_EDGE, linewidth=0.55,
                   alpha=0.8, zorder=1)
        ax.axhline(target + tolerance, color=TARGET_EDGE, linewidth=0.55,
                   alpha=0.8, zorder=1)
        ax.axhline(target, color=TARGET_EDGE, linewidth=0.85,
                   linestyle=(0, (3, 2)), zorder=1)
        ax.set_axisbelow(True)
        ax.grid(axis="y", color=GRID, linewidth=0.45, zorder=0)

        response_points = [p for p in points if p["status"] in
                           ("observed", "observation_after_unlinked_candidate")]
        response_points.sort(key=lambda p: int(p["step"]))
        x = [int(p["step"]) for p in response_points]
        y = [float(p["value"]) for p in response_points]
        ax.plot(x, y, color=BLUE, marker="o", markersize=4.2,
                markerfacecolor="white", markeredgecolor=BLUE,
                markeredgewidth=0.9, zorder=3)

        # Preserve provenance: the triangle is a structured PV response whose
        # candidate lacks an optimization record; the cross is event-text data.
        for p in points:
            step, value = int(p["step"]), float(p["value"])
            if p["status"] == "observation_after_unlinked_candidate":
                ax.plot(step, value, marker="^", markersize=5.0,
                        color=ORANGE, markerfacecolor="white",
                        markeredgewidth=1.0, linestyle="none", zorder=4)
            elif p["status"] == "reverted_candidate":
                ax.plot(step, value, marker="x", markersize=5.0,
                        color=ORANGE, markeredgewidth=1.1,
                        linestyle="none", zorder=4)

        terminal, terminal_x = terminal_values[scene]
        ax.plot(terminal_x, terminal, marker="s", markersize=4.8,
                color=DARK, markerfacecolor=DARK, linestyle="none", zorder=5)
        label_offset = {
            "injection": (0.08, 0.16, "left"),
            "wwtp": (-0.18, 0.20, "right"),
            "anneal": (0.12, 0.32, "left"),
            "biax": (-0.08, 0.18, "right"),
        }[scene]
        dx, dy, align = label_offset
        ax.annotate(f"{terminal:.2f}", xy=(terminal_x, terminal),
                    xytext=(terminal_x + dx, terminal + dy),
                    textcoords="data", fontsize=9, color=DARK,
                    ha=align, va="bottom",
                    bbox=dict(facecolor="white", edgecolor="none",
                              pad=0.4, alpha=0.88), zorder=6)

        if scene == "injection":
            ax.set_xlim(-0.35, 2.55)
            ax.set_xticks([0, 1, 2])
        elif scene == "wwtp":
            ax.set_xlim(-0.4, 16.0)
            ax.set_xticks([0, 5, 10, 15])
        elif scene == "anneal":
            ax.set_xlim(-0.4, 6.8)
            ax.set_xticks([0, 1, 2, 3, 4, 5, 6])
        else:
            ax.set_xlim(-0.35, 3.7)
            ax.set_xticks([0, 1, 2, 3])

        ax.set_ylim(*ylim)
        ax.set_ylabel(ylabel, labelpad=2.0)
        ax.set_title(f"{panel_tags[idx]} {name}", loc="left", pad=4,
                     fontweight="semibold")
        ax.tick_params(direction="out", pad=2.0)
        for label in ax.get_xticklabels() + ax.get_yticklabels():
            label.set_fontsize(9)

    fig.supxlabel("Recorded event index (0 = baseline)", y=0.015,
                  fontsize=9)
    for ext in ("pdf", "svg"):
        fig.savefig(OUT.with_suffix("." + ext))
    fig.savefig(OUT.with_suffix(".png"), dpi=600)
    plt.close(fig)


def main() -> None:
    meta, last_event, raw_by_id = load_data()
    build_figure(meta, last_event, raw_by_id)
    print(json.dumps({
        "figure": str(OUT.with_suffix(".pdf")),
        "source": meta["source"],
        "source_sha256": meta["source_sha256"],
        "scenes": SCENES,
        "terminal_event_indices": last_event,
        "metric": meta["metric"],
        "metric_scope": meta["metric_scope"],
    }, indent=2))


if __name__ == "__main__":
    main()

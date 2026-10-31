#!/usr/bin/env python3
"""Build the four-panel process figure from the audited 2026-09-28 mission logs."""
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
ROOT = PAPER.parents[2]
RESOURCE = PAPER / "resources"
DATA = RESOURCE / "figure-source-data" / "four-scenario-2026-09-28.json"
CSV_OUT = RESOURCE / "figure-source-data" / "four-scenario-2026-09-28.csv"
MANIFEST_OUT = RESOURCE / "figure-source-data" / "four-scenario-2026-09-28-manifest.json"
FIG_BASE = RESOURCE / "fig-missions-controls"

COLORS = {
    "injection": "#245D7A",
    "biax": "#B65F2A",
    "anneal": "#2F7868",
    "wwtp": "#74558A",
}
TARGET = "#DCEBE4"
TARGET_EDGE = "#4D806B"
DARK = "#242A2D"
GRID = "#D9DEE0"
STAGE_LABELS = {
    "injection": ["Start", "Pressure", "Time", "Pressure"],
    "biax": ["Start", "Casting", "Fast roll", "Rail", "Casting"],
    "anneal": ["Start", "Zone 2", "Speed", "Revert"],
    "wwtp": ["Start", "Air 1", "Air 2", "Air 3", "Air 4", "Air 5"],
}

plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Arial", "Liberation Sans", "DejaVu Sans"],
    "font.size": 9.0,
    "axes.labelsize": 9.0,
    "axes.titlesize": 10.0,
    "xtick.labelsize": 9.0,
    "ytick.labelsize": 9.0,
    "legend.fontsize": 9.0,
    "axes.linewidth": 0.6,
    "lines.linewidth": 1.15,
    "xtick.major.width": 0.6,
    "ytick.major.width": 0.6,
    "xtick.major.size": 2.5,
    "ytick.major.size": 2.5,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    "svg.fonttype": "none",
    "legend.frameon": False,
    "savefig.facecolor": "white",
})


def load() -> dict:
    data = json.loads(DATA.read_text(encoding="utf-8"))
    receipts = []
    for rel in data["source_paths"]:
        path = ROOT / rel
        receipts.append({
            "path": rel,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        })
    data["source_receipts"] = receipts
    return data


def write_source_csv(data: dict) -> None:
    fields = [
        "scenario", "display", "point_order", "point_type", "operation",
        "value", "unit", "target_center", "target_lower", "target_upper",
        "recorded", "source_path",
    ]
    with CSV_OUT.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for scene in data["scenarios"]:
            source = next(
                p for p in data["source_paths"]
                if f"mission-{scene['id']}.log" in p
            )
            for point in scene["points"]:
                writer.writerow({
                    "scenario": scene["id"],
                    "display": scene["display"],
                    "point_order": point["order"],
                    "point_type": "structured_trajectory",
                    "operation": point["operation"],
                    "value": point["value"],
                    "unit": scene["unit"],
                    "target_center": scene["target"]["center"],
                    "target_lower": scene["target"]["lower"],
                    "target_upper": scene["target"]["upper"],
                    "recorded": point["recorded"],
                    "source_path": source,
                })
            end = scene["reported_endpoint"]
            if end["separate"]:
                writer.writerow({
                    "scenario": scene["id"],
                    "display": scene["display"],
                    "point_order": end["order"],
                    "point_type": "separate_mission_endpoint",
                    "operation": "mission-reported endpoint; not connected to trajectory",
                    "value": end["value"],
                    "unit": scene["unit"],
                    "target_center": scene["target"]["center"],
                    "target_lower": scene["target"]["lower"],
                    "target_upper": scene["target"]["upper"],
                    "recorded": False,
                    "source_path": source,
                })


def plot_scene(ax, scene: dict, panel: str) -> None:
    color = COLORS[scene["id"]]
    target = scene["target"]
    points = scene["points"]
    xs = [int(point["order"]) for point in points]
    ys = [float(point["value"]) for point in points]
    accepted = [point for point in points if point.get("recorded", True)]
    lo, hi = float(target["lower"]), float(target["upper"])
    ax.axhspan(lo, hi, facecolor=TARGET, edgecolor="none", zorder=0)
    ax.axhline(lo, color=TARGET_EDGE, linewidth=0.55, linestyle=":")
    ax.axhline(hi, color=TARGET_EDGE, linewidth=0.55, linestyle=":")
    ax.axhline(float(target["center"]), color=TARGET_EDGE,
               linewidth=0.65, linestyle="--")
    ax.plot([int(point["order"]) for point in accepted],
            [float(point["value"]) for point in accepted],
            color=color, marker="o", markersize=3.7,
            markeredgewidth=0.7, markeredgecolor="white", zorder=3)

    for point, x, y in zip(points, xs, ys):
        if not point["recorded"] and point["operation"] != "baseline":
            ax.plot(x, y, marker="^", markersize=5.0, linestyle="none",
                    markerfacecolor="white", markeredgecolor=color,
                    markeredgewidth=1.0, zorder=4)

    endpoint = scene["reported_endpoint"]
    if endpoint["separate"]:
        x = float(endpoint["order"])
        y = float(endpoint["value"])
        ax.plot(x, y, marker="s", markersize=4.3, linestyle="none",
                markerfacecolor="white", markeredgecolor=DARK,
                markeredgewidth=0.9, zorder=5)

    tick_x = list(xs)
    tick_labels = list(STAGE_LABELS[scene["id"]])
    if endpoint["separate"]:
        tick_x.append(int(endpoint["order"]))
        tick_labels.append("End")
    ax.set_xticks(tick_x)
    ax.set_xticklabels(tick_labels, ha="center")
    ax.set_ylabel(f"{scene['variable']} ({scene['unit']})", labelpad=3)
    ax.set_title(f"({panel}) {scene['display']}", loc="left", pad=4,
                 fontweight="semibold", fontsize=10.0)
    ax.set_xlim(-0.25, max(tick_x) + 0.35)
    ax.grid(axis="y", color=GRID, linewidth=0.45, zorder=0)
    ax.tick_params(direction="out", pad=2)


def main() -> None:
    data = load()
    write_source_csv(data)

    fig, axes = plt.subplots(2, 2, figsize=(7.16, 3.58), sharex=False)
    fig.subplots_adjust(left=0.092, right=0.99, top=0.94, bottom=0.23,
                        wspace=0.30, hspace=0.67)
    for ax, scene, panel in zip(
        axes.flat, data["scenarios"], ["a", "b", "c", "d"]
    ):
        plot_scene(ax, scene, panel)

    handles = [
        Patch(facecolor=TARGET, edgecolor=TARGET_EDGE, label="Target band"),
        Line2D([], [], color=COLORS["injection"], marker="o", markersize=3.8,
               linewidth=1.1, label="Structured observations"),
        Line2D([], [], color=COLORS["anneal"], marker="^", markersize=4.5,
               markerfacecolor="white", linewidth=0,
               label="Reverted candidate"),
        Line2D([], [], color=DARK, marker="s", markersize=4.0, linewidth=0,
               markerfacecolor="white", label="Reported endpoint"),
    ]
    fig.legend(handles=handles, loc="lower center", ncol=4,
               bbox_to_anchor=(0.5, 0.012), handlelength=1.15,
               columnspacing=0.8)

    for ext in ("pdf", "svg"):
        fig.savefig(FIG_BASE.with_suffix(f".{ext}"), facecolor="white")
    fig.savefig(FIG_BASE.with_suffix(".png"), dpi=600, facecolor="white")
    plt.close(fig)
    MANIFEST_OUT.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {FIG_BASE.with_suffix('.pdf')}")
    print(f"Wrote {CSV_OUT}")
    print(f"Wrote {MANIFEST_OUT}")


if __name__ == "__main__":
    main()

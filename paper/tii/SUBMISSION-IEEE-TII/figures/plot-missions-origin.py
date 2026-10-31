#!/usr/bin/env python3
"""Plot four documented simulator missions as ordered observations.

Data are not interpolated in time. A solid segment joins adjacent structured
observations solely as an ordering guide. The reverted candidate is sourced
from event text, and separately reported endpoints are intentionally unlinked.
Each scenario is a single deterministic simulator trajectory.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from matplotlib.ticker import MaxNLocator

HERE = Path(__file__).resolve().parent
RESOURCE = HERE.parent / "resources"
DATA = RESOURCE / "figure-source-data" / "four-scenario-2026-09-28.json"
OUT = RESOURCE / "fig-missions-origin"

# Final figure is 7.16 x 3.9 in at the IEEE two-column text width.  Colours
# and shapes carry distinct evidence types, never distinct treatment groups.
plt.rcParams.update({
    "font.family": "sans-serif", "font.sans-serif": ["Arial", "DejaVu Sans"],
    "font.size": 8.5, "axes.labelsize": 8.5, "axes.titlesize": 9.5,
    "xtick.labelsize": 8.0, "ytick.labelsize": 8.0, "legend.fontsize": 8.0,
    "axes.linewidth": 0.7, "xtick.major.width": 0.7, "ytick.major.width": 0.7,
    "xtick.major.size": 3, "ytick.major.size": 3, "pdf.fonttype": 42,
    "ps.fonttype": 42, "svg.fonttype": "none", "legend.frameon": False,
    "savefig.facecolor": "white",
})

NAVY = "#174A72"
GREEN = "#DCEADF"
GREEN_EDGE = "#729886"
ORANGE = "#B75C27"
LABELS = {
    "injection": ["Start", "Pressure", "Time", "Pressure"],
    "biax": ["Start", "Casting", "Fast roll", "Rail", "Casting"],
    "anneal": ["Start", "Zone 2", "Speed", "Revert", "Final"],
    "wwtp": ["Start", "Air 1", "Air 2", "Air 3", "Air 4", "Air 5", "Final"],
}
LIMITS = {"injection": (31.0, 33.1), "biax": (23.7, 28.8),
          "anneal": (84, 141), "wwtp": (-0.2, 4.4)}
TITLES = {"injection": "Injection molding", "biax": "BOPET film",
          "anneal": "Continuous annealing", "wwtp": "A2O wastewater"}


def plot_scene(ax, scene, panel):
    target, points = scene["target"], scene["points"]
    ax.axhspan(target["lower"], target["upper"], color=GREEN, zorder=0)
    ax.axhline(target["lower"], color=GREEN_EDGE, lw=0.55, ls="--", zorder=1)
    ax.axhline(target["upper"], color=GREEN_EDGE, lw=0.55, ls="--", zorder=1)
    structured = [p for p in points if p["recorded"]]
    xs, ys = [p["order"] for p in structured], [p["value"] for p in structured]
    # Lines imply sequence only, not continuous time or interpolation.
    ax.plot(xs, ys, color=NAVY, marker="o", markersize=4.0, lw=1.0,
            markeredgecolor="white", markeredgewidth=0.45, zorder=4)
    for p in points:
        if not p["recorded"]:
            ax.plot(p["order"], p["value"], "^", ms=5.4, mfc="white",
                    mec=ORANGE, mew=1.0, linestyle="none", zorder=5)
    endpoint = scene["reported_endpoint"]
    if endpoint["separate"]:
        ax.plot(endpoint["order"], endpoint["value"], "s", ms=4.7,
                mfc="white", mec=NAVY, mew=1.0, linestyle="none", zorder=5)
    ax.set_xticks(range(len(LABELS[scene["id"]])), LABELS[scene["id"]])
    ax.set_xlim(-0.35, len(LABELS[scene["id"]]) - 0.65)
    ax.set_ylim(*LIMITS[scene["id"]])
    ax.yaxis.set_major_locator(MaxNLocator(nbins=4))
    ax.set_ylabel(f"{scene['variable']} ({scene['unit']})", labelpad=3)
    ax.set_title(f"({panel}) {TITLES[scene['id']]}", loc="left", fontweight="bold", pad=4)
    ax.tick_params(direction="in", top=True, right=True, pad=3)
    for spine in ax.spines.values():
        spine.set_visible(True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DATA, help="audited four-scenario JSON")
    parser.add_argument("--output", type=Path, default=OUT, help="output prefix without extension")
    parser.add_argument("--audit-dir", type=Path, default=Path(os.environ.get(
        "NATURE_FIGURE_AUDIT_DIR", str(Path.home() / ".codex" / "skills" / "nature-figure" / "scripts"))),
        help="directory containing audit_panel_alignment.py")
    args = parser.parse_args()
    sys.path.insert(0, str(args.audit_dir))
    try:
        from audit_panel_alignment import require_matplotlib_panel_alignment
    except ModuleNotFoundError as exc:
        if exc.name != "audit_panel_alignment":
            raise
        from figure_layout import require_matplotlib_panel_alignment
    data = json.loads(args.data.read_text(encoding="utf-8"))
    output = args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    scenes = data["scenarios"]
    assert [s["id"] for s in scenes] == ["injection", "biax", "anneal", "wwtp"]
    fig, axes = plt.subplots(2, 2, figsize=(7.16, 3.9))
    fig.subplots_adjust(left=0.087, right=0.985, top=0.94, bottom=0.19,
                        wspace=0.31, hspace=0.56)
    for ax, scene, panel in zip(axes.flat, scenes, "abcd"):
        plot_scene(ax, scene, panel)
    handles = [Patch(facecolor=GREEN, edgecolor=GREEN_EDGE, label="Target band"),
               Line2D([], [], color=NAVY, lw=1, marker="o", ms=4, label="Observed response"),
               Line2D([], [], color=ORANGE, marker="^", mfc="white", ls="none", ms=5,
                      label="Reverted candidate"),
               Line2D([], [], color=NAVY, marker="s", mfc="white", ls="none", ms=4.5,
                      label="Reported final")]
    fig.legend(handles=handles, loc="lower center", ncol=4,
               bbox_to_anchor=(0.5, 0.012), handlelength=1.2,
               handletextpad=0.5, columnspacing=1.0)
    fig.canvas.draw()
    require_matplotlib_panel_alignment(
        fig, json_out=str(output) + ".alignment.json",
        overlay_svg=str(output) + ".alignment.svg",
        tolerance_pt=1.5, gutter_tolerance_pt=1.5, strict=True)
    for ext in ("pdf", "svg"):
        fig.savefig(output.with_suffix("." + ext), facecolor="white")
    fig.savefig(output.with_suffix(".png"), dpi=600, facecolor="white")
    plt.close(fig)
    print(f"Wrote {output}.pdf, .svg, and .png")


if __name__ == "__main__":
    main()

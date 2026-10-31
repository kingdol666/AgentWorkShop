#!/usr/bin/env python3
"""Rebuild four target-deviation panels from the archived multi-scene mission.

The source stores scenario-specific PV trajectories and requested setpoints.
The figure shows the descriptive normalized absolute target deviation
|PV - target| / tolerance, not an optimizer score.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch

ROOT = Path(__file__).resolve().parents[4]
PAPER = Path(__file__).resolve().parents[1]
RESOURCE = PAPER / "resources"
SOURCE = ROOT / "bench/results/20260921184204-10lc/scenarios.json"
SOURCE_REL = SOURCE.relative_to(ROOT).as_posix()
OUT = RESOURCE / "fig-multiscene-optimization-2026"

PALETTE = ["#1E5B7A", "#C66A2B", "#2D7E72", "#74558A"]
DARK = "#262626"
TOLERANCE_FILL = "#E7F0EB"
TOLERANCE_LINE = "#4F8B70"
SCENES = ["injection", "wwtp", "anneal", "biax"]
plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Arial", "Liberation Sans", "DejaVu Sans"],
    "font.size": 9.2,
    "axes.labelsize": 9.2,
    "axes.titlesize": 10,
    "xtick.labelsize": 9,
    "ytick.labelsize": 9,
    "legend.fontsize": 9,
    "axes.linewidth": 0.65,
    "lines.linewidth": 1.0,
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


def parse_source():
    raw = json.loads(SOURCE.read_text(encoding="utf-8-sig"))
    by_id = {item["id"]: item for item in raw["results"]}
    traces: dict[str, list[dict]] = {}

    for scene in SCENES:
        mission = by_id[scene]["mission"]
        pv = by_id[scene]["pv"]
        trace = []
        for ordinal, point in enumerate(mission["traj"]):
            if scene == "wwtp" and point.get("phase") not in ("baseline", "blower"):
                continue
            status = "observed"
            if point.get("knob") and not point.get("record"):
                status = "observation_after_unlinked_candidate"
            trace.append({
                "step": ordinal,
                "value": float(point["pv"]),
                "target": float(pv["target"]),
                "tolerance": float(pv["tol"]),
                "deviation": abs(float(point["pv"]) - float(pv["target"])) / float(pv["tol"]),
                "phase": point.get("phase", ""),
                "status": status,
                "source_anchor": f"results[id={scene}].mission.traj[{ordinal}]",
            })

        if scene == "anneal":
            # The event narrative records a reverted candidate and its
            # separate terminal observation; retain both as discrete points.
            trace.extend([
                {"step": 5, "value": 101.3, "target": float(pv["target"]),
                 "tolerance": float(pv["tol"]),
                 "deviation": abs(101.3 - float(pv["target"])) / float(pv["tol"]),
                 "phase": "reverted 176 m/min candidate", "status": "reverted_candidate",
                 "source_anchor": "results[id=anneal].mission.ev[5]"},
                {"step": 6, "value": float(mission["final"]), "target": float(pv["target"]),
                 "tolerance": float(pv["tol"]),
                 "deviation": abs(float(mission["final"]) - float(pv["target"])) / float(pv["tol"]),
                 "phase": "separate terminal observation", "status": "terminal_observation",
                 "source_anchor": "results[id=anneal].mission.final"},
            ])
        elif scene == "wwtp":
            trace.append({
                "step": 6, "value": float(mission["final"]), "target": float(pv["target"]),
                "tolerance": float(pv["tol"]),
                "deviation": abs(float(mission["final"]) - float(pv["target"])) / float(pv["tol"]),
                "phase": "separate terminal observation after pH/TP stages",
                "status": "terminal_observation",
                "source_anchor": f"results[id=wwtp].mission.final",
            })

        traces[scene] = trace

    return {
        "description": "One scripted simulator mission per scene from the archived seed-42 integrated run.",
        "source": SOURCE_REL,
        "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "seed": raw["seed"],
        "n_per_scene": 1,
        "metric": "normalized absolute target deviation = |PV - target| / tolerance; <= 1 is within the declared target band",
        "metric_scope": "descriptive target-tracking metric computed from archived PV values; not an optimizer-internal J",
        "parameter_semantics": "requested setpoints; not independent device readbacks",
        "wastewater_scope": "DO/blower phase only; pH and total-phosphorus stages have distinct objectives and are excluded from the DO curve",
        "annealing_scope": "the first temperature point has no optimization record; the 176 m/min candidate and rollback are taken from the event narrative; terminal hardness is separate",
        "traces": traces,
    }


def plot(metadata):
    fig, axs = plt.subplots(2, 2, figsize=(7.16, 4.10), sharey=True)
    fig.subplots_adjust(left=.125, right=.99, bottom=.13, top=.80,
                        wspace=.24, hspace=.43)
    short_names = {"injection": "Injection molding", "wwtp": "Wastewater (DO)",
                   "anneal": "Continuous annealing", "biax": "BOPET film"}
    panel_tags = ["a", "b", "c", "d"]
    max_deviation = max(point["deviation"]
                        for trace in metadata["traces"].values() for point in trace)
    shared_ymax = max(7, math.ceil(max_deviation))
    y_ticks = sorted(set([0, 1, 2, 4, 6, shared_ymax]))

    legend_handles = [
        Patch(facecolor=TOLERANCE_FILL, edgecolor=TOLERANCE_LINE,
              label="Target band (e ≤ 1)"),
        Line2D([], [], linestyle="none", marker="o", markersize=5,
               color=PALETTE[0], markerfacecolor=PALETTE[0],
               label="Observed"),
        Line2D([], [], linestyle="none", marker="^", markersize=5,
               color=PALETTE[1], markerfacecolor="white", markeredgewidth=.9,
               label="Unlinked response"),
        Line2D([], [], linestyle="none", marker="x", markersize=5,
               color=PALETTE[1], markeredgewidth=1.0,
               label="Reverted candidate"),
        Line2D([], [], linestyle="none", marker="s", markersize=4.7,
               color=DARK, markerfacecolor=DARK,
               label="Terminal reading"),
    ]
    fig.legend(handles=legend_handles, loc="upper center",
               bbox_to_anchor=(.54, .985), ncol=5, frameon=False,
               fontsize=9, handlelength=1.25, handletextpad=.4,
               columnspacing=.85, borderaxespad=0.)

    status_styles = {
        "observed": ("o", PALETTE[0], PALETTE[0], .9),
        "observation_after_unlinked_candidate": ("^", "white", PALETTE[1], .9),
        "reverted_candidate": ("x", PALETTE[1], PALETTE[1], 1.0),
        "terminal_observation": ("s", DARK, DARK, .9),
    }
    for index, (ax, scene) in enumerate(zip(axs.flat, SCENES)):
        trace = metadata["traces"][scene]
        ax.axhspan(0, 1, color=TOLERANCE_FILL, zorder=0)
        ax.axhline(1, color=TOLERANCE_LINE, linewidth=.85,
                   linestyle=(0, (3, 2)), zorder=1)
        ax.set_axisbelow(True)
        ax.grid(axis="y", color="#D7DEE2", linewidth=.45, zorder=0)

        # Keep archived observations discrete; no connecting line or inferred
        # intermediate value is drawn between recorded events.
        for point in trace:
            marker, face, edge, edgewidth = status_styles[point["status"]]
            ax.plot(point["step"], point["deviation"], linestyle="none",
                    marker=marker, markersize=5.2, color=edge,
                    markerfacecolor=face, markeredgecolor=edge,
                    markeredgewidth=edgewidth, zorder=3)

        xmax = max(point["step"] for point in trace)
        ax.set_xlim(-.4, xmax + .45)
        ax.set_ylim(0, shared_ymax)
        ax.set_xticks(list(range(xmax + 1)))
        ax.set_yticks(y_ticks)
        ax.tick_params(direction="out", pad=2.0)
        ax.set_title(f"({panel_tags[index]}) {short_names[scene]}",
                     loc="left", pad=6, fontweight="semibold")
        for label in ax.get_xticklabels() + ax.get_yticklabels():
            label.set_fontsize(9)

    fig.supylabel("Normalized target deviation, e", x=.018, fontsize=9.2)
    fig.supxlabel("Recorded event index", y=.025, fontsize=9.2)

    # Do not crop: the PDF page retains the exact double-column width.
    for ext in ("pdf", "svg"):
        fig.savefig(OUT.with_suffix("." + ext))
    fig.savefig(OUT.with_suffix(".png"), dpi=600)
    plt.close(fig)


def main():
    metadata = parse_source()
    plot(metadata)
    print(json.dumps({"figure": str(OUT.with_suffix(".pdf")),
                      "source": SOURCE_REL, "sha256": metadata["source_sha256"],
                      "scenes": SCENES, "n_per_scene": metadata["n_per_scene"]}, indent=2))


if __name__ == "__main__":
    main()

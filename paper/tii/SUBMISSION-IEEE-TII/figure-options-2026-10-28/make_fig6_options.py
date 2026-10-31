#!/usr/bin/env python3
"""Create three publication-style alternatives for Fig. 6 from archived evidence.

The source contains six paired checkpoints from two simulated scenes. It adds
no observations, interpolation, summary statistics, or uncertainty estimates.
Run with Matplotlib 3.11.2 from this directory or pass --data-root.
"""
from __future__ import annotations

import argparse
import csv
import re
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from matplotlib.ticker import MultipleLocator


HERE = Path(__file__).resolve().parent
DEFAULT_DATA = HERE.parent / "Supplementary-evidence-2026-10-27"
BLUE = "#0072B2"       # Okabe-Ito blue
VERMILLION = "#D55E00" # Okabe-Ito vermillion
GREEN = "#009E73"      # Okabe-Ito green
INK = "#343A40"
MID = "#69737D"
BAND = "#E7EEF2"
BAND_EDGE = "#8096A3"

plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans"],
    "font.size": 9,
    "axes.labelsize": 9,
    "axes.titlesize": 9.5,
    "xtick.labelsize": 8.5,
    "ytick.labelsize": 8.5,
    "legend.fontsize": 8.5,
    "axes.linewidth": 0.8,
    "xtick.direction": "in",
    "ytick.direction": "in",
    "xtick.top": True,
    "ytick.right": True,
    "xtick.major.size": 3,
    "ytick.major.size": 3,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    "figure.facecolor": "white",
    "axes.facecolor": "white",
    "savefig.facecolor": "white",
})


def load_data(root: Path) -> dict[str, dict]:
    """Read paired values and bands from the evidence overview, verify probes."""
    overview = (root / "EVIDENCE-OVERVIEW.md").read_text(encoding="utf-8")
    row_pattern = re.compile(
        r"^\| (Cast film|Annealing) ([123]) \| ([\d.]+) (μm|°C) "
        r"\| ([\d.]+)[–-]([\d.]+) \4 \|.*?\| ([\d.]+) \4 \|",
        re.MULTILINE,
    )
    overview_rows = row_pattern.findall(overview)
    if len(overview_rows) != 6:
        raise ValueError(f"Expected 6 paired rows in evidence overview; found {len(overview_rows)}")

    raw_path = root / "real-harness" / "R20-TRACE-SUMMARY.csv"
    with raw_path.open(encoding="utf-8", newline="") as stream:
        raw_probes = {row["execution_key"]: float(row["sample_value"])
                      for row in csv.DictReader(stream)}
    if len(raw_probes) != 6:
        raise ValueError(f"Expected 6 raw probes; found {len(raw_probes)}")

    scenes = {
        "Cast film": {"key": "cast-film", "label": "Cast film", "unit": "μm"},
        "Annealing": {"key": "annealing", "label": "Continuous annealing", "unit": "°C"},
    }
    for scene_name, task, pre, unit, lower, upper, reported_probe in overview_rows:
        scene = scenes[scene_name]
        if unit != scene["unit"]:
            raise ValueError(f"Unexpected unit for {scene_name}: {unit}")
        key = f"{scene['key']}-r{task}"
        if key not in raw_probes:
            raise ValueError(f"Missing raw probe for {key}")
        # The overview displays probes to two decimals; raw values may retain
        # floating-point serialization artifacts at finer precision.
        if abs(raw_probes[key] - float(reported_probe)) > 0.0051:
            raise ValueError(f"Overview/raw probe mismatch for {key}")
        scene.setdefault("tasks", []).append({
            "task": int(task),
            "pre": float(pre),
            "probe": raw_probes[key],
            "lower": float(lower),
            "upper": float(upper),
        })

    for scene in scenes.values():
        scene["tasks"].sort(key=lambda item: item["task"])
        if len(scene["tasks"]) != 3:
            raise ValueError(f"Expected 3 tasks for {scene['label']}")
        bands = {(task["lower"], task["upper"]) for task in scene["tasks"]}
        if len(bands) != 1:
            raise ValueError(f"Inconsistent target band for {scene['label']}")
        scene["lower"], scene["upper"] = next(iter(bands))
    return scenes


def export(fig: plt.Figure, name: str) -> None:
    for ext in ("pdf", "svg", "png"):
        fig.savefig(HERE / f"{name}.{ext}", dpi=600, metadata={"Creator": "Matplotlib"})
    plt.close(fig)


def style_axes(ax: plt.Axes) -> None:
    ax.spines["top"].set_color("#7B838A")
    ax.spines["right"].set_color("#7B838A")
    ax.spines["left"].set_color("#505960")
    ax.spines["bottom"].set_color("#505960")
    ax.tick_params(colors=INK, width=0.7)
    ax.set_axisbelow(True)


def panel_header(ax: plt.Axes, label: str, title: str) -> None:
    ax.text(-0.02, 1.075, label, transform=ax.transAxes, ha="left", va="bottom",
            fontsize=10, fontweight="bold", color=INK)
    ax.text(0.045, 1.075, title, transform=ax.transAxes, ha="left", va="bottom",
            fontsize=9.5, fontweight="bold", color=INK)


def target_band(ax: plt.Axes, scene: dict, orientation: str = "vertical") -> None:
    lo, hi = scene["lower"], scene["upper"]
    if orientation == "vertical":
        ax.axvspan(lo, hi, facecolor=BAND, edgecolor="none", zorder=0)
        ax.axvline(lo, color=BAND_EDGE, linewidth=0.65, linestyle=(0, (3, 2)), zorder=1)
        ax.axvline(hi, color=BAND_EDGE, linewidth=0.65, linestyle=(0, (3, 2)), zorder=1)
    else:
        ax.axhspan(lo, hi, facecolor=BAND, edgecolor="none", zorder=0)
        ax.axhline(lo, color=BAND_EDGE, linewidth=0.65, linestyle=(0, (3, 2)), zorder=1)
        ax.axhline(hi, color=BAND_EDGE, linewidth=0.65, linestyle=(0, (3, 2)), zorder=1)


def value_label(value: float, scene: dict) -> str:
    return f"{value:.2f}"


def option_a(scenes: dict[str, dict]) -> None:
    """Horizontal paired dot plot in the original measurement units."""
    fig, axes = plt.subplots(1, 2, figsize=(7.16, 3.15), layout="constrained")
    for ax, (name, scene), panel in zip(axes, scenes.items(), ("(a)", "(b)")):
        target_band(ax, scene)
        for task in scene["tasks"]:
            y = 4 - task["task"]
            y_pre, y_probe = y + 0.10, y - 0.10
            ax.plot([task["pre"], task["probe"]], [y_pre, y_probe], color=MID,
                    linewidth=0.85, linestyle=(0, (2.2, 2.0)), zorder=2)
            ax.scatter(task["pre"], y_pre, s=41, marker="o", facecolors="white",
                       edgecolors=VERMILLION, linewidths=1.35, zorder=4)
            ax.scatter(task["probe"], y_probe, s=38, marker="s", facecolors=BLUE,
                       edgecolors=BLUE, linewidths=0.7, zorder=5)
            ax.annotate(value_label(task["pre"], scene), (task["pre"], y_pre),
                        xytext=(0, 7), textcoords="offset points", ha="center",
                        va="bottom", fontsize=8, color=VERMILLION)
            ax.annotate(value_label(task["probe"], scene), (task["probe"], y_probe),
                        xytext=(0, -8), textcoords="offset points", ha="center",
                        va="top", fontsize=8, color=BLUE)
        ax.set_yticks([3, 2, 1], ["Task 1", "Task 2", "Task 3"])
        ax.set_ylim(0.55, 3.45)
        if name == "Cast film":
            ax.set_xlim(43.5, 58.1)
            ax.xaxis.set_major_locator(MultipleLocator(2))
            ax.set_xlabel("Film thickness (μm)")
        else:
            ax.set_xlim(666, 766)
            ax.xaxis.set_major_locator(MultipleLocator(20))
            ax.set_xlabel("Strip temperature (°C)")
        ax.grid(axis="x", color="#D8DDE1", linewidth=0.45)
        panel_header(ax, panel, scene["label"])
        style_axes(ax)
    handles = [
        Patch(facecolor=BAND, edgecolor=BAND_EDGE, linewidth=0.65, label="Target band"),
        Line2D([], [], marker="o", linestyle="none", markerfacecolor="white",
               markeredgecolor=VERMILLION, markeredgewidth=1.25, markersize=5.5,
               label="Pre-task observation"),
        Line2D([], [], marker="s", linestyle="none", markerfacecolor=BLUE,
               markeredgecolor=BLUE, markersize=5.0, label="Single post-trial probe"),
    ]
    fig.legend(handles=handles, loc="outside lower center", ncol=3,
               frameon=False, columnspacing=2.2, handletextpad=0.65)
    export(fig, "fig6_option_A_origin_paired")


def option_b(scenes: dict[str, dict]) -> None:
    """Before/after slopegraph, with one color per paired task."""
    task_colors = [BLUE, VERMILLION, GREEN]
    fig, axes = plt.subplots(1, 2, figsize=(7.16, 3.35), layout="constrained")
    task_offsets = (-0.12, 0.0, 0.12)
    for ax, (name, scene), panel in zip(axes, scenes.items(), ("(a)", "(b)")):
        target_band(ax, scene, orientation="horizontal")
        for task, color, offset in zip(scene["tasks"], task_colors, task_offsets):
            xs = [offset, 1 + offset]
            ys = [task["pre"], task["probe"]]
            ax.plot(xs, ys, color=color, linewidth=1.05, alpha=0.88, zorder=2)
            ax.scatter(xs[0], ys[0], s=43, marker="o", facecolors="white",
                       edgecolors=color, linewidths=1.35, zorder=4)
            ax.scatter(xs[1], ys[1], s=38, marker="s", facecolors=color,
                       edgecolors=color, linewidths=0.7, zorder=4)
        ax.set_xlim(-0.42, 1.42)
        ax.set_xticks([0, 1], ["Pre-task", "Post-trial\nprobe"])
        if name == "Cast film":
            ax.set_ylim(43.5, 58.1)
            ax.yaxis.set_major_locator(MultipleLocator(2))
            ax.set_ylabel("Film thickness (μm)")
        else:
            ax.set_ylim(666, 766)
            ax.yaxis.set_major_locator(MultipleLocator(20))
            ax.set_ylabel("Strip temperature (°C)")
        ax.grid(axis="y", color="#D8DDE1", linewidth=0.45)
        panel_header(ax, panel, scene["label"])
        style_axes(ax)
    handles = [
        Patch(facecolor=BAND, edgecolor=BAND_EDGE, linewidth=0.65, label="Target band"),
        Line2D([], [], marker="o", linestyle="none", markerfacecolor="white",
               markeredgecolor=INK, markeredgewidth=1.25, markersize=5.5,
               label="Pre-task observation"),
        Line2D([], [], marker="s", linestyle="none", markerfacecolor=INK,
               markeredgecolor=INK, markersize=5.0, label="Single post-trial probe"),
    ]
    handles.extend(Line2D([], [], color=color, linewidth=1.2, label=f"Task {i}")
                   for i, color in enumerate(task_colors, start=1))
    fig.legend(handles=handles, loc="outside lower center", ncol=3,
               frameon=False, columnspacing=1.7, handletextpad=0.6)
    export(fig, "fig6_option_B_before_after_slope")


def option_c(scenes: dict[str, dict]) -> None:
    """Paired observations on a common target-normalized axis."""
    fig, axes = plt.subplots(1, 2, figsize=(7.16, 3.15), layout="constrained")
    for ax, (name, scene), panel in zip(axes, scenes.items(), ("(a)", "(b)")):
        lo, hi = scene["lower"], scene["upper"]
        width = hi - lo
        ax.axvspan(0, 1, facecolor=BAND, edgecolor="none", zorder=0)
        ax.axvline(0, color=BAND_EDGE, linewidth=0.65, linestyle=(0, (3, 2)), zorder=1)
        ax.axvline(1, color=BAND_EDGE, linewidth=0.65, linestyle=(0, (3, 2)), zorder=1)
        for task in scene["tasks"]:
            y = 4 - task["task"]
            y_pre, y_probe = y + 0.10, y - 0.10
            pre = (task["pre"] - lo) / width
            probe = (task["probe"] - lo) / width
            ax.plot([pre, probe], [y_pre, y_probe], color=MID, linewidth=0.85,
                    linestyle=(0, (2.2, 2.0)), zorder=2)
            ax.scatter(pre, y_pre, s=41, marker="o", facecolors="white",
                       edgecolors=VERMILLION, linewidths=1.35, zorder=4)
            ax.scatter(probe, y_probe, s=38, marker="s", facecolors=BLUE,
                       edgecolors=BLUE, linewidths=0.7, zorder=5)
            ax.annotate(value_label(task["pre"], scene), (pre, y_pre),
                        xytext=(0, 7), textcoords="offset points", ha="center",
                        va="bottom", fontsize=7.8, color=VERMILLION)
            ax.annotate(value_label(task["probe"], scene), (probe, y_probe),
                        xytext=(0, -8), textcoords="offset points", ha="center",
                        va="top", fontsize=7.8, color=BLUE)
        ax.set_xlim(-0.9, 2.45)
        ax.set_xticks([-0.5, 0, 0.5, 1, 1.5, 2], ["−0.5", "0", "0.5", "1", "1.5", "2"])
        ax.set_yticks([3, 2, 1], ["Task 1", "Task 2", "Task 3"])
        ax.set_ylim(0.55, 3.45)
        ax.set_xlabel("Target-relative position, q")
        ax.grid(axis="x", color="#D8DDE1", linewidth=0.45)
        panel_header(ax, panel, f"{scene['label']} ({scene['unit']}; values labeled)")
        style_axes(ax)
    handles = [
        Patch(facecolor=BAND, edgecolor=BAND_EDGE, linewidth=0.65,
              label="Target band (0 to 1)"),
        Line2D([], [], marker="o", linestyle="none", markerfacecolor="white",
               markeredgecolor=VERMILLION, markeredgewidth=1.25, markersize=5.5,
               label="Pre-task observation"),
        Line2D([], [], marker="s", linestyle="none", markerfacecolor=BLUE,
               markeredgecolor=BLUE, markersize=5.0, label="Single post-trial probe"),
    ]
    fig.legend(handles=handles, loc="outside lower center", ncol=3,
               frameon=False, columnspacing=2.0, handletextpad=0.65)
    export(fig, "fig6_option_C_target_relative")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, default=DEFAULT_DATA)
    args = parser.parse_args()
    scenes = load_data(args.data_root)
    option_a(scenes)
    option_b(scenes)
    option_c(scenes)
    print("Generated three Fig. 6 options from six paired evidence rows.")


if __name__ == "__main__":
    main()

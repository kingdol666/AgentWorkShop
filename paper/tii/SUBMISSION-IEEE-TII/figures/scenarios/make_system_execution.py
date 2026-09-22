# -*- coding: utf-8 -*-
"""IEEE single-column summary of heterogeneous, governed system execution.

Figure contract
---------------
Core conclusion:
    AgentWorkShop executes an end-to-end evidence chain across heterogeneous
    protocol stacks, while reporting process-objective attainment separately
    from framework execution status.
Results-level question:
    Does the framework retain complete and auditable execution evidence without
    conflating successful orchestration with successful process optimization?
Archetype:
    Schematic-led quantitative composite (single IEEE column, 89 mm).
Panel map:
    a, the governed evidence chain; b, heterogeneous protocol timing;
    c, independent execution and scenario-outcome reporting.

All displayed numbers are loaded from scenario-fig-data.json.  Python/matplotlib
is the exclusive rendering backend.  The script exports editable vector files,
a 600-dpi TIFF, a PNG preview, and a mandatory panel-alignment audit.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from matplotlib.ticker import FixedLocator, FuncFormatter

# Nature-figure mandatory typography/export settings.
plt.rcParams["font.family"] = "sans-serif"
plt.rcParams["font.sans-serif"] = ["Arial", "Helvetica", "DejaVu Sans", "Liberation Sans"]
plt.rcParams.update({
    "svg.fonttype": "none",
    "pdf.fonttype": 42,
})
plt.rcParams["ps.fonttype"] = 42
plt.rcParams["font.size"] = 6.5
plt.rcParams["axes.labelsize"] = 6.5
plt.rcParams["axes.titlesize"] = 7.2
plt.rcParams["xtick.labelsize"] = 6.0
plt.rcParams["ytick.labelsize"] = 6.1
plt.rcParams["axes.linewidth"] = 0.65
plt.rcParams["legend.frameon"] = False
plt.rcParams["axes.spines.top"] = False
plt.rcParams["axes.spines.right"] = False
plt.rcParams["savefig.dpi"] = 600

HERE = Path(__file__).resolve().parent
DATA_PATH = HERE / "scenario-fig-data.json"
OUT = HERE / "fig-system-execution"
DATA = json.loads(DATA_PATH.read_text(encoding="utf-8"))
INTEGRATED = DATA["integrated"]
PROTOCOLS = DATA["archivedPlc"]["protocols"]
SCENARIOS = DATA["scenarios"]

# Frozen-data assertions prevent a visually plausible figure from silently
# drifting away from the benchmark evidence used by the manuscript.
assert INTEGRATED["status"] == "PASS"
assert INTEGRATED["checks"] == {"pass": 75, "warn": 5, "fail": 0, "total": 80}
assert INTEGRATED["phases"] == {"pass": 16, "warn": 2, "fail": 0, "total": 18}
assert INTEGRATED["scenarioSubreport"] == {"status": "FAIL", "attained": 2, "total": 4}
assert INTEGRATED["daqSamples"] == 57
assert math.isclose(INTEGRATED["writeP50Ms"], 29.541)
assert math.isclose(INTEGRATED["backstopS"], 130.131)
assert len(PROTOCOLS) == 5
assert sum(bool(s["attained"]) for s in SCENARIOS) == 2

# Color-blind-safe semantic palette (Okabe-Ito inspired).
INK = "#202124"
TEXT = "#3C4043"
MUTED = "#6F7478"
HAIR = "#CBD1D6"
LIGHT = "#EEF2F5"
BLUE = "#0072B2"       # framework / execution evidence
SKY = "#56B4E9"        # heterogeneous transport layer
TEAL = "#009E73"       # attained / verified
AMBER = "#E69F00"      # warnings / backstop action
VERMILION = "#D55E00"  # unmet objective accent (not sole encoding)

SKILL_SCRIPTS = Path(r"C:\Users\87287\.codex\skills\nature-figure\scripts")
if str(SKILL_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SKILL_SCRIPTS))
from audit_panel_alignment import require_matplotlib_panel_alignment  # noqa: E402


def panel_label(ax: plt.Axes, label: str) -> None:
    """Add an auditor-detectable lower-case bold panel label."""
    ax.text(
        -0.075, 1.02, label,
        transform=ax.transAxes, ha="left", va="bottom",
        fontsize=8.0, fontweight="bold", color=INK, clip_on=False,
    )


def panel_title(ax: plt.Axes, title: str) -> None:
    ax.text(
        0.0, 1.02, title,
        transform=ax.transAxes, ha="left", va="bottom",
        fontsize=7.2, fontweight="bold", color=INK, clip_on=False,
    )


def clean_axis(ax: plt.Axes) -> None:
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)


def rounded_outline(ax: plt.Axes, xy: tuple[float, float], width: float, height: float,
                    edge: str = HAIR, lw: float = 0.75, radius: float = 0.018) -> None:
    ax.add_patch(
        FancyBboxPatch(
            xy, width, height,
            boxstyle=f"round,pad=0.008,rounding_size={radius}",
            linewidth=lw, edgecolor=edge, facecolor="none",
            transform=ax.transAxes, clip_on=False,
        )
    )


def draw_panel_a(ax: plt.Axes) -> None:
    clean_axis(ax)
    panel_label(ax, "a")
    panel_title(ax, "Governed evidence chain")

    # A quiet benchmark-status line establishes that the chain completed.
    ax.text(
        1.0, 1.02,
        f"{INTEGRATED['checks']['pass']} pass · {INTEGRATED['checks']['warn']} warn · "
        f"{INTEGRATED['checks']['fail']} hard failures",
        transform=ax.transAxes, ha="right", va="bottom",
        fontsize=5.8, fontweight="bold", color=TEAL, clip_on=False,
    )

    stages = [
        ("Acquire", f"{INTEGRATED['daqSamples']} samples", BLUE),
        ("Govern", f"{INTEGRATED['checks']['total']} checks", BLUE),
        ("Actuate", f"{len(PROTOCOLS)} protocols", SKY),
        ("Verify", f"{INTEGRATED['writeP50Ms']:.3f} ms p50", BLUE),
        ("Recover", f"{INTEGRATED['backstopS']:.3f} s", AMBER),
    ]
    xs = np.linspace(0.082, 0.918, len(stages))
    y = 0.48
    box_w, box_h = 0.158, 0.39

    # Connection first, then boxes/text, so arrows never cross labels.
    for left, right in zip(xs[:-1], xs[1:]):
        ax.add_patch(
            FancyArrowPatch(
                (left + box_w / 2 + 0.006, y),
                (right - box_w / 2 - 0.006, y),
                transform=ax.transAxes,
                arrowstyle="-|>", mutation_scale=6.5,
                linewidth=0.8, color=MUTED, shrinkA=0, shrinkB=0,
            )
        )

    for x, (name, metric, color) in zip(xs, stages):
        rounded_outline(ax, (x - box_w / 2, y - box_h / 2), box_w, box_h, edge=HAIR)
        ax.plot(
            [x - box_w / 2 + 0.018, x + box_w / 2 - 0.018],
            [y + box_h / 2 - 0.055] * 2,
            transform=ax.transAxes, color=color, lw=2.1,
            solid_capstyle="round", clip_on=False,
        )
        ax.text(x, y + 0.045, name, transform=ax.transAxes,
                ha="center", va="center", fontsize=6.15, fontweight="bold", color=INK)
        ax.text(x, y - 0.075, metric, transform=ax.transAxes,
                ha="center", va="center", fontsize=5.15, color=TEXT)

    ax.text(
        0.5, 0.095,
        f"{INTEGRATED['phases']['pass']} pass + {INTEGRATED['phases']['warn']} warn over "
        f"{INTEGRATED['phases']['total']} phases\n"
        "write → readback → judgment → recovery retained",
        transform=ax.transAxes, ha="center", va="center",
        fontsize=5.45, color=MUTED, linespacing=1.30,
    )


def draw_panel_b(ax: plt.Axes) -> None:
    panel_label(ax, "b")
    panel_title(ax, "Heterogeneous protocol paths share one semantic surface")

    ordered = sorted(PROTOCOLS, key=lambda item: item["ms"])
    short = {"Modbus RTU": "MB RTU", "Modbus TCP": "MB TCP"}
    labels = [f"{short.get(item['name'], item['name'])}  {item['ms']}" for item in ordered]
    values = np.array([item["ms"] for item in ordered], dtype=float)
    if np.any(values <= 0):
        raise ValueError("Protocol times must be strictly positive for the log axis")
    y = np.arange(len(ordered))

    ax.set_xscale("log")
    ax.set_xlim(12, 2100)
    ax.set_ylim(-0.55, len(ordered) - 0.45)
    ax.xaxis.set_major_locator(FixedLocator([20, 30, 100, 300, 1000]))
    ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{int(v)}"))
    ax.xaxis.set_minor_locator(FixedLocator([]))
    ax.set_yticks(y)
    ax.set_yticklabels(labels)
    ax.set_xlabel("Observed write-path time (ms, log scale)", labelpad=3.0)

    for yi, value in zip(y, values):
        ax.hlines(yi, 14, value, color=HAIR, lw=1.1, zorder=1)
    ax.scatter(values, y, s=28, color=BLUE, edgecolor="white", linewidth=0.65, zorder=3)





    ax.grid(axis="x", which="major", color=LIGHT, linewidth=0.7, zorder=0)
    ax.tick_params(axis="both", direction="out", length=2.2, width=0.65, color=MUTED, pad=2)
    ax.spines["left"].set_visible(False)
    ax.spines["bottom"].set_color(MUTED)
    ax.spines["bottom"].set_linewidth(0.65)


def draw_panel_c(ax: plt.Axes) -> None:
    clean_axis(ax)
    panel_label(ax, "c")
    panel_title(ax, "Execution and outcome are reported independently")

    # Two outlined evidence bands keep the interpretation explicit without
    # treating scenario attainment as an execution failure.
    rounded_outline(ax, (0.00, 0.56), 1.00, 0.30, edge=HAIR, lw=0.8)
    rounded_outline(ax, (0.00, 0.08), 1.00, 0.36, edge=HAIR, lw=0.8)

    # Internal integration-suite evidence. The bar encodes observed check
    # counts, not a synthetic performance score.
    ax.text(0.035, 0.79, "Internal integration suite", transform=ax.transAxes,
            ha="left", va="center", fontsize=6.2, fontweight="bold", color=INK)
    ax.text(0.965, 0.79, f"{INTEGRATED['checks']['fail']} hard failures", transform=ax.transAxes,
            ha="right", va="center", fontsize=6.35, fontweight="bold", color=TEAL)
    x0, x1, y = 0.035, 0.965, 0.675
    check_total = INTEGRATED["checks"]["total"]
    pass_x = x0 + (x1 - x0) * INTEGRATED["checks"]["pass"] / check_total
    ax.plot([x0, pass_x], [y, y], transform=ax.transAxes, color=BLUE, lw=5.0,
            solid_capstyle="butt")
    ax.plot([pass_x, x1], [y, y], transform=ax.transAxes, color=AMBER, lw=5.0,
            solid_capstyle="butt")
    ax.text(0.035, 0.585,
            f"{INTEGRATED['phases']['total']} phases: {INTEGRATED['phases']['pass']} pass · "
            f"{INTEGRATED['phases']['warn']} warn   |   "
            f"closed loop {INTEGRATED['closedLoop']['convergedN']}/{INTEGRATED['closedLoop']['n']} converged, "
            f"{INTEGRATED['closedLoop']['writesTotal']} writes, "
            f"{INTEGRATED['closedLoop']['rejectedTotal']} rejected",
            transform=ax.transAxes, ha="left", va="bottom", fontsize=5.35, color=MUTED)

    # Scenario-objective band.
    attained = INTEGRATED["scenarioSubreport"]["attained"]
    total = INTEGRATED["scenarioSubreport"]["total"]
    ax.text(0.035, 0.385, "Process objectives", transform=ax.transAxes,
            ha="left", va="center", fontsize=6.2, fontweight="bold", color=INK)
    ax.text(0.965, 0.385, f"{attained}/{total} attained", transform=ax.transAxes,
            ha="right", va="center", fontsize=6.5, fontweight="bold", color=VERMILION)

    # A 100% evidence bar reports the scenario result without feeding it
    # back into the framework-execution verdict.
    x0, x1, y_obj = 0.035, 0.965, 0.245
    split = x0 + (x1 - x0) * attained / total
    ax.plot([x0, split], [y_obj, y_obj], transform=ax.transAxes,
            color=TEAL, lw=6.0, solid_capstyle="butt")
    ax.plot([split, x1], [y_obj, y_obj], transform=ax.transAxes,
            color=HAIR, lw=6.0, solid_capstyle="butt")
    ax.plot([split, split], [y_obj - 0.035, y_obj + 0.035], transform=ax.transAxes,
            color="white", lw=1.0)
    ax.text((x0 + split) / 2, 0.305, f"{attained} attained",
            transform=ax.transAxes, ha="center", va="center",
            fontsize=5.45, fontweight="bold", color=TEAL)
    ax.text((split + x1) / 2, 0.305, f"{total - attained} unmet",
            transform=ax.transAxes, ha="center", va="center",
            fontsize=5.45, fontweight="bold", color=VERMILION)

    terminal = next(s.get("taskTerminal") for s in SCENARIOS if s["id"] == "biax")
    ax.text(
        0.5, 0.135,
        f"BOPET: task terminal = {terminal}; objective predicate = unmet",
        transform=ax.transAxes, ha="center", va="center", fontsize=5.20, color=MUTED,
    )


def build_figure() -> plt.Figure:
    width_mm = 89.0  # IEEE single-column width
    width_in = width_mm / 25.4
    height_in = 130.0 / 25.4
    fig = plt.figure(figsize=(width_in, height_in), facecolor="white")
    gs = fig.add_gridspec(
        3, 1,
        height_ratios=[1.05, 1.42, 1.30],
        left=0.185, right=0.970, top=0.958, bottom=0.055,
        hspace=0.50,
    )
    ax_a = fig.add_subplot(gs[0, 0])
    ax_b = fig.add_subplot(gs[1, 0])
    ax_c = fig.add_subplot(gs[2, 0])

    draw_panel_a(ax_a)
    draw_panel_b(ax_b)
    draw_panel_c(ax_c)
    fig.canvas.draw()

    require_matplotlib_panel_alignment(
        fig,
        axes=[ax_a, ax_b, ax_c],
        panel_ids=["a", "b", "c"],
        column_groups=[["a", "b", "c"]],
        json_out=OUT.with_suffix(".alignment.json"),
        overlay_svg=OUT.with_suffix(".alignment.svg"),
        tolerance_pt=1.5,
        gutter_tolerance_pt=1.5,
        require_panel_labels=True,
        strict=True,
    )
    return fig


def export(fig: plt.Figure) -> None:
    # No tight bounding box: preserve the exact 89-mm final width.
    fig.savefig(OUT.with_suffix(".pdf"), facecolor="white")
    fig.savefig(OUT.with_suffix(".svg"), facecolor="white")
    fig.savefig(OUT.with_suffix(".png"), dpi=600, facecolor="white")
    fig.savefig(OUT.with_suffix(".tiff"), dpi=600, facecolor="white",
                pil_kwargs={"compression": "tiff_lzw"})
    plt.close(fig)


if __name__ == "__main__":
    export(build_figure())
    print(f"Wrote publication figure bundle at {OUT.name}.*")



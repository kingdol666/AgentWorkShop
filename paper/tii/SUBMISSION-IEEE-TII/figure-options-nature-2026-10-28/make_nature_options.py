"""Nature-figure-style alternatives for manuscript Figs. 1 and 5.

The diagrams are rebuilt in Matplotlib from implementation semantics. Fig. 5
uses a normalized conceptual interval sketch and contains no run-derived data.
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Rectangle
from matplotlib.lines import Line2D

ROOT = Path(__file__).resolve().parent
SKILL_SCRIPTS = Path(r"C:\Users\87287\.codex\skills\nature-figure\scripts")
sys.path.insert(0, str(SKILL_SCRIPTS))
from audit_panel_alignment import require_matplotlib_panel_alignment  # noqa: E402

# Nature-figure contract: editable text and vector TrueType fonts.
# Editable vector-text requirements: svg.fonttype='none'; pdf.fonttype=42.
plt.rcParams['font.family'] = 'sans-serif'
plt.rcParams['font.sans-serif'] = ['Arial', 'DejaVu Sans', 'Liberation Sans']
plt.rcParams['svg.fonttype'] = 'none'
plt.rcParams['pdf.fonttype'] = 42
plt.rcParams["ps.fonttype"] = 42
plt.rcParams["font.size"] = 9.0
plt.rcParams["axes.unicode_minus"] = False
plt.rcParams["savefig.facecolor"] = "white"

INK = "#24313D"
NAVY = "#315F7C"
BLUE = "#4E7895"
TEAL = "#2D7F78"
AMBER = "#B27A2B"
MUTED = "#667580"
EDGE = "#B7C3CB"
GRID = "#E2E8EC"
PALE_BLUE = "#EEF3F6"
PALE_TEAL = "#EDF5F3"
PALE_AMBER = "#F7F1E7"
WHITE = "#FFFFFF"

FIG1_SIZE = {
    "A": (3.50, 4.22),
    "B": (7.16, 2.72),
    "C": (7.16, 2.82),
}
FIG5_SIZE = (7.16, 2.95)


def rounded_box(ax, x, y, w, h, title, detail="", *, color=NAVY,
                fill=WHITE, edge=EDGE, title_size=9.3, detail_size=8.4,
                rounding=0.06, weight="bold", title_y=0.68,
                detail_y=0.31, detail_linespacing=1.13):
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h,
        boxstyle=f"round,pad=0.015,rounding_size={rounding}",
        facecolor=fill, edgecolor=edge, linewidth=0.8,
    ))
    ax.text(x + w / 2, y + h * title_y, title, ha="center", va="center",
            color=color, fontsize=title_size, weight=weight, linespacing=1.0)
    if detail:
        ax.text(x + w / 2, y + h * detail_y, detail, ha="center", va="center",
                color=INK, fontsize=detail_size, linespacing=detail_linespacing)


def arrow(ax, start, end, *, color=MUTED, lw=1.05, scale=8.5,
          linestyle="-", rad=0):
    ax.add_patch(FancyArrowPatch(
        start, end, arrowstyle="-|>", mutation_scale=scale,
        linewidth=lw, color=color, linestyle=linestyle,
        shrinkA=0, shrinkB=0, connectionstyle=f"arc3,rad={rad}",
    ))


def new_canvas(size, xlim, ylim):
    fig = plt.figure(figsize=size, facecolor=WHITE)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    ax.axis("off")
    return fig, ax


def export(fig, stem, *, panel_ids=None, row_groups=None, exemptions=()):
    align_path = ROOT / f"{stem}.alignment.json"
    overlay_path = ROOT / f"{stem}.alignment.svg"
    require_matplotlib_panel_alignment(
        fig,
        json_out=align_path,
        overlay_svg=overlay_path,
        tolerance_pt=1.5,
        gutter_tolerance_pt=1.5,
        require_panel_labels=panel_ids is not None,
        strict=True,
        panel_ids=panel_ids,
        row_groups=row_groups,
        exemptions=exemptions,
    )
    fig.savefig(ROOT / f"{stem}.pdf")
    fig.savefig(ROOT / f"{stem}.svg")
    fig.savefig(ROOT / f"{stem}.png", dpi=600)
    plt.close(fig)


def panel_box(ax, center, y, title, detail, *, fill=WHITE,
              color=NAVY, width=1.12, height=0.53,
              title_size=8.3, detail_size=7.15):
    rounded_box(ax, center - width / 2, y, width, height, title, detail,
                color=color, fill=fill, title_size=title_size,
                detail_size=detail_size)


def fig1_a_vertical():
    """Single-column process flow with deliberately long vertical connectors."""
    fig, ax = new_canvas(FIG1_SIZE["A"], (0, 3.5), (0, 4.22))
    xs = 1.75
    w, h = 2.52, 0.48
    nodes = [
        (3.62, "Task and production context", "goal, line, product, recipe, run", BLUE, PALE_BLUE),
        (2.91, "Agent control", "DAQ/MES context → named operation", BLUE, WHITE),
        (2.20, "Shared operation dispatcher", "scope, policy, applicable grant", TEAL, PALE_TEAL),
        (1.49, "Route checks", "scene limits; approval and recheck", TEAL, WHITE),
        (0.78, "Device access", "DCW → driver → PLC / simulator", NAVY, PALE_BLUE),
    ]
    for y, title, detail, color, fill in nodes:
        rounded_box(ax, xs - w / 2, y, w, h, title, detail,
                    color=color, fill=fill, title_size=9.1, detail_size=9.0)
    for upper, lower in zip(nodes, nodes[1:]):
        arrow(ax, (xs, upper[0]), (xs, lower[0] + h), color=BLUE, lw=1.0, scale=8.2)

    # Keep evidence endpoints separate: execution receipt is not a later DAQ sample.
    out_y, out_h, out_w = 0.10, 0.43, 1.50
    left_c, right_c = 0.92, 2.58
    rounded_box(ax, left_c - out_w / 2, out_y, out_w, out_h,
                "Command receipt", "write / readback", color=BLUE,
                fill=PALE_BLUE, title_size=9.0, detail_size=9.0)
    rounded_box(ax, right_c - out_w / 2, out_y, out_w, out_h,
                "Later observation", "timestamped DAQ", color=TEAL,
                fill=PALE_TEAL, title_size=9.0, detail_size=9.0)
    arrow(ax, (xs - 0.16, 0.78), (left_c, out_y + out_h), color=BLUE,
          lw=0.95, scale=7.5, rad=0.10)
    arrow(ax, (xs + 0.16, 0.78), (right_c, out_y + out_h), color=TEAL,
          lw=0.95, scale=7.5, linestyle="--", rad=-0.10)
    export(fig, "fig1_A_vertical_single_column")


def draw_horizontal_flow(ax, *, two_lanes=False):
    if two_lanes:
        stage_y, stage_w, stage_h = 1.35, 1.13, 0.72
        centers = [0.78, 2.18, 3.58, 4.98, 6.38]
        nodes = [
            ("Context", "goal + active\nproduction tuple", BLUE, PALE_BLUE),
            ("Agent", "DAQ/MES context;\noperation proposal", BLUE, WHITE),
            ("Dispatcher", "scope + policy;\napplicable checks", TEAL, PALE_TEAL),
            ("Route checks", "scene limits;\napproval if required", TEAL, WHITE),
            ("Device", "DCW → driver →\nPLC / simulator", NAVY, PALE_BLUE),
        ]
        ax.text(0.20, 2.58, "OPERATION PATH", fontsize=8.1, weight="bold",
                color=MUTED, ha="left", va="center")
        ax.plot([1.32, 6.96], [2.58, 2.58], color=GRID, lw=0.8)
        ax.text(0.20, 0.89, "EVIDENCE", fontsize=8.1, weight="bold",
                color=MUTED, ha="left", va="center")
        ax.plot([0.88, 6.96], [0.89, 0.89], color=GRID, lw=0.8)
        receipt_y, receipt_h = 0.26, 0.53
        receipt_x, receipt_w = 2.13, 1.92
        observation_x, observation_w = 4.55, 2.16
        for center, (title, detail, color, fill) in zip(centers, nodes):
            panel_box(ax, center, stage_y, title, detail, fill=fill,
                      color=color, width=stage_w, height=stage_h,
                      title_size=8.4, detail_size=7.2)
        for left, right in zip(centers, centers[1:]):
            arrow(ax, (left + stage_w / 2, stage_y + stage_h / 2),
                  (right - stage_w / 2, stage_y + stage_h / 2),
                  color=BLUE, lw=1.1, scale=8.7)
        ax.text(2.18, 2.36, "Application policy", fontsize=7.6,
                color=BLUE, ha="center", va="center")
        arrow(ax, (2.18, 2.25), (2.18, stage_y + stage_h),
              color=BLUE, lw=0.85, scale=7.2, linestyle="--")
        ax.text(4.98, 2.36, "Scene targets / guards", fontsize=7.6,
                color=AMBER, ha="center", va="center")
        arrow(ax, (4.98, 2.25), (4.98, stage_y + stage_h),
              color=AMBER, lw=0.85, scale=7.2, linestyle="--")
        rounded_box(ax, receipt_x, receipt_y, receipt_w, receipt_h,
                    "Command receipt", "write / readback result", color=BLUE,
                    fill=PALE_BLUE, title_size=8.3, detail_size=7.4)
        rounded_box(ax, observation_x, receipt_y, observation_w, receipt_h,
                    "Later process observation", "timestamped DAQ sample", color=TEAL,
                    fill=PALE_TEAL, title_size=8.3, detail_size=7.4)
        arrow(ax, (centers[3], stage_y), (receipt_x + receipt_w * 0.55,
                                           receipt_y + receipt_h),
              color=BLUE, lw=1.05, scale=8.2, rad=0.08)
        arrow(ax, (centers[4], stage_y), (observation_x + observation_w * 0.50,
                                           receipt_y + receipt_h),
              color=TEAL, lw=1.05, scale=8.2, linestyle="--", rad=-0.08)
    else:
        stage_y, stage_w, stage_h = 1.23, 1.10, 0.76
        centers = [0.73, 2.16, 3.59, 5.02, 6.45]
        nodes = [
            ("Task + scene", "goal / policy;\nactive run context", BLUE, PALE_BLUE),
            ("Agent", "available DAQ/MES;\nnamed operation", BLUE, WHITE),
            ("Shared dispatch", "scope + channel policy;\napplicable checks", TEAL, PALE_TEAL),
            ("Write handler", "scene guards / limits;\nconditional approval", TEAL, WHITE),
            ("Device access", "DCW → driver;\nPLC / simulator", NAVY, PALE_BLUE),
        ]
        for center, (title, detail, color, fill) in zip(centers, nodes):
            panel_box(ax, center, stage_y, title, detail, fill=fill,
                      color=color, width=stage_w, height=stage_h,
                      title_size=8.15, detail_size=7.0)
        for left, right in zip(centers, centers[1:]):
            arrow(ax, (left + stage_w / 2, stage_y + stage_h / 2),
                  (right - stage_w / 2, stage_y + stage_h / 2),
                  color=BLUE, lw=1.1, scale=8.7)
        ax.text(2.16, 2.25, "Application policy", fontsize=7.7,
                color=BLUE, ha="center", va="center")
        arrow(ax, (2.16, 2.14), (2.16, stage_y + stage_h),
              color=BLUE, lw=0.85, scale=7.2, linestyle="--")
        ax.text(5.02, 2.25, "Scene targets / guards", fontsize=7.7,
                color=AMBER, ha="center", va="center")
        arrow(ax, (5.02, 2.14), (5.02, stage_y + stage_h),
              color=AMBER, lw=0.85, scale=7.2, linestyle="--")
        receipt_y, receipt_h = 0.18, 0.47
        receipt_x, receipt_w = 3.38, 1.66
        sample_x, sample_w = 5.22, 1.64
        rounded_box(ax, receipt_x, receipt_y, receipt_w, receipt_h,
                    "Command receipt", "write / readback", color=BLUE,
                    fill=PALE_BLUE, title_size=7.9, detail_size=7.0)
        rounded_box(ax, sample_x, receipt_y, sample_w, receipt_h,
                    "Later DAQ sample", "process observation", color=TEAL,
                    fill=PALE_TEAL, title_size=7.9, detail_size=7.0)
        arrow(ax, (centers[3], stage_y), (receipt_x + receipt_w / 2,
                                           receipt_y + receipt_h),
              color=BLUE, lw=1.05, scale=8.2, rad=0.08)
        arrow(ax, (centers[4], stage_y), (sample_x + sample_w / 2,
                                           receipt_y + receipt_h),
              color=TEAL, lw=1.05, scale=8.2, linestyle="--", rad=-0.08)


def fig1_b_horizontal():
    fig, ax = new_canvas(FIG1_SIZE["B"], (0, 7.16), (0, 2.72))
    draw_horizontal_flow(ax, two_lanes=False)
    export(fig, "fig1_B_horizontal_handoffs")


def fig1_c_evidence_lanes():
    fig, ax = new_canvas(FIG1_SIZE["C"], (0, 7.16), (0, 2.82))
    draw_horizontal_flow(ax, two_lanes=True)
    export(fig, "fig1_C_operation_and_evidence_lanes")


def panel_letter(ax, letter, title, subtitle):
    ax.text(0.025, 1.025, letter, transform=ax.transAxes,
            fontsize=9.2, weight="bold", color=INK,
            ha="left", va="bottom", clip_on=False)
    ax.text(0.105, 1.025, title, transform=ax.transAxes,
            fontsize=9.3, weight="bold", color=INK,
            ha="left", va="bottom", clip_on=False)
    ax.text(0.105, 0.925, subtitle, transform=ax.transAxes,
            fontsize=9.0, color=MUTED,
            ha="left", va="bottom", clip_on=False)


def draw_intervals(ax, style="color"):
    if style == "mono":
        baseline, product, recipe, common = MUTED, INK, INK, INK
        common_fill, hard_line = "#D9DEE2", INK
    elif style == "hero":
        baseline, product, recipe, common = BLUE, TEAL, AMBER, TEAL
        common_fill, hard_line = "#B9DDD7", NAVY
    else:
        baseline, product, recipe, common = BLUE, TEAL, AMBER, TEAL
        common_fill, hard_line = "#D5E8E5", NAVY

    x_left, x_right = 0.98, 3.38
    xmap = lambda value: x_left + value * (x_right - x_left)
    rows = [
        ("Hard limit", 0.06, 0.94, hard_line, 2.28),
        ("Baseline", 0.16, 0.84, baseline, 1.86),
        ("Product", 0.12, 0.88, product, 1.44),
        ("Recipe", 0.30, 0.70, recipe, 1.02),
    ]
    common_lo, common_hi, y_common = 0.30, 0.70, 0.47
    for name, lo, hi, color, yy in rows:
        ax.plot([x_left, x_right], [yy, yy], color=GRID, linewidth=0.65, zorder=0)
        ax.text(0.12, yy, name, fontsize=9.0, color=INK,
                ha="left", va="center", weight="bold" if name == "Hard limit" else "normal")
        ax.plot([xmap(lo), xmap(hi)], [yy, yy], color=color,
                linewidth=4.3 if style == "hero" else 3.5,
                solid_capstyle="butt", zorder=3)
        for endpoint in (lo, hi):
            ax.plot([xmap(endpoint), xmap(endpoint)], [yy - 0.075, yy + 0.075],
                    color=INK, linewidth=0.8, zorder=4)

    # The highlighted interval is the conceptual intersection of all four
    # constraints. No numeric test values or measurements are encoded.
    if style == "hero":
        ax.add_patch(Rectangle((xmap(common_lo), 0.35),
                               xmap(common_hi) - xmap(common_lo), 2.09,
                               facecolor=common_fill, alpha=0.34,
                               edgecolor="none", zorder=0))
        for endpoint in (common_lo, common_hi):
            ax.plot([xmap(endpoint), xmap(endpoint)], [0.40, 2.43],
                    color=TEAL, linewidth=0.8, linestyle=(0, (2, 2)), zorder=1)
    ax.text(0.12, y_common, "Admissible", fontsize=9.0,
            color=common if style != "mono" else INK,
            ha="left", va="center", weight="bold")
    ax.plot([xmap(common_lo), xmap(common_hi)], [y_common, y_common],
            color=common,
            linewidth=5.2 if style == "hero" else 4.2,
            solid_capstyle="butt", zorder=4)
    ax.text(0.12, 0.10, "Conceptual intersection; no experimental values",
            fontsize=9.0, color=MUTED, ha="left", va="bottom", style="italic")

    ax.set_xlim(0, 3.60)
    ax.set_ylim(0, 2.92)
    ax.set_xticks([])
    ax.set_yticks([])
    for side in ("left", "right", "top", "bottom"):
        ax.spines[side].set_visible(False)


def draw_approval(ax, style="color"):
    ax.set_xlim(0, 3.60)
    ax.set_ylim(0, 2.92)
    ax.axis("off")
    edge = EDGE if style != "mono" else INK
    approve = TEAL if style != "mono" else INK
    decline = AMBER if style != "mono" else INK
    panel_letter(ax, "b", "Conditional approval / recheck",
                 "Symbolic path; no measured process values")
    rounded_box(ax, 0.53, 2.00, 2.48, 0.45,
                "Operation proposal", "operation + active context",
                color=NAVY, fill=PALE_BLUE if style != "mono" else WHITE,
                edge=edge, title_size=9.2, detail_size=9.0,
                title_y=0.69, detail_y=0.27)
    rounded_box(ax, 0.83, 1.31, 1.88, 0.43,
                "Human decision", "only when required",
                color=approve, fill=PALE_TEAL if style != "mono" else WHITE,
                edge=edge, title_size=9.0, detail_size=9.0,
                title_y=0.69, detail_y=0.27)
    arrow(ax, (1.77, 2.00), (1.77, 1.75), color=MUTED, lw=0.9, scale=7.6)

    left_x, card_w, right_x = 0.17, 1.48, 1.95
    card_y, card_h = 0.05, 0.94
    branch_y = 1.16
    ax.plot([1.77, 1.77], [1.31, branch_y], color=MUTED, linewidth=0.8)
    ax.plot([left_x + card_w / 2, right_x + card_w / 2],
            [branch_y, branch_y], color=MUTED, linewidth=0.8)
    arrow(ax, (left_x + card_w / 2, branch_y),
          (left_x + card_w / 2, card_y + card_h), color=decline, lw=0.9,
          scale=7.4)
    arrow(ax, (right_x + card_w / 2, branch_y),
          (right_x + card_w / 2, card_y + card_h), color=approve, lw=0.9,
          scale=7.4)
    rounded_box(ax, left_x, card_y, card_w, card_h,
                "Decline", "record decision\nno dispatch",
                color=decline, fill=PALE_AMBER if style != "mono" else WHITE,
                edge=edge, title_size=9.0, detail_size=9.0,
                title_y=0.86, detail_y=0.38)
    rounded_box(ax, right_x, card_y, card_w, card_h,
                "Approve + recheck",
                "authority + tuple\nlimits checked\npass: dispatch\nfail: stop",
                color=approve, fill=PALE_TEAL if style != "mono" else WHITE,
                edge=edge, title_size=9.0, detail_size=9.0,
                title_y=0.86, detail_y=0.38, detail_linespacing=1.20)


def make_fig5(variant):
    size = FIG5_SIZE
    fig = plt.figure(figsize=size, facecolor=WHITE)
    if variant == "B":
        gs = fig.add_gridspec(1, 2, width_ratios=[1.22, 1.0],
                              left=0.045, right=0.985,
                              bottom=0.07, top=0.89, wspace=0.09)
        ax_a, ax_b = fig.add_subplot(gs[0, 0]), fig.add_subplot(gs[0, 1])
        style = "hero"
        exemptions = [{
            "panels": ["b"],
            "checks": ["panel-width"],
            "reason": "Panel a is the quantitative interval hero; panel b is a subordinate symbolic approval-path schematic.",
        }]
    else:
        gs = fig.add_gridspec(1, 2, width_ratios=[1, 1],
                              left=0.055, right=0.98,
                              bottom=0.07, top=0.89, wspace=0.10)
        ax_a, ax_b = fig.add_subplot(gs[0, 0]), fig.add_subplot(gs[0, 1])
        style = "mono" if variant == "C" else "color"
        exemptions = []
    for ax in (ax_a, ax_b):
        ax.set_facecolor(WHITE)
    panel_letter(ax_a, "a", "Configured range intersection", "Conceptual mechanism · no run data")
    draw_intervals(ax_a, style=style)
    draw_approval(ax_b, style=style)
    fig.canvas.draw()
    # A light divider is placed in the gutter without changing either panel area.
    x_div = (ax_a.get_position().x1 + ax_b.get_position().x0) / 2
    fig.add_artist(Line2D([x_div, x_div], [0.09, 0.88],
                          transform=fig.transFigure, color=GRID, linewidth=0.8))
    stem = {
        "A": "fig5_A_balanced_ranges_and_approval",
        "B": "fig5_B_interval_hero_and_recheck",
        "C": "fig5_C_grayscale_admission_flow",
    }[variant]
    export(fig, stem, panel_ids=["a", "b"], row_groups=[["a", "b"]],
           exemptions=exemptions)


def make_contact_sheet(fig_number, stems, output, captions):
    images = [plt.imread(ROOT / f"{stem}.png") for stem in stems]
    fig, axes = plt.subplots(len(images), 1, figsize=(7.16, 12.8),
                             constrained_layout=True)
    for ax, image, caption in zip(axes, images, captions):
        ax.imshow(image)
        ax.set_title(caption, loc="left", fontsize=10, weight="bold", color=INK, pad=7)
        ax.axis("off")
    fig.savefig(ROOT / output, dpi=300, facecolor=WHITE)
    plt.close(fig)


def write_source_data():
    rows = [
        ("hard", 0.06, 0.94, "normalized sketch position", "conceptual layout coordinate; not experimental data"),
        ("baseline", 0.16, 0.84, "normalized sketch position", "conceptual layout coordinate; not experimental data"),
        ("product", 0.12, 0.88, "normalized sketch position", "conceptual layout coordinate; not experimental data"),
        ("recipe", 0.30, 0.70, "normalized sketch position", "conceptual layout coordinate; not experimental data"),
        ("admissible_intersection", 0.30, 0.70, "normalized sketch position", "conceptual intersection only; not experimental data"),
    ]
    with (ROOT / "fig5_interval_source.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["range", "lower", "upper", "unit", "source_note"])
        writer.writerows(rows)


def write_readme():
    text = """# Fig. 1 and Fig. 5 — refined figure options

The six alternatives are author-selection drafts. They are not inserted into the manuscript. Each figure is exported as editable SVG, vector PDF, and 600-dpi PNG; the Matplotlib source and alignment/collision QA outputs are included alongside them.

## Figure contract

- **Fig. 1 claim:** registered-harness operations and direct operations converge at a shared named-operation dispatcher, while command receipts and later process observations remain distinct evidence records.
- **Fig. 1 archetype:** single-system execution schematic. A/B/C vary only the layout and evidence-lane emphasis; they do not add system behavior.
- **Fig. 5 claim:** configured value ranges constrain online admission, and a required human approval is followed by an authority/context/limit recheck before dispatch.
- **Fig. 5 archetype:** schematic-led mixed-modality composite. Panel a is a normalized conceptual interval intersection with no run-derived values; panel b is a symbolic execution path.
- **Statistics:** none. These are limit ranges and a symbolic flow, not replicate summaries; no error bars or significance claims are appropriate.
- **Output:** IEEE TII two-column width 7.16 in for Fig. 1 B/C and all Fig. 5 alternatives; Fig. 1 A is 3.50 in single-column width. Editable SVG, embedded-font vector PDF, and 600-dpi PNG previews.

## Fig. 1 choices

- **A — `fig1_A_vertical_single_column.pdf`:** single-column vertical flow, with longer inter-stage arrows and separate receipt/sample outputs. It fits a one-column placement but is taller.
- **B — `fig1_B_horizontal_handoffs.pdf`:** compact horizontal sequence; the policy and guard inputs enter above their relevant stages.
- **C — `fig1_C_operation_and_evidence_lanes.pdf`:** separates the operation path from the evidence path. Recommended when the key point is that a command receipt is not a later process observation.

**Proposed caption:** Execution path from task context through the agent, shared operation dispatcher, route checks, and configured device access. Application policy and scene targets or guards enter at their respective stages. Command receipts are returned by execution, whereas subsequent process observations are recorded separately as DAQ samples when available.

## Fig. 5 choices

- **A — `fig5_A_balanced_ranges_and_approval.pdf`:** balanced panels for interval admission and the conditional approval flow.
- **B — `fig5_B_interval_hero_and_recheck.pdf`:** gives the common interval the dominant visual weight and keeps the approval path subordinate. Recommended for the clearest evidence hierarchy.
- **C — `fig5_C_grayscale_admission_flow.pdf`:** monochrome-safe line and fill treatment.

**Proposed caption:** (a) Conceptual intersection of hard, baseline, product, and recipe admission ranges; horizontal positions are schematic and do not encode experimental values. (b) Symbolic conditional-approval path: a decline is recorded without dispatch, while approval triggers a recheck of authority, production context, and applicable limits before dispatch.

The interval source coordinates are listed in `fig5_interval_source.csv` and are layout coordinates only. They do not encode measurements or a particular test run.

## Review notes

The flow colors are redundantly encoded with text, dash style, and separate evidence labels; the grayscale Fig. 5 option remains interpretable without hue. Fig. 5 panels have equal heights and aligned top edges; option B uses an explicit width exemption because panel a carries the interval evidence and panel b is explanatory. Before insertion, update the manuscript's `figure`/`figure*` environment to match the selected width, retain the proposed caption's evidence boundary, and compile to confirm the final float position and page count.

## Reproduction

```text
uv run --isolated --with "matplotlib==3.11.2" --with numpy python make_nature_options.py
```
"""
    (ROOT / "README.md").write_text(text, encoding="utf-8")


def main():
    write_source_data()
    fig1_a_vertical()
    fig1_b_horizontal()
    fig1_c_evidence_lanes()
    make_fig5("A")
    make_fig5("B")
    make_fig5("C")
    make_contact_sheet(
        1,
        ["fig1_A_vertical_single_column", "fig1_B_horizontal_handoffs",
         "fig1_C_operation_and_evidence_lanes"],
        "fig1_comparison.png",
        ["A · Single-column vertical flow", "B · Horizontal handoffs",
         "C · Separate operation and evidence lanes"],
    )
    make_contact_sheet(
        5,
        ["fig5_A_balanced_ranges_and_approval", "fig5_B_interval_hero_and_recheck",
         "fig5_C_grayscale_admission_flow"],
        "fig5_comparison.png",
        ["A · Balanced interval and approval panels", "B · Interval evidence as the hero",
         "C · Grayscale-safe admission and approval"],
    )
    write_readme()
    print(f"Wrote refined alternatives to {ROOT}")


if __name__ == "__main__":
    main()

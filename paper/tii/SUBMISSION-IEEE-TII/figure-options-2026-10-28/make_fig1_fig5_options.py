"""Create six publication-sized, evidence-faithful alternatives for Figs. 1 and 5.

All numeric intervals in Fig. 5 are illustrative values from the archived
admission drill. The diagrams are explanatory schematics, not experimental
outcome plots. Render with Matplotlib 3.11.2 from the manuscript workspace.
"""
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Polygon, Rectangle


OUT = Path(__file__).resolve().parent

INK = "#26323D"
NAVY = "#315F7C"
BLUE = "#4D7896"
TEAL = "#2A7F78"
AMBER = "#B87924"
RED = "#A75D55"
MUTED = "#6E7B85"
EDGE = "#B9C4CC"
GRID = "#E3E9ED"
PALE_BLUE = "#EEF3F6"
PALE_TEAL = "#EDF5F3"
PALE_AMBER = "#F8F2E8"
WHITE = "#FFFFFF"


def configure():
    plt.rcParams.update(
        {
            "font.family": ["Arial", "DejaVu Sans"],
            "font.size": 9.0,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "svg.fonttype": "none",
            "axes.unicode_minus": False,
            "savefig.facecolor": WHITE,
        }
    )


def rounded_box(ax, x, y, w, h, title, detail="", color=NAVY, fill=WHITE,
                title_size=9.0, detail_size=8.2, edge=EDGE, lw=0.85,
                align="center", pad=0.04, weight="bold", title_frac=None,
                detail_frac=None):
    ax.add_patch(
        FancyBboxPatch(
            (x, y), w, h,
            boxstyle="round,pad=0.012,rounding_size=0.055",
            facecolor=fill, edgecolor=edge, linewidth=lw,
        )
    )
    left = x + pad if align == "left" else x + w / 2
    ha = "left" if align == "left" else "center"
    if detail:
        title_y = y + h * (0.77 if "\n" in detail else 0.67)
        detail_y = y + h * (0.30 if "\n" in detail else 0.31)
        if title_frac is not None:
            title_y = y + h * title_frac
        if detail_frac is not None:
            detail_y = y + h * detail_frac
        ax.text(left, title_y, title, ha=ha, va="center", color=color,
                fontsize=title_size, weight=weight, linespacing=1.02)
        ax.text(left, detail_y, detail, ha=ha, va="center", color=INK,
                fontsize=detail_size, linespacing=1.10)
    else:
        ax.text(left, y + h / 2, title, ha=ha, va="center", color=color,
                fontsize=title_size, weight=weight, linespacing=1.05)


def arrow(ax, start, end, color=MUTED, lw=1.05, style="-|>", scale=8.5,
          linestyle="-", connectionstyle="arc3,rad=0"):
    ax.add_patch(
        FancyArrowPatch(
            start, end, arrowstyle=style, mutation_scale=scale,
            linewidth=lw, color=color, linestyle=linestyle,
            shrinkA=0, shrinkB=0, connectionstyle=connectionstyle,
        )
    )


def canvas(width, height):
    fig = plt.figure(figsize=(width, height), facecolor=WHITE)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, width)
    ax.set_ylim(0, height)
    ax.axis("off")
    return fig, ax


def save(fig, stem):
    fig.savefig(OUT / f"{stem}.pdf", format="pdf")
    fig.savefig(OUT / f"{stem}.svg", format="svg")
    fig.savefig(OUT / f"{stem}.png", format="png", dpi=600)
    plt.close(fig)


def fig1_a_column_flow():
    """One-column flow with visible vertical links and distinct evidence outputs."""
    w, h = 3.50, 3.86
    fig, ax = canvas(w, h)
    x, bw = 0.17, 3.16
    rows = [
        (3.18, 0.52, "Task and active production context",
         "Goal / policy · active line/product/recipe/run", BLUE, PALE_BLUE),
        (2.59, 0.43, "Agent control",
         "Available DAQ/MES → named operation", BLUE, WHITE),
        (2.00, 0.43, "Shared operation dispatcher",
         "Scope + policy · applicable grant / binding", TEAL, PALE_TEAL),
        (1.41, 0.43, "Write handler",
         "Scene guards · approval / recheck if required", TEAL, WHITE),
        (0.82, 0.43, "Device access",
         "DCW → configured driver → PLC / simulator", NAVY, PALE_BLUE),
    ]
    for y, rh, title, detail, color, fill in rows:
        rounded_box(ax, x, y, bw, rh, title, detail, color=color, fill=fill,
                    title_size=9.0, detail_size=8.2, pad=0.13, align="left")
    # Each inter-stage connector spans 0.16 in (11.5 pt), over twice the
    # 4.7 pt gap in the current artwork.
    for y0, y1 in [(3.18, 3.02), (2.59, 2.43), (2.00, 1.84), (1.41, 1.25)]:
        arrow(ax, (w / 2, y0), (w / 2, y1), lw=1.15, scale=9.0)

    # One execution path, two deliberately separate records.
    receipt_x, obs_x, ow, oh, oy = 0.19, 1.84, 1.45, 0.44, 0.08
    branch_y = 0.70
    ax.plot([w / 2, w / 2], [0.82, branch_y], color=MUTED, lw=0.95)
    ax.plot([receipt_x + ow / 2, obs_x + ow / 2], [branch_y, branch_y],
            color=MUTED, lw=0.95)
    arrow(ax, (receipt_x + ow / 2, branch_y), (receipt_x + ow / 2, oy + oh),
          color=BLUE, lw=1.0, scale=8.0)
    arrow(ax, (obs_x + ow / 2, branch_y), (obs_x + ow / 2, oy + oh),
          color=TEAL, lw=1.0, scale=8.0, linestyle="--")
    rounded_box(ax, receipt_x, oy, ow, oh, "Command receipt", color=BLUE,
                fill=PALE_BLUE, title_size=8.3, edge=BLUE, lw=0.8)
    rounded_box(ax, obs_x, oy, ow, oh, "Later process observation", color=TEAL,
                fill=PALE_TEAL, title_size=8.0, edge=TEAL, lw=0.8)
    save(fig, "fig1_option_A_column-flow")


def fig1_b_horizontal_handoffs():
    """Two-column horizontal flow with a separate evidence row."""
    w, h = 7.16, 2.72
    fig, ax = canvas(w, h)
    box_w, box_h, gap = 1.15, 0.78, 0.24
    left = 0.23
    y = 1.47
    stages = [
        ("Task + scene", "Goal / policy\nactive run context", BLUE, PALE_BLUE),
        ("Agent", "Available DAQ/MES\nnamed operation", BLUE, WHITE),
        ("Shared dispatch", "Scope + channel\napplicable grant/binding", TEAL, PALE_TEAL),
        ("Write handler", "Scene guards / limits\nconditional approval + recheck", TEAL, WHITE),
        ("Device access", "DCW → driver\nPLC / simulator", NAVY, PALE_BLUE),
    ]
    xs = []
    for i, (title, detail, color, fill) in enumerate(stages):
        x = left + i * (box_w + gap)
        xs.append(x)
        rounded_box(ax, x, y, box_w, box_h, title, detail, color=color,
                    fill=fill, title_size=8.7, detail_size=8.1,
                    edge=EDGE, pad=0.035)
    for i in range(4):
        arrow(ax, (xs[i] + box_w, y + box_h / 2),
              (xs[i + 1], y + box_h / 2), lw=1.15, scale=8.3)

    # Dashed configuration links indicate setup inputs, not measured results.
    rounded_box(ax, 1.63, 2.38, 1.35, 0.24, "Application policy",
                color=BLUE, fill=PALE_BLUE, title_size=8.0, edge=EDGE, lw=0.65)
    arrow(ax, (2.18, 2.38), (2.18, y + box_h), color=BLUE, lw=0.8,
          scale=7.5, linestyle="--")
    rounded_box(ax, 4.45, 2.38, 1.40, 0.24, "Scene targets / guards",
                color=TEAL, fill=PALE_TEAL, title_size=8.0, edge=EDGE, lw=0.65)
    arrow(ax, (5.12, 2.38), (5.12, y + box_h), color=TEAL, lw=0.8,
          scale=7.5, linestyle="--")

    # Evidence boxes are independent destinations; the dashed line denotes a
    # later DAQ sample, not an immediate device acknowledgement.
    rounded_box(ax, 4.15, 0.30, 1.27, 0.44, "Command receipt",
                color=BLUE, fill=PALE_BLUE, title_size=8.0, edge=BLUE, lw=0.8)
    rounded_box(ax, 5.76, 0.30, 1.23, 0.44, "Later DAQ sample",
                color=TEAL, fill=PALE_TEAL, title_size=8.0, edge=TEAL, lw=0.8)
    arrow(ax, (xs[3] + box_w * 0.72, y), (4.78, 0.74), color=BLUE,
          lw=0.95, scale=8.0, connectionstyle="arc3,rad=0.12")
    arrow(ax, (xs[4] + box_w * 0.62, y), (6.37, 0.74), color=TEAL,
          lw=0.95, scale=8.0, linestyle="--", connectionstyle="arc3,rad=-0.10")
    save(fig, "fig1_option_B_horizontal-handoffs")


def fig1_c_swimlane():
    """Two-tier functional view; operation route and evidence route are separated."""
    w, h = 7.16, 2.70
    fig, ax = canvas(w, h)
    # Light lane rules create a restrained Origin-like scaffold.
    ax.text(0.20, 2.36, "OPERATION PATH", fontsize=8.1, color=MUTED,
            weight="bold", va="center")
    ax.plot([1.42, 6.96], [2.36, 2.36], color=GRID, lw=0.8)
    ax.text(0.20, 0.95, "EVIDENCE", fontsize=8.1, color=MUTED,
            weight="bold", va="center")
    ax.plot([1.42, 6.96], [0.95, 0.95], color=GRID, lw=0.8)

    y, bh, bw = 1.31, 0.66, 1.18
    xs = [0.24, 1.63, 3.02, 4.41, 5.80]
    stages = [
        ("Context", "Goal + active\nproduction tuple", BLUE, PALE_BLUE),
        ("Agent", "DAQ/MES context;\noperation proposal", BLUE, WHITE),
        ("Dispatcher", "Scope / policy;\napplicable checks", TEAL, PALE_TEAL),
        ("Route checks", "Scene limits;\napproval if required", TEAL, WHITE),
        ("Device", "DCW → driver →\nPLC / simulator", NAVY, PALE_BLUE),
    ]
    for x, (title, detail, color, fill) in zip(xs, stages):
        rounded_box(ax, x, y, bw, bh, title, detail, color=color, fill=fill,
                    title_size=8.7, detail_size=8.0, edge=EDGE, pad=0.035)
    for i in range(4):
        arrow(ax, (xs[i] + bw, y + bh / 2), (xs[i + 1], y + bh / 2),
              lw=1.15, scale=8.0)
    # Compact setup signals into their configured stages.
    ax.text(2.22, 2.17, "Application policy", fontsize=8.0, color=BLUE,
            ha="center", va="center")
    arrow(ax, (2.22, 2.09), (2.22, y + bh), color=BLUE, lw=0.8,
          scale=7.4, linestyle="--")
    ax.text(4.99, 2.17, "Targets / guards", fontsize=8.0, color=TEAL,
            ha="center", va="center")
    arrow(ax, (4.99, 2.09), (4.99, y + bh), color=TEAL, lw=0.8,
          scale=7.4, linestyle="--")

    # Separate record boxes occupy a dedicated evidence lane.
    rounded_box(ax, 2.26, 0.30, 1.73, 0.50, "Command receipt",
                "write / readback result", color=BLUE, fill=PALE_BLUE,
                title_size=8.7, detail_size=8.0, edge=BLUE, lw=0.8)
    rounded_box(ax, 4.65, 0.30, 1.93, 0.50, "Later process observation",
                "timestamped DAQ sample", color=TEAL, fill=PALE_TEAL,
                title_size=8.5, detail_size=8.0, edge=TEAL, lw=0.8)
    arrow(ax, (xs[3] + bw * 0.42, y), (3.12, 0.80), color=BLUE,
          lw=0.9, scale=7.5, connectionstyle="arc3,rad=0.10")
    arrow(ax, (xs[4] + bw * 0.64, y), (5.62, 0.80), color=TEAL,
          lw=0.9, scale=7.5, linestyle="--", connectionstyle="arc3,rad=-0.10")
    save(fig, "fig1_option_C_two-lane")


def draw_interval_panel(ax, x0, x1, y_top, style="color"):
    """Illustrative four-layer interval, with explicit overview/detail scales."""
    left_label = x0 + 0.04
    plot_x0 = x0 + 1.00
    plot_x1 = x1 - 0.10
    width = plot_x1 - plot_x0
    ax.text(x0 + 0.04, y_top, "(a)  Four-layer admission", fontsize=9.6,
            color=INK, weight="bold", ha="left", va="top")
    ax.text(x0 + 0.04, y_top - 0.23, "Illustrative interval drill · rpm",
            fontsize=8.5, color=MUTED, ha="left", va="top")

    # Overview for hard equipment bounds [50, 200].
    ov_y = y_top - 0.66
    ax.text(left_label, ov_y + 0.08, "Hard limit", fontsize=8.2, color=INK,
            ha="left", va="center")
    ax.text(left_label, ov_y - 0.10, "50–200 rpm", fontsize=8.0,
            color=MUTED, ha="left", va="center")
    ax.plot([plot_x0, plot_x1], [ov_y, ov_y], color=EDGE, lw=1.2, zorder=1)
    ax.plot([plot_x0, plot_x1], [ov_y, ov_y], color=NAVY, lw=4.0,
            solid_capstyle="butt", zorder=2)
    ax.plot([plot_x0, plot_x1], [ov_y, ov_y], color=WHITE, lw=0.9,
            linestyle=(0, (2.2, 2.2)), zorder=3)
    # The detail interval is called out as a view window within the hard limit.
    scale_lo, scale_hi = 140.0, 160.0
    xmap = lambda v: plot_x0 + (v - scale_lo) / (scale_hi - scale_lo) * width
    hardmap = lambda v: plot_x0 + (v - 50.0) / (200.0 - 50.0) * width
    zoom_a, zoom_b = hardmap(140), hardmap(160)
    ax.add_patch(Rectangle((zoom_a, ov_y - 0.055), zoom_b - zoom_a, 0.11,
                           facecolor=PALE_TEAL, edgecolor=TEAL, linewidth=0.7,
                           linestyle="--", zorder=4))
    ax.text((zoom_a + zoom_b) / 2, ov_y + 0.13, "detail: 140–160 rpm",
            fontsize=8.0, ha="center", va="bottom", color=TEAL)

    rows = [
        ("Baseline", 143.7, 156.3, "[143.7, 156.3]", BLUE),
        ("Product", 146.22, 153.78, "[146.22, 153.78]", TEAL),
        ("Recipe", 141.0, 159.0, "[141, 159]", AMBER),
    ]
    row_y0 = y_top - 1.12
    dy = 0.27
    if style == "focus":
        band_top = row_y0 + 0.12
        band_bottom = row_y0 - 3 * dy - 0.06
        ax.add_patch(Rectangle(
            (xmap(146.22), band_bottom), xmap(153.78) - xmap(146.22),
            band_top - band_bottom, facecolor=PALE_TEAL, edgecolor="none",
            alpha=0.85, zorder=0,
        ))
        for bound in (146.22, 153.78):
            ax.plot([xmap(bound), xmap(bound)], [band_bottom, band_top],
                    color=TEAL, lw=0.75, linestyle=(0, (2.0, 2.2)), zorder=2)
    for idx, (name, lo, hi, text, color) in enumerate(rows):
        yy = row_y0 - idx * dy
        ax.text(left_label, yy, name, fontsize=8.2, color=INK,
                ha="left", va="center")
        xa, xb = xmap(lo), xmap(hi)
        ax.plot([plot_x0, plot_x1], [yy, yy], color=GRID, lw=0.7, zorder=1)
        ax.text((xa + xb) / 2, yy + 0.105, text, fontsize=8.0, color=MUTED,
                ha="center", va="bottom")
        if style == "mono":
            color = INK
            ax.plot([xa, xb], [yy, yy], color=color, lw=3.5,
                    solid_capstyle="butt", zorder=3)
            ax.plot([xa, xb], [yy, yy], color=WHITE, lw=0.9,
                    linestyle="--" if idx == 2 else "-", zorder=4)
        else:
            if style == "focus" and idx == 1:
                color = NAVY
            ax.plot([xa, xb], [yy, yy], color=color, lw=4.0,
                    solid_capstyle="butt", zorder=3)
        ax.plot([xa, xa], [yy - 0.065, yy + 0.065], color=INK, lw=0.75, zorder=5)
        ax.plot([xb, xb], [yy - 0.065, yy + 0.065], color=INK, lw=0.75, zorder=5)
    allowable_y = row_y0 - len(rows) * dy
    ax.text(left_label, allowable_y, "Common", fontsize=8.2, color=TEAL if style != "mono" else INK,
            ha="left", va="center", weight="bold")
    ax.plot([plot_x0, plot_x1], [allowable_y, allowable_y], color=GRID, lw=0.7, zorder=1)
    common_color = INK if style == "mono" else TEAL
    ax.text((xmap(146.22) + xmap(153.78)) / 2, allowable_y + 0.105,
            "[146.22, 153.78]", fontsize=8.0, color=MUTED,
            ha="center", va="bottom")
    ax.plot([xmap(146.22), xmap(153.78)], [allowable_y, allowable_y],
            color=common_color, lw=6.0, solid_capstyle="butt", zorder=3)
    if style == "mono":
        ax.plot([xmap(146.22), xmap(153.78)], [allowable_y, allowable_y],
                color=WHITE, lw=1.0, linestyle=(0, (1.4, 1.4)), zorder=4)
    for v in (140, 145, 150, 155, 160):
        xx = xmap(v)
        ax.plot([xx, xx], [allowable_y - 0.09, row_y0 + 0.12], color=GRID,
                lw=0.55, zorder=0)
        ax.text(xx, allowable_y - 0.14, f"{v}", fontsize=8.0, color=MUTED,
                ha="center", va="top")
    # The common interval is labeled directly above its own range bar.


def flow_panel(ax, x0, x1, y_top, style="color"):
    panel_w = x1 - x0
    edge = EDGE if style == "color" else INK
    ink = INK
    accent = TEAL if style == "color" else INK
    decline = AMBER if style == "color" else INK
    ax.text(x0 + 0.04, y_top, "(b)  Conditional approval / recheck",
            fontsize=9.6, color=INK, weight="bold", ha="left", va="top")
    ax.text(x0 + 0.04, y_top - 0.23,
            "Symbolic path · no measured process values",
            fontsize=8.5, color=MUTED, ha="left", va="top")

    # Compact flow for the approval-required path. Values are intentionally
    # absent; approved context is checked again before dispatch.
    bx = x0 + 0.22
    bw = panel_w - 0.44
    rounded_box(ax, bx + 0.53, y_top - 0.83, bw - 1.06, 0.38,
                "Proposal", "operation + active context", color=NAVY,
                fill=PALE_BLUE if style == "color" else WHITE,
                title_size=8.6, detail_size=8.0, edge=edge, lw=0.75)
    rounded_box(ax, bx + 0.73, y_top - 1.48, bw - 1.46, 0.40,
                "Human decision", "only if required", color=accent,
                fill=PALE_TEAL if style == "color" else WHITE,
                title_size=8.5, detail_size=8.0, edge=edge, lw=0.75)
    arrow(ax, (x0 + panel_w / 2, y_top - 0.83),
          (x0 + panel_w / 2, y_top - 1.08), color=MUTED, lw=0.9, scale=7.7)

    left_x = bx + 0.02
    card_w = 1.36
    right_x = left_x + 1.48
    branch_y = y_top - 1.62
    decision_bottom = y_top - 1.48
    ax.plot([x0 + panel_w / 2, x0 + panel_w / 2], [decision_bottom, branch_y],
            color=MUTED, lw=0.8)
    ax.plot([left_x + card_w / 2, right_x + card_w / 2], [branch_y, branch_y],
            color=MUTED, lw=0.8)
    card_y = y_top - 2.70
    card_h = 0.85
    card_top = card_y + card_h
    arrow(ax, (left_x + card_w / 2, branch_y), (left_x + card_w / 2, card_top),
          color=decline, lw=0.9, scale=7.5)
    arrow(ax, (right_x + card_w / 2, branch_y), (right_x + card_w / 2, card_top),
          color=accent, lw=0.9, scale=7.5)
    rounded_box(ax, left_x, card_y, card_w, card_h,
                "Decline", "record decision\nno dispatch", color=decline,
                fill=PALE_AMBER if style == "color" else WHITE,
                title_size=8.3, detail_size=8.0, edge=edge, lw=0.75,
                title_frac=0.80, detail_frac=0.40)
    rounded_box(ax, right_x, card_y, card_w, card_h,
                "Approve + recheck", "authority + tuple\nlimits checked\npass: dispatch\nfail: stop", color=accent,
                fill=PALE_TEAL if style == "color" else WHITE,
                title_size=8.1, detail_size=8.0, edge=edge, lw=0.75,
                title_frac=0.82, detail_frac=0.37)


def fig5_a_origin_split():
    """Origin-like restrained color, explicit four ranges and conditional path."""
    w, h = 7.16, 2.95
    fig, ax = canvas(w, h)
    ax.plot([3.59, 3.59], [0.10, 2.83], color=GRID, lw=0.9)
    draw_interval_panel(ax, 0.15, 3.50, 2.83, style="color")
    flow_panel(ax, 3.70, 7.04, 2.83, style="color")
    ax.text(0.20, 0.13, "Illustrative ranges from a separate archived admission drill",
            fontsize=8.0, color=MUTED, ha="left", va="bottom", style="italic")
    save(fig, "fig5_option_A_origin-interval-approval")


def fig5_b_range_focus():
    """Enlarged range bands with explicit common interval and approval states."""
    w, h = 7.16, 2.95
    fig, ax = canvas(w, h)
    ax.plot([3.59, 3.59], [0.10, 2.83], color=GRID, lw=0.9)
    # Reuse exact data with a tighter, range-first heading and stronger
    # intersection emphasis; no process outcomes or error bars are introduced.
    draw_interval_panel(ax, 0.15, 3.50, 2.83, style="focus")
    # Add an explicit evidence boundary beneath panel (a).
    ax.text(0.20, 0.13, "Illustrative ranges from a separate archived admission drill",
            fontsize=8.0, color=MUTED, ha="left", va="bottom", style="italic")
    flow_panel(ax, 3.70, 7.04, 2.83, style="color")
    save(fig, "fig5_option_B_intersection-and-states")


def fig5_c_grayscale():
    """Grayscale-compatible variant using line styles and patterns as cues."""
    w, h = 7.16, 2.95
    fig, ax = canvas(w, h)
    ax.plot([3.59, 3.59], [0.10, 2.83], color=EDGE, lw=0.9)
    draw_interval_panel(ax, 0.15, 3.50, 2.83, style="mono")
    flow_panel(ax, 3.70, 7.04, 2.83, style="mono")
    ax.text(0.20, 0.13, "Illustrative ranges from a separate archived admission drill",
            fontsize=8.0, color=MUTED, ha="left", va="bottom", style="italic")
    save(fig, "fig5_option_C_grayscale")


def main():
    configure()
    fig1_a_column_flow()
    fig1_b_horizontal_handoffs()
    fig1_c_swimlane()
    fig5_a_origin_split()
    fig5_b_range_focus()
    fig5_c_grayscale()
    print(f"Wrote six alternatives to {OUT}")


if __name__ == "__main__":
    main()

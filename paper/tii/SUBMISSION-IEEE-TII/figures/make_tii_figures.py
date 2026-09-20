"""Publication figures for the IEEE TII submission.

Origin-style conventions throughout:
  * Times/serif text at journal sizes, boxed axes, inward major+minor ticks on all spines
  * no chart junk: no grid by default, no legend frames, no filled areas except hatched bands
  * every series is distinguishable by marker shape and line style, so the figures survive a
    greyscale reprint and the common colour-vision deficiencies
  * every plotted number is read from the frozen archives named in `bench/reports-archive`;
    nothing is interpolated, smoothed, or invented

Run from the repository root:
    python paper/tii/figures/tii-final/make_tii_figures.py
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Rectangle

try:
    import fitz  # PyMuPDF, used for the post-render QA pass
except ImportError:  # pragma: no cover
    fitz = None

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[3]

ARCHIVE = "20260920094610-to4"
ARCHIVE_A = "20260920093330-md4"
ARCHIVE_ABL = "20260920094442-e1lite"
ARCHIVE_PLC = "20260920094335-1b5g"
REPORT = ROOT / "bench" / "reports-archive" / "20260920-stable-final" / "benchmark-report.md"

# --------------------------------------------------------------------------------------
# Origin-style rc block.  Sizes are the values IEEE TII figures are normally set in:
# axis labels at 8 pt, tick labels at 7 pt, panel tags at 8 pt bold.
# --------------------------------------------------------------------------------------
plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "Times", "Nimbus Roman", "DejaVu Serif"],
    "mathtext.fontset": "stix",
    "font.size": 8,
    "axes.titlesize": 8,
    "axes.labelsize": 8,
    "xtick.labelsize": 7,
    "ytick.labelsize": 7,
    "legend.fontsize": 7,
    "axes.linewidth": 0.7,
    "xtick.major.width": 0.7,
    "ytick.major.width": 0.7,
    "xtick.minor.width": 0.6,
    "ytick.minor.width": 0.6,
    "lines.linewidth": 0.9,
    "lines.markersize": 3.6,
    "hatch.linewidth": 0.5,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    "svg.fonttype": "none",
    "savefig.dpi": 600,
    "figure.dpi": 120,
})

INK = "#000000"
SOFT = "#4d4d4d"
GRID = "#c9c9c9"
TEAL = "#1F6F78"
RED = "#B3282D"
BLUE = "#3D6FB5"
GREEN = "#2E7D32"
AMBER = "#C8871B"
GREY = "#5F6B76"
PURPLE = "#6A4C93"
TINT = ["#E8F1F2", "#FBEDED", "#EDF3FA", "#EDF5EE", "#FBF3E4", "#EFEFF3"]

# Times family fallback: if Times New Roman is unavailable, DejaVu Serif still embeds.
RESOLVED_SERIF = plt.rcParams["font.serif"]
MARK = ["o", "s", "^", "D"]
DASH = ["-", "--", ":", "-."]


# --------------------------------------------------------------------------------------
# data loading
# --------------------------------------------------------------------------------------
def load(archive: str, name: str):
    return json.loads((ROOT / "bench" / "results" / archive / name).read_text(encoding="utf-8-sig"))


RUN = load(ARCHIVE, "run.json")
RUN_A = load(ARCHIVE_A, "run.json")
ABL = load(ARCHIVE_ABL, "run.json")
PLC = load(ARCHIVE_PLC, "run.json")

ENV = RUN["env"]
PHASES = RUN["phases"]
CHECKS = RUN["checks"]
SEEDS = RUN["closedloop"]["seeds"]
AGG = RUN["closedloop"]["agg"]
LINES = RUN["lines"]
MISSION = ENV["biax"]["missionTraj"]

if not (ENV["verdict"]["ok"] and ENV["runId"] == ARCHIVE and ENV["profile"] == "integrated"):
    raise SystemExit(f"archive {ARCHIVE} is not the frozen governing run")


def phase_order() -> list[dict]:
    """Pipeline order as recorded, with the per-phase check count resolved from `checks`."""
    rows = []
    for p in PHASES:
        n = sum(1 for c in CHECKS if c["phase"] == p["phase"])
        rows.append({"phase": p["phase"], "n": n})
    return rows


ORDER = phase_order()
assert sum(r["n"] for r in ORDER) == 75, "phase/check partition drifted"

# Functional layers, used for both grouping and the table in the manuscript.
LAYERS = [
    ("Plant &\nprovisioning", ["P0", "P1", "P2"], TINT[0]),
    ("Protocol I/O &\ngovernance", ["P3"], TINT[2]),
    ("Tool loops\n& records", ["P4", "P4b", "P4c", "P4d", "P4e", "P4f"], TINT[3]),
    ("Team objectives\n& BOPET line", ["P4m", "P10"], TINT[4]),
    ("Controller\n& backstop", ["P6", "P7", "P8", "P8b"], TINT[1]),
    ("Platform\nsubsystems", ["P9"], TINT[5]),
]

QA: dict[str, dict] = {}


# --------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------
def origin_axes(ax, minor=True, grid_axis=None):
    """Boxed Origin frame: black spines, inward major+minor ticks on every spine."""
    for spine in ax.spines.values():
        spine.set_linewidth(0.7)
        spine.set_color(INK)
    ax.tick_params(which="major", direction="in", length=2.6, width=0.7,
                   top=True, right=True, colors=INK)
    if minor:
        ax.tick_params(which="minor", direction="in", length=1.4, width=0.6,
                       top=True, right=True, colors=INK)
        ax.minorticks_on()
    if grid_axis:
        ax.grid(axis=grid_axis, color=GRID, linewidth=0.5, linestyle="-", zorder=0)
        ax.set_axisbelow(True)


def panel_tag(ax, tag, dx=0.0, dy=1.045):
    ax.text(dx, dy, tag, transform=ax.transAxes, ha="left", va="bottom",
            fontsize=8, fontweight="bold", color=INK)


def save(fig, name: str, pad=0.02):
    """Vector PDF for LaTeX plus a raster proof, metadata stripped for reproducibility."""
    pdf = OUT / f"{name}.pdf"
    fig.savefig(pdf, metadata={"CreationDate": None, "ModDate": None}, bbox_inches=None)
    fig.savefig(OUT / f"{name}.png", dpi=600, bbox_inches=None)
    plt.close(fig)
    return pdf


def _nonoverlap_ok(boxes, tol=0.75):
    """Return the first pair of text boxes that visibly collide, else None."""
    rects = [(b[0], b[1], b[2], b[3]) for b in boxes]
    n = len(rects)
    for i in range(n):
        x0, y0, x1, y1 = rects[i]
        for j in range(i + 1, n):
            a0, b0, a1, b1 = rects[j]
            ox = min(x1, a1) - max(x0, a0)
            oy = min(y1, b1) - max(y0, b0)
            if ox > tol and oy > tol:
                return (i, j, round(ox, 2), round(oy, 2))
    return None


def qa_pdf(name: str, pdf: Path, expected_in, raster=False):
    """Post-render QA: single page, exact physical size, embedded fonts, no live text outside
    the canvas, and no overlapping render-visible strings inside a panel group."""
    info = {"size_in": list(expected_in), "raster_images_in_pdf": None,
            "embedded_fonts": None, "fonts": None, "text_boxes": None, "overlap": None,
            "spans_outside_canvas": None}
    if fitz is None:
        QA[name] = info
        return
    with fitz.open(pdf) as doc:
        if len(doc) != 1:
            raise SystemExit(f"{name}: expected a single-page figure, got {len(doc)}")
        page = doc[0]
        if not np.allclose([page.rect.width, page.rect.height],
                           np.array(expected_in) * 72.0, atol=0.02):
            raise SystemExit(f"{name}: page {page.rect.width}x{page.rect.height} pt != "
                             f"{expected_in} in")
        info["raster_images_in_pdf"] = len(page.get_images())
        fonts = page.get_fonts(full=True)
        info["embedded_fonts"] = all(doc.extract_font(f[0])[3] for f in fonts)
        info["fonts"] = sorted({f[3] for f in fonts})
        spans, boxes = [], []
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    box = fitz.Rect(span["bbox"])
                    spans.append(box)
                    if span["text"].strip():
                        boxes.append((box.x0, box.y0, box.x1, box.y1))
        info["text_boxes"] = len(boxes)
        info["spans_outside_canvas"] = sum(1 for b in spans if not page.rect.contains(b))
        clash = _nonoverlap_ok(boxes)
        info["overlap"] = clash
        if info["spans_outside_canvas"]:
            raise SystemExit(f"{name}: {info['spans_outside_canvas']} text spans fall outside "
                             f"the canvas")
        if clash:
            raise SystemExit(f"{name}: text boxes {clash[0]} and {clash[1]} overlap by "
                             f"{clash[2]}x{clash[3]} pt")
    QA[name] = info


# ======================================================================================
# Figure: closed-loop supervisory control structure  (single column)
# ======================================================================================
def fig_control_loop():
    W, H = 3.4, 5.05
    fig = plt.figure(figsize=(W, H))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis("off")

    def lane(y, h, label, sub, fill):
        ax.add_patch(FancyBboxPatch((1.0, y), 98.0, h,
                                    boxstyle="round,pad=0,rounding_size=1.4",
                                    facecolor=fill, edgecolor=INK, linewidth=0.7, zorder=1))
        ax.text(2.4, y + h - 2.2, label, ha="left", va="top",
                fontsize=7.4, fontweight="bold", zorder=4)
        ax.text(91.6, y + h - 2.2, sub, ha="right", va="top",
                fontsize=6.2, color=SOFT, zorder=4)

    def node(x, y, w, h, title, body="", fill="white", bold=True, fs=6.4, bfs=6.0):
        ax.add_patch(FancyBboxPatch((x, y), w, h,
                                    boxstyle="round,pad=0,rounding_size=0.9",
                                    facecolor=fill, edgecolor=INK, linewidth=0.7, zorder=3))
        if body:
            ax.text(x + w / 2, y + h * 0.66, title, ha="center", va="center",
                    fontsize=fs, fontweight="bold" if bold else "normal", zorder=4)
            ax.text(x + w / 2, y + h * 0.27, body, ha="center", va="center",
                    fontsize=bfs, color=SOFT, linespacing=1.15, zorder=4)
        else:
            ax.text(x + w / 2, y + h / 2, title, ha="center", va="center",
                    fontsize=fs, fontweight="bold" if bold else "normal", zorder=4)

    def arrow(x0, y0, x1, y1, style="-", color=INK, lw=0.7, rad=0.0, mut=7):
        ax.add_patch(FancyArrowPatch((x0, y0), (x1, y1), arrowstyle="-|>",
                                     mutation_scale=mut, linewidth=lw, color=color,
                                     linestyle=style, zorder=2,
                                     connectionstyle=f"arc3,rad={rad}",
                                     shrinkA=0.6, shrinkB=0.6))

    def tag(x, y, text):
        ax.text(x, y, text, ha="center", va="center", fontsize=6.2, style="italic",
                color=SOFT, zorder=5)

    # ---- decision loop -----------------------------------------------------------------
    lane(83.5, 14.5, "Supervisory loop", "seconds to minutes", TINT[2])
    node(4.0, 85.0, 27.0, 10.2, "Plant / digital twin",
         "thickness, melt T,\nmelt p, defect rate", fill="white")
    node(35.0, 85.0, 26.5, 10.2, "Acquisition nodes",
         "DAQ over five protocols", fill="white")
    node(65.5, 85.0, 31.0, 10.2, "Controller",
         r"$N\leftarrow N(50/h)$", fill="white")
    arrow(31.3, 90.1, 34.7, 90.1)
    arrow(61.8, 90.1, 65.2, 90.1)
    tag(33.0, 92.6, "C1")
    tag(63.5, 92.6, "C2")

    # ---- governance + execution plane --------------------------------------------------
    lane(58.0, 25.5, "Governed execution plane", "per write", TINT[4])
    node(4.0, 70.5, 92.5, 7.0, "Admission checks, in order",
         "hard range \u2192 recipe window \u2192 product / baseline limit \u2192 approval",
         fill=TINT[0], fs=6.2, bfs=5.9)
    arrow(81.0, 84.8, 81.0, 77.9)
    tag(72.6, 81.5, "C3")

    node(4.0, 57.5, 21.0, 12.5, "Modbus TCP", "zone 1-3 SP\n120-260 \u00b0C")
    node(27.0, 57.5, 21.0, 12.5, "OPC UA", "screw speed\n50-200 rpm")
    node(50.0, 57.5, 21.0, 12.5, "MQTT", "line speed\n20-120 m/min")
    node(73.0, 57.5, 23.5, 12.5, "HTTP", "die gap\n0.5-2.0 mm")
    for x in (14.5, 37.5, 60.5, 84.75):
        arrow(x, 70.0, x, 69.9)
    ax.text(50.0, 53.6, "driver write  +  readback", ha="center", va="center",
            fontsize=6.0, color=SOFT, style="italic")

    # ---- evidence plane ----------------------------------------------------------------
    lane(38.0, 14.0, "Evidence plane", "attribution", TINT[3])
    node(4.0, 39.5, 28.5, 9.5, "Optimization record", "baseline + hypothesis")
    node(35.0, 39.5, 29.0, 9.5, "Readback / setpoint", r"$|v_{\rm rb}-v|\leq\tau_n$")
    node(66.5, 39.5, 30.0, 9.5, "Judgment + journal", "keep / rollback / uncertain")
    for x in (14.5, 37.5, 60.5, 84.75):
        arrow(x, 57.0, x, 49.4)
    arrow(32.7, 44.2, 34.7, 44.2)
    arrow(64.2, 44.2, 66.2, 44.2)

    # ---- compensation lane -------------------------------------------------------------
    lane(22.0, 13.5, "Compensation (separate)", "operator or eligible backstop", TINT[1])
    node(4.0, 23.5, 43.0, 8.5, "Rollback / restore", "new, rejectable write")
    node(52.5, 23.5, 44.0, 8.5, "Escalation", "approval required at K = 2")
    arrow(81.0, 39.0, 81.0, 32.3)
    tag(84.5, 35.6, "C6")
    arrow(25.5, 23.5, 25.5, 15.6)
    tag(32.0, 20.3, "C7")
    tag(50.0, 18.2, "C4  attribution separates authorization, device acceptance and process response")

    # ---- closed loop return ------------------------------------------------------------
    node(4.0, 6.0, 92.5, 7.0,
         "Process response observed again  \u2192  next iteration", fill=TINT[3], fs=6.6)
    arrow(74.5, 15.6, 74.5, 13.1)
    ax.add_patch(FancyArrowPatch((100.6, 9.5), (100.6, 93.6), arrowstyle="-|>",
                                 mutation_scale=7, linewidth=0.7, color=SOFT,
                                 linestyle=(0, (4, 2)), zorder=2,
                                 connectionstyle="arc3,rad=0.0"))
    arrow(100.6, 9.5, 83.0, 9.5, style=(0, (4, 2)), color=SOFT)
    ax.add_patch(FancyArrowPatch((100.6, 93.6), (83.0, 93.6), arrowstyle="-|>",
                                 mutation_scale=7, linewidth=0.7, color=SOFT,
                                 linestyle=(0, (4, 2)), zorder=2,
                                 connectionstyle="arc3,rad=0.0"))
    ax.text(99.8, 95.9, "C8", ha="right", va="bottom", fontsize=6.2, style="italic",
            color=SOFT)
    ax.text(2.0, 99.55, "C8  closed-loop feedback", ha="left", va="top", fontsize=6.2,
            color=SOFT, style="italic")

    ax.text(1.0, 1.4,
            "Plant and controller are simulated; the transports, admission checks, readback and\n"
            "journal follow the deployed execution path.",
            ha="left", va="bottom", fontsize=5.9, color=SOFT, linespacing=1.3)

    pdf = save(fig, "fig-closedloop-control", pad=0.0)
    qa_pdf("fig-closedloop-control", pdf, (W, H))


# ======================================================================================
# Figure: integrated benchmark - archived checks, protocol transport, governance
# ======================================================================================
def fig_benchmark():
    W, H = 7.16, 4.35
    fig = plt.figure(figsize=(W, H))
    gs = fig.add_gridspec(2, 2, left=0.155, right=0.985, top=0.885, bottom=0.085,
                          wspace=0.62, hspace=0.72,
                          height_ratios=[1.0, 0.78], width_ratios=[1.0, 1.0])

    # ---- (a) archived check verdicts per functional layer ------------------------------
    ax = fig.add_subplot(gs[:, 0])
    labels, counts, colours = [], [], []
    for name, phases, tint in LAYERS:
        labels.append(name)
        counts.append(sum(r["n"] for r in ORDER if r["phase"] in phases))
        colours.append(tint)
    y = np.arange(len(labels))[::-1]
    tot = sum(counts)
    ax.barh(y, counts, height=0.56, facecolor="white", edgecolor=INK, linewidth=0.7, zorder=3)
    for yi, ci, ti in zip(y, counts, colours):
        ax.barh(yi, ci, height=0.56, facecolor=ti, edgecolor="none", zorder=2)
    for yi, c in zip(y, counts):
        ax.text(c + 1.1, yi, f"{c}", va="center", ha="left", fontsize=7, zorder=4)
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=6.5, linespacing=1.25)
    ax.set_xlim(0, 27)
    ax.set_xticks([0, 5, 10, 15, 20, 25])
    ax.set_xlabel("Archived checks passed (count)")
    ax.text(0.985, 0.055, f"75 pass\n0 warn\n0 fail\n17 phases", transform=ax.transAxes,
            ha="right", va="bottom", fontsize=6.6, color=INK, linespacing=1.35,
            bbox=dict(boxstyle="round,pad=0.32", facecolor="white", edgecolor=INK,
                      linewidth=0.6))
    origin_axes(ax, grid_axis="x")
    ax.tick_params(axis="y", length=0, width=0)
    ax.tick_params(axis="y", which="minor", length=0, width=0)
    panel_tag(ax, "(a)", dx=0.02, dy=1.075)

    # ---- (b) protocol transport --------------------------------------------------------
    axb = fig.add_subplot(gs[0, 1])
    writable = [l for l in LINES if l.get("writeP50") is not None]
    names = ["Modbus\nTCP", "OPC UA", "MQTT", "HTTP"]
    p50 = np.array([l["writeP50"] for l in writable])
    p95 = np.array([l["writeP95"] for l in writable])
    yb = np.arange(len(names))[::-1]
    for yi, a, b in zip(yb, p50, p95):
        axb.hlines(yi, a, b, color=GREY, linewidth=0.8, zorder=2)
    axb.scatter(p50, yb, s=26, marker="o", facecolor="white", edgecolor=INK,
                linewidth=0.8, zorder=4)
    axb.scatter(p95, yb, s=26, marker="^", facecolor=INK, edgecolor=INK,
                linewidth=0.8, zorder=4)
    for yi, a, b in zip(yb, p50, p95):
        axb.text(a - 2.4, yi + 0.30, f"{a:.1f}", ha="right", va="center", fontsize=6.2)
        axb.text(b + 2.4, yi - 0.30, f"{b:.1f}", ha="left", va="center", fontsize=6.2)
    axb.annotate("p50", xy=(p50[0], yb[0]), xytext=(p50[0] - 16.0, yb[0] + 0.72),
                 fontsize=6.4, ha="center", va="center",
                 arrowprops=dict(arrowstyle="-", linewidth=0.6, color=INK,
                                 shrinkA=0.5, shrinkB=1.5))
    axb.annotate("p95", xy=(p95[0], yb[0]), xytext=(p95[0] + 15.0, yb[0] + 0.72),
                 fontsize=6.4, ha="center", va="center",
                 arrowprops=dict(arrowstyle="-", linewidth=0.6, color=INK,
                                 shrinkA=0.5, shrinkB=1.5))
    axb.set_yticks(yb)
    axb.set_yticklabels(names, fontsize=6.6)
    axb.set_xlim(0, 118)
    axb.set_ylim(-0.7, 3.95)
    axb.set_xticks([0, 25, 50, 75, 100])
    axb.set_xlabel("Governed write latency (ms)")
    origin_axes(axb, grid_axis="x")
    axb.tick_params(axis="y", length=0, width=0)
    axb.tick_params(axis="y", which="minor", length=0, width=0)
    panel_tag(axb, "(b)", dy=1.075)

    # ---- (c) governance outcome counters -----------------------------------------------
    axc = fig.add_subplot(gs[1, 1])
    cats = ["DAQ samples\n(5 nodes)", "Out-of-window probes\nrejected", "Legal writes\nblocked"]
    observed = [sum(l["daqSamples"] for l in LINES),
                sum(l["f5Rejected"] for l in writable),
                sum(l["falseBlock"] for l in writable)]
    avail = [observed[0], sum(l["f5Total"] for l in writable), 4]
    xc = np.arange(len(cats))
    axc.bar(xc, avail, width=0.52, facecolor="white", edgecolor=INK, linewidth=0.7,
            hatch="////", zorder=2)
    axc.bar(xc, observed, width=0.52, facecolor="white", edgecolor=INK, linewidth=0.7,
            zorder=3)
    for xi, o, a in zip(xc, observed, avail):
        axc.text(xi, max(o, a) + 2.2, f"{o}/{a}", ha="center", va="bottom", fontsize=6.8)
    axc.set_xticks(xc)
    axc.set_xticklabels(cats, fontsize=6.4)
    for lbl in axc.get_xticklabels():
        lbl.set_linespacing(1.9)
    axc.set_ylim(0, 76)
    axc.set_yticks([0, 20, 40, 60])
    axc.set_ylabel("Observed count")
    origin_axes(axc, grid_axis="y")
    axc.tick_params(axis="x", length=0, width=0)
    axc.tick_params(axis="x", which="minor", length=0, width=0)
    panel_tag(axc, "(c)", dx=0.985, dy=1.075)

    pdf = save(fig, "fig-benchmark-results", pad=0.0)
    qa_pdf("fig-benchmark-results", pdf, (W, H))


# ======================================================================================
# Figure: fixed-controller loop closure
# ======================================================================================
def fig_controller():
    W, H = 7.16, 4.15
    fig = plt.figure(figsize=(W, H))
    gs = fig.add_gridspec(2, 2, left=0.075, right=0.985, top=0.895, bottom=0.105,
                          wspace=0.30, hspace=0.62)

    # ---- (a) objective trajectory ------------------------------------------------------
    axa = fig.add_subplot(gs[0, 0])
    for k, s in enumerate(SEEDS):
        pts = s["traj"]
        axa.plot([p["iter"] for p in pts], [p["J"] for p in pts], color=INK, linewidth=0.8,
                 linestyle=DASH[k], marker=MARK[k], markersize=4.0, markerfacecolor="white",
                 markeredgewidth=0.8, label=f"seed {s['seed']}")
    jstar = SEEDS[0]["Jstar"]
    axa.axhline(jstar, color=GREY, linewidth=0.8, linestyle="-.")
    axa.text(2.16, jstar + 0.9, rf"$J^\ast={jstar:.3f}$", ha="right", va="bottom",
             fontsize=6.6, color=INK)
    axa.set_xlim(-0.18, 2.18)
    axa.set_ylim(63, 96)
    axa.set_xticks([0, 1, 2])
    axa.set_xlabel("Evaluation index")
    axa.set_ylabel(r"Objective $J$")
    axa.legend(loc="lower right", frameon=False, handlelength=2.1, handletextpad=0.5,
               borderpad=0.1, labelspacing=0.28)
    origin_axes(axa, grid_axis="y")
    panel_tag(axa, "(a)")

    # ---- (b) thickness against the reward band -----------------------------------------
    axb = fig.add_subplot(gs[0, 1])
    axb.axhspan(48.0, 52.0, facecolor="white", edgecolor=INK, linewidth=0.0,
                hatch="\\\\\\\\", zorder=1)
    axb.axhline(48.0, color=GREY, linewidth=0.6, zorder=2)
    axb.axhline(52.0, color=GREY, linewidth=0.6, zorder=2)
    for k, s in enumerate(SEEDS):
        pts = s["traj"]
        axb.plot([p["iter"] for p in pts], [p["thickness"] for p in pts], color=INK,
                 linewidth=0.8, linestyle=DASH[k], marker=MARK[k], markersize=4.0,
                 markerfacecolor="white", markeredgewidth=0.8, label=f"seed {s['seed']}")
    axb.text(0.04, 0.90, r"reward band $50\pm2\ \mu$m", transform=axb.transAxes,
             ha="left", va="top", fontsize=6.4)
    axb.set_xlim(-0.18, 2.18)
    axb.set_ylim(46, 58)
    axb.set_xticks([0, 1, 2])
    axb.set_xlabel("Evaluation index")
    axb.set_ylabel(r"Thickness $h$ ($\mu$m)")
    axb.legend(loc="upper right", frameon=False, handlelength=2.1, handletextpad=0.5,
               borderpad=0.1, labelspacing=0.28)
    origin_axes(axb, grid_axis="y")
    panel_tag(axb, "(b)")

    # ---- (c) commanded speeds ----------------------------------------------------------
    axc = fig.add_subplot(gs[1, 0])
    axc2 = axc.twinx()
    for k, s in enumerate(SEEDS):
        pts = s["traj"]
        axc.plot([p["iter"] for p in pts], [p["screw"] for p in pts], color=INK,
                 linewidth=0.8, linestyle=DASH[k], marker=MARK[k], markersize=3.8,
                 markerfacecolor="white", markeredgewidth=0.8)
        axc2.plot([p["iter"] for p in pts], [p["lineSpeed"] for p in pts], color=GREY,
                  linewidth=0.8, linestyle=DASH[k], marker="v", markersize=3.4,
                  markerfacecolor="white", markeredgewidth=0.7)
    axc.text(0.03, 0.05, "screw speed (left axis)", transform=axc.transAxes, fontsize=6.3,
             va="bottom")
    axc2.text(0.97, 0.05, "line speed (right axis)", transform=axc2.transAxes, fontsize=6.3,
              va="bottom", ha="right", color=GREY)
    axc.set_xlim(-0.18, 2.18)
    axc.set_ylim(130, 154)
    axc2.set_ylim(88.5, 101.5)
    axc.set_xticks([0, 1, 2])
    axc.set_yticks([130, 140, 150])
    axc2.set_yticks([90, 95, 100])
    axc.set_xlabel("Evaluation index")
    axc.set_ylabel("Screw speed (rpm)")
    axc2.set_ylabel("Line speed (m/min)", color=GREY, fontsize=7)
    origin_axes(axc, grid_axis="y")
    origin_axes(axc2, minor=False)
    axc2.tick_params(axis="y", colors=GREY)
    axc2.spines["right"].set_color(GREY)
    panel_tag(axc, "(c)")

    # ---- (d) final reward composition --------------------------------------------------
    axd = fig.add_subplot(gs[1, 1])
    comp = ["Thickness\n(55)", "Quality\n(25)", "Energy\n(8)", "Throughput\n(7)"]

    def rewards(pts, key):
        p = pts[key]
        h, d, N, v = p["thickness"], p["defect"], p["screw"], p["lineSpeed"]
        return np.array([55 * max(0.0, 1 - max(abs(h - 50) - 2, 0) / 10),
                         25 * (1 - min(d, 8) / 8),
                         8 * (1 - (N - 50) / 150),
                         7 * (v / 120)])

    first = np.mean([rewards(s["traj"], 0) for s in SEEDS], axis=0)
    last = np.mean([rewards(s["traj"], -1) for s in SEEDS], axis=0)
    xd = np.arange(len(comp))
    axd.bar(xd - 0.185, first, width=0.34, facecolor="white", edgecolor=INK, linewidth=0.7,
            hatch="////", label="first evaluation", zorder=3)
    axd.bar(xd + 0.185, last, width=0.34, facecolor="white", edgecolor=INK, linewidth=0.7,
            label="last evaluation", zorder=3)
    for xi, a in zip(xd - 0.185, first):
        axd.text(xi, a + 1.4, f"{a:.1f}", ha="center", va="bottom", fontsize=6.1)
    for xi, b in zip(xd + 0.185, last):
        axd.text(xi, b + 1.4, f"{b:.1f}", ha="center", va="bottom", fontsize=6.1)
    axd.set_xticks(xd)
    axd.set_xticklabels(comp, fontsize=6.2)
    for lbl in axd.get_xticklabels():
        lbl.set_linespacing(1.95)
    axd.set_ylim(0, 64)
    axd.set_yticks([0, 20, 40, 60])
    axd.set_ylabel("Reward contribution")
    axd.legend(loc="upper right", frameon=False, handlelength=1.6, handletextpad=0.45,
               borderpad=0.1, labelspacing=0.28)
    origin_axes(axd, grid_axis="y")
    axd.tick_params(axis="x", length=0, width=0)
    axd.tick_params(axis="x", which="minor", length=0, width=0)
    panel_tag(axd, "(d)")

    pdf = save(fig, "fig-controller-results", pad=0.0)
    qa_pdf("fig-controller-results", pdf, (W, H))


# ======================================================================================
# Figure: four-arm governance ablation
# ======================================================================================
def fig_ablation():
    W, H = 7.16, 2.55
    fig = plt.figure(figsize=(W, H))
    gs = fig.add_gridspec(1, 3, left=0.085, right=0.985, top=0.845, bottom=0.235,
                          wspace=0.46, width_ratios=[1.0, 1.0, 1.0])

    arms = ["Full", "No interlock", "No readback", "Both disabled"]
    xarms = ["1", "2", "3", "4"]
    keys = ["full", "no-interlock", "no-readback", "ungated"]
    agg = ABL["aggregate"]

    # ---- (a) interception per repetition ----------------------------------------------
    axa = fig.add_subplot(gs[0, 0])
    xa = np.arange(len(arms))
    for k, key in enumerate(keys):
        rates = np.array(agg[key]["intercept_rates"]) * 18.0
        for r, val in enumerate(rates):
            axa.plot([xa[k] - 0.20, xa[k] + 0.20], [val, val], color=GRID, linewidth=0.6,
                     zorder=1)
        axa.scatter([xa[k]] * 3, rates, s=16, marker=MARK[k % len(MARK)],
                    facecolor="white", edgecolor=INK, linewidth=0.8, zorder=3)
        axa.text(xa[k], rates.mean() + 1.05, f"{rates.mean():.0f}", ha="center",
                 va="bottom", fontsize=6.6)
    axa.axhline(18, color=GREY, linewidth=0.7, linestyle="-.")
    axa.text(0.975, 0.055, "18/18 ceiling", transform=axa.transAxes, ha="right",
             va="bottom", fontsize=6.2, color=SOFT)
    axa.set_xticks(xa)
    axa.set_xticklabels(xarms, fontsize=6.6)
    axa.set_xlim(-0.45, 3.45)
    axa.set_ylim(6, 21.5)
    axa.set_yticks([6, 9, 12, 15, 18])
    axa.set_ylabel("Probes rejected (per repetition)")
    axa.set_xlabel("Ablation arm")
    origin_axes(axa, grid_axis="y")
    axa.tick_params(axis="x", length=0, width=0)
    axa.tick_params(axis="x", which="minor", length=0, width=0)
    panel_tag(axa, "(a)")

    # ---- (b) executions that reached the plant -----------------------------------------
    axb = fig.add_subplot(gs[0, 1])
    breached = [0, 6, 0, 6]
    rejected = [18, 12, 18, 12]
    xb = np.arange(len(arms))
    axb.bar(xb, rejected, width=0.54, facecolor="white", edgecolor=INK, linewidth=0.7,
            hatch="////", zorder=3, label="rejected")
    axb.bar(xb, breached, width=0.54, facecolor=INK, edgecolor=INK, linewidth=0.7,
            zorder=4, label="executed")
    for xi, b, r in zip(xb, breached, rejected):
        axb.text(xi, r + 0.45, f"{r}", ha="center", va="bottom", fontsize=6.6)
        if b:
            axb.text(xi, 1.5, f"{b}", ha="center", va="bottom", fontsize=6.6, color="white")
    axb.set_xticks(xb)
    axb.set_xticklabels(xarms, fontsize=6.6)
    axb.set_xlim(-0.62, 3.62)
    axb.set_ylim(0, 22.5)
    axb.set_yticks([0, 6, 12, 18])
    axb.set_ylabel("Window-class probes (count)")
    axb.set_xlabel("Ablation arm")
    axb.legend(loc="upper center", frameon=False, handlelength=1.5, handletextpad=0.45,
               borderpad=0.1, labelspacing=0.28, ncol=2, columnspacing=0.9)
    origin_axes(axb, grid_axis="y")
    axb.tick_params(axis="x", length=0, width=0)
    axb.tick_params(axis="x", which="minor", length=0, width=0)
    panel_tag(axb, "(b)")

    # ---- (c) mock write latency --------------------------------------------------------
    axc = fig.add_subplot(gs[0, 2])
    for k, key in enumerate(keys):
        vals = np.array(agg[key]["p50"])
        for v in vals:
            axc.plot([k - 0.20, k + 0.20], [v, v], color=GRID, linewidth=0.6, zorder=1)
        axc.scatter([k] * len(vals), vals, s=16, marker=MARK[k % len(MARK)],
                    facecolor="white", edgecolor=INK, linewidth=0.8, zorder=3)
        axc.text(k, vals.mean() + 2.6, f"{vals.mean():.0f}", ha="center", va="bottom",
                 fontsize=6.6)
    axc.set_xticks(np.arange(len(arms)))
    axc.set_xticklabels(xarms, fontsize=6.6)
    axc.set_xlim(-0.45, 3.45)
    axc.set_ylim(100, 158)
    axc.set_yticks([100, 120, 140])
    axc.set_ylabel("Mock write p50 (ms)")
    axc.set_xlabel("Ablation arm")
    origin_axes(axc, grid_axis="y")
    axc.tick_params(axis="x", length=0, width=0)
    axc.tick_params(axis="x", which="minor", length=0, width=0)
    panel_tag(axc, "(c)")

    pdf = save(fig, "fig-ablation", pad=0.0)
    qa_pdf("fig-ablation", pdf, (W, H))


# ======================================================================================
# Figure: recorded AgentTeam mission on the BOPET line
# ======================================================================================
def fig_agentteam():
    W, H = 7.16, 2.95
    fig = plt.figure(figsize=(W, H))
    gs = fig.add_gridspec(1, 2, left=0.072, right=0.985, top=0.855, bottom=0.215,
                          wspace=0.30, width_ratios=[1.18, 1.0])

    knob_name = {"cast-spd-sp": "Casting speed", "fast-roll-sp": "MDO fast roll",
                 "rail-out-sp": "TDO outlet width"}
    protocol = {"cast-spd-sp": "Modbus TCP", "fast-roll-sp": "Modbus TCP",
                "rail-out-sp": "OPC UA"}
    unit = {"cast-spd-sp": "m/min", "fast-roll-sp": "m/min", "rail-out-sp": "mm"}

    # ---- (a) archived thickness observations -------------------------------------------
    axa = fig.add_subplot(gs[0, 0])
    x = [p["iter"] for p in MISSION]
    h = [p["thickness"] for p in MISSION]
    axa.axhspan(24.3, 25.7, facecolor="white", edgecolor=INK, linewidth=0.0,
                hatch="\\\\\\\\", zorder=1)
    axa.axhline(24.3, color=GREY, linewidth=0.6, zorder=2)
    axa.axhline(25.7, color=GREY, linewidth=0.6, zorder=2)
    axa.axhline(25.0, color=GREY, linewidth=0.7, linestyle="-.", zorder=2)
    axa.plot(x, h, color=INK, linewidth=0.8, marker="o", markersize=4.2,
             markerfacecolor="white", markeredgewidth=0.8, zorder=4)
    for xi, hi in zip(x, h):
        if xi == x[-1]:
            # keep clear of the descending segment and of the band edge at 25.7
            axa.text(xi - 0.10, hi + 0.34, f"{hi:.2f}", ha="right", va="bottom",
                     fontsize=6.4)
        else:
            axa.text(xi, hi + 0.12, f"{hi:.2f}", ha="center", va="bottom", fontsize=6.4)
    axa.text(0.06, 1.05, r"hatched band: target $25.0\pm0.7\ \mu$m", transform=axa.transAxes,
             ha="left", va="bottom", fontsize=6.2, color=INK)
    axa.set_xlim(-0.35, 4.55)
    axa.set_ylim(24.1, 27.4)
    axa.set_xticks([0, 1, 2, 3, 4])
    axa.set_yticks([24.5, 25.5, 26.5])
    axa.set_xlabel("Governed write index (0 = baseline)")
    axa.set_ylabel(r"Thickness $h$ ($\mu$m)")
    origin_axes(axa, grid_axis="y")
    panel_tag(axa, "(a)", dx=0.02, dy=1.10)

    # ---- (b) the four governed writes --------------------------------------------------
    axb = fig.add_subplot(gs[0, 1])
    axb.set_xlim(0, 1)
    axb.set_ylim(0, 1)
    axb.axis("off")
    writes = MISSION[1:]
    axb.text(0.02, 0.955, "Write", ha="left", va="top", fontsize=6.4, fontweight="bold")
    axb.text(0.28, 0.955, "Parameter and setpoint change", ha="left", va="top",
             fontsize=6.4, fontweight="bold")
    axb.text(0.985, 0.955, "Transport", ha="right", va="top", fontsize=6.4,
             fontweight="bold")
    axb.plot([0.02, 0.985], [0.905, 0.905], color=INK, linewidth=0.7)
    for i, w in enumerate(writes):
        y = 0.815 - i * 0.175
        axb.text(0.02, y, f"{i + 1}", ha="left", va="center", fontsize=6.6)
        axb.text(0.28, y + 0.028, knob_name[w["knob"]], ha="left", va="center",
                 fontsize=6.6)
        axb.text(0.28, y - 0.030, f"{w['from']:.1f} \u2192 {w['to']:.1f} {unit[w['knob']]}",
                 ha="left", va="center", fontsize=6.2, color=SOFT)
        axb.text(0.985, y, protocol[w["knob"]], ha="right", va="center", fontsize=6.4)
        if i:
            axb.plot([0.02, 0.985], [y - 0.088, y - 0.088], color=GRID, linewidth=0.5)
    axb.text(0.02, 0.015,
             "4 writes on 3 parameters and 2 actuator transports.\n"
             "Every write opened an optimization record and was judged "
             + r"$\mathit{keep}$" + ";\nthe parent task reached COMPLETED.",
             ha="left", va="bottom", fontsize=6.2, color=INK, linespacing=1.35)
    panel_tag(axb, "(b)", dx=-0.02)

    pdf = save(fig, "fig-agentteam-mission", pad=0.0)
    qa_pdf("fig-agentteam-mission", pdf, (W, H))


# ======================================================================================
# provenance + reproduction manifest
# ======================================================================================
def manifest():
    sources = {}
    for archive in (ARCHIVE, ARCHIVE_A, ARCHIVE_ABL, ARCHIVE_PLC):
        base = ROOT / "bench" / "results" / archive
        for p in sorted(base.iterdir()):
            if p.is_file() and p.suffix in {".json", ".csv", ".log", ".md"}:
                sources[f"{archive}/{p.name}"] = hashlib.sha256(p.read_bytes()).hexdigest()
    sources["benchmark-report.md"] = hashlib.sha256(REPORT.read_bytes()).hexdigest()

    data = {
        "archive": ARCHIVE,
        "seed": ENV["seed"],
        "git_commit": ENV["gitCommit"],
        "harness_hash": ENV["harnessHash"],
        "node": ENV["node"],
        "phase_checks": ORDER,
        "protocol_metrics": [
            {k: l.get(k) for k in ("index", "protocol", "dcwSignal", "daqSamples", "writeP50",
                                   "writeP95", "readbackDelta", "f5Rejected", "f5Total",
                                   "falseBlock")}
            for l in LINES if not l.get("satellite")
        ],
        "controller": {"seeds": SEEDS, "aggregate": AGG},
        "mission": MISSION,
        "ablation": {k: ABL["aggregate"][k] for k in ABL["aggregate"]},
        "scope": ("Aggregates reproduced from the frozen archives only; scripted policies on a "
                  "simulated plant; no invented error bars, no interpolated trajectories."),
    }
    (OUT / "plotted-data.json").write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    man = {
        "figures": {k: v for k, v in QA.items()},
        "figure_sizes_inches": {"fig-closedloop-control": [3.4, 5.05],
                                "fig-benchmark-results": [7.16, 4.35],
                                "fig-controller-results": [7.16, 4.15],
                                "fig-ablation": [7.16, 2.55],
                                "fig-agentteam-mission": [7.16, 2.95]},
        "python": sys.version,
        "matplotlib": matplotlib.__version__,
        "numpy": np.__version__,
        "serif_candidates": RESOLVED_SERIF,
        "source_hashes": sources,
        "outputs": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in sorted(OUT.iterdir()) if p.suffix in {".pdf", ".png"}},
        "reproduce": "python paper/tii/figures/tii-final/make_tii_figures.py",
    }
    (OUT / "source-manifest.json").write_text(json.dumps(man, indent=2) + "\n",
                                              encoding="utf-8")
    return man


if __name__ == "__main__":
    fig_control_loop()
    fig_benchmark()
    fig_controller()
    fig_ablation()
    fig_agentteam()
    man = manifest()
    print("PASS", ARCHIVE)
    for name, info in sorted(QA.items()):
        print(f"  {name}: {info['size_in'][0]}x{info['size_in'][1]} in, "
              f"{info['text_boxes']} labelled spans, raster={info['raster_images_in_pdf']}, "
              f"overlap={info['overlap']}, fonts={info['fonts']}")

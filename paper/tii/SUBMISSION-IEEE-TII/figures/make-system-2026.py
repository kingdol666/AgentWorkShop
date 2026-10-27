"""Exact-size vector mechanisms for the revised industrial-informatics paper.

Run with the established Python environment. No experiment data are generated.
The interval values are the archived admission drill, not a new trial. All
other panels describe implementation semantics and use no measured values.
"""
from pathlib import Path
import argparse
import json
import subprocess
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import (FancyArrowPatch, FancyBboxPatch, Polygon,
                                Rectangle, Circle, Ellipse)
import pymupdf as fitz
from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "resources"
REVISION = HERE.parent.parent / "revision-2026-10-25"
QA = REVISION / "qa"
SKILL = Path.home() / ".codex" / "skills" / "nature-figure"
sys.path.insert(0, str(SKILL / "scripts"))
from audit_panel_alignment import require_matplotlib_panel_alignment

INK = "#202A34"
GRAY = "#5F6872"
RULE = "#B3BDC6"
BLUE = "#294F6B"
TEAL = "#26756F"
GOLD = "#9A650F"
PALE_BLUE = "#EDF3F7"
PALE_TEAL = "#EEF5F3"
PALE_GOLD = "#F9F3E8"

plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans"],
    "font.size": 9,
    "svg.fonttype": "none",
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    "axes.linewidth": 0.6,
    "lines.linewidth": 0.8,
    "savefig.facecolor": "white",
})


def canvas(width, height):
    fig = plt.figure(figsize=(width, height), facecolor="white")
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set(xlim=(0, width * 72), ylim=(0, height * 72))
    ax.set_axis_off()
    return fig, ax


def text(ax, x, y, value, *, color=INK, bold=False, ha="left", va="center", size=9):
    return ax.text(x, y, value, fontsize=size, color=color, ha=ha, va=va,
                   fontweight="bold" if bold else "normal", linespacing=1.2,
                   fontfamily=["Arial", "DejaVu Sans"])


def box(ax, x, y, width, height, *, fill="white", edge=RULE):
    ax.add_patch(Rectangle((x, y), width, height, facecolor=fill,
                           edgecolor=edge, linewidth=0.6))


def arrow(ax, start, end, *, color=GRAY, dashed=False, points=None):
    if points:
        xs, ys = zip(start, *points, end)
        ax.plot(xs[:-1], ys[:-1], color=color, lw=0.8,
                linestyle=(0, (3, 2)) if dashed else "-", solid_capstyle="butt")
        start = points[-1]
    ax.add_patch(FancyArrowPatch(start, end, arrowstyle="-|>",
                                mutation_scale=7, linewidth=0.8,
                                linestyle=(0, (3, 2)) if dashed else "-",
                                color=color, shrinkA=0, shrinkB=0))


def gap_arrow(ax, start, end, *, color=GRAY, dashed=False):
    """Draw a compact arrow that stays inside the whitespace between boxes."""
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = (dx * dx + dy * dy) ** 0.5
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    line_start = (start[0] + 1.5 * ux, start[1] + 1.5 * uy)
    base = (end[0] - 5.0 * ux, end[1] - 5.0 * uy)
    tip = (end[0] - 1.2 * ux, end[1] - 1.2 * uy)
    ax.plot([line_start[0], base[0]], [line_start[1], base[1]],
            color=color, lw=0.7, solid_capstyle="butt",
            linestyle=(0, (2, 1.4)) if dashed else "-")
    ax.add_patch(Polygon(
        [tip, (base[0] + 2.0 * px, base[1] + 2.0 * py),
         (base[0] - 2.0 * px, base[1] - 2.0 * py)],
        closed=True, facecolor=color, edgecolor=color, linewidth=0.3))


def save(fig, name, *, panels=None):
    stem = QA / f"system-{name}"
    options = {}
    if panels:
        options = {"axes": panels, "panel_ids": ["a", "b"],
                   "row_groups": [["a", "b"]]}
    require_matplotlib_panel_alignment(
        fig, json_out=f"{stem}.alignment.json",
        overlay_svg=f"{stem}.alignment.svg", tolerance_pt=1.5,
        gutter_tolerance_pt=1.5, require_panel_labels=bool(panels),
        strict=True, **options,
    )
    # Do not crop: the MediaBox must equal the exact final physical dimensions.
    fig.savefig(OUT / f"fig-{name}.pdf", metadata={
        "Title": name.replace("-2026", "").replace("-", " "),
        "Author": "", "Subject": "Supervisory system mechanism",
        "Creator": "Matplotlib", "Keywords": "",
    })
    svg_path = OUT / f"fig-{name}.svg"
    fig.savefig(svg_path)
    # Matplotlib emits SVG path data with insignificant trailing spaces;
    # strip them so generated source assets pass repository whitespace checks.
    svg_lines = svg_path.read_text(encoding="utf-8").splitlines()
    svg_path.write_text("\n".join(line.rstrip() for line in svg_lines) + "\n",
                        encoding="utf-8")
    fig.savefig(OUT / f"fig-{name}.eps")
    fig.savefig(OUT / f"fig-{name}.png", dpi=600)
    # Keep the QA preview at publication-grade raster density; the manuscript
    # consumes the vector PDF, while this preview is used for physical-size QA.
    fig.savefig(QA / f"system-{name}.final-size.png", dpi=300)
    with Image.open(QA / f"system-{name}.final-size.png") as preview:
        preview.convert("L").save(QA / f"system-{name}.grayscale.png")
    plt.close(fig)


def architecture():
    """Compact architecture with distinct entry paths and owned records."""
    fig, ax = canvas(7.16, 3.58)
    BLUE_E, GOLD_E, TEAL_E = "#2B5673", "#9A650F", "#226E68"
    F_BLUE, F_GOLD, F_TEAL = "#EFF5F9", "#FBF5E8", "#EEF6F4"

    def txt(x, y, s, *, color=INK, bold=False, ha="center", va="center",
            size=9):
        ax.text(x, y, s, fontsize=size, color=color, ha=ha, va=va,
                fontweight="bold" if bold else "normal",
                linespacing=1.15, fontfamily=["Arial", "DejaVu Sans"], zorder=6)

    def card(x0, x1, y0, y1, *, edge, fill="white"):
        ax.add_patch(Rectangle((x0, y0), x1 - x0, y1 - y0,
                               facecolor=fill, edgecolor=edge,
                               linewidth=0.65, zorder=3))

    def node(x0, x1, y0, y1, heading, detail, *, edge, fill="white",
             detail2=None):
        card(x0, x1, y0, y1, edge=edge, fill=fill)
        cx = (x0 + x1) / 2
        if detail2 is None:
            txt(cx, y0 + (y1 - y0) * 0.68, heading,
                bold=True, color=edge)
            txt(cx, y0 + (y1 - y0) * 0.32, detail)
        else:
            txt(cx, y1 - 9, heading, bold=True, color=edge)
            txt(cx, y0 + 18, detail)
            txt(cx, y0 + 8, detail2, color=GRAY)

    # Context and scene configuration ground the task path; live route state
    # is resolved again by the operation handler.
    ax.add_patch(Rectangle((17, 216), 365, 35, facecolor=F_TEAL,
                           edgecolor="none", zorder=1))
    node(21, 381, 219, 248, "Production context + scene blueprint",
         "line / product / recipe / run · signals · objectives · guards",
         edge=TEAL_E, fill="white")

    # Task/chat uses the collaboration and harness path. Direct operation
    # invocation bypasses that path and enters the shared dispatcher.
    node(21, 194, 179, 207, "Task / chat route",
         "CLI · web · SDK · MCP tasks",
         edge=BLUE_E, fill=F_BLUE)
    node(205, 381, 179, 207, "Direct operation route",
         "REST · selected stdio MCP operations",
         edge=GOLD_E, fill=F_GOLD)

    node(21, 381, 132, 166, "Shared per-call dispatcher",
         "scope + policy; grant / binding as needed",
         edge=GOLD_E, fill=F_GOLD)

    node(21, 194, 91, 121, "Read / analysis services",
         "DAQ · MES · retrieval · models",
         edge=TEAL_E, fill=F_TEAL)
    node(205, 381, 91, 121, "Write / recipe services",
         "context · conditional approval · DCW",
         edge=TEAL_E, fill=F_TEAL)

    node(21, 174, 47, 76, "Semantic DAQ / DCW nodes",
         "typed sensing · bounded writes",
         edge=BLUE_E, fill=F_BLUE)
    node(195, 381, 42, 81, "Configured protocol drivers",
         "e.g., OPC UA · MQTT · Modbus",
         edge=BLUE_E, fill=F_BLUE, detail2="plant / simulator")

    # Solid arrows show execution; dashed arrows show context supplied to the
    # task path, not a task-pinned authorization token.
    gap_arrow(ax, (106, 219), (106, 207), color=TEAL, dashed=True)
    gap_arrow(ax, (106, 179), (106, 166), color=BLUE)
    gap_arrow(ax, (294, 179), (294, 166), color=GOLD)
    gap_arrow(ax, (106, 132), (106, 121), color=TEAL)
    gap_arrow(ax, (294, 132), (294, 121), color=TEAL)
    # Route both service connections through the open gutter.  Orthogonal
    # bends keep the write connection clear of the protocol-driver card.
    gap_arrow(ax, (106, 91), (106, 76), color=TEAL)
    arrow(ax, (294, 91), (151, 76), color=TEAL,
          points=[(294, 86), (151, 86)])
    gap_arrow(ax, (174, 61.5), (195, 61.5), color=BLUE)
    txt(199, 26, "Independent PLC / safety-instrumented system (SIS) protection is external",
        size=9, color=GRAY)

    # Evidence stays with the service that owns each lifecycle. The panel is a
    # sidecar, not a generic record envelope.
    card(395, 512, 6, 248, edge=RULE, fill="#F8FAFB")
    txt(453.5, 235, "Service-owned evidence", bold=True, color=BLUE)
    txt(453.5, 222, "separate record types", color=GRAY)
    records = [
        (196, "Task: task / approval"),
        (173, "DCW: ACK / readback"),
        (150, "DAQ: observations"),
        (127, "Analysis: summaries"),
        (104, "Recipe: versions"),
    ]
    for y, label in records:
        ax.add_patch(Circle((408, y), 1.7, facecolor=BLUE,
                            edgecolor="none", zorder=5))
        txt(416, y, label, ha="left", size=9)
    ax.plot([405, 502], [85, 85], color="#E3E8EC", lw=0.6, zorder=2)
    txt(453.5, 68, "Joined by actor / context IDs", color=GRAY)
    txt(453.5, 55, "when available", color=GRAY)
    txt(453.5, 35, "Command and process", color=GRAY)
    txt(453.5, 22, "remain separate", color=GRAY)
    save(fig, "architecture-2026-9pt")


def runtime():
    """Task flow from prompt context and registered tools through dispatch."""
    fig, ax = canvas(7.16, 3.55)
    F_BLUE, F_GOLD, F_TEAL = PALE_BLUE, PALE_GOLD, PALE_TEAL

    def node(x, y, w, h, heading, detail, *, fill="white", edge=BLUE):
        box(ax, x, y, w, h, fill=fill, edge=edge)
        text(ax, x + w / 2, y + h * 0.67, heading, color=edge,
             bold=True, ha="center", size=9)
        text(ax, x + w / 2, y + h * 0.31, detail, color=INK,
             ha="center", size=9)

    # The scoped catalog is provisioned with the adapter and refreshed through
    # supported registry updates; each returned call is rechecked at dispatch.
    node(17, 202, 132, 39, "Task / chat entry",
         "channel task · chat message", fill=F_BLUE)
    node(164, 202, 150, 39, "Turn context / tool catalog",
         "context/turn · catalog setup/refresh", fill=F_BLUE)
    node(329, 202, 145, 39, "Harness + agent turn",
         "registered adapter · named request", fill=F_BLUE)
    gap_arrow(ax, (149, 221.5), (164, 221.5), color=BLUE)
    gap_arrow(ax, (314, 221.5), (329, 221.5), color=BLUE)

    # The handler-specific route may perform reads before refusing a write.
    node(161, 158, 193, 30, "Per-call dispatch gate",
         "scope + policy; grant / binding as needed", fill=F_GOLD, edge=GOLD)
    arrow(ax, (401.5, 202), (324, 188), color=GOLD,
          points=[(401.5, 195), (324, 195)])
    ax.add_patch(Polygon([(257.5, 150), (293, 136), (257.5, 122), (222, 136)],
                         closed=True, facecolor=F_GOLD, edgecolor=GOLD,
                         linewidth=0.6))
    text(ax, 257.5, 136, "Route?", color=GOLD, bold=True, ha="center", size=9)
    gap_arrow(ax, (257.5, 158), (257.5, 150), color=GOLD)

    # Route-specific handlers share the return and evidence path.
    node(19, 80, 213, 37, "Read / analysis route",
         "DAQ · MES · retrieval · model services", fill=F_TEAL, edge=TEAL)
    node(276, 80, 213, 37, "Write / recipe route",
         "conditional approval recheck · DCW driver", fill=F_TEAL, edge=TEAL)
    arrow(ax, (222, 136), (125.5, 117), color=TEAL,
          points=[(125.5, 136)])
    arrow(ax, (293, 136), (382.5, 117), color=TEAL,
          points=[(382.5, 136)])

    node(105, 26, 305, 33, "Tool result → harness continuation",
         "host text · optional error flag", fill=F_BLUE)
    arrow(ax, (125.5, 80), (205, 59), color=TEAL,
          points=[(125.5, 69), (205, 69)])
    arrow(ax, (382.5, 80), (310, 59), color=TEAL,
          points=[(382.5, 69), (310, 69)])
    # The result returns to the active adapter turn; the runner can then
    # continue the task or close it after the harness returns its result.
    arrow(ax, (410, 42.5), (474, 221.5), color=BLUE,
          points=[(500, 42.5), (500, 221.5)])
    save(fig, "runtime-2026-9pt")


def admission_hitl():
    width, height = 7.16, 2.45
    fig = plt.figure(figsize=(width, height), facecolor="white")
    axes = []
    for x in (0.04, 3.68):
        ax = fig.add_axes([x / width, 0.015 / height, 3.44 / width, 2.42 / height])
        ax.set(xlim=(0, 3.44 * 72), ylim=(0, 2.42 * 72))
        ax.set_axis_off()
        axes.append(ax)
    a, b = axes
    for ax, letter, title in [(a, "a", "Source-aware admission"),
                              (b, "b", "Approval and recheck")]:
        text(ax, 2, 167, letter, bold=True)
        text(ax, 17, 167, title, bold=True)

    # Illustrative interval example. Hard limits use their complete own scale.
    lo, hi = 146.22, 153.78
    text(a, 2, 153, "I = H ∩ B ∩ P ∩ R = [146.22,153.78] rpm", color=TEAL)
    text(a, 2, 131, "H hard")
    full = lambda value: 75 + (value - 50) / 150 * 164
    box(a, full(50), 128, full(200) - full(50), 6, fill=PALE_BLUE, edge=BLUE)
    a.add_patch(Rectangle((full(lo), 128), full(hi) - full(lo), 6,
                          facecolor=TEAL, edgecolor=TEAL, lw=0.5))
    text(a, full(50), 118, "50", ha="center")
    text(a, full(200), 118, "200 rpm", ha="right")
    text(a, 75, 105, "Detail scale: 140–160 rpm", color=GRAY)
    zoom = lambda value: 75 + (value - 140) / 20 * 164
    # The common admissible band is a geometry aid, not uncertainty.
    a.add_patch(Rectangle((zoom(lo), 28), zoom(hi) - zoom(lo), 68,
                          facecolor=PALE_TEAL, edgecolor="none"))
    for value in (lo, hi):
        a.plot([zoom(value), zoom(value)], [28, 96], color=TEAL,
               lw=0.6, ls=(0, (3, 2)))
    layers = [("B baseline", "143.7–156.3", 143.7, 156.3, 87, BLUE),
              ("P product", "146.22–153.78", lo, hi, 64, TEAL),
              ("R recipe", "141–159", 141, 159, 41, GOLD)]
    for label, interval, start, stop, y, color in layers:
        text(a, 2, y + 3, label)
        text(a, 2, y - 8, interval, color=GRAY)
        a.add_patch(Rectangle((zoom(start), y - 3), zoom(stop) - zoom(start), 6,
                              facecolor=color, edgecolor=color, lw=0.5))
    a.plot([zoom(140), zoom(160)], [25, 25], color=GRAY, lw=0.6)
    for value in (140, 150, 160):
        x = zoom(value)
        a.plot([x, x], [25, 22], color=GRAY, lw=0.6)
        text(a, x, 16, str(value), ha="center")
    # Symbolic fields avoid fabricating current UI state or measurements.
    text(b, 2, 153, "Symbolic schematic; no measured values", color=GRAY)
    box(b, 2, 44, 239, 98, edge=RULE)
    text(b, 10, 132, "Line / recipe binding + active run", bold=True)
    b.plot([10, 233], [121, 121], color=RULE, lw=0.5)
    text(b, 10, 111, "Parameter")
    text(b, 123, 111, "Current")
    text(b, 183, 111, "Proposed")
    text(b, 10, 95, "Control u", bold=True)
    text(b, 123, 95, "u(now)")
    text(b, 183, 95, "u(next)", bold=True)
    text(b, 10, 77, "Reason / hypothesis + execution context")
    for x, label, color, fill in [(10, "Approve", TEAL, PALE_TEAL),
                                   (123, "Decline", GOLD, PALE_GOLD)]:
        box(b, x, 50, 100, 17, fill=fill, edge=color)
        text(b, x + 50, 58.5, label, ha="center", color=color, bold=True)
    text(b, 2, 37, "Approve → recheck grants, binding and context", color=TEAL)
    text(b, 2, 24, "Then admission → dispatch; failure → no dispatch")
    text(b, 2, 11, "Decline → no dispatch; decision is recorded", color=GOLD)
    save(fig, "admission-hitl-2026", panels=axes)


def run_audits(names):
    source_check = subprocess.run([
        sys.executable, str(SKILL / "scripts" / "validate_figure.py"),
        str(Path(__file__).resolve()), "--json",
    ], text=True, capture_output=True)
    (QA / "system-source-validation.json").write_text(source_check.stdout, encoding="utf-8")
    report = {}
    for name in names:
        pdf = OUT / f"fig-{name}.pdf"
        stem = QA / f"system-{name}"
        text_check = subprocess.run([
            sys.executable, str(SKILL / "scripts" / "audit_pdf_text.py"),
            str(pdf), "--min-pt", "9", "--json",
        ], text=True, capture_output=True)
        Path(f"{stem}.text.json").write_text(text_check.stdout, encoding="utf-8")
        collision_check = subprocess.run([
            sys.executable, str(SKILL / "scripts" / "audit_figure_collisions.py"),
            str(pdf), "--json-out", f"{stem}.collision.json",
            "--overlay-pdf", f"{stem}.collision.pdf",
        ], text=True, capture_output=True)
        collision = json.loads(Path(f"{stem}.collision.json").read_text(encoding="utf-8"))
        with fitz.open(pdf) as doc:
            page = doc[0]
            spans = [span for block in page.get_text("dict")["blocks"]
                     if block["type"] == 0 for line in block["lines"]
                     for span in line["spans"] if span["text"].strip()]
            fonts = page.get_fonts(full=True)
            report[name] = {
                "width_in": round(page.rect.width / 72, 4),
                "height_in": round(page.rect.height / 72, 4),
                "minimum_font_pt": min(span["size"] for span in spans),
                "fonts": sorted({span["font"] for span in spans}),
                "embedded_font_extensions": sorted({font[1] for font in fonts}),
                "minimum_stroke_pt": min(path["width"] for path in page.get_drawings()
                                         if path.get("width") and path.get("color")),
                "embedded_raster_images": len(page.get_images()),
                "svg_editable_text_count": (OUT / f"fig-{name}.svg").read_text(encoding="utf-8").count("<text"),
                "anonymous_pdf_metadata": not any(doc.metadata.get(key, "") for key in ("author", "keywords")),
                "text_audit_exit": text_check.returncode,
                "collision_audit_exit": collision_check.returncode,
                "collision_summary": collision["summary"],
            }
        with Image.open(OUT / f"fig-{name}.png") as raster:
            report[name]["png_pixels"] = list(raster.size)
            report[name]["png_dpi"] = list(raster.info.get("dpi", ()))
        if text_check.returncode or collision_check.returncode:
            print(text_check.stdout)
            print(collision_check.stdout)
            print(collision_check.stderr)
    (QA / "system-export-metadata.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if any(item["text_audit_exit"] or item["collision_audit_exit"] for item in report.values()):
        raise SystemExit("A rendered audit failed; repair before delivery.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", nargs="+", choices=("architecture", "runtime", "admission"),
                        default=("architecture", "runtime"),
                        help="Regenerate selected figures; admission is opt-in.")
    parser.add_argument("--qa-dir", type=Path, default=QA)
    args = parser.parse_args()
    QA = args.qa_dir.resolve()
    OUT.mkdir(exist_ok=True)
    QA.mkdir(parents=True, exist_ok=True)
    selected = {"architecture": (architecture, "architecture-2026-9pt"),
                "runtime": (runtime, "runtime-2026-9pt"),
                "admission": (admission_hitl, "admission-hitl-2026")}
    for key in dict.fromkeys(args.only):
        selected[key][0]()
    run_audits([selected[key][1] for key in dict.fromkeys(args.only)])


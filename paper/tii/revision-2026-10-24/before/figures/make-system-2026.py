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
from matplotlib.patches import FancyArrowPatch, Polygon, Rectangle
import pymupdf as fitz
from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "resources"
REVISION = HERE.parent.parent / "final-revision-2026-10-20"
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
    fig.savefig(OUT / f"fig-{name}.svg")
    fig.savefig(OUT / f"fig-{name}.png", dpi=600)
    # Keep the QA preview at publication-grade raster density; the manuscript
    # consumes the vector PDF, while this preview is used for physical-size QA.
    fig.savefig(QA / f"system-{name}.final-size.png", dpi=300)
    with Image.open(QA / f"system-{name}.final-size.png") as preview:
        preview.convert("L").save(QA / f"system-{name}.grayscale.png")
    plt.close(fig)


def architecture():
    fig, ax = canvas(7.16, 3.15)
    # A component view: the context spans all three service responsibilities.
    # Connections describe distinct information contracts, not a single order
    # of governance checks shared by every operation.
    box(ax, 8, 207, 499, 16, fill=PALE_BLUE, edge=BLUE)
    text(ax, 257.5, 215, "Console · REST · MCP · A2A · CLI   |   Typed SDK + registration",
         ha="center", color=BLUE)
    ax.add_patch(Polygon([(4, 3), (344, 3), (344, 54), (511, 54),
                         (511, 225), (4, 225)], closed=True, facecolor="none",
                        edgecolor=RULE, linewidth=0.6, linestyle=(0, (3, 2))))
    box(ax, 8, 182, 499, 19, fill=PALE_BLUE, edge=BLUE)
    text(ax, 257.5, 191.5,
         "Production context: line · product · recipe / version · active run",
         ha="center", bold=True, color=BLUE)
    for x, width, title in [(8, 157, "Team and strategy"),
                            (179, 161, "Governed execution"),
                            (354, 153, "Industrial integration")]:
        text(ax, x + width / 2, 172, title, ha="center", bold=True,
             color=BLUE, size=10)
        ax.plot([x, x + width], [163, 163], color=RULE, lw=0.6)

    text(ax, 15, 151, "Channel · member · engine")
    text(ax, 15, 137, "Tasks, memory and tool profile")
    box(ax, 9, 97, 155, 29, fill=PALE_BLUE, edge=BLUE)
    text(ax, 16, 117, "Read-only DAQ / IDD / RAG", color=BLUE)
    text(ax, 16, 104, "AML data → qualified model", color=BLUE)
    box(ax, 9, 62, 155, 29, fill=PALE_TEAL, edge=TEAL)
    text(ax, 16, 82, "Authorized proposals", bold=True, color=TEAL)
    text(ax, 16, 69, "Exploration / recipe actions", color=TEAL)

    # The gate bundle is intentionally not drawn as a universal sequence.
    box(ax, 179, 62, 161, 96, fill="white", edge=TEAL)
    text(ax, 187, 148, "Operation-specific gates", bold=True, color=TEAL)
    text(ax, 187, 133, "Capabilities + production scope")
    text(ax, 187, 119, "Required HITL and rechecking")
    text(ax, 187, 105, "Active limits + intervention pace")
    ax.plot([187, 332], [96, 96], color=RULE, lw=0.5)
    text(ax, 187, 85, "Node / batch execution", bold=True, color=TEAL)
    text(ax, 187, 71, "Dispatch + graded confirmation")
    arrow(ax, (164, 77), (179, 77), color=TEAL)
    arrow(ax, (340, 142), (354, 142), color=TEAL)
    arrow(ax, (354, 154), (340, 154), color=GRAY, dashed=True)

    box(ax, 354, 117, 132, 41, fill=PALE_TEAL, edge=TEAL)
    text(ax, 361, 148, "DCW · control drivers", bold=True, color=TEAL)
    text(ax, 361, 135, "u → device / simulator")
    text(ax, 361, 125, "ACK / readback if available")
    box(ax, 354, 69, 132, 35, fill=PALE_BLUE, edge=BLUE)
    text(ax, 361, 94, "DAQ · observation", bold=True, color=BLUE)
    text(ax, 361, 81, "Timestamped output y")
    # Command and command-confirmation routes use distinct gutters; process
    # output has an independent upward acquisition connection.
    arrow(ax, (486, 140), (497, 42), color=TEAL, points=[(497, 140)])
    arrow(ax, (505, 42), (486, 151), color=GRAY, dashed=True,
          points=[(505, 151)])
    arrow(ax, (374, 42), (374, 69), color=BLUE)

    box(ax, 354, 7, 153, 35, fill="white", edge=GRAY)
    text(ax, 361, 31, "Equipment / simulator", bold=True, color=GRAY)
    text(ax, 361, 18, "Local control and protection", color=GRAY)

    # Records remain route specific while shared context makes them joinable.
    box(ax, 8, 7, 332, 35, fill=PALE_BLUE, edge=BLUE)
    text(ax, 16, 31, "Linked evidence for review and learning", bold=True, color=BLUE)
    text(ax, 16, 18, "Task artifacts · node journal · batch receipts · DAQ history")
    arrow(ax, (259, 62), (259, 42), color=TEAL)
    arrow(ax, (354, 86), (340, 25), color=BLUE, dashed=True,
          points=[(347, 86), (347, 25)])
    arrow(ax, (8, 25), (9, 111), color=BLUE, dashed=True,
          points=[(3, 25), (3, 111)])
    save(fig, "architecture-2026")


def runtime():
    fig, ax = canvas(3.50, 3.55)
    text(ax, 126, 248, "Production context + channel profile", ha="center",
         bold=True, color=BLUE)
    panels = []
    for x, letter, title, entries, lane_color, lane_fill in [
        (6, "a", "Bounded exploration", [
            ("Baseline u₀, y₀", "Snapshot / DAQ mean"),
            ("Internal execution", "Required HITL + checks"),
            ("Apply control u₁", "Journal on value change"),
            ("Platform waits", "Query DAQ mean y₁"),
            ("Exploration summary", "Save u₀, u₁, y₀, y₁"),
        ], BLUE, PALE_BLUE),
        (130, "b", "Recipe trial / apply", [
            ("Candidate or version", "Trial override / apply"),
            ("Recipe gates", "Required HITL + recheck"),
            ("Create batch run", "Write + verify each u₁"),
            ("Return graded receipt", "Per-parameter evidence"),
            ("Caller waits / queries", "Evaluate DAQ output y₁"),
        ], TEAL, PALE_TEAL),
    ]:
        branch = fig.add_axes([x / 252, 45 / 255.6, 116 / 252, 195 / 255.6])
        branch.set(xlim=(0, 116), ylim=(0, 195))
        branch.set_axis_off()
        branch.patch.set_alpha(0)
        branch.add_patch(Rectangle((0, 193.5), 116, 1.5,
                                   facecolor=lane_color, edgecolor="none",
                                   zorder=1))
        panels.append(branch)
        text(branch, 1, 185, letter, bold=True, color=lane_color, size=9.5)
        text(branch, 14, 185, title, bold=True, color=lane_color, size=9.5)
        centers = (159, 124, 89, 54, 19)
        for index, ((heading, detail), center) in enumerate(zip(entries, centers)):
            box(branch, 1, center - 13.5, 114, 27, fill=lane_fill, edge=RULE)
            text(branch, 58, center + 6, heading, ha="center", bold=True, color=lane_color)
            text(branch, 58, center - 6.5, detail, ha="center")
            if index < len(entries) - 1:
                arrow(branch, (58, center - 13.5), (58, centers[index + 1] + 13.5),
                      color=lane_color)

    text(ax, 8, 26, "Node journal and summary", color=GRAY)
    text(ax, 8, 13, "are separate records.", color=GRAY)
    box(ax, 131, 3, 114, 31, fill="white", edge=TEAL)
    text(ax, 188, 25, "Separate caller action", ha="center", color=TEAL)
    text(ax, 188, 12, "recipe_update → save", ha="center", bold=True, color=TEAL)
    arrow(ax, (188, 50.5), (188, 34), color=TEAL, dashed=True)
    save(fig, "runtime-2026", panels=panels)


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

    # Archived Q1 mechanism example. Hard limits use their complete own scale.
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
    text(a, 2, 3, "Recipe dispatch omits the old R", color=GOLD)

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
    text(b, 2, 30, "Approve → recheck grants, binding and context", color=TEAL)
    text(b, 2, 17, "Then admission → dispatch; failure → no dispatch")
    text(b, 2, 4, "Decline → no dispatch; decision is recorded", color=GOLD)
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
    selected = {"architecture": (architecture, "architecture-2026"),
                "runtime": (runtime, "runtime-2026"),
                "admission": (admission_hitl, "admission-hitl-2026")}
    for key in dict.fromkeys(args.only):
        selected[key][0]()
    run_audits([selected[key][1] for key in dict.fromkeys(args.only)])

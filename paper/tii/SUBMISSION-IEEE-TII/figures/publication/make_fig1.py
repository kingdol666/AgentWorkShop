"""Generate the publication-ready conceptual Figure 1 for the TII submission.

This scoped generator owns only Figure 1. It never rewrites TeX, benchmark data,
or the archived GPT-generated reference PNG. The artwork is original vector-style
line art with a restrained IEEE-compatible palette and explicit request/result
routing.

Run from the repository root:
    python paper/tii/SUBMISSION-IEEE-TII/figures/publication/make_fig1.py
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import fitz
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import Arc, Circle, Ellipse, FancyArrowPatch, FancyBboxPatch, Rectangle

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
OUT = HERE
STEM = "fig1-supervisory-binding"
WIDTH_IN, HEIGHT_IN = 7.16, 2.72
DPI = 300

INK = "#25333b"
NAVY = "#35576a"
TEAL = "#367d82"
RULE = "#b8c2c7"
PALE = "#eef2f3"
PALE_TEAL = "#edf5f5"
WHITE = "#ffffff"
ICON_LW = 0.85


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def configure() -> None:
    font_manager.findfont("Times New Roman", fallback_to_default=False)
    plt.rcParams.update({
        "font.family": "Times New Roman",
        "font.size": 8.0,
        "text.color": INK,
        "axes.labelcolor": INK,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "svg.fonttype": "path",
        "svg.hashsalt": "agentworkshop-fig1",
        "savefig.pad_inches": 0,
    })


def canvas():
    fig = plt.figure(figsize=(WIDTH_IN, HEIGHT_IN))
    ax = fig.add_axes([0, 0, 1, 1], xlim=(0, WIDTH_IN), ylim=(0, HEIGHT_IN))
    ax.axis("off")
    return fig, ax


def text(ax, x, y, value, *, size=8.0, weight="normal", color=INK,
         ha="left", va="center", style="normal", linespacing=1.0):
    return ax.text(x, y, value, fontsize=size, fontweight=weight, color=color,
                   ha=ha, va=va, fontstyle=style, linespacing=linespacing)


def rounded_box(ax, x, y, w, h, *, edge=NAVY, face=WHITE, lw=0.75,
                radius=0.045):
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle=f"round,pad=0.012,rounding_size={radius}",
        linewidth=lw, edgecolor=edge, facecolor=face,
    ))


def arrow(ax, x1, y1, x2, y2, *, color=NAVY, lw=0.75, dashed=False,
          mutation=6.0, shrink=1.5):
    ax.add_patch(FancyArrowPatch(
        (x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=mutation,
        linewidth=lw, color=color, linestyle="--" if dashed else "-",
        shrinkA=shrink, shrinkB=shrink,
    ))


def icon_line(ax, points, cx, cy, *, color, scale=1.0):
    ax.plot([cx + x * scale for x, _ in points],
            [cy + y * scale for _, y in points], color=color,
            linewidth=ICON_LW, solid_capstyle="round", solid_joinstyle="round")


def robot_icon(ax, cx, cy, color=NAVY):
    """Original agent face: paired eyes, antenna, and two side terminals."""
    ax.add_patch(FancyBboxPatch((cx - .105, cy - .07), .21, .15,
                               boxstyle="round,pad=0.003,rounding_size=0.035",
                               fill=False, edgecolor=color, linewidth=ICON_LW))
    for dx in (-.04, .04):
        ax.add_patch(Circle((cx + dx, cy + .014), .011, color=color, linewidth=0))
    for pts in ([(-.04, -.035), (.04, -.035)], [(0, .08), (0, .12)],
                [(-.135, -.03), (-.135, .03)], [(.135, -.03), (.135, .03)]):
        icon_line(ax, pts, cx, cy, color=color)
    ax.add_patch(Circle((cx, cy + .137), .015, fill=False,
                        edgecolor=color, linewidth=ICON_LW))


def factory_icon(ax, cx, cy, color=TEAL):
    """Original sawtooth roof and chimney, with one continuous outline."""
    icon_line(ax, [(-.14, -.10), (-.14, .035), (-.07, .08),
                   (-.07, .035), (0, .08), (0, .035), (.07, .035),
                   (.07, .14), (.12, .14), (.12, -.10), (-.14, -.10)],
              cx, cy, color=color)
    for dx in (-.095, -.025, .045):
        ax.add_patch(Rectangle((cx + dx, cy - .063), .026, .035,
                               fill=False, edgecolor=color, linewidth=ICON_LW))


def tank_icon(ax, cx, cy, color=TEAL):
    """Acquisition/storage equipment, drawn from ellipses and straight walls."""
    ax.add_patch(Ellipse((cx, cy + .082), .18, .065, fill=False,
                         edgecolor=color, linewidth=ICON_LW))
    for dx in (-.09, .09):
        icon_line(ax, [(dx, .082), (dx, -.082)], cx, cy, color=color)
    ax.add_patch(Arc((cx, cy - .082), .18, .065, theta1=180, theta2=360,
                     color=color, linewidth=ICON_LW))
    ax.add_patch(Arc((cx, cy), .18, .065, theta1=180, theta2=360,
                     color=color, linewidth=ICON_LW))


def gauge_icon(ax, cx, cy, color=TEAL):
    """Measurement equipment, using a dial with three ticks and a pointer."""
    ax.add_patch(Circle((cx, cy), .114, fill=False,
                        edgecolor=color, linewidth=ICON_LW))
    for pts in ([(-.077, .045), (-.058, .034)], [(0, .087), (0, .067)],
                [(.077, .045), (.058, .034)], [(0, -.016), (.055, .052)]):
        icon_line(ax, pts, cx, cy, color=color)
    ax.add_patch(Circle((cx, cy - .016), .017, fill=False,
                        edgecolor=color, linewidth=ICON_LW))


def team_icon(ax, cx, cy, color=NAVY):
    """Three separate silhouettes; foreground lead and two side members."""
    for dx in (-.105, .105):
        ax.add_patch(Circle((cx + dx, cy + .045), .034, fill=False,
                            edgecolor=color, linewidth=ICON_LW))
        icon_line(ax, [(dx - .049, -.067), (dx - .049, -.039),
                       (dx - .032, -.01), (dx + .032, -.01),
                       (dx + .049, -.039), (dx + .049, -.067)],
                  cx, cy, color=color)
    # White foreground keeps silhouettes separated without varying stroke weight.
    ax.add_patch(FancyBboxPatch((cx - .067, cy - .107), .134, .117,
                               boxstyle="round,pad=0.003,rounding_size=0.035",
                               facecolor=WHITE, edgecolor=color, linewidth=ICON_LW,
                               zorder=3))
    ax.add_patch(Circle((cx, cy + .074), .043, facecolor=WHITE,
                        edgecolor=color, linewidth=ICON_LW, zorder=3))


def node_stack_icon(ax, cx, cy, color=NAVY):
    """Three semantic node cards connected to a common member-side binding bus."""
    icon_line(ax, [(-.155, -.085), (-.155, .085)], cx, cy, color=color)
    for yy in (-.085, 0, .085):
        icon_line(ax, [(-.155, yy), (-.105, yy)], cx, cy, color=color)
        ax.add_patch(FancyBboxPatch((cx - .105, cy + yy - .028), .245, .056,
                                   boxstyle="round,pad=0.002,rounding_size=0.012",
                                   fill=False, edgecolor=color, linewidth=ICON_LW))
        ax.add_patch(Circle((cx - .072, cy + yy), .008, color=color, linewidth=0))
        icon_line(ax, [(-.025, yy), (.09, yy)], cx, cy, color=color)


def checklist_icon(ax, cx, cy, color=TEAL):
    """Verification, not a safety guarantee: a checklist with three marked rows."""
    ax.add_patch(FancyBboxPatch((cx - .102, cy - .132), .204, .264,
                               boxstyle="round,pad=0.004,rounding_size=0.017",
                               fill=False, edgecolor=color, linewidth=ICON_LW))
    for yy in (.075, 0, -.075):
        icon_line(ax, [(-.065, yy), (-.047, yy - .018), (-.015, yy + .021)],
                  cx, cy, color=color)
        icon_line(ax, [(.024, yy), (.067, yy)], cx, cy, color=color)


def record_icon(ax, cx, cy, color=TEAL):
    """Execution record: folded page and two rows, without implying success."""
    icon_line(ax, [(-.08, -.102), (-.08, .102), (.035, .102), (.08, .057),
                   (.08, -.102), (-.08, -.102)], cx, cy, color=color)
    icon_line(ax, [(.035, .102), (.035, .057), (.08, .057)], cx, cy, color=color)
    for yy in (.005, -.044):
        icon_line(ax, [(-.045, yy), (.043, yy)], cx, cy, color=color)


def intro():
    fig, ax = canvas()
    text(ax, .10, 2.55, "(a) Application-specific integration", size=9.3, weight="bold")
    text(ax, 3.39, 2.55, "(b) AgentWorkShop node-native binding", size=9.3, weight="bold")
    ax.plot([3.27, 3.27], [.09, 2.63], color=RULE, linewidth=.55)

    # Three independent routes repeat driver, permission and logging logic.
    for number, y, device in ((1, 1.75, factory_icon), (2, 1.07, tank_icon),
                              (3, .39, gauge_icon)):
        rounded_box(ax, .10, y, .66, .54, edge=NAVY, face=PALE)
        robot_icon(ax, .43, y + .33)
        text(ax, .43, y + .105, f"Agent {number}", size=8.2, ha="center")

        rounded_box(ax, 1.02, y, 1.17, .54, edge=RULE, face=PALE)
        for label, yy in (("Driver", .435), ("Permission", .27), ("Log", .105)):
            text(ax, 1.605, y + yy, label, size=8.2, ha="center")
        for yy in (.1875, .3525):
            ax.plot([1.09, 2.12], [y + yy, y + yy], color=RULE, linewidth=.45)

        rounded_box(ax, 2.46, y, .66, .54, edge=TEAL, face=PALE_TEAL)
        device(ax, 2.79, y + .33)
        text(ax, 2.79, y + .105, f"Device {number}", size=8.2, ha="center")
        arrow(ax, .78, y + .27, 1.0, y + .27)
        arrow(ax, 2.21, y + .27, 2.44, y + .27, color=TEAL)

    ax.plot([1.02, 1.02, 2.19, 2.19], [.285, .235, .235, .285],
            color=NAVY, linewidth=.7)
    text(ax, 1.605, .10, "Duplicated per application", size=8.2, weight="bold", ha="center")

    # A member's request is bound, checked, and then sent to the semantic node.
    for x, w, icon, labels, edge, face in (
        (3.39, .85, team_icon, ("Channel", "lead + workers"), NAVY, WHITE),
        (4.62, .78, node_stack_icon, ("Node binding", "per member"), NAVY, PALE),
        (6.25, .82, factory_icon, ("DAQ / DCW", "nodes"), TEAL, PALE_TEAL),
    ):
        rounded_box(ax, x, 1.40, w, .70, edge=edge, face=face)
        icon(ax, x + w / 2, 1.865, color=edge)
        text(ax, x + w / 2, 1.635, labels[0], size=8.2, ha="center")
        text(ax, x + w / 2, 1.465, labels[1], size=8.0, ha="center")

    arrow(ax, 4.26, 1.865, 4.60, 1.865)
    text(ax, 4.43, 2.035, "request", size=8.0, ha="center", color=NAVY)
    arrow(ax, 5.42, 1.865, 5.61, 1.865)
    checklist_icon(ax, 5.74, 1.865)
    text(ax, 5.74, 1.635, "Checks", size=8.2, ha="center", color=TEAL)
    text(ax, 5.74, 2.345, "Applicable range", size=8.0, ha="center", color=TEAL)
    text(ax, 5.74, 2.18, "recipe / approval", size=8.0, ha="center", color=TEAL)
    arrow(ax, 5.87, 1.865, 6.23, 1.865, color=TEAL)

    # Shared identifiers sit inside the loop, without arrows granting authority.
    rounded_box(ax, 3.70, .94, 3.02, .28, edge=RULE, face=PALE)
    text(ax, 5.21, 1.08, "Shared line / product / recipe / run IDs", size=8.2, ha="center")

    # A routed result path returns node evidence to channel members.
    # Orthogonal connectors terminate on the evidence record and channel card.
    ax.plot([6.93, 6.93], [1.388, .55], color=TEAL, linewidth=.75)
    arrow(ax, 6.93, .55, 6.392, .55, color=TEAL, shrink=0)
    rounded_box(ax, 4.28, .35, 2.10, .40, edge=TEAL, face=WHITE)
    record_icon(ax, 4.45, .55)
    text(ax, 5.43, .64, "Execution evidence", size=8.2, weight="bold", ha="center", color=TEAL)
    text(ax, 5.43, .47, "Result / readback* / record", size=8.0, ha="center")
    ax.plot([4.268, 3.50, 3.50], [.55, .55, 1.17], color=TEAL, linewidth=.75)
    arrow(ax, 3.50, 1.17, 3.50, 1.388, color=TEAL, shrink=0)
    text(ax, 5.33, .14, "* Readback where supported", size=8.0, ha="center")
    return fig


def pdf_info(path: Path):
    with fitz.open(path) as doc:
        if len(doc) != 1:
            raise RuntimeError("Expected a single-page figure")
        page = doc[0]
        fonts = page.get_fonts(full=True)
        spans = [s for b in page.get_text("dict")["blocks"] if "lines" in b
                 for line in b["lines"] for s in line["spans"] if s["text"].strip()]
        outside = [s["text"] for s in spans if not page.rect.contains(fitz.Rect(s["bbox"]))]
        overlaps = []
        for i, first in enumerate(spans):
            for second in spans[i + 1:]:
                intersection = fitz.Rect(first["bbox"]) & fitz.Rect(second["bbox"])
                if intersection.width > 0.75 and intersection.height > 0.75:
                    overlaps.append([first["text"], second["text"]])
        page.get_pixmap(dpi=DPI, alpha=False).save(OUT / f"{STEM}.png")
        page.get_pixmap(dpi=DPI, colorspace=fitz.csGRAY, alpha=False).save(
            OUT / f"{STEM}-grayscale.png")
        return {
            "size_in": [round(page.rect.width / 72, 4), round(page.rect.height / 72, 4)],
            "raster_images_in_pdf": len(page.get_images(full=True)),
            "embedded_fonts": bool(fonts) and all(bool(doc.extract_font(f[0])[3]) for f in fonts),
            "fonts": sorted({f[3] for f in fonts}),
            "minimum_font_pt": round(min(s["size"] for s in spans), 2),
            "text_spans": len(spans),
            "spans_outside_canvas": outside,
            "text_overlap_pairs": overlaps,
            "proof_dpi": DPI,
        }


def main() -> None:
    configure()
    OUT.mkdir(parents=True, exist_ok=True)
    original = OUT.parent / "gpt" / "fig1-intro-tii.png"
    original_hash = sha256(original)
    if original_hash != "2053cdad022a0a6674bd5380595c24b79a1ff3007a001a49422bbc3408bb5e6f":
        raise RuntimeError("Archived reference PNG differs from its recorded hash")

    fig = intro()
    pdf = OUT / f"{STEM}.pdf"
    svg = OUT / f"{STEM}.svg"
    fig.savefig(pdf, format="pdf", metadata={
        "Title": "Conceptual supervisory integration",
        "Creator": "Matplotlib vector figure generator",
        "Author": None, "CreationDate": None, "ModDate": None,
    })
    fig.savefig(svg, format="svg", metadata={"Title": "Conceptual supervisory integration", "Date": None})
    plt.close(fig)

    info = pdf_info(pdf)
    expected = [WIDTH_IN, HEIGHT_IN]
    if info["size_in"] != expected:
        raise RuntimeError(f"Unexpected PDF size: {info['size_in']}")
    if (info["raster_images_in_pdf"] or not info["embedded_fonts"]
            or info["minimum_font_pt"] < 8.0 or info["spans_outside_canvas"]
            or info["text_overlap_pairs"]):
        raise RuntimeError(f"Figure 1 QA failed: {info}")
    if sha256(original) != original_hash:
        raise RuntimeError("Archived reference PNG was modified")

    artifacts = {
        "pdf": pdf,
        "svg": svg,
        "png": OUT / f"{STEM}.png",
        "grayscale_png": OUT / f"{STEM}-grayscale.png",
    }
    hashes = {kind: sha256(path) for kind, path in artifacts.items()}
    qa_path = OUT / f"{STEM}-qa.json"
    visual_inspection = {"status": "pending", "scope": "Local visual inspection, not independent approval."}
    if qa_path.exists():
        previous = json.loads(qa_path.read_text(encoding="utf-8"))
        if previous.get("sha256") == hashes:
            visual_inspection = previous.get("visual_inspection", visual_inspection)

    source_paths = [
        ROOT / "paper/tii/SUBMISSION-IEEE-TII/sections/introduction.tex",
        ROOT / "paper/tii/SUBMISSION-IEEE-TII/sections/mechanisms.tex",
        OUT.parent / "make_publication_figures.py",
        original,
    ]
    qa = {
        "figure": STEM,
        "generator": Path(__file__).name,
        "generator_sha256": sha256(Path(__file__)),
        "preserved_reference_sha256": original_hash,
        "input_assets": {path.relative_to(ROOT).as_posix(): sha256(path) for path in source_paths},
        "outputs": {kind: str(path.resolve()) for kind, path in artifacts.items()},
        "sha256": hashes,
        "qa": info,
        "provenance": "AI-assisted, programmatically constructed original vector artwork; no raster tracing or generated icon assets. Reference PNG preserved.",
        "visual_inspection": visual_inspection,
        "integration_note": "Scoped Figure 1 generator and assets only. Existing aggregate generators/manifests are intentionally untouched.",
        "design_notes": [
            "Original uniform-stroke line icons for agents, factory, tank, gauge, channel team, bound node stack, verification checklist, and execution record.",
            "Muted blue/teal/gray palette with redundant shape, outline, and label cues for grayscale reading.",
            "Forward request path passes through per-member binding and applicable range/recipe/approval checks. An orthogonal result/readback/record route returns to the channel.",
            "Shared identifiers sit inside the feedback loop, separate from the authority path. Readback is qualified as protocol-dependent; the parent caption supplies the conceptual comparison caveat.",
        ],
    }
    qa_path.write_text(json.dumps(qa, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(qa, indent=2))


if __name__ == "__main__":
    main()

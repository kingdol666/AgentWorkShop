# -*- coding: utf-8 -*-
"""Create an editable and publication-ready single-column agent-control figure.

The original drawing contained undefined "Node" placeholders and one
unconnected PLC edge. This figure follows only execution stages supported by
the manuscript: task context, DAQ-informed agent proposal, shared dispatch,
route checks, configured approval, DCW/device routing, and distinct outcomes.

Run from this directory with: python make-agent-control-figure.py
"""
import os
import xml.etree.ElementTree as ET

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Rectangle


HERE = os.path.dirname(os.path.abspath(__file__))
RESOURCES = os.path.join(HERE, "..", "resources")
os.makedirs(RESOURCES, exist_ok=True)

BLUE, GREEN, TEAL = "#2E5E8C", "#3E8E55", "#20706B"
DARK, GREY, EDGE = "#262626", "#737B83", "#B7C0C8"

ROWS = [
    ("Goal + production context", "active line · product · recipe · run", BLUE),
    ("Agent control", "reads DAQ/MES; proposes a named operation", BLUE),
    ("Shared operation dispatcher", "scope + channel policy; applicable grant/binding checks", GREEN),
    ("Write guards + approval", "process limits; approval when required; recheck before dispatch", GREEN),
    ("DCW → driver → PLC / simulator", "command receipt and later DAQ observation remain distinct", TEAL),
]


def make_vector_figure():
    plt.rcParams.update({
        "font.family": ["Arial", "DejaVu Sans"],
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "font.size": 7.5,
    })
    width, height = 3.50, 2.42
    fig = plt.figure(figsize=(width, height))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, width)
    ax.set_ylim(0, height)
    ax.axis("off")

    x0, box_w = 0.11, width - 0.22
    row_h, gap = 0.36, 0.065
    top = height - 0.065
    bottoms = []
    for title, detail, color in ROWS:
        y = top - row_h
        bottoms.append(y)
        ax.add_patch(FancyBboxPatch(
            (x0, y), box_w, row_h,
            boxstyle="round,pad=0.006,rounding_size=0.035",
            facecolor="white", edgecolor=EDGE, linewidth=0.65,
        ))
        ax.add_patch(Rectangle(
            (x0 + 0.006, y + 0.006), 0.042, row_h - 0.012,
            facecolor=color, edgecolor="none",
        ))
        ax.text(x0 + 0.105, y + row_h - 0.061, title,
                fontsize=7.7, weight="bold", color=color,
                va="top", ha="left")
        ax.text(x0 + 0.105, y + 0.050, detail,
                fontsize=7.25, color=DARK, va="bottom", ha="left")
        top = y - gap

    for i in range(len(bottoms) - 1):
        y0 = bottoms[i]
        y1 = bottoms[i + 1] + row_h
        ax.add_patch(FancyArrowPatch(
            (width / 2, y0), (width / 2, y1),
            arrowstyle="-|>", mutation_scale=6.4,
            color=GREY, linewidth=0.65, shrinkA=0, shrinkB=0,
        ))

    out_pdf = os.path.join(RESOURCES, "fig-agent-control.pdf")
    out_svg = os.path.join(RESOURCES, "fig-agent-control.svg")
    out_png = os.path.join(RESOURCES, "fig-agent-control.png")
    fig.savefig(out_pdf, format="pdf")
    fig.savefig(out_svg, format="svg")
    fig.savefig(out_png, format="png", dpi=600)
    plt.close(fig)
    return out_pdf, out_svg, out_png


def make_editable_drawio():
    """Write a simple, uncompressed diagrams.net source for later editing."""
    root = ET.Element("mxfile", {
        "host": "app.diagrams.net",
        "modified": "2026-10-26T00:00:00.000Z",
        "agent": "Codex",
        "type": "device",
    })
    diagram = ET.SubElement(root, "diagram", {"name": "Agent control path", "id": "agent-control-path"})
    model = ET.SubElement(diagram, "mxGraphModel", {
        "dx": "1000", "dy": "900", "grid": "1", "gridSize": "10",
        "guides": "1", "tooltips": "1", "connect": "1", "arrows": "1",
        "fold": "1", "page": "1", "pageScale": "1", "pageWidth": "827",
        "pageHeight": "1169", "math": "0", "shadow": "0",
    })
    graph_root = ET.SubElement(model, "root")
    ET.SubElement(graph_root, "mxCell", {"id": "0"})
    ET.SubElement(graph_root, "mxCell", {"id": "1", "parent": "0"})

    node_ids = []
    y = 36
    for i, (title, detail, color) in enumerate(ROWS, start=1):
        node_id = f"step-{i}"
        node_ids.append(node_id)
        cell = ET.SubElement(graph_root, "mxCell", {
            "id": node_id,
            "value": f"<b>{title}</b><br>{detail}",
            "style": (
                "rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFFFF;"
                f"strokeColor={color};strokeWidth=2;align=left;verticalAlign=middle;"
                "spacingLeft=14;spacingRight=10;fontSize=15;fontColor=#262626;"
            ),
            "vertex": "1",
            "parent": "1",
        })
        ET.SubElement(cell, "mxGeometry", {
            "x": "130", "y": str(y), "width": "570", "height": "68",
            "as": "geometry",
        })
        y += 98

    for i in range(len(node_ids) - 1):
        edge = ET.SubElement(graph_root, "mxCell", {
            "id": f"flow-{i + 1}",
            "style": (
                "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;"
                "jettySize=auto;html=1;endArrow=block;endFill=1;"
                f"strokeColor={GREY};strokeWidth=1.4;"
            ),
            "edge": "1",
            "parent": "1",
            "source": node_ids[i],
            "target": node_ids[i + 1],
        })
        ET.SubElement(edge, "mxGeometry", {"relative": "1", "as": "geometry"})

    ET.indent(root, space="  ")
    out = os.path.join(HERE, "agent-control-path.drawio")
    ET.ElementTree(root).write(out, encoding="utf-8", xml_declaration=True)
    return out


if __name__ == "__main__":
    for path in make_vector_figure():
        print("written", os.path.abspath(path))
    print("written", os.path.abspath(make_editable_drawio()))

    try:
        import pymupdf
        doc = pymupdf.open(os.path.join(RESOURCES, "fig-agent-control.pdf"))
        page = doc[0]
        spans = [
            span for block in page.get_text("dict")["blocks"] if block.get("type") == 0
            for line in block["lines"]
            for span in line["spans"] if span["text"].strip()
        ]
        sizes = [span["size"] for span in spans]
        assert sizes and min(sizes) >= 7.2, f"minimum text size: {min(sizes) if sizes else None}"
        assert page.rect.width <= 260 and page.rect.height <= 260, "unexpected single-column size"
        print(f"self-check ok: min font={min(sizes):.2f} pt; page={page.rect.width:.1f}x{page.rect.height:.1f} pt")
    except ImportError:
        print("self-check skipped: PyMuPDF unavailable")

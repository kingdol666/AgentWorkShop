"""Compose the TII Figure 1 from a GPT Image 2.6 illustration and exact labels.

The process illustration is raster. Labels, cards, and connectors are drawn as
editable vector text and shapes in PDF/SVG; the companion draw.io file embeds
the same illustration and keeps the labels/connectors editable.
"""
from __future__ import annotations

import base64
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, ElementTree

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch
from PIL import Image


HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parents[1]
FIGURES = PACKAGE / "figures"
BASE = HERE / "fig1-gptimage26-base.png"
CROP = HERE / "fig1-gptimage26-crop.png"
DRAWIO = HERE / "fig1_cast_film.drawio"

WIDTH_PT, HEIGHT_PT = 252, 150
NAVY = "#23415A"
TEAL = "#167D86"
AMBER = "#B56B24"
TEXT = "#263442"
PALE_BLUE = "#F3F6F8"
PALE_TEAL = "#F0F8F7"
PALE_AMBER = "#FCF5EE"
WHITE = "#FFFFFF"

# Trim only unused white margins around the generated equipment illustration.
with Image.open(BASE) as source:
    source = source.convert("RGB")
    crop = source.crop((60, 272, 1610, 774))
    crop.save(CROP, format="PNG", optimize=True)

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "Times", "DejaVu Serif"],
    "font.size": 9.3,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    "svg.fonttype": "none",
    "axes.linewidth": 0.7,
    "figure.facecolor": WHITE,
    "savefig.facecolor": WHITE,
})

fig = plt.figure(figsize=(WIDTH_PT / 72, HEIGHT_PT / 72), dpi=600)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, WIDTH_PT)
ax.set_ylim(HEIGHT_PT, 0)
ax.axis("off")
ax.set_facecolor(WHITE)


def rounded_box(x: float, y: float, w: float, h: float, edge: str, fill: str,
                radius: float = 2.0, lw: float = 0.8) -> None:
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h,
        boxstyle=f"round,pad=0,rounding_size={radius}",
        linewidth=lw, edgecolor=edge, facecolor=fill, zorder=3,
    ))


def label(x: float, y: float, text: str, size: float = 9.3,
          color: str = TEXT, bold: bool = False, ha: str = "center") -> None:
    ax.text(x, y, text, ha=ha, va="center", fontsize=size, color=color,
            fontweight="bold" if bold else "normal", zorder=5)


def arrow(start: tuple[float, float], end: tuple[float, float], color: str,
          rad: float = 0.0) -> None:
    ax.add_patch(FancyArrowPatch(
        start, end, arrowstyle="-|>", mutation_scale=7, shrinkA=0, shrinkB=1,
        linewidth=0.9, color=color,
        connectionstyle=f"arc3,rad={rad}", zorder=4,
    ))


# Signal-role cards sit in the open space above the line illustration.
rounded_box(7, 4, 114, 29, NAVY, PALE_BLUE)
label(64, 12.5, "Control node", 9.3, NAVY, True)
label(64, 24.5, "linespeed-sp / MQTT", 9.3, TEXT)

rounded_box(131, 4, 114, 29, TEAL, PALE_TEAL)
label(188, 12.5, "Measurement node", 9.3, TEAL, True)
label(188, 24.5, "film-thickness / MQTT", 9.3, TEXT)

# Generated physical context; the text and signal semantics remain code-authored.
with Image.open(CROP) as source_illustration:
    illustration = source_illustration.convert("RGB")
    aspect = illustration.width / illustration.height
image_x, image_w, image_y = 7.0, 238.0, 37.0
image_h = image_w / aspect
ax.imshow(illustration, extent=(image_x, image_x + image_w,
                               image_y + image_h, image_y),
          origin="upper", interpolation="lanczos", aspect="auto", zorder=1)

# The control setpoint acts on the haul-off/roller section; the gauge supplies
# the distinct process measurement. No causal claim is encoded between them.
arrow((64, 33), (157, 74), NAVY, rad=-0.04)
arrow((188, 33), (215, 63), TEAL, rad=0.02)

# These are separate records, not a single success signal.
cards = [
    (7, 117, 75, NAVY, PALE_BLUE, "Command", "receipt"),
    (88.5, 117, 75, AMBER, PALE_AMBER, "Optional", "setpoint readback"),
    (170, 117, 75, TEAL, PALE_TEAL, "Later DAQ", "observation"),
]
for x, y, w, edge, fill, first, second in cards:
    rounded_box(x, y, w, 28, edge, fill, radius=2.0, lw=0.75)
    label(x + w / 2, y + 9.5, first, 9.3, edge, True)
    label(x + w / 2, y + 20.0, second, 9.3, TEXT)

FIGURES.mkdir(parents=True, exist_ok=True)
for ext in ("pdf", "svg", "png"):
    target = FIGURES / f"fig1.{ext}"
    options = {"dpi": 600} if ext == "png" else {}
    fig.savefig(target, **options)
plt.close(fig)


def drawio_cell(root, cell_id: str, value: str, style: str, *, vertex=False,
                edge=False, geometry: tuple[float, float, float, float] | None = None,
                parent: str = "1"):
    attrs = {"id": cell_id, "value": value, "style": style, "parent": parent}
    if vertex:
        attrs["vertex"] = "1"
    if edge:
        attrs["edge"] = "1"
    cell = SubElement(root, "mxCell", attrs)
    if geometry is not None:
        x, y, w, h = geometry
        SubElement(cell, "mxGeometry", {
            "x": str(x), "y": str(y), "width": str(w), "height": str(h),
            "as": "geometry",
        })
    return cell


def write_drawio() -> None:
    mx = Element("mxfile", {"host": "app.diagrams.net", "version": "24.7.17"})
    diagram = SubElement(mx, "diagram", {"name": "fig1_cast_film", "id": "fig1_cast_film"})
    model = SubElement(diagram, "mxGraphModel", {
        "dx": str(WIDTH_PT), "dy": str(HEIGHT_PT), "grid": "1", "gridSize": "5",
        "page": "1", "pageScale": "1", "pageWidth": str(WIDTH_PT),
        "pageHeight": str(HEIGHT_PT), "background": WHITE,
    })
    root = SubElement(model, "root")
    SubElement(root, "mxCell", {"id": "0"})
    SubElement(root, "mxCell", {"id": "1", "parent": "0"})
    cell_id = 2

    embedded = base64.b64encode(CROP.read_bytes()).decode("ascii")
    image_style = (
        "shape=image;verticalLabelPosition=bottom;verticalAlign=top;"
        "imageAspect=0;aspect=fixed;strokeColor=none;"
        f"image=data:image/png;base64,{embedded};"
    )
    drawio_cell(root, str(cell_id), "GPT Image 2.6 cast-film illustration",
                image_style, vertex=True,
                geometry=(image_x, image_y, image_w, image_h))
    cell_id += 1

    def box(x, y, w, h, edge, fill, lines):
        nonlocal cell_id
        drawio_cell(root, str(cell_id), "",
                    f"rounded=1;arcSize=5;whiteSpace=wrap;html=1;strokeColor={edge};"
                    f"fillColor={fill};strokeWidth=1;", vertex=True,
                    geometry=(x, y, w, h))
        cell_id += 1
        line_specs = lines
        for text_value, py, size, color, bold in line_specs:
            font_style = 1 if bold else 0
            style = (
                f"text;whiteSpace=wrap;html=0;strokeColor=none;fillColor=none;"
                f"fontColor={color};fontFamily=Times New Roman;fontSize={size};"
                f"fontStyle={font_style};align=center;verticalAlign=middle;"
            )
            drawio_cell(root, str(cell_id), text_value, style, vertex=True,
                        geometry=(x + 2, py - 5, w - 4, 10))
            cell_id += 1

    box(7, 4, 114, 29, NAVY, PALE_BLUE, [
        ("Control node", 12.5, 9.3, NAVY, True),
        ("linespeed-sp / MQTT", 24.5, 9.3, TEXT, False),
    ])
    box(131, 4, 114, 29, TEAL, PALE_TEAL, [
        ("Measurement node", 12.5, 9.3, TEAL, True),
        ("film-thickness / MQTT", 24.5, 9.3, TEXT, False),
    ])

    def edge(points, color):
        nonlocal cell_id
        start, end = points
        cell = drawio_cell(root, str(cell_id), "",
                           f"edgeStyle=none;rounded=0;html=0;endArrow=block;"
                           f"endFill=1;strokeColor={color};strokeWidth=1;",
                           edge=True)
        geo = SubElement(cell, "mxGeometry", {"relative": "1", "as": "geometry"})
        SubElement(geo, "mxPoint", {"x": str(start[0]), "y": str(start[1]), "as": "sourcePoint"})
        SubElement(geo, "mxPoint", {"x": str(end[0]), "y": str(end[1]), "as": "targetPoint"})
        cell_id += 1

    edge(((64, 33), (157, 74)), NAVY)
    edge(((188, 33), (215, 63)), TEAL)
    box(7, 117, 75, 28, NAVY, PALE_BLUE, [
        ("Command", 126.5, 9.3, NAVY, True), ("receipt", 137, 9.3, TEXT, False),
    ])
    box(88.5, 117, 75, 28, AMBER, PALE_AMBER, [
        ("Optional", 126.5, 9.3, AMBER, True), ("setpoint readback", 137, 9.3, TEXT, False),
    ])
    box(170, 117, 75, 28, TEAL, PALE_TEAL, [
        ("Later DAQ", 126.5, 9.3, TEAL, True), ("observation", 137, 9.3, TEXT, False),
    ])

    ElementTree(mx).write(DRAWIO, encoding="utf-8", xml_declaration=True)


write_drawio()
print("Generated Figure 1 PDF/SVG/600-dpi PNG and editable draw.io source.")

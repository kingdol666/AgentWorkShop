"""Build an object-editable diagrams.net copy of the current Figure 5 CSVs."""
from __future__ import annotations

import csv
import math
import statistics
import xml.etree.ElementTree as ET
from pathlib import Path

DATA = Path(__file__).resolve().parent
PAIRED_CSV = DATA / "paired-delta.csv"
ABLATION_CSV = DATA / "window_ablation.csv"
OUTPUT = DATA / "fig5-editable.drawio"

INK = "#202B34"
NAVY = "#23415A"
TEAL = "#167D86"
AMBER = "#B56B24"
GRID = "#D7DDE0"
FONT = "Times New Roman"
PAGE_WIDTH = 1032
PAGE_HEIGHT = 640

SCENES = [
    ("injection", "Injection (g·s)", NAVY, (150.0, 202.0), (160, 180, 200), 91, 333),
    ("wwtp", "Wastewater ((mg/L)·s)", TEAL, (600.0, 642.0), (600, 620, 640), 412, 649),
    ("anneal", "Annealing (HV·s)", AMBER, (7850.0, 8160.0), (7900, 8000, 8100), 730, 1005),
]
ARMS = [
    ("full", "Full guard", 0),
    ("no-interlock", "Window check removed", 6),
    ("no-readback", "Readback check removed", 0),
    ("ungated", "Window + readback removed", 6),
]
KINDS = ("below-window", "above-window")


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


paired = read_csv(PAIRED_CSV)
ablation = read_csv(ABLATION_CSV)
assert len(paired) == 9, f"expected 9 valid paired deltas, found {len(paired)}"
assert len(ablation) == 24, f"expected 24 guard-ablation requests, found {len(ablation)}"
scene_names = {scene[0] for scene in SCENES}
assert {row["scene"] for row in paired} == scene_names
for scene in scene_names:
    scene_rows = [row for row in paired if row["scene"] == scene]
    assert len(scene_rows) == 3, f"expected 3 valid paired deltas for {scene}"
    assert len({int(row["seed"]) for row in scene_rows}) == 3
    assert all(math.isfinite(float(row["delta_iae"])) for row in scene_rows)

ablation_matrix: dict[tuple[str, int, str], str] = {}
for arm, _, _ in ARMS:
    for rep in (1, 2, 3):
        for kind in KINDS:
            matches = [row for row in ablation
                       if row["arm"] == arm
                       and int(row["rep"]) == rep
                       and row["kind"] == kind]
            assert len(matches) == 1, f"expected one row for {arm}/{rep}/{kind}"
            status = matches[0]["status"]
            assert status in ("200", "400"), f"unexpected HTTP status {status}"
            ablation_matrix[arm, rep, kind] = status

counts = {
    arm: sum(ablation_matrix[arm, rep, kind] == "200"
             for rep in (1, 2, 3) for kind in KINDS)
    for arm, _, _ in ARMS
}
assert counts == {arm: expected for arm, _, expected in ARMS}


mxfile = ET.Element("mxfile", host="app.diagrams.net", version="24.7.17", type="device")
diagram = ET.SubElement(mxfile, "diagram", id="figure5", name="Figure 5")
model = ET.SubElement(
    diagram, "mxGraphModel", dx=str(PAGE_WIDTH), dy=str(PAGE_HEIGHT), grid="1",
    gridSize="10", page="1", pageScale="1", pageWidth=str(PAGE_WIDTH),
    pageHeight=str(PAGE_HEIGHT), background="#ffffff",
)
root = ET.SubElement(model, "root")
ET.SubElement(root, "mxCell", id="0")
ET.SubElement(root, "mxCell", id="1", parent="0")
next_id = 2


def add_cell(value: str, x: float, y: float, width: float, height: float,
             style: str, *, edge: bool = False) -> ET.Element:
    global next_id
    cell = ET.SubElement(root, "mxCell", id=str(next_id), value=value,
                         style=style, parent="1",
                         **({"edge": "1"} if edge else {"vertex": "1"}))
    next_id += 1
    ET.SubElement(cell, "mxGeometry", x=str(x), y=str(y), width=str(width),
                  height=str(height), **{"as": "geometry"})
    return cell


def text(label: str, x: float, y: float, width: float, height: float = 22,
         *, size: float = 18, color: str = INK, bold: bool = False,
         align: str = "left", rotation: int = 0) -> None:
    style = (
        "text;html=0;whiteSpace=wrap;overflow=hidden;strokeColor=none;"
        f"fillColor=none;fontColor={color};fontFamily={FONT};fontSize={size};"
        f"fontStyle={1 if bold else 0};align={align};verticalAlign=middle;spacing=0;"
        f"rotation={rotation};"
    )
    add_cell(label, x, y, width, height, style)


def rect(x: float, y: float, width: float, height: float, color: str) -> None:
    add_cell("", x, y, width, height,
             f"shape=rectangle;rounded=0;html=0;strokeColor=none;fillColor={color};")


def marker(x: float, y: float, *, fill: str, stroke: str, square: bool = False,
           diameter: float = 12) -> None:
    shape = "rectangle" if square else "ellipse"
    add_cell("", x - diameter / 2, y - diameter / 2, diameter, diameter,
             f"shape={shape};html=0;strokeColor={stroke};fillColor={fill};strokeWidth=1.5;")


def dashed_vertical(x: float, y1: float, y2: float, color: str) -> None:
    y = y1
    while y < y2:
        height = min(7, y2 - y)
        rect(x - 1, y, 2, height, color)
        y += 12


def x_position(value: float, limits: tuple[float, float], left: float, right: float) -> float:
    low, high = limits
    assert low <= value <= high, f"value {value} lies outside [{low}, {high}]"
    return left + (value - low) / (high - low) * (right - left)


text("(a) Fixed-horizon process comparison", 25, 7, 700, size=19, bold=True)
text("Delta IAE = IAE(C0) - IAE(C1); positive values favor the script. Horizontal scales are scene-specific.",
     25, 31, 980, size=17)

plot_top = 93
plot_bottom = 189
for scene, title, color, limits, ticks, plot_left, plot_right in SCENES:
    width = plot_right - plot_left
    text(title, plot_left - 18, 61, width + 36, size=18.4, bold=True, align="center")
    rows = sorted((row for row in paired if row["scene"] == scene),
                  key=lambda row: int(row["seed"]))
    for tick in ticks:
        x = x_position(tick, limits, plot_left, plot_right)
        rect(x, plot_top, 0.8, plot_bottom - plot_top, GRID)
        text(str(tick), x - 27, 191, 54, 19, size=16, align="center")
    median = statistics.median(float(row["delta_iae"]) for row in rows)
    dashed_vertical(x_position(median, limits, plot_left, plot_right),
                    plot_top, plot_bottom, INK)
    for index, row in enumerate(rows):
        y = plot_bottom - ((index + 0.5) / len(rows)) * (plot_bottom - plot_top)
        text(str(int(row["seed"])), plot_left - 43, y - 9, 34, 18,
             size=16, align="right")
        x = x_position(float(row["delta_iae"]), limits, plot_left, plot_right)
        marker(x, y, fill=color, stroke=color, diameter=11)
    rect(plot_left, plot_bottom, plot_right - plot_left, 1.4, INK)
    rect(plot_left, plot_top, 1.4, plot_bottom - plot_top, INK)
text("Seed", 31, 129, 42, 20, size=16, color=INK, align="center", rotation=270)
text("Points: valid pairs; dashed lines: scene medians. Invalid C0 gaps: wastewater seed 45 (9 s), annealing seed 46 (6 s).",
     25, 236, 980, 20, size=17)
text("Separate injection seed-43 pilot (ΔIAE = 163.240 g·s) is not plotted.",
     25, 261, 980, 20, size=17)

text("(b) Process-window guard ablation", 25, 288, 700, 22, size=19, bold=True)
text("Three technical repetitions per arm; benchmark mode.", 25, 311, 700, 20, size=17)

marker_x = (460, 520, 625, 685, 790, 850)
for rep in range(3):
    center = (marker_x[rep * 2] + marker_x[rep * 2 + 1]) / 2
    text(f"Rep. {rep + 1}", center - 52, 367, 104, 20, size=17, align="center")
for index, x in enumerate(marker_x):
    text("Below" if index % 2 == 0 else "Above", x - 32, 405, 64, 20,
         size=17, align="center")
text("HTTP 200 / 6", 885, 405, 125, 20, size=17, align="right")

row_y = (444, 479, 514, 549)
for y, (arm, label, expected_count) in zip(row_y, ARMS):
    text(label, 25, y - 11, 370, 22, size=17)
    for rep in (1, 2, 3):
        for kind_index, kind in enumerate(KINDS):
            x = marker_x[(rep - 1) * 2 + kind_index]
            status = ablation_matrix[arm, rep, kind]
            if status == "200":
                marker(x, y, fill=AMBER, stroke=AMBER, square=True, diameter=12)
            else:
                marker(x, y, fill="#ffffff", stroke=NAVY, diameter=12)
    text(f"{counts[arm]}/6", 930, y - 11, 78, 22, size=17, align="right")

text("Open circle: HTTP 400 (rejected)  |  filled square: HTTP 200",
     25, 591, 980, 20, size=17)
text("No readback-mismatch stimulus was included; HTTP status does not prove a driver call.",
     25, 615, 980, 20, size=17)

ET.ElementTree(mxfile).write(OUTPUT, encoding="utf-8", xml_declaration=True)
print(f"Wrote {OUTPUT.name} with {next_id - 2} native editable draw.io objects.")

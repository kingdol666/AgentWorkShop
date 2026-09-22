# -*- coding: utf-8 -*-
"""Figure 1 (hero) builder: governed industrial agent platform, HTML+SVG.

Concept drafted by gpt-image-2.5 (fig1-governed-platform-concept.png), rebuilt
here as an exact print-grade vector schematic.

Design contract
  * canvas 1810 x 740 px at 0.1 mm/px  ->  181 x 74 mm (IEEE text width)
  * minimum text 29 px = 8.2 pt at print size (house floor 8 pt, IEEE floor 6 pt)
  * palette: navy #35576A (agent side) / teal #367D82 (plant side) /
    amber #C8871B (governance) / ink #25333B; panel (a) desaturated + red x-chips
  * narrative: (a) direct agent access -- three open questions;
    (b) this work -- the same three questions answered (who writes / which
    limits / write-outcome), governance spine on the write path, shared
    context rail, evidence loop back to the team
  * icons: Lucide v0.469.0 (ISC), cached in fig1-icons/, inlined as <g>
  * QA: PyMuPDF -- page size, min font, span overlaps, spans outside canvas

Output: fig1-governed-platform.{html,pdf,png,grayscale.png} + qa json
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import fitz

HERE = Path(__file__).resolve().parent
ICONS = HERE / "fig1-icons"
STEM = "fig1-governed-platform"
W, H = 1810, 740
MM = 181.0
PDF_PT = (MM * 72 / 25.4, 74.0 * 72 / 25.4)
DPI = 300
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

INK = "#25333b"
SUB = "#4a545c"
NAVY = "#35576a"
TEAL = "#367d82"
AMBER = "#c8871b"
GREY = "#7e8b93"
RULE = "#d5dbde"
PALE = "#f4f6f7"
PALE_NAVY = "#eef2f3"
PALE_TEAL = "#edf5f5"
PALE_AMBER = "#fbf3e6"
BAD = "#a65a4a"
BAD_FILL = "#faf0ee"

_cache: dict[str, str] = {}


def icon(name: str, cx: float, cy: float, px: float, color: str) -> str:
    if name not in _cache:
        raw = (ICONS / f"{name}.svg").read_text(encoding="utf-8")
        inner = re.sub(r"^.*?<svg[^>]*>", "", raw, flags=re.S)
        inner = re.sub(r"</svg>\s*$", "", inner, flags=re.S)
        _cache[name] = inner
    s = px / 24.0
    return (f'<g transform="translate({cx - px / 2:.1f},{cy - px / 2:.1f}) scale({s:.4f})" '
            f'fill="none" stroke="{color}" stroke-width="{2.3 / s:.3f}" '
            f'stroke-linecap="round" stroke-linejoin="round">{_cache[name]}</g>')


def tw(s: str, size: float, bold: bool = False) -> float:
    return len(s) * size * (0.545 if bold else 0.475)


def T(x: float, y: float, s: str, size: float, *, bold: bool = False,
      color: str = INK, anchor: str = "middle", italic: bool = False) -> str:
    style = ' font-style="italic"' if italic else ""
    weight = ' font-weight="bold"' if bold else ""
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}"{weight}{style} '
            f'fill="{color}" text-anchor="{anchor}">{s}</text>')


def R(x: float, y: float, w: float, h: float, *, rx: float = 12,
      stroke: str, fill: str, sw: float = 2.0, dash: str | None = None) -> str:
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
            f'rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')


def seg(x1: float, y1: float, x2: float, y2: float, color: str,
        sw: float = 2.2, dash: str | None = None) -> str:
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{color}" stroke-width="{sw}"{d}/>')


def poly(pts: list[tuple[float, float]], color: str, sw: float = 2.2) -> str:
    p = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    return f'<polyline points="{p}" fill="none" stroke="{color}" stroke-width="{sw}"/>'


def arrow_head(x: float, y: float, direction: str, color: str,
               length: float = 13.0, width: float = 9.0) -> str:
    if direction == "right":
        pts = [(x - length, y - width / 2), (x, y), (x - length, y + width / 2)]
    elif direction == "left":
        pts = [(x + length, y - width / 2), (x, y), (x + length, y + width / 2)]
    elif direction == "up":
        pts = [(x - width / 2, y + length), (x, y), (x + width / 2, y + length)]
    else:
        pts = [(x - width / 2, y - length), (x, y), (x + width / 2, y - length)]
    p = " ".join(f"{a:.1f},{b:.1f}" for a, b in pts)
    return f'<polygon points="{p}" fill="{color}"/>'


def arrow(x1: float, y1: float, x2: float, y2: float, color: str,
          direction: str, sw: float = 2.2) -> str:
    if direction == "right":
        return seg(x1, y1, x2 - 11, y2, color, sw) + arrow_head(x2, y2, direction, color)
    if direction == "left":
        return seg(x1, y1, x2 + 11, y2, color, sw) + arrow_head(x2, y2, direction, color)
    if direction == "up":
        return seg(x1, y1, x2, y2 + 11, color, sw) + arrow_head(x2, y2, direction, color)
    return seg(x1, y1, x2, y2 - 11, color, sw) + arrow_head(x2, y2, direction, color)


def check_mark(cx: float, cy: float, color: str, s: float = 1.0) -> str:
    return poly([(cx - 7 * s, cy), (cx - 2 * s, cy + 5 * s),
                 (cx + 8 * s, cy - 6 * s)], color, 3.0)


def cross_mark(cx: float, cy: float, color: str, s: float = 1.0) -> str:
    return (poly([(cx - 6 * s, cy - 6 * s), (cx + 6 * s, cy + 6 * s)], color, 3.0)
            + poly([(cx + 6 * s, cy - 6 * s), (cx - 6 * s, cy + 6 * s)], color, 3.0))


def chip(cx: float, cy: float, text: str, color: str, fill: str,
         mark: str = "check") -> str:
    """Rounded answer chip: drawn check/cross glyph + label."""
    w = tw(text, 29) + 52
    h = 34
    x0, y0 = cx - w / 2, cy - h / 2
    mark_el = (check_mark(x0 + 22, cy, color, 1.15) if mark == "check"
               else cross_mark(x0 + 22, cy, color, 1.0))
    return "".join([R(x0, y0, w, h, rx=17, stroke=color, fill=fill, sw=1.6),
                    mark_el,
                    T(x0 + 40, cy + 10, text, 29, color=color, anchor="start")])


# ── panel (a): direct, ungoverned agent access ──────────────────────────────
def panel_a() -> list[str]:
    o: list[str] = []
    o.append(T(30, 46, "(a) Direct agent access", 34, bold=True, anchor="start"))
    # agent card
    o.append(R(60, 100, 210, 130, stroke=GREY, fill=PALE, sw=1.8))
    o.append(icon("bot", 165, 152, 48, GREY))
    o.append(T(165, 218, "LLM agent", 29))
    # raw write arrow straight down into the plant
    o.append(seg(165, 230, 165, 420, GREY, 3.6))
    o.append(arrow_head(165, 433, "down", GREY, 15, 12))
    o.append(T(165, 254, "raw writes", 29, color=SUB))
    # plant card
    o.append(R(60, 446, 210, 130, stroke=GREY, fill=PALE, sw=1.8))
    o.append(icon("factory", 165, 498, 48, GREY))
    o.append(T(165, 564, "PLC / plant", 29))
    # three open questions along the arrow
    for i, row in enumerate(("who may write", "which limits", "write \u2194 outcome")):
        o.append(chip(370, 275 + i * 65, row, BAD, BAD_FILL, mark="cross"))
    # footnote
    o.append(T(60, 640, "task completed \u2260 process attained", 29, color=SUB,
               anchor="start", italic=True))
    return o


# ── panel (b): AgentWorkShop governed platform ──────────────────────────────
AGENT_X, AGENT_W = 560, 360          # agent zone 560..920
SPINE_X, SPINE_W = 950, 220          # governance spine 950..1170
PLANT_X, PLANT_W = 1200, 580         # plant zone 1200..1780
ZONE_Y, ZONE_H = 150, 340            # zones 150..490
BUS_Y = 118


def zone_card(x: int, y: int, w: int, ic: str, icon_color: str,
              title: str, sub: str) -> list[str]:
    o = [R(x, y, w, 76, rx=10, stroke=icon_color, fill="#ffffff", sw=1.6),
         icon(ic, x + 36, y + 38, 40, icon_color),
         T(x + 68, y + 34, title, 29, bold=True, anchor="start"),
         T(x + 68, y + 64, sub, 29, color=SUB, anchor="start")]
    return o


def gate(y: int, label: str) -> list[str]:
    return [R(SPINE_X, y, SPINE_W, 64, rx=10, stroke=AMBER, fill=PALE_AMBER, sw=2.0),
            icon("clipboard-check", SPINE_X + 34, y + 32, 30, AMBER),
            T(SPINE_X + 60, y + 42, label, 29, bold=True, color=AMBER,
              anchor="start")]


def answer_line(y: float, text: str) -> list[str]:
    return [check_mark(SPINE_X + 34, y, TEAL, 1.15),
            T(SPINE_X + 52, y + 10, text, 29, color=TEAL, anchor="start")]


def panel_b() -> list[str]:
    o: list[str] = []
    o.append(T(560, 46, "(b) AgentWorkShop: governed agent\u2013plant loop",
               34, bold=True, anchor="start"))

    # entry surfaces drop onto one bus, the bus drops into the agent side
    entries = (("monitor", "console"), ("terminal", "TUI"), ("network", "MCP"),
               ("users", "A2A"), ("puzzle", "plugin"))
    ex = 690
    for ic, label in entries:
        o.append(R(ex, 66, 176, 36, rx=18, stroke=GREY, fill="#ffffff", sw=1.6))
        o.append(icon(ic, ex + 26, 84, 26, GREY))
        o.append(T(ex + 46, 94, label, 29, anchor="start"))
        o.append(seg(ex + 88, 102, ex + 88, BUS_Y, GREY, 1.4))
        ex += 196
    o.append(seg(690 + 88, BUS_Y, 690 + 4 * 196 + 88, BUS_Y, GREY, 1.6))
    o.append(seg(740, BUS_Y, 740, ZONE_Y - 4, GREY, 1.6))
    o.append(arrow_head(740, ZONE_Y, "down", GREY, 11, 8))

    # agent side zone
    o.append(R(AGENT_X, ZONE_Y, AGENT_W, ZONE_H, rx=14, stroke=NAVY,
               fill=PALE_NAVY, sw=2.0))
    o.append(T(AGENT_X + AGENT_W / 2, 186, "agent side", 30, bold=True, color=NAVY))
    o.extend(zone_card(584, 204, 312, "layers", NAVY,
                       "Harness registry", "14 agent engines"))
    o.extend(zone_card(584, 296, 312, "users", NAVY,
                       "Agent team", "lead + workers"))
    o.extend(zone_card(584, 388, 312, "wrench", NAVY,
                       "Governed tools", "48 semantic cards"))
    # request into the governance spine
    o.append(arrow(920, 202, 946, 202, NAVY, "right"))

    # governance spine: binding -> checks -> write, each with its answer
    o.extend(gate(170, "binding"))
    o.extend(answer_line(252, "who writes"))
    o.append(arrow(SPINE_X + SPINE_W / 2, 264, SPINE_X + SPINE_W / 2, 280,
                   AMBER, "down"))
    o.extend(gate(284, "checks"))
    o.extend(answer_line(366, "which limits"))
    o.append(arrow(SPINE_X + SPINE_W / 2, 378, SPINE_X + SPINE_W / 2, 394,
                   AMBER, "down"))
    o.extend(gate(398, "write"))
    # interlocked write into the plant side
    o.append(arrow(1170, 430, 1196, 430, AMBER, "right"))

    # plant side zone
    o.append(R(PLANT_X, ZONE_Y, PLANT_W, ZONE_H, rx=14, stroke=TEAL,
               fill=PALE_TEAL, sw=2.0))
    o.append(T(PLANT_X + PLANT_W / 2, 186, "plant side", 30, bold=True, color=TEAL))
    o.extend(zone_card(1224, 204, 532, "cpu", TEAL,
                       "DAQ / DCW nodes", "engineering quantities"))
    o.extend(zone_card(1224, 296, 532, "radio", TEAL,
                       "Protocol drivers", "Modbus \u00b7 OPC UA \u00b7 MQTT \u00b7 HTTP"))
    o.extend(zone_card(1224, 388, 532, "factory", TEAL,
                       "Physical plant", "four scenarios evaluated"))

    # shared production context rail feeds the governance spine
    o.append(R(560, 510, 860, 42, rx=10, stroke="#b8c2c7", fill=PALE_NAVY, sw=1.6))
    o.append(T(990, 538, "shared production context \u2014 line \u00b7 product \u00b7 "
               "recipe \u00b7 run", 29))
    o.append(seg(1060, 462, 1060, 510, "#8a979e", 1.8, dash="7,6"))

    # intervention record (evidence) and the return to the team
    o.append(arrow(1490, ZONE_Y + ZONE_H, 1490, 572, TEAL, "down"))
    o.append(T(1512, 540, "process follows", 29, color=TEAL, anchor="start"))
    o.append(R(1120, 576, 660, 96, rx=12, stroke=TEAL, fill="#ffffff", sw=2.2))
    o.append(icon("file-text", 1150, 606, 40, TEAL))
    o.append(T(1178, 614, "Intervention record", 29, bold=True, anchor="start"))
    o.append(check_mark(1186, 641, TEAL, 1.1))
    o.append(T(1204, 651, "proposal \u2192 result \u2192 observation \u2192 verdict",
               29, color=TEAL, anchor="start"))
    o.append(seg(1120, 608, 744, 608, TEAL))
    o.append(arrow(740, 608, 740, 494, TEAL, "up"))
    o.append(T(930, 596, "verdict recorded", 29, color=TEAL))

    # digital twin observes the shared data, never actuates
    o.append(seg(720, 552, 720, 616, "#8a979e", 1.6, dash="5,5"))
    o.append(R(560, 620, 320, 70, rx=12, stroke=GREY, fill="#ffffff", sw=1.6,
               dash="7,6"))
    o.append(icon("eye", 592, 655, 38, GREY))
    o.append(T(620, 648, "Digital twin", 29, bold=True, anchor="start"))
    o.append(T(620, 678, "observes only", 29, color=SUB, anchor="start"))

    o.append(T(1170, 728, "* Fast PLC regulation and plant protection remain "
               "outside the agent-team loop", 29, color=SUB, italic=True))
    return o


def build_svg() -> str:
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{MM:g}mm" height="74mm" '
             f'viewBox="0 0 {W} {H}" style="font-family:\'Times New Roman\',Times,serif">',
             f'<rect width="{W}" height="{H}" fill="#ffffff"/>']
    parts.extend(panel_a())
    parts.append(seg(530, 24, 530, 706, RULE, 1.4))
    parts.extend(panel_b())
    parts.append("</svg>")
    return "".join(parts)


def main() -> None:
    svg = build_svg()
    html = ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
            f"@page {{ size: {MM:g}mm 74mm; margin: 0; }} "
            "html, body { margin: 0; padding: 0; } "
            "svg { display: block; }</style></head>"
            f"<body>{svg}</body></html>")
    (HERE / f"{STEM}.html").write_text(html, encoding="utf-8")

    import subprocess
    pdf = HERE / f"{STEM}.pdf"
    subprocess.run([CHROME, "--headless=new", "--disable-gpu",
                    "--no-pdf-header-footer",
                    "--run-all-compositor-stages-before-draw",
                    "--virtual-time-budget=4000",
                    f"--print-to-pdf={pdf}", (HERE / f"{STEM}.html").as_uri()],
                   check=True, capture_output=True)

    doc = fitz.open(pdf)
    page = doc[0]
    size = (round(page.rect.width, 2), round(page.rect.height, 2))
    fonts = page.get_fonts(full=True)
    spans = [s for b in page.get_text("dict")["blocks"] if "lines" in b
             for line in b["lines"] for s in line["spans"] if s["text"].strip()]
    outside = [s["text"] for s in spans
               if not page.rect.contains(fitz.Rect(s["bbox"]))]
    overlaps = []
    for i, first in enumerate(spans):
        for second in spans[i + 1:]:
            inter = fitz.Rect(first["bbox"]) & fitz.Rect(second["bbox"])
            if inter.width > 1.0 and inter.height > 3.0:
                overlaps.append([first["text"], second["text"]])
    page.get_pixmap(dpi=DPI, alpha=False).save(HERE / f"{STEM}.png")
    page.get_pixmap(dpi=DPI, colorspace=fitz.csGRAY, alpha=False).save(
        HERE / f"{STEM}-grayscale.png")
    qa = {
        "figure": STEM,
        "generator": Path(__file__).name,
        "concept": "gpt-image-2.5 storyboard (fig1-governed-platform-concept.png)",
        "size_pt": size,
        "expected_pt": [round(PDF_PT[0], 2), round(PDF_PT[1], 2)],
        "embedded_fonts": sorted({f[3] for f in fonts}),
        "min_font_pt": round(min(s["size"] for s in spans), 2),
        "text_spans": len(spans),
        "spans_outside_canvas": outside,
        "text_overlap_pairs": overlaps,
        "icons": sorted(_cache),
    }
    doc.close()
    ok = (abs(size[0] - qa["expected_pt"][0]) <= 0.6
          and abs(size[1] - qa["expected_pt"][1]) <= 0.6
          and qa["min_font_pt"] >= 8.0 and not outside and not overlaps)
    (HERE / f"{STEM}-qa.json").write_text(json.dumps(qa, indent=2) + "\n",
                                          encoding="utf-8")
    print(json.dumps(qa, indent=2))
    if not ok:
        raise SystemExit("QA FAILED")
    print("QA PASS")


if __name__ == "__main__":
    main()

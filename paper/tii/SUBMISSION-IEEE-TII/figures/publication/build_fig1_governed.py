# -*- coding: utf-8 -*-
"""Figure 1 (v2) builder: governed member-node binding, HTML+SVG emission.

Design contract
  * canvas 1810 x 690 px at 0.1 mm/px  ->  181 x 69 mm (IEEE text width,
    matched to the previous figure's height so pagination is unchanged)
  * minimum text 29 px = 8.2 pt at print size (house floor 8 pt, IEEE floor 6 pt)
  * palette: navy #35576A (agent side) / teal #367D82 (industrial side) /
    amber #C8871B (governance) / ink #25333B; panel (a) is desaturated on purpose
  * icons: Lucide v0.469.0 (ISC), cached in fig1-icons/, inlined as <g>
  * QA: PyMuPDF -- page size, min font, span overlaps, spans outside canvas

Output: fig1-governed-binding.{html,pdf,png,grayscale.png} + qa json
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import fitz

HERE = Path(__file__).resolve().parent
ICONS = HERE / "fig1-icons"
STEM = "fig1-governed-binding"
W, H = 1810, 690
MM = 181.0
PDF_PT = (MM * 72 / 25.4, 69.0 * 72 / 25.4)
DPI = 300
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

INK = "#25333b"
SUB = "#4a545c"
NAVY = "#35576a"
TEAL = "#367d82"
AMBER = "#c8871b"
GREY = "#7e8b93"
DEVMUTE = "#6e969a"
RULE = "#d5dbde"
PALE = "#f4f6f7"
PALE_NAVY = "#eef2f3"
PALE_TEAL = "#edf5f5"
PALE_AMBER = "#fbf3e6"
BAD = "#a65a4a"

_cache: dict[str, str] = {}


def icon(name: str, cx: float, cy: float, px: float, color: str) -> str:
    """Inline a cached Lucide icon centred at (cx, cy), scaled to px."""
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
    """Conservative Times advance-width estimate (px)."""
    return len(s) * size * (0.545 if bold else 0.475)


def T(x: float, y: float, s: str, size: float, *, bold: bool = False,
      color: str = INK, anchor: str = "middle", italic: bool = False) -> str:
    style = ' font-style="italic"' if italic else ""
    weight = ' font-weight="bold"' if bold else ""
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}"{weight}{style} '
            f'fill="{color}" text-anchor="{anchor}">{s}</text>')


def R(x: float, y: float, w: float, h: float, *, rx: float = 12,
      stroke: str, fill: str, sw: float = 2.0) -> str:
    return (f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
            f'rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')


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
    """Straight arrow; head consumes 13 px of the run."""
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


def chip(cx: float, cy: float, text: str, color: str, fill: str) -> str:
    """Rounded answer chip: drawn check glyph + label."""
    w = tw(text, 29) + 52
    h = 34
    x0, y0 = cx - w / 2, cy - h / 2
    out = [R(x0, y0, w, h, rx=17, stroke=color, fill=fill, sw=1.6),
           check_mark(x0 + 22, cy, color, 1.15),
           T(x0 + 40, cy + 10, text, 29, color=color, anchor="start")]
    return "".join(out)


# ── panel (a): application-specific integration (desaturated) ───────────────
def panel_a() -> list[str]:
    o: list[str] = []
    o.append(T(34, 48, "(a) Application-specific integration", 34, bold=True,
               anchor="start"))
    rows = ((1, 78, "factory"), (2, 218, "database"), (3, 358, "gauge"))
    for n, y, dev_icon in rows:
        cy = y + 120 / 2
        # agent
        o.append(R(34, y, 168, 120, stroke=GREY, fill=PALE, sw=1.8))
        o.append(icon("bot", 118, y + 46, 44, GREY))
        o.append(T(118, y + 100, f"Agent {n}", 29))
        # duplicated middleware stack
        o.append(R(246, y, 210, 120, stroke=GREY, fill=PALE, sw=1.8))
        for label, ly in (("Driver", y + 34), ("Permission", y + 64), ("Log", y + 94)):
            o.append(T(351, ly, label, 29, color=SUB))
        for ry in (y + 49, y + 79):
            o.append(seg(258, ry, 444, ry, "#c4ccd0", 1.2))
        # device
        o.append(R(500, y, 168, 120, stroke=DEVMUTE, fill="#eef4f4", sw=1.8))
        o.append(icon(dev_icon, 584, y + 46, 44, DEVMUTE))
        o.append(T(584, y + 100, f"Device {n}", 29))
        # links
        o.append(arrow(204, cy, 244, cy, GREY, "right", 2.0))
        o.append(arrow(458, cy, 498, cy, GREY, "right", 2.0))
    # duplication bracket under the middleware column
    o.append(poly([(246, 482), (246, 496), (456, 496), (456, 482)], GREY, 2.0))
    o.append(T(351, 526, "Duplicated per application", 29, bold=True))
    # open questions card
    o.append(R(34, 550, 634, 130, stroke="#b8c2c7", fill="#fafbfb", sw=1.4, rx=10))
    o.append(T(56, 582, "Open on the write path", 29, bold=True, color=SUB, anchor="start"))
    for i, row in enumerate(("who is authorized", "which limits apply",
                             "write \u2194 outcome link")):
        ry = 610 + i * 26
        o.append(cross_mark(66, ry - 8, BAD, 0.85))
        o.append(T(84, ry, row, 29, color=SUB, anchor="start"))
    return o


# ── panel (b): governed member-node binding (this work) ─────────────────────
CARDS = [  # (x, w, edge, face, icon, title lines, sub lines)
    (744, 204, NAVY, "#ffffff", "users", ["Channel"], ["lead + workers"]),
    (996, 240, NAVY, PALE_NAVY, "network", ["Member\u2013node", "binding"], []),
    (1332, 196, TEAL, PALE_TEAL, "cpu", ["DAQ / DCW", "nodes"],
     ["engineering", "quantities"]),
    (1584, 192, TEAL, PALE_TEAL, "factory", ["Plant", "devices"], ["5 protocols"]),
]
FLOW_Y0, FLOW_H = 78, 174
ARROW_Y = FLOW_Y0 + 87


def card(x: int, w: int, edge: str, face: str, ic: str,
         titles: list[str], subs: list[str]) -> list[str]:
    o = [R(x, FLOW_Y0, w, FLOW_H, stroke=edge, fill=face, sw=2.0)]
    cx = x + w / 2
    o.append(icon(ic, cx, FLOW_Y0 + 30, 42, edge))
    if len(titles) == 1:
        y = FLOW_Y0 + 88
    else:
        y = FLOW_Y0 + 80
        o.append(T(cx, y, titles[0], 31, bold=True))
        y += 30
    o.append(T(cx, y, titles[-1], 31, bold=True))
    y = FLOW_Y0 + (132 if len(titles) == 1 else 134)
    for s in subs:
        o.append(T(cx, y, s, 29, color=SUB))
        y += 26
    return o


def panel_b() -> list[str]:
    o: list[str] = []
    o.append(T(744, 48, "(b) AgentWorkShop member\u2013node binding (this work)",
               34, bold=True, anchor="start"))

    # forward write path: binding -> [gate] -> nodes -> plant
    o.append(arrow(948, ARROW_Y, 994, ARROW_Y, NAVY, "right"))
    o.append(arrow(1236, ARROW_Y, 1330, ARROW_Y, AMBER, "right"))
    o.append(arrow(1528, ARROW_Y, 1582, ARROW_Y, TEAL, "right"))
    for x, w, edge, face, ic, titles, subs in CARDS:
        o.extend(card(x, w, edge, face, ic, titles, subs))
    # answer chip on binding card
    o.append(chip(1116, FLOW_Y0 + 152, "who writes", TEAL, "#ffffff"))
    # governance gate glyph riding the write arrow
    o.append(R(1262, ARROW_Y - 22, 44, 44, rx=11, stroke=AMBER, fill=PALE_AMBER, sw=2.2))
    o.append(icon("clipboard-check", 1284, ARROW_Y, 30, AMBER))
    o.append(seg(1284, ARROW_Y + 27, 1284, 246, AMBER, 1.4, dash="3,5"))
    o.append(chip(1284, 276, "which limits", AMBER, "#ffffff"))
    o.append(T(1284, 316, "recipe \u00b7 approval \u00b7 range", 29, color=AMBER))

    # shared production context rail (read by binding and gate)
    o.append(R(996, 330, 404, 42, rx=10, stroke="#b8c2c7", fill=PALE_NAVY, sw=1.6))
    o.append(T(1198, 358, "line \u00b7 product \u00b7 recipe \u00b7 run", 29))
    o.append(seg(1040, FLOW_Y0 + FLOW_H, 1040, 330, "#8a979e", 1.8, dash="7,6"))

    # stage captions with dotted leaders tying each to its own arrow
    o.append(seg(972, ARROW_Y + 13, 972, 250, "#8a979e", 1.4, dash="3,5"))
    o.append(T(972, 276, "request", 29, color=SUB))
    o.append(seg(1556, ARROW_Y + 13, 1556, 250, "#8a979e", 1.4, dash="3,5"))
    o.append(T(1556, 276, "process follows", 29, color=SUB))

    # evidence loop
    o.append(arrow(1430, FLOW_Y0 + FLOW_H, 1430, 414, TEAL, "down"))
    o.append(seg(1680, FLOW_Y0 + FLOW_H, 1680, 516, TEAL))
    o.append(seg(1680, 516, 1557, 516, TEAL))
    o.append(arrow_head(1544, 516, "left", TEAL))
    o.append(T(1444, 352, "readback", 29, color=TEAL, anchor="start"))
    o.append(T(1612, 548, "process", 29, color=TEAL))

    # intervention record
    o.append(R(1000, 416, 540, 150, stroke=TEAL, fill="#ffffff", sw=2.2, rx=12))
    o.append(icon("file-text", 1028, 446, 44, TEAL))
    o.append(T(1062, 454, "Intervention record", 31, bold=True, anchor="start"))
    chain = (("proposal", 121), ("result", 90), ("observation", 154), ("verdict", 102))
    cx = 1024
    for label, cw in chain:
        o.append(R(cx, 474, cw, 36, rx=8, stroke="#9fc0c2", fill=PALE_TEAL, sw=1.4))
        o.append(T(cx + cw / 2, 499, label, 29, color=TEAL))
        cx += cw + 8
    o.append(chip(1270, 542, "write \u2194 outcome", TEAL, "#ffffff"))

    # return path to the channel (single arrowhead at the terminus)
    o.append(seg(1000, 466, 846, 466, TEAL))
    o.append(arrow(846, 466, 846, 254, TEAL, "up"))
    o.append(T(890, 496, "verdict recorded", 29, color=TEAL))

    o.append(T(1260, 648, "* Readback where supported \u00b7 fast PLC regulation "
               "stays outside the loop", 29, color=SUB, italic=True))
    return o


def build_svg() -> str:
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{MM:g}mm" height="69mm" '
             f'viewBox="0 0 {W} {H}" style="font-family:\'Times New Roman\',Times,serif">',
             f'<rect width="{W}" height="{H}" fill="#ffffff"/>']
    parts.extend(panel_a())
    parts.append(seg(722, 26, 722, 664, RULE, 1.4))
    parts.extend(panel_b())
    parts.append("</svg>")
    return "".join(parts)


def main() -> None:
    svg = build_svg()
    html = ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
            f"@page {{ size: {MM:g}mm 69mm; margin: 0; }} "
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

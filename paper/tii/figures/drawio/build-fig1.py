# -*- coding: utf-8 -*-
"""Fig. 1 generator: AgentWorkShop integration framework.

Single source of truth for the architecture figure. Emits
  * fig1-arch-print.svg   -- print-scale SVG rendered to PDF by Chrome
  * fig1-architecture.drawio -- editable drawio master, same content

Design constraint that drives every number here: the figure is placed at the
IEEE single-column-span text width (181 mm).  A font of F px on a canvas of W px
prints at F/W * 181 mm, so legibility is a ratio, not an absolute size.  IEEE
wants >= 6 pt (= 2.12 mm) for figure text; at W = 1500 px that means every
font size must be >= 18 px.  The layout below is therefore sized around an
18-21 px type scale, and `check()` fails the build if any string would not fit
its box at that scale.
"""
import io, os, re, sys

W, H = 1500, 558           # canvas; 1500 px -> 181 mm, so 1 px = 0.1207 mm
MM_PER_PX = 181.0 / W

FS_ENTRY, FS_ENTRY_SUB = 20, 18
FS_ZONE = 22
FS_BOX, FS_BOX_SUB = 20, 18
FS_BAND, FS_BAND_SUB = 19, 18
FS_RAIL = 18

C = dict(
    blue="#3D6FB5", blue_fill="#EDF3FA",
    teal="#1F6F78", teal_fill="#E8F1F2",
    amber="#C8871B", amber_fill="#FBF3E6",
    purple="#6A4C93", purple_fill="#F0ECF7",
    grey="#5F6B76", grey_fill="#F4F6F8",
    ink="#0D1114", sub="#4A545C", band="#B9BFC6",
)

# ── layout ───────────────────────────────────────────────────────────────────
M = 16
CONTENT = W - 2 * M


def row(n, gap, y, h):
    """n boxes of equal width spanning the content area."""
    w = (CONTENT - (n - 1) * gap) / n
    return [dict(x=M + i * (w + gap), y=y, w=w, h=h) for i in range(n)]


ZONE_GAP = 26
zone_w = (CONTENT - 2 * ZONE_GAP) / 3
zones = [dict(x=M + i * (zone_w + ZONE_GAP), y=70, w=zone_w, h=360) for i in range(3)]

BOX_PAD = 14
box_w = zone_w - 2 * BOX_PAD


def zone_boxes(z):
    """Four stacked boxes inside a zone, below its title band."""
    top, gap, h = z["y"] + 42, 9, 70
    return [dict(x=z["x"] + BOX_PAD, y=top + i * (h + gap), w=box_w, h=h) for i in range(4)]


# ── content ──────────────────────────────────────────────────────────────────
ENTRY = [
    ("Web console", "approvals · pages"),
    ("TUI workbench", "same approval queue"),
    ("MCP server", "governed tool surface"),
    ("A2A endpoint", "agent-to-agent"),
    ("Plugin host", "hot reload · isolation"),
]

ZONES = [
    ("Agent half", C["blue"], C["blue_fill"], [
        ("Harness registry", "14 engines · availability probe"),
        ("Teams & channels", "lead supervision · task tree · fallback"),
        ("Hybrid memory", "FTS5 + vector · RRF + MMR · 3-layer"),
        ("Cross-channel comms", "lead-gated · in-reply routing"),
    ]),
    ("Governed bridge", C["amber"], C["amber_fill"], [
        ("Agent tool surface", "48 tools · semantic cards (unit · ranges)"),
        ("Node bindings", "manual / auto / unbound · team-scoped"),
        ("Governed write path", "check → approve → readback → journal"),
        ("Backstop (bounded autonomy)", "bounded rollback · K = 2 · escalation"),
    ]),
    ("Industrial half", C["teal"], C["teal_fill"], [
        ("Protocol drivers", "Modbus TCP/RTU · OPC UA · MQTT · HTTP"),
        ("Edge runtimes & storage", "per-node acquisition · TimescaleDB · MinIO"),
        ("Alarm chain & recipes", "warn · hysteresis · versioned runs"),
        ("Plants & scenarios", "cast-film twin · film line · devices"),
    ]),
]

BAND = [
    ("Audit plane", "signed journal · attribution", C["grey"]),
    ("Storage", "SQLite WAL · FTS5 · frames", C["grey"]),
    ("Device-twin registry", "telemetry / desired / state", C["purple"]),
    ("3D scene (three.js)", "live render · never actuates", C["purple"]),
]

# flow rail: (kind, colour, label); kind 0 = left-to-right plain, 1 = left-to-right
# with a bidirectional mark, 2 = right-to-left dashed feedback
RAIL = [
    (0, C["blue"], "proposals"),
    (1, C["teal"], "governed write ⇄ readback"),
    (2, C["grey"], "telemetry · journal · twin state (the twin observes, never actuates)"),
]

# ── text metrics + validation ────────────────────────────────────────────────
def text_w(s, size, bold=False):
    """Arial-ish advance-width estimate, in px."""
    return len(s) * (0.605 if bold else 0.552) * size


problems = []


def check(s, size, usable, where, bold=False):
    w = text_w(s, size, bold)
    if w > usable:
        problems.append(f"{where}: {size}px {w:.0f} > {usable:.0f}  \"{s}\"")
    pt = size * MM_PER_PX / 0.352778
    if pt < 5.95:
        problems.append(f"{where}: {size}px prints at {pt:.2f} pt (< 6 pt)  \"{s}\"")


for t, s in ENTRY:
    check(t, FS_ENTRY, 282 - 20, "entry.title", True)
    check(s, FS_ENTRY_SUB, 282 - 20, "entry.sub")
for zt, _, _, boxes in ZONES:
    check(zt, FS_ZONE, zone_w - 20, "zone.title", True)
    for t, s in boxes:
        check(t, FS_BOX, box_w - 16, "box.title", True)
        check(s, FS_BOX_SUB, box_w - 16, "box.sub")
band = row(4, 14, 488, 56)
for (t, s, _), b in zip(BAND, band):
    check(t, FS_BAND, b["w"] - 18, "band.title", True)
    check(s, FS_BAND_SUB, b["w"] - 18, "band.sub")
for _, _, lab in RAIL:
    check(lab, FS_RAIL, CONTENT - 40, "rail")

if problems:
    print("LAYOUT PROBLEMS:")
    for p in problems:
        print("  " + p)
    sys.exit(1)

# ── SVG ──────────────────────────────────────────────────────────────────────
def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


o = []
o.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
o.append('<rect width="100%" height="100%" fill="#ffffff"/>')
o.append('<style>text{font-family:Arial,Helvetica,sans-serif}</style>')


def box(b, title, sub, stroke, fill, fs_t, fs_s, sw=1.5, rx=7, sub_color=None):
    o.append(f'<rect x="{b["x"]:.1f}" y="{b["y"]:.1f}" width="{b["w"]:.1f}" height="{b["h"]:.1f}" '
             f'rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')
    cx = b["x"] + b["w"] / 2
    if sub:
        lh_t, lh_s = fs_t * 1.22, fs_s * 1.30
        total = lh_t + lh_s
        y0 = b["y"] + b["h"] / 2 - total / 2 + fs_t * 0.82
        o.append(f'<text x="{cx:.1f}" y="{y0:.1f}" text-anchor="middle" font-size="{fs_t}" '
                 f'font-weight="bold" fill="{C["ink"]}">{esc(title)}</text>')
        o.append(f'<text x="{cx:.1f}" y="{y0 + lh_s + fs_s*0.14:.1f}" text-anchor="middle" font-size="{fs_s}" '
                 f'fill="{sub_color or C["sub"]}">{esc(sub)}</text>')
    else:
        o.append(f'<text x="{cx:.1f}" y="{b["y"] + b["h"]/2 + fs_t*0.34:.1f}" text-anchor="middle" '
                 f'font-size="{fs_t}" font-weight="bold" fill="{C["ink"]}">{esc(title)}</text>')


# entry surfaces
for (t, s), b in zip(ENTRY, row(5, 14, 14, 44)):
    box(b, t, s, C["grey"], C["grey_fill"], FS_ENTRY, FS_ENTRY_SUB, sw=1.4)
    # every entry surface drops into the platform underneath it
    cx = b["x"] + b["w"] / 2
    o.append(f'<line x1="{cx:.1f}" y1="{b["y"] + b["h"]:.1f}" x2="{cx:.1f}" y2="70" '
             f'stroke="{C["grey"]}" stroke-width="1.6"/>')
# the three halves
for (zt, stroke, fill, boxes), z in zip(ZONES, zones):
    o.append(f'<rect x="{z["x"]:.1f}" y="{z["y"]:.1f}" width="{z["w"]:.1f}" height="{z["h"]:.1f}" '
             f'rx="10" fill="{fill}" stroke="{stroke}" stroke-width="2.0"/>')
    o.append(f'<text x="{z["x"] + z["w"]/2:.1f}" y="{z["y"] + 27:.1f}" text-anchor="middle" '
             f'font-size="{FS_ZONE}" font-weight="bold" fill="{stroke}">{esc(zt)}</text>')
    for (t, s), b in zip(boxes, zone_boxes(z)):
        box(b, t, s, stroke, "#ffffff", FS_BOX, FS_BOX_SUB, sw=1.3, rx=6)

# bottom band: one data domain
band_y = band[0]["y"]
o.append(f'<text x="{M}" y="{band_y - 8:.1f}" font-size="{FS_BAND_SUB}" font-style="italic" '
         f'fill="{C["grey"]}">One data domain — audit, storage and the digital twin share the platform process</text>')
for (t, s, stroke), b in zip(BAND, band):
    box(b, t, s, stroke, C["purple_fill"] if stroke == C["purple"] else C["grey_fill"],
        FS_BAND, FS_BAND_SUB, sw=1.4, rx=6)

# inter-zone flow arrows. Each gap carries all three flows so the rail legend
# below keys arrows that actually exist in the body: proposals right (blue),
# governed write right (teal), telemetry/journal left dashed (grey).
mid0 = zones[0]["y"] + 120
for i in range(2):
    x0 = zones[i]["x"] + zones[i]["w"] + 4
    x1 = zones[i + 1]["x"] - 4
    for k, (colour, dashed) in enumerate([(C["blue"], False), (C["teal"], False), (C["grey"], True)]):
        y = mid0 + k * 22
        dash = ' stroke-dasharray="6,4"' if dashed else ''
        if dashed:
            # telemetry/journal flows back toward the agent half
            o.append(f'<line x1="{x1:.1f}" y1="{y:.1f}" x2="{x0+6:.1f}" y2="{y:.1f}" stroke="{colour}" '
                     f'stroke-width="2.2"{dash}/>')
            o.append(f'<path d="M{x0+7:.1f},{y-5:.1f} L{x0:.1f},{y:.1f} L{x0+7:.1f},{y+5:.1f} z" fill="{colour}"/>')
        else:
            o.append(f'<line x1="{x0:.1f}" y1="{y:.1f}" x2="{x1-6:.1f}" y2="{y:.1f}" stroke="{colour}" '
                     f'stroke-width="2.2"{dash}/>')
            o.append(f'<path d="M{x1-7:.1f},{y-5:.1f} L{x1:.1f},{y:.1f} L{x1-7:.1f},{y+5:.1f} z" fill="{colour}"/>')

# flow rail legend (keys the arrows drawn in the gaps above)
rail_y = 452
o.append(f'<line x1="{M}" y1="{rail_y - 12:.1f}" x2="{W-M}" y2="{rail_y - 12:.1f}" '
         f'stroke="{C["band"]}" stroke-width="1"/>')
cx = M + 2
for kind, colour, lab in RAIL:
    dash = ' stroke-dasharray="7,4"' if kind == 2 else ''
    o.append(f'<line x1="{cx:.1f}" y1="{rail_y:.1f}" x2="{cx+40:.1f}" y2="{rail_y:.1f}" '
             f'stroke="{colour}" stroke-width="2.4"{dash}/>')
    if kind == 2:
        o.append(f'<path d="M{cx-1:.1f},{rail_y-5.5:.1f} L{cx-8:.1f},{rail_y:.1f} L{cx-1:.1f},{rail_y+5.5:.1f} z" fill="{colour}"/>')
    else:
        o.append(f'<path d="M{cx+41:.1f},{rail_y-5.5:.1f} L{cx+48:.1f},{rail_y:.1f} L{cx+41:.1f},{rail_y+5.5:.1f} z" fill="{colour}"/>')
        if kind == 1:
            o.append(f'<path d="M{cx-1:.1f},{rail_y-5.5:.1f} L{cx-8:.1f},{rail_y:.1f} L{cx-1:.1f},{rail_y+5.5:.1f} z" fill="{colour}"/>')
    o.append(f'<text x="{cx+56:.1f}" y="{rail_y + 6:.1f}" font-size="{FS_RAIL}" fill="{C["sub"]}">{esc(lab)}</text>')
    cx += 56 + text_w(lab, FS_RAIL) + 40

o.append("</svg>")
svg = "\n".join(o)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fig1-arch-print.svg")
io.open(out, "w", encoding="utf-8").write(svg)
print(f"wrote {out}  ({W}x{H} px -> {W*MM_PER_PX:.1f} x {H*MM_PER_PX:.1f} mm)")

# ── drawio master (same content, editable in diagrams.net) ───────────────────
def xesc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def dx(b, title, sub, stroke, fill, fs_t=12, fs_s=10, rx=8, sw=2):
    val = f"&lt;b&gt;{xesc(title)}&lt;/b&gt;"
    if sub:
        val += (f'&lt;br&gt;&lt;font style=&quot;font-size:{fs_s}px&quot; '
                f'color=&quot;{C["sub"]}&quot;&gt;{xesc(sub)}&lt;/font&gt;')
    st = (f"rounded=1;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};"
          f"strokeWidth={sw};fontSize={fs_t};verticalAlign=middle;")
    return (f'        <mxCell id="{b["id"]}" value="{val}" style="{st}" vertex="1" parent="1">\n'
            f'          <mxGeometry x="{b["x"]:.0f}" y="{b["y"]:.0f}" width="{b["w"]:.0f}" '
            f'height="{b["h"]:.0f}" as="geometry" />\n        </mxCell>')


cells = []
for i, ((t, s), b) in enumerate(zip(ENTRY, row(5, 14, 14, 44))):
    b["id"] = f"entry{i}"
    cells.append(dx(b, t, s, C["grey"], C["grey_fill"], FS_ENTRY, FS_ENTRY_SUB, sw=1.4))
for zi, ((zt, stroke, fill, boxes), z) in enumerate(zip(ZONES, zones)):
    z["id"] = f"zone{zi}"
    cells.append(dx(z, zt, None, stroke, fill, FS_ZONE, 10, rx=10, sw=2))
    cells[-1] = cells[-1].replace("verticalAlign=middle", "verticalAlign=top")
    for bi, ((t, s), b) in enumerate(zip(boxes, zone_boxes(z))):
        b["id"] = f"z{zi}b{bi}"
        cells.append(dx(b, t, s, stroke, "#FFFFFF", FS_BOX, FS_BOX_SUB, rx=6, sw=1.3))
for i, ((t, s, stroke), b) in enumerate(zip(BAND, band)):
    b["id"] = f"band{i}"
    cells.append(dx(b, t, s, stroke, C["purple_fill"] if stroke == C["purple"] else C["grey_fill"],
                    FS_BAND, FS_BAND_SUB, rx=6, sw=1.4))

drawio = (f'<mxfile host="app.diagrams.net" agent="AgentWorkShop-architecture" version="24.7.7">\n'
          f'  <diagram name="AgentWorkShop Architecture" id="aws-arch-v3">\n'
          f'    <mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" '
          f'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="{W}" pageHeight="{H}" '
          f'math="0" shadow="0">\n      <root>\n        <mxCell id="0" />\n        <mxCell id="1" parent="0" />\n'
          + "\n".join(cells) + "\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n")
dout = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fig1-architecture.drawio")
io.open(dout, "w", encoding="utf-8").write(drawio)
print(f"wrote {dout}")

# -*- coding: utf-8 -*-
"""Generate three design directions for the paper's hero figure (Fig. 1).

Canvas is 716 x 270 units; the figure is placed at 7.16 in width in IEEEtran,
so 1 unit = 0.72 pt. All type >= 9 units (6.5 pt).
"""
import os

OUT = os.path.dirname(os.path.abspath(__file__))
W, H = 716, 270

FONT_A = "Arial, Helvetica, sans-serif"          # direction A: neutral grotesque
FONT_B = "'Segoe UI', Tahoma, sans-serif"        # direction B: humanist
FONT_C = "Tahoma, Verdana, sans-serif"           # direction C: sturdy grotesque


# ---------------------------------------------------------------- primitives
def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def rect(x, y, w, h, fill="none", stroke="none", sw=1.0, rx=0, dash=None, op=None):
    a = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}"'
    if stroke != "none":
        a += f' stroke="{stroke}" stroke-width="{sw}"'
    if rx:
        a += f' rx="{rx}"'
    if dash:
        a += f' stroke-dasharray="{dash}"'
    if op is not None:
        a += f' opacity="{op}"'
    return a + "/>"


def line(x1, y1, x2, y2, stroke, sw=1.0, dash=None, cap="butt", marker=None):
    a = f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{sw}" stroke-linecap="{cap}"'
    if dash:
        a += f' stroke-dasharray="{dash}"'
    if marker:
        a += f' marker-end="url(#{marker})"'
    return a + "/>"


def path(d, stroke="none", fill="none", sw=1.0, dash=None, marker=None, cap="butt"):
    a = f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" stroke-linecap="{cap}" stroke-linejoin="round"'
    if dash:
        a += f' stroke-dasharray="{dash}"'
    if marker:
        a += f' marker-end="url(#{marker})"'
    return a + "/>"


def text(x, y, s, size, fill, weight="normal", anchor="start", family=FONT_A,
         tracking=None, op=None, style=None):
    a = f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" fill="{fill}"'
    if weight != "normal":
        a += f' font-weight="{weight}"'
    if anchor != "start":
        a += f' text-anchor="{anchor}"'
    if tracking:
        a += f' letter-spacing="{tracking}"'
    if op is not None:
        a += f' opacity="{op}"'
    if style:
        a += f' font-style="{style}"'
    return a + f'>{esc(s)}</text>'


def arrow_defs(items):
    """items: list of (id, color)"""
    out = ["<defs>"]
    for mid, col in items:
        out.append(
            f'<marker id="{mid}" viewBox="0 0 10 10" refX="9" refY="5" '
            f'markerWidth="5.2" markerHeight="5.2" orient="auto-start-reverse">'
            f'<path d="M 0 0 L 10 5 L 0 10 z" fill="{col}"/></marker>')
    out.append("</defs>")
    return "".join(out)


def node(x, y, w, h, title, sub=None, fill="#FFFFFF", stroke="#14181F", sw=1.1,
         tcol="#14181F", scol="#5A636E", tsize=11.5, ssize=9.0, family=FONT_A,
         tracking=None, rx=0, tweight="bold"):
    o = [rect(x, y, w, h, fill=fill, stroke=stroke, sw=sw, rx=rx)]
    cx = x + w / 2
    if sub:
        o.append(text(cx, y + h / 2 - 1.4, title, tsize, tcol, tweight, "middle",
                      family, tracking))
        o.append(text(cx, y + h / 2 + 9.6, sub, ssize, scol, "normal", "middle",
                      family))
    else:
        o.append(text(cx, y + h / 2 + tsize * 0.35, title, tsize, tcol, tweight,
                      "middle", family, tracking))
    return "".join(o)


def valve(cx, cy, color, size=7.0):
    """The gate mark: a distinct non-rectangular shape (a valve/lock)."""
    s = size
    d = (f"M {cx-s} {cy-s} L {cx} {cy} L {cx-s} {cy+s} Z "
         f"M {cx+s} {cy-s} L {cx} {cy} L {cx+s} {cy+s} Z")
    return path(d, stroke=color, fill=color, sw=1.0)


def svg_doc(body, defs):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
            f'width="{W}" height="{H}">{defs}{body}</svg>')


FOOTER = ("Readback where the driver supports it. Fast PLC regulation stays "
          "outside the agent-team loop.")


# ============================================================ DIRECTION A
def direction_a():
    paper, ink, red, navy = "#FAF8F3", "#14181F", "#D8262C", "#16324F"
    grise = "#7A828C"
    o = [rect(0, 0, W, H, fill=paper)]
    o.append(rect(0, 0, W, 3.0, fill=red))
    o.append(text(16, 26, "One governed write path — not one per application.",
                  16.5, navy, "bold", "start", FONT_A, "-0.25"))
    o.append(rect(16, 34, 684, 1.5, fill=red))

    # ---------------- panel (a)
    ax = 16
    o.append(text(ax, 58, "(a)", 13, red, "bold"))
    o.append(text(ax + 24, 58, "Application-specific integration", 12.5, ink, "bold",
                  tracking="-0.15"))
    o.append(text(ax, 71, "every application rebuilds its own integration",
                  9, grise))
    rows = [84, 112, 140]
    for i, ry in enumerate(rows):
        o.append(rect(ax, ry, 58, 24, fill="#FFFFFF", stroke=ink, sw=1.0))
        o.append(text(ax + 29, ry + 15.5, f"App {i+1}", 10, ink, "bold", "middle"))
        o.append(line(ax + 58, ry + 12, ax + 84, ry + 12, grise, 1.0, marker="aAr"))
        o.append(rect(ax + 88, ry, 112, 24, fill="#F1EDE6", stroke=ink, sw=1.0))
        for k, lab in enumerate(("Driver", "Permission", "Log")):
            o.append(text(ax + 94, ry + 8.6 + k * 7.2, lab, 9, ink))
        o.append(line(ax + 200, ry + 12, ax + 222, ry + 12, grise, 1.0, marker="aAr"))
        o.append(rect(ax + 226, ry, 88, 24, fill="#FFFFFF", stroke=ink, sw=1.0))
        o.append(text(ax + 270, ry + 15.5, f"Device {i+1}", 10, ink, "bold", "middle"))
    o.append(rect(ax + 84, 80, 120, 88, fill="none", stroke=red, sw=1.4, dash="4 3"))
    o.append(text(ax + 144, 180, "DUPLICATED ×N", 9.5, red, "bold", "middle",
                  tracking="0.5"))
    o.append(text(ax, 200, "Open on the write path", 10, ink, "bold"))
    for k, (bx, lab) in enumerate((
            (ax, "who is authorized"),
            (ax + 104, "which limits apply"),
            (ax + 216, "write ↔ outcome link"))):
        o.append(text(bx, 216, "✕", 10, red, "bold"))
        o.append(text(bx + 12, 216, lab, 9, ink))

    # ---------------- panel (b)
    bx = 348
    o.append(text(bx, 58, "(b)", 13, navy, "bold"))
    o.append(text(bx + 24, 58, "AgentWorkShop member–node binding", 12.5, ink,
                  "bold", tracking="-0.15"))
    o.append(text(bx, 71, "one governed path, evidence returned", 9, grise))
    # context rail above the path
    o.append(rect(bx, 76, 352, 17, fill="#E9EEF4"))
    o.append(rect(bx, 76, 2.6, 17, fill=navy))
    o.append(text(bx + 8, 88.4, "line · product · recipe · run", 9, navy, "bold"))
    o.append(text(bx + 346, 88.4, "context", 9, grise, anchor="end"))
    # governed path
    py, ph = 98, 34
    o.append(node(bx, py, 66, ph, "Channel", "lead · workers", fill="#F6F8FB",
                  stroke=ink, tsize=10.5, ssize=9))
    o.append(node(bx + 74, py, 128, ph, "Member–node binding",
                  "recipe · approval · range", fill="#F6F8FB", stroke=ink,
                  tsize=10.5, ssize=9))
    o.append(node(bx + 210, py, 60, ph, "DAQ/DCW", "nodes", fill="#F6F8FB",
                  stroke=ink, tsize=10.5, ssize=9))
    o.append(node(bx + 278, py, 74, ph, "Plant", "5 protocols", fill="#F6F8FB",
                  stroke=ink, tsize=10.5, ssize=9))
    for x1, x2 in ((bx + 66, bx + 74), (bx + 202, bx + 210), (bx + 270, bx + 278)):
        o.append(line(x1, py + 17, x2, py + 17, ink, 1.1, marker="aNv"))
    o.append(valve(bx + 206, py + 17, red, 5.4))
    # evidence bus
    for cx, lab, col in ((bx + 82, "verdict", red), (bx + 240, "readback", grise),
                         (bx + 315, "process", grise)):
        o.append(line(cx, py + ph, cx, 172, col, 1.1,
                      marker=("aRr" if col == red else "aAr")))
        o.append(text(cx + 4, 156, lab, 9, col, "bold" if col == red else "normal"))
    o.append(rect(bx, 172, 352, 42, fill="#FFFFFF", stroke=navy, sw=1.2))
    o.append(text(bx + 8, 186, "Intervention record", 11, navy, "bold"))
    o.append(text(bx + 344, 186, "write ↔ outcome", 9, red, "bold", anchor="end"))
    for k, lab in enumerate(("proposal", "result", "observation", "verdict")):
        cxx = bx + 8 + k * 84
        o.append(rect(cxx, 192, 78, 16, fill="#F1EDE6", stroke=ink, sw=0.8))
        o.append(text(cxx + 39, 203.4, lab, 9, ink, "normal", "middle"))

    o.append(text(16, 258, FOOTER, 9, grise))
    return svg_doc("".join(o), arrow_defs([("aAr", grise), ("aNv", ink),
                                           ("aRr", red)]))


# ============================================================ DIRECTION B
def direction_b():
    bg, ink, grise = "#FFFFFF", "#1B1F24", "#98A1AA"
    blue, amber, green, faint = "#3E6E9E", "#C0821F", "#3F7A5E", "#DCE3EA"
    c = [72, 232, 452, 636]        # shared column centres for BOTH rows
    o = [rect(0, 0, W, H, fill=bg)]
    o.append(text(16, 21, "Integration pattern, compared on one axis", 12, ink,
                  "bold", "start", FONT_B, "-0.1"))
    # key (top right)
    for k, (col, lab) in enumerate(((grise, "ungoverned"), (amber, "admission"),
                                    (green, "evidence"))):
        kx = 470 + k * 78
        o.append(rect(kx, 13, 9, 9, fill=col))
        o.append(text(kx + 13, 21, lab, 9, ink, family=FONT_B))
    # column headers + guides
    for cx, lab in ((c[0], "agents"), (c[1], "integration"), (c[2], "semantic nodes"),
                    (c[3], "plant")):
        o.append(line(cx, 30, cx, 252, faint, 0.8))
        o.append(text(cx - 26, 40, lab, 9, grise, "bold", family=FONT_B,
                      tracking="0.6"))
    o.append(line(16, 46, 700, 46, ink, 1.0))

    # ---- row (a): three thin ungoverned pipelines on the same axis
    o.append(text(16, 60, "(a)", 11.5, grise, "bold", family=FONT_B))
    o.append(text(42, 60, "Application-specific integration — rebuilt per "
                  "application", 10, ink, "bold", family=FONT_B))
    for i, ry in enumerate((68, 84, 100)):
        o.append(rect(c[0] - 34, ry, 68, 14, fill="#FFFFFF", stroke=grise, sw=0.9))
        o.append(text(c[0], ry + 9.9, f"App {i+1}", 9, ink, "normal", "middle",
                      FONT_B))
        o.append(line(c[0] + 34, ry + 7, c[1] - 46, ry + 7, grise, 0.9, marker="bGr"))
        for k in range(3):
            o.append(rect(c[1] - 44, ry + k * 4.6, 88, 3.9, fill=grise, op=0.5))
        o.append(line(c[1] + 44, ry + 7, c[2] - 38, ry + 7, grise, 0.9, marker="bGr"))
        o.append(rect(c[2] - 36, ry, 72, 14, fill="#FFFFFF", stroke=grise, sw=0.9))
        o.append(text(c[2], ry + 9.9, "quantity", 9, grise, "normal", "middle",
                      FONT_B))
        o.append(line(c[2] + 36, ry + 7, c[3] - 30, ry + 7, grise, 0.9, marker="bGr"))
        o.append(rect(c[3] - 28, ry, 56, 14, fill="#FFFFFF", stroke=grise, sw=0.9))
        o.append(text(c[3], ry + 9.9, f"Device {i+1}", 9, grise, "normal",
                      "middle", FONT_B))
    o.append(text(c[1] - 44, 128, "driver · permission · log, duplicated ×N",
                  9, grise, "bold", family=FONT_B))
    o.append(text(c[1] - 44, 140, "no admission gate · no evidence return",
                  9, amber, "bold", family=FONT_B))
    o.append(line(16, 150, 700, 150, ink, 1.0))

    # ---- row (b): one governed path on the same axis
    o.append(text(16, 165, "(b)", 11.5, blue, "bold", family=FONT_B))
    o.append(text(42, 165, "AgentWorkShop member–node binding — one governed "
                  "path, shared context", 10, ink, "bold", family=FONT_B))
    # context rail ABOVE the path so the evidence bus below stays clear
    o.append(rect(16, 172, 684, 13, fill="#F2F6FA"))
    o.append(rect(16, 172, 2.6, 13, fill=blue))
    o.append(text(24, 181.6, "line · product · recipe · run", 9, blue, "bold",
                  family=FONT_B))
    o.append(text(694, 181.6, "resolved per request", 9, grise, anchor="end",
                  family=FONT_B))
    by, bh = 190, 24
    o.append(node(c[0] - 36, by, 72, bh, "Channel", fill="#FFFFFF", stroke=blue,
                  sw=1.1, tsize=10, family=FONT_B, tcol=ink))
    o.append(node(c[1] - 62, by, 124, bh, "Member–node binding", fill="#FFF7E8",
                  stroke=amber, sw=1.5, tsize=10, family=FONT_B, tcol=ink))
    o.append(node(c[2] - 42, by, 84, bh, "DAQ/DCW", fill="#FFFFFF", stroke=blue,
                  sw=1.1, tsize=10, family=FONT_B, tcol=ink))
    o.append(node(c[3] - 34, by, 68, bh, "Plant", fill="#FFFFFF", stroke=blue,
                  sw=1.1, tsize=10, family=FONT_B, tcol=ink))
    for x1, x2 in ((c[0] + 36, c[1] - 62), (c[1] + 62, c[2] - 42),
                   (c[2] + 42, c[3] - 34)):
        o.append(line(x1, by + bh / 2, x2, by + bh / 2, blue, 1.1, marker="bBr"))
    o.append(valve(c[1] + 67, by + bh / 2, amber, 5.0))
    o.append(text(c[1] + 78, 186, "admission: recipe ·", 9, amber, "bold",
                  family=FONT_B))
    o.append(text(c[1] + 78, 195, "approval · range", 9, amber, "bold",
                  family=FONT_B))

    # ---- evidence bus (one clean return loop below the path)
    ry = 250
    for cx, lab in ((c[2], "readback"), (c[3], "process")):
        o.append(line(cx, by + bh, cx, ry, green, 1.2))
        o.append(text(cx + 4, ry - 4, lab, 9, green, anchor="start", family=FONT_B))
    o.append(line(c[3], ry, c[1], ry, green, 1.2))
    o.append(line(c[1], ry, c[1], by + bh + 3, green, 1.2, marker="bEr"))
    o.append(text(244, 226, "intervention record", 9.5, green, "bold",
                  family=FONT_B))
    o.append(text(244, 238, "proposal · result · observation · verdict", 9, ink,
                  family=FONT_B))
    o.append(text(358, 266, FOOTER, 9, grise, "normal", "middle", FONT_B))
    return svg_doc("".join(o), arrow_defs([("bGr", grise), ("bBr", blue),
                                           ("bEr", green)]))


# ============================================================ DIRECTION C
def direction_c():
    bg, ink = "#FFFFFF", "#1A1A1A"
    blue, green, silver = "#2B6CB0", "#3F7A5E", "#C9CDD2"
    grid = "#EEF1F3"
    o = [rect(0, 0, W, H, fill=bg)]
    for k in range(13):                      # visible 12-column grid
        gx = 16 + k * (684 / 12.0)
        o.append(line(gx, 12, gx, 258, grid, 0.8))
    o.append(text(16, 25, "TWO WAYS TO REACH THE SAME PLANT", 11, ink, "bold",
                  "start", FONT_C, "1.2"))
    o.append(line(16, 30, 700, 30, ink, 1.4))
    o.append(rect(16, 38, 2.8, 12, fill=blue))
    o.append(text(25, 48, "A  UNGOVERNED", 10, blue, "bold", tracking="1.0"))
    o.append(text(25, 60, "driver · permission · log duplicated per application",
                  9, ink))
    o.append(text(25, 72, "no gate · no return path", 9, blue, "bold"))
    o.append(rect(366, 38, 2.8, 12, fill=green))
    o.append(text(375, 48, "B  GOVERNED  (THIS WORK)", 10, green, "bold",
                  tracking="1.0"))
    o.append(text(375, 60, "one member–node path · context per request", 9, ink))
    o.append(text(375, 72, "gate on admission · evidence returned", 9, green,
                  "bold"))

    # ---- (a) three ungoverned drops into the shared plant band
    for i, cx in enumerate((76, 160, 244)):
        o.append(rect(cx - 30, 86, 60, 20, fill="#FFFFFF", stroke=ink, sw=1.1))
        o.append(text(cx, 100, f"APP {i+1}", 9.5, ink, "bold", "middle", FONT_C,
                      "0.6"))
        o.append(line(cx, 106, cx, 120, ink, 1.2, marker="cIn"))
        o.append(rect(cx - 30, 120, 60, 46, fill="#F4F5F6", stroke=ink, sw=1.1))
        for k, lab in enumerate(("DRIVER", "PERMISSION", "LOG")):
            o.append(text(cx, 134 + k * 13, lab, 9, ink, "normal", "middle", FONT_C,
                          "0.4"))
        o.append(line(cx, 166, cx, 208, ink, 1.2, marker="cIn"))
    o.append(text(16, 196, "×3 DUPLICATED INTEGRATION", 9, blue, "bold",
                  tracking="0.8"))

    # ---- (b) one governed orthogonal drop
    o.append(rect(374, 86, 92, 20, fill="#FFFFFF", stroke=ink, sw=1.1))
    o.append(text(420, 100, "CHANNEL", 9.5, ink, "bold", "middle", FONT_C, "0.6"))
    o.append(rect(486, 86, 150, 20, fill="#F0F6F2", stroke=green, sw=1.4))
    o.append(text(561, 100, "MEMBER–NODE BINDING", 9.5, green, "bold", "middle",
                  FONT_C, "0.6"))
    o.append(line(466, 96, 486, 96, green, 1.2, marker="cGr"))
    o.append(text(476, 83, "AUTHORITY", 8.6, green, "bold", "middle", FONT_C, "0.8"))
    # the governed drop: binding -> gate -> plant
    o.append(line(561, 106, 561, 122, green, 1.6))
    o.append(valve(561, 130, green, 6.2))
    o.append(line(561, 138, 561, 208, green, 1.6, marker="cGr"))
    # context (left of the drop) and admission (right of the drop)
    o.append(text(520, 124, "CONTEXT", 9, ink, "bold", "end", FONT_C, "0.8"))
    o.append(text(520, 135, "line · product", 9, ink, "normal", "end", FONT_C))
    o.append(text(520, 146, "· recipe · run", 9, ink, "normal", "end", FONT_C))
    o.append(text(580, 124, "ADMISSION", 9, green, "bold", tracking="0.8"))
    o.append(text(580, 135, "recipe · approval,", 9, ink))
    o.append(text(580, 146, "· range", 9, ink))
    o.append(text(548, 176, "READBACK", 8.6, green, "bold", "end", FONT_C, "0.8"))
    # evidence record, wired to the drop and back to the binding
    o.append(rect(580, 158, 120, 46, fill="#FFFFFF", stroke=green, sw=1.2))
    o.append(text(640, 170, "INTERVENTION", 9, green, "bold", "middle",
                  FONT_C, "0.6"))
    o.append(text(640, 181, "RECORD", 9, green, "bold", "middle", FONT_C, "0.6"))
    o.append(text(640, 193, "proposal · result", 8.6, ink, "normal", "middle",
                  FONT_C))
    o.append(text(640, 202, "observation · verdict", 8.6, ink, "normal", "middle",
                  FONT_C))
    o.append(line(561, 176, 580, 176, green, 1.2, marker="cGr"))
    o.append(path("M 690 158 L 690 94 L 638 94", stroke=green, sw=1.2,
                  marker="cGr"))
    o.append(text(694, 118, "VERDICT", 8.6, green, "bold", "end", FONT_C, "0.8"))
    o.append(line(670, 208, 670, 204, green, 1.2, marker="cGr"))

    # ---- shared plant band
    o.append(rect(16, 208, 684, 38, fill="#F4F5F6", stroke=ink, sw=1.4))
    o.append(text(26, 226, "PLANT", 10.5, ink, "bold", tracking="1.0"))
    o.append(text(26, 238, "5 PROTOCOLS", 9, ink, tracking="0.6"))
    for k, lab in enumerate(("MODBUS TCP", "MODBUS RTU", "OPC UA", "MQTT",
                             "HTTP/REST")):
        tx = 120 + k * 116
        o.append(rect(tx, 218, 2.2, 18, fill=silver))
        o.append(text(tx + 8, 231, lab, 9, ink, tracking="0.4"))
    o.append(text(16, 262, FOOTER, 9, "#6B7178", family=FONT_C))
    return svg_doc("".join(o), arrow_defs([("cIn", ink), ("cGr", green)]))


if __name__ == "__main__":
    d = os.path.join(OUT, "design-demos")
    os.makedirs(d, exist_ok=True)
    for name, fn in (("A-magazine-pop", direction_a),
                     ("B-distill-axis", direction_b),
                     ("C-aicher-grid", direction_c)):
        p = os.path.join(d, name + ".svg")
        open(p, "w", encoding="utf-8").write(fn())
        print("wrote", p)

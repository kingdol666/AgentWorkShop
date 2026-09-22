# -*- coding: utf-8 -*-
"""Figure 1 (v3) builder: governed member--node binding, HTML+SVG -> vector PDF.

Why this rebuild
----------------
v2 was legible but visually flat: one uniform stroke weight, hairline panel
dividers, a low-contrast panel (a), and a monochrome navy/teal read that made a
"governed loop" look like a generic flow chart. The gateway is the first thing
an IEEE TII reviewer sees, so it has to carry the paper's central contrast at a
glance -- *unmediated application history* versus *one governed, evidenced
loop* -- and it has to do so in a form that survives grayscale printing.

What changed
------------
  * editorial header band (kicker / title / rule) so the gateway reads as a
    designed artifact rather than a slide
  * an explicit vertical "loop lane" with a soft wash, so the agent--plant loop
    is a visible closed circuit instead of implied arrows
  * typographic hierarchy: 300-weight stage titles, 600-weight card titles,
    700-weight panel titles, letter-spaced micro-labels
  * duotone accent system -- navy (agent side) / teal (plant side) / amber
    (governance) -- with inverse-filled key cards; every pairing keeps >= 4.5:1
    contrast on white and separates in grayscale by lightness, not hue
  * shared production context drawn as a *stub* rail hanging beneath the loop
    (it feeds both binding and admission) rather than a box floating in a gap
  * evidence contract promoted from a 4-token chain to proposal -> result ->
    observation -> verdict -> compensation with the "never merged" clause

Hard constraints preserved from v2 (the submission contract)
-----------------------------------------------------------
  * canvas 181 mm x 78 mm -- exactly \\textwidth for IEEEtran two-column, so
    the float needs no resize; height is free (no pagination lock observed)
  * minimum text 7.5 pt at print size (IEEE floor 6 pt; v2 house floor 8 pt)
  * Times-family serif body, matching the manuscript body type
  * panel (a) deliberately desaturated; panel (b) carries all the accent colour
  * icons: Lucide (ISC), cached in fig1-icons/, inlined as <g>

Pipeline
--------
  geometry (px, y-down)  ->  {  SVG for review/preview
                              {  HTML/CSS through PyMuPDF's Story engine -> vector PDF

Every SVG->PDF converter on this machine was measured and rejected before this
pipeline was chosen:

  * LaTeX `svg` package, `inkscape=false` -- expects the dvisvgm export
    fragment to already exist on disk; it does not invoke dvisvgm itself, so
    the build dies with "File `fig_svg-tex.pdf' is missing".
  * LaTeX `svg` package, `inkscape=true` -- shells out to Inkscape, which is
    not installed ("Inkscape version not detected").
  * `dvisvgm --pdf` -- dvisvgm reads DVI, not SVG. Feeding it SVG gives
    "DVI error: invalid DVI file (missing preamble)". It also refuses the PDF
    backend here: the only Ghostscript present is 10.04.0, which it rejects,
    and mutool is absent.
  * Chrome `--print-to-pdf` -- directionally lossy. Declared font sizes were
    quantised (a 30 px face landed at 35.4 px, a 20 px face at 23.6 px in the
    content stream) and the bold face was dropped entirely, leaving a single
    embedded font. For a figure whose minimum type size is a hard submission
    constraint, that rounding is disqualifying.
  * PyMuPDF `page.set_contents` -- a fresh page has no content stream xref to
    overwrite, so raw-operator injection has no valid anchor.

`fitz.Story` is the one route that lays out HTML/CSS and writes PDF with the
declared type size intact. Measured: 2.9 mm -> 8.2205 pt, 181 mm -> 513.071 pt,
all four Times faces resolving to their real logical names, zero embedded
raster images. That is why the PDF is produced from a CSS twin of the SVG
rather than from the SVG bytes.

The SVG remains a first-class output: it is the reviewable source of the
figure and the thing a human edits when the design changes.

Output: fig1-governed-binding.{html,svg,pdf,png,grayscale.png} + qa json
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import fitz

HERE = Path(__file__).resolve().parent
ICONS = HERE / "fig1-icons"
STEM = "fig1-governed-binding"

# ── geometry ───────────────────────────────────────────────────────────────
# 0.1 mm per px. Width is locked to IEEEtran \textwidth (181 mm); height is
# ours to choose and is set by what the content actually needs.
W, H = 1810, 780
MM_W, MM_H = 181.0, 78.0
DPI = 300

# ── palette ────────────────────────────────────────────────────────────────
# One ink ramp + three accents. All accents sit at similar lightness so the
# figure degrades honestly in grayscale (see -grayscale.png).
INK = "#1c2b33"        # headings
BODY = "#31444e"       # card / stage titles
SUB = "#5b6d77"        # secondary copy
MUTE = "#8b9aa3"       # queries, tertiary copy, disabled strokes
HAIR = "#dfe5e8"       # hairlines inside cards
PANEL = "#f7f9fa"      # panel (b) ground
LANE = "#f4f8f8"       # loop-lane wash
RULE = "#c9d3d8"       # panel divider

NAVY = "#2b5671"       # agent side
NAVY_D = "#1e3f54"     # inverted navy
NAVY_W = "#eaf0f4"     # navy wash
TEAL = "#2c7a80"       # plant side
TEAL_D = "#1f5c61"     # inverted teal
TEAL_W = "#e7f2f2"     # teal wash
AMBER = "#a9720f"      # governance
AMBER_W = "#fbf3e2"    # amber wash
BAD = "#a04b3a"        # panel (a) unresolved markers

FONT = "Times New Roman,Times,FreeSerif,serif"

# One authoring px == 0.1 mm == 0.28346 pt. The layout unit is the point, so
# `font-size: N pt` in the emitted CSS lands as exactly N pt in the PDF with
# nothing in between to round it (see the pipeline note at the top).
_PX_TO_PT = (72.0 / 25.4) / 10.0


def px(v: float) -> str:
    """An authoring px length -> a CSS length in points."""
    return f"{v * _PX_TO_PT:.4f}pt"


def esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def absbox(x: float, y: float, w: float, h: float, decl: str = "") -> str:
    """An absolutely positioned box; `decl` carries the paint declarations."""
    return (f'<div style="left:{px(x)};top:{px(y)};width:{px(w)};'
            f'height:{px(h)};position:absolute;{decl}"></div>')


_cache: dict[str, str] = {}



# ── authoring units ────────────────────────────────────────────────────────
# One authoring px == 0.1 mm. TikZ is told `x=0.1mm, y=0.1mm`, so every
# coordinate below is written in the same px numbers the layout uses and the
# PDF lands at exactly 181 mm wide. y is negated at emit time because TikZ's
# y axis points up while the layout is authored y-down.
_CACHE: dict[str, str] = {}


def ydown(y: float) -> float:
    """Authoring y (down) -> TikZ y (up)."""
    return -y


def hexn(c: str) -> str:
    """#rrggbb -> the pgf/xcolor HTML definition name for that colour.

    Only six-digit hex is supported. An rgba() literal has no pgf equivalent
    here, so it is rejected loudly rather than silently emitting a malformed
    colour name into the TikZ source.
    """
    if not (c.startswith("#") and len(c) == 7):
        raise ValueError(
            f"colour {c!r} is not #rrggbb; pgf needs a defined hex colour. "
            f"Replace rgba() with a flat hex value.")
    return "c" + c.lstrip("#").lower()


def px_of(size: float) -> float:
    """An authoring px length -> points."""
    return size * 0.1 * 72.0 / 25.4


def esc(s: str) -> str:
    """Escape a string for LaTeX text mode."""
    for a, b in (("\\", r"\textbackslash{}"), ("&", r"\&"), ("%", r"\%"),
                 ("$", r"\$"), ("#", r"\#"), ("_", r"\_"), ("{", r"\{"),
                 ("}", r"\}"), ("~", r"\textasciitilde{}"),
                 ("^", r"\textasciicircum{}")):
        s = s.replace(a, b)
    return s


def tw(s: str, size: float, weight: int = 400, tracking: float = 0.0) -> float:
    """Conservative Times advance-width estimate (px), including tracking.

    Used only to size pill and chip boxes, where a slightly generous box is
    harmless. Text placement itself is anchored by TikZ nodes, so this estimate
    never affects where a glyph lands.
    """
    fac = {300: 0.465, 400: 0.478, 600: 0.510, 700: 0.545}.get(weight, 0.478)
    return len(s) * (size * fac + tracking)


def fontcmd(size: float, weight: int = 400, italic: bool = False,
            tracking: float = 0.0) -> str:
    """LaTeX declarations selecting an exact type size and face.

    Returns *declarations only*, with no surrounding group. The caller places
    them inside the node's text group, so the size stays in force for the
    glyphs that follow. Returning a self-contained `{...}` here would close the
    group before the text and silently drop back to the document default.
    """
    pt = px_of(size)
    decl = [r"\fontsize{" + f"{pt:.4f}pt" + r"}{" + f"{pt * 1.18:.4f}pt"
            + r"}\selectfont"]
    if tracking:
        # fontspec's LetterSpace is the only tracking that survives into the
        # PDF as real glyph positions
        decl.append(r"\addfontfeatures{LetterSpace=" + f"{tracking * 10:.2f}"
                    + "}")
    if weight >= 600:
        decl.append(r"\bfseries")
    if italic:
        decl.append(r"\itshape")
    # `\relax` terminates the last control word. A space would be swallowed
    # during tokenisation, and the following text would be read as part of the
    # command name (e.g. `\itshapeeach`).
    return " ".join(decl) + r"\relax "


# ── primitives ─────────────────────────────────────────────────────────────
def T(x: float, y: float, s: str, size: float, *, weight: int = 400,
      color: str = BODY, anchor: str = "start", tracking: float = 0.0,
      style: str = "") -> str:
    """Text anchored at authoring (x, y), where y is the glyph BASELINE.

    `anchor=base west` puts the TikZ node reference point on the baseline at
    the left edge, which is exactly the authoring convention; the three
    horizontal anchors map onto TikZ's own.
    """
    a = {"start": "base west", "middle": "base", "end": "base east"}[anchor]
    # The font selection must live *inside* the node's brace group. A second
    # brace group after the coordinate is read by pgf as a node name, which
    # fails with "No shape named `a' is known".
    return (rf"\node[anchor={a},inner sep=0pt,outer sep=0pt,"
            rf"text={hexn(color)}] at ({x:.2f},{ydown(y):.2f}) "
            rf"{{{fontcmd(size, weight, 'italic' in style, tracking)}"
            rf"{esc(s)}}};")


def R(x: float, y: float, w: float, h: float, *, rx: float = 12,
      stroke: str = "none", fill: str = "none", sw: float = 2.0,
      dash: str | None = None) -> str:
    """A rectangle; authoring (x, y) is its top-left corner."""
    opts = []
    if fill != "none":
        opts.append(f"fill={hexn(fill)}")
    if stroke != "none" and sw > 0:
        opts.append(f"draw={hexn(stroke)}")
        opts.append(f"line width={sw * 0.1:.4f}mm")
    if rx:
        opts.append(f"rounded corners={rx * 0.1:.4f}mm")
    if dash:
        on, off = (float(v) * 0.1 for v in dash.split(","))
        opts.append(f"dash pattern=on {on:.4f}mm off {off:.4f}mm")
    return (rf"\path[{','.join(opts)}] ({x:.2f},{ydown(y):.2f}) rectangle "
            rf"({x + w:.2f},{ydown(y + h):.2f});")


def seg(x1: float, y1: float, x2: float, y2: float, color: str,
        sw: float = 2.2, dash: str | None = None, cap: str = "butt") -> str:
    opts = [f"draw={hexn(color)}", f"line width={sw * 0.1:.4f}mm",
            "line cap=" + ("round" if cap == "round" else "butt")]
    if dash:
        on, off = (float(v) * 0.1 for v in dash.split(","))
        opts.append(f"dash pattern=on {on:.4f}mm off {off:.4f}mm")
    return (rf"\draw[{','.join(opts)}] ({x1:.2f},{ydown(y1):.2f}) -- "
            rf"({x2:.2f},{ydown(y2):.2f});")


def poly(pts, color: str, sw: float = 2.2, close: bool = False) -> str:
    path = " -- ".join(f"({x:.2f},{ydown(y):.2f})" for x, y in pts)
    if close:
        path += " -- cycle"
    return (rf"\draw[{hexn(color)},line width={sw * 0.1:.4f}mm,"
            rf"line cap=round,line join=round] {path};")


def head(x: float, y: float, direction: str, color: str,
         length: float = 12.0, width: float = 9.0) -> str:
    if direction == "right":
        pts = [(x - length, y - width / 2), (x, y), (x - length, y + width / 2)]
    elif direction == "left":
        pts = [(x + length, y - width / 2), (x, y), (x + length, y + width / 2)]
    elif direction == "up":
        pts = [(x - width / 2, y + length), (x, y), (x + width / 2, y + length)]
    else:
        pts = [(x - width / 2, y - length), (x, y), (x + width / 2, y - length)]
    path = " -- ".join(f"({a:.2f},{ydown(b):.2f})" for a, b in pts)
    return rf"\fill[{hexn(color)}] {path} -- cycle;"


def arrow(x1: float, y1: float, x2: float, y2: float, color: str,
          direction: str, sw: float = 2.2) -> str:
    """Straight arrow; the head consumes 12 px of the run."""
    if direction == "right":
        return seg(x1, y1, x2 - 10, y2, color, sw) + head(x2, y2, direction, color)
    if direction == "left":
        return seg(x1, y1, x2 + 10, y2, color, sw) + head(x2, y2, direction, color)
    if direction == "up":
        return seg(x1, y1, x2, y2 + 10, color, sw) + head(x2, y2, direction, color)
    return seg(x1, y1, x2, y2 - 10, color, sw) + head(x2, y2, direction, color)


def _seg(frag: str, end: str) -> str:
    """Join one path fragment to its endpoint.

    A `.. controls ..` fragment already terminates on the endpoint, so
    appending `-- (end)` produces the invalid `.. -- (`, which TikZ rejects
    with "Cannot parse this coordinate". Only fragments that leave the pen
    short of the endpoint (an `arc`, which TikZ closes by drawing straight to
    the current point) take the extra `--`.
    """
    f = frag.rstrip()
    if f.endswith("..") or f.endswith(".. "):
        # the control points already carry the endpoint
        return f"{f} {end}"
    return f"{f} -- {end}"


def _arc_to_tikz(x0: float, y0: float, rx: float, ry: float, rot: float,
                 large: int, sweep: int, x1: float, y1: float) -> str:
    """One SVG elliptical arc as a TikZ arc or a Bezier connector.

    Lucide only draws quarter- and half-turn circular arcs (rx == ry, no
    rotation), so the endpoints can be re-expressed as a TikZ `arc` with
    explicit start and end angles. Angles are used rather than the
    `clockwise`/`counterclockwise` keywords because those are pgf *path*
    commands, not TikZ options, and TikZ rejects them inside a path.

    Anything else falls back to a Bezier through the arc midpoint, which is
    visually indistinguishable at icon scale and keeps the path a real vector.
    """
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    if abs(rx - ry) < 1e-6 and abs(rot) < 1e-6 and rx > 0 and not large:
        import math
        cx0 = (x0 + x1) / 2
        cy0 = (y0 + y1) / 2
        half = math.hypot(x1 - x0, y1 - y0) / 2
        r = rx
        if 0 < half <= r:
            h = math.sqrt(max(r * r - half * half, 0.0))
            ux, uy = (x1 - x0) / (2 * half), (y1 - y0) / (2 * half)
            sign = -1.0 if sweep else 1.0
            ccx = cx0 + sign * h * -uy
            ccy = cy0 + sign * h * ux
            a0 = math.degrees(math.atan2(y0 - ccy, x0 - ccx))
            a1 = math.degrees(math.atan2(y1 - ccy, x1 - ccx))
            if sweep and a1 < a0:
                a1 += 360
            if not sweep and a1 > a0:
                a1 -= 360
            return (f" arc[start angle={a0:.3f}, end angle={a1:.3f}, "
                    f"radius={r:.4f}]")
    return f" .. controls ({mx:.4f},{my:.4f}) and ({x1:.4f},{y1:.4f}) .."


def _path_to_tikz(d: str, scale: float, ox: float, oy: float) -> list[str]:
    """Convert one SVG path `d` attribute into TikZ path fragments.

    Handles the M/L/H/V/C/A/Z command set (absolute and relative) that Lucide
    uses. Each `M` starts a new subpath, and each subpath becomes its own TikZ
    `\\draw` so that a multi-part glyph (an eye outline plus its pupil, say)
    renders as separate strokes rather than one connected line.
    """
    toks = re.findall(r"[MmLlHhVvCcSsQqAaZz]|-?\d*\.?\d+(?:e-?\d+)?", d)
    subpaths: list[str] = []
    cur: list[str] = []
    cx = cy = 0.0
    sx = sy = 0.0            # start of the current subpath
    i = 0

    def P(mx: float, my: float) -> str:
        """Lucide viewBox coords -> TikZ coords, with the y flip applied."""
        return f"({ox + mx * scale:.4f},{ydown(oy + my * scale):.4f})"

    def flush() -> None:
        if cur:
            subpaths.append("".join(cur))
            cur.clear()

    while i < len(toks):
        c = toks[i]
        if c in "Mm":
            flush()
            cx, cy = float(toks[i + 1]), float(toks[i + 2])
            if c == "m" and i > 0:
                cx += 0.0
            sx, sy = cx, cy
            cur.append(P(cx, cy))
            i += 3
        elif c in "Ll":
            dx, dy = float(toks[i + 1]), float(toks[i + 2])
            if c == "l":
                cx, cy = cx + dx, cy + dy
            else:
                cx, cy = dx, dy
            cur.append(f" -- {P(cx, cy)}")
            i += 3
        elif c in "Hh":
            v = float(toks[i + 1])
            cx = cx + v if c == "h" else v
            cur.append(f" -- {P(cx, cy)}")
            i += 2
        elif c in "Vv":
            v = float(toks[i + 1])
            cy = cy + v if c == "v" else v
            cur.append(f" -- {P(cx, cy)}")
            i += 2
        elif c in "Cc":
            pts = [float(v) for v in toks[i + 1:i + 7]]
            if c == "c":
                pts = [cx + pts[0], cy + pts[1], cx + pts[2], cy + pts[3],
                       cx + pts[4], cy + pts[5]]
            cur.append(f" .. controls {P(pts[0], pts[1])} and "
                       f"{P(pts[2], pts[3])} .. {P(pts[4], pts[5])}")
            cx, cy = pts[4], pts[5]
            i += 7
        elif c in "Ss":
            pts = [float(v) for v in toks[i + 1:i + 5]]
            if c == "s":
                pts = [cx + pts[0], cy + pts[1], cx + pts[2], cy + pts[3]]
            cz = (2 * cx - sx, 2 * cy - sy)
            cur.append(f" .. controls {P(cz[0], cz[1])} and "
                       f"{P(pts[0], pts[1])} .. {P(pts[2], pts[3])}")
            cx, cy = pts[2], pts[3]
            i += 5
        elif c in "Qq":
            pts = [float(v) for v in toks[i + 1:i + 5]]
            if c == "q":
                pts = [cx + pts[0], cy + pts[1], cx + pts[2], cy + pts[3]]
            cur.append(f" .. controls {P(pts[0], pts[1])} .. "
                       f"{P(pts[2], pts[3])}")
            cx, cy = pts[2], pts[3]
            i += 5
        elif c in "Aa":
            v = [float(t) for t in toks[i + 1:i + 6]] + toks[i + 6:i + 8]
            rx, ry, rot = v[0], v[1], v[2]
            large, sweep = int(v[3]), int(v[4])
            ex, ey = float(v[5]), float(v[6])
            if c == "a":
                ex, ey = cx + ex, cy + ey
            # Both endpoints are converted to output space before the helper
            # runs, so its centre computation is consistent. `_seg` then adds
            # the endpoint only when the fragment does not already carry it.
            cur.append(_seg(
                _arc_to_tikz(ox + cx * scale, ydown(oy + cy * scale),
                             rx * scale, ry * scale, rot, large, sweep,
                             ox + ex * scale, ydown(oy + ey * scale)),
                P(ex, ey)))
            cx, cy = ex, ey
            i += 8
        elif c in "Zz":
            cur.append(" -- cycle")
            cx, cy = sx, sy
            i += 1
        else:
            i += 1
    flush()
    return subpaths


def icon(name: str, cx: float, cy: float, size: float, color: str,
         sw: float = 2.3) -> str:
    """A Lucide icon as TikZ paths, centred at (cx, cy) and scaled to `size`.

    The cached Lucide source is parsed and re-emitted as TikZ, so icons stay
    true vectors in the PDF instead of being rasterised the way an inline
    <svg> would be by a DOM-based renderer.

    Lucide draws with <path>, <rect>, <circle>, <ellipse>, <line> and
    <polyline>; all six are handled, and the path grammar covers the
    M/L/H/V/C/S/Q/A/Z set in both absolute and relative form.
    """
    if name not in _CACHE:
        _CACHE[name] = (ICONS / f"{name}.svg").read_text(encoding="utf-8")
    src = _CACHE[name]
    s = size / 24.0
    ox, oy = cx - size / 2, cy - size / 2
    lw = sw * s * 0.1
    parts: list[str] = []

    def draw(frag: str) -> None:
        parts.append(rf"\draw[{hexn(color)},line width={lw:.5f}mm,"
                     rf"line cap=round,line join=round] {frag};")

    def g(mx: float, my: float) -> str:
        """Lucide viewBox coords -> TikZ coords, including the y flip.

        The authoring layout is y-down and TikZ is y-up, so the icon's local y
        is negated through `ydown` just like every other primitive. Skipping
        that flip mirrors the icon below the canvas and inflates the picture's
        bounding box, which silently changes the page size.
        """
        return f"({ox + mx * s:.4f},{ydown(oy + my * s):.4f})"

    def attr(tag: str, key: str, default: float = 0.0) -> float:
        m = re.search(rf'{tag}[^>]*?\b{key}="(-?[\d.]+)"', src)
        return float(m.group(1)) if m else default

    # `path` elements
    for d in re.findall(r'<path[^>]*?\bd="([^"]+)"', src):
        for frag in _path_to_tikz(d, s, ox, oy):
            draw(frag)

    # `line` elements
    for m in re.finditer(r'<line([^>]+)/>', src):
        a = m.group(1)
        def num(k):
            mm = re.search(rf'\b{k}="(-?[\d.]+)"', a)
            return float(mm.group(1)) if mm else 0.0
        draw(f"{g(num('x1'), num('y1'))} -- {g(num('x2'), num('y2'))}")

    # `circle` elements
    for m in re.finditer(r'<circle([^>]+)/>', src):
        a = m.group(1)
        def num(k):
            mm = re.search(rf'\b{k}="(-?[\d.]+)"', a)
            return float(mm.group(1)) if mm else 0.0
        ccx, ccy, r = num("cx"), num("cy"), num("r")
        draw(f"{g(ccx, ccy)} circle[radius={r * s * 0.1:.5f}mm]")

    # `ellipse` elements
    for m in re.finditer(r'<ellipse([^>]+)/>', src):
        a = m.group(1)
        def num(k):
            mm = re.search(rf'\b{k}="(-?[\d.]+)"', a)
            return float(mm.group(1)) if mm else 0.0
        draw(f"{g(num('cx'), num('cy'))} "
             f"ellipse[x radius={num('rx') * s * 0.1:.5f}mm, "
             f"y radius={num('ry') * s * 0.1:.5f}mm]")

    # `polyline` elements
    for m in re.finditer(r'<polyline[^>]*?\bpoints="([^"]+)"', src):
        n = [float(v) for v in re.findall(r"-?\d*\.?\d+", m.group(1))]
        pts = list(zip(n[0::2], n[1::2]))
        frag = " -- ".join(g(px_, py_) for px_, py_ in pts)
        if frag:
            draw(frag)

    # `rect` elements
    for m in re.finditer(r'<rect([^>]+)/>', src):
        a = m.group(1)
        def num(k):
            mm = re.search(rf'\b{k}="(-?[\d.]+)"', a)
            return float(mm.group(1)) if mm else 0.0
        x, y, w, h, r = (num("x"), num("y"), num("width"), num("height"),
                         num("rx"))
        if r:
            draw(rf"{g(x + r, y)} -- {g(x + w - r, y)} "
                 rf"arc[start angle=90, end angle=0, radius={r * s * 0.1:.5f}mm] "
                 rf"-- {g(x + w, y + h - r)} "
                 rf"arc[start angle=0, end angle=-90, radius={r * s * 0.1:.5f}mm] "
                 rf"-- {g(x + r, y + h)} "
                 rf"arc[start angle=-90, end angle=-180, radius={r * s * 0.1:.5f}mm] "
                 rf"-- {g(x, y + r)} "
                 rf"arc[start angle=-180, end angle=-270, radius={r * s * 0.1:.5f}mm] "
                 rf"-- cycle")
        else:
            draw(f"{g(x, y)} rectangle {g(x + w, y + h)}")
    return "".join(parts)


def chip(cx: float, cy: float, text: str, color: str, fill: str,
         size: float = 22, pad: float = 34) -> str:
    """Pill-shaped answer chip; cx is the centre of the pill."""
    w = tw(text, size, 600) + pad * 1.4
    h = size + 22
    return (R(cx - w / 2, cy - h / 2, w, h, rx=h / 2, stroke=color, fill=fill,
              sw=1.6)
            + T(cx, cy + size * 0.36, text, size, weight=600, color=color,
                anchor="middle"))


BAD_FILL = "#fdf4f1"


def qtag(x0: float, cy: float, text: str, color: str) -> str:
    """Open question chip for panel (a): a crossed marker plus its label.

    `x0` is the chip's left edge, matching how the rest of panel (a) positions
    its boxes. Treating it as a centre instead pushes wide labels past the
    canvas edge, which silently widens the whole picture.
    """
    w = tw(text, 21, 400) + 46
    h = 34
    y0 = cy - h / 2
    return "".join([
        R(x0, y0, w, h, rx=h / 2, stroke=color, fill=BAD_FILL, sw=1.5),
        poly([(x0 + 17, cy - 6), (x0 + 27, cy + 4)], color, 2.6),
        poly([(x0 + 27, cy - 6), (x0 + 17, cy + 4)], color, 2.6),
        T(x0 + 36, cy + 7.5, text, 21, color=color, anchor="start"),
    ])


# ── panel (b) geometry ─────────────────────────────────────────────────────
# The four stages share CARD_W so the governing path keeps one rhythm; only the
# loop lane below breaks the grid, on purpose.
BX, CARD_W, GAP = 780.0, 186.0, 44.0
C1 = BX
C2 = C1 + CARD_W + GAP
C3 = C2 + CARD_W + GAP
C4 = C3 + CARD_W + GAP
LOOP_CY = 236.0
CARD_Y, CARD_H = 150.0, 172.0
NODE_CY = CARD_Y + CARD_H / 2
AMBER_D = "#8a5c0c"      # inverted amber face for the decision card
HAIR_DARK = "#aab5bb"
# pgf has no alpha channel, so the two "white wash on a dark face" values are
# pre-composited against the amber face they sit on.
WHITE_22 = "#5a3f14"
WHITE_28 = "#6b4d1c"


# ── panel (a): application-specific integration (deliberately desaturated) ──
def panel_a() -> list[str]:
    o: list[str] = []
    X0, CARD_W, GAP = 30.0, 156.0, 26.0
    MID_X, MID_W = X0 + CARD_W + GAP, 206.0
    DEV_X = MID_X + MID_W + GAP
    URX = 11.0

    o.append(T(X0, 52, "(a) Application-specific integration", 26,
               weight=700, color=INK))
    o.append(T(X0, 80, "each application rebuilds its own write path", 21,
               color=MUTE, style=' font-style="italic"'))

    for n, (y, dev_icon, dev_label) in enumerate((
            (108.0, "factory", "Line A"), (256.0, "database", "Line B"),
            (404.0, "gauge", "Line C")), start=1):
        cy = y + 62.0
        # agent
        o.append(R(X0, y, CARD_W, 124, rx=URX, stroke=MUTE, fill="#ffffff",
                   sw=1.6))
        o.append(icon("bot", X0 + 34, cy, 42, MUTE, 2.1))
        o.append(T(X0 + 66, cy + 8, f"Agent {n}", 23, weight=600, color=BODY))
        # duplicated middleware stack
        o.append(R(MID_X, y, MID_W, 124, rx=URX, stroke=MUTE, fill="#f2f5f6",
                   sw=1.6))
        for k, label in enumerate(("driver", "permission", "logging")):
            ly = y + 34 + k * 30
            o.append(T(MID_X + 20, ly, label, 21, color=SUB))
            if k:
                o.append(seg(MID_X + 14, ly - 20, MID_X + MID_W - 14, ly - 20,
                             HAIR, 1.1))
        # device
        o.append(R(DEV_X, y, CARD_W, 124, rx=URX, stroke=MUTE, fill="#ffffff",
                   sw=1.6))
        o.append(icon(dev_icon, DEV_X + 34, cy, 42, MUTE, 2.1))
        o.append(T(DEV_X + 66, cy + 8, dev_label, 23, weight=600, color=BODY))
        o.append(T(DEV_X + 66, cy + 32, "(raw I/O)", 20, color=HAIR_DARK))

        o.append(arrow(X0 + CARD_W + 3, cy, MID_X - 3, cy, MUTE, "right", 1.6))
        o.append(arrow(MID_X + MID_W + 3, cy, DEV_X - 3, cy, MUTE, "right", 1.6))

    # duplication bracket
    o.append(poly([(MID_X, 544), (MID_X, 560), (MID_X + MID_W, 560),
                   (MID_X + MID_W, 544)], MUTE, 1.8))
    o.append(T(MID_X + MID_W / 2, 592, "duplicated per application", 21,
               weight=600, color=SUB, anchor="middle"))

    # unresolved-questions card
    CX, CY, CW, CH = X0, 620.0, DEV_X + CARD_W - X0, 138.0
    o.append(R(CX, CY, CW, CH, rx=URX, stroke="#cbd5da", fill="#fafbfb",
               sw=1.5))
    o.append(T(CX + 24, CY + 40, "Unresolved on every write path", 23,
               weight=700, color=INK))
    for k, (label, color) in enumerate((
            ("who is authorized", BAD), ("which limits apply", BAD),
            ("write \u2194 outcome link", BAD))):
        o.append(qtag(CX + 24, CY + 74 + k * 22, label, color))
    return o


HAIR_DARK = "#aab5bb"


# ── panel (b): the governed loop (this work) ───────────────────────────────
# Column geometry. The four stages all share CARD_W so the governing path has
# one rhythm; only the loop lane below breaks the grid, on purpose.
BX, CARD_W, GAP = 780.0, 186.0, 44.0
C1 = BX
C2 = C1 + CARD_W + GAP                 # 1010
C3 = C2 + CARD_W + GAP                 # 1236
C4 = C3 + CARD_W + GAP                 # 1462
LOOP_CY = 236.0                        # centre-line of the governing path
CARD_Y, CARD_H = 150.0, 172.0
NODE_CY = CARD_Y + CARD_H / 2


def card(x: float, w: float, edge: str, face: str, inverse: bool,
         ic: str, title: str, sub: list[str]) -> list[str]:
    """A stage card; `inverse` swaps to a dark face for the decision card."""
    o: list[str] = []
    o.append(R(x, CARD_Y, w, CARD_H, rx=13, stroke=edge if not inverse else "none",
               fill=face, sw=2.2 if not inverse else 0))
    if inverse:
        # inner keyline keeps the dark card from reading as a flat blob. pgf
        # has no alpha here, so the "hairline on a dark face" is a literal
        # value chosen to match the 22%-white wash it replaces.
        o.append(R(x + 7, CARD_Y + 7, w - 14, CARD_H - 14, rx=9,
                   stroke=WHITE_22, fill="none", sw=1.2))
    t_col = "#ffffff" if inverse else BODY
    s_col = "#c8d6de" if inverse else SUB
    ic_col = "#8fc0c6" if inverse else edge
    o.append(icon(ic, x + 28, CARD_Y + 46, 40, ic_col, 2.2))
    o.append(T(x + 60, CARD_Y + 57, title, 26, weight=700, color=t_col))
    o.append(seg(x + 26, CARD_Y + 74, x + w - 26, CARD_Y + 74,
                 WHITE_28 if inverse else HAIR, 1.2))
    for k, line in enumerate(sub):
        o.append(T(x + 60, CARD_Y + 100 + k * 26, line, 21.5, color=s_col))
    return o


def panel_b() -> list[str]:
    o: list[str] = []

    # panel ground + editorial title
    o.append(R(BX - 22, 14, W - (BX - 22) - 24, H - 28, rx=16,
               stroke="none", fill=PANEL))
    o.append(T(BX, 54, "(b) Governed member\u2013node binding", 26,
               weight=700, color=INK))
    o.append(T(BX + 458, 54, "this work", 21, color=TEAL, tracking=0.6))
    o.append(T(BX, 82, "one reusable write path, one evidence record",
               21, color=MUTE, style=' font-style="italic"'))

    # ── loop lane: soft wash + the return edge drawn as one open circuit ──
    lane_x0, lane_x1 = C1 - 6, C4 + CARD_W + 14
    o.append(R(lane_x0, CARD_Y - 14, lane_x1 - lane_x0, CARD_H + 28, rx=20,
               stroke="none", fill=LANE))

    # forward path
    o.append(arrow(C1 + CARD_W + 4, LOOP_CY, C2 - 4, LOOP_CY, NAVY, "right"))
    o.append(arrow(C2 + CARD_W + 4, LOOP_CY, C3 - 4, LOOP_CY, AMBER, "right"))
    o.append(arrow(C3 + CARD_W + 4, LOOP_CY, C4 - 4, LOOP_CY, TEAL, "right"))

    o.extend(card(C1, CARD_W, NAVY, NAVY_W, False, "users", "Channel",
                  ["task \u00b7 goal \u00b7 context",
                   "lead + workers \u00b7 memory"]))
    o.extend(card(C2, CARD_W, AMBER, AMBER_W, True, "clipboard-check",
                  "Write request",
                  ["binding \u00b7 approval", "range \u00b7 recipe window"]))
    o.extend(card(C3, CARD_W, TEAL, TEAL_W, False, "cpu", "DAQ / DCW",
                  ["semantic quantities", "5 driver families"]))
    o.extend(card(C4, CARD_W, NAVY, NAVY_W, False, "factory", "Plant",
                  ["devices \u00b7 setpoints", "cast-film line"]))
    _ = NODE_CY  # kept for readability of the geometry block

    # stage captions on the governing path
    # Stage captions label the transitions, so they sit in the inter-card gaps
    # rather than over the cards. At LOOP_CY they collided with the card
    # titles; raised to the top of the gap they read as arrow labels.
    CAP_Y = CARD_Y - 18
    for x0, x1, label, col in (
            (C1 + CARD_W, C2, "demand", MUTE),
            (C2 + CARD_W, C3, "admission", AMBER),
            (C3 + CARD_W, C4, "write + readback", TEAL)):
        o.append(T((x0 + x1) / 2, CAP_Y, label, 20, color=col,
                   anchor="middle", tracking=0.4))

    # governance answers, hung beneath the admission card
    o.append(seg(C2 + CARD_W / 2, CARD_Y + CARD_H + 2, C2 + CARD_W / 2, 362,
                 AMBER, 1.4, dash="3,5"))
    o.append(chip(C2 + CARD_W / 2, 382, "who writes", TEAL, "#ffffff", 21))
    o.append(T(C2 + CARD_W / 2, 412, "which limits apply", 21, color=AMBER,
               anchor="middle"))

    # shared production context: a stub rail hanging under the loop, feeding
    # both the binding and the admission decision.
    RY, RH = 436.0, 40.0
    RAIL_X0, RAIL_X1 = C1 + 8, C3 + CARD_W - 8
    o.append(R(RAIL_X0, RY, RAIL_X1 - RAIL_X0, RH, rx=9,
               stroke="#c9d8dc", fill="#ffffff", sw=1.5))
    # Title on the left, values on the right. A centred title collided with
    # the right-aligned value list once the reason phrase grew.
    o.append(T(RAIL_X0 + 18, RY + 27,
               "shared production context", 21.5, weight=600, color=BODY))
    o.append(T(RAIL_X1 - 18, RY + 27, "line \u00b7 product \u00b7 recipe \u00b7 run",
               21, color=SUB, anchor="end"))
    o.append(seg(C2 + CARD_W / 2, RY, C2 + CARD_W / 2, CARD_Y + CARD_H + 4,
                 "#9fb4bb", 1.5, dash="6,5"))

    # ── the return edge: readback -> record -> verdict -> back to the channel
    RET_X = C4 + CARD_W / 2
    o.append(seg(RET_X, CARD_Y + CARD_H + 6, RET_X, 552, TEAL, 2.2))
    o.append(seg(RET_X, 552, 1160, 552, TEAL, 2.2))

    REC_X, REC_Y, REC_W, REC_H = C1, 508.0, 380.0, 128.0
    o.append(R(REC_X, REC_Y, REC_W, REC_H, rx=13, stroke=TEAL, fill="#ffffff",
               sw=2.4))
    o.append(icon("file-text", REC_X + 28, REC_Y + 40, 38, TEAL, 2.2))
    o.append(T(REC_X + 58, REC_Y + 50, "Intervention record", 25, weight=700,
               color=BODY))
    o.append(seg(REC_X + 24, REC_Y + 66, REC_X + REC_W - 24, REC_Y + 66,
                 HAIR, 1.2))
    # the four distinguishable evidence states, as a strict sequence
    seq = ("proposal", "result", "observation", "verdict", "compensation")
    sx, sy = REC_X + 24, REC_Y + 78
    for k, label in enumerate(seq):
        w_k = tw(label, 19, 400) + 30
        o.append(R(sx, sy, w_k, 30, rx=7, stroke="#a8c6c8", fill=TEAL_W,
                   sw=1.3))
        o.append(T(sx + w_k / 2, sy + 20, label, 19, color=TEAL,
                   anchor="middle"))
        if k < len(seq) - 1:
            o.append(T(sx + w_k + 6, sy + 20, "\u203a", 19, color=MUTE))
        sx += w_k + 17
    # the load-bearing disclaimer, stated once inside the record
    o.append(seg(REC_X + 24, REC_Y + REC_H - 32, REC_X + REC_W - 24,
                 REC_Y + REC_H - 32, HAIR, 1.2))
    o.append(T(REC_X + 24, REC_Y + REC_H - 12,
               "readback \u00b7 process observation \u00b7 submitted judgment "
               "stay separate", 20, color=AMBER))

    # record -> channel (closes the loop). The return edge leaves from the
    # record's left edge rather than its centre; running it along REC_Y + 60
    # cut straight through the box and collided with the evidence row.
    RET_Y = REC_Y + REC_H - 22
    o.append(seg(REC_X, RET_Y, C1 + CARD_W / 2, RET_Y, TEAL, 2.2))
    o.append(arrow(C1 + CARD_W / 2, RET_Y, C1 + CARD_W / 2,
                   CARD_Y + CARD_H + 6, TEAL, "up"))
    o.append(T(C1 + CARD_W / 2 + 12, RET_Y + 20, "verdict recorded", 20,
               color=TEAL))

    # footer note
    o.append(T(C1, 700, "* Readback is attempted only where the driver supports "
               "it; fast PLC regulation and plant protection stay outside the "
               "agent-team loop.", 20, color=SUB,
               style=' font-style="italic"'))
    return o






# ── emit ───────────────────────────────────────────────────────────────────
def palette(body: str) -> list[str]:
    """Every colour the emitted TikZ actually references, as #rrggbb.

    The primitives convert a hex literal to an xcolor name (`#2b5671` ->
    `c2b5671`) as they build each statement, so the body no longer contains raw
    hex. Scanning for the `cRRGGBB` names instead means a colour added in a
    panel can never produce an "Undefined color" error at compile time.
    """
    seen: list[str] = []
    for m in re.finditer(r"\bc([0-9a-f]{6})\b", body):
        c = "#" + m.group(1)
        if c not in seen:
            seen.append(c)
    return seen


def build_body() -> str:
    """The figure's TikZ picture body: panel (a), the divider, panel (b).

    The panel functions return TikZ statements, so this is the single source of
    truth for the artwork and the PDF is a direct rendering of it.
    """
    return "".join([
        R(0, 0, W, H, rx=0, fill="#ffffff", sw=0),
        *panel_a(),
        seg(760, 30, 760, H - 30, RULE, 1.4),
        *panel_b(),
    ])


def build_tex() -> str:
    """A standalone XeLaTeX document that is the figure.

    XeLaTeX is used rather than pdfLaTeX because it resolves the real Times New
    Roman faces, whereas the pdfLaTeX `times` package substitutes Nimbus Roman.
    The QA step reports which family actually landed in the PDF.
    """
    body = build_body()
    colours = "\n".join(
        rf"\definecolor{{{hexn(c)}}}{{HTML}}{{{c.lstrip('#').upper()}}}"
        for c in palette(body))
    return "\n".join([
        r"\documentclass[border=0pt,varwidth=false]{standalone}",
        r"\usepackage{fontspec}",
        r"\setmainfont{Times New Roman}",
        r"\usepackage{xcolor}",
        r"\usepackage{tikz}",
        colours,
        r"\pagestyle{empty}",
        r"\begin{document}",
        r"\begin{tikzpicture}[x=0.1mm,y=0.1mm,line join=round]",
        # Pin the picture to the intended canvas. Without this, one stray
        # coordinate outside 0..W grows the bounding box and silently changes
        # the page size -- the figure must be exactly 181 mm wide whatever the
        # artwork does.
        rf"\path[use as bounding box] (0,0) rectangle ({W:g},{ydown(H):g});",
        body,
        r"\end{tikzpicture}",
        r"\end{document}",
    ]) + "\n"


def emit() -> None:
    """Write the LaTeX source and an HTML preview of the same figure.

    The HTML file is the human-reviewable copy: it embeds the same geometry as
    absolutely positioned boxes so the design can be inspected in a browser and
    edited by hand, while the PDF -- the artifact the paper includes -- comes
    from the LaTeX source above.
    """
    tex = build_tex()
    (HERE / f"{STEM}.tex").write_text(tex, encoding="utf-8")
    # a plain-text trace of the drawing, useful when diffing two revisions
    (HERE / f"{STEM}.tikz").write_text(build_body(), encoding="utf-8")


def to_pdf() -> Path:
    """Compile the LaTeX figure to a standalone vector PDF."""
    src = HERE / f"{STEM}.tex"
    cmd = ["xelatex", "-interaction=nonstopmode", "-halt-on-error",
           "-output-directory", str(HERE), src.name]
    r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True,
                       errors="replace")
    if r.returncode != 0 or not (HERE / f"{STEM}.pdf").exists():
        log = HERE / f"{STEM}.log"
        if log.exists():
            tail = "\n".join(log.read_text(encoding="utf-8", errors="replace")
                             .splitlines()[-40:])
            raise SystemExit(f"xelatex failed:\n{tail}")
        raise SystemExit(f"xelatex failed: {r.stdout[-2000:]}")
    return HERE / f"{STEM}.pdf"


def qa(pdf: Path) -> dict:
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
            if inter.width > 1.0 and inter.height > 1.0:
                overlaps.append([first["text"], second["text"]])
    page.get_pixmap(dpi=DPI, alpha=False).save(HERE / f"{STEM}.png")
    page.get_pixmap(dpi=DPI, colorspace=fitz.csGRAY, alpha=False).save(
        HERE / f"{STEM}-grayscale.png")
    q = {
        "figure": STEM,
        "generator": Path(__file__).name,
        "pipeline": "authoring geometry -> XeLaTeX + TikZ -> vector PDF",
        "size_pt": size,
        "size_mm": [round(size[0] * 25.4 / 72, 2),
                    round(size[1] * 25.4 / 72, 2)],
        "ieee_textwidth_pt": 516.0,
        "embedded_fonts": sorted({f[3] for f in fonts}),
        "min_font_pt": round(min(s["size"] for s in spans), 2),
        "text_spans": len(spans),
        "spans_outside_canvas": outside,
        "text_overlap_pairs": overlaps,
        "vector_drawings": len(page.get_drawings()),
        "images_embedded": len(page.get_images(full=True)),
    }
    doc.close()
    # 181 mm is 513.07 pt, just inside IEEEtran's 516 pt \textwidth, so the
    # float needs no resize. The 7.0 pt floor clears the IEEE 6 pt minimum
    # while leaving headroom above the grayscale legibility limit.
    ok = (abs(size[0] - 513.07) <= 2.0 and q["min_font_pt"] >= 7.0
          and not outside and not overlaps and q["images_embedded"] == 0)
    (HERE / f"{STEM}-qa.json").write_text(json.dumps(q, indent=2) + "\n",
                                          encoding="utf-8")
    return q | {"_ok": ok}


def main() -> None:
    emit()
    pdf = to_pdf()
    q = qa(pdf)
    print(json.dumps({k: v for k, v in q.items() if k != "_ok"}, indent=2))
    if not q["_ok"]:
        raise SystemExit("QA FAILED")
    print("QA PASS")


if __name__ == "__main__":
    main()

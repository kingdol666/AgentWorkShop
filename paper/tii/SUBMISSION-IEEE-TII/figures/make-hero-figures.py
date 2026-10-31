"""Candidate hero figures for the IEEE TII manuscript (Figs. 1 and 2).

All drawing is vector (PDF/SVG) from code, full text width 7.16 in, Arial with
DejaVu Sans fallback, no raster images. Caption-level claims are restricted to
behaviour described in Sections III--IV; the stdio-MCP operation route and the
external PLC/SIS boundary are labelled as shown/not tested and external.

Run:
    python figures/make-hero-figures.py --only fig1-a
    python figures/make-hero-figures.py            # every candidate
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.font_manager import FontProperties
from matplotlib.patches import Circle, FancyArrowPatch, Polygon, Rectangle
from matplotlib.path import Path as MplPath

HERE = Path(__file__).resolve().parent
OUT = HERE / "hero-candidates"
QA = OUT / "qa"
AUDIT = Path.home() / ".codex" / "skills" / "nature-figure" / "scripts"

WIDTH_IN = 7.16

INK = "#1E2A33"
GRAY = "#57636E"
LIGHT = "#8A97A3"
RULE = "#AEB9C3"
HAIR = "#DCE2E7"

NAVY = "#264E6B"
TEAL = "#1F6F69"
GOLD = "#8E5A08"
PLUM = "#6B3F6E"

F_NAVY = "#EDF3F8"
F_TEAL = "#EBF3F1"
F_GOLD = "#FAF3E5"
F_PLUM = "#F4EFF5"
F_NEUTRAL = "#F7F9FA"

plt.rcParams.update({
    "font.family": ["Arial", "DejaVu Sans"],
    "font.size": 8.4,
    "svg.fonttype": "none",
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    "lines.linewidth": 0.8,
    "savefig.facecolor": "white",
    "figure.facecolor": "white",
})


class Board:
    """Exact-size point canvas with wrapping and text-fit assertions."""

    def __init__(self, height_in: float, width_in: float = WIDTH_IN):
        self.w = width_in * 72.0
        self.h = height_in * 72.0
        self.fig = plt.figure(figsize=(width_in, height_in), dpi=72)
        self.ax = self.fig.add_axes([0, 0, 1, 1])
        self.ax.set_xlim(0, self.w)
        self.ax.set_ylim(0, self.h)
        self.ax.set_axis_off()
        self._texts = []   # (artist, allowed rect, tag, size)
        self.cards = []
        self.fig.canvas.draw()
        self.renderer = self.fig.canvas.get_renderer()

    # ---- measurement -------------------------------------------------
    def width_of(self, s, size, weight="normal", style="normal"):
        prop = FontProperties(family=["Arial", "DejaVu Sans"], size=size,
                              weight=weight, style=style)
        w, _h, _d = self.renderer.get_text_width_height_descent(s, prop, False)
        return w

    def wrap(self, s, size, avail, weight="normal"):
        words = s.split()
        lines, cur = [], ""
        for word in words:
            trial = word if not cur else cur + " " + word
            if self.width_of(trial, size, weight) <= avail or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = word
        if cur:
            lines.append(cur)
        return lines

    # ---- primitives --------------------------------------------------
    def rect(self, x0, y0, x1, y1, *, fc="white", ec=RULE, lw=0.6, z=2,
             ls="-"):
        patch = Rectangle((x0, y0), x1 - x0, y1 - y0, facecolor=fc,
                          edgecolor=ec, linewidth=lw, linestyle=ls, zorder=z)
        self.ax.add_patch(patch)
        return patch

    def text(self, x, y, s, *, size=8.4, weight="normal", color=INK,
             ha="center", va="center", style="normal", z=6, rot=0,
             check=None, tag=""):
        artist = self.ax.text(
            x, y, s, fontsize=size, color=color, ha=ha, va=va,
            fontweight=weight, fontstyle=style, rotation=rot, zorder=z,
            linespacing=1.14,
        )
        if check is not None:
            self._texts.append((artist, check, tag or s[:30], size))
        return artist

    def card(self, x0, y0, x1, y1, title, lines=(), *, ec=NAVY, fc="white",
             tsize=8.8, bsize=8.4, pad=3.0, lw=0.6, align="center", z=3,
             title_color=None):
        self.rect(x0, y0, x1, y1, fc=fc, ec=ec, lw=lw, z=z)
        avail = (x1 - x0) - 2 * pad
        wrapped = []
        for line in lines:
            wrapped.extend(self.wrap(line, bsize, avail))
        th = tsize * 1.14
        bh = bsize * 1.16
        total = th + len(wrapped) * bh
        block_top = (y0 + y1) / 2 + total / 2
        block_top = min(block_top, y1 - pad + 1.0)
        ty = block_top - th / 2
        cx = (x0 + x1) / 2
        tx = cx if align == "center" else x0 + pad
        ha = "center" if align == "center" else "left"
        limit = (x0 + pad, y0 + pad * 0.6, x1 - pad, y1 - pad * 0.4)
        self.text(tx, ty, title, size=tsize, weight="bold",
                  color=title_color or ec, ha=ha, va="center",
                  check=limit, tag=f"{title} [title]")
        for index, line in enumerate(wrapped):
            ly = ty - th / 2 - bh * (index + 0.5) - 0.4
            self.text(tx, ly, line, size=bsize, color=INK, ha=ha,
                      va="center", check=limit, tag=line)
        self.cards.append((x0, y0, x1, y1, title))
        return (x0, y0, x1, y1)

    def plain(self, x0, y0, x1, y1, lines, *, ec=RULE, fc="white", size=8.4,
              color=INK, weight="normal", align="center", pad=3.0, lw=0.55,
              z=3, wrap=True):
        self.rect(x0, y0, x1, y1, fc=fc, ec=ec, lw=lw, z=z)
        avail = (x1 - x0) - 2 * pad
        items = []
        for line in lines:
            items.extend(self.wrap(line, size, avail) if wrap else [line])
        bh = size * 1.16
        top = (y0 + y1) / 2 + len(items) * bh / 2
        limit = (x0 + pad, y0 + pad * 0.5, x1 - pad, y1 - pad * 0.35)
        for index, item in enumerate(items):
            y = top - bh * (index + 0.5)
            x = (x0 + x1) / 2 if align == "center" else x0 + pad
            ha = "center" if align == "center" else "left"
            self.text(x, y, item, size=size, color=color, weight=weight, ha=ha,
                      va="center", check=limit, tag=item)
        return (x0, y0, x1, y1)

    def divided(self, x0, y0, x1, y1, parts, *, ec=NAVY, fc="white",
                tsize=8.8, bsize=8.0, pad=4.0, z=3, lw=0.7, header=None,
                header_fc=None, hsize=8.2):
        """One block with internal divisions; each flow lands on one block."""
        self.rect(x0, y0, x1, y1, fc=fc, ec=ec, lw=lw, z=z)
        body_top = y1
        if header:
            hh = 11.0
            self.rect(x0, y1 - hh, x1, y1, fc=header_fc or fc, ec=ec, lw=0.45,
                      z=z + 0.2)
            self.text(x0 + pad, y1 - hh / 2, header, size=hsize, weight="bold",
                      color=ec, ha="left",
                      check=(x0 + pad, y1 - hh + 0.6, x1 - pad, y1 - 0.6),
                      tag=header)
            body_top = y1 - hh
        total = sum(part[0] for part in parts)
        scale = (x1 - x0) / total
        x = x0
        for index, (width, title, lines) in enumerate(parts):
            width_pt = width * scale
            if index:
                self.ax.plot([x, x], [y0 + 2.0, body_top - 2.0], color=ec,
                             lw=0.45, alpha=0.55, zorder=z + 0.4)
            avail = width_pt - 2 * pad
            wrapped = []
            for line in lines:
                wrapped.extend(self.wrap(line, bsize, avail))
            th = tsize * 1.14
            bh = bsize * 1.16
            block = th + len(wrapped) * bh
            top = (y0 + body_top) / 2 + block / 2
            limit = (x + pad, y0 + 2.2, x + width_pt - pad, body_top - 1.4)
            self.text(x + pad, top - th / 2, title, size=tsize, weight="bold",
                      color=ec, ha="left", check=limit, tag=title)
            for j, line in enumerate(wrapped):
                self.text(x + pad, top - th - bh * (j + 0.5), line,
                          size=bsize, color=INK, ha="left", check=limit,
                          tag=line)
            x += width_pt
        return (x0, y0, x1, y1)

    def chip(self, x0, y0, x1, y1, label, *, ec=NAVY, fc="white", size=8.2,
             color=None, weight="normal", pad=2.2):
        self.rect(x0, y0, x1, y1, fc=fc, ec=ec, lw=0.55, z=3)
        self.text((x0 + x1) / 2, (y0 + y1) / 2, label, size=size,
                  color=color or INK, weight=weight,
                  check=(x0 + pad, y0 + 1.2, x1 - pad, y1 - 1.2), tag=label)

    def diamond(self, cx, cy, hw, hh, label, *, ec=GOLD, fc=F_GOLD, size=8.2):
        pts = [(cx, cy + hh), (cx + hw, cy), (cx, cy - hh), (cx - hw, cy)]
        self.ax.add_patch(Polygon(pts, closed=True, facecolor=fc, edgecolor=ec,
                                  linewidth=0.65, zorder=3))
        self.text(cx, cy, label, size=size, color=ec, weight="bold",
                  check=(cx - hw * 0.6, cy - hh * 0.48, cx + hw * 0.6,
                         cy + hh * 0.48), tag=label)

    def arrow(self, pts, *, color=GRAY, lw=0.85, ls="-", head=True, ms=6.2,
              z=4, halo=False):
        pts = [(float(x), float(y)) for x, y in pts]
        if halo:
            for delta in (1.7, -1.7):
                if abs(pts[0][0] - pts[-1][0]) < 1e-6:   # vertical
                    shift = [(x + delta, y) for x, y in pts]
                else:
                    shift = [(x, y + delta) for x, y in pts]
                self.ax.add_line(plt.Line2D(
                    [p[0] for p in shift], [p[1] for p in shift], color="white",
                    lw=lw + 3.4, solid_capstyle="butt", zorder=z - 0.5))
        codes = [MplPath.MOVETO] + [MplPath.LINETO] * (len(pts) - 1)
        patch = FancyArrowPatch(
            path=MplPath(pts, codes), arrowstyle="-|>" if head else "-",
            mutation_scale=ms, linewidth=lw, linestyle=ls, color=color,
            shrinkA=0, shrinkB=0, capstyle="butt", joinstyle="miter", zorder=z,
        )
        self.ax.add_patch(patch)
        return patch

    def dot(self, x, y, r=1.5, color=NAVY, z=5):
        self.ax.add_patch(Circle((x, y), r, facecolor=color, edgecolor="none",
                                 zorder=z))

    # ---- audit ------------------------------------------------------
    def verify(self, tolerance=0.5):
        self.fig.canvas.draw()
        problems = []
        for artist, rect, tag, size in self._texts:
            bbox = artist.get_window_extent(self.renderer)
            x0, y0, x1, y1 = bbox.x0, bbox.y0, bbox.x1, bbox.y1
            if (x0 < rect[0] - tolerance or y0 < rect[1] - tolerance or
                    x1 > rect[2] + tolerance or y1 > rect[3] + tolerance):
                problems.append({
                    "tag": tag, "size": size,
                    "text_box": [round(v, 2) for v in (x0, y0, x1, y1)],
                    "limit": [round(v, 2) for v in rect],
                    "over_x": round(max(0.0, rect[0] - x0, x1 - rect[2]), 2),
                    "over_y": round(max(0.0, rect[1] - y0, y1 - rect[3]), 2),
                })
        return problems

    def save(self, name, *, dpi=600):
        OUT.mkdir(parents=True, exist_ok=True)
        QA.mkdir(parents=True, exist_ok=True)
        pdf = OUT / f"{name}.pdf"
        self.fig.savefig(pdf, metadata={
            "Title": name, "Author": "", "Subject": "IEEE TII figure",
            "Creator": "Matplotlib", "Keywords": "",
        })
        svg_path = OUT / f"{name}.svg"
        self.fig.savefig(svg_path)
        lines = svg_path.read_text(encoding="utf-8").splitlines()
        svg_path.write_text("\n".join(line.rstrip() for line in lines) + "\n",
                            encoding="utf-8")
        self.fig.savefig(OUT / f"{name}.png", dpi=dpi)
        problems = self.verify()
        (QA / f"{name}.fit.json").write_text(
            json.dumps({"size_in": [round(self.w / 72, 3),
                                    round(self.h / 72, 3)],
                        "candidates": problems}, indent=2), encoding="utf-8")
        plt.close(self.fig)
        return pdf, problems


# =====================================================================
# Fig. 1 -- A: layered architecture with record ownership
# =====================================================================
def fig1_a():
    b = Board(3.58)
    RX = 65.0
    L, R = 70.0, 390.0
    EX = 398.0
    EW = b.w - EX - 4.0

    rows = {
        "field": (19.0, 49.0),
        "svc": (57.0, 97.0),
        "ctx": (105.0, 135.0),
        "gov": (143.0, 181.0),
        "run": (189.0, 219.0),
        "acc": (227.0, 257.0),
    }
    accents = {"field": "#3F637D", "svc": TEAL, "ctx": "#2B7A72",
               "gov": GOLD, "run": NAVY, "acc": "#3A6280"}
    labels = {"field": "FIELD I/O", "svc": "SERVICES", "ctx": "CONTEXT",
              "gov": "GOVERNANCE", "run": "RUNTIME", "acc": "ACCESS"}
    fills = {"field": "#F4F7F9", "svc": "#F1F7F6", "ctx": "#EDF5F3",
             "gov": "#FBF5E9", "run": "#EDF3F8", "acc": "#F1F5F9"}

    for key in ("acc", "run", "gov", "ctx", "svc", "field"):
        y0, y1 = rows[key]
        b.ax.add_patch(Rectangle((L - 4, y0), R + 2 - (L - 4), y1 - y0,
                                 facecolor=fills[key], edgecolor="none",
                                 zorder=1))
        b.ax.add_patch(Rectangle((L - 4, y0), 2.6, y1 - y0,
                                 facecolor=accents[key], edgecolor="none",
                                 zorder=2))
        b.text(RX, (y0 + y1) / 2, labels[key], size=9.0, weight="bold",
               color=accents[key], ha="right",
               check=(-4, y0 + 2, RX + 2, y1 - 2), tag=labels[key])

    # ---- access -------------------------------------------------------
    b.card(70, 229, 268, 255, "Task / chat entry",
           ("CLI · web console · SDK · A2A",), ec=NAVY, fc="white",
           tsize=9.2, bsize=9.0, pad=2.4)
    b.card(274, 229, 390, 255, "Direct operation entry",
           ("REST · stdio-MCP",), ec=GOLD, fc="white", tsize=9.2, bsize=9.0,
           pad=2.4)

    # ---- runtime ------------------------------------------------------
    b.divided(70, 191, 340, 217, [
        (135, "Workspace & channel", ("task queue · memory",)),
        (135, "Task engine & harness", ("goal · loop · prompt",)),
    ], ec=NAVY, fc="white", tsize=9.2, bsize=9.0)

    # ---- governance ---------------------------------------------------
    b.divided(70, 145, 360, 179, [
        (88, "Tool catalog", ("discovery, not", "a permission")),
        (112, "Dispatch gate", ("scope · policy", "S & P & G & B")),
        (90, "Write admission", ("card · 180 s", "H ∩ B ∩ P ∩ R")),
    ], ec=GOLD, fc="#FDF9F0", tsize=9.2, bsize=9.0, pad=3.2)

    # ---- context ------------------------------------------------------
    b.divided(70, 107, 330, 133, [
        (130, "Production context", ("line–product–recipe–run",)),
        (130, "Scene & semantics", ("signals · guards · units",)),
    ], ec=TEAL, fc="white", tsize=9.2, bsize=9.0)

    # ---- services -----------------------------------------------------
    b.divided(70, 59, 387, 95, [
        (79, "DAQ edge", ("run-tagged",)),
        (79, "Write (DCW)", ("readback",)),
        (79, "MES", ("order history",)),
        (80, "Analysis", ("reports",)),
    ], ec=TEAL, fc="white", tsize=9.2, bsize=9.0,
        header="route handlers select a service adapter",
        header_fc=F_TEAL, hsize=9.0, pad=3.0)

    # ---- field I/O ----------------------------------------------------
    b.card(70, 21, 250, 47, "Configured protocol drivers",
           ("OPC UA · MQTT · Modbus",), ec="#3F637D", fc="white",
           tsize=9.2, bsize=9.0, pad=2.4)
    b.card(266, 21, 390, 47, "Plant or simulator",
           ("cast film · annealing",), ec="#3F637D", fc="white", tsize=9.2,
           bsize=9.0, pad=2.4)

    # ---- execution flow ----------------------------------------------
    b.arrow([(148, 229), (148, 217)], color=NAVY, lw=0.9)      # task -> runtime
    b.arrow([(200, 191), (200, 179)], color=NAVY, lw=0.9)      # turn -> gate
    # direct operation lane: no task, no harness turn; enters governance
    b.arrow([(380, 229), (380, 162), (360, 162)], color=GOLD, lw=0.9)
    # governance dispatches to the service handlers
    b.arrow([(345, 145), (345, 95)], color=GOLD, lw=0.9)
    # context supplies the active tuple to governance and configures services
    b.arrow([(240, 133), (240, 145)], color=TEAL, ls=(0, (2.8, 1.8)), lw=0.8)
    b.arrow([(220, 107), (220, 95)], color=TEAL, ls=(0, (2.8, 1.8)), lw=0.8)
    # services reach the field devices through configured drivers
    b.arrow([(150, 59), (150, 47)], color=TEAL, lw=0.9)
    b.arrow([(320, 59), (320, 47)], color=TEAL, lw=0.9)
    b.arrow([(250, 34), (266, 34)], color=TEAL, lw=0.9)

    # ---- evidence rail ------------------------------------------------
    b.rect(EX, 19, b.w - 4, 257, fc=F_NEUTRAL, ec=RULE, lw=0.6)
    b.text(EX + EW / 2, 248, "Service-owned records", size=9.2, weight="bold",
           color=NAVY)
    b.text(EX + EW / 2, 239, "own record types", size=9.0,
           color=GRAY)
    b.ax.plot([EX + 6, b.w - 10], [233, 233], color=HAIR, lw=0.6, zorder=2)
    rows_ev = [
        ("Task runtime", ("task journal", "approval decisions"), NAVY),
        ("Write control", ("receipts (3 grades)", "write audit · refusals"),
         TEAL),
        ("DAQ", ("run-tagged samples",), TEAL),
        ("Analysis", ("summaries",), TEAL),
        ("Recipe store", ("versions",), TEAL),
    ]
    y = 222.0
    for owner, lines, color in rows_ev:
        b.dot(EX + 7.5, y - 2.0, 1.6, color)
        b.text(EX + 13, y - 1.5, owner, size=9.2, weight="bold", color=color,
               ha="left", check=(EX + 11, y - 6, b.w - 8, y + 4), tag=owner)
        for index, line in enumerate(lines):
            b.text(EX + 13, y - 11.5 - index * 10.2, line, size=9.0,
                   color=INK, ha="left",
                   check=(EX + 11, y - 17 - index * 10.2, b.w - 8,
                          y - 6.5 - index * 10.2), tag=line)
        y -= 31.0
    b.ax.plot([EX + 6, b.w - 10], [y + 10, y + 10], color=HAIR, lw=0.6,
              zorder=2)
    b.text(EX + 7, y + 1, "Linked by actor and", size=9.0, color=GRAY,
           ha="left", check=(EX + 5, y - 4.5, b.w - 6, y + 6), tag="note 1")
    b.text(EX + 7, y - 9, "run IDs where a route", size=9.0, color=GRAY,
           ha="left", check=(EX + 5, y - 14.5, b.w - 6, y - 3.5), tag="note 2")
    b.text(EX + 7, y - 19, "supplies them.", size=9.0, color=GRAY,
           ha="left", check=(EX + 5, y - 24.5, b.w - 6, y - 13.5), tag="note 3")
    b.text(EX + 7, y - 31, "A receipt is not a", size=9.0, color=GRAY,
           ha="left", check=(EX + 5, y - 36.5, b.w - 6, y - 25.5), tag="note 4")
    b.text(EX + 7, y - 41, "process observation.", size=9.0, color=GRAY,
           ha="left", check=(EX + 5, y - 46.5, b.w - 6, y - 35.5), tag="note 5")

    # ---- footnote and legend -----------------------------------------
    b.text(8, 9, "Independent PLC / SIS protection remains external.",
           size=9.0, color=GRAY, ha="left")
    b.arrow([(272, 9), (288, 9)], color=GRAY, lw=0.9, ms=5.5)
    b.text(292, 9, "execution", size=9.0, color=GRAY, ha="left")
    b.arrow([(350, 9), (366, 9)], color=TEAL, lw=0.8,
            ls=(0, (2.8, 1.8)), ms=5.5)
    b.text(370, 9, "configuration", size=9.0, color=GRAY, ha="left")

    return b.save("fig1-A-layered")


# =====================================================================
# Fig. 1 -- B: task-to-device pipeline (serpentine stages)
# =====================================================================
def fig1_b():
    b = Board(3.64)
    c1 = (8.0, 128.0)
    c2 = (134.0, 266.0)
    c3 = (272.0, 384.0)
    c4 = (390.0, 507.0)

    def header(x0, x1, number, label, color):
        b.text(x0, 254, number, size=9.2, weight="bold", color=color, ha="left")
        b.text(x0 + 10, 254, label, size=8.6, weight="bold", color=color,
               ha="left", check=(x0 + 10, 249, x1, 259), tag=label)
        b.ax.plot([x0, x1], [248, 248], color=color, lw=0.9, zorder=3)

    header(*c1, "1", "TASK PLANE", NAVY)
    header(*c2, "2", "OPERATION PLANE", GOLD)
    header(*c3, "3", "SERVICE PLANE", TEAL)
    header(*c4, "4", "DEVICE PLANE", "#3E657F")

    # ---- 1 task plane (top-down) ------------------------------------
    b.card(c1[0], 216, c1[1], 242, "Task / chat entry",
           ("CLI · web · SDK · A2A · MCP",), ec=NAVY, fc=F_NAVY, pad=2.4)
    b.card(c1[0], 188, c1[1], 212, "Workspace & channel",
           ("tasks · memory · mailbox",), ec=NAVY, fc="white", pad=2.4)
    b.card(c1[0], 160, c1[1], 184, "Task engine",
           ("goal · loop · verdicts",), ec=NAVY, fc="white", pad=2.4)
    b.card(c1[0], 132, c1[1], 156, "Harness adapters",
           ("prompt assembly · registry",), ec=NAVY, fc="white", pad=2.4)

    # ---- 2 operation plane (bottom-up) ------------------------------
    b.card(c2[0], 132, c2[1], 166, "Catalog & dispatch gate",
           ("profile · policy · binding", "S · P · G · B, every call"),
           ec=GOLD, fc=F_GOLD, pad=2.4)
    b.card(c2[0], 168, c2[1], 200, "Approval & admission",
           ("pending card · 180 s expiry", "H ∩ B ∩ P ∩ R"), ec=GOLD, fc="white",
           pad=2.6)
    b.card(c2[0], 204, c2[1], 238, "Route handlers",
           ("read: DAQ · MES · retrieval", "write: DCW · recipe checks"),
           ec=GOLD, fc="white", pad=2.6)

    # ---- 3 service plane (top-down) ---------------------------------
    b.card(c3[0], 204, c3[1], 238, "DAQ edge runtime",
           ("per-node cadence", "timestamped samples"), ec=TEAL, fc=F_TEAL,
           pad=2.6)
    b.card(c3[0], 168, c3[1], 196, "Write control (DCW)",
           ("bounds · readback · audit",), ec=TEAL, fc="white", pad=2.4)
    b.card(c3[0], 134, c3[1], 166, "MES · analysis · models",
           ("order data · diagnostics", "retrieval · twin"), ec=TEAL, fc="white",
           pad=2.6)

    # ---- 4 device plane (top-down) ----------------------------------
    b.card(c4[0], 204, c4[1], 238, "Semantic nodes",
           ("DAQ / DCW bindings", "units · ranges"),
           ec="#3E657F", fc="white", pad=3.0)
    b.card(c4[0], 166, c4[1], 198, "Protocol drivers",
           ("OPC UA · MQTT", "Modbus TCP/RTU"), ec="#3E657F", fc="white",
           pad=2.6)
    b.card(c4[0], 132, c4[1], 160, "Plant or simulator",
           ("cast film · annealing",), ec="#3E657F", fc="white", pad=2.4)
    b.card(c2[0], 96, c2[0] + 80, 124, "Direct entry",
           ("no task",), ec=GOLD, fc=F_GOLD, tsize=8.4, pad=2.4)

    # ---- context strip ----------------------------------------------
    b.rect(8, 70, 384, 92, fc=F_TEAL, ec="none", z=1)
    b.text(14, 84, "CONTEXT", size=8.2, weight="bold", color=TEAL, ha="left")
    b.text(14, 74, "scene settings", size=8.0, color=GRAY, ha="left")
    b.text(86, 84, "line–product–recipe–run · scene blueprint", size=8.4,
           color=INK, ha="left", check=(86, 79, 380, 89), tag="ctx line 1")
    b.text(86, 74, "signal maps · objectives · guards", size=8.4, color=INK,
           ha="left", check=(86, 69, 380, 79), tag="ctx line 2")
    b.text(390, 92, "PLC / SIS protection is external", size=8.0, color=GRAY,
           ha="left", check=(390, 87, 507, 97), tag="sis")

    # ---- evidence strip ---------------------------------------------
    b.rect(8, 18, 507, 64, fc=F_NEUTRAL, ec=RULE, lw=0.6, z=1)
    b.text(14, 52, "Service-owned records", size=8.6, weight="bold",
           color=NAVY, ha="left")
    b.text(14, 41, "each owner keeps its own type", size=8.0, color=GRAY,
           ha="left")
    b.text(14, 30, "linked by actor and run IDs", size=8.0, color=GRAY,
           ha="left")
    chips = ["task journal", "approvals", "receipts", "observations",
             "summaries", "recipe versions"]
    for index, chip in enumerate(chips):
        row, col = divmod(index, 3)
        x = 176.0 + col * 112
        y = 44.0 if row == 0 else 22.0
        b.chip(x, y, x + 104, y + 15, chip, ec=RULE, fc="white", size=8.0)

    # ---- flows -------------------------------------------------------
    b.arrow([(68, 216), (68, 212)], color=NAVY)
    b.arrow([(68, 188), (68, 184)], color=NAVY)
    b.arrow([(68, 160), (68, 156)], color=NAVY)
    b.arrow([(128, 144), (134, 144)], color=GOLD)
    b.arrow([(200, 166), (200, 170)], color=GOLD)          # gate -> approval
    b.arrow([(200, 200), (200, 204)], color=GOLD)          # approval -> handler
    b.arrow([(266, 221), (272, 221)], color=TEAL)          # handler -> services
    b.arrow([(328, 204), (328, 196)], color=TEAL)          # DAQ -> DCW
    b.arrow([(328, 168), (328, 166)], color=TEAL)          # DCW -> MES
    b.arrow([(384, 221), (390, 221)], color=TEAL)          # DAQ -> nodes
    b.arrow([(384, 182), (390, 182)], color=TEAL)          # DCW -> drivers
    b.arrow([(448, 204), (448, 198)], color="#3E657F")     # nodes -> drivers
    b.arrow([(448, 166), (448, 160)], color="#3E657F")     # drivers -> plant
    # context feeds the operation, service and device planes (dashed)
    b.arrow([(68, 92), (68, 132)], color=TEAL, ls=(0, (2.6, 1.8)), lw=0.75)
    b.arrow([(240, 92), (240, 136)], color=TEAL, ls=(0, (2.6, 1.8)), lw=0.75)
    b.arrow([(174, 124), (174, 136)], color=GOLD, ls=(0, (3.0, 1.8)), lw=0.8)
    b.arrow([(328, 92), (328, 136)], color=TEAL, ls=(0, (2.6, 1.8)), lw=0.75)
    b.text(8, 10, "Direct REST and stdio-MCP operations enter the gate without a task or harness turn.",
           size=8.2, color=GRAY, ha="left", check=(8, 4, 320, 16), tag="footnote")
    b.arrow([(330, 10), (346, 10)], color=GOLD, lw=0.8, ms=5.5,
            ls=(0, (3.0, 1.8)))
    b.text(350, 10, "direct route", size=8.2, color=GRAY, ha="left",
           check=(348, 5, 400, 15), tag="direct legend")

    return b.save("fig1-B-pipeline")


# =====================================================================
# Fig. 1 -- C: two routes, one operation boundary
# =====================================================================
def fig1_c():
    b = Board(3.60)
    cols = [(8.0, 130.0), (136.0, 272.0), (278.0, 404.0), (410.0, 507.0)]
    labels = ["ENTRY", "SHARED CHECKS", "SHARED EXECUTION", "RECORDS"]

    for (x0, x1), label in zip(cols, labels):
        b.text(x0, 250, label, size=8.2, weight="bold", color=GRAY, ha="left",
               check=(x0, 245, x1, 255), tag=label)
        b.ax.plot([x0, x1], [244, 244], color=HAIR, lw=0.8, zorder=2)

    b.card(8, 202, 130, 236, "Task / chat surfaces",
           ("CLI · web console · SDK", "A2A · MCP task methods"), ec=NAVY,
           fc=F_NAVY, align="left", pad=3.4)
    b.card(8, 170, 130, 194, "Task runtime",
           ("workspace · engine · harness",), ec=NAVY, fc="white", align="left",
           pad=3.4, tsize=8.4)
    b.card(8, 118, 130, 160, "Direct surfaces",
           ("REST · stdio-MCP operations", "no task · no harness turn"),
           ec=GOLD, fc=F_GOLD, align="left", pad=3.6)

    b.rect(136, 116, 404, 220, fc="#FDFBF6", ec="none", z=1)
    b.card(136, 118, 272, 218, "Shared operation gate",
           ("catalog: discovery ≠ permission", "scope · channel policy",
            "grant · binding · ownership", "S ∧ P ∧ G ∧ B at every call",
            "write: approval card · 180 s", "H ∩ B ∩ P ∩ R admission",
            "step · interval · hold checks"), ec=GOLD, fc=F_GOLD,
           align="left", pad=5.0, tsize=9.0, bsize=8.4)
    b.card(278, 118, 404, 218, "Shared handlers",
           ("read: DAQ · MES · retrieval", "write: DCW · recipe",
            "semantic nodes · drivers", "live state resolved at call",
            "receipt graded", "observation separate"),
           ec=TEAL, fc=F_TEAL, align="left", pad=5.0, tsize=9.0, bsize=8.4)

    b.card(410, 168, 507, 236, "Task records",
           ("task journal", "approvals", "receipt", "observation"), ec=NAVY,
           fc="white", align="left", pad=3.6, tsize=8.6)
    b.card(410, 92, 507, 160, "Operation records",
           ("receipt · readback", "observation", "no task edge"), ec=GOLD,
           fc="white", align="left", pad=3.6, tsize=8.6)

    b.rect(8, 56, 507, 88, fc=F_TEAL, ec="none", z=1)
    b.text(14, 78, "Production context", size=8.6, weight="bold", color=TEAL,
           ha="left")
    b.text(14, 65, "line–product–recipe–run · scene blueprint · semantic nodes",
           size=8.4, color=INK, ha="left")
    b.text(300, 78, "grounds prompts and live checks;", size=8.0, color=GRAY,
           ha="left", check=(300, 73, 505, 83), tag="ctx note 1")
    b.text(300, 65, "never grants authority", size=8.0, color=GRAY, ha="left",
           check=(300, 60, 505, 70), tag="ctx note 2")

    b.rect(8, 12, 507, 48, fc=F_NEUTRAL, ec=RULE, lw=0.6, z=1)
    b.text(14, 37, "Services", size=8.2, weight="bold", color=TEAL, ha="left")
    b.text(14, 24, "DAQ edge · DCW · MES · analysis · models", size=8.2,
           color=INK, ha="left", check=(14, 19, 260, 29), tag="svc line 1")
    b.text(276, 37, "Field I/O", size=8.2, weight="bold", color="#3E657F",
           ha="left")
    b.text(276, 24, "OPC UA · MQTT · Modbus → plant or simulator", size=8.2,
           color=INK, ha="left", check=(276, 19, 505, 29), tag="svc line 2")

    b.arrow([(68, 202), (68, 194)], color=NAVY)
    b.arrow([(130, 182), (136, 182)], color=NAVY)
    b.arrow([(130, 139), (136, 139)], color=GOLD)
    b.arrow([(272, 219), (278, 219)], color=GOLD)
    b.arrow([(272, 144), (278, 144)], color=GOLD)
    b.arrow([(404, 202), (410, 202)], color=TEAL)
    b.arrow([(404, 126), (410, 126)], color=TEAL)
    for x in (200, 341):
        b.arrow([(x, 88), (x, 118)], color=TEAL, ls=(0, (2.6, 1.8)), lw=0.75)

    return b.save("fig1-C-routes")


# =====================================================================
# Fig. 2 -- A: per-call control flow with route expansion
# =====================================================================
def fig2_a():
    b = Board(3.58)

    # ---- harness row ---------------------------------------------------
    b.card(8, 232, 120, 256, "Task / chat entry", (), ec=NAVY, fc=F_NAVY,
           tsize=9.2)
    b.plain(132, 232, 244, 256, ("Resolve context", "retrieve memory"),
            ec=NAVY, fc="white", size=9.0)
    b.plain(256, 232, 368, 256, ("Assemble prompt",), ec=NAVY, fc="white",
            size=9.0)
    b.card(380, 232, 498, 256, "Harness turn",
           ("scoped catalog",), ec=NAVY, fc=F_NAVY, tsize=9.2, bsize=9.0,
           pad=2.0)
    for x in (120, 244, 368):
        b.arrow([(x, 244), (x + 12, 244)], color=NAVY, lw=0.9)

    # ---- shared checks --------------------------------------------------
    b.card(8, 192, 276, 220, "Shared dispatch checks",
           ("scope · policy · grant · binding · S & P & G & B",), ec=GOLD,
           fc=F_GOLD, pad=2.4, tsize=9.2, bsize=9.0)
    b.diamond(322, 206, 34, 14, "allowed?", ec=GOLD, fc="white", size=9.0)
    b.plain(368, 192, 498, 220, ("no: tool error", "to the harness"), ec=GOLD,
            fc="white", size=9.0)
    b.arrow([(276, 206), (288, 206)], color=GOLD, lw=0.9)
    b.arrow([(356, 206), (368, 206)], color=GOLD, lw=0.9)
    b.arrow([(430, 220), (430, 232)], color=GOLD, lw=0.9)
    # the harness turn issues the call; one long edge, no stub
    b.arrow([(380, 232), (270, 220)], color=NAVY, lw=0.9)

    # ---- handler selection ---------------------------------------------
    b.card(8, 162, 498, 180, "Select handler: read route (left) or write route (right)",
           (), ec=GOLD, fc="white", tsize=9.2)
    b.arrow([(322, 192), (322, 180)], color=GOLD, lw=0.9)

    # ---- read route ------------------------------------------------------
    b.rect(8, 50, 176, 150, fc="white", ec=RULE, lw=0.6, z=2)
    b.card(14, 124, 170, 148, "Read handler", (), ec=TEAL, fc=F_TEAL,
           tsize=9.2)
    b.plain(14, 88, 170, 112, ("DAQ · MES · retrieval",), ec=TEAL, fc="white",
            size=9.0)
    b.plain(14, 52, 170, 76, ("summary records",), ec=TEAL, fc="white",
            size=9.0)
    b.arrow([(92, 162), (92, 148)], color=TEAL, lw=0.9)
    b.arrow([(92, 124), (92, 112)], color=TEAL, lw=0.9)
    b.arrow([(92, 88), (92, 76)], color=TEAL, lw=0.9)

    # ---- write route -----------------------------------------------------
    b.rect(184, 50, 498, 150, fc="#FDFBF6", ec=RULE, lw=0.6, z=2)
    b.card(190, 124, 286, 148, "Route guards", ("run · bounds",), ec=GOLD,
           fc="white", tsize=9.0, bsize=9.0, pad=2.0)
    b.card(298, 124, 394, 148, "Approval", ("if needed",), ec=GOLD, fc=F_GOLD,
           tsize=9.0, bsize=9.0, pad=2.0)
    b.card(406, 124, 492, 148, "Human decision", ("approve / decline",), ec=PLUM,
           fc=F_PLUM, tsize=9.0, bsize=9.0, pad=2.0)
    b.card(190, 88, 286, 112, "Driver write", ("bounded batch",), ec=GOLD,
           fc="white", tsize=9.0, bsize=9.0, pad=2.0)
    b.card(298, 88, 394, 112, "DCW admission", ("H ∩ B ∩ P ∩ R",), ec=GOLD,
           fc="white", tsize=9.0, bsize=9.0, pad=2.0)
    b.diamond(449, 100, 34, 12, "tuple?", ec=GOLD, fc="white", size=9.0)
    b.card(190, 52, 286, 76, "Grade receipt", ("3 outcomes",), ec=GOLD,
           fc="white", tsize=9.0, bsize=9.0, pad=2.0)
    b.card(298, 52, 394, 76, "Observation", ("DAQ record",), ec=TEAL,
           fc="white", tsize=9.0, bsize=9.0, pad=2.0)
    b.card(406, 52, 492, 76, "Refuse", ("no write",), ec=PLUM, fc=F_PLUM,
           tsize=9.0, bsize=9.0, pad=2.0)

    b.arrow([(340, 162), (340, 148)], color=GOLD, lw=0.9)
    b.arrow([(286, 136), (298, 136)], color=GOLD, lw=0.9)
    b.arrow([(394, 136), (406, 136)], color=GOLD, lw=0.9)
    b.arrow([(449, 124), (449, 112)], color=PLUM, lw=0.9)
    b.arrow([(415, 100), (394, 100)], color=GOLD, lw=0.9)
    b.arrow([(298, 100), (286, 100)], color=GOLD, lw=0.9)
    b.arrow([(238, 88), (238, 76)], color=GOLD, lw=0.9)
    b.arrow([(286, 64), (298, 64)], color=TEAL, lw=0.9)
    b.arrow([(449, 88), (449, 76)], color=PLUM, lw=0.9)

    # ---- result and return ----------------------------------------------
    b.card(8, 14, 470, 38, "Tool result → harness continuation",
           ("host text · optional error flag",), ec=NAVY, fc=F_NAVY, tsize=9.2,
           bsize=9.0, pad=2.0)
    b.arrow([(92, 50), (92, 38)], color=TEAL, lw=0.9)
    b.arrow([(340, 50), (340, 38)], color=GOLD, lw=0.9)
    b.arrow([(470, 26), (505, 26), (505, 244), (498, 244)], color=NAVY,
            lw=0.9)

    b.text(8, 7, "Software-boundary checks; approval does not reserve equipment state.",
           size=9.0, color=GRAY, ha="left", check=(8, 2, 340, 12), tag="note")
    b.arrow([(348, 7), (364, 7)], color=PLUM, lw=0.9, ms=5.5)
    b.text(368, 7, "approval / refusal", size=9.0, color=GRAY, ha="left",
           check=(366, 2, 460, 12), tag="legend")

    return b.save("fig2-A-flow")


# =====================================================================
# Fig. 2 -- B: linear pipeline with a human approval loop
# =====================================================================
def fig2_b():
    b = Board(3.62)

    b.card(8, 228, 112, 252, "Task / chat entry", (), ec=NAVY, fc=F_NAVY,
           tsize=8.6)
    b.plain(118, 228, 238, 252, ("Resolve context,", "retrieve memory"),
            ec=NAVY, fc="white")
    b.plain(244, 228, 330, 252, ("Assemble prompt",), ec=NAVY, fc="white")
    b.card(336, 228, 498, 252, "Harness turn",
           ("registered adapter · scoped catalog",), ec=NAVY, fc=F_NAVY,
           tsize=8.6)
    for x in (112, 238, 330):
        b.arrow([(x, 240), (x + 6, 240)], color=NAVY)

    b.card(8, 186, 300, 218, "Dispatch checks",
           ("scope · channel policy · grant · binding · ownership",
            "S ∧ P ∧ G ∧ B on every returned call"), ec=GOLD, fc=F_GOLD,
           pad=2.6)
    b.arrow([(430, 228), (430, 222), (200, 222), (200, 218)], color=NAVY)
    b.diamond(330, 203, 28, 13, "allowed?", ec=GOLD, fc="white", size=8.0)
    b.arrow([(300, 203), (302, 203)], color=GOLD)
    b.plain(364, 190, 498, 216, ("no: tool error to the harness",), ec=GOLD,
            fc="white", size=8.2)
    b.arrow([(358, 203), (364, 203)], color=GOLD)
    b.arrow([(430, 216), (430, 228)], color=GOLD)

    b.card(8, 156, 498, 180, "Select handler for the named operation", (),
           ec=GOLD, fc="white", tsize=8.8)
    b.arrow([(330, 190), (330, 180)], color=GOLD)

    # read route
    b.rect(8, 84, 150, 144, fc="white", ec=RULE, lw=0.6, z=2)
    b.text(14, 138, "Read route", size=8.6, weight="bold", color=TEAL,
           ha="left")
    b.plain(14, 110, 144, 130, ("Read handler",), ec=TEAL, fc=F_TEAL)
    b.plain(14, 86, 144, 106, ("services + records",), ec=TEAL, fc="white")
    b.arrow([(70, 156), (70, 144)], color=TEAL)

    # write chain
    b.rect(156, 84, 498, 144, fc="#FDFBF6", ec=RULE, lw=0.6, z=2)
    b.text(162, 137, "Write route", size=8.6, weight="bold", color=GOLD,
           ha="left")
    chain = ["Route guards", "Approval if required", "Recheck tuple",
             "DCW admission", "Write, grade"]
    x = 162.0
    boxes = []
    for step in chain:
        box = b.plain(x, 108, x + 62, 132, (step,), ec=GOLD, fc="white",
                      size=8.0, pad=2.2)
        boxes.append(box)
        x += 67
    b.plain(229, 58, 300, 80, ("Human decision", "approve / decline"),
            ec=PLUM, fc=F_PLUM, size=8.0, pad=2.4)

    b.arrow([(225, 156), (225, 144)], color=GOLD)
    for index in range(4):
        b.arrow([(boxes[index][2], 120), (boxes[index + 1][0], 120)], color=GOLD)
    b.arrow([(259, 108), (259, 80)], color=PLUM)             # card -> human
    b.arrow([(300, 69), (307, 69), (307, 108)], color=PLUM)   # human -> recheck
    b.text(263, 92, "if required", size=8.0, color=PLUM, ha="left",
           check=(261, 87, 300, 97), tag="if required")
    b.text(311, 88, "approved", size=8.0, color=PLUM, ha="left",
           check=(309, 83, 350, 93), tag="approved")
    b.plain(158, 54, 224, 80, ("decline → refuse", "no driver write"), ec=PLUM,
            fc=F_PLUM, size=8.0, pad=1.8)
    b.arrow([(229, 69), (224, 69)], color=PLUM)

    # result and return
    b.card(8, 24, 470, 46, "Tool result → harness continuation",
           ("host text · optional error flag",), ec=NAVY, fc=F_NAVY, tsize=8.6)
    b.arrow([(70, 84), (70, 46)], color=TEAL)
    b.arrow([(450, 84), (450, 46)], color=GOLD)
    b.arrow([(470, 35), (505, 35), (505, 240), (498, 240)], color=NAVY)

    b.text(8, 11, "Refusal and decline paths record the reason; no driver write occurs.",
           size=8.0, color=GRAY, ha="left", check=(8, 6, 420, 16), tag="note")
    b.arrow([(430, 11), (446, 11)], color=PLUM, lw=0.8, ms=5.5)
    b.text(450, 11, "approval", size=8.0, color=GRAY, ha="left")

    return b.save("fig2-B-pipeline")


# =====================================================================
# Fig. 2 -- C: gate ladder with per-gate refusal reasons
# =====================================================================
def fig2_c():
    b = Board(3.86)
    L, R = 40.0, 250.0
    RX0, RX1 = 296.0, 488.0

    b.card(L, 254, R, 276, "Tool call from the harness",
           ("named operation · returned by the adapter",), ec=NAVY, fc=F_NAVY,
           tsize=8.6, pad=2.4)
    b.card(L, 226, R, 248, "Scope, policy, grant, binding",
           ("S ∧ P ∧ G ∧ B, rechecked before handler",), ec=GOLD, fc=F_GOLD,
           tsize=8.4, pad=2.4)
    b.arrow([(145, 254), (145, 248)], color=GOLD)

    b.card(RX0, 226, RX1, 250, "Read / analysis route",
           ("DAQ · MES · retrieval · KB, then summary",), ec=TEAL, fc=F_TEAL,
           tsize=8.2, pad=2.4)
    b.arrow([(250, 238), (RX0, 238)], color=TEAL)
    b.text(256, 242, "read", size=8.0, color=TEAL, ha="left",
           check=(252, 237, 282, 247), tag="read label")

    gates = [
        (204, "approval?", "no approval, or card expired"),
        (174, "tuple same?", "context changed after approval"),
        (144, "admit?", "empty H ∩ B ∩ P ∩ R"),
    ]
    for cy, label, reason in gates:
        b.diamond(145, cy, 46, 12, label, ec=GOLD, fc="white", size=8.0)
        b.arrow([(145, cy + 14), (145, cy + 12)], color=GOLD)
        b.plain(RX0, cy - 13, RX1, cy + 13, (reason,), ec=PLUM, fc=F_PLUM,
                size=8.2, pad=2.4, align="left")
        b.arrow([(196, cy), (RX0, cy)], color=PLUM, lw=0.8)
        b.text(203, cy + 4, "no", size=8.0, color=PLUM, ha="left",
               check=(199, cy - 1, 230, cy + 9), tag="no label")
    b.arrow([(145, 226), (145, 216)], color=GOLD)

    b.card(L, 104, R, 130, "Driver write and readback",
           ("bounded batch · step and interval checks",), ec=TEAL, fc=F_TEAL,
           tsize=8.4, pad=2.4)
    b.arrow([(145, 132), (145, 130)], color=TEAL)

    b.plain(L, 72, 140, 96, ("Receipt", "verified · ack · unverified"),
            ec=TEAL, fc="white", size=8.2, pad=2.4)
    b.plain(150, 72, R, 96, ("Observation", "later, DAQ record"), ec=TEAL,
            fc="white", size=8.2, pad=2.4)
    b.arrow([(95, 104), (95, 96)], color=TEAL)
    b.arrow([(200, 104), (200, 96)], color=TEAL)

    b.card(40, 38, 470, 60, "Result returned to the harness; the task continues",
           (), ec=NAVY, fc=F_NAVY, tsize=8.4)
    b.arrow([(95, 72), (95, 60)], color=TEAL)
    b.arrow([(200, 72), (200, 60)], color=TEAL)
    b.arrow([(40, 49), (20, 49), (20, 265), (40, 265)], color=NAVY)

    b.text(RX0, 268, "recorded refusal, no dispatch", size=8.4, weight="bold",
           color=PLUM, ha="left", check=(RX0, 262, RX1, 272), tag="refusal hdr")

    b.text(8, 14, "Read operations leave after the scope check; direct REST and stdio-MCP calls use the same gate sequence.",
           size=8.0, color=GRAY, ha="left", check=(8, 9, 470, 19), tag="note")

    return b.save("fig2-C-gates")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", default=["fig1-a"])
    args = ap.parse_args()
    registry = {"fig1-a": fig1_a, "fig1-b": fig1_b, "fig1-c": fig1_c,
                "fig2-a": fig2_a, "fig2-b": fig2_b, "fig2-c": fig2_c}
    for key in args.only:
        pdf, problems = registry[key]()
        print(f"{key}: {pdf}")
        if problems:
            print(json.dumps(problems, indent=2))
            sys.exit(1)

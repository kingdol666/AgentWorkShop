"""Regenerate fig4-governed-flow.pdf (governed write route map).

Geometry is laid out in top-down points on a 252 x 320 pt canvas (IEEE
column width). Every text block is sized so it stays inside its shape
with >= 2.5 pt clearance; the decision diamond is wide enough for its
label at the label's own height, and the right-hand rejection corridor
keeps >= 3.5 pt between labels, box edges, and the corridor line.

Run:  python make_fig4.py [output.pdf]
"""
import os
import sys

from reportlab.lib.colors import Color
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

import matplotlib

W, H = 252.0, 320.0

INK = Color(0.231, 0.298, 0.357)
ACCENT = Color(0.204, 0.365, 0.471)
BLUE_FILL = Color(0.914, 0.945, 0.965)
GUARD_FILL = Color(0.945, 0.961, 0.973)
RED = Color(0.533, 0.239, 0.192)
STOP_FILL = Color(0.980, 0.937, 0.925)
REC_FILL = Color(0.973, 0.980, 0.984)
TEXT = Color(0.180, 0.239, 0.298)
SUB = Color(0.353, 0.420, 0.486)
WHITE = Color(1, 1, 1)

FONT_DIR = os.path.join(matplotlib.get_data_path(), "fonts", "ttf")
pdfmetrics.registerFont(TTFont("DejaVuSans", os.path.join(FONT_DIR, "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont("DejaVuSans-Bold", os.path.join(FONT_DIR, "DejaVuSans-Bold.ttf")))


class Fig:
    def __init__(self, path):
        self.c = canvas.Canvas(path, pagesize=(W, H))
        self.c.setTitle("Governed write route map")
        self.c.setCreator("make_fig4.py")

    def y(self, top):
        return H - top

    def text(self, s, x, baseline, size=7.8, font="DejaVuSans", color=SUB, align="center"):
        c = self.c
        c.setFont(font, size)
        c.setFillColor(color)
        if align == "center":
            c.drawCentredString(x, self.y(baseline), s)
        else:
            c.drawString(x, self.y(baseline), s)

    def box(self, x0, y0, x1, y1, fill=WHITE, stroke=INK, r=4.0, dash=None, lw=0.85):
        c = self.c
        c.setLineWidth(lw)
        c.setStrokeColor(stroke)
        c.setFillColor(fill)
        c.setDash(dash or [])
        c.roundRect(x0, self.y(y1), x1 - x0, y1 - y0, r, stroke=1, fill=1)
        c.setDash([])

    def diamond(self, cx, cy, hw, hh, fill=BLUE_FILL, stroke=ACCENT):
        c = self.c
        p = c.beginPath()
        p.moveTo(cx, self.y(cy - hh))
        p.lineTo(cx + hw, self.y(cy))
        p.lineTo(cx, self.y(cy + hh))
        p.lineTo(cx - hw, self.y(cy))
        p.close()
        c.setLineWidth(0.9)
        c.setStrokeColor(stroke)
        c.setFillColor(fill)
        c.drawPath(p, stroke=1, fill=1)

    def line(self, x0, y0, x1, y1, color=INK, lw=0.9):
        c = self.c
        c.setLineWidth(lw)
        c.setStrokeColor(color)
        c.line(x0, self.y(y0), x1, self.y(y1))

    def dot(self, x, y, color=INK, r=1.4):
        c = self.c
        c.setFillColor(color)
        c.circle(x, self.y(y), r, stroke=0, fill=1)

    def arrow_down(self, x, y0, y1, color=INK):
        self.line(x, y0, x, y1 - 4.8, color)
        c = self.c
        p = c.beginPath()
        p.moveTo(x - 2.3, self.y(y1 - 5.4))
        p.lineTo(x + 2.3, self.y(y1 - 5.4))
        p.lineTo(x, self.y(y1))
        p.close()
        c.setFillColor(color)
        c.drawPath(p, stroke=0, fill=1)

    def arrow_right(self, x0, x1, y, color=INK):
        self.line(x0, y, x1 - 4.8, y, color)
        c = self.c
        p = c.beginPath()
        p.moveTo(x1 - 5.4, self.y(y - 2.3))
        p.lineTo(x1 - 5.4, self.y(y + 2.3))
        p.lineTo(x1, self.y(y))
        p.close()
        c.setFillColor(color)
        c.drawPath(p, stroke=0, fill=1)

    def save(self):
        self.c.showPage()
        self.c.save()


def build(path):
    f = Fig(path)
    f.c.setFillColor(WHITE)
    f.c.rect(0, 0, W, H, stroke=0, fill=1)

    # Entry routes
    f.box(10, 2, 114, 28)
    f.text("Single-node explore", 62, 12.5, 8.6, color=TEXT)
    f.text("(agent or manual)", 62, 22, 7.8)
    f.box(138, 2, 242, 28)
    f.text("Recipe trial / apply", 190, 12.5, 8.6, color=TEXT)
    f.text("(per parameter)", 190, 22, 7.8)

    # Merge into the approval decision
    f.line(62, 28, 62, 36)
    f.line(190, 28, 190, 36)
    f.line(62, 36, 190, 36)
    f.dot(116, 36)
    f.arrow_down(116, 36, 44)

    # Decision diamond: half-width 66 at centre, label clears the slanted
    # edges by ~6 pt at its own top and bottom.
    f.diamond(116, 62, 66, 18)
    f.text("Need approval?", 116, 65.3, 9.2, "DejaVuSans-Bold", TEXT)

    # No corridor: bypasses approval but still enters the shared guard.
    f.line(50, 62, 20, 62)
    f.line(20, 62, 20, 221)
    f.arrow_right(20, 49, 221)
    f.text("No", 25, 58.5, 8.9, color=TEXT, align="left")

    # Yes branch
    f.arrow_down(116, 80, 92)
    f.text("Yes", 121, 88.2, 8.9, color=TEXT, align="left")

    # Approval
    f.box(49, 92, 183, 128)
    f.text("Approval", 116, 103.5, 9.2, color=TEXT)
    f.text("single-node: (n, x) decision", 116, 114, 7.8)
    f.text("recipe: operation + context", 116, 123.5, 7.8)
    f.line(183, 120, 231, 120, RED)
    f.text("Declined /", 207, 106.5, 8.2, color=RED)
    f.text("timeout", 207, 115.5, 8.2, color=RED)

    f.arrow_down(116, 128, 146)
    f.text("Approved", 66, 139.5, 8.9, color=TEXT, align="left")

    # Route-specific revalidation: four text lines with real padding.
    f.box(49, 146, 183, 196)
    f.text("Route-specific revalidation", 116, 158, 8.8, color=TEXT)
    f.text("single-node: node binding", 116, 169.5, 7.8)
    f.text("recipe: definition,", 116, 179, 7.8)
    f.text("context, and scope", 116, 188.5, 7.8)
    f.line(183, 182, 231, 182, RED)
    f.dot(231, 182, RED)
    f.text("Invalid", 207, 177, 8.2, color=RED)

    f.arrow_down(116, 196, 206)

    # Shared write guard
    f.box(49, 206, 183, 236, fill=GUARD_FILL, stroke=ACCENT)
    f.text("Shared write guard", 116, 218.5, 9.2, "DejaVuSans-Bold", TEXT)
    f.text("per Algorithm 1 and Eq. (3)", 116, 229.5, 7.8)
    f.line(183, 228, 231, 228, RED)
    f.dot(231, 228, RED)
    f.text("Rejected", 207, 223.5, 8.2, color=RED)

    f.arrow_down(116, 236, 246)

    # Driver I/O and Stop
    f.box(64, 246, 168, 266, fill=BLUE_FILL, stroke=ACCENT, r=10)
    f.text("Driver I/O", 116, 259.5, 9.2, "DejaVuSans-Bold", TEXT)
    f.line(231, 120, 231, 240.6, RED)
    f.arrow_down(231, 240.6, 246, RED)
    f.box(212, 246, 250, 266, fill=STOP_FILL, stroke=RED, r=10)
    f.text("Stop", 231, 259.5, 9.2, "DejaVuSans-Bold", RED)

    f.arrow_down(116, 266, 278)

    # Distinct records after dispatch
    f.box(18, 278, 214, 318, fill=REC_FILL, dash=[2.2, 1.5])
    f.text("Distinct records after dispatch", 116, 290.5, 8.8, "DejaVuSans-Bold", TEXT)
    f.text("command outcome \u00b7 setpoint readback", 116, 301, 8.2)
    f.text("later DAQ observation", 116, 310.5, 8.2)

    f.save()


if __name__ == "__main__":
    default = os.path.join(
        os.path.dirname(__file__), "..", "TII-SUBMISSION-PACKAGE-FINAL",
        "overleaf-source", "resources", "fig4-governed-flow.pdf")
    out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else default)
    build(out)
    print("wrote", out)
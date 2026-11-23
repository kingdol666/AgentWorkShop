"""Regenerate fig1 (configured cast-film example + process flow).

Base machine row is an ImageGen illustration (v3); code composites crisp
vector text, stage badges, flow arrows, node leaders, and record cards.
The generated gauge station had misaligned sensor heads, so it is masked
with the sampled background colour and rebuilt as a vector C-frame gauge
with opposed heads at the film web.

Run:  python make_fig1.py [source.png] [output.pdf]
"""
import os
import sys

import numpy as np
from PIL import Image
from reportlab.lib.colors import Color
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

import matplotlib

W, H = 252.0, 140.0
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SRC = os.path.join(HERE, "..", "TII-SUBMISSION-PACKAGE-FINAL", "build", "fig1-line-v3.png")
DEFAULT_OUT = os.path.join(HERE, "..", "TII-SUBMISSION-PACKAGE-FINAL", "overleaf-source", "resources", "fig1-vectorized-20261109.pdf")

INK = Color(0.231, 0.298, 0.357)
ACCENT = Color(0.204, 0.365, 0.471)
TEAL = Color(0.176, 0.478, 0.545)
BLUE_FILL = Color(0.914, 0.945, 0.965)
AMBER = Color(0.780, 0.482, 0.188)
AMBER_FILL = Color(0.988, 0.949, 0.902)
TEXT = Color(0.180, 0.239, 0.298)
SUB = Color(0.353, 0.420, 0.486)
WHITE = Color(1, 1, 1)
WEB = Color(0.749, 0.890, 0.933)
FRAME_FILL = Color(0.871, 0.898, 0.918)

FONT_DIR = os.path.join(matplotlib.get_data_path(), "fonts", "ttf")
pdfmetrics.registerFont(TTFont("DejaVuSans", os.path.join(FONT_DIR, "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont("DejaVuSans-Bold", os.path.join(FONT_DIR, "DejaVuSans-Bold.ttf")))

# illustration placement inside the canvas
IX, IY, IW = 10.0, 30.0, 232.0


class Fig:
    def __init__(self, path):
        self.c = canvas.Canvas(path, pagesize=(W, H))
        self.c.setTitle("Configured cast-film example and process flow")
        self.c.setCreator("make_fig1.py")

    def y(self, top):
        return H - top

    def text(self, s, x, baseline, size=7.6, font="DejaVuSans", color=SUB, align="center"):
        self.c.setFont(font, size)
        self.c.setFillColor(color)
        if align == "center":
            self.c.drawCentredString(x, self.y(baseline), s)
        else:
            self.c.drawString(x, self.y(baseline), s)

    def box(self, x0, y0, x1, y1, fill=WHITE, stroke=INK, r=3.5, lw=0.85):
        c = self.c
        c.setLineWidth(lw)
        c.setStrokeColor(stroke)
        c.setFillColor(fill)
        c.roundRect(x0, self.y(y1), x1 - x0, y1 - y0, r, stroke=1, fill=1)

    def line(self, x0, y0, x1, y1, color=INK, lw=0.7):
        c = self.c
        c.setLineWidth(lw)
        c.setStrokeColor(color)
        c.line(x0, self.y(y0), x1, self.y(y1))

    def dot(self, x, y, color=INK, r=1.2):
        self.c.setFillColor(color)
        self.c.circle(x, self.y(y), r, stroke=0, fill=1)

    def rect(self, x0, y0, x1, y1, fill, stroke=None, lw=0.7):
        c = self.c
        c.setFillColor(fill)
        if stroke is None:
            c.rect(x0, self.y(y1), x1 - x0, y1 - y0, stroke=0, fill=1)
        else:
            c.setStrokeColor(stroke)
            c.setLineWidth(lw)
            c.rect(x0, self.y(y1), x1 - x0, y1 - y0, stroke=1, fill=1)

    def badge(self, n, x, y):
        c = self.c
        c.setFillColor(WHITE)
        c.setStrokeColor(ACCENT)
        c.setLineWidth(0.7)
        c.circle(x, self.y(y), 3.4, stroke=1, fill=1)
        c.setFont("DejaVuSans-Bold", 5.6)
        c.setFillColor(ACCENT)
        c.drawCentredString(x, self.y(y + 2.0), str(n))

    def arrow_right(self, x, y, color=TEAL, s=2.0):
        c = self.c
        p = c.beginPath()
        p.moveTo(x - s, self.y(y - s * 0.62))
        p.lineTo(x - s, self.y(y + s * 0.62))
        p.lineTo(x, self.y(y))
        p.close()
        c.setFillColor(color)
        c.drawPath(p, stroke=0, fill=1)

    def save(self):
        self.c.showPage()
        self.c.save()


def prepare(src):
    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(int)
    Hs, Ws, _ = a.shape
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.abs(a - bg).sum(axis=2)
    nw = dist > 60
    nw[int(Hs * 0.86):, int(Ws * 0.78):] = False  # ignore generator watermark
    rows = np.where(nw.sum(axis=1) > 20)[0]
    cols = np.where(nw.sum(axis=0) > 20)[0]
    y0, y1, x0, x1 = rows.min(), rows.max(), cols.min(), cols.max()
    a[dist <= 60] = 255  # whiten tinted background so the band has no panel edge
    a[int(Hs * 0.86):, int(Ws * 0.78):] = 255
    crop = a[y0:y1 + 1, x0:x1 + 1].copy()
    ch, cw, _ = crop.shape
    # mask the mis-drawn gauge posts/heads; web is redrawn vectorially there
    gx0, gx1 = int(0.640 * cw), int(0.805 * cw)
    gy0, gy1 = int(0.24 * ch), int(0.97 * ch)
    crop[gy0:gy1, gx0:gx1] = 255
    web = (crop[..., 0] >= 140) & (crop[..., 2] >= crop[..., 0] + 10) & (crop[..., 1] >= crop[..., 0] + 4) & (crop[..., 0] <= 235)
    wr = np.where(web.sum(axis=1) > cw * 0.25)[0]
    web_y = (wr.min() + wr.max()) / 2 if len(wr) else 0.53 * ch
    out = os.path.join(HERE, "..", "TII-SUBMISSION-PACKAGE-FINAL", "build", "fig1-line-prepared.png")
    Image.fromarray(crop.astype(np.uint8)).save(out)
    return out, cw, ch, web_y / ch, (gx0 / cw, gx1 / cw, gy0 / ch, gy1 / ch)


def build(src, path):
    prep, cw, ch, webf, gpatch = prepare(src)
    ih = IW * ch / cw
    sc = IW / cw
    f = Fig(path)
    f.c.setFillColor(WHITE)
    f.c.rect(0, 0, W, H, stroke=0, fill=1)

    # node cards
    f.box(8, 2, 122, 26)
    f.text("Control node", 65, 11.5, 8.4, "DejaVuSans-Bold", TEXT)
    f.text("linespeed-sp / MQTT", 65, 21, 7.6)
    f.box(130, 2, 244, 26, stroke=TEAL)
    f.text("Measurement node", 187, 11.5, 8.4, "DejaVuSans-Bold", TEAL)
    f.text("film-thickness / MQTT", 187, 21, 7.6)

    # machine row
    f.c.drawImage(ImageReader(prep), IX, f.y(IY + ih), IW, ih, mask="auto")

    wy = IY + webf * ih
    # redraw the web across the masked gauge patch
    px0, px1 = IX + gpatch[0] * IW, IX + gpatch[1] * IW
    f.rect(px0, wy - 1.15, px1, wy + 1.15, WEB)

    # vector C-frame thickness gauge with opposed heads at the web
    gx = IX + 0.720 * IW
    f.rect(gx + 4.5, wy - 13, gx + 7.0, wy + 13, FRAME_FILL, INK)          # back post
    f.rect(gx - 5.0, wy - 13, gx + 4.5, wy - 10.8, FRAME_FILL, INK)       # top arm
    f.rect(gx - 5.0, wy + 10.8, gx + 4.5, wy + 13, FRAME_FILL, INK)       # bottom arm
    f.rect(gx - 2.6, wy - 10.8, gx - 0.6, wy - 4.6, FRAME_FILL, INK)      # top stem
    f.rect(gx - 2.6, wy + 4.6, gx - 0.6, wy + 10.8, FRAME_FILL, INK)      # bottom stem
    f.rect(gx - 4.2, wy - 4.6, gx + 1.0, wy - 1.6, AMBER, INK, 0.6)       # top head
    f.rect(gx - 4.2, wy + 1.6, gx + 1.0, wy + 4.6, AMBER, INK, 0.6)       # bottom head

    # flow direction on the web
    for fr in (0.415, 0.615, 0.815):
        f.arrow_right(IX + fr * IW, wy)

    # stage badges
    badges = [(1, 0.105, 0.30), (2, 0.385, 0.27), (3, 0.465, 0.30),
              (4, 0.545, 0.33), (5, 0.720, 0.245), (6, 0.900, 0.26)]
    for n, fx, fy in badges:
        f.badge(n, IX + fx * IW, IY + fy * ih)

    # leaders: control -> draw rolls, measurement -> gauge
    f.line(65, 26, 65, 28.5, INK)
    f.line(65, 28.5, IX + 0.545 * IW, 28.5, INK)
    f.line(IX + 0.545 * IW, 28.5, IX + 0.545 * IW, IY + 0.36 * ih, INK)
    f.dot(IX + 0.545 * IW, IY + 0.36 * ih, INK)
    f.line(187, 26, 187, 28.5, TEAL)
    f.line(187, 28.5, gx - 1.6, 28.5, TEAL)
    f.line(gx - 1.6, 28.5, gx - 1.6, wy - 13, TEAL)
    f.dot(gx - 1.6, wy - 13, TEAL)

    # stage legend
    f.text("1 Extrusion   2 Cast die   3 Chill-roll casting", 126, IY + ih + 8, 6.6, color=TEXT)
    f.text("4 Line-speed draw   5 Thickness gauge   6 Winding", 126, IY + ih + 17, 6.6, color=TEXT)

    # record cards
    ry0, ry1 = 106, 136
    f.box(8, ry0, 82, ry1)
    f.text("Command", 45, 117, 8.2, "DejaVuSans-Bold", TEXT)
    f.text("receipt", 45, 127, 7.4)
    f.box(88, ry0, 164, ry1, fill=AMBER_FILL, stroke=AMBER)
    f.text("Optional", 126, 117, 8.2, "DejaVuSans-Bold", AMBER)
    f.text("setpoint readback", 126, 127, 7.4)
    f.box(170, ry0, 244, ry1, stroke=TEAL)
    f.text("Later DAQ", 207, 117, 8.2, "DejaVuSans-Bold", TEAL)
    f.text("observation", 207, 127, 7.4)
    f.save()


if __name__ == "__main__":
    src = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.abspath(DEFAULT_SRC)
    out = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.abspath(DEFAULT_OUT)
    build(src, out)
    print("wrote", out)
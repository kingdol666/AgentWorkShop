"""Shared drawing primitives for the benchmark figure set.

Every plate is authored as inline SVG at a fixed point size and printed through headless
Chrome, so the point values in the source are the values on the page.  The conventions are
the ones an IEEE TII figure is reviewed against:

  * white ground, hairline strokes, no gradients, no shadows, no 3-D, no palette
  * one serif family; emphasis carried by weight and by a single spot tone, so every plate
    survives a monochrome reprint
  * a two-weight type scale (7.5 pt notes, 8.4 pt body, 12 pt titles) rather than a
    continuum, so the hierarchy reads at a glance
  * numeric labels are placed clear of marks by construction, and `shapes.py` reports any
    label that would collide, leave the canvas, or be struck by a rule

Print geometry: IEEEtran letter text width is 531 pt.  Plates are built at `W_PT` and the
caller scales them into LaTeX, so each builder also reports the effective font size on the
page.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# --------------------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------------------
ROOT = Path(__file__).resolve()
while ROOT.name != "AgentWorkShop":
    if ROOT.parent == ROOT:
        raise SystemExit("run from inside the AgentWorkShop checkout")
    ROOT = ROOT.parent
RESULTS = ROOT / "bench" / "results"
OUT = Path(__file__).resolve().parent

# --------------------------------------------------------------------------------------
# palette: one spot tone plus a warm counter-tone, both dark enough for greyscale
# --------------------------------------------------------------------------------------
INK = "#101010"        # data marks and rules that must read as black
GREY = "#5d5d5d"       # secondary text
FAINT = "#9a9a9a"      # tertiary text, gridlines
RULE = "#c2c2c2"       # separators
TONE = "#1F6F78"       # primary accent (accepted / governed path)
WARM = "#A8541F"       # counter accent (executed / breach)
COOL = "#3D6FB5"       # tertiary series
WASH_T = "#e9f1f2"     # tone tint for fills
WASH_W = "#f7ece1"     # warm tint for fills
PAPER = "#ffffff"

FONT = "Times New Roman, Times, Nimbus Roman, Liberation Serif, serif"

# type scale, in points
T_TITLE = 12.0
T_SUB = 8.4
T_HEAD = 9.4
T_BODY = 8.4
T_KEY = 7.8
T_NOTE = 7.5

# leading, in points: 1.08 em of the body size clears consecutive ink boxes
L_BODY = 8.6
L_TIGHT = 7.8


# --------------------------------------------------------------------------------------
# archive access
# --------------------------------------------------------------------------------------
def load(archive: str, name: str = "run.json"):
    return json.loads((RESULTS / archive / name).read_text(encoding="utf-8-sig"))


def ablation_rows() -> list[dict]:
    import csv
    path = RESULTS / "20260920094442-e1lite" / "e1-lite.csv"
    return list(csv.DictReader(path.read_text(encoding="utf-8-sig").splitlines()))


ARMS = [("Full", "full"), ("No interlock", "no-interlock"),
        ("No readback", "no-readback"), ("Both disabled", "ungated")]

ATTACK_KINDS = [
    ("below-global", "below\nhard range"),
    ("above-global", "above\nhard range"),
    ("below-window", "below\nrecipe window"),
    ("above-window", "above\nrecipe window"),
    ("extreme", "extreme\nvalue"),
    ("negative", "negative\nvalue"),
]


# --------------------------------------------------------------------------------------
# canvas
# --------------------------------------------------------------------------------------
class Canvas:
    """An SVG canvas whose user unit is `U` per point."""

    def __init__(self, w_pt: float, h_pt: float, u: float = 2.0):
        self.U = u
        self.w_pt, self.h_pt = w_pt, h_pt
        self.w, self.h = w_pt * u, h_pt * u
        self._parts: list[str] = []

    # -- coordinate helpers ------------------------------------------------------------
    def u(self, v: float) -> float:
        return v * self.U

    # -- primitives --------------------------------------------------------------------
    def text(self, x, y, body, *, size=T_KEY, anchor="start", weight="normal", fill=INK,
             style="normal") -> None:
        self._parts.append(
            f'<text x="{x:.1f}" y="{y:.1f}" font-size="{self.u(size):.1f}" '
            f'text-anchor="{anchor}" font-weight="{weight}" font-style="{style}" '
            f'fill="{fill}">{_esc(body)}</text>')

    def rect(self, x, y, w, h, *, fill=PAPER, stroke=INK, sw=1.0, rx=0.0) -> None:
        r = f' rx="{self.u(rx):.1f}"' if rx else ""
        self._parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="{sw:.2f}"{r}/>')

    def line(self, x1, y1, x2, y2, *, stroke=RULE, sw=0.9, dash=None) -> None:
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self._parts.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{stroke}" stroke-width="{sw:.2f}"{d}/>')

    def circle(self, cx, cy, r, *, fill=PAPER, stroke=INK, sw=0.9) -> None:
        self._parts.append(
            f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="{sw:.2f}"/>')

    def path(self, d, *, fill="none", stroke=INK, sw=0.9, cap="butt", dash=None) -> None:
        da = f' stroke-dasharray="{dash}"' if dash else ""
        self._parts.append(
            f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{sw:.2f}" '
            f'stroke-linecap="{cap}"{da}/>')

    def arrow(self, x, y, *, size=4.6, direction="right", fill=TONE) -> None:
        s = self.u(size)
        if direction == "right":
            d = f"M {x:.1f} {y - s / 2:.1f} L {x + s:.1f} {y:.1f} L {x:.1f} {y + s / 2:.1f} Z"
        else:
            d = f"M {x:.1f} {y - s / 2:.1f} L {x - s:.1f} {y:.1f} L {x:.1f} {y + s / 2:.1f} Z"
        self._parts.append(f'<path d="{d}" fill="{fill}"/>')

    def tick(self, x, y, *, length=3.0, stroke=INK, sw=0.9) -> None:
        self.line(x, y, x, y + self.u(length), stroke=stroke, sw=sw)

    # -- output ------------------------------------------------------------------------
    def svg(self) -> str:
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w:.0f} '
            f'{self.h:.0f}" width="{self.w:.0f}" height="{self.h:.0f}" '
            f'font-family="{FONT}">\n'
            f'<rect x="0" y="0" width="{self.w:.0f}" height="{self.h:.0f}" '
            f'fill="{PAPER}"/>\n' + "\n".join(self._parts) + "\n</svg>\n")


def _esc(t: str) -> str:
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# --------------------------------------------------------------------------------------
# print
# --------------------------------------------------------------------------------------
BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]


def build(name: str, canvas: Canvas, *, scale_in_latex: float, title: str,
          note: str = "") -> dict:
    """Write HTML + SVG, print to PDF, rasterise a proof, and report render facts."""
    svg = canvas.svg()
    html = (
        f'<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        f'<title>{_esc(title)}</title>\n<style>\n'
        f'  @page {{ size: {canvas.w_pt / 72:.4f}in {canvas.h_pt / 72:.4f}in; margin: 0; }}\n'
        f'  html, body {{ margin: 0; padding: 0; background: {PAPER}; }}\n'
        f'  svg {{ display: block; }}\n</style>\n</head>\n<body>\n{svg}</body>\n</html>\n')

    (OUT / f"{name}.svg").write_text(svg, encoding="utf-8")
    (OUT / f"{name}.html").write_text(html, encoding="utf-8")

    browser = next((b for b in BROWSERS if Path(b).is_file()), None)
    if browser is None:
        raise SystemExit("no headless Chromium available for print-to-PDF")

    pdf = OUT / f"{name}.pdf"
    profile = OUT / f"_profile-{name}"
    subprocess.run([
        browser, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
        "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
        "--force-device-scale-factor=1", f"--user-data-dir={profile}",
        "--no-pdf-header-footer", f"--print-to-pdf={pdf}",
        (OUT / f"{name}.html").as_uri(),
    ], capture_output=True, text=True, timeout=180)
    shutil.rmtree(profile, ignore_errors=True)
    if not pdf.is_file():
        raise SystemExit(f"{name}: print-to-pdf produced nothing")

    import fitz

    doc = fitz.open(pdf)
    page = doc[0]
    page.set_mediabox(fitz.Rect(0, 0, canvas.w_pt, canvas.h_pt))
    page.get_pixmap(dpi=300).save(OUT / f"{name}.png")
    spans = [s for b in page.get_text("dict")["blocks"] if "lines" in b
             for ln in b["lines"] for s in ln["spans"]]
    outside = [s["text"] for s in spans if not page.rect.contains(fitz.Rect(s["bbox"]))]
    fonts = sorted({f[3] for f in page.get_fonts(full=True)})
    sizes = sorted({round(s["size"], 2) for s in spans})
    tmp = OUT / f"_{name}.tmp.pdf"
    doc.save(tmp, garbage=4, deflate=True)
    doc.close()
    shutil.move(str(tmp), str(pdf))

    facts = {
        "name": name,
        "title": title,
        "note": note,
        "pdf_points": [canvas.w_pt, canvas.h_pt],
        "pdf_inches": [round(canvas.w_pt / 72, 3), round(canvas.h_pt / 72, 3)],
        "latex_width_fraction": scale_in_latex,
        "print_scale": round(scale_in_latex * 531.0 / canvas.w_pt, 4),
        "font_sizes_designed": sizes,
        "font_sizes_effective": [round(s * scale_in_latex * 531.0 / canvas.w_pt, 2)
                                 for s in sizes],
        "text_spans": len(spans),
        "spans_outside_canvas": outside,
        "fonts": fonts,
    }
    (OUT / f"{name}.facts.json").write_text(
        json.dumps(facts, indent=2) + "\n", encoding="utf-8")

    print(f"built {name}: {canvas.w_pt:.0f}x{canvas.h_pt:.0f} pt, "
          f"{len(spans)} spans, min effective "
          f"{min(facts['font_sizes_effective']):.2f} pt")
    if outside:
        raise SystemExit(f"{name}: text outside canvas: {outside[:4]}")
    return facts


# --------------------------------------------------------------------------------------
# design QA
# --------------------------------------------------------------------------------------
def qa(name: str, *, min_ink=0.010, max_ink=0.30, tol_x=0.6, tol_y=3.6) -> tuple[list[str], list[str]]:
    """Structural and design checks on a printed plate.

    Beyond containment and collisions this reports the ink fraction, the content bounding
    box against the canvas (balance), and the distinct font sizes, so an ugly or unbalanced
    plate is visible without a human looking at it.
    """
    import fitz

    pdf = OUT / f"{name}.pdf"
    doc = fitz.open(pdf)
    page = doc[0]
    canvas = page.rect
    ok: list[str] = []
    bad: list[str] = []

    def check(cond, msg):
        (ok if cond else bad).append(msg)

    spans = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                if span["text"].strip():
                    spans.append((fitz.Rect(span["bbox"]), span["text"],
                                  round(span["size"], 2)))

    outside = [s[1] for s in spans if not canvas.contains(s[0])]
    check(not outside, f"no text outside canvas ({len(outside)})")

    collisions = []
    for i in range(len(spans)):
        ri, ti, _ = spans[i]
        for j in range(i + 1, len(spans)):
            rj, tj, _ = spans[j]
            ox = min(ri.x1, rj.x1) - max(ri.x0, rj.x0)
            oy = min(ri.y1, rj.y1) - max(ri.y0, rj.y0)
            if ox > tol_x and oy > tol_y:
                collisions.append((ti[:28], tj[:28]))
    check(not collisions, f"no colliding labels ({len(collisions)})")

    rules = []
    for d in page.get_drawings():
        r = fitz.Rect(d["rect"])
        if r.height <= 1.6 and 16 < r.width < canvas.width * 0.92:
            rules.append(("h", r))
        elif r.width <= 1.6 and 16 < r.height < canvas.height * 0.92:
            rules.append(("v", r))
    strikes = []
    for rect, body, size in spans:
        pad = max(1.8, 0.22 * size)
        for kind, rr in rules:
            if kind == "h" and rect.y0 + pad < rr.y1 and rect.y1 - pad > rr.y0:
                if min(rect.x1, rr.x1) - max(rect.x0, rr.x0) > 2.0:
                    strikes.append(body[:28])
            if kind == "v" and rect.x0 + pad < rr.x1 and rect.x1 - pad > rr.x0:
                if min(rect.y1, rr.y1) - max(rect.y0, rr.y0) > 2.0:
                    strikes.append(body[:28])
    check(not strikes, f"no rule strikes a label ({len(strikes)})")

    # ink fraction: guards a plate that is either nearly empty or unreadably dense
    pix = page.get_pixmap(dpi=100, colorspace=fitz.csGRAY)
    dark = sum(1 for i in range(0, len(pix.samples), pix.n) if pix.samples[i] < 200)
    ink = dark / (pix.width * pix.height)
    check(min_ink <= ink <= max_ink,
          f"ink fraction {ink:.4f} within [{min_ink}, {max_ink}]")

    # balance: text should sit inside the canvas with sane, roughly even margins.  The
    # full-bleed background rect is excluded; headless printing introduces sub-pixel drift,
    # so stroke clipping is allowed a hair of tolerance.
    if spans:
        box = spans[0][0]
        for r, _, _ in spans[1:]:
            box |= r
        left, right = box.x0, canvas.width - box.x1
        topm, botm = box.y0, canvas.height - box.y1
        check(min(left, right, topm, botm) >= 2.0,
              f"text margins >= 2 pt (l{left:.1f} r{right:.1f} t{topm:.1f} b{botm:.1f})")
        check(abs(left - right) <= 8.0,
              f"text margins balanced (l{left:.1f} r{right:.1f})")
    over = []
    for d in page.get_drawings():
        r = fitz.Rect(d["rect"])
        if r.width >= canvas.width - 0.5 and r.height >= canvas.height - 0.5:
            continue                      # the background plate
        if (r.x0 < -0.6 or r.y0 < -0.6 or r.x1 > canvas.width + 0.6
                or r.y1 > canvas.height + 0.6):
            over.append(tuple(round(v, 1) for v in r))
    check(not over, f"no stroke clipped by the canvas ({len(over)})")

    check(len({s[2] for s in spans}) <= 6,
          f"type scale has <= 6 sizes ({sorted({s[2] for s in spans})})")

    doc.close()
    return ok, bad


def report(name: str, *, ok: list[str], bad: list[str]) -> int:
    print(f"  {name}: PASS {len(ok)}  FAIL {len(bad)}")
    for m in bad:
        print("     FAIL", m)
    return 1 if bad else 0

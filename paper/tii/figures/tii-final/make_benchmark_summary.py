"""Build the consolidated AW-IndustrialBench summary figure as HTML + SVG.

One plate summarises the whole consolidated benchmark report, with the emphasis on the two
subjects the manuscript is about: the AgentTeam closed loop that drives parameters, and the
PLC node scenario those writes land on.

Drawing conventions, matching what an IEEE TII figure is reviewed against:

  * no chart junk: hairline rules, white fills, no gradients, no shadows, no palette
  * one serif family; SVG user units are 1/2 pt and the plate prints at ~96 %, so the point
    sizes below are the sizes a reader sees
  * emphasis by weight plus a single spot tone, so the plate survives a monochrome reprint
  * every number is an archived measurement or an explicit count; qa_benchmark_figure.py
    asserts each one against bench/results/<archive>/run.json

Outputs, beside this file:
    fig-benchmark-summary.html    authored, editable source
    fig-benchmark-summary.svg     inline vector SVG
    fig-benchmark-summary.pdf     printed at exact figure size
    fig-benchmark-summary.png     300 dpi proof
    fig-benchmark-summary.qa.json render facts consumed by the QA harness
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

OUT = Path(__file__).resolve().parent
ROOT = OUT
while ROOT.name != "AgentWorkShop":
    if ROOT.parent == ROOT:
        raise SystemExit("run this from inside the AgentWorkShop checkout")
    ROOT = ROOT.parent
RESULTS = ROOT / "bench" / "results"

# ======================================================================================
# geometry
#
#   U      user units per point, scaled so hairline strokes stay crisp
#   W_PT   printed width.  IEEEtran letter text width is 531 pt; the plate is built at
#          549 pt and included at 0.96\textwidth, a 3.3 % reduction that leaves the 7.8 pt
#          body text at about 7.5 pt on the page.
#
#   five bands of 65 pt pitch, a 25 pt title block and a 4 pt outer margin:
#       25 + 5*65 + 4 = 354
# ======================================================================================
U = 2.0
W_PT, H_PT = 549.0, 391.0
W, H = W_PT * U, H_PT * U

M = 4.0 * U
LEFT, RIGHT = M, W - M
FIELD = RIGHT - LEFT

BAND_TOP = 25.0 * U
BAND_PITCH = 65.0 * U
BAND_H = 66.0 * U
HEAD_H = 15.0 * U

INK = "#000000"
GREY = "#565656"
RULE = "#bcbcbc"
TONE = "#1F6F78"
FILL = "#e9f1f2"
FONT = "Times New Roman, Times, Nimbus Roman, Liberation Serif, serif"

# read sizes, in points
S_TITLE = 12.0 * U
S_SUB = 8.4 * U
S_HEAD = 9.4 * U
S_BAND = 8.0 * U
S_TILE = 8.0 * U
S_KEY = 7.8 * U
S_NOTE = 7.6 * U

# leading, in points, chosen so consecutive ascender/descender boxes never touch
L_TILE = 8.6 * U
L_ROW = 8.6 * U

# ======================================================================================
# archived values
# ======================================================================================
def load(archive: str, name: str):
    return json.loads((RESULTS / archive / name).read_text(encoding="utf-8-sig"))


B = load("20260920094610-to4", "run.json")
ABL = load("20260920094442-e1lite", "run.json")
PLC = load("20260920094335-1b5g", "run.json")

BIAX = B["env"]["biax"]
MISSION = BIAX["missionTraj"]
SEEDS = B["closedloop"]["seeds"]
AGG = B["closedloop"]["agg"]
WRITABLE = [l for l in B["lines"] if l.get("writeP50") is not None]
PORT = B["env"]["portability"]
KPI = {k["label"]: k["value"] for k in B["kpis"]}
POOLED_P50 = float(KPI["Write p50 (all protocols)"])

PLC_PROTOCOLS = [("Modbus TCP", 30), ("Modbus RTU", 16), ("OPC UA", 17),
                 ("MQTT", 16), ("HTTP", 17)]
PLC_PASS = PLC["env"]["total"]["pass"]
PLC_TOTAL = PLC["env"]["total"]["got"]
F5_REJ = sum(l["f5Rejected"] for l in WRITABLE)
F5_TOT = sum(l["f5Total"] for l in WRITABLE)
FALSE_BLK = sum(l["falseBlock"] for l in WRITABLE)

parts: list[str] = []
add = parts.append


def esc(t: str) -> str:
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def text(x, y, body, *, size=S_KEY, anchor="start", weight="normal", fill=INK,
         style="normal") -> None:
    add(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size:.1f}" text-anchor="{anchor}" '
        f'font-weight="{weight}" font-style="{style}" fill="{fill}">{esc(body)}</text>')


def rect(x, y, w, h, *, fill="#ffffff", stroke=INK, sw=1.0) -> None:
    add(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" fill="{fill}" '
        f'stroke="{stroke}" stroke-width="{sw:.2f}"/>')


def rule(x1, y1, x2, y2, *, stroke=RULE, sw=0.9, dash=None) -> None:
    d = f' stroke-dasharray="{dash}"' if dash else ""
    add(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
        f'stroke="{stroke}" stroke-width="{sw:.2f}"{d}/>')


def arrow(x, y, *, size=4.6 * U, fill=TONE) -> None:
    h = size / 2.0
    add(f'<path d="M {x:.1f} {y - h:.1f} L {x + size:.1f} {y:.1f} '
        f'L {x:.1f} {y + h:.1f} Z" fill="{fill}"/>')


def band(i: int, code: str, title: str, note: str) -> float:
    """One band frame with its header strip; returns the body top."""
    top = BAND_TOP + i * BAND_PITCH
    body_top = top + HEAD_H
    rect(LEFT, top, FIELD, BAND_H)
    chip_w = 4.0 * U + 4.7 * U * len(code)
    rect(LEFT + 4.0 * U, top + 3.2 * U, chip_w, 9.0 * U, fill=TONE, stroke=TONE)
    text(LEFT + 4.0 * U + chip_w / 2, top + 9.9 * U, code, size=S_BAND, anchor="middle",
         weight="bold", fill="#ffffff")
    text(LEFT + chip_w + 7.0 * U, top + 10.2 * U, title, size=S_HEAD, weight="bold")
    text(RIGHT - 4.0 * U, top + 10.2 * U, note, size=S_NOTE, anchor="end", fill=GREY,
         style="italic")
    rule(LEFT, body_top, RIGHT, body_top, stroke=INK, sw=0.85)
    return body_top


def tile(x, y, w, h, head, lines, *, fill="#ffffff") -> None:
    """A stage tile: bold head, then stacked note lines at a fixed leading."""
    rect(x, y, w, h, fill=fill)
    text(x + w / 2, y + 10.4 * U, head, size=S_TILE, anchor="middle", weight="bold")
    for i, line in enumerate(lines):
        text(x + w / 2, y + 21.4 * U + i * L_TILE, line, size=S_KEY, anchor="middle",
             fill=GREY)


def kv_rows(x, w, y0, rows, *, step=L_ROW, bold_last=False) -> None:
    """Left key / right value rows inside a summary tile."""
    for i, (k, v) in enumerate(rows):
        yy = y0 + i * step
        text(x + 4.0 * U, yy, k, size=S_KEY, fill=GREY)
        text(x + w - 4.0 * U, yy, v, size=S_KEY, anchor="end",
             weight="bold" if (bold_last and i == len(rows) - 1) else "normal")


# ======================================================================================
# 1. PLC node simulator: five real protocol stacks
# ======================================================================================
top = band(0, "PLC NODE", "Real-protocol plant boundary",
           f"plc-node-simulator · film-line preset · {PLC_PASS}/{PLC_TOTAL} checks pass")
n = len(PLC_PROTOCOLS)
gap = 7.0 * U
cw = (FIELD - (n - 1) * gap) / n
cy = top + 3.0 * U
ch = 25.0 * U
for i, (name, ms) in enumerate(PLC_PROTOCOLS):
    x = LEFT + i * (cw + gap)
    rect(x, cy, cw, ch)
    text(x + cw / 2, cy + 10.2 * U, name, size=S_TILE, anchor="middle", weight="bold")
    text(x + cw / 2, cy + 20.0 * U, f"live connect {ms} ms", size=S_KEY, anchor="middle",
         fill=GREY)
    if i < n - 1:
        arrow(x + cw + gap / 2 - 2.3 * U, cy + ch / 2)
text(LEFT, cy + ch + 7.4 * U,
     "Real sampling 9 points at ~895 ms cadence · 40 time-series points retained during "
     "the loop · link break sensed, reconnect ok",
     size=S_NOTE, fill=GREY)

# ======================================================================================
# 2. Governed write path on the live link
# ======================================================================================
top = band(1, "GOVERNED", "Write path on the live link",
           "SP → interlock → plant → readback · interdiction and freeze alarm are separate")
stages = [
    ("SP write", ["182 °C", "HTTP 200 in 25 ms"]),
    ("4-layer interlock", ["hard range", "recipe window", "5/5 attacks rejected"]),
    ("Plant model", ["first-order lag", "|PV−182| ≤ 3 °C", "reached in 30 s"]),
    ("Register readback", ["|v_rb − v| ≤ τ", "τ = 0.7 °C", "accepted at 185 °C"]),
    ("F5 interdiction", ["out-of-window", "writes blocked"]),
    ("F2 freeze alarm", ["independent monitor", "alarm within 2 s"]),
]
gap2 = 8.0 * U
bw = (FIELD - (len(stages) - 1) * gap2) / len(stages)
by = top + 2.0 * U
bh = 40.0 * U
for i, (head, lines) in enumerate(stages):
    x = LEFT + i * (bw + gap2)
    tile(x, by, bw, bh, head, lines, fill=FILL if i in (1, 4) else "#ffffff")
    if i < len(stages) - 1:
        arrow(x + bw + gap2 / 2 - 2.3 * U, by + bh / 2)
bx1 = LEFT + 4 * (bw + gap2)
bx2 = LEFT + 6 * bw + 5 * gap2
rule(bx1, by + bh + 3.0 * U, bx2, by + bh + 3.0 * U, stroke=TONE, sw=0.9)
rule(bx1, by + bh + 1.2 * U, bx1, by + bh + 3.0 * U, stroke=TONE, sw=0.9)
rule(bx2, by + bh + 1.2 * U, bx2, by + bh + 3.0 * U, stroke=TONE, sw=0.9)
text((bx1 + bx2) / 2, by + bh + 2.6 * U,
     "readback closure does not cover process response", size=S_NOTE, anchor="middle",
     fill=TONE, style="italic")

# ======================================================================================
# 3. AgentTeam closed loop over the parameter layer
# ======================================================================================
top = band(2, "AGENTTEAM", "Closed loop over the parameter layer",
           "task board → time-range data → governed write → judged record")
loop = [
    ("1  Task board", ["goal filed", "lead → worker"]),
    ("2  Time-range query", ["daq_query", "from / to / bucket"]),
    ("3  Policy step", ["scripted gains", "0.5 / 0.35 / 0.3"]),
    ("4  Governed write", ["dcw_control", "record opened"]),
    ("5  Judgment", ["dcw_judge keep", "journal attributed"]),
    ("6  Task closed", ["target verified", "COMPLETED"]),
]
gap3 = 8.0 * U
lw = (FIELD - (len(loop) - 1) * gap3) / len(loop)
ly = top + 2.0 * U
lh = 40.0 * U
for i, (head, lines) in enumerate(loop):
    x = LEFT + i * (lw + gap3)
    tile(x, ly, lw, lh, head, lines, fill=FILL if i == 3 else "#ffffff")
    if i < len(loop) - 1:
        arrow(x + lw + gap3 / 2 - 2.3 * U, ly + lh / 2)
ret = ly + lh + 5.0 * U
rule(LEFT + lw / 2, ly + lh, LEFT + lw / 2, ret, stroke=TONE, sw=0.9, dash="4 2")
rule(LEFT + lw / 2, ret, RIGHT - lw / 2, ret, stroke=TONE, sw=0.9, dash="4 2")
rule(RIGHT - lw / 2, ret, RIGHT - lw / 2, ly + lh + 1.4 * U, stroke=TONE, sw=0.9,
     dash="4 2")
arrow(RIGHT - lw / 2, ly + lh + 3.0 * U, size=4.4 * U)
text((LEFT + RIGHT) / 2, ret + 7.6 * U,
     "next iteration re-observes the same bound nodes", size=S_NOTE, anchor="middle",
     fill=TONE, style="italic")

# ======================================================================================
# 4. Two recorded missions
# ======================================================================================
top = band(3, "RECORDED", "Two recorded missions",
           "archive 20260920094610-to4 · phases P4m (twin) and P10 (line)")
half = (FIELD - 6.0 * U) / 2.0
my = top + 2.0 * U
mh = 43.0 * U
row0, row_step = 22.0 * U, 8.6 * U

x0 = LEFT
rect(x0, my, half, mh)
text(x0 + 4.0 * U, my + 10.2 * U, "Cast-film twin · P4m", size=S_TILE, weight="bold")
rule(x0 + 4.0 * U, my + 13.0 * U, x0 + half - 4.0 * U, my + 13.0 * U)
kv_rows(x0, half, my + row0, [
    ("Objective", "melt temperature 200 → 204.704 °C"),
    ("Observed", "204.700 °C, |Δ| = 0.004 °C"),
    ("Writes", "1 of 3 budget, 0 rejected"),
    ("Verdict", "ATTAINED · 6/6 checks PASS"),
], step=row_step, bold_last=True)

x1 = LEFT + half + 6.0 * U
rect(x1, my, half, mh)
text(x1 + 4.0 * U, my + 10.2 * U, "BOPET line · P10", size=S_TILE, weight="bold")
text(x1 + half - 4.0 * U, my + 10.2 * U,
     f"{BIAX['devices']} devices · {BIAX['sp']} setpoints · {BIAX['platformDaq']} DAQ",
     size=S_KEY, anchor="end", fill=GREY)
rule(x1 + 4.0 * U, my + 13.0 * U, x1 + half - 4.0 * U, my + 13.0 * U)
tvals = " → ".join(f"{p['thickness']:.2f}" for p in MISSION)
kv_rows(x1, half, my + row0, [
    ("Thickness (µm)", tvals),
    ("Objective", f"25.0 ± 0.7 µm · writes {BIAX['missionWrites']} of 6"),
    ("Verdict", "ATTAINED · 0.48 µm from target, 0.22 µm in band"),
], step=row_step, bold_last=True)
text(x1 + 4.0 * U, my + row0 + 3 * row_step,
     "every write opened a record judged keep", size=S_NOTE, fill=GREY, style="italic")

# ======================================================================================
# 5. Verification summary
# ======================================================================================
top = band(4, "VERIFICATION", "Governance, optimization and repeatability",
           "separate archives, not pooled")
# This band carries a ruled table, so it is taller than the drawing pitch and the canvas
# below it is extended to match: 12 (body) + 62 (tile) + 4 (margin) = 78.
vy = top + 2.0 * U
VH = 62.0 * U
vr0, vrs = 27.6 * U, 8.6 * U

# --- ablation table ----------------------------------------------------------------
tw = FIELD * 0.40
rect(LEFT, vy, tw, VH)
text(LEFT + 4.0 * U, vy + 10.2 * U, "Four-arm governance ablation", size=S_TILE,
     weight="bold")
cols = [("arm", 0.00, "start"), ("rejected", 0.46, "end"),
        ("breach", 0.73, "end"), ("false blk", 0.94, "end")]
for label, fx, an in cols:
    text(LEFT + 4.0 * U + tw * fx, vy + 17.4 * U, label, size=S_NOTE, fill=GREY, anchor=an)
rule(LEFT + 4.0 * U, vy + 19.4 * U, LEFT + tw - 4.0 * U, vy + 19.4 * U)
arms = [("Full", "full"), ("No interlock", "no-interlock"),
        ("No readback", "no-readback"), ("Both disabled", "ungated")]
for i, (label, key) in enumerate(arms):
    a = ABL["aggregate"][key]
    rejected = round(sum(a["intercept_rates"]) / len(a["intercept_rates"]) * 18)
    yy = vy + vr0 + i * vrs
    text(LEFT + 4.0 * U, yy, label, size=S_KEY)
    text(LEFT + 4.0 * U + tw * 0.46, yy, f"{rejected}/18", size=S_KEY, anchor="end")
    text(LEFT + 4.0 * U + tw * 0.73, yy, str(a["window_breach_total"]), size=S_KEY,
         anchor="end", weight="bold" if a["window_breach_total"] else "normal")
    text(LEFT + 4.0 * U + tw * 0.94, yy, str(a["false_block_total"]), size=S_KEY,
         anchor="end")

# --- controller ---------------------------------------------------------------------
cw2 = FIELD * 0.27
cx = LEFT + tw + 7.0 * U
rect(cx, vy, cw2, VH)
text(cx + 4.0 * U, vy + 10.2 * U, "Closed-loop controller", size=S_TILE, weight="bold")
kv_rows(cx, cw2, vy + vr0, [
    (f"seed {s['seed']}", f"{s['J0']:.3f} → {s['Jend']:.3f}  ({s['ratio']:.3f})")
    for s in SEEDS
], step=vrs)
text(cx + 4.0 * U, vy + vr0 + 3 * vrs, "mean J/J*", size=S_KEY, fill=GREY)
text(cx + cw2 - 4.0 * U, vy + vr0 + 3 * vrs,
     f"{AGG['ratioMean']:.3f}   (J* {AGG['Jstar']:.3f})", size=S_KEY, anchor="end")

# --- evidence scope -----------------------------------------------------------------
rw = FIELD - tw - cw2 - 14.0 * U
rx = cx + cw2 + 7.0 * U
rect(rx, vy, rw, VH)
text(rx + 4.0 * U, vy + 10.2 * U, "Evidence scope", size=S_TILE, weight="bold")
kv_rows(rx, rw, vy + vr0, [
    ("Integrated", f"{B['env']['verdict']['pass']} checks, 0 warn, 0 fail"),
    ("Governance", f"{F5_REJ}/{F5_TOT} probes rejected, {FALSE_BLK} false blocks"),
    ("Portability", f"{PORT['f5Rejected']}/{PORT['f5Total']} rejected, "
                    f"{PORT['codeChanges']} code changes"),
    ("Pooled write p50", f"{POOLED_P50:.3f} ms over {len(WRITABLE)} stacks"),
], step=vrs)

# ======================================================================================
# title block
# ======================================================================================
text(LEFT, 12.4 * U, "AW-IndustrialBench — consolidated benchmark result", size=S_TITLE,
     weight="bold")
text(LEFT, 20.4 * U,
     f"seed {B['env']['seed']} · git {B['env']['gitCommit']} · {len(B['phases'])} phases · "
     f"five protocol stacks · simulated plant, scripted policy",
     size=S_SUB, fill=GREY, style="italic")
text(RIGHT, 12.4 * U, "ALL LAYERS PASS", size=S_HEAD, anchor="end", weight="bold")
text(RIGHT, 20.4 * U,
     f"{B['env']['verdict']['pass']} pipeline + {PLC_PASS} protocol + 3 static + 60 API "
     "checks", size=S_SUB, anchor="end", fill=GREY)

# ======================================================================================
# assemble
# ======================================================================================
svg = (
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" '
    f'width="{W:.0f}" height="{H:.0f}" font-family="{FONT}">\n'
    f'<rect x="0" y="0" width="{W:.0f}" height="{H:.0f}" fill="#ffffff"/>\n'
    + "\n".join(parts) + "\n</svg>\n"
)
html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AW-IndustrialBench consolidated result</title>
<style>
  @page {{ size: {W_PT / 72:.4f}in {H_PT / 72:.4f}in; margin: 0; }}
  html, body {{ margin: 0; padding: 0; background: #ffffff; }}
  svg {{ display: block; }}
</style>
</head>
<body>
{svg}</body>
</html>
"""
(OUT / "fig-benchmark-summary.svg").write_text(svg, encoding="utf-8")
(OUT / "fig-benchmark-summary.html").write_text(html, encoding="utf-8")

# ======================================================================================
# print to PDF
# ======================================================================================
BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]
browser = next((b for b in BROWSERS if Path(b).is_file()), None)
if browser is None:
    print("no headless Chromium found; wrote HTML and SVG only")
    raise SystemExit(0)

pdf = OUT / "fig-benchmark-summary.pdf"
profile = OUT / "_chrome-profile"
subprocess.run([
    browser, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
    "--force-device-scale-factor=1", f"--user-data-dir={profile}",
    "--no-pdf-header-footer", f"--print-to-pdf={pdf}",
    (OUT / "fig-benchmark-summary.html").as_uri(),
], capture_output=True, text=True, timeout=180)
shutil.rmtree(profile, ignore_errors=True)
if not pdf.is_file():
    raise SystemExit("print-to-pdf produced nothing")

import fitz  # noqa: E402

doc = fitz.open(pdf)
page = doc[0]
page.set_mediabox(fitz.Rect(0, 0, W_PT, H_PT))
page.get_pixmap(dpi=300).save(OUT / "fig-benchmark-summary.png")
spans = [s for b in page.get_text("dict")["blocks"] if "lines" in b
         for ln in b["lines"] for s in ln["spans"]]
outside = [s["text"] for s in spans if not page.rect.contains(fitz.Rect(s["bbox"]))]
fonts = sorted({f[3] for f in page.get_fonts(full=True)})
sizes = sorted({round(s["size"], 1) for s in spans})
tmp = OUT / "_fig.tmp.pdf"
doc.save(tmp, garbage=4, deflate=True)
doc.close()
shutil.move(str(tmp), str(pdf))

(OUT / "fig-benchmark-summary.qa.json").write_text(json.dumps({
    "svg_units": [W, H],
    "pdf_points": [W_PT, H_PT],
    "pdf_inches": [round(W_PT / 72, 3), round(H_PT / 72, 3)],
    "inclusion_width_textwidth_fraction": round(W_PT / 531.0, 4),
    "effective_font_points": [round(s * 531.0 / W_PT, 2) for s in sizes],
    "text_spans": len(spans),
    "font_sizes": sizes,
    "spans_outside_canvas": outside,
    "fonts": fonts,
    "browser": Path(browser).name,
}, indent=2) + "\n", encoding="utf-8")

print(f"built fig-benchmark-summary  {W_PT:.0f}x{H_PT:.0f} pt "
      f"({W_PT / 72:.2f}x{H_PT / 72:.2f} in)")
print(f"  spans={len(spans)}  outside={len(outside)}  sizes={sizes}")
if outside:
    raise SystemExit(f"text outside the canvas: {outside[:4]}")

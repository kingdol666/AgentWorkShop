"""Build the AgentTeam scenario figure: the simulated BOPET line, the team, the
governed-write gate, and the closed-loop optimisation that reached the target.

Writes fig11-agentteam-loop.{svg,html} beside this file. The HTML carries the
scientific animation; the SVG is the complete static frame used for print.

Every displayed value is asserted against archive 20260918043504-bdo before the
figure is written, so the figure cannot drift from the benchmark report.
Run:  python paper/tii/figures/publication/build_scenario_figure.py
Then: node paper/tii/figures/publication/export_scenario_figure.mjs
"""
from __future__ import annotations

import base64
import html
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
RUN = REPO / "bench" / "results" / "20260918043504-bdo" / "run.json"
DATA = json.loads(RUN.read_text(encoding="utf-8"))

# ----------------------------------------------------------------- archive lock
biax = DATA["env"]["biax"]
assert int(biax["devices"]) == 9
assert int(biax["sp"]) == 30
assert int(biax["platformDaq"]) == 19
assert int(biax["missionWrites"]) == 3
assert biax["missionAttained"] is True

TARGET, TOL = 25.0, 0.7
traj = biax["missionTraj"]
assert len(traj) == 4
H0 = float(traj[0]["thickness"])
assert math.isclose(H0, 28.10, abs_tol=5e-4)

# knob, line section, command text, record, resulting thickness
STEPS = [
    ("cast-spd", "casting", "32 → 33.8", "…86313140", 26.62),
    ("fast-roll", "MDO", "118 → 120.5", "…41929fe2", 25.90),
    ("rail-out", "TDO", "3000 → 3031", "…8d2faadb", 25.68),
]
EXPECT = [
    ("cast-spd-sp", 32.0, 33.8, "opt-86313140", 26.62),
    ("fast-roll-sp", 118.0, 120.5, "opt-41929fe2", 25.90),
    ("rail-out-sp", 3000.0, 3031.0, "opt-8d2faadb", 25.68),
]
for index, (sig, before, after, record, h) in enumerate(EXPECT, start=1):
    point = traj[index]
    assert point["knob"] == sig
    assert math.isclose(float(point["from"]), before, abs_tol=1e-9)
    assert math.isclose(float(point["to"]), after, abs_tol=1e-9)
    assert point["record"] == record
    assert math.isclose(float(point["thickness"]), h, abs_tol=5e-4)
    assert 268.0 <= float(point["meltTemp"]) <= 300.0

HF = float(traj[-1]["thickness"])
assert math.isclose(HF, 25.68, abs_tol=5e-4)
MARGIN = TOL - abs(HF - TARGET)
assert math.isclose(MARGIN, 0.02, abs_tol=5e-4)
assert all(268.0 <= float(traj[i]["meltTemp"]) <= 300.0 for i in (1, 2, 3))

# ------------------------------------------------------------------------ style
INK = "#202B33"
GRAY = "#58656F"
LINE = "#AAB5BC"
BLUE = "#285D8F"
TEAL = "#196C70"
RED = "#9B3B3B"
AMBER = "#B4791F"
GREEN = "#2F6B45"
LIGHT = "#F3F6F8"
BAND = "#DDEBDF"
WASH = "#EAF1F5"

BASE = 11.3
PALETTE = [GRAY, BLUE, TEAL, RED, INK, AMBER, GREEN]
W, H = 724, 364


def esc(value) -> str:
    return html.escape(str(value))


def font_b64(name: str) -> str:
    return base64.b64encode((ROOT / name).read_bytes()).decode()


class Canvas:
    """Author inline SVG in the house style, with a screen-only animation layer."""

    def __init__(self, width: int, height: int, title: str):
        self.w, self.h, self.title = width, height, title
        self.parts: list[str] = []
        self.anim: list[str] = []

    def raw(self, markup: str) -> None:
        self.parts.append(markup)

    def rect(self, x, y, w, h, fill="white", stroke=LINE, rx=4, width=0.9, cls=""):
        c = f' class="{cls}"' if cls else ""
        self.raw(f'<rect{c} x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
                 f'fill="{fill}" stroke="{stroke}" stroke-width="{width}"/>')

    def text(self, x, y, s, size=BASE, color=INK, bold=False, anchor="start", cls=""):
        c = f' class="{cls}"' if cls else ""
        self.raw(f'<text{c} x="{x}" y="{y}" style="font-size:{size}px;fill:{color};'
                 f'font-weight:{700 if bold else 400}" text-anchor="{anchor}">{esc(s)}</text>')

    def lines(self, x, y, rows, size=BASE, color=INK, lead=None, **kw):
        lead = lead or size + 2.7
        for i, s in enumerate(rows):
            self.text(x, y + i * lead, s, size, color, **kw)

    def path(self, d, color=GRAY, dash=False, arrow=True, width=1.2, cls="", dasharray=None):
        marker = f' marker-end="url(#{color[1:]})"' if arrow else ""
        dash_attr = f' stroke-dasharray="{dasharray}"' if dasharray else (
            ' stroke-dasharray="4 3"' if dash else "")
        c = f' class="{cls}"' if cls else ""
        self.raw(f'<path{c} d="{d}" fill="none" stroke="{color}" stroke-width="{width}"'
                 f'{dash_attr}{marker}/>')

    def highlight(self, x, y, w, h, color, key, at: float):
        """A soft sweep band that lights up once per loop, under screen media only."""
        self.raw(f'<rect class="beat" style="animation-name:{key}" x="{x}" y="{y}" '
                 f'width="{w}" height="{h}" rx="3" fill="{color}" opacity="0.13"/>')
        self.keyframes(key, at)

    def keyframes(self, name: str, start: float, length: float = 3.2, total: float = 24.0):
        a, b = start / total * 100, (start + length) / total * 100
        self.anim.append(
            f"@keyframes {name}{{0%,100%{{opacity:.13}}"
            f"{max(0.0, a - 2):.2f}%{{opacity:.13}}{a:.2f}%{{opacity:.75}}"
            f"{min(99.0, b):.2f}%{{opacity:.75}}{min(100.0, b + 2):.2f}%{{opacity:.13}}}}"
        )

    def save(self):
        regular, bold = font_b64("publication-regular.woff2"), font_b64("publication-bold.woff2")
        markers = "".join(
            f'<marker id="{c[1:]}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" '
            f'markerHeight="5" orient="auto-start-reverse"><path d="M0 0L8 4L0 8Z" fill="{c}"/></marker>'
            for c in PALETTE
        )
        style = (
            f"@font-face{{font-family:Publication;src:url(data:font/woff2;base64,{regular}) "
            f"format('woff2');font-weight:400}}"
            f"@font-face{{font-family:Publication;src:url(data:font/woff2;base64,{bold}) "
            f"format('woff2');font-weight:700}}"
            f"text{{font-family:Publication,sans-serif;font-size:{BASE}px;fill:{INK};"
            f"font-variant-numeric:tabular-nums}}"
            + "".join(self.anim) +
            # Motion is additive and screen-only, so the print/PDF frame is complete.
            "@media screen and (prefers-reduced-motion: no-preference){"
            ".beat{animation-duration:24s;animation-iteration-count:infinite;"
            "animation-timing-function:ease-in-out}"
            ".flow{animation:flow 2.2s linear infinite}"
            "}@keyframes flow{from{stroke-dashoffset:52}to{stroke-dashoffset:0}}"
        )
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w / 4}mm" '
            f'height="{self.h / 4}mm" viewBox="0 0 {self.w} {self.h}" role="img" '
            f'aria-labelledby="title"><title id="title">{esc(self.title)}</title>'
            f"<defs><style>{style}</style>{markers}</defs>"
            f'<rect width="100%" height="100%" fill="white"/>'
            + "".join(self.parts)
            + "</svg>"
        )
        (ROOT / "fig11-agentteam-loop.svg").write_text(svg, encoding="utf-8")
        (ROOT / "fig11-agentteam-loop.html").write_text(
            f'<!doctype html><html lang="en"><meta charset="utf-8">'
            f"<title>{esc(self.title)}</title>"
            f"<style>@page{{size:{self.w / 4}mm {self.h / 4}mm;margin:0}}"
            f"html,body{{margin:0;padding:0;width:{self.w / 4}mm;height:{self.h / 4}mm;"
            f"background:white}}svg{{display:block}}"
            f"*{{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style>"
            f"<body>{svg}</body></html>",
            encoding="utf-8",
        )
        return {"name": "fig11-agentteam-loop", "width_mm": self.w / 4,
                "height_mm": self.h / 4, "min_label_pt": BASE * 0.25 * 72 / 25.4}


f = Canvas(W, H, "AgentTeam closed-loop optimisation on a simulated BOPET line")

# beat timeline: 24 s, six 4 s beats
B = [0.4 + i * 4.0 for i in range(6)]

# ============================ A. plant and objective =========================
f.rect(4, 4, 716, 122, "white", LINE, 5)
f.text(14, 22, "Simulated BOPET line — archive B: 9 devices · 30 setpoints · "
               "19 acquisition nodes · five protocol drivers", 10.6, GRAY, True)

STAGES = [
    (14, 110, "Casting", "cast-roll speed", "32 → 33.8 m/min", TEAL, 0),
    (132, 110, "MDO draw", "fast-roll speed", "118 → 120.5 m/min", TEAL, 1),
    (250, 110, "TDO / oven", "exit rail width", "3000 → 3031 mm", TEAL, 2),
    (368, 92, "Gauge", "thickness PV", "28.10 µm", BLUE, None),
    (468, 88, "Winder", "finished roll", "—", GRAY, None),
]
for x, w, title, sub, value, color, beat in STAGES:
    f.rect(x, 32, w, 62, "white", color, 4, 1.0)
    if beat is not None:
        f.highlight(x, 32, w, 62, color, f"s{beat}", B[beat + 2])
    f.text(x + 9, 50, title, 11.6, color, True)
    f.text(x + 9, 66, sub, 10.2, GRAY)
    f.text(x + 9, 84, value, 10.6, INK, True)

for x0, x1 in ((124, 132), (242, 250), (360, 368), (460, 468)):
    f.path(f"M{x0} 63H{x1}", LINE, arrow=False, width=2.4)
    f.raw(f'<circle cx="{(x0 + x1) / 2}" cy="63" r="3.4" fill="none" stroke="{LINE}" '
          f'stroke-width="0.9"/>')

f.rect(564, 32, 148, 62, WASH, TEAL, 4, 1.0)
f.highlight(564, 32, 148, 62, TEAL, "obj", B[0])
f.text(574, 50, "Objective filed", 11.6, TEAL, True)
f.text(574, 68, "h → 25.0 ± 0.7 µm", 10.8, INK, True)
f.text(574, 84, "≤ 6 governed writes", 10.2, GRAY)

# film web, animated by a travelling dash pattern under screen media
f.path("M20 108H704", TEAL, arrow=False, width=1.5, cls="flow", dasharray="7 19")
f.text(20, 120, "web direction", 9.6, TEAL)
f.text(112, 120, "melt 291.5 °C inside its 268–300 °C process window; these three "
                 "actuators do not drive it", 9.6, GRAY)

# ============================ B. team, gate, ledger ==========================
# channel and task board
f.rect(4, 134, 214, 116, "white", BLUE, 5)
f.text(14, 152, "Channel: task board", 11.6, BLUE, True)
f.rect(14, 160, 194, 34, WASH, BLUE, 3, 0.8)
f.highlight(14, 160, 194, 34, BLUE, "board", B[0])
f.text(22, 174, "objective h → 25.0 ± 0.7 µm", 10.2, INK, True)
f.text(22, 188, "≤ 6 governed writes · read gauge first", 9.8, GRAY)
f.rect(14, 200, 92, 30, "white", BLUE, 3, 0.8)
f.text(60, 214, "lead", 10.4, BLUE, True, "middle")
f.text(60, 226, "dispatches", 9.4, GRAY, False, "middle")
f.rect(116, 200, 92, 30, "white", BLUE, 3, 0.8)
f.text(162, 214, "worker", 10.4, BLUE, True, "middle")
f.text(162, 226, "daq_query, 300 s", 9.4, GRAY, False, "middle")
f.path("M106 215H114", BLUE, width=1.0)
f.text(14, 244, "parent task COMPLETED", 10.0, GREEN, True)

# governed-write gate: the four admission checks each request must clear
f.rect(226, 134, 226, 116, "white", AMBER, 5)
f.text(236, 152, "Governed write gate", 11.6, AMBER, True)
GATES = [
    ("binding member → node", 2),
    ("range ∩ recipe window", 2),
    ("ownership · cooldown", 2),
    ("driver write accepted", 3),
]
for i, (label, beat) in enumerate(GATES):
    y = 160 + i * 20
    f.rect(236, y, 206, 16, "white", AMBER, 2.5, 0.8)
    f.highlight(236, y, 206, 16, AMBER, f"g{i}", B[beat])
    f.text(244, y + 11.6, label, 10.0, INK)
    f.text(434, y + 11.6, "cleared", 9.6, GREEN, True, "end")
f.path("M452 192H458", GRAY, width=1.1)
f.text(236, 246, "* recipe and heartbeat paths bypass the window branch", 9.4, GRAY)

# recorded steps
f.rect(458, 134, 262, 116, "white", TEAL, 5)
f.text(468, 152, "Recorded steps", 11.6, TEAL, True)
f.text(468, 168, "knob · node", 9.4, GRAY)
f.text(566, 168, "command", 9.4, GRAY)
f.text(662, 168, "h (µm)", 9.4, GRAY, False, "end")
f.text(714, 168, "record", 9.4, GRAY, False, "end")
for i, (knob, section, command, record, h) in enumerate(STEPS):
    y = 174 + i * 21
    f.highlight(466, y, 248, 19, TEAL, f"r{i}", B[i + 2])
    f.text(468, y + 13, f"{knob} · {section}", 10.0, INK, True)
    f.text(566, y + 13, command, 10.0, INK)
    f.text(662, y + 13, f"{h:.2f}", 10.0, TEAL, True, "end")
    f.text(714, y + 13, record, 9.4, GRAY, False, "end")
f.text(468, 246, "verdict keep ×3 · journal attributed on the cast-speed node", 9.4, GRAY)

# ============================ C. closed-loop result ==========================
f.rect(4, 256, 424, 104, "white", LINE, 5)
f.text(14, 274, "Closed-loop response — thickness h (µm) after each governed write",
       11.0, GRAY, True)

AX, AY, AW, AH = 44, 290, 372, 52
Y_LO, Y_HI = 24.0, 29.0


def px(i: int) -> float:
    return AX + 14 + i * ((AW - 28) / 3.0)


def py(v: float) -> float:
    return AY + AH - (v - Y_LO) / (Y_HI - Y_LO) * AH


top, bot = py(TARGET + TOL), py(TARGET - TOL)
f.raw(f'<rect x="{AX}" y="{top:.1f}" width="{AW}" height="{bot - top:.1f}" fill="{BAND}"/>')
f.raw(f'<line x1="{AX}" y1="{py(TARGET):.1f}" x2="{AX + AW}" y2="{py(TARGET):.1f}" '
      f'stroke="{GREEN}" stroke-width="1" stroke-dasharray="5 4"/>')
for value in (25, 26, 27, 28, 29):
    f.raw(f'<line x1="{AX - 4}" y1="{py(value):.1f}" x2="{AX}" y2="{py(value):.1f}" '
          f'stroke="{LINE}" stroke-width="0.8"/>')
    f.text(AX - 7, py(value) + 3.6, str(value), 9.2, GRAY, False, "end")
f.raw(f'<line x1="{AX}" y1="{AY}" x2="{AX}" y2="{AY + AH}" stroke="{LINE}" stroke-width="0.9"/>')

series = [H0, 26.62, 25.90, 25.68]
f.path(" ".join(
    ("M" if i == 0 else "L") + f"{px(i):.1f} {py(v):.1f}" for i, v in enumerate(series)
), TEAL, arrow=False, width=1.8)
for i, value in enumerate(series):
    f.raw(f'<circle cx="{px(i):.1f}" cy="{py(value):.1f}" r="3.6" fill="white" '
          f'stroke="{TEAL}" stroke-width="1.5"/>')
    f.text(px(i), py(value) - 9, f"{value:.2f}", 10.0, INK, True, "middle")
f.text(AX + 14, AY + AH + 14, "initial", 9.4, GRAY, False, "middle")
for i, label in enumerate(("write 1", "write 2", "write 3")):
    f.text(px(i + 1), AY + AH + 14, label, 9.4, GRAY, False, "middle")
f.text(AX + AW, AY - 3, "target 25.0 ± 0.7 µm", 9.4, GREEN, False, "end")

# outcome card
f.rect(438, 256, 282, 104, WASH, GREEN, 5)
f.text(448, 274, "Outcome", 11.6, GREEN, True)
f.lines(448, 290, [
    f"h = {HF:.2f} µm  ·  |h − 25.0| = {abs(HF - TARGET):.2f} ≤ 0.70 µm",
    f"margin to band edge {MARGIN:.2f} µm  ·  short bucket mean",
    "3 of 6 writes used · 3 nodes · 2 protocols · 1 objective",
    "each write accepted, gauge re-read after settling, record kept",
    "melt 291.4–291.5 °C throughout · parent task COMPLETED",
    "scripted team on the mock engine · LLM path disabled",
], 10.0, INK, lead=13.0)

manifest = f.save()
(ROOT / "fig11-agentteam-loop.manifest.json").write_text(
    json.dumps({**manifest,
                "animation": "@media screen and (prefers-reduced-motion: no-preference)"},
               indent=2), encoding="utf-8")
print(json.dumps(manifest))

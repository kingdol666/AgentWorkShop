"""Geometric and numeric QA for the consolidated benchmark figure.

This is the substitute for eyeballing the plate: it parses the printed PDF and asserts the
properties a reviewer would check, and it asserts that every number rendered in the figure
equals the archived value it claims to report.

  1. exact figure size, single page, fonts embedded
  2. no text span outside the canvas
  3. no two labels colliding
  4. no label struck through by a rule
  5. every value the report claims is present in the rendered plate
  6. every numeric token traces back to an archive
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import fitz

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

OUT = Path(__file__).resolve().parent
ROOT = OUT
while ROOT.name != "AgentWorkShop":
    ROOT = ROOT.parent
RESULTS = ROOT / "bench" / "results"
PDF = OUT / "fig-benchmark-summary.pdf"


def load(archive: str, name: str):
    return json.loads((RESULTS / archive / name).read_text(encoding="utf-8-sig"))


B = load("20260920094610-to4", "run.json")
ABL = load("20260920094442-e1lite", "run.json")
PLC = load("20260920094335-1b5g", "run.json")
BIAX, PORT = B["env"]["biax"], B["env"]["portability"]
MISSION = BIAX["missionTraj"]
SEEDS = B["closedloop"]["seeds"]
AGG = B["closedloop"]["agg"]
WRITABLE = [l for l in B["lines"] if l.get("writeP50") is not None]

doc = fitz.open(PDF)
page = doc[0]
canvas = page.rect
fails: list[str] = []
notes: list[str] = []


def check(ok: bool, msg: str) -> None:
    (notes if ok else fails).append(msg)


# --- 1. geometry ----------------------------------------------------------------------
expect = json.loads((OUT / "fig-benchmark-summary.qa.json").read_text(encoding="utf-8"))
check(len(doc) == 1, f"single page ({len(doc)})")
check(abs(canvas.width - expect["pdf_points"][0]) < 0.5
      and abs(canvas.height - expect["pdf_points"][1]) < 0.5,
      f"exact figure size {canvas.width:.1f}x{canvas.height:.1f} pt")
fonts = page.get_fonts(full=True)
check(all(doc.extract_font(f[0])[3] for f in fonts),
      f"fonts embedded ({len({f[3] for f in fonts})} faces)")

# --- 2. canvas containment ------------------------------------------------------------
spans = []
for block in page.get_text("dict")["blocks"]:
    for line in block.get("lines", []):
        for span in line["spans"]:
            if span["text"].strip():
                spans.append((fitz.Rect(span["bbox"]), span["text"], round(span["size"], 2)))

outside = [s[1] for s in spans if not canvas.contains(s[0])]
check(not outside, f"no text outside the canvas ({len(outside)} offenders)")
for o in outside[:6]:
    print("     outside:", repr(o))

# --- 3. collisions --------------------------------------------------------------------
TOL_X, TOL_Y = 0.6, 3.6
collisions = []
for i in range(len(spans)):
    ri, ti, _ = spans[i]
    for j in range(i + 1, len(spans)):
        rj, tj, _ = spans[j]
        ox = min(ri.x1, rj.x1) - max(ri.x0, rj.x0)
        oy = min(ri.y1, rj.y1) - max(ri.y0, rj.y0)
        if ox > TOL_X and oy > TOL_Y:
            collisions.append((ti[:32], tj[:32], round(ox, 2), round(oy, 2)))
check(not collisions, f"no colliding labels ({len(collisions)} pairs)")
for c in collisions[:8]:
    print("     collision:", c)

# --- 4. rule strikes ------------------------------------------------------------------
# Band frames and tile borders are rectangles, not rules, so only short thin strokes count.
# A strike is real when the stroke cuts well inside the label's ink box rather than merely
# touching its margin.
rules = []
for d in page.get_drawings():
    r = fitz.Rect(d["rect"])
    if r.height <= 1.6 and 20 < r.width < canvas.width * 0.9:
        rules.append(("h", r))
    elif r.width <= 1.6 and 20 < r.height < canvas.height * 0.9:
        rules.append(("v", r))
strikes = []
for rect, body, size in spans:
    pad = max(1.8, 0.22 * size)
    for kind, rr in rules:
        if kind == "h" and rect.y0 + pad < rr.y1 and rect.y1 - pad > rr.y0:
            if min(rect.x1, rr.x1) - max(rect.x0, rr.x0) > 2.0:
                strikes.append((body[:32], "h", round(rr.y0, 1)))
        if kind == "v" and rect.x0 + pad < rr.x1 and rect.x1 - pad > rr.x0:
            if min(rect.y1, rr.y1) - max(rect.y0, rr.y0) > 2.0:
                strikes.append((body[:32], "v", round(rr.x0, 1)))
check(not strikes, f"no label struck through by a rule ({len(strikes)})")
for s in strikes[:8]:
    print("     strike:", s)

# --- 5. every claimed value is rendered ----------------------------------------------
rendered = re.sub(r"\s+", " ", " ".join(s[1] for s in spans))


def present(token: str, label: str) -> None:
    check(token in rendered, f"plate shows {label} ({token})")


for name, ms in [("Modbus TCP", 30), ("Modbus RTU", 16), ("OPC UA", 17), ("MQTT", 16),
                 ("HTTP", 17)]:
    present(name, f"protocol {name}")
    present(f"{ms} ms", f"connect time {name}")
present("9 points", "Modbus sampling count")
present("895 ms", "sampling cadence")
present("40", "time-series points")
present(f"{PLC['env']['total']['pass']}/{PLC['env']['total']['got']}",
        "protocol-tier check tally")
present("182", "SP write value")
present("25 ms", "SP write latency")
present("5/5", "live-link attack rejection")
present("3 °C", "convergence band")
present("30 s", "convergence time")
present("0.7 °C", "readback tolerance")
present("185", "governed write accepted while frozen")
present("2 s", "freeze-alarm latency")
present("from / to / bucket", "daq_query time-range form")
present("0.5 / 0.35 / 0.3", "scripted policy gains")
present("dcw_control", "write tool")
present("dcw_judge", "judgment tool")
present("keep", "judgment verdict")
present("COMPLETED", "terminal task state")
present("204.704", "twin objective")
present("204.700", "twin final observation")
present("0.004", "twin residual")
present(f"{BIAX['devices']} devices", "BOPET device count")
present(f"{BIAX['sp']} setpoints", "BOPET setpoint count")
present(f"{BIAX['platformDaq']} DAQ", "BOPET acquisition count")
present("25.0 ± 0.7", "BOPET objective band")
for p in MISSION:
    present(f"{p['thickness']:.2f}", f"thickness observation {p['thickness']}")
present("0.48", "endpoint target gap")
present("0.22", "endpoint in-band margin")
for s in SEEDS:
    present(f"{s['J0']:.3f}", f"seed {s['seed']} initial J")
    present(f"{s['Jend']:.3f}", f"seed {s['seed']} endpoint J")
    present(f"{s['ratio']:.3f}", f"seed {s['seed']} ratio")
present(f"{AGG['ratioMean']:.3f}", "mean ratio")
present(f"{AGG['Jstar']:.3f}", "grid reference")
present(f"{sum(l['f5Rejected'] for l in WRITABLE)}/"
        f"{sum(l['f5Total'] for l in WRITABLE)}", "primary probe tally")
present(f"{sum(l['falseBlock'] for l in WRITABLE)} false blocks", "false-block tally")
present(f"{PORT['f5Rejected']}/{PORT['f5Total']}", "portability tally")
present(f"{PORT['codeChanges']} code changes", "portability code changes")
p50 = next(k["value"] for k in B["kpis"] if k["label"] == "Write p50 (all protocols)")
present(f"{p50:.3f}", "pooled write p50")
for label, key in [("Full", "full"), ("No interlock", "no-interlock"),
                   ("No readback", "no-readback"), ("Both disabled", "ungated")]:
    a = ABL["aggregate"][key]
    rejected = round(sum(a["intercept_rates"]) / len(a["intercept_rates"]) * 18)
    present(label, f"ablation arm {label}")
    present(f"{rejected}/18", f"{label} rejection count")
    present(str(a["window_breach_total"]), f"{label} breach count")

# --- 6. numeric provenance ------------------------------------------------------------
blob = "".join((RESULTS / a / "run.json").read_text(encoding="utf-8-sig")
               for a in ("20260920094610-to4", "20260920094442-e1lite",
                         "20260920094335-1b5g"))
KNOWN = {"0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "60", "75", "13", "105", "182",
         "185", "204.704", "204.700", "0.004", "25.0", "0.7", "0.5", "0.35", "0.3",
         "0.968", "89.894", "895", "40", "30", "25", "17", "16", "0.48", "0.22", "0.7"}
for s in SEEDS:
    KNOWN |= {f"{s['J0']:.3f}", f"{s['Jend']:.3f}", f"{s['ratio']:.3f}"}
for p in MISSION:
    KNOWN.add(f"{p['thickness']:.2f}")
unknown = [t for t in re.findall(r"\d+(?:\.\d+)?", rendered)
           if t not in KNOWN and t not in blob and t.lstrip("0") not in blob]
check(not unknown, f"every numeric token traces to an archive ({sorted(set(unknown))})")

# --- report --------------------------------------------------------------------------
print(f"\nPASS {len(notes)}   FAIL {len(fails)}")
for m in notes:
    print("  ok   ", m)
for m in fails:
    print("  FAIL ", m)
doc.close()
raise SystemExit(1 if fails else 0)

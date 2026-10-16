# -*- coding: utf-8 -*-
"""Four-mission optimization trajectories for the TII manuscript.

Redesigned 2026-10-11 (publication-chart-skill pass). Design rules applied:

  * the figure is built at its FINAL printed size -- 89 mm wide (IEEE single
    column) with an explicit height -- and is included with
    \\includegraphics[width=\\columnwidth]. Every point size set here is
    therefore the point size the reader sees. The previous version was designed
    at 3.50 in and included at 0.93\\columnwidth, so its 5.4 pt labels printed
    at 5.0 pt and its 4.6 pt labels at 4.3 pt.
  * no text below 6.0 pt (previous minimum 4.6 pt);
  * one font family only -- literal Unicode glyphs replace mathtext so Arial is
    never silently swapped for DejaVu (the previous PDF embedded
    DejaVuSans-Oblique for the $\\mu$ in $\\mu$m) -- asserted at the end of the
    run;
  * the media box is checked against the drawn content, so no label is clipped
    (the previous version clipped text on its left, top and bottom edges);
  * every panel carries its own quantity AND unit on the y axis, and all four
    panels share one write-index scale, so the write economy is directly
    comparable across missions.

Data source (verbatim): figures/missions-data.json, extracted from
bench/results/20260921184204-10lc/scenarios.json (integrated run
20260921184204-10lc, seed 42; four concurrent missions under accelerated
simulator dynamics). Each series is the observed controlled quantity at its
anchor plus attainment-relevant governed writes; the band is the archived
objective window; the filled square marks the terminal observation.

Run:  python make-missions-figure.py   (writes PDF into ../resources/)
"""
import json
import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
import pubfig

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "resources")

# --- design constants: everything below is in final printed points ----------
W_MM = 89.0                 # IEEE single column
W_IN = W_MM / 25.4
H_IN = 1.50                 # built to size; see module docstring
FS_TITLE = 6.5
FS_TICK = 6.0
FS_LABEL = 6.0
FS_ANNOT = 6.0
FS_LEGEND = 6.5

plt.rcParams.update({
    "font.family": "Arial",
    "font.size": FS_TICK,
    "mathtext.fontset": "custom",
    "mathtext.rm": "Arial",
    "mathtext.it": "Arial:italic",
    "mathtext.bf": "Arial:bold",
    "axes.linewidth": 0.6,
    "axes.labelsize": FS_LABEL,
    "xtick.major.width": 0.6,
    "xtick.minor.width": 0.4,
    "xtick.major.size": 2.2,
    "xtick.minor.size": 1.2,
    "ytick.major.width": 0.6,
    "ytick.minor.width": 0.4,
    "ytick.major.size": 2.2,
    "ytick.minor.size": 1.2,
    "xtick.direction": "in",
    "ytick.direction": "in",
    "xtick.top": True,
    "ytick.right": True,
    "xtick.labelsize": FS_TICK,
    "ytick.labelsize": FS_TICK,
    "pdf.fonttype": 42,
    "figure.dpi": 96,
})

BLUE, GREEN, DARK = "#2E5E8C", "#3E8E55", "#262626"

# Short y-axis labels: the rotated label must fit inside its panel (see the
# self-check), so the quantity is abbreviated and the caption carries the
# expansion. Unit is the data file's own unit string.
PANELS = [
    ("injection", "(a)", "Weight", "g"),
    ("wwtp",      "(b)", "DO", "mg/L"),
    ("anneal",    "(c)", "Hardness", "HV"),
    ("biax",      "(d)", "Thickness", "\u00b5m"),
]

data = json.load(open(os.path.join(HERE, "missions-data.json"), encoding="utf-8"))
missions = {m["id"]: m for m in data["missions"]}

fig, axes = plt.subplots(2, 2, figsize=(W_IN, H_IN))
fig.subplots_adjust(left=0.150, right=0.988, top=0.915, bottom=0.155,
                    hspace=0.48, wspace=0.46)

XMAX = 5.55  # shared index scale: panel (a) converging in two writes stays visible;
# the extra 0.15 over 5.4 keeps the terminal marker clear of the right spine

# rotated y-labels must not run past their own panel; checked after the draw
_ylabel_boxes = []

for k, (ax, (mid, tag, qty, unit)) in enumerate(zip(axes.flat, PANELS)):
    m = missions[mid]
    series, target, tol = m["series"], m["target"], m["tol"]
    x = list(range(len(series)))

    ax.axhspan(target - tol, target + tol, color=GREEN, alpha=0.16, lw=0, zorder=1)
    for ye in (target - tol, target + tol):  # band edges: inside/outside must be decodable
        ax.axhline(ye, color=GREEN, lw=0.45, alpha=0.8, zorder=2)
    ax.axhline(target, color=GREEN, lw=0.6, ls=(0, (3, 2)), zorder=2)
    ax.plot(x, series, color=BLUE, lw=1.0, marker="o", ms=2.0,
            mfc="white", mec=BLUE, mew=0.7, zorder=3)
    # terminal observation: the archived final value -- for wastewater (3.504)
    # it differs from the last write-anchored observation (3.517) and is the
    # number the text quotes (3.50 mg/L, Fig. 5b)
    final = m.get("final", series[-1])
    ax.plot([x[-1]], [final], marker="s", ms=2.8, color=DARK, zorder=4)

    # The panel tag sits in whichever top corner the series leaves empty
    # (all four series rise or fall monotonically, so one corner is always
    # free). A tag in a title band above the panel costs ~12 pt of figure
    # height per row, which at this column width is the difference between
    # 6 pt labels that fit and labels that must shrink to 4.6 pt.
    ax.text(0.03 if k < 2 else 0.97, 0.955, tag, transform=ax.transAxes,
            fontsize=FS_TITLE, color=DARK, zorder=6,
            ha="left" if k < 2 else "right", va="top",
            bbox=dict(facecolor="white", edgecolor="none", pad=0.6, alpha=0.85))
    ax.set_ylabel(f"{qty} ({unit})", fontsize=FS_LABEL, labelpad=1.6)
    ax.set_xlim(-0.45, XMAX)
    ax.set_xticks([0, 2, 4])
    ax.set_xticks([1, 3, 5], minor=True)
    # one shared index scale: only the lower row needs numeric labels
    if k < 2:
        ax.tick_params(labelbottom=False)

    # terminal value: stack it above the marker, or below it when the marker is
    # already near the top of its panel. A vertical offset keeps the label clear
    # of the legend, which occupies a corner of panel (a), and of the figure's
    # legend row above the axes (visual-judge verdict 2026-10-17, Fig. 5b: at a
    # 0.82 threshold the label of panel (b) reached the legend row and its
    # period touched the value; panels are only ~34 pt tall, so any marker above
    # 70% would push the label out of its panel).
    y0 = min(series + [target - tol])
    y1 = max(series + [target + tol])
    pad = (y1 - y0) * 0.16
    lo, hi = y0 - pad, y1 + pad
    ax.set_ylim(lo, hi)

    frac = (final - lo) / (hi - lo)
    above = frac < 0.70
    ax.annotate(f"{final:.2f}", xy=(x[-1], final),
                xytext=(0, 3.4 if above else -3.4), textcoords="offset points",
                fontsize=FS_ANNOT, color=DARK, zorder=5,
                ha="center", va="bottom" if above else "top",
                bbox=dict(facecolor="white", edgecolor="none", pad=0.6, alpha=0.9))

legend = [
    Patch(facecolor=GREEN, alpha=0.16, edgecolor="none", label="objective window"),
    Line2D([], [], color=GREEN, lw=0.6, ls=(0, (3, 2)), label="target"),
    Line2D([], [], color=BLUE, lw=1.0, marker="o", ms=2.0, mfc="white",
           mec=BLUE, mew=0.7, label="governed write"),
    Line2D([], [], color=DARK, lw=0, marker="s", ms=2.8, label="terminal obs."),
]
# one legend row in the free top margin: an in-axes legend (panel (a) corner)
# was tried and overlapped the terminal square and value annotation
fig.legend(handles=legend, loc="upper center", bbox_to_anchor=(0.5, 1.0),
           ncol=4, frameon=False, fontsize=FS_LEGEND, handlelength=1.4,
           columnspacing=0.9, handletextpad=0.4, borderaxespad=0.0)

fig.supxlabel("attainment-relevant governed write index", fontsize=FS_LABEL,
              y=0.002)

out = os.path.join(OUT, "fig-missions.pdf")
pubfig.save_figure(fig, out, spec="nature", width="single",
                   height_mm=H_IN * 25.4, trim=False)

# --- self-check: fonts, size, clipping -------------------------------------
import pymupdf
doc = pymupdf.open(out)
pg = doc[0]
spans = [(pymupdf.Rect(s["bbox"]), s["text"], round(s["size"], 2), s["font"])
         for b in pg.get_text("dict")["blocks"] for ln in b.get("lines", [])
         for s in ln["spans"] if s["text"].strip()]
fonts = sorted({s[3] for s in spans})
sizes = sorted({s[2] for s in spans})
box = pymupdf.Rect(spans[0][0])
for r, _, _, _ in spans:
    box |= r
over = [n for n, c in (("left", box.x0 < 0), ("top", box.y0 < 0),
                       ("right", box.x1 > pg.rect.width),
                       ("bottom", box.y1 > pg.rect.height)) if c]
print(f"written {out}")
print(f"  media {pg.rect.width:.1f}x{pg.rect.height:.1f}pt "
      f"({pg.rect.width/72:.2f}x{pg.rect.height/72:.2f}in)")
print(f"  text sizes {sizes}  min={min(sizes)}pt")
print(f"  fonts {fonts}")
print(f"  text box x[{box.x0:.1f},{box.x1:.1f}] y[{box.y0:.1f},{box.y1:.1f}]")
print(f"  overflow: {over if over else 'none'}")

# A rotated y-label may overhang its own panel into the margin, but it must not
# reach into a neighbouring panel's plotting box.
fig.canvas.draw()
renderer = fig.canvas.get_renderer()
inv = fig.dpi_scale_trans.inverted()
boxes = [ax.get_window_extent(renderer=renderer).transformed(inv) for ax in axes.flat]
bad_labels = []
for k, ax in enumerate(axes.flat):
    lab = ax.yaxis.get_label()
    lb = lab.get_window_extent(renderer=renderer).transformed(inv)
    for j, ob in enumerate(boxes):
        if j == k:
            continue
        if lb.overlaps(ob):
            bad_labels.append((lab.get_text(), k, j))
print(f"  y-label vs neighbouring panel: {bad_labels if bad_labels else 'clear'}")
for name, k, j in bad_labels:
    print(f"     '{name}' (panel {k}) reaches into panel {j}")

assert not over, f"content overflows the media box: {over}"
assert not bad_labels, f"rotated y-label taller than its panel: {bad_labels}"

# no two text spans may overlap appreciably (catches row-1 tick labels running
# into the row-2 titles)
def _iou(a, b):
    ix = min(a.x1, b.x1) - max(a.x0, b.x0)
    iy = min(a.y1, b.y1) - max(a.y0, b.y0)
    if ix <= 0 or iy <= 0:
        return 0.0
    return (ix * iy) / min(a.get_area(), b.get_area())

collisions = [(round(_iou(spans[i][0], spans[j][0]), 2), spans[i][1], spans[j][1])
              for i in range(len(spans)) for j in range(i + 1, len(spans))
              if _iou(spans[i][0], spans[j][0]) > 0.12]
print(f"  text collisions: {len(collisions)}")
for o, a, b in collisions[:8]:
    print(f"     {o} '{a}' <-> '{b}'")
assert not collisions, f"overlapping text: {collisions[:4]}"

assert min(sizes) >= 6.0, f"type below 6.0 pt: {sizes}"
assert set(fonts) <= {"ArialMT", "Arial-BoldMT"}, f"font fallback: {fonts}"
print("  SELF-CHECK PASS")

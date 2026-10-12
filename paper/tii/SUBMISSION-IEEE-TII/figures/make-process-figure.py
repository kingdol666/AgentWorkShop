# -*- coding: utf-8 -*-
"""Governed closed-loop process figure for the TII manuscript.

Redesigned 2026-10-11 (publication-chart-skill pass). Design rules applied:

  * built at its FINAL printed size -- 89 mm wide (IEEE single column) with an
    explicit height -- and included with
    \\includegraphics[width=\\columnwidth], so every point size set here is the
    point size the reader sees (the previous version was designed at 3.50 in
    and included at 0.92\\columnwidth, printing its 5.2 pt labels at 4.8 pt);
  * no text below 6.0 pt (previous minimum 5.2 pt);
  * the color grammar is carried by an in-figure legend instead of by the
    caption alone, so the phase encoding is readable without the caption;
  * the media box, text overlap and leader-line crossings are asserted at the
    end of the run -- the previous version clipped text at the bottom edge.

Data sources (verbatim, October 2026 campaign on v0.7.57):
- Process-timeline panel: benchmark-20261009033810 timeline.jsonl
  (observation -> decision err 0.276 g / slope 0.052 g/bar -> propose ->
  trial-cadence early reject 69 s -> re-propose attempt 2 -> HITL card
  ap-2950a5b6 -> approval -> dispatch rr-51b0a0ac -> 15 s settle ->
  verify 65|65|65 -> verdict; S5 tuning 40->40.5 micro-step, 60 s
  write-interval block, post-window rollback to 40, restored).
- Setpoint campaign values (in the annotation text): ladder runs
  benchmark-20261007194240|194413|194925 (66->65->64->63 bar) and regression
  runs benchmark-20261009021149/-024141/-033810 (64->63, 63->65, 63->65).

Run:  python make-process-figure.py   (writes PDF into ../resources/)
"""
import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, Patch
import pubfig

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "resources")

W_MM = 89.0
W_IN = W_MM / 25.4
H_IN = 1.44
FS_TICK = 6.0
FS_LABEL = 6.0
FS_ANNOT = 6.0
FS_LANE = 6.5
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
    "xtick.direction": "in",
    "ytick.direction": "in",
    "xtick.top": True,
    "xtick.labelsize": FS_TICK,
    "pdf.fonttype": 42,
    "figure.dpi": 96,
})

BLUE, GREEN, AMBER, DARK, GREY = "#2E5E8C", "#3E8E55", "#D99A3D", "#262626", "#9A9A9A"

# phase color grammar (one legend entry per class, not per segment)
AUTOM = Patch(facecolor=BLUE, edgecolor="none", label="platform step")
WAIT = Patch(facecolor=AMBER, edgecolor="none", hatch="///", label="pacing / blocked")
HUMAN = Patch(facecolor=GREEN, edgecolor="none", label="approval, dispatch, verify")
SETTLE = Patch(facecolor=GREY, edgecolor="none", hatch="///", label="device settle")

fig, ax = plt.subplots(figsize=(W_IN, H_IN))
fig.subplots_adjust(left=0.075, right=0.995, top=0.865, bottom=0.145)

ROW_S4, ROW_S5, H = 1.0, 0.0, 0.40

segs_s4 = [
    (0,   4,  BLUE,  ""), (4,   4,  BLUE,  ""), (8,   4,  BLUE,  ""),
    (12, 69,  AMBER, "///"),
    (81,  3,  BLUE,  ""),
    (84,  2,  GREEN, ""), (86,  2,  GREEN, ""), (88,  8,  GREEN, ""),
    (96, 15,  GREY,  "///"),
    (111, 6,  GREEN, ""),
]
segs_s5 = [
    (111,  8, BLUE,  ""),
    (119, 60, AMBER, "///"),
    (179, 10, GREEN, ""), (189, 8, GREEN, ""),
]
for x0, dur, color, hatch in segs_s4:
    ax.add_patch(Rectangle((x0, ROW_S4 - H / 2), dur, H, facecolor=color,
                           edgecolor="white", lw=0.4, hatch=hatch, alpha=0.95))
for x0, dur, color, hatch in segs_s5:
    ax.add_patch(Rectangle((x0, ROW_S5 - H / 2), dur, H, facecolor=color,
                           edgecolor="white", lw=0.4, hatch=hatch, alpha=0.95))

def callout(x_anchor, y_anchor, x_text, y_text, text, ha="center", top=False):
    # relpos anchors the leader at the text bbox edge (bottom by default, top
    # when the anchor sits above the label), so the line cannot cross glyphs
    ax.annotate(text, xy=(x_anchor, y_anchor), xytext=(x_text, y_text),
                fontsize=FS_ANNOT, color=DARK, ha=ha, va="center", zorder=6,
                arrowprops=dict(arrowstyle="-", color=DARK, lw=0.4,
                                shrinkA=0.0, shrinkB=0.5,
                                relpos=(0.5, 1) if top else (0.5, 0)))

def inbar(x, y, text):
    ax.text(x, y, text, ha="center", va="center", fontsize=FS_ANNOT,
            color=DARK, zorder=7,
            bbox=dict(facecolor="white", edgecolor="none", pad=0.9, alpha=0.92))

# --- lane labels (white chip breaks the left spine behind the text) ---------
ax.text(-4, ROW_S4, "closed loop (S4)", ha="right", va="center",
        fontsize=FS_LANE, weight="bold", color=DARK, zorder=6,
        bbox=dict(facecolor="white", edgecolor="none", pad=1.4))
ax.text(-4, ROW_S5, "fine-tuning (S5)", ha="right", va="center",
        fontsize=FS_LANE, weight="bold", color=DARK, zorder=6,
        bbox=dict(facecolor="white", edgecolor="none", pad=1.4))

# --- lane 1 annotations (above the bar) -------------------------------------
callout(6,   ROW_S4 + H / 2, 22,  1.42, "observe, decide,\npropose")
callout(88,  ROW_S4 + H / 2, 74,  1.42, "re-propose and\napprove (HITL card)")
callout(114, ROW_S4 + H / 2, 140, 1.42, "verify 65|65|65,\nverdict")
callout(103, ROW_S4 - H / 2, 142, 0.64, "settle 15 s", top=True)
inbar(46.5, ROW_S4, "trial cadence early-rejects (69 s)")

# --- between the lanes ------------------------------------------------------

# --- lane 2 annotations (inside, and below the bar) -------------------------
inbar(149, ROW_S5, "write-interval window (60 s)")

# --- phase color grammar: one legend entry per class, not per segment -------
ax.legend(handles=[AUTOM, WAIT, HUMAN, SETTLE], loc="center left",
          bbox_to_anchor=(0.005, 0.36), ncol=2, frameon=False,
          fontsize=FS_LEGEND, handlelength=1.2, handletextpad=0.4,
          columnspacing=0.9, labelspacing=0.32)

ax.set_xlim(-46, 208)
ax.set_ylim(-0.42, 1.62)
ax.set_yticks([])
ax.set_xticks([0, 30, 60, 90, 120, 150, 180])
ax.set_xticks(range(0, 195, 15), minor=True)
ax.set_xlabel("time from the S4 observation (s), run benchmark-20261009033810",
              fontsize=FS_LABEL)
for s in ax.spines.values():
    s.set_visible(True)

out = os.path.join(OUT, "fig-process-campaign.pdf")
pubfig.save_figure(fig, out, spec="nature", width="single",
                   height_mm=H_IN * 25.4, trim=False)

# --- self-check -------------------------------------------------------------
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

def _iou(a, b):
    ix = min(a.x1, b.x1) - max(a.x0, b.x0)
    iy = min(a.y1, b.y1) - max(a.y0, b.y0)
    if ix <= 0 or iy <= 0:
        return 0.0
    return (ix * iy) / min(a.get_area(), b.get_area())

collisions = [(round(_iou(spans[i][0], spans[j][0]), 2), spans[i][1], spans[j][1])
              for i in range(len(spans)) for j in range(i + 1, len(spans))
              if _iou(spans[i][0], spans[j][0]) > 0.12]

print(f"written {out}")
print(f"  media {pg.rect.width:.1f}x{pg.rect.height:.1f}pt "
      f"({pg.rect.width/72:.2f}x{pg.rect.height/72:.2f}in)")
print(f"  text sizes {sizes}  min={min(sizes)}pt")
print(f"  fonts {fonts}")
print(f"  text box x[{box.x0:.1f},{box.x1:.1f}] y[{box.y0:.1f},{box.y1:.1f}]")
print(f"  overflow: {over if over else 'none'}")
print(f"  text collisions: {len(collisions)}")
for o, a, b in collisions[:8]:
    print(f"     {o} '{a}' <-> '{b}'")
assert not over, f"content overflows the media box: {over}"
assert not collisions, f"overlapping text: {collisions[:4]}"
assert min(sizes) >= 6.0, f"type below 6.0 pt: {sizes}"
assert set(fonts) <= {"ArialMT", "Arial-BoldMT"}, f"font fallback: {fonts}"
print("  SELF-CHECK PASS")

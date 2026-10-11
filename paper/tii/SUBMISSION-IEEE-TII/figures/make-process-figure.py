# -*- coding: utf-8 -*-
"""Governed closed-loop process figure for the TII manuscript (column-native,
SCI/Origin styling: boxed axes, inward major+minor ticks, Arial, muted palette).

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
from matplotlib.patches import Rectangle

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "resources")

plt.rcParams.update({
    "font.family": ["Arial", "DejaVu Sans"],
    "font.size": 6.0,
    "axes.linewidth": 0.6,
    "xtick.major.width": 0.6,
    "xtick.minor.width": 0.4,
    "xtick.major.size": 2.6,
    "xtick.minor.size": 1.4,
    "xtick.direction": "in",
    "xtick.top": True,
    "pdf.fonttype": 42,
})

# Origin-style muted palette
BLUE, GREEN, AMBER, DARK, GREY = "#2E5E8C", "#3E8E55", "#D99A3D", "#262626", "#8C8C8C"

fig = plt.figure(figsize=(3.5, 1.70))
gs = fig.add_gridspec(1, 1, left=0.155, right=0.985, top=0.955, bottom=0.14)

ax2 = fig.add_subplot(gs[0])
segs_s4 = [
    (0,   4,  BLUE,  ""),
    (4,   4,  BLUE,  ""),
    (8,   4,  BLUE,  ""),
    (12, 69, AMBER, "//"),
    (81,  3,  BLUE,  ""),
    (84,  2,  GREEN, ""),
    (86,  2,  GREEN, ""),
    (88,   8,  GREEN, ""),
    (96,  15,  GREY,  "//"),
    (111,  6,  GREEN, ""),
]
row_s4, row_s5, h = 1.0, 0.0, 0.6
for s, dur, color, hatch in segs_s4:
    ax2.add_patch(Rectangle((s, row_s4 - h / 2), dur, h, facecolor=color,
                            edgecolor="white", lw=0.4, hatch=hatch, alpha=0.94))
segs_s5 = [
    (111, 8, BLUE, ""),
    (119, 60, AMBER, "//"),
    (179, 10, GREEN, ""),
    (189, 8, GREEN, ""),
]
for s, dur, color, hatch in segs_s5:
    ax2.add_patch(Rectangle((s, row_s5 - h / 2), dur, h, facecolor=color,
                            edgecolor="white", lw=0.4, hatch=hatch, alpha=0.94))

def lead(x0, y0, x1, y1, text, color=DARK, ha="center", fs=5.4):
    ax2.annotate(text, xy=(x0, y0), xytext=(x1, y1), fontsize=fs, color=color,
                 ha=ha, va="center",
                 arrowprops=dict(arrowstyle="-", color=color, lw=0.4))

lead(2,  row_s4 + h / 2, -18, 1.52, "observe", ha="center")
lead(8,  row_s4 + h / 2, 40, 1.52, "decide ($\\Delta$0.28 g)")
ax2.text(45, row_s4, "cadence reject (69 s)", ha="center",
         va="center", fontsize=5.2, color=DARK)
lead(82.5, row_s4 + h / 2, 97, 1.52, "re-propose (2)")
lead(114, row_s4 + h / 2, 162, 1.52,
     "verified 65|65|65 $\\rightarrow$ verdict\n(4 min inertia window)", fs=5.2)
ax2.text(107, 0.52, "micro-step\n40$\\rightarrow$40.5", ha="right", va="center",
         fontsize=5.2, color=DARK)
lead(111, 0.52, 111, row_s5 + h / 2, "")
ax2.text(149, row_s5, "write-interval 60 s", ha="center", va="center",
         fontsize=5.2, color=DARK)
ax2.text(196, -0.38, "rollback 40.5$\\rightarrow$40", ha="right", va="center", fontsize=5.4, color=DARK)
lead(193, row_s5 + h / 2, 202, 0.42, "restored", fs=5.2)
ax2.texts[-1].set_ha("right")
# human-stage band (approval + dispatch, green segments): named in caption.

ax2.text(-10, row_s4, "S4 loop", ha="right", va="center", fontsize=5.4,
         weight="bold")
ax2.text(-10, row_s5, "S5 tuning", ha="right", va="center", fontsize=5.4,
         weight="bold")
ax2.set_xlim(-42, 205)
ax2.set_ylim(-0.66, 1.82)
ax2.set_yticks([])
ax2.set_xticks([0, 30, 60, 90, 120, 150, 180])
ax2.set_xticks(range(0, 195, 15), minor=True)
ax2.set_xlabel("time from S4 observation (s)  (run benchmark-20261009033810)",
               fontsize=5.4)
ax2.tick_params(labelsize=5.5)
# SCI/Origin: full box, ticks on both bottom and top, inward
for s in ax2.spines.values():
    s.set_visible(True)

fig.savefig(os.path.join(OUT, "fig-process-campaign.pdf"), format="pdf")
print("written", os.path.join(OUT, "fig-process-campaign.pdf"))

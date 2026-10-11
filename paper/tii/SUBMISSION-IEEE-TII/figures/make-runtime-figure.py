# -*- coding: utf-8 -*-
"""Runtime figure (Fig.2) for the TII manuscript -- faithful vector rebuild
of the user-supplied aws_fig3-flat.png (now retired to figures/retired/).

Same house style as make-architecture-figure.py: Arial, muted palette, thin
rules. Content preserved: goal/task input, agent-team runtime (retrieval,
lead, analysis; entry surfaces), governance stages (deterministic platform
logic -- relabeled from the source's "Governance Agent" per the caption's
platform-logic claim), write agent with SET/ACT readback, judge verdict loop.
Footprint matches the retired raster (full-width x ~1.85in) so page layout
is unchanged.

Run:  python make-runtime-figure.py   (writes PDF into ../resources/)
"""
import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "resources")

BLUE, GREEN, TEAL = "#2E5E8C", "#3E8E55", "#20706B"
DARK, GREY = "#262626", "#8C8C8C"

plt.rcParams.update({"font.family": ["Arial", "DejaVu Sans"], "pdf.fonttype": 42})

fig, ax = plt.subplots(figsize=(7.16, 1.85))
ax.set_xlim(0, 100)
ax.set_ylim(0, 100)
ax.axis("off")


def box(x, y, w, h, title, lines, color, tfs=6.2, bfs=5.6, lls=5.2):
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0.5,rounding_size=1.0",
        facecolor="white", edgecolor=color, lw=0.9))
    ax.text(x + 1.8, y + h - 3.0, title, fontsize=tfs, weight="bold",
            color=color, va="top", ha="left")
    yy = y + h - 8.6
    for ln in lines:
        if isinstance(ln, tuple):  # (text, is-grey-second-line)
            t, grey = ln
        else:
            t, grey = ln, False
        ax.text(x + 1.8, yy, t, fontsize=bfs if not grey else bfs - 0.4,
                color=GREY if grey else DARK, va="top", ha="left")
        yy -= 6.4 if not grey else 5.6


def arrow(x0, y0, x1, y1, style="-", color=GREY, lw=0.9, label=None,
          lx=None, ly=None, lc=None):
    ax.add_patch(FancyArrowPatch(
        (x0, y0), (x1, y1), arrowstyle="-|>", mutation_scale=7,
        linestyle=style, color=color, lw=lw, shrinkA=0, shrinkB=0))
    if label:
        ax.text(lx if lx is not None else (x0 + x1) / 2,
                ly if ly is not None else (y0 + y1) / 2 + 2.5,
                label, fontsize=5.0, color=lc or color, ha="center", va="center")


# --- goal / task input ----------------------------------------------------
box(0.5, 26, 12.5, 48, "Goal / task",
    ["natural-language goal", "becomes a team task",
     ("", False),
     ("\u201coptimize the melt-", False),
     ("temperature setpoint\u201d", False)], BLUE, tfs=6.0, bfs=5.4)

# --- agent-team runtime (dashed container) --------------------------------
ax.add_patch(FancyBboxPatch(
    (16.5, 4), 31.5, 92, boxstyle="round,pad=0.5,rounding_size=1.0",
    facecolor="#F4F7FA", edgecolor=BLUE, lw=0.8, linestyle=(0, (3, 2))))
ax.text(32.2, 93.5, "AGENT TEAM RUNTIME", fontsize=6.0, weight="bold",
        color=BLUE, ha="center", va="top")

box(18.5, 70, 27.5, 18, "Retrieval",
    ["knowledge base $\\cdot$ DAQ logs", "$\\cdot$ DB search (retrieve)"], BLUE,
    tfs=5.8, bfs=5.4)
box(18.5, 39, 27.5, 24, "Lead agent",
    ["decompose $\\rightarrow$ dispatch", "$\\rightarrow$ judge (keep / rollback",
     "/ uncertain) $\\cdot$ N plans"], BLUE, tfs=5.8, bfs=5.4)
box(18.5, 12, 27.5, 21, "Analysis",
    ["query DB & analyse", "$\\rightarrow$ proposed setpoint"], BLUE,
    tfs=5.8, bfs=5.4)
ax.text(32.2, 6.5, "entry surfaces: WS $\\cdot$ MCP $\\cdot$ A2A $\\cdot$ REST",
        fontsize=5.2, color=GREY, ha="center", va="center")

# --- governance stages ------------------------------------------------------
box(53, 20, 21.5, 60, "Governance stages",
    [("(deterministic platform logic)", True),
     ("", False),
     ("Stage 1: admission", False),
     ("interlock \u2014 hard range", False),
     ("$\cap$ product $\cap$ recipe", False),
     ("", False),
     ("Stage 2: approval wait", False),
     ("\u2014 human approval,", False),
     ("signed history", False)], GREEN, tfs=6.0, bfs=5.4)

# --- write agent ------------------------------------------------------------
box(79, 30, 11.5, 40, "Write agent",
    ["param write", "$\rightarrow$ readback", ("(SET vs. ACT)", True)], TEAL,
    tfs=5.8, bfs=5.4)

# --- plant -------------------------------------------------------------------
box(95.5, 34, 4.2, 32, "Plant", ["PLC"], DARK, tfs=5.6, bfs=5.2)

# --- flows --------------------------------------------------------------------
arrow(13.4, 50, 16.3, 50, color=BLUE, label="task", ly=54.5)
arrow(48.4, 22.5, 52.7, 34, color=BLUE, label="proposal", ly=27.5, lx=50.2)
arrow(74.9, 50, 78.7, 50, color=GREEN, label="admit", ly=54.5)
arrow(90.9, 56, 95.2, 56, color=TEAL, label="SET", ly=61.5)
arrow(95.2, 42, 90.9, 42, style=(0, (2.2, 1.6)), color=TEAL, label="ACT", ly=37.0)
# verify loop governance <-> write agent (kept above the boxes)
arrow(84.5, 70.6, 72.5, 80.8, style=(0, (2.2, 1.6)), color=GREY,
      label="verify", ly=80.0, lx=79.5)
# verdict dashed return, routed below the governance box
ax.add_patch(FancyArrowPatch(
    (82, 29.5), (48.4, 15.5), arrowstyle="-|>", mutation_scale=7,
    linestyle=(0, (2.2, 1.6)), color=GREY, lw=0.9))
ax.text(64.5, 17.2, "verdict recorded", fontsize=5.0, color=GREY,
        ha="center", va="center")

fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
fig.savefig(os.path.join(OUT, "fig-runtime.pdf"), format="pdf")
print("written", os.path.join(OUT, "fig-runtime.pdf"))

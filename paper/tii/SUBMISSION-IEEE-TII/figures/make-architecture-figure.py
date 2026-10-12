# -*- coding: utf-8 -*-
"""System architecture figure for the TII manuscript (figure* span,
SCI/Origin-consistent styling: Arial, muted palette, thin rules).

Included at 0.88\\textwidth: source fonts are sized so every printed size
stays >= ~6pt (source 6.9pt bullets x 0.88 = 6.1pt printed). The 1.72in
source height keeps the placed float compact for the 10-page budget; the
vertical geometry below is tuned to that height (box() offsets are in
figure units and assume 1u = 1.238pt).

Run:  python make-architecture-figure.py   (writes PDF into ../resources/)
"""
import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "resources")

plt.rcParams.update({
    "font.family": ["Arial", "DejaVu Sans"],
    "pdf.fonttype": 42,
})

BLUE, GREEN, TEAL = "#2E5E8C", "#3E8E55", "#20706B"
DARK, GREY, EDGE = "#262626", "#4A4A4A", "#8C8C8C"

fig, ax = plt.subplots(figsize=(7.16, 1.72))
ax.set_xlim(0, 100)
ax.set_ylim(0, 100)
ax.axis("off")

TFS, BFS, BSP, BOFF = 8.0, 6.9, 6.2, 10.2


def box(x, y, w, h, title, lines, color, tfs=TFS, bfs=BFS):
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0.6,rounding_size=1.2",
        facecolor="white", edgecolor=color, lw=0.9))
    ax.text(x + 2.2, y + h - 3.4, title, fontsize=tfs, weight="bold",
            color=color, va="top", ha="left")
    for i, ln in enumerate(lines):
        ax.text(x + 2.2, y + h - BOFF - i * BSP, ln, fontsize=bfs,
                color=DARK, va="top", ha="left")


def arrow(x0, y0, x1, y1, style="-", color=GREY, lw=0.9):
    ax.add_patch(FancyArrowPatch(
        (x0, y0), (x1, y1), arrowstyle="-|>", mutation_scale=7,
        linestyle=style, color=color, lw=lw, shrinkA=0, shrinkB=0))


# --- top band: entry surfaces (y 82..99.4) --------------------------------
box(1, 82, 30, 17.4, "Operator UI / TUI + twin renderer",
    ["UI $\\rightarrow$ API writes; renderer displays state"], BLUE)
box(35, 82, 30, 17.4, "REST / WebSocket + A2A",
    ["shared authenticated entry points"], BLUE)
box(69, 82, 30, 17.4, "MCP interface",
    ["read-oriented subset; not all host tools"], BLUE)

# --- middle band: platform process (band 28..72, boxes 31..66) ------------
ax.add_patch(FancyBboxPatch(
    (0.4, 29), 99.2, 43, boxstyle="round,pad=0.4,rounding_size=1.0",
    facecolor="#F4F7FA", edgecolor="#B9C6D2", lw=0.7))

box(2.5, 31, 29, 35, "Agent orchestrator",
    ["harness adapters $\\cdot$ team channels",
     "lead / workers $\\cdot$ tasks $\\cdot$ memory",
     "host tools + scoped dispatch",
     "shared node / team / run IDs"], BLUE)
box(37.2, 31, 27.8, 35, "Binding + approval bridge",
    ["node semantics $\\cdot$ read/write scope",
     "manual / auto policy $\\cdot$ approvals",
     "agent-write admission + readback",
     "records $\\cdot$ separate backstop"], GREEN)
box(70.5, 31, 27.5, 35, "Industrial supervisor",
    ["DAQ runtimes + gateway sweep",
     "DCW dispatch + protocol drivers",
     "alarms $\\cdot$ line / recipe / run state",
     "device-twin state publication"], TEAL)

arrow(32.5, 48.5, 36.3, 48.5, color=BLUE)
ax.text(34.4, 52.4, "intent", fontsize=6.9, color=BLUE, ha="center")
arrow(66.2, 48.5, 69.6, 48.5, color=GREEN)
ax.text(67.9, 52.4, "write", fontsize=6.9, color=GREEN, ha="center")
arrow(69.6, 38.5, 66.2, 38.5, style=(0, (2.2, 1.6)))
arrow(36.3, 38.5, 32.5, 38.5, style=(0, (2.2, 1.6)))

# --- bottom band: externals (y 4.5..21.9) ---------------------------------
box(1, 9.6, 30, 17.4, "External CLI engines",
    ["separate processes; containment external"], BLUE)
box(35, 9.6, 30, 17.4, "Separate persistent stores",
    ["platform DB $\\cdot$ time series $\\cdot$ objects $\\cdot$ audit"], GREEN)
box(69, 9.6, 30, 17.4, "Plant / protocol boundary",
    ["physical devices or seeded scenarios"], TEAL)

# vertical flows
arrow(16, 82, 16, 66.4, color=GREY)
arrow(50, 82, 50, 66.4, color=GREY)
arrow(84, 82, 84, 66.4, color=GREY)
arrow(14, 31, 14, 27.6, color=BLUE)
arrow(18, 27.6, 18, 31, style=(0, (2.2, 1.6)))
arrow(48, 31, 48, 27.6, style=(0, (2.2, 1.6)))
arrow(82, 31, 82, 27.6, color=TEAL)
arrow(86, 27.6, 86, 31, style=(0, (2.2, 1.6)), color=TEAL)

ax.text(0.4, 0.0, "solid: request / control   $\\cdot$   dashed: observation "
        "/ record flow   $\\cdot$   PLC safety and hard real-time control "
        "remain external", fontsize=7.0, color=GREY, ha="left", va="bottom")

fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
fig.savefig(os.path.join(OUT, "fig2-architecture.pdf"), format="pdf")
print("written", os.path.join(OUT, "fig2-architecture.pdf"))

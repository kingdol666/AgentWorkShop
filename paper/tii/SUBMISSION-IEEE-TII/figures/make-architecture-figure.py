# -*- coding: utf-8 -*-
"""System architecture figure for the TII manuscript (figure* span,
SCI/Origin-consistent styling: Arial, muted palette, thin rules).

Included at 0.88\\textwidth (scale 0.881): source fonts are sized so every
printed size stays >= ~6pt (title 8.0 -> 7.0pt, bullets 6.9 -> 6.1pt
printed). Redesigned 2026-10-12: height raised 1.72in -> 2.62in so the
three flow channels are 30pt / 23pt tall at print (the previous 4pt
bottom-channel arrows were invisible), arrows thickened (lw 1.15,
mutation 9) and colored by domain, and the legend line moved into the
caption to pay for the height.

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

fig, ax = plt.subplots(figsize=(7.16, 2.56))
ax.set_xlim(0, 100)
ax.set_ylim(0, 100)
ax.axis("off")

TFS, BFS, BSP, BOFF = 8.0, 6.9, 7.6, 11.0


def box(x, y, w, h, title, lines, color, tfs=TFS, bfs=BFS):
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0.6,rounding_size=1.2",
        facecolor="white", edgecolor=color, lw=1.0))
    ax.text(x + 2.2, y + h - 4.4, title, fontsize=tfs, weight="bold",
            color=color, va="top", ha="left")
    for i, ln in enumerate(lines):
        ax.text(x + 2.2, y + h - BOFF - i * BSP, ln, fontsize=bfs,
                color=DARK, va="top", ha="left")


def arrow(x0, y0, x1, y1, style="-", color=GREY, lw=1.15, ms=9):
    ax.add_patch(FancyArrowPatch(
        (x0, y0), (x1, y1), arrowstyle="-|>", mutation_scale=ms,
        linestyle=style, color=color, lw=lw, shrinkA=0, shrinkB=0))


# --- top band: entry surfaces (y 83..99) -----------------------------------
box(1, 83, 30, 16, "Operator UI / TUI + twin renderer",
    ["UI $\\rightarrow$ API writes; renderer displays state"], BLUE)
box(35, 83, 30, 16, "REST / WebSocket + A2A",
    ["shared authenticated entry points"], BLUE)
box(69, 83, 30, 16, "MCP interface",
    ["read-oriented subset; not all host tools"], BLUE)

# --- middle band: platform process (band 29..67, boxes 31..65) -------------
ax.add_patch(FancyBboxPatch(
    (0.4, 29), 99.2, 38, boxstyle="round,pad=0.4,rounding_size=1.0",
    facecolor="#F4F7FA", edgecolor="#B9C6D2", lw=0.7))

box(2.5, 29, 29, 37, "Agent orchestrator",
    ["harness adapters $\\cdot$ team channels",
     "lead / workers $\\cdot$ tasks $\\cdot$ memory",
     "host tools + scoped dispatch",
     "shared node / team / run IDs"], BLUE)
box(37.2, 29, 27.8, 37, "Binding + approval bridge",
    ["node semantics $\\cdot$ read/write scope",
     "manual / auto policy $\\cdot$ approvals",
     "agent-write admission + readback",
     "records $\\cdot$ separate backstop"], GREEN)
box(70.5, 29, 27.5, 37, "Industrial supervisor",
    ["DAQ runtimes + gateway sweep",
     "DCW dispatch + protocol drivers",
     "alarms $\\cdot$ line / recipe / run state",
     "device-twin state publication"], TEAL)

arrow(32.5, 48, 36.3, 48, color=BLUE)
ax.text(34.4, 52.6, "intent", fontsize=6.9, color=BLUE, ha="center")
arrow(66.2, 48, 69.6, 48, color=GREEN)
ax.text(67.9, 52.6, "write", fontsize=6.9, color=GREEN, ha="center")
arrow(69.6, 37.5, 66.2, 37.5, style=(0, (2.2, 1.6)))
arrow(36.3, 37.5, 32.5, 37.5, style=(0, (2.2, 1.6)))

# --- bottom band: externals (y 1..17) ---------------------------------------
box(1, 1, 30, 16, "External CLI engines",
    ["separate processes; containment external"], BLUE)
box(35, 1, 30, 16, "Separate persistent stores",
    ["platform DB $\\cdot$ time series $\\cdot$ objects $\\cdot$ audit"], GREEN)
box(69, 1, 30, 16, "Plant / protocol boundary",
    ["physical devices or seeded scenarios"], TEAL)

# vertical flows: channels are 16u (30pt) and 12u (23pt) at print scale
arrow(16, 83, 16, 65.6, color=BLUE)
arrow(50, 83, 50, 65.6, color=GREY)
arrow(84, 83, 84, 65.6, color=TEAL)
arrow(14, 29, 14, 17.6, color=BLUE)
arrow(18, 17.6, 18, 29, style=(0, (2.2, 1.6)), color=BLUE)
arrow(48, 29, 48, 17.6, style=(0, (2.2, 1.6)), color=GREEN)
arrow(82, 29, 82, 17.6, color=TEAL)
arrow(86, 17.6, 86, 29, style=(0, (2.2, 1.6)), color=TEAL)

fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
fig.savefig(os.path.join(OUT, "fig2-architecture.pdf"), format="pdf")
print("written", os.path.join(OUT, "fig2-architecture.pdf"))

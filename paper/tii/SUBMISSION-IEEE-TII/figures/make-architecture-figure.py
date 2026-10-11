# -*- coding: utf-8 -*-
"""System architecture figure for the TII manuscript (figure* span,
SCI/Origin-consistent styling: Arial, muted palette, thin rules).

Replaces the September HTML->PDF block diagram (Calibri, no source script)
with a reproducible matplotlib source matching fig-admission /
fig-process-campaign / fig-missions typography.

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

fig, ax = plt.subplots(figsize=(7.16, 2.28))
ax.set_xlim(0, 100)
ax.set_ylim(0, 100)
ax.axis("off")


def box(x, y, w, h, title, lines, color, tfs=6.6, bfs=5.8):
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0.6,rounding_size=1.2",
        facecolor="white", edgecolor=color, lw=0.9))
    ax.text(x + 2.2, y + h - 3.4, title, fontsize=tfs, weight="bold",
            color=color, va="top", ha="left")
    for i, ln in enumerate(lines):
        ax.text(x + 2.2, y + h - 9.4 - i * 5.6, ln, fontsize=bfs,
                color=DARK, va="top", ha="left")


def arrow(x0, y0, x1, y1, style="-", color=GREY, lw=0.9):
    ax.add_patch(FancyArrowPatch(
        (x0, y0), (x1, y1), arrowstyle="-|>", mutation_scale=7,
        linestyle=style, color=color, lw=lw, shrinkA=0, shrinkB=0))


# --- top band: entry surfaces -------------------------------------------
box(1, 84, 30, 14, "Operator UI / TUI + twin renderer",
    ["UI $\\rightarrow$ API writes; renderer displays state"], BLUE)
box(35, 84, 30, 14, "REST / WebSocket + A2A",
    ["shared authenticated entry points"], BLUE)
box(69, 84, 30, 14, "MCP interface",
    ["read-oriented subset; not all host tools"], BLUE)

# --- middle band: platform process --------------------------------------
ax.add_patch(FancyBboxPatch(
    (0.4, 30), 99.2, 47, boxstyle="round,pad=0.4,rounding_size=1.0",
    facecolor="#F4F7FA", edgecolor="#B9C6D2", lw=0.7))
ax.text(2.2, 73.2, "PLATFORM PROCESS", fontsize=6.0, weight="bold",
        color="#5A6B7A", va="top", ha="left")

box(2.5, 33, 29, 35, "Agent orchestrator",
    ["harness adapters $\\cdot$ team channels",
     "lead / workers $\\cdot$ tasks $\\cdot$ memory",
     "host tools + scoped dispatch",
     "shared node / team / run IDs"], BLUE)
box(35.5, 33, 29, 35, "Binding + approval bridge",
    ["node semantics $\\cdot$ read/write scope",
     "manual / auto policy $\\cdot$ approvals",
     "agent-write admission + readback",
     "records $\\cdot$ separate backstop"], GREEN)
box(68.5, 33, 29, 35, "Industrial supervisor",
    ["DAQ runtimes + gateway sweep",
     "DCW dispatch + protocol drivers",
     "alarms $\\cdot$ line / recipe / run state",
     "device-twin state publication"], TEAL)

arrow(31.7, 50.5, 35.3, 50.5, color=BLUE)
ax.text(33.5, 54.0, "intent", fontsize=5.4, color=BLUE, ha="center")
arrow(64.7, 50.5, 68.3, 50.5, color=GREEN)
ax.text(66.5, 54.0, "write", fontsize=5.4, color=GREEN, ha="center")
arrow(68.3, 40.5, 64.7, 40.5, style=(0, (2.2, 1.6)))
arrow(35.3, 40.5, 31.7, 40.5, style=(0, (2.2, 1.6)))

# --- bottom band: externals ---------------------------------------------
box(1, 6, 30, 14, "External CLI engines",
    ["separate processes; containment external"], BLUE)
box(35, 6, 30, 14, "Separate persistent stores",
    ["platform DB $\\cdot$ time series $\\cdot$ objects $\\cdot$ audit"], GREEN)
box(69, 6, 30, 14, "Plant / protocol boundary",
    ["physical devices or seeded scenarios"], TEAL)

# vertical flows
arrow(16, 84, 16, 68.4, color=GREY)
arrow(50, 84, 50, 68.4, color=GREY)
arrow(84, 84, 84, 68.4, color=GREY)
arrow(14, 33, 14, 20.4, color=BLUE)
arrow(18, 20.4, 18, 33, style=(0, (2.2, 1.6)))
arrow(48, 33, 48, 20.4, style=(0, (2.2, 1.6)))
ax.text(59, 25.2, "logical IDs; not atomic storage", fontsize=5.2,
        color=GREY, ha="left", va="center")
arrow(82, 33, 82, 20.4, color=TEAL)
arrow(86, 20.4, 86, 33, style=(0, (2.2, 1.6)), color=TEAL)

ax.text(0.4, 1.2, "solid: request / control   $\\cdot$   dashed: observation "
        "/ record flow   $\\cdot$   PLC safety and hard real-time control "
        "remain external", fontsize=5.2, color=GREY, ha="left", va="bottom")

fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
fig.savefig(os.path.join(OUT, "fig2-architecture.pdf"), format="pdf")
print("written", os.path.join(OUT, "fig2-architecture.pdf"))

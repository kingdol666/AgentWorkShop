# Graphical abstract for the Computers in Industry submission.
# Elsevier: minimum 1328 x 531 px (w x h), 300 dpi, readable at 5 x 13 cm.
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import os

plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans"],
    "font.size": 8.0,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
})

C1 = "#dbe9f6"; E1 = "#3b6ea5"
C2 = "#fdeeda"; E2 = "#c07f2d"
C3 = "#fde3e3"; E3 = "#c73e3e"
C4 = "#e2f2e4"; E4 = "#3f8a4f"

fig, ax = plt.subplots(figsize=(13.0/2.54, 5.0/2.54))
ax.set_xlim(0, 100); ax.set_ylim(0, 100); ax.axis("off")

def box(x, y, w, h, text, fc, ec, fs=8.0):
    ax.add_patch(FancyBboxPatch((x, y), w, h,
                 boxstyle="round,pad=0.012,rounding_size=0.04",
                 fc=fc, ec=ec, lw=1.1, mutation_aspect=1))
    ax.text(x + w/2, y + h/2, text, ha="center", va="center",
            fontsize=fs, linespacing=1.25)

def arrow(x1, y1, x2, y2):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>",
                                 mutation_scale=11, color="#444444", lw=1.2))

ax.text(50, 94, "Governing LLM-agent setpoint writes on production lines",
        ha="center", va="center", fontsize=9.5, weight="bold")

# Four-stage story (short labels to stay legible at 5 x 13 cm)
y, h, w = 52, 26, 22.5
xs = [1, 24.5, 48, 71.5]
box(xs[0], y, w, h, "Agent goal\n(LLM team)", C1, E1)
box(xs[1], y, w, h, "Binding\n+ 4-layer admission", C2, E2, fs=7.0)
box(xs[2], y, w, h, "Human approval\n+ recheck", C3, E3, fs=7.2)
box(xs[3], y, w, h, "Readback receipt\n+ ledger", C4, E4, fs=7.2)
for i in range(3):
    arrow(xs[i] + w, y + h/2, xs[i+1] - 0.6, y + h/2)

# Audit ledger band
box(2, 16, 96, 17,
    "Every verdict, rejection layer, approval, dispatch and receipt is journaled\n"
    "Attribution is separable from prevention: executed breaches remain recorded",
    "#f5f5f5", "#555555", fs=7.2)

for x in xs:
    arrow(x + w/2, y - 0.5, x + w/2, 33.8)

ax.text(50, 6, "No bypass from the agent surface: every plant-facing write crosses the same path",
        ha="center", va="center", fontsize=7.6, style="italic")

out = os.path.join(os.path.dirname(__file__), "graphical-abstract.png")
fig.savefig(out, dpi=300)
fig.savefig(out.replace(".png", ".pdf"))
plt.close(fig)
print("graphical abstract saved", out)

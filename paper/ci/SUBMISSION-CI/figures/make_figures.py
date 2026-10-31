# Generates the four vector figures for the Computers in Industry submission.
# All plotted numbers are taken from the frozen evidence artifacts; nothing invented.
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import os

plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans"],
    "font.size": 9,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
})

C_RUNTIME = "#dbe9f6"; C_RUNTIME_E = "#3b6ea5"
C_GOV     = "#fdeeda"; C_GOV_E     = "#c07f2d"
C_IND     = "#e2f2e4"; C_IND_E     = "#3f8a4f"
C_ENTRY   = "#f0e6f6"; C_ENTRY_E   = "#7a4fa3"
C_REJ     = "#c73e3e"

def box(ax, x, y, w, h, text, fc, ec, fs=9, weight="normal", lw=1.2):
    ax.add_patch(FancyBboxPatch((x, y), w, h,
                 boxstyle="round,pad=0.015,rounding_size=0.05",
                 fc=fc, ec=ec, lw=lw, mutation_aspect=1))
    ax.text(x + w/2, y + h/2, text, ha="center", va="center", fontsize=fs,
            weight=weight, linespacing=1.3)

def arrow(ax, x1, y1, x2, y2, color="#444444", lw=1.4, style="-|>", ls="-"):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle=style,
                                 mutation_scale=12, color=color, lw=lw, linestyle=ls))

def save(fig, name):
    fig.savefig(os.path.join(os.path.dirname(__file__), name),
                bbox_inches="tight", pad_inches=0.03)
    plt.close(fig)

# ---------------------------------------------------------------- Fig 1
fig, ax = plt.subplots(figsize=(5.6, 4.75))
ax.set_xlim(0, 100); ax.set_ylim(0, 100); ax.axis("off")

box(ax, 6, 90, 88, 9, "Entry points:  WebSocket (AEP)  ·  REST  ·  A2A  ·  MCP server",
    C_ENTRY, C_ENTRY_E, fs=9)
box(ax, 32, 77, 36, 8.5, "AgentChannelManager\n(single convergence point)", "#ffffff", "#555555", fs=9)
arrow(ax, 50, 90, 50, 86)

# collaboration runtime
box(ax, 1, 14, 30, 58, "", C_RUNTIME, C_RUNTIME_E, lw=1.6)
ax.text(16, 68.5, "Agent runtime", ha="center", fontsize=9.0, weight="bold")
box(ax, 3, 56.5, 26, 9, "Channels · agents\nmailboxes", "#ffffff", C_RUNTIME_E, fs=8.0)
box(ax, 3, 46, 26, 9, "Task engine\nroot queue · fencing", "#ffffff", C_RUNTIME_E, fs=8.0)
box(ax, 3, 35.5, 26, 9, "Process memory\nFTS5 + vector", "#ffffff", C_RUNTIME_E, fs=8.0)
box(ax, 3, 20, 26, 13.5, "Harness adapters (14)\nRPC · CLI", "#ffffff", C_RUNTIME_E, fs=8.0)

# governance block
box(ax, 35, 14, 30, 58, "", C_GOV, C_GOV_E, lw=1.8)
ax.text(50, 68.5, "Governance block", ha="center", fontsize=9.0, weight="bold")
for i, t in enumerate([
    "Operation catalog\nscope + policy",
    "Binding model\npoint · recipe",
    "Four-layer interval\nEq. (2)",
    "Step/rate limits\nbatch window",
    "Approval records\ntuple recheck",
    "Receipt grading\nRV / TA / UV",
]):
    y = 60 - i*7.2
    box(ax, 37, y, 26, 6.7, t, "#ffffff", C_GOV_E, fs=8.0)
box(ax, 37, 15.6, 26, 7.6, "Audit ledger\nevery rejection",
    "#fdf3f3", C_REJ, fs=8.0)

# industrial side
box(ax, 69, 14, 30, 58, "", C_IND, C_IND_E, lw=1.6)
ax.text(84, 68.5, "Industrial side", ha="center", fontsize=9.0, weight="bold")
box(ax, 71, 56.5, 26, 9, "DAQ gateway\nper-node runtimes", "#ffffff", C_IND_E, fs=8.0)
box(ax, 71, 46, 26, 9, "Write gateway\none in flight", "#ffffff", C_IND_E, fs=8.0)
box(ax, 71, 30.5, 26, 14, "Drivers\nModbus · OPC UA\nMQTT · HTTP · MES", "#ffffff", C_IND_E, fs=8.0)
box(ax, 71, 20, 26, 9, "Time-series store\nSQLite / Timescale", "#ffffff", C_IND_E, fs=8.0)

arrow(ax, 31, 45, 35, 45)
arrow(ax, 65, 56, 69, 60)
arrow(ax, 65, 30, 69, 50)
save(fig, "fig1-architecture.pdf")

# ---------------------------------------------------------------- Fig 2  (serpentine, 2 rows x 4 stages)
fig, ax = plt.subplots(figsize=(5.6, 3.3))
ax.set_xlim(0, 100); ax.set_ylim(0, 100); ax.axis("off")

BW, BH = 21.5, 21
r1y, r2y = 68, 30
xs = [2, 26.5, 51, 75.5]

row1 = [
    ("Agent request", "#ffffff", C_RUNTIME_E),
    ("Scope + policy\nchecks  Eq. (1)", C_RUNTIME, C_RUNTIME_E),
    ("Four-layer\ninterval\nEq. (2)", C_GOV, C_GOV_E),
    ("Step limit\nmin interval", C_GOV, C_GOV_E),
]
row2 = [  # drawn left-to-right but flow is right-to-left
    ("Driver write\nreadback\nRV/TA/UV", C_IND, C_IND_E),
    ("Dispatch\nrevalidation", "#fde3e3", C_REJ),
    ("Approval\nvalues · limits\nexpiry", "#fde3e3", C_REJ),
    ("Batch window\none in flight", C_GOV, C_GOV_E),
]

for x, (label, fc, ec) in zip(xs, row1):
    box(ax, x, r1y, BW, BH, label, fc, ec, fs=8.0)
for x, (label, fc, ec) in zip(xs, row2):
    box(ax, x, r2y, BW, BH, label, fc, ec, fs=8.0)

# serpentine arrows
for i in range(3):
    arrow(ax, xs[i] + BW, r1y + BH/2, xs[i+1] - 1.2, r1y + BH/2)
arrow(ax, xs[3] + BW/2, r1y, xs[3] + BW/2, r2y + BH + 1.2)          # down at right
for i in range(3, 0, -1):
    arrow(ax, xs[i] - 1.2, r2y + BH/2, xs[i-1] + BW + 1.2, r2y + BH/2)

# ledger band
box(ax, 2, 2, 95, 12,
    "Audit ledger — every verdict, approval,\ndispatch and receipt",
    "#f5f5f5", "#555555", fs=9)
for x in xs:
    arrow(ax, x + BW/2, r2y, x + BW/2, 15, color=C_REJ, lw=1.0, ls=(0, (2.5, 2.5)))
ax.annotate("human decision", xy=(xs[2] + BW/2 + 2, r2y + BH), xytext=(xs[2] - 6, r2y + BH + 12),
            fontsize=8.5, color=C_REJ, ha="center",
            arrowprops=dict(arrowstyle="-|>", color=C_REJ, lw=1.0))
save(fig, "fig2-writepath.pdf")

# ---------------------------------------------------------------- Fig 3
fig, axes = plt.subplots(1, 2, figsize=(5.6, 3.3))
arms = ["Full", "No interlock", "No readback", "Ungated"]
x = range(4)

ax = axes[0]
blocked = [18, 12, 18, 12]; executed = [0, 6, 0, 6]
ax.bar(x, blocked, width=0.6, color="#4a7db5", label="intercepted")
ax.bar(x, executed, width=0.6, bottom=blocked, color="#c73e3e",
       label="executed (journaled)")
for i in range(4):
    ax.text(i, blocked[i] + executed[i] + 0.6,
            f"{blocked[i]}/{blocked[i]+executed[i]}", ha="center", fontsize=9)
ax.set_xticks(list(x))
ax.set_xticklabels(arms, fontsize=8.0, rotation=30, ha="right")
ax.tick_params(axis="y", labelsize=9)
ax.set_ylabel("window-class attacks (18 per arm)", fontsize=9)
ax.set_ylim(0, 22)
ax.legend(fontsize=8.5, frameon=True, framealpha=1.0, edgecolor="#cccccc",
          loc="upper center", bbox_to_anchor=(0.5, -0.22), ncol=2)
ax.set_title("(a) Interception per arm", fontsize=10)
ax.spines[["top", "right"]].set_visible(False)

ax = axes[1]
ax.bar(x, [0.4]*4, width=0.6, color="#3f8a4f")
for i in range(4):
    ax.text(i, 0.44, "0", ha="center", fontsize=9.0, weight="bold", color="#3f8a4f")
ax.text(1.5, 0.62, "69 legitimate writes:\nzero false blocks in every arm",
        ha="center", fontsize=8.5)
ax.set_xticks(list(x))
ax.set_xticklabels(arms, fontsize=8.0, rotation=30, ha="right")
ax.tick_params(axis="y", labelsize=9)
ax.set_ylabel("false blocks", fontsize=9)
ax.set_ylim(0, 0.95); ax.set_yticks([0])
ax.set_title("(b) Governance cost (false blocks)", fontsize=10)
ax.spines[["top", "right"]].set_visible(False)

fig.tight_layout()
save(fig, "fig3-ablation.pdf")

# ---------------------------------------------------------------- Fig 4
fig, axes = plt.subplots(1, 2, figsize=(5.6, 2.55))

ax = axes[0]
vals = [6.42, 0.02]
bars = ax.bar(["before\noptimization", "final beat"], vals, width=0.5,
              color=["#b8b8b8", "#3f8a4f"])
for b, v in zip(bars, vals):
    ax.text(b.get_x() + b.get_width()/2, v + 0.18, f"{v}", ha="center", fontsize=10)
ax.annotate("99.7% reduction", xy=(0.5, 3.6), xytext=(0.28, 5.2), fontsize=9,
            arrowprops=dict(arrowstyle="-|>", lw=1.0))
ax.tick_params(axis="x", labelsize=9); ax.tick_params(axis="y", labelsize=9)
ax.set_ylabel("median quality error", fontsize=9)
ax.set_ylim(0, 7.4); ax.set_title("(a) Live closed loop (12 beats)", fontsize=10)
ax.spines[["top", "right"]].set_visible(False)

ax = axes[1]
vals = [94.8, 42.2]
bars = ax.bar(["model-driven\n(dynamic)", "static response\nsurface"], vals,
              width=0.5, color=["#4a7db5", "#b8b8b8"])
for b, v in zip(bars, vals):
    ax.text(b.get_x() + b.get_width()/2, v + 2, f"{v}%", ha="center", fontsize=10)
ax.tick_params(axis="x", labelsize=9); ax.tick_params(axis="y", labelsize=9)
ax.set_ylabel("success rate (%)", fontsize=9)
ax.set_ylim(0, 112); ax.set_title("(b) 20-seed paired comparison", fontsize=10)
ax.spines[["top", "right"]].set_visible(False)

fig.tight_layout()
save(fig, "fig4-modeltier.pdf")

print("figures regenerated")

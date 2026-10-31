"""Build publication figures from the single 2026-10-31 integrated run."""

from pathlib import Path
import csv

import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.patches import Patch


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "resources" / "current-run-data"
OUT = ROOT / "resources"

mpl.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "Liberation Serif", "Times"],
    "font.size": 8,
    "axes.labelsize": 8,
    "xtick.labelsize": 7.5,
    "ytick.labelsize": 7.5,
    "legend.fontsize": 7,
    "axes.linewidth": 0.8,
    "lines.linewidth": 1.5,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    "svg.fonttype": "none",
})

BLUE = "#356D9A"
INK = "#30343B"
GRID = "#D8DDE2"
BAND = "#DDEBE6"


def read_rows(path):
    with path.open(newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def save(fig, stem):
    fig.savefig(OUT / f"{stem}.pdf", bbox_inches="tight", facecolor="white")
    fig.savefig(OUT / f"{stem}.svg", bbox_inches="tight", facecolor="white")
    fig.savefig(OUT / f"{stem}.png", dpi=600, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def objective_figure():
    rows = read_rows(DATA / "p6-seeds.csv")
    x = list(range(len(rows)))
    y = [100.0 * float(row["Jend_over_Jstar"]) for row in rows]
    writes = [int(row["governed_writes"]) for row in rows]

    fig, ax = plt.subplots(figsize=(3.43, 2.20))
    for xi, yi, count in zip(x, y, writes):
        marker = "^" if count == 0 else "o"
        ax.scatter(xi, yi, s=43, marker=marker, color=BLUE, edgecolor="white",
                   linewidth=0.7, zorder=3)
        label_offset = (0, -16) if yi > 98.5 else (0, 8)
        label_va = "top" if yi > 98.5 else "bottom"
        ax.annotate(f"{yi:.1f}%", (xi, yi), xytext=label_offset,
                    textcoords="offset points", ha="center", va=label_va,
                    color=INK, fontsize=7.5)

    ax.axhline(100, color="#777777", linestyle=(0, (4, 2.5)), linewidth=1.0,
               zorder=1)
    ax.set_xlim(-0.45, len(rows) - 0.55)
    ax.set_ylim(90, 101.7)
    ax.set_xticks(x, [f"{row['seed']} ({writes[i]} writes)"
                      for i, row in enumerate(rows)])
    ax.set_yticks([90, 94, 98, 100])
    ax.set_xlabel("Simulator seed (governed writes)")
    ax.set_ylabel("Objective / reference (%)")
    ax.grid(axis="y", color=GRID, linewidth=0.65)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.tick_params(direction="out", length=3, width=0.7, colors=INK)
    fig.tight_layout(pad=0.35)
    save(fig, "fig-objective-ratios-current-run")


def bopet_figure():
    rows = read_rows(DATA / "bopet-trace.csv")
    x = [int(row["action_index"]) for row in rows]
    y = [float(row["thickness_um"]) for row in rows]
    labels = ["Initial", "After write 1", "After write 2", "After write 3"]

    fig, ax = plt.subplots(figsize=(3.43, 2.20))
    ax.axhspan(24.3, 25.7, color=BAND, alpha=0.9, zorder=0)
    ax.axhline(25.0, color="#658277", linestyle=(0, (3, 2)), linewidth=0.9,
               zorder=1)
    ax.plot(x, y, color=BLUE, marker="o", markersize=5.0,
            markerfacecolor="white", markeredgewidth=1.4, zorder=3)
    for i, (xi, yi) in enumerate(zip(x, y)):
        if i == 0:
            offset, ha = (8, 7), "left"
        else:
            offset, ha = (0, 9), "center"
        ax.annotate(f"{yi:.2f}", (xi, yi), xytext=offset,
                    textcoords="offset points", ha=ha, va="bottom",
                    color=INK, fontsize=7.5)

    ax.set_xlim(-0.12, 3.12)
    ax.set_ylim(24.0, 29.0)
    ax.set_xticks(x, labels)
    ax.set_yticks([24, 25, 26, 27, 28, 29])
    ax.set_xlabel("Scripted task state")
    ax.set_ylabel("Film thickness (µm)")
    ax.grid(axis="y", color=GRID, linewidth=0.65)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.tick_params(direction="out", length=3, width=0.7, colors=INK)
    ax.legend(handles=[Patch(facecolor=BAND, edgecolor="#9BB4A9",
                             label="Target band: 24.3–25.7 µm")],
              frameon=False, loc="upper right", borderaxespad=0.2)
    fig.tight_layout(pad=0.35)
    save(fig, "fig-bopet-integration-trace")


if __name__ == "__main__":
    objective_figure()
    bopet_figure()

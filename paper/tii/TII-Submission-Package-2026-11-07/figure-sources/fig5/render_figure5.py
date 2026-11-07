"""Render Figure 5 from the archived E6 pairs and guard-ablation records."""
from __future__ import annotations

import csv
import io
import json
import statistics
from pathlib import Path
from zipfile import ZipFile

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

PACKAGE = Path(__file__).resolve().parents[2]
DATA = Path(__file__).resolve().parent
EVIDENCE = PACKAGE / "supplementary" / "S7-e6-e7-2026-11-07.zip"
CORE = PACKAGE / "supplementary" / "S7-core.zip"
OUT = PACKAGE / "figures" / "fig5"

INK = "#202B34"
NAVY = "#23415A"
TEAL = "#167D86"
AMBER = "#B56B24"
GRID = "#D7DDE0"

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "Times", "DejaVu Serif"],
    "font.size": 9.0,
    "axes.labelsize": 9.0,
    "axes.titlesize": 9.2,
    "xtick.labelsize": 9.0,
    "ytick.labelsize": 9.0,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    "svg.fonttype": "none",
    "axes.linewidth": 0.7,
    "figure.facecolor": "white",
    "savefig.facecolor": "white",
})

with ZipFile(EVIDENCE) as archive:
    run = json.loads(archive.read("E6/confirmation/run.json"))
    blocks = run["blockRows"]
    paired = []
    for block in blocks:
        c0, c1 = block["arms"]["C0"], block["arms"]["C1"]
        if not (c0["valid"] and c1["valid"]):
            continue
        paired.append({
            "scene": block["scene"],
            "seed": int(block["seed"]),
            "delta_iae": float(c0["iae"]) - float(c1["iae"]),
        })

assert len(blocks) == 11 and len(paired) == 9
expected = {"injection": 3, "wwtp": 3, "anneal": 3}
assert {scene: sum(row["scene"] == scene for row in paired)
        for scene in expected} == expected
assert all(row["delta_iae"] > 0 for row in paired)
medians = {
    scene: statistics.median(row["delta_iae"] for row in paired
                             if row["scene"] == scene)
    for scene in expected
}
assert {scene: round(value, 3) for scene, value in medians.items()} == {
    "injection": 165.165,
    "wwtp": 615.605,
    "anneal": 8000.45,
}

with ZipFile(CORE) as archive:
    ablation = list(csv.DictReader(io.StringIO(
        archive.read("01-paper-evidence/process-window-ablation.csv")
        .decode("utf-8-sig"))))

arms = ["full", "no-interlock", "no-readback", "ungated"]
matrix: dict[tuple[str, int, str], bool] = {}
for arm in arms:
    for rep in (1, 2, 3):
        for kind in ("below-window", "above-window"):
            rows = [r for r in ablation if r["arm"] == arm
                    and int(r["rep"]) == rep and r["kind"] == kind]
            assert len(rows) == 1 and rows[0]["status"] in ("200", "400")
            matrix[arm, rep, kind] = rows[0]["status"] == "200"
counts = {
    arm: sum(matrix[arm, rep, kind] for rep in (1, 2, 3)
             for kind in ("below-window", "above-window"))
    for arm in arms
}
assert counts == {"full": 0, "no-interlock": 6,
                   "no-readback": 0, "ungated": 6}

fig = plt.figure(figsize=(7.16, 4.44))
fig.text(0.025, 0.975, "(a) Fixed-horizon process comparison",
         weight="bold", color=INK, fontsize=9.3, va="top")
fig.text(0.025, 0.941,
         "Delta IAE = IAE(C0) - IAE(C1); positive values favor the script. Horizontal scales are scene-specific.",
         color=INK, fontsize=9.0, va="top")

scenes = [
    ("injection", "Injection (g·s)", NAVY, (150, 202), [160, 180, 200]),
    ("wwtp", "Wastewater ((mg/L)·s)", TEAL, (600, 642), [600, 620, 640]),
    ("anneal", "Annealing (HV·s)", AMBER, (7850, 8160), [7900, 8000, 8100]),
]
grid = fig.add_gridspec(1, 3, left=0.075, right=0.985, bottom=0.705,
                        top=0.855, wspace=0.38)
for index, (scene, title, color, xlim, xticks) in enumerate(scenes):
    ax = fig.add_subplot(grid[0, index])
    rows = sorted((r for r in paired if r["scene"] == scene),
                  key=lambda r: r["seed"])
    y = list(range(len(rows)))
    x = [r["delta_iae"] for r in rows]
    median = statistics.median(x)
    ax.scatter(x, y, s=25, color=color, edgecolor=color, linewidth=0.7,
               zorder=3)
    ax.axvline(median, color=INK, linestyle=(0, (3, 2)), linewidth=0.8,
               zorder=2)
    ax.set_title(title, color=INK, weight="bold", pad=4)
    ax.set_xlim(*xlim)
    ax.set_xticks(xticks)
    ax.set_ylim(-0.55, 2.75)
    ax.set_yticks(y)
    ax.set_yticklabels([str(r["seed"]) for r in rows])
    ax.grid(axis="x", color=GRID, linewidth=0.5, zorder=0)
    ax.spines[["top", "right"]].set_visible(False)
    ax.tick_params(length=2.5, pad=2)
    if index == 0:
        ax.set_ylabel("Seed", labelpad=2)
    else:
        ax.spines["left"].set_visible(False)
        ax.tick_params(axis="y", length=0)

fig.text(0.025, 0.625,
         "Points: valid pairs; dashed lines: scene medians. Invalid C0 gaps: wastewater seed 45 (9 s), annealing seed 46 (6 s).",
         fontsize=9.0, color=INK, va="center")
fig.text(0.025, 0.585,
         "Separate injection seed-43 pilot (ΔIAE = 163.240 g·s) is not plotted.",
         fontsize=9.0, color=INK, va="center")

fig.text(0.025, 0.535, "(b) Process-window guard ablation",
         weight="bold", color=INK, fontsize=9.3, va="center")
fig.text(0.025, 0.505,
         "Three technical repetitions per arm; benchmark mode.",
         fontsize=9.0, color=INK, va="center")

ax = fig.add_axes([0.025, 0.115, 0.95, 0.32])
ax.set(xlim=(0, 1), ylim=(0, 1))
ax.axis("off")
centers = [0.445, 0.51, 0.61, 0.675, 0.775, 0.84]
for rep in range(3):
    ax.text((centers[2 * rep] + centers[2 * rep + 1]) / 2, 0.97,
            f"Rep. {rep + 1}", ha="center", va="top", fontsize=9.0,
            color=INK)
    for offset, label in enumerate(("Below", "Above")):
        ax.text(centers[2 * rep + offset], 0.78, label,
                ha="center", va="center", fontsize=9.0, color=INK)
ax.text(0.995, 0.78, "HTTP 200 / 6", ha="right", va="center",
        fontsize=9.0, color=INK)
labels = ["Full guard", "Window check removed",
          "Readback check removed", "Window + readback removed"]
ys = [0.60, 0.43, 0.26, 0.09]
for y, arm, label in zip(ys, arms, labels):
    ax.text(0, y, label, ha="left", va="center", fontsize=9.0, color=INK)
    for rep in (1, 2, 3):
        for kind_index, kind in enumerate(("below-window", "above-window")):
            accepted = matrix[arm, rep, kind]
            x = centers[(rep - 1) * 2 + kind_index]
            ax.scatter(x, y, s=24, marker="s" if accepted else "o",
                       facecolors=AMBER if accepted else "white",
                       edgecolors=AMBER if accepted else NAVY,
                       linewidths=0.9, zorder=2)
    ax.text(0.985, y, f"{counts[arm]}/6", ha="right", va="center",
            fontsize=9.0, color=INK)

fig.text(0.025, 0.070,
         "Open circle: HTTP 400 (rejected)  |  filled square: HTTP 200",
         fontsize=9.0, color=INK, va="center")
fig.text(0.025, 0.038,
         "No readback-mismatch stimulus was included; HTTP status does not prove a driver call.",
         fontsize=9.0, color=INK, va="center")

OUT.parent.mkdir(parents=True, exist_ok=True)
for ext in ("pdf", "svg", "png"):
    target = OUT.with_suffix(f".{ext}")
    fig.savefig(target, **({"dpi": 600} if ext == "png" else {}))
    if ext == "svg":
        content = target.read_text(encoding="utf-8")
        target.write_text("\n".join(line.rstrip() for line in content.splitlines())
                          + "\n", encoding="utf-8")
plt.close(fig)

with (DATA / "paired-delta.csv").open("w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=["scene", "seed", "delta_iae"])
    writer.writeheader()
    writer.writerows(paired)
with (DATA / "window_ablation.csv").open("w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=["arm", "rep", "kind", "status"],
                            extrasaction="ignore")
    writer.writeheader()
    writer.writerows(r for r in ablation
                     if r["kind"] in ("below-window", "above-window"))

print("Verified 11 E6 confirmation attempts, 9 valid paired deltas, and guard counts:", counts)

#!/usr/bin/env python3
"""Plot single post-trial simulator probes from six R20 harness tasks.

Task numbers indicate execution order within each shared simulator, not elapsed
time or independent replication. Candidate setpoints and receipt status come
from application records. Synthetic approvals and SQLite fallback are part of
the test setup; the provider's raw request/response was not retained.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from matplotlib.ticker import MaxNLocator

HERE = Path(__file__).resolve().parent
PAPER = HERE.parent
SOURCE = PAPER / "Supplementary-evidence-2026-10-27" / "real-harness"
OUT = PAPER / "resources" / "fig-r20-origin"

plt.rcParams.update({
    "font.family": "sans-serif", "font.sans-serif": ["Arial", "DejaVu Sans"],
    "font.size": 8.5, "axes.labelsize": 8.5, "axes.titlesize": 9.5,
    "xtick.labelsize": 8.0, "ytick.labelsize": 8.0, "legend.fontsize": 8.0,
    "axes.linewidth": 0.7, "xtick.major.width": 0.7, "ytick.major.width": 0.7,
    "xtick.major.size": 3, "ytick.major.size": 3, "pdf.fonttype": 42,
    "ps.fonttype": 42, "svg.fonttype": "none", "legend.frameon": False,
    "savefig.facecolor": "white",
})

SPECS = {
    "cast-film": {"title": "(a) Cast film", "ylabel": "Film thickness (µm)",
                  "band": (48.0, 52.0), "ylim": (44.4, 53.0), "unit": "rpm"},
    "annealing": {"title": "(b) Continuous annealing", "ylabel": "Strip temperature (°C)",
                  "band": (700.0, 760.0), "ylim": (673.0, 766.0), "unit": "°C"},
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=SOURCE, help="directory with R20 evidence CSV and JSON")
    parser.add_argument("--output", type=Path, default=OUT, help="output prefix without extension")
    parser.add_argument("--audit-dir", type=Path, default=Path(os.environ.get(
        "NATURE_FIGURE_AUDIT_DIR", str(Path.home() / ".codex" / "skills" / "nature-figure" / "scripts"))),
        help="directory containing audit_panel_alignment.py")
    args = parser.parse_args()
    sys.path.insert(0, str(args.audit_dir))
    try:
        from audit_panel_alignment import require_matplotlib_panel_alignment
    except ModuleNotFoundError as exc:
        if exc.name != "audit_panel_alignment":
            raise
        from figure_layout import require_matplotlib_panel_alignment
    output = args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    with (args.data_dir / "R20-TRACE-SUMMARY.csv").open(encoding="utf-8", newline="") as f:
        samples = {r["execution_key"]: r for r in csv.DictReader(f)}
    evidence = json.loads((args.data_dir / "R20-EVIDENCE-PROJECTION.json").read_text(encoding="utf-8"))
    assert len(samples) == len(evidence["runs"]) == 6
    fig, axes = plt.subplots(1, 2, figsize=(7.16, 2.8))
    fig.subplots_adjust(left=0.09, right=0.985, top=0.89, bottom=0.28, wspace=0.32)
    for ax, (scene, spec) in zip(axes, SPECS.items()):
        runs = sorted((r for r in evidence["runs"] if r["scene"] == scene),
                      key=lambda r: r["repetition"])
        assert len(runs) == 3 and [r["repetition"] for r in runs] == [1, 2, 3]
        values = [float(samples[r["id"]]["sample_value"]) for r in runs]
        assert all(r["candidate"] in r["candidateChoices"] for r in runs)
        assert all(v < spec["band"][0] for v in values)
        lo, hi = spec["band"]
        ax.axhspan(lo, hi, color="#DCEADF", zorder=0)
        ax.axhline(lo, color="#729886", lw=0.55, ls="--", zorder=1)
        ax.axhline(hi, color="#729886", lw=0.55, ls="--", zorder=1)
        ax.plot([1, 2, 3], values, linestyle="none", marker="o", ms=5,
                mfc="#174A72", mec="white", mew=0.45, zorder=4)
        for x, value in enumerate(values, 1):
            ax.annotate(f"{value:.2f}" if scene == "cast-film" else f"{value:.1f}",
                        (x, value), xytext=(0, 6), textcoords="offset points",
                        ha="center", va="bottom", fontsize=8)
        ax.set_xticks([1, 2, 3], [f"{r['repetition']}\n{r['candidate']} {spec['unit']}" for r in runs])
        ax.set_xlim(0.55, 3.45)
        ax.set_ylim(*spec["ylim"])
        ax.yaxis.set_major_locator(MaxNLocator(nbins=4))
        ax.set_title(spec["title"], loc="left", fontweight="bold", pad=4)
        ax.set_ylabel(spec["ylabel"], labelpad=3)
        ax.set_xlabel("Task order (selected setpoint)", labelpad=4)
        ax.tick_params(direction="in", top=True, right=True, pad=3)
        for spine in ax.spines.values():
            spine.set_visible(True)
    fig.legend(handles=[Patch(facecolor="#DCEADF", edgecolor="#729886", label="Target band"),
                        Line2D([], [], color="#174A72", marker="o", ls="none", ms=5,
                               label="Single post-trial probe")],
               loc="lower center", ncol=2, bbox_to_anchor=(0.5, 0.015),
               handlelength=1.0, handletextpad=0.5, columnspacing=1.2)
    fig.canvas.draw()
    require_matplotlib_panel_alignment(
        fig, json_out=str(output) + ".alignment.json", overlay_svg=str(output) + ".alignment.svg",
        tolerance_pt=1.5, gutter_tolerance_pt=1.5, strict=True)
    for ext in ("pdf", "svg"):
        fig.savefig(output.with_suffix("." + ext), facecolor="white")
    fig.savefig(output.with_suffix(".png"), dpi=600, facecolor="white")
    plt.close(fig)
    print(f"Wrote {output}.pdf, .svg, and .png")


if __name__ == "__main__":
    main()

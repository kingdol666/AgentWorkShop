#!/usr/bin/env python3
"""Rebuild the archived display of current-version route evidence.

The plotted response is a single post-trial sample for each recorded route
execution. No route means, uncertainty intervals, or temporal trend lines are
estimated. The three model-mediated observations per scene are sequential
samples from one simulator instance; horizontal offsets only separate markers.
This diagnostic plot is retained for reproducibility and is not a numbered
figure in the current manuscript.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

ROOT = Path(__file__).resolve().parents[1]
ZIP_PATH = ROOT / "Supplementary-File-S1.zip"
DATA_DIR = ROOT / "resources" / "figure-source-data"
OUT = ROOT / "resources" / "fig-current-route-results"

TARGETS = {
    "cast-film": {"min": 48.0, "max": 52.0, "unit": "µm", "label": "Cast-film thickness (µm)"},
    "annealing": {"min": 700.0, "max": 760.0, "unit": "°C", "label": "Annealing-strip temperature (°C)"},
}
ROUTES = {
    "R20": {"key": "model-mediated", "label": "Model task", "color": "#0072B2", "marker": "o"},
    "R21": {"key": "fixed-call", "label": "Fixed-call", "color": "#E69F00", "marker": "s"},
    "R22": {"key": "direct-rest", "label": "REST call", "color": "#009E73", "marker": "D"},
    "R23": {"key": "cli-adapter", "label": "CLI task", "color": "#CC79A7", "marker": "^"},
}

def read_csv(zf: zipfile.ZipFile, name: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(zf.read(name).decode("utf-8-sig"))))

def make_row(route: str, scene: str, value: float, lo: float, hi: float,
             sequence: int, delay_s: int, source: str) -> dict[str, object]:
    return {
        "evidence_group": route,
        "route_key": ROUTES[route]["key"],
        "scene": scene,
        "sample_sequence": sequence,
        "sample_value": value,
        "unit": TARGETS[scene]["unit"],
        "target_min": lo,
        "target_max": hi,
        "post_trial_delay_seconds": delay_s,
        "source_archive_path": source,
    }

def extract_observations() -> list[dict[str, object]]:
    if not ZIP_PATH.exists():
        raise FileNotFoundError(f"Evidence archive not found: {ZIP_PATH}")
    rows: list[dict[str, object]] = []
    with zipfile.ZipFile(ZIP_PATH) as zf:
        # R20 supplies exact samples in its trace matrix and target bands in
        # each model decision record.
        exp20 = json.loads(zf.read("revision-2026-10-25/R20/evidence.json"))["experiment"]
        target20 = {run["id"]: run["modelDecision"]["targetBand"]
                    for run in exp20["runOutcomes"]}
        for r in read_csv(zf, "revision-2026-10-25/R20/R20-TRACE-MATRIX.csv"):
            run_id = r["execution_key"]
            scene = "cast-film" if run_id.startswith("cast-film-") else "annealing"
            lo, hi = target20[run_id]
            sequence = int(run_id.rsplit("r", 1)[1])
            rows.append(make_row("R20", scene, float(r["sample_value"]), lo, hi,
                                 sequence, 20,
                                 "revision-2026-10-25/R20/R20-TRACE-MATRIX.csv"))

        # R21 does not duplicate target metadata; use the two explicit scene
        # bands from the experimental protocol.
        for r in read_csv(zf, "revision-2026-10-25/R21/R21-TRACE-MATRIX.csv"):
            band = TARGETS[r["scene"]]
            rows.append(make_row("R21", r["scene"], float(r["sample_value"]),
                                 band["min"], band["max"], 1, 20,
                                 "revision-2026-10-25/R21/R21-TRACE-MATRIX.csv"))

        # Direct REST records both the sample and its target band.
        exp22 = json.loads(zf.read("revision-2026-10-25/R22/evidence.json"))["experiment"]
        for scene_data in exp22["scenes"]:
            obs = scene_data["observation"]
            band = obs["targetBand"]
            rows.append(make_row("R22", scene_data["id"], float(obs["value"]),
                                 band["min"], band["max"], 1,
                                 int(obs["postTrialDelaySeconds"]),
                                 "revision-2026-10-25/R22/evidence.json"))

        # R23 records exact sample and target values in its trace matrix.
        for r in read_csv(zf, "revision-2026-10-25/R23/R23-TRACE-MATRIX.csv"):
            rows.append(make_row("R23", r["scene"], float(r["sample_value"]),
                                 float(r["target_min"]), float(r["target_max"]),
                                 1, 20,
                                 "revision-2026-10-25/R23/R23-TRACE-MATRIX.csv"))

    if len(rows) != 12:
        raise ValueError(f"Expected 12 current route observations, found {len(rows)}")
    if {r["scene"] for r in rows} != set(TARGETS):
        raise ValueError("Evidence does not contain both configured simulator scenes")
    if any(float(r["target_min"]) != TARGETS[str(r["scene"])]["min"] or
           float(r["target_max"]) != TARGETS[str(r["scene"])]["max"] for r in rows):
        raise ValueError("The source target bands differ across route evidence")
    return rows

def write_source_data(rows: list[dict[str, object]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = DATA_DIR / "current-route-observations.csv"
    fields = list(rows[0])
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    archive_hash = hashlib.sha256(ZIP_PATH.read_bytes()).hexdigest()
    metadata = {
        "figure": "Fig. 5: current-version route-linked process samples",
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "source_archive": "Supplementary-File-S1.zip",
        "source_archive_sha256": archive_hash,
        "source_entries": sorted({str(r["source_archive_path"]) for r in rows}),
        "transform": "Plot each raw process sample in its recorded unit; no aggregation or vertical jitter",
        "display_only_adjustment": "The three sequential model-mediated samples per scene receive small arbitrary horizontal offsets only to separate markers; offsets do not represent elapsed time or run order.",
        "sample_count": len(rows),
        "independent_process_replicates": 0,
        "target_bands": TARGETS,
        "csv": csv_path.name,
    }
    (DATA_DIR / "current-route-observations.json").write_text(
        json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

def draw(rows: list[dict[str, object]]) -> None:
    font_manager.findfont("Arial", fallback_to_default=False)
    matplotlib.rcParams.update({
        "font.family": "Arial", "font.size": 9.0, "axes.labelsize": 9.0,
        "axes.titlesize": 10.0, "xtick.labelsize": 9.0, "ytick.labelsize": 9.0,
        "pdf.fonttype": 42, "ps.fonttype": 42, "svg.fonttype": "none",
        "axes.linewidth": 0.8, "savefig.facecolor": "white",
    })
    fig, axes = plt.subplots(1, 2, figsize=(7.16, 3.05), sharey=False)
    route_order = list(ROUTES)
    jitter = {"R20": (-0.12, 0.12, 0.0), "R21": (0.0,), "R22": (0.0,), "R23": (0.0,)}
    axis_ranges = {"cast-film": (44.0, 54.0), "annealing": (665.0, 770.0)}
    axis_ticks = {"cast-film": [44, 46, 48, 50, 52, 54],
                  "annealing": [670, 700, 730, 760]}

    for ax, scene in zip(axes, ("cast-film", "annealing")):
        subset = [r for r in rows if r["scene"] == scene]
        lo, hi = TARGETS[scene]["min"], TARGETS[scene]["max"]
        ax.axhspan(lo, hi, facecolor="#E5EEF2", edgecolor="none",
                   alpha=1.0, zorder=0)
        ax.axhline(hi, color="#455A64", linewidth=0.9, linestyle=(0, (4, 2)), zorder=1)
        ax.axhline(lo, color="#455A64", linewidth=1.0, linestyle=(0, (4, 2)), zorder=1)
        ax.axhline((lo + hi) / 2, color="#7A858A", linewidth=0.75,
                   linestyle=":", zorder=1)
        for i, route in enumerate(route_order):
            group = sorted((r for r in subset if r["evidence_group"] == route),
                           key=lambda r: float(r["sample_value"]))
            offsets = jitter[route]
            if len(group) != len(offsets):
                raise ValueError(f"Unexpected sample count for {route}/{scene}: {len(group)}")
            for r, dx in zip(group, offsets):
                ax.scatter(i + dx, float(r["sample_value"]),
                           s=56, marker=ROUTES[route]["marker"],
                           facecolor=ROUTES[route]["color"], edgecolor="#20282C",
                           linewidth=0.75, zorder=3)
        ax.set_xlim(-0.48, len(route_order) - 0.52)
        ax.set_ylim(*axis_ranges[scene])
        ax.set_yticks(axis_ticks[scene])
        ax.set_xticks(range(len(route_order)))
        ax.set_xticklabels([ROUTES[r]["label"] for r in route_order], linespacing=1.12)
        panel_title = "Cast-film process" if scene == "cast-film" else "Annealing process"
        ax.set_title(panel_title, loc="left", pad=8, fontweight="bold")
        ax.grid(axis="y", color="#D8DEE2", linewidth=0.55, zorder=0)
        ax.tick_params(axis="both", length=3, width=0.7, color="#59656B", pad=4)
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        ax.spines["left"].set_color("#68747A")
        ax.spines["bottom"].set_color("#68747A")
        band_y = (hi - 0.18 * (hi - lo) - axis_ranges[scene][0]) / (axis_ranges[scene][1] - axis_ranges[scene][0])
        ax.text(0.98, band_y, "Target band", transform=ax.transAxes,
                ha="right", va="top", fontsize=9, color="#33434B",
                bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.82, "pad": 1.2})

    axes[0].set_ylabel("Thickness (µm)")
    axes[1].set_ylabel("Strip temperature (°C)")
    fig.subplots_adjust(left=0.09, right=0.99, bottom=0.16, top=0.88, wspace=0.34)
    for ext in ("pdf", "svg", "png"):
        fig.savefig(OUT.with_suffix(f".{ext}"), dpi=600 if ext == "png" else None,
                    bbox_inches="tight", pad_inches=0.08)
    plt.close(fig)

def main() -> None:
    rows = extract_observations()
    if not all(math.isfinite(float(r["sample_value"])) for r in rows):
        raise ValueError("Non-finite plotted data")
    if not all(float(r["sample_value"]) < float(r["target_min"]) for r in rows):
        raise ValueError("Expected all current route samples to be below target")
    write_source_data(rows)
    draw(rows)
    print(f"Wrote {OUT.with_suffix('.pdf')} from {len(rows)} observations")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Rebuild Fig. 5 (four-scenario optimization record) from packaged data.

Reads only ``resources/figure-source-data/source-data-missions.json`` and writes
``resources/fig-missions-controls.{pdf,svg,png}``. The layout is the four-column
form used in the manuscript: the upper row shows process-variable observations
against each scenario's target band; the lower row shows requested set-point
changes as percentages of the baseline. Event indices give order, not elapsed
time. All type is 9 pt Arial and the PDF/SVG are vector, so the figure passes the
IEEE TII figure gate (>= 8 pt, Arial, <= 260 pt tall, no raster).
"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator

HERE = Path(__file__).resolve().parent
PAPER = HERE.parent
RESOURCES = PAPER / "resources"
SOURCE = RESOURCES / "figure-source-data" / "source-data-missions.json"

BLUE, ORANGE, GREEN, DARK, LIGHT = "#245D85", "#B96A22", "#37816F", "#262626", "#EAF1ED"
plt.rcParams.update({
    "font.family": "sans-serif", "font.sans-serif": ["Arial", "DejaVu Sans"],
    "font.size": 9, "axes.labelsize": 9, "axes.titlesize": 9,
    "xtick.labelsize": 9, "ytick.labelsize": 9, "legend.fontsize": 9,
    "axes.linewidth": 0.6, "lines.linewidth": 1.0,
    "xtick.major.width": 0.6, "ytick.major.width": 0.6,
    "xtick.major.size": 2.5, "ytick.major.size": 2.5,
    "axes.spines.top": False, "axes.spines.right": False,
    "pdf.fonttype": 42, "ps.fonttype": 42, "svg.fonttype": "none",
    "legend.frameon": False, "savefig.facecolor": "white",
})

IDS = ["injection", "wwtp", "anneal", "biax"]
NAMES = ["Injection molding", "Wastewater", "Annealing", "BOPET film"]
QUANTITY = ["Weight (g)", "DO (mg/L)", "Hardness (HV)", "Thickness (µm)"]
CONTROLS = {
    "injection": [("hold-pressure-sp", "Pressure", BLUE, "o"),
                  ("hold-time-sp", "Hold time", ORANGE, "s")],
    "wwtp": [("blower-hz-sp", "Blower", BLUE, "o"),
             ("naoh-dose-sp", "NaOH", ORANGE, "s"),
             ("pac-dose-sp", "PAC", GREEN, "^")],
    "anneal": [("zone3-sp", "Zone 3", BLUE, "o"),
               ("zone2-sp", "Zone 2", ORANGE, "s"),
               ("line-speed-sp", "Line speed", GREEN, "^")],
    "biax": [("cast-spd-sp", "Casting", BLUE, "o"),
             ("fast-roll-sp", "Fast roll", ORANGE, "s"),
             ("rail-out-sp", "Rail width", GREEN, "^")],
}
UNITS = {"hold-pressure-sp": "bar", "hold-time-sp": "s", "blower-hz-sp": "Hz",
         "naoh-dose-sp": "L/h", "pac-dose-sp": "L/h", "zone3-sp": "°C",
         "zone2-sp": "°C", "line-speed-sp": "m/min", "cast-spd-sp": "m/min",
         "fast-roll-sp": "m/min", "rail-out-sp": "mm"}
SHORT = {"hold-pressure-sp": "Pressure", "hold-time-sp": "Time",
         "blower-hz-sp": "Blower", "naoh-dose-sp": "NaOH", "pac-dose-sp": "PAC",
         "zone3-sp": "Z3", "zone2-sp": "Z2", "line-speed-sp": "Speed",
         "cast-spd-sp": "Cast", "fast-roll-sp": "Roll", "rail-out-sp": "Rail"}


def tag(ax, label):
    ax.text(0, 1.08, "(" + label + ")", transform=ax.transAxes,
            va="bottom", ha="left", fontsize=9, fontweight="bold")
    ax.tick_params(direction="out")
    ax.xaxis.set_major_locator(MaxNLocator(integer=True, nbins=5))


def band(ax, target, tol):
    ax.axhspan(target - tol, target + tol, color=LIGHT, zorder=0)
    ax.axhline(target - tol, color=GREEN, linewidth=0.5, linestyle=":")
    ax.axhline(target + tol, color=GREEN, linewidth=0.5, linestyle=":")
    ax.axhline(target, color=GREEN, linewidth=0.6, linestyle="--")


def load():
    data = json.loads(SOURCE.read_text(encoding="utf-8-sig"))
    missions = {m["id"]: m for m in data["raw_results"]}
    return missions, data["controls"]


def build():
    missions, events = load()
    fig, axs = plt.subplots(2, 4, figsize=(7.16, 3.55))
    fig.subplots_adjust(left=.075, right=.99, bottom=.26, top=.84, wspace=.65, hspace=.95)
    for column, mission_id in enumerate(IDS):
        mission = missions[mission_id]
        trajectory = mission["mission"]["traj"]
        mission_events = [e for e in events if e["mission"] == mission_id]

        ax = axs[0, column]
        tag(ax, chr(97 + column))
        band(ax, mission["pv"]["target"], mission["pv"]["tol"])
        if mission_id == "wwtp":
            y = [r["pv"] for r in trajectory if r["phase"] in ("baseline", "blower")]
            x = list(range(len(y)))
        else:
            y = [r["pv"] for r in trajectory]
            x = list(range(len(y)))
        last_event = max(e["event"] for e in mission_events)
        ax.plot(x, y, "o-", color=BLUE, ms=3, mfc="white")
        if mission_id == "anneal":
            ax.plot([5], [101.3], marker="x", color=ORANGE, ms=4, linestyle="none")
            ax.plot([1], [y[1]], marker="^", color=DARK, mfc="white", ms=5, linestyle="none")
        ax.plot([last_event], [mission["mission"]["final"]], marker="s", color=DARK,
                ms=3.5, linestyle="none")
        all_y = y + [mission["mission"]["final"],
                     mission["pv"]["target"] - mission["pv"]["tol"],
                     mission["pv"]["target"] + mission["pv"]["tol"]]
        lo, hi = min(all_y), max(all_y)
        span = hi - lo
        ax.set_ylim(lo - .10 * span, hi + .18 * span)
        ax.set_xlim(-.4, last_event + .6)
        ax.set_ylabel(QUANTITY[column], labelpad=1)
        ax.set_title(NAMES[column], pad=20)
        ax.set_xlabel("")

        ax = axs[1, column]
        tag(ax, chr(101 + column))
        ax.axhline(0, color="#888888", lw=.5, ls=":")
        for knob, label, color, marker in CONTROLS[mission_id]:
            selected = [e for e in mission_events if e["knob"] == knob]
            base = selected[0]["from"]
            current = base
            xs, ys = [0], [0.]
            for event in mission_events:
                if event["knob"] == knob:
                    current = event["to"]
                xs.append(event["event"])
                ys.append(100. * (current - base) / base)
            ax.step(xs, ys, where="post", color=color, lw=.85,
                    ls="--" if marker == "s" else "-", label=label)
            for event in selected:
                ax.plot([event["event"]], [100. * (event["to"] - base) / base],
                        marker="x" if event["kind"] == "reverted candidate" else marker,
                        ms=3.2, mfc="white", mec=color, color=color, linestyle="none")
        ax.set_xlim(-.4, last_event + .6)
        y0, y1 = ax.get_ylim()
        ax.set_ylim(min(-2, y0), y1 + (y1 - y0) * .55)
        ax.set_ylabel("Request change (%)", labelpad=1)
        ax.set_xlabel("Control event index", labelpad=1)
        ax.legend(loc="lower left", bbox_to_anchor=(.14, .95), fontsize=9,
                  handlelength=.8, borderpad=.1, labelspacing=.15, handletextpad=.3)

    for column, mission_id in enumerate(IDS):
        native = []
        for knob, _, _, _ in CONTROLS[mission_id]:
            selected = [e for e in events if e["mission"] == mission_id and e["knob"] == knob]
            native.append(f"{SHORT[knob]} {selected[0]['from']:g} → {selected[-1]['to']:g} {UNITS[knob]}")
        position = axs[1, column].get_position()
        fig.text(.98 if column == 3 else (position.x0 + position.x1) / 2, .015,
                 "\n".join(native), ha="right" if column == 3 else "center",
                 va="bottom", fontsize=9, linespacing=1.12)

    for extension in ("pdf", "svg"):
        fig.savefig(RESOURCES / ("fig-missions-controls." + extension))
    fig.savefig(RESOURCES / "fig-missions-controls.png", dpi=600)
    plt.close(fig)


if __name__ == "__main__":
    build()
    print("Wrote", RESOURCES / "fig-missions-controls.pdf")

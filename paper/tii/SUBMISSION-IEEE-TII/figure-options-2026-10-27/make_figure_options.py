#!/usr/bin/env python3
"""Draw three evidence-bounded figure alternatives using the archived data.

Run: python make_figure_options.py [--data-root ../Supplementary-evidence-2026-10-27]
The plotting style starts from figure-generation's line template. No data are
simulated or interpolated; dotted connectors show record order/pairing only.
"""
from pathlib import Path
import argparse
import csv
import json
import re

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch

HERE = Path(__file__).resolve().parent
DEFAULT_DATA = HERE.parent / "Supplementary-evidence-2026-10-27"
BLUE = "#17628C"
ORANGE = "#A44E19"
GRAY = "#555C63"
BAND = "#E5EBEF"
BAND_EDGE = "#8095A5"

plt.rcParams.update({
    "font.family": "sans-serif", "font.sans-serif": ["Arial", "DejaVu Sans"],
    "font.size": 8.5, "axes.labelsize": 9, "xtick.labelsize": 8,
    "ytick.labelsize": 8, "legend.fontsize": 8, "axes.linewidth": 0.8,
    "xtick.direction": "in", "ytick.direction": "in",
    "xtick.top": True, "ytick.right": True, "xtick.major.size": 3,
    "ytick.major.size": 3, "savefig.dpi": 350, "pdf.fonttype": 42,
    "ps.fonttype": 42, "figure.facecolor": "white", "axes.facecolor": "white",
})


def save(fig, stem):
    for ext in ("png", "pdf", "svg"):
        fig.savefig(HERE / f"{stem}.{ext}", dpi=350, facecolor="white")
    plt.close(fig)


def legend_band():
    return Patch(facecolor=BAND, edgecolor=BAND_EDGE, linewidth=.8, label="Target band")


def load_data(root):
    mission = json.loads((root / "four-missions/figure-data/four-scenario-2026-09-28.json").read_text(encoding="utf-8"))
    with (root / "real-harness/R20-TRACE-SUMMARY.csv").open(encoding="utf-8", newline="") as f:
        probes = {row["execution_key"]: float(row["sample_value"]) for row in csv.DictReader(f)}
    # Pre-task values are explicitly transcribed in the overview table; extract
    # them from that table so the figure remains linked to the archival source.
    overview = (root / "EVIDENCE-OVERVIEW.md").read_text(encoding="utf-8")
    rows = re.findall(r"^\| (Cast film|Annealing) ([123]) \| ([\d.]+) (?:μm|°C) \|", overview, re.MULTILINE)
    pre = {("cast-film" if s == "Cast film" else "annealing") + "-r" + n: float(v) for s,n,v in rows}
    if len(pre) != 6 or len(probes) != 6 or pre.keys() != probes.keys():
        raise ValueError("Expected exactly six matching R20 pre-task and probe records")
    return mission["scenarios"], pre, probes


def missions_plot(scenarios):
    fig, axs = plt.subplots(2, 2, figsize=(7.16, 4.35))
    fig.subplots_adjust(left=.087, right=.99, top=.93, bottom=.16, hspace=.55, wspace=.30)
    titles = ["(a) Injection molding", "(b) BOPET film", "(c) Continuous annealing", "(d) A2O wastewater"]
    ylabels = ["Part weight (g)", "Film thickness (µm)", "Hardness (HV)", "Dissolved oxygen (mg/L)"]
    limits = [(31.0, 33.0), (23.9, 28.6), (84, 139), (-.15, 4.5)]
    ticklabels = [["Start", "Pressure", "Time", "Pressure"],
                  ["Start", "Cast", "Roll", "Rail", "Cast"],
                  ["Start", "Zone 2", "Speed", "Revert", "Final"],
                  ["Start", "Air 1", "Air 2", "Air 3", "Air 4", "Air 5", "Final"]]
    for ax, s, title, yl, ylim, ticks in zip(axs.flat, scenarios, titles, ylabels, limits, ticklabels):
        band = s["target"]
        ax.axhspan(band["lower"], band["upper"], facecolor=BAND, edgecolor=BAND_EDGE, linewidth=.6, zorder=0)
        points = [p for p in s["points"] if p["recorded"]]
        ax.plot([p["order"] for p in points], [p["value"] for p in points],
                linestyle=(0,(2.2,1.8)), linewidth=1, marker="o", markersize=4.5,
                color=BLUE, markerfacecolor=BLUE, zorder=3)
        for p in s["points"]:
            if not p["recorded"]:
                ax.plot(p["order"], p["value"], marker="^", markersize=6,
                        markerfacecolor="white", markeredgewidth=1.2, markeredgecolor=ORANGE, zorder=4)
        ep = s["reported_endpoint"]
        if ep["separate"]:
            ax.plot(ep["order"], ep["value"], marker="s", markersize=5.5,
                    markerfacecolor="white", markeredgewidth=1.2, markeredgecolor=BLUE, zorder=4)
        ax.set_ylim(*ylim)
        ax.set_xlim(-.32, len(ticks)-.68)
        ax.set_xticks(range(len(ticks)), ticks)
        ax.set_ylabel(yl)
        ax.text(0, 1.04, title, transform=ax.transAxes, ha="left", va="bottom", fontweight="bold", fontsize=9)
    fig.legend(handles=[legend_band(),
        Line2D([], [], color=BLUE, linestyle=(0,(2.2,1.8)), marker="o", markersize=4.5, label="Structured observation"),
        Line2D([], [], color=ORANGE, marker="^", markerfacecolor="white", linestyle="none", label="Reverted candidate"),
        Line2D([], [], color=BLUE, marker="s", markerfacecolor="white", linestyle="none", label="Reported final")],
        loc="lower center", bbox_to_anchor=(.5,.025), frameon=False, ncol=2, columnspacing=2)
    save(fig, "option-A_mission-sequences")


def harness_plot(pre, probes):
    fig, axs = plt.subplots(1, 2, figsize=(7.16, 2.85))
    fig.subplots_adjust(left=.075, right=.99, top=.86, bottom=.28, wspace=.38)
    panels = [("cast-film", "(a) Cast film", "Film thickness (µm)", (48,52), (43.0,58.2)),
              ("annealing", "(b) Continuous annealing", "Strip temperature (°C)", (700,760), (669,765))]
    for ax, (key, title, xlabel, band, xlim) in zip(axs, panels):
        ax.axvspan(*band, facecolor=BAND, edgecolor=BAND_EDGE, linewidth=.7, zorder=0)
        for i in range(1,4):
            run=f"{key}-r{i}"
            y=4-i
            p, q = pre[run], probes[run]
            # A small vertical offset separates nearly coincident markers;
            # the vertical position otherwise conveys only task identity.
            ax.plot([p,q], [y+.10,y-.10], color=GRAY, linewidth=.85, linestyle=(0,(2.2,1.8)), zorder=1)
            ax.plot(p,y+.10, marker="o", markerfacecolor="white", markeredgecolor=ORANGE, markeredgewidth=1.2, markersize=5.6, zorder=2)
            ax.plot(q,y-.10, marker="o", markerfacecolor=BLUE, markeredgecolor=BLUE, markersize=5.2, zorder=3)
            decimals=2 if key=="cast-film" else 1
            ax.annotate(f"{p:.{decimals}f}", (p,y+.10), xytext=(0,5), textcoords="offset points", ha="center", va="bottom", fontsize=8, color=ORANGE)
            ax.annotate(f"{q:.{decimals}f}", (q,y-.10), xytext=(0,-5), textcoords="offset points", ha="center", va="top", fontsize=8, color=BLUE)
        ax.set_xlim(*xlim)
        ax.set_ylim(.45,3.55)
        ax.set_yticks([3,2,1], ["Task 1", "Task 2", "Task 3"])
        ax.set_xlabel(xlabel)
        ax.text(0,1.05,title,transform=ax.transAxes,ha="left",va="bottom",fontsize=9,fontweight="bold")
    fig.legend(handles=[legend_band(),
        Line2D([], [], marker="o", color=ORANGE, markerfacecolor="white", linestyle="none", label="Pre-task observation"),
        Line2D([], [], marker="o", color=BLUE, linestyle="none", label="Single post-trial probe")],
        loc="lower center", bbox_to_anchor=(.5,.045), frameon=False, ncol=3, columnspacing=1.8)
    save(fig, "option-B_r20-paired-observations")


def evidence_plot(scenarios, probes):
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(7.16, 3.55))
    fig.subplots_adjust(left=.17, right=.985, top=.84, bottom=.23, wspace=.58)
    for ax in (ax1,ax2):
        ax.axvspan(-1,1,facecolor=BAND,edgecolor=BAND_EDGE,linewidth=.7,zorder=0)
        ax.axvline(0,color="#9AA1A8",linewidth=.5,linestyle=":")
        ax.set_xlim(-6.2,7.6)
        ax.set_xticks([-6,-4,-2,0,2,4,6])
        ax.set_xlabel("Target-relative position $(v-c)/h$")
    labels=["Injection (g)", "BOPET (µm)", "Anneal (HV)", "Wastewater (mg/L)"]
    for i,s in enumerate(scenarios):
        y=4-i
        t=s["target"]
        norm=lambda value: (value-t["center"])/t["tolerance"]
        a=norm(s["points"][0]["value"])
        b=norm(s["reported_endpoint"]["value"])
        if not s["reported_endpoint"]["separate"]:
            ax1.plot([a,b],[y,y],color=GRAY,linewidth=.75,linestyle=(0,(2.2,1.8)))
        ax1.plot(a,y,marker="o",markersize=5.5,markerfacecolor="white",markeredgecolor=ORANGE,markeredgewidth=1.1)
        if s["reported_endpoint"]["separate"]:
            ax1.plot(b,y,marker="s",markersize=5.5,markerfacecolor="white",markeredgecolor=BLUE,markeredgewidth=1.1)
        else:
            ax1.plot(b,y,marker="o",markersize=5,markerfacecolor=BLUE,markeredgecolor=BLUE)
    ax1.set_yticks([4,3,2,1],labels)
    ax1.set_ylim(.35,4.65)
    ax1.text(0,1.08,"(a) Deterministic missions",transform=ax1.transAxes,fontweight="bold",fontsize=9,va="bottom")
    ax1.text(0,1.01,"One direct-node trajectory per scene",transform=ax1.transAxes,fontsize=8,va="bottom")
    labels2=[]
    for scene, center, tol, unit in [("cast-film",50,2,"µm"),("annealing",730,30,"°C")]:
        for i in range(1,4):
            run=f"{scene}-r{i}"
            labels2.append(("Film" if scene=="cast-film" else "Anneal") + f" {i} ({probes[run]:.2f} {unit})")
            y=7-len(labels2)
            ax2.plot((probes[run]-center)/tol,y,marker="o",markersize=5,markerfacecolor=BLUE,markeredgecolor=BLUE)
    ax2.set_yticks([6,5,4,3,2,1],labels2)
    ax2.set_ylim(.35,6.65)
    ax2.text(0,1.08,"(b) R20 harness tasks",transform=ax2.transAxes,fontweight="bold",fontsize=9,va="bottom")
    ax2.text(0,1.01,"One post-trial probe per task",transform=ax2.transAxes,fontsize=8,va="bottom")
    fig.legend(handles=[legend_band(),
        Line2D([], [], marker="o",color=ORANGE,markerfacecolor="white",linestyle="none",label="Initial observation"),
        Line2D([], [], marker="o",color=BLUE,linestyle="none",label="Final observation or R20 probe"),
        Line2D([], [], marker="s",color=BLUE,markerfacecolor="white",linestyle="none",label="Separately reported final")],
        loc="lower center",bbox_to_anchor=(.5,.015),ncol=2,frameon=False,columnspacing=2)
    save(fig,"option-C_distinct-evidence")


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--data-root",type=Path,default=DEFAULT_DATA)
    args=parser.parse_args()
    scenarios,pre,probes=load_data(args.data_root)
    missions_plot(scenarios)
    harness_plot(pre,probes)
    evidence_plot(scenarios,probes)
    print("Saved three options as PNG, PDF and SVG in",HERE)


if __name__=="__main__":
    main()

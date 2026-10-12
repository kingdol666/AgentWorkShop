# -*- coding: utf-8 -*-
"""Figures for the IEEE TII revision, drawn from the October 2026 campaign.

Data sources (verbatim):
- docs/benchmarks/EXPERIMENT-REPORT.md  (three consecutive full-suite runs,
  80/80 each; closed-loop ladder 66->65->64->63 bar; three-way consistency
  0.0 bar x3; HITL->dispatch 8/9/9 ms; observation->verification
  25.1/245.2/245.1 s incl. 218 s trial-cadence waits in R2/R3)
- docs/benchmarks/benchmark-20261008045434/report.md  (hardened pipeline,
  92/92: S0 6, S1 54, S2 11, S3 3, S4 9, S5 4, S6 4, S7 1)
- docs/audit/2026-10-08-production-hardening-report.md  (loop 53/53,
  write-evidence suite 34/34, docs consistency 91/91)

Run:  python make-figures.py   (writes PDFs into ../resources/)
"""
import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "STIXGeneral", "DejaVu Serif"],
    "font.size": 8,
    "axes.labelsize": 8,
    "axes.titlesize": 8,
    "xtick.labelsize": 7.5,
    "ytick.labelsize": 7.5,
    "legend.fontsize": 7,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    "axes.linewidth": 0.6,
    "xtick.major.width": 0.6,
    "ytick.major.width": 0.6,
})

BLUE = "#0072B2"
ORANGE = "#E69F00"
GREEN = "#009E73"
VERM = "#D55E00"
GREY = "#7F7F7F"

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resources")
COL_W = 3.45  # IEEE single-column width, inches


def fig_regression_campaign():
    stages = ["S0 env.", "S1 API matrix", "S2 ingest+MES", "S3 gov. neg.",
              "S4 closed loop", "S5 fine-tune", "S6 diagnostics", "S7 report"]
    counts = [6, 54, 11, 3, 9, 4, 4, 1]

    suites = ["Docs consistency", "Write-evidence legs", "API full-loop",
              "Benchmark pipeline S0–S7"]
    suite_n = [91, 34, 53, 92]

    fig, (ax1, ax2) = plt.subplots(
        2, 1, figsize=(COL_W, 1.98), gridspec_kw={"height_ratios": [1.25, 1.0]})

    y = range(len(stages))
    ax1.barh(y, counts, height=0.62, color=BLUE, alpha=0.92, zorder=3)
    ax1.set_yticks(list(y))
    ax1.set_yticklabels(stages)
    ax1.invert_yaxis()
    for i, c in enumerate(counts):
        ax1.text(c + 0.9, i, f"{c}/{c}", va="center", ha="left",
                 fontsize=7, color="#222222")
    ax1.set_xlim(0, 62)
    ax1.set_xlabel("assertions passed per stage (hardened run)")
    ax1.xaxis.set_label_coords(0.5, -0.32)
    ax1.xaxis.grid(True, linewidth=0.4, alpha=0.35, zorder=0)
    ax1.set_axisbelow(True)
    for s in ("top", "right"):
        ax1.spines[s].set_visible(False)

    y2 = range(len(suites))
    ax2.barh(y2, [100] * len(suites), height=0.58, color=GREEN, alpha=0.88,
             zorder=3)
    ax2.set_yticks(list(y2))
    ax2.set_yticklabels(suites)
    ax2.invert_yaxis()
    for i, n in enumerate(suite_n):
        ax2.text(99, i, f"{n}/{n}", va="center", ha="right", fontsize=7,
                 color="white", fontweight="bold")
    ax2.set_xlim(0, 100)
    ax2.set_xticks([0, 25, 50, 75, 100])
    ax2.set_xlabel("regression suites, Oct. 2026 (%)")
    ax2.xaxis.set_label_coords(0.5, -0.34)
    ax2.xaxis.grid(True, linewidth=0.4, alpha=0.35, zorder=0)
    ax2.set_axisbelow(True)
    for s in ("top", "right"):
        ax2.spines[s].set_visible(False)

    fig.tight_layout(h_pad=1.0)
    fig.savefig(os.path.join(os.path.dirname(os.path.abspath(__file__)), "chk-regression.png"), dpi=200); fig.savefig(os.path.join(OUT, "fig-regression-campaign.pdf"),
                bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)


def fig_closedloop_runs():
    runs = ["R1", "R2", "R3"]
    anchor = [66, 65, 64]          # setpoint at observation, bar
    verified = [65, 64, 63]        # three-way verified new setpoint
    tri = ["65/65/65", "64/64/64", "63/63/63"]
    total = [25.1, 245.2, 245.1]   # observation -> verification, s
    cadence = [0.0, 218.0, 218.0]  # trial-cadence window inside the span
    hitl = ["8 ms", "9 ms", "9 ms"]  # approval -> dispatch

    fig, (ax1, ax2) = plt.subplots(
        2, 1, figsize=(COL_W, 2.2), gridspec_kw={"height_ratios": [1.15, 1.0]})

    x = range(len(runs))
    for i in x:
        ax1.plot([i, i], [anchor[i], verified[i]], color=VERM, linewidth=1.6,
                 zorder=3)
        ax1.annotate("", xy=(i, verified[i] - 0.06), xytext=(i, verified[i] + 0.12),
                     arrowprops=dict(arrowstyle="-|>", color=VERM, lw=1.2))
    ax1.plot(list(x), anchor, linestyle="none", marker="o", markersize=5,
             markerfacecolor="white", markeredgecolor="#333333", zorder=4,
             label="anchor setpoint (observed)")
    ax1.plot(list(x), verified, linestyle="none", marker="s", markersize=5.5,
             markerfacecolor=GREEN, markeredgecolor=GREEN, zorder=4,
             label="dispatched, three-way verified")
    for i in x:
        ax1.text(i, verified[i] - 0.42, tri[i], ha="center", va="top",
                 fontsize=7.0, color=GREEN)
    for i in range(len(runs) - 1):
        ax1.plot([i, i + 1], [verified[i], anchor[i + 1]], linestyle=":",
                 color=GREY, linewidth=0.9, zorder=2)
    ax1.text(0.02, 0.97, "(a)", transform=ax1.transAxes, fontsize=8,
             fontweight="bold", va="top")
    ax1.set_xticks(list(x))
    ax1.set_xticklabels(runs)
    ax1.set_ylim(61.8, 67.2)
    ax1.set_ylabel("hold-pressure setpoint (bar)")
    ax1.legend(loc="upper right", frameon=False, handlelength=1.4,
               borderaxespad=0.1)
    ax1.yaxis.grid(True, linewidth=0.4, alpha=0.35)
    ax1.set_axisbelow(True)
    for s in ("top", "right"):
        ax1.spines[s].set_visible(False)

    platform = [t - c for t, c in zip(total, cadence)]
    y2 = range(len(runs))
    ax2.barh(y2, platform, height=0.52, color=BLUE, alpha=0.92, zorder=3)
    ax2.barh(y2, cadence, height=0.52, left=platform, color=ORANGE,
             alpha=0.85, zorder=3, hatch="///", edgecolor="white",
             linewidth=0.4)
    for i in x:
        ax2.text(total[i] + 6, i, f"{total[i]:.1f} s", va="center",
                 fontsize=7, color="#222222")
    ax2.axvline(300, color=VERM, linewidth=0.9, linestyle=(0, (3, 2)), zorder=2)
    ax2.text(296, -0.42, "300 s cadence bound", ha="right", va="center",
             fontsize=6.3, color=VERM)
    ax2.text((platform[1] + total[1]) / 2, 1, "218 s governed trial-cadence wait",
             ha="center", va="center", fontsize=6.3, color="#5a3a00", zorder=4)
    ax2.text(0.98, 0.95, "(b)", transform=ax2.transAxes, fontsize=8,
             fontweight="bold", va="top", ha="right")
    ax2.set_yticks(list(y2))
    ax2.set_yticklabels(runs)
    ax2.invert_yaxis()
    ax2.set_xlim(0, 300)
    ax2.set_xlabel("observation $\\rightarrow$ verification span (s)")
    ax2.xaxis.set_label_coords(0.5, -0.34)
    ax2.xaxis.grid(True, linewidth=0.4, alpha=0.35, zorder=0)
    ax2.set_axisbelow(True)
    for s in ("top", "right"):
        ax2.spines[s].set_visible(False)

    fig.tight_layout(h_pad=1.0)
    fig.savefig(os.path.join(os.path.dirname(os.path.abspath(__file__)), "chk-closedloop.png"), dpi=200); fig.savefig(os.path.join(OUT, "fig-campaign.pdf"),
                bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)



def fig_campaign_combined():
    """Double-column campaign figure: (a) stage counts, (b) suites,
    (c) three-run setpoint ladder, (d) observation->verification span."""
    stages = ["S0 env.", "S1 API", "S2 ingest", "S3 gov.",
              "S4 loop", "S5 tune", "S6 diag.", "S7 rep."]
    counts = [6, 54, 11, 3, 9, 4, 4, 1]
    suites = ["Docs consistency", "Write-evidence legs", "API full-loop",
              "Pipeline S0–S7"]
    suite_n = [91, 34, 53, 92]
    runs = ["R1", "R2", "R3"]
    anchor = [66, 65, 64]
    verified = [65, 64, 63]
    tri = ["65/65/65", "64/64/64", "63/63/63"]
    total = [25.1, 245.2, 245.1]
    cadence = [0.0, 218.0, 218.0]

    fig, axs = plt.subplots(2, 2, figsize=(7.16, 4.4))
    (ax1, ax2), (ax3, ax4) = axs

    y = range(len(stages))
    ax1.barh(y, counts, height=0.62, color=BLUE, alpha=0.92, zorder=3)
    ax1.set_yticks(list(y)); ax1.set_yticklabels(stages); ax1.invert_yaxis()
    for i, c in enumerate(counts):
        ax1.text(c + 1.0, i, f"{c}/{c}", va="center", fontsize=7)
    ax1.set_xlim(0, 64)
    ax1.set_xlabel("assertions per stage, hardened pipeline", fontsize=7.5)
    ax1.xaxis.grid(True, linewidth=0.4, alpha=0.35); ax1.set_axisbelow(True)
    for s in ("top", "right"): ax1.spines[s].set_visible(False)

    y2 = range(len(suites))
    ax2.barh(y2, [100]*len(suites), height=0.58, color=GREEN, alpha=0.88, zorder=3)
    ax2.set_yticks(list(y2)); ax2.set_yticklabels(suites); ax2.invert_yaxis()
    for i, n in enumerate(suite_n):
        ax2.text(99, i, f"{n}/{n}", va="center", ha="right", fontsize=7,
                 color="white", fontweight="bold")
    ax2.set_xlim(0, 100); ax2.set_xticks([0, 25, 50, 75, 100])
    ax2.set_xlabel("regression suites, Oct. 2026 (% passed)", fontsize=7.5)
    ax2.xaxis.grid(True, linewidth=0.4, alpha=0.35); ax2.set_axisbelow(True)
    for s in ("top", "right"): ax2.spines[s].set_visible(False)

    x = range(len(runs))
    for i in x:
        ax3.plot([i, i], [anchor[i], verified[i]], color=VERM, linewidth=1.6, zorder=3)
        ax3.annotate("", xy=(i, verified[i]-0.06), xytext=(i, verified[i]+0.12),
                     arrowprops=dict(arrowstyle="-|>", color=VERM, lw=1.2))
    for i in range(len(runs)-1):
        ax3.plot([i, i+1], [verified[i], anchor[i+1]], linestyle=":",
                 color=GREY, linewidth=0.9, zorder=2)
    ax3.plot(list(x), anchor, linestyle="none", marker="o", markersize=5,
             markerfacecolor="white", markeredgecolor="#333333", zorder=4,
             label="anchor setpoint (observed)")
    ax3.plot(list(x), verified, linestyle="none", marker="s", markersize=5.5,
             markerfacecolor=GREEN, markeredgecolor=GREEN, zorder=4,
             label="dispatched, three-way verified")
    for i in x:
        ax3.text(i, verified[i]-0.44, tri[i], ha="center", va="top",
                 fontsize=6.4, color=GREEN)
    ax3.set_xticks(list(x)); ax3.set_xticklabels(runs)
    ax3.set_ylim(61.8, 67.4)
    ax3.set_ylabel("hold-pressure setpoint (bar)", fontsize=7.5)
    ax3.legend(loc="upper right", frameon=False, handlelength=1.4,
               borderaxespad=0.1, fontsize=6.5)
    ax3.yaxis.grid(True, linewidth=0.4, alpha=0.35); ax3.set_axisbelow(True)
    for s in ("top", "right"): ax3.spines[s].set_visible(False)

    platform = [t-c for t, c in zip(total, cadence)]
    y4 = range(len(runs))
    ax4.barh(y4, platform, height=0.52, color=BLUE, alpha=0.92, zorder=3,
             label="settle + platform path")
    ax4.barh(y4, cadence, height=0.52, left=platform, color=ORANGE,
             alpha=0.85, zorder=3, hatch="///", edgecolor="white",
             linewidth=0.4, label="trial-cadence window (governed wait)")
    for i in x:
        ax4.text(total[i]+5, i, f"{total[i]:.1f} s", va="center", fontsize=7)
    ax4.set_yticks(list(y4)); ax4.set_yticklabels(runs); ax4.invert_yaxis()
    ax4.set_xlim(0, 300)
    ax4.set_xlabel("observation → verification span (s); "
                   "approval → dispatch 8–9 ms throughout", fontsize=7.5)
    ax4.legend(loc="lower right", frameon=False, handlelength=1.5,
               borderaxespad=0.1, fontsize=6.5)
    ax4.xaxis.grid(True, linewidth=0.4, alpha=0.35); ax4.set_axisbelow(True)
    for s in ("top", "right"): ax4.spines[s].set_visible(False)

    fig.tight_layout(h_pad=1.2, w_pad=1.6)
    fig.savefig(os.path.join(OUT, "fig-campaign-combined.pdf"),
                bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)



def fig_four_missions():
    """Single-column 2x2 panel of the four archived mission trajectories,
    drawn from figures/missions-data.json (run 20260921184204-10lc)."""
    import json
    data = json.load(open(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "missions-data.json"),
        encoding="utf-8"))
    titles = {"injection": "injection molding (weight, g)",
              "wwtp": "WWTP (dissolved oxygen, mg/L)",
              "anneal": "annealing (hardness, HV)",
              "biax": "BOPET (thickness, μm)"}
    fig, axs = plt.subplots(2, 2, figsize=(COL_W, 2.5))
    unit_of = {"injection": "g", "wwtp": "mg/L", "anneal": "HV", "biax": "\u03bcm"}
    for ax, m in zip(axs.flat, data["missions"]):
        s = m["series"]; lo = m["target"] - m["tol"]; hi = m["target"] + m["tol"]
        x = list(range(len(s)))
        ax.axhspan(lo, hi, color=GREEN, alpha=0.17, zorder=1)
        ax.axhline(m["target"], color=GREEN, linewidth=0.7,
                   linestyle="-.", zorder=2)
        ax.plot(x, s, color=BLUE, linewidth=1.3, marker="o", markersize=3.2,
                zorder=3)
        ax.plot(x[-1], s[-1], marker="s", markersize=4.5, markerfacecolor=GREEN,
                markeredgecolor=GREEN, zorder=4)
        ax.annotate(f"{s[-1]:.2f} {unit_of[m['id']]}", xy=(x[-1], s[-1]),
                    xytext=(4, -9), textcoords="offset points", fontsize=6.0,
                    color=DARK if "DARK" in dir() else "#333333", zorder=5)
        pad = (hi - lo) * 0.9
        ax.set_ylim(min(lo, min(s)) - pad, max(hi, max(s)) + pad)
        ax.set_xlim(-0.3, len(s) - 0.7)
        ax.set_title(titles[m["id"]], fontsize=7.4, pad=2.5)
        ax.text(0.04, 0.06, f"{m['writes']} governed writes",
                transform=ax.transAxes, fontsize=6.8, color="#444444")
        ax.tick_params(labelsize=7.2)
        ax.xaxis.grid(True, linewidth=0.3, alpha=0.3)
        ax.yaxis.grid(True, linewidth=0.3, alpha=0.3)
        ax.set_axisbelow(True)
        for sp in ("top", "right"):
            ax.spines[sp].set_visible(False)
    for ax in axs[1]:
        ax.set_xlabel("governed-write round", fontsize=6.8)
    for ax in axs[:, 0]:
        ax.set_ylabel("controlled variable", fontsize=6.8)
    fig.tight_layout(h_pad=0.9, w_pad=1.0)
    fig.savefig(os.path.join(OUT, "fig-four-missions.pdf"),
                bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)


def _box(ax, x, y, w, h, text, fc="white", ec=BLUE, fs=6.6, lw=0.9):
    ax.add_patch(plt.Rectangle((x, y), w, h, facecolor=fc, edgecolor=ec,
                               linewidth=lw, zorder=3))
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center",
            fontsize=fs, zorder=4, linespacing=1.15)


def _arrow(ax, x0, y0, x1, y1):
    ax.annotate("", xy=(x1, y1), xytext=(x0, y0), zorder=2,
                arrowprops=dict(arrowstyle="-|>", color="#555555", lw=1.0))


def fig_runtime():
    """Double-column sober agent-team runtime diagram (block-diagram
    conventions matching fig_lifecycle)."""
    fig, ax = plt.subplots(figsize=(5.9, 1.95))
    ax.set_xlim(0, 100); ax.set_ylim(0, 100); ax.axis('off')

    ax.add_patch(plt.Rectangle((1, 58), 98, 40, facecolor='#F2F5F9',
                               edgecolor='none', zorder=0))
    ax.text(50, 95, 'PROPOSE', ha='center', va='center', fontsize=7.4,
            color='#33455e', fontweight='bold')
    ax.add_patch(plt.Rectangle((1, 18), 98, 38, facecolor='#FBF6EC',
                               edgecolor='none', zorder=0))
    ax.text(13, 53, 'GOVERN / ACTUATE /\nCLOSE', ha='center', va='center',
            fontsize=7.4, color='#7a5a1a', fontweight='bold')

    W, H = 21, 26
    Y1, Y2 = 62, 22
    xs = [2.5, 27, 51.5, 76]
    _box(ax, 2.5, Y1, W, H, "task + goal\n(natural language)", ec=BLUE, fs=7.2)
    _box(ax, 27, Y1, W, H, "lead agent\nplan dispatch", ec=BLUE, fs=7.2)
    _box(ax, 51.5, Y1, W, H, "worker agents\nretrieval / analysis /\nsetpoint proposal", ec=BLUE, fs=7.2)
    _box(ax, 76, Y1, W, H, "write agent\ngoverned write\nrequest", ec=BLUE, fs=7.2)
    ax.text(62, 58.5, "strategy slot: LLM engine (replaceable)", ha='center',
            va='center', fontsize=6.8, color='#555555', style='italic')
    for i in range(3):
        _arrow(ax, xs[i] + W, Y1 + H / 2, xs[i + 1] - 0.5, Y1 + H / 2)
    ax.annotate('', xy=(xs[3] + W / 2, Y2 + H), xytext=(xs[3] + W / 2, Y1),
                arrowprops=dict(arrowstyle='-|>', color='#555555', lw=1.0))
    _box(ax, 76, Y2, W, H, "governance gate\nEq. (1) admission +\napproval wait (manual)", ec=ORANGE, fs=7.2)
    _box(ax, 51.5, Y2, W, H, "driver dispatch,\ncommanded SET vs\nobserved ACT readback", ec=BLUE, fs=7.2)
    _box(ax, 27, Y2, W, H, "optimization record\nverdict: keep / rollback /\nuncertain", ec=GREEN, fs=7.2)
    for i in (3, 2):
        _arrow(ax, xs[i] - 0.5, Y2 + H / 2, xs[i - 1] + W, Y2 + H / 2)
    ax.annotate('', xy=(xs[1] + W / 2 + 3, Y1), xytext=(xs[1] + W / 2 + 3, Y2 + H),
                arrowprops=dict(arrowstyle='-|>', color='#555555', lw=1.0))

    ax.add_patch(plt.Rectangle((13, 4), 74, 9, facecolor='#F7F7F7',
                               edgecolor='#BBBBBB', linewidth=0.6, zorder=1))
    ax.text(50, 8.5, "journal: every step attributed (member, timestamp)",
            ha='center', va='center', fontsize=7.2, color='#333333', zorder=2)

    fig.tight_layout(pad=0.2)
    fig.savefig(os.path.join(OUT, 'fig-runtime.pdf'),
                bbox_inches='tight', pad_inches=0.02)
    plt.close(fig)


def fig_lifecycle():
    """Double-column governed write-path life cycle."""
    fig, ax = plt.subplots(figsize=(7.16, 2.05))
    ax.set_xlim(0, 100); ax.set_ylim(0, 100); ax.axis('off')

    bands = [(1, 24.5, 'PROPOSE'), (25.5, 49, 'ADMIT'),
             (50, 73.5, 'ACTUATE + ACKNOWLEDGE'), (74.5, 99, 'VERIFY + CLOSE')]
    for x0, x1, name in bands:
        ax.add_patch(plt.Rectangle((x0, 60), x1 - x0, 38, facecolor='#F2F5F9',
                                   edgecolor='none', zorder=0))
        ax.text((x0 + x1) / 2, 95, name, ha='center', va='center',
                fontsize=7.4, color='#33455e', fontweight='bold')

    W, H, Y1, Y2 = 21, 26, 66, 26
    xs = [2.5, 27, 51.5, 76]
    _box(ax, 2.5, Y1, W, H, "task + production context\nline/product/recipe/run", ec=BLUE, fs=7.2)
    _box(ax, 27, Y1, W, H, "member proposes v\nauthority: member-node\nbinding", ec=BLUE, fs=7.2)
    _box(ax, 51.5, Y1, W, H, "admission: v in H/B/P/R\n(Eq. 1), re-checked\nevery request", ec=BLUE, fs=7.2)
    _box(ax, 76, Y1, W, H, "approval wait (manual)\ntimed, journaled,\nduplicates suppressed", ec=BLUE, fs=7.2)
    for i in range(3):
        _arrow(ax, xs[i] + W, Y1 + H / 2, xs[i + 1] - 0.5, Y1 + H / 2)
    ax.annotate('', xy=(xs[3] + W / 2, Y2 + H), xytext=(xs[3] + W / 2, Y1),
                arrowprops=dict(arrowstyle='-|>', color='#555555', lw=1.0))
    _box(ax, 2.5, Y2, W, H, "driver dispatch\nbatch receipt with\nper-parameter grade", ec=BLUE, fs=7.2)
    _box(ax, 27, Y2, W, H, "acknowledgment grade\n(verify 3×2 s):\nreadback-verified /\ntransport-ack / unverified", ec=ORANGE, fs=7.2)
    _box(ax, 51.5, Y2, W, H, "three-way consistency\nrecipe | device | mirror", ec=GREEN, fs=7.2)
    _box(ax, 76, Y2, W, H, "optimization record\nverdict: keep / rollback /\nuncertain", ec=GREEN, fs=7.2)
    for i in range(3, 0, -1):
        _arrow(ax, xs[i] - 0.5, Y2 + H / 2, xs[i - 1] + W, Y2 + H / 2)

    chips = [(2.5, "compensation: separately\nadmitted write, graded", GREEN),
             (27, "backstop: never-closed\nrecords auto-rollback", "#555555"),
             (51.5, "out-of-window: refused,\njournaled", VERM),
             (76, "expired: fail-closed refusal\nhold mode: no expiry", "#555555")]
    for x, t, c in chips:
        ax.text(x + W / 2, 13, t, ha='center', va='center', fontsize=7.4,
                color=c, linespacing=1.25)
    for x in xs:
        _arrow(ax, x + W / 2, Y2 - 0.5, x + W / 2, 21)

    fig.tight_layout(pad=0.2)
    fig.savefig(os.path.join(OUT, 'fig-lifecycle.pdf'),
                bbox_inches='tight', pad_inches=0.02)
    plt.close(fig)


if __name__ == '__main__':
    fig_closedloop_runs()
    fig_four_missions()
    fig_runtime()
    fig_lifecycle()

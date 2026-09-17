"""Fig. 7 - real-LLM agent closed-loop execution trace (omp / glm-5.3-flash).

Data source (archived execution trace, read - never invented):
  bench/results/20260917044223-17ho/agent-loop-omp.log
    -> task header: target SP 197.48 C, line L1 (modbus-tcp), wall 132.344 s,
       final state COMPLETED, oracle INTEGRATED-CLOSEDLOOP-OK: yes
    -> first daq_query (15 s buckets, read before the write):
       12:42:15=44.65; 12:42:30=111.86; 12:42:45=167.23; 12:43:00=188.4;
       12:43:15=195.74; 12:43:30=198.36; 12:43:45=199.32
    -> post-write daq_query (15 s buckets):
       12:44:30=200.1; 12:44:15=200.02; 12:44:00=199.65; 12:43:45=199.41
    -> recipe monitoring window [191.6, 208.4] C (task history brief)
    -> governed write: SP 197.48 C, PLC raw 197.48, readback 197.5 C,
       optimization record opt-419b36e1, judge keep
    -> trace timestamps: task started 12:43:09 (+08:00); first read returned
       data through 12:43:45, so the write lands in ~12:43:47-12:43:55;
       the step edge is drawn at 12:43:50 (mid-point of that interval).

Style: IEEE TII single column, 86 mm wide, 300 dpi, boxed axes with inward
major+minor ticks, light horizontal grid only, grayscale-safe series.
"""
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt

OUT = Path(__file__).resolve().parent

# ------------------------------------------------------------ trace data
# (minutes since 12:42:00 local, PV degC) - 15 s buckets, first + post-write reads
PV = [
    (0.25, 44.65), (0.50, 111.86), (0.75, 167.23), (1.00, 188.40),
    (1.25, 195.74), (1.50, 198.36), (1.75, 199.41),
    (2.00, 199.65), (2.25, 200.02), (2.50, 200.10),
]
SP0, SP1 = 200.0, 197.48           # setpoint before / after the governed write
T_WRITE = 1.83                      # ~12:43:50 (see provenance note above)
WIN_LO, WIN_HI = 191.6, 208.4      # recipe monitoring window
READ1_T, REQUERY_T = 1.79, 2.42    # first read / adaptive re-query instants

# ------------------------------------------------------------ style
MM = 1.0 / 25.4
mpl.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "STIXGeneral", "DejaVu Serif"],
    "mathtext.fontset": "stix",
    "font.size": 7.5,
    "axes.labelsize": 7.5,
    "axes.titlesize": 7.5,
    "legend.fontsize": 6.6,
    "xtick.labelsize": 7,
    "ytick.labelsize": 7,
    "axes.linewidth": 0.6,
    "xtick.direction": "in",
    "ytick.direction": "in",
    "xtick.minor.visible": True,
    "ytick.minor.visible": True,
    "xtick.top": True,
    "ytick.right": True,
    "axes.grid": True,
    "grid.alpha": 0.25,
    "grid.linewidth": 0.4,
    "legend.frameon": False,
})

fig, ax = plt.subplots(figsize=(86 * MM, 52 * MM), dpi=300)

# recipe window band
ax.axhspan(WIN_LO, WIN_HI, color="#9ed8a4", alpha=0.18, lw=0,
           label="recipe window [191.6, 208.4] °C")

# setpoint step line
t_sp = [0.0, T_WRITE, T_WRITE, 2.6]
sp = [SP0, SP0, SP1, SP1]
ax.plot(t_sp, sp, color="#c44e52", lw=1.2, ls="--", label="setpoint (PLC register)")

# measured PV
t = [p[0] for p in PV]
v = [p[1] for p in PV]
ax.plot(t, v, color="#1f77b4", lw=1.1, marker="o", ms=2.6, mfc="white",
        mew=0.7, label="measured PV (15 s buckets, Modbus TCP)")

# action markers
ax.axvline(T_WRITE, color="#c44e52", lw=0.6, ls=":", alpha=0.8)
ax.annotate("(1) read: startup ramp\nidentified", xy=(0.55, 130), fontsize=6.2,
            ha="center", color="#333333")
ax.annotate("(2) governed write\nSP→197.48 °C\n(record + readback 197.5)",
            xy=(T_WRITE, 166), xytext=(1.98, 143), fontsize=6.2,
            arrowprops=dict(arrowstyle="->", lw=0.55, color="#555555"),
            color="#333333")
ax.annotate("(3) adaptive re-query\n(1 s→15 s bucket)", xy=(2.42, 200.6),
            xytext=(1.30, 205.6), fontsize=6.2,
            arrowprops=dict(arrowstyle="->", lw=0.55, color="#555555"),
            color="#333333")
ax.annotate("(4) judge: keep\n(evidence-cited)", xy=(2.50, 199.6),
            xytext=(2.36, 182), fontsize=6.2,
            arrowprops=dict(arrowstyle="->", lw=0.55, color="#555555"),
            color="#333333")

ax.set_xlim(0, 2.92)
ax.set_ylim(30, 214)
ax.set_xticks([0, 0.5, 1.0, 1.5, 2.0, 2.5])
ax.set_xticklabels(["12:42", "12:42:30", "12:43", "12:43:30", "12:44", "12:44:30"],
                   rotation=0, fontsize=6.2)
ax.set_xlabel("wall-clock time (local, task window 12:42:15–12:44:30)")
ax.set_ylabel("melt temperature (°C)")
ax.legend(loc="lower right", handlelength=1.6, borderaxespad=0.3)

fig.tight_layout(pad=0.4)
fig.savefig(OUT / "fig7-agenttrace.png", dpi=300)
fig.savefig(OUT / "fig7-agenttrace.pdf")
print("written:", OUT / "fig7-agenttrace.pdf")

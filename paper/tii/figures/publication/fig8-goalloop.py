"""Fig. 8 - goal-driven AgentTeam optimization trajectory (omp / glm-5.3-flash).

Data source (archived execution, read - never invented):
  bench/results/20260918013146-4ms/  (extended archive E of the manuscript)
    -> agent-goal-loop-omp.log
         task 82ea1b9d, cast-film twin line ln-6c86b7cd,
         screw node dw-377c3580, thickness DAQ dn-a0209c1b,
         objective-only task: bring film thickness to 52.0 +/- 0.8 um,
         screw speed the only adjustable parameter, at most 6 governed writes;
         wall 1503.2 s, oracle GOAL-OPT-OK: yes, 6-bucket mean 51.917 um.
    -> governed-write events (platform audit, exact instants):
         01:35:45  150 -> 147  (agent write,   dcw.write.agent)
         01:42:52  147 -> 150  (model-initiated rollback, dcw.write.rollback)
         01:44:17  150 -> 153  (agent write)
         01:52:42  153 -> 150  (agent write)
         01:55:35  150 -> 146  (agent write)
    -> acquired thickness series: platform samples API for dn-a0209c1b,
       15 s cadence, 01:34:30-01:59:30 (+08:00), stored beside this script as
       goalloop-pv-20260918.json (raw export, unmodified).

Style: IEEE TII single column, 86 mm wide, 300 dpi, boxed axes with inward
major+minor ticks, light horizontal grid only, grayscale-safe series
(colour + marker + line style each identified in the legend).
"""
import json
from datetime import datetime
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt

OUT = Path(__file__).resolve().parent
DATA = json.loads((OUT / "goalloop-pv-20260918.json").read_text(encoding="utf-8"))

T0 = datetime.fromisoformat("2026-09-18T01:34:33.113+00:00").timestamp()

def mins(at):
    ts = at if isinstance(at, (int, float)) else datetime.fromisoformat(at).timestamp()
    if ts > 1e12:  # epoch milliseconds
        ts /= 1000.0
    return (ts - T0) / 60.0

pv = [(mins(p["at"]), float(p["v"])) for p in DATA["pts"]]
writes = sorted(
    [(mins(w["at"]), float(w["eng"]), w["act"]) for w in DATA["writes"]],
    key=lambda e: e[0],
)

SP0 = 150.0
TARGET, TOL = 52.0, 0.8
BAND_LO, BAND_HI = TARGET - TOL, TARGET + TOL

# ------------------------------------------------------------ style
MM = 1.0 / 25.4
mpl.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "STIXGeneral", "DejaVu Serif"],
    "mathtext.fontset": "stix",
    "font.size": 6,
    "axes.labelsize": 7,
    "xtick.labelsize": 6,
    "ytick.labelsize": 6,
    "legend.fontsize": 6,
    "axes.linewidth": 0.6,
    "lines.linewidth": 1.1,
    "lines.markersize": 2.6,
    "xtick.direction": "in", "ytick.direction": "in",
    "xtick.top": True, "ytick.right": True,
    "xtick.major.size": 2.6, "xtick.minor.size": 1.5,
    "ytick.major.size": 2.6, "ytick.minor.size": 1.5,
    "xtick.major.width": 0.6, "xtick.minor.width": 0.5,
    "ytick.major.width": 0.6, "ytick.minor.width": 0.5,
    "xtick.minor.visible": True, "ytick.minor.visible": True,
    "legend.frameon": False,
    "savefig.dpi": 300,
})

TEAL, RED = "#1F6F78", "#B3282D"

fig, (axa, axb) = plt.subplots(
    2, 1, figsize=(86 * MM, 55 * MM), sharex=True,
    gridspec_kw={"height_ratios": [1.5, 1.0], "hspace": 0.14},
)

# ------------------------------------------------- (a) thickness response
axa.axhspan(BAND_LO, BAND_HI, color="0.90", lw=0, zorder=0)
axa.axhline(TARGET, color="0.45", lw=0.6, ls=(0, (4, 3)), zorder=1)
axa.plot([t for t, _ in pv], [v for _, v in pv],
         color=TEAL, lw=1.0, marker="o", markevery=6,
         markerfacecolor="white", markeredgewidth=0.7, zorder=3,
         label="acquired thickness $h$")

tin, vin = next((t, v) for t, v in pv if t >= writes[-1][0] and BAND_LO <= v <= BAND_HI)
axa.annotate("in band after W$_4$ (%.1f min)" % tin, xy=(tin, vin), xytext=(24.9, 51.4),
             fontsize=6, ha="right", va="center", color="black",
             arrowprops=dict(arrowstyle="-", lw=0.6, color="0.35",
                             shrinkA=1, shrinkB=2, connectionstyle="arc3,rad=0"))
axa.text(16.4, 55.42, "+0.35 $\\mu$m/rpm (model\'s local estimate)",
         fontsize=6, ha="center", va="bottom", color="black")
axa.text(0.015, BAND_LO + 0.12, "objective $52.0\\pm0.8\\,\\mu$m",
         transform=axa.get_yaxis_transform(), ha="left", va="bottom",
         fontsize=6, color="0.35")
axa.set_ylabel("Thickness $h$ ($\\mu$m)")
axa.set_ylim(50.6, 56.3)
axa.set_yticks([51, 52, 53, 54, 55, 56])
axa.grid(axis="y", color="0.88", lw=0.5)
axa.set_axisbelow(True)
axa.tick_params(which="both", pad=2)
axa.legend(loc="upper left", bbox_to_anchor=(0.005, 1.0), handlelength=2.2)
axa.text(0.988, 0.965, "(a)", transform=axa.transAxes, fontsize=7,
         fontweight="bold", va="top", ha="right")

# ------------------------------------------------- (b) screw-speed setpoint
step_t, step_v = [0.0], [SP0]
for t, sp, _kind in writes:
    step_t += [t, t]
    step_v += [step_v[-1], sp]
step_t.append(25.2)
step_v.append(step_v[-1])
axb.step(step_t, step_v, where="post", color=RED, lw=1.2,
         label="screw-speed setpoint")

# (t, sp, label, side) - sides staggered so adjacent labels never touch
EVENT_MARK = [
    (writes[0][0], writes[0][1], "$\mathrm{W}_1\\rightarrow147$", 0.55),
    (writes[1][0], writes[1][1], "$\mathrm{revert}\\rightarrow150$", 1.0),
    (writes[2][0], writes[2][1], "$\mathrm{W}_2\\rightarrow153$", 0.55),
    (writes[3][0], writes[3][1], "$\mathrm{W}_3\\rightarrow150$", -0.35),
    (writes[4][0], writes[4][1], "$\mathrm{W}_4\\rightarrow146$", 1.0),
]
for t, sp, lab, side in EVENT_MARK:
    axb.plot([t], [sp], marker="o", ms=2.8, color=RED, zorder=3)
    if side >= 1.0:
        axb.annotate(lab, xy=(t, sp), xytext=(t, 157.6), fontsize=5.6,
                     ha="center", va="top", color="black",
                     annotation_clip=False)
    elif side < 0:
        axb.annotate(lab, xy=(t, sp), xytext=(t + side, 157.6), fontsize=5.6,
                     ha="right", va="top", color="black",
                     annotation_clip=False)
    else:
        axb.annotate(lab, xy=(t, sp), xytext=(t + side, sp - 0.4),
                     fontsize=5.6, ha="left", va="top", color="black")
axb.set_ylabel("Screw-speed SP (rpm)")
axb.set_xlabel("Time since task start (min)")
axb.set_ylim(142, 158.6)
axb.set_yticks([145, 150, 155])
axb.set_xlim(-0.3, 25.4)
axb.set_xticks([0, 5, 10, 15, 20, 25])
axb.grid(axis="y", color="0.88", lw=0.5)
axb.set_axisbelow(True)
axb.tick_params(which="both", pad=2)
axb.legend(loc="lower right", bbox_to_anchor=(0.995, 0.02), handlelength=2.2)
axb.text(0.012, 0.965, "(b)", transform=axb.transAxes, fontsize=7,
         fontweight="bold", va="top")

fig.align_ylabels((axa, axb))
fig.savefig(OUT / "fig8-goalloop.png", dpi=300)
fig.savefig(OUT / "fig8-goalloop.pdf")
print("wrote fig8-goalloop.pdf / .png;",
      f"{len(pv)} PV samples, {len(writes)} governed-write events")

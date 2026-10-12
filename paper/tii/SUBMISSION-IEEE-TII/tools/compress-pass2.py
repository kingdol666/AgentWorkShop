# -*- coding: utf-8 -*-
"""Close the 10-page budget: remaining prose cuts (correct patterns) plus
non-content space savings (figure scales, bibliography leading).

Validates every pattern before writing anything.
"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = "sections/evaluation.tex"
M = "sections/mechanisms.tex"

EDITS = [
    # --- prose cuts ------------------------------------------------------
    (M,
     " The claim is only decidability and replayability by an audit, not that a\nlearned model cannot be safe \\cite{garcia2015safe,sui2015safe}.",
     " The claim is decidability and replayability, not learned-model safety\n\\cite{garcia2015safe,sui2015safe}."),

    (E,
     "and a standalone admission fixture (six unique probes per arm---four\nhard-range, two window-class---three deterministic repetitions with\nidentical counts); it isolates the window\ninterlock, untouched by the October hardening pass.",
     "and a standalone fixture (six probe classes per arm, three deterministic\nrepetitions with identical counts); it isolates the window interlock,\nuntouched by the October hardening pass."),

    (E,
     "The evaluation draws on two evidence tiers of the same codebase. The\n\\emph{archived snapshot} for Q1--Q4 is integrated run \\resRun{} (seed\n\\resSeed, commit \\resCommit,\nharness \\resHarness, completed \\resEvidenceDate), archived with raw\nreports, together with ablation companion \\resAblationRun. The\nstanding single-node preset is a cast-film extrusion line tuned through the\ndie-head heater setpoint (objective $J$ weights thickness conformance,\ndefects, energy, and throughput under melt-temperature and pressure\nconstraints, larger better); each mission contributes one seed-42\ntrajectory from\ninitial state: Q1, Q2, and Q4 are single-trace case studies (every claim\neach makes is checkable in the archived artifacts), the deterministic loop adds\ntwo in-run traces (seeds 43--44 of the same archived campaign), and repeat\nevidence comes from Q5's\nconsecutive campaigns on the deployment tier---a different tier, not a re-run\nof these traces.",
     "The evaluation draws on two evidence tiers of one codebase. The\n\\emph{archived snapshot} for Q1--Q4 is integrated run \\resRun{} (seed\n\\resSeed, commit \\resCommit,\nharness \\resHarness, completed \\resEvidenceDate), archived with raw\nreports, plus ablation companion \\resAblationRun. Its\nstanding preset is a cast-film extrusion line tuned through the\ndie-head heater setpoint (objective $J$ weights thickness conformance,\ndefects, energy, and throughput under melt-temperature and pressure\nconstraints, larger better). Each mission contributes one seed-42\ntrajectory: Q1, Q2, and Q4 are single-trace case studies (every claim\neach makes is checkable in the archived artifacts), the deterministic loop adds\ntwo in-run traces (seeds 43--44 of the same campaign), and repeat\nevidence comes from Q5's consecutive deployment-tier campaigns---a different\ntier, not a re-run of these traces."),
]

for rel, old, new in EDITS:
    s = io.open(os.path.join(ROOT, rel), encoding="utf-8").read()
    if s.count(old) != 1:
        print(f"ABORT (nothing written) {rel}: {s.count(old)} matches")
        sys.exit(1)

for rel, old, new in EDITS:
    p = os.path.join(ROOT, rel)
    s = io.open(p, encoding="utf-8").read()
    io.open(p, "w", encoding="utf-8", newline="").write(s.replace(old, new, 1))

b = sum(len(o.split()) for _, o, _ in EDITS)
a = sum(len(n.split()) for _, _, n in EDITS)
print(f"prose cuts applied: {len(EDITS)} ({a - b:+d} words)")

# --- non-content space savings ------------------------------------------
SCALE = [
    ("sections/system.tex", "width=0.74\\textwidth", "width=0.70\\textwidth",
     "Fig. 1 architecture diagram"),
    ("sections/mechanisms.tex", "width=0.50\\textwidth", "width=0.45\\textwidth",
     "Fig. 2 runtime diagram"),
    ("sections/mechanisms.tex", "width=\\columnwidth]{resources/hitl-card-crop.png}",
     "width=0.90\\columnwidth]{resources/hitl-card-crop.png}", "Fig. 3b HITL screenshot"),
    ("main.tex", "\\linespread{0.82}\\scriptsize", "\\linespread{0.79}\\scriptsize",
     "bibliography leading"),
]
for rel, old, new, what in SCALE:
    p = os.path.join(ROOT, rel)
    s = io.open(p, encoding="utf-8").read()
    n = s.count(old)
    if n != 1:
        print(f"  SKIP {what}: {n} matches")
        continue
    io.open(p, "w", encoding="utf-8", newline="").write(s.replace(old, new, 1))
    print(f"  scaled {what}: {old} -> {new}")

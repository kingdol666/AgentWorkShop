# -*- coding: utf-8 -*-
"""Compression pass to hold the 10-page budget after the 2026-10-12 disclosure
additions. Every replacement must match exactly once, or the script aborts --
a silent no-op must not be able to masquerade as a cut.
"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = "sections/evaluation.tex"

EDITS = [
    # --- tighten this round's own additions ------------------------------
    (E,
     "These are deliberate excitation steps, not corrections: the archived\ndecision records the loop already converged at error $0.014$\\,g against a\n\\resNovDeadband{} dead-band, and states its purpose as exercising the\ndispatch chain. The scenario therefore tests the governed path end to end;\nit is not evidence of an optimizer finding a better setpoint.",
     "These are deliberate excitations, not corrections: the archived decision\nrecords the loop already converged ($0.014$\\,g against a \\resNovDeadband{}\ndead-band) and names its purpose as exercising the dispatch chain, so the\nscenario tests the governed path, not an optimizer's setpoint choice."),

    (E,
     "$\\resBiaxTarget\\pm\\resBiaxTol$\\,$\\mu$m---$0.04$\\,$\\mu$m inside the window.\nWe report the number and an archive disagreement with it: the same run's\nprose summary records this mission as \\emph{not} attained while its\nmachine-readable verdict records attained. Each write opened a record,",
     "$\\resBiaxTarget\\pm\\resBiaxTol$\\,$\\mu$m---$0.04$\\,$\\mu$m inside the window;\nthe same run's prose summary records it \\emph{not} attained while its\nmachine-readable verdict records attained, so we report both. Each write opened a record,"),

    (E,
     "\\caption{One governed iteration on an already-converged loop\n(harness-adjudicated approval): the step is a deliberate excitation, not a\ncorrection; the trial cadence early-rejects the proposal 69\\,s before a\nhuman is\ninvolved;",
     "\\caption{One governed iteration on an already-converged loop\n(harness-adjudicated approval); the step is a deliberate excitation, not a\ncorrection. The trial cadence early-rejects the proposal 69\\,s before a human is\ninvolved;"),

    # --- remove an unsupported causal claim and its bulk ------------------
    (E,
     "with\nin-specification weight ratio \\resInspecRatio{} (October 7--8; the single\noutlier a blank boundary cell parsed as zero) and \\resNovInspecRange{}\nacross the three October~9 runs (wider feed spread, std\n\\resNovStdRange)---a feed data-quality observation, not a process\nexcursion.",
     "whose\nin-specification weight ratio is \\resInspecRatio{} on October 7--8 and\n\\resNovInspecRange{} across the three October~9 runs---a feed\ndata-quality observation, not a process excursion."),

    # --- drop the lowest-value addition of this revision ------------------
    (E,
     " The claim is only decidability and replayability by an audit, not that a\nlearned model cannot be safe \\cite{garcia2015safe,sui2015safe}.",
     " The claim is decidability and replayability, not learned-model safety\n\\cite{garcia2015safe,sui2015safe}."),

    # --- tighten flagged verbosity ---------------------------------------
    (E,
     "and a standalone admission fixture (six unique probes per arm---four\nhard-range, two window-class---three deterministic repetitions with\nidentical counts); it isolates the window\ninterlock, untouched by the October hardening pass.",
     "and a standalone fixture (six probe classes per arm, three deterministic\nrepetitions with identical counts); it isolates the window interlock,\nuntouched by the October hardening pass."),

    (E,
     "The evaluation draws on two evidence tiers of one codebase. The\n\\emph{archived snapshot} for Q1--Q4 is integrated run \\resRun{} (seed\n\\resSeed, commit \\resCommit,\nharness \\resHarness, completed \\resEvidenceDate), archived with raw\nreports, plus ablation companion \\resAblationRun. Its\nstanding preset is a cast-film extrusion line tuned through the\ndie-head heater setpoint (objective $J$ weights thickness conformance,\ndefects, energy, and throughput under melt-temperature and pressure\nconstraints, larger better); each mission contributes one seed-42\ntrajectory: Q1, Q2, and Q4 are single-trace case studies (each claim is\ncheckable in the archived artifacts), the deterministic loop adds\ntwo in-run traces (seeds 43--44 of the same campaign), and repeat\nevidence comes from Q5's\nconsecutive deployment-tier campaigns---a different tier, not a re-run\nof these traces.",
     "The evaluation draws on two evidence tiers of one codebase. The\n\\emph{archived snapshot} for Q1--Q4 is integrated run \\resRun{} (seed\n\\resSeed, commit \\resCommit,\nharness \\resHarness, completed \\resEvidenceDate), archived with raw\nreports, plus ablation companion \\resAblationRun. Its\nstanding preset is a cast-film extrusion line tuned through the\ndie-head heater setpoint (objective $J$ weights thickness conformance,\ndefects, energy, and throughput under melt-temperature and pressure\nconstraints, larger better). Each mission contributes one seed-42\ntrajectory: Q1, Q2, and Q4 are single-trace case studies, the deterministic\nloop adds two in-run traces (seeds 43--44 of the same campaign), and repeat\nevidence comes from Q5's consecutive deployment-tier campaigns---a different\ntier, not a re-run of these traces."),
]

for rel, old, new in EDITS:
    path = os.path.join(ROOT, rel)
    s = io.open(path, encoding="utf-8").read()
    n = s.count(old)
    if n != 1:
        print(f"ABORT {rel}: {n} matches (want 1)")
        print("  pattern starts:", old[:70].replace("\n", "\\n"))
        sys.exit(1)
    io.open(path, "w", encoding="utf-8", newline="").write(s.replace(old, new, 1))

before = sum(len(o.split()) for _, o, _ in EDITS)
after = sum(len(n.split()) for _, _, n in EDITS)
print(f"applied {len(EDITS)} cuts: {before} -> {after} words ({after - before:+d})")

# -*- coding: utf-8 -*-
"""Reclaim ~7 lines. All three cuts shorten text added or flagged as incidental
this session; none removes a claim.

Validates every pattern before writing.
"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = "sections/evaluation.tex"

EDITS = [
    # 1. same disclosure, half the words
    (E,
     "That absence is a claim about the\npublications in Table~\\ref{tab:nearest}, not about what could be compared: the\nclosed-loop harness parameterizes a direct-REST write path alongside the\ngoverned one precisely to make governance a measurable dimension, and only the\ngoverned arm was exercised, so what governance costs in writes or convergence\nis unmeasured here.",
     "That absence describes the publications in\nTable~\\ref{tab:nearest}, not what could be compared: the harness\nparameterizes a direct-REST write path beside the governed one to make\ngovernance measurable, and only the governed arm ran, so its cost in writes or\nconvergence is unmeasured."),

    # 2. the paper itself calls this a data-quality aside, not a process result
    (E,
     "and the diagnostics scenario exports a 30-min merged wide\ntable (\\resRowsRange{} rows, 14 columns, both campaigns) whose\nin-specification weight ratio is \\resInspecRatio{} on October 7--8 and\n\\resNovInspecRange{} across the three October~9 runs---a feed\ndata-quality observation, not a process excursion.",
     "and the diagnostics scenario exports a 30-min merged wide\ntable (\\resRowsRange{} rows, 14 columns, both campaigns) at in-specification\nweight ratio \\resInspecRatio{} to \\resNovInspecRange{}---a feed data-quality\nobservation, not a process excursion."),

    # 3. keep the count and the exception, drop the two illustrative values
    (E,
     "effluent guards: four finish wider than at baseline\n(COD 359.8$\\rightarrow$42.2, NH$_3$-N 34.4$\\rightarrow$2.6), the fifth, pH,\ndrifting 6.59$\\rightarrow$6.38.",
     "effluent guards: four finish wider than at baseline, the\nfifth, pH, drifting 6.59$\\rightarrow$6.38."),
]

for rel, old, new in EDITS:
    s = io.open(os.path.join(ROOT, rel), encoding="utf-8").read()
    if s.count(old) != 1:
        print(f"ABORT (nothing written) {rel}: {s.count(old)} matches")
        print("   starts:", old[:70].replace("\n", "\\n"))
        sys.exit(1)

for rel, old, new in EDITS:
    p = os.path.join(ROOT, rel)
    s = io.open(p, encoding="utf-8").read()
    io.open(p, "w", encoding="utf-8", newline="").write(s.replace(old, new, 1))

b = sum(len(o.split()) for _, o, _ in EDITS)
a = sum(len(n.split()) for _, _, n in EDITS)
print(f"applied {len(EDITS)} cuts: {b} -> {a} words ({a-b:+d})")

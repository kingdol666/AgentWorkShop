# -*- coding: utf-8 -*-
"""Reclaim ~2 lines without touching content.

The manuscript already uses \\looseness=-1 on several long paragraphs; IEEEtran
honours it by setting the paragraph one line short. Extending it to the
remaining long evaluation paragraphs buys the page budget with zero change to
what the paper says -- unlike cutting prose, it cannot alter a claim.

Validates every anchor before writing.
"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = "sections/evaluation.tex"

ANCHORS = [
    "The ablation replays the same probes on companion run",
    "Seeds 42--44 each issue two governed writes",
    "Wastewater treatment is the write-heaviest",
    "\\emph{Full-suite repeatability.} Three consecutive pipeline executions",
    "\\emph{Closed-loop scenario under governance.} Each run walks observation",
    "Across the five questions the pattern holds",
]

path = os.path.join(ROOT, E)
src = io.open(path, encoding="utf-8").read()
out = src
applied, skipped = [], []
for a in ANCHORS:
    # only add when the paragraph does not already carry the directive
    if ("\\looseness=-1 " + a) in out or ("\\looseness=-1\n" + a) in out:
        skipped.append((a, "already set"))
        continue
    if out.count(a) != 1:
        skipped.append((a, f"{out.count(a)} matches"))
        continue
    out = out.replace(a, "\\looseness=-1 " + a, 1)
    applied.append(a)

if not applied:
    print("nothing applied")
    for a, why in skipped:
        print("  skip:", why, "|", a[:50])
    sys.exit(0)

io.open(path, "w", encoding="utf-8", newline="").write(out)
print(f"added \\looseness=-1 to {len(applied)} paragraphs:")
for a in applied:
    print("  +", a[:60])
for a, why in skipped:
    print("  skip:", why, "|", a[:50])

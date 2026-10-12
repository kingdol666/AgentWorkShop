# -*- coding: utf-8 -*-
"""Final budget closing for this round.

Note on the citation choice: two safe-optimization references were added this
revision to support a load-bearing claim. They cost ~2 bibliography entries
(~45 pt), which is most of the remaining overflow. A survey is the stronger
single citation for a class-level claim, so one is kept and one dropped.
"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = "sections/evaluation.tex"
M = "sections/mechanisms.tex"

EDITS = [
    # keep the survey, drop the second entry (class-level claim)
    (M,
     "not learned-model safety\n\\cite{garcia2015safe,sui2015safe}.",
     "not learned-model safety \\cite{garcia2015safe}."),

    # Fig. 4 caption: same content, fewer lines
    (E,
     "\\caption{One governed iteration on an already-converged loop\n(harness-adjudicated approval); the step is a deliberate excitation, not a\ncorrection. The trial cadence early-rejects the proposal 69\\,s before a human is\ninvolved; the re-proposal is raised as a HITL card and released by\nstructured approval; dispatch returns readback-verified, and the three-way\ncheck reads 65|65|65. Lower lane: fine-tuning under the same 60\\,s window,\nrolled back 40.5$\\rightarrow$40 and restored.}",
     "\\caption{One governed iteration on an already-converged loop\n(harness-adjudicated approval); the step is a deliberate excitation, not a\ncorrection. The trial cadence early-rejects the proposal 69\\,s before a human\nis involved, and structured approval releases the re-proposal; dispatch\nreturns readback-verified and the three-way check reads 65|65|65. Lower lane:\nfine-tuning under the same 60\\,s window, rolled back and restored.}"),

    # write-evidence paragraph: compress, and drop "after three attempts",
    # which R1 could not find demonstrated in the archive
    (E,
     "verify; a publish-only endpoint stays unverified after three attempts; and\non a manual-mode line an approval-free binding's dispatch is intercepted\ninto the queue, approval releasing all six parameters device-verified. An\nAPI regression and a documentation-consistency suite (fails on any\ndocumented-count or version drift) close the campaign.",
     "verify; a publish-only endpoint stays unverified; and\non a manual-mode line an approval-free binding's dispatch is intercepted\ninto the queue, approval releasing all six parameters device-verified. An\nAPI regression and a documentation-consistency suite close the campaign."),
]

for rel, old, new in EDITS:
    s = io.open(os.path.join(ROOT, rel), encoding="utf-8").read()
    if s.count(old) != 1:
        print(f"ABORT (nothing written) {rel}: {s.count(old)} matches")
        print("  starts:", old[:60].replace("\n", "\\n"))
        sys.exit(1)

for rel, old, new in EDITS:
    p = os.path.join(ROOT, rel)
    s = io.open(p, encoding="utf-8").read()
    io.open(p, "w", encoding="utf-8", newline="").write(s.replace(old, new, 1))
print(f"applied {len(EDITS)} edits")

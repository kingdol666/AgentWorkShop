# Revision notes — 5 November 2026

## Experimental interpretation corrected

The archived runner pair matches the recorded harness hash as described in
`REPRODUCIBILITY.md`. Inspection of `bench/lib/scenarios.mjs` and
`bench/experiment/optimization-control.mjs` found two errors in the previous
manuscript's description of the scripted comparison:

1. The wastewater and annealing routines include additional steps after a
   target band is reached and then record a final process value. The 15
   scripted endpoints are therefore not all first in-band readings. The
   abstract, evaluation, discussion, figure and S7 now describe these as
   final values after scenario-specific steps.
2. The 150.41–172.90 s values are wall times for each parallel three-scene
   batch, including setup. The runner copies the batch time to each scene's
   CSV row. They are not per-scene times to reach the target. The figure no
   longer presents them as such; the main text and S7 define their scope.

The recorded endpoint values and 0/15 versus 15/15 band counts were not
changed. The comparison remains descriptive: endpoint rules and horizons were
not matched, and two no-write seed-42 records started from residual states.

## References and figure

`CITATION-VERIFICATION-2026-11-05.md` records checks and their limits for all
25 cited works. Among the changes, the manuscript no longer classifies all
works in a mixed citation group as simulated, the description of InstructMPC
was corrected, and the Graul description was restricted to what the
accessible abstract supports. An arXiv version replaced an unverified conference
DOI; the publication status and version date of another preprint were clarified.
One ICCAD entry's publisher record and full text still require confirmation;
the title and pages are corroborated by the DBLP proceedings index.

Figure 5 shows the 30 archived scene endpoints and 24 targeted guard requests
with distinct shapes for monochrome reproduction. The generator validates the
raw counts from the frozen S7 archive. An independent review checked the
plotted values, target bands, exceptional seed markers, and caption.

## Remaining research and submission work

No new experiment was run. The unequal endpoint rules, unverified live-Agent
control, single-run pilot and incomplete provenance remain. A submission-ready
efficacy claim would require new matched, fixed-horizon experiments and an
appropriate baseline. TII's live submission instructions and the channel for
AI-use disclosure should be confirmed by the authors before submission.

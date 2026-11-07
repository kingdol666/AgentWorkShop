# IEEE TII Manuscript Package

The active anonymous-review manuscript is `main.tex`. It presents a
configuration-driven runtime for carrying industrial production context,
semantic acquisition and control nodes, and protocol mappings through shared
operation dispatch and route-specific write governance.

## Experimental scope

The main evaluation comprises six evidence blocks from the November 1--2
archive: integration checks, selected scene--protocol probes, a scripted
target-band comparison, route and authorization checks, a mock-driver guard
ablation, and a negative live-Agent pilot. A separate November 3 injection
scenario pilot is now reported as exploratory follow-up evidence. It used an
acceptance script and a PLC-based simulated twin, not an active Agent or a
physical plant. Its 15/15 count refers to checks within one execution.

Later system-acceptance suites exercise different fixtures and outcomes; they
are not pooled with the manuscript's experimental results. The paper makes no
claim of physical-plant safety or positive live-Agent performance.

Figure 3 uses the author-supplied workflow image unchanged. Figure 4 is a
vector flowchart of the two write routes. Figure 5 shows individual endpoints
and guard-ablation requests; `tools/redraw_fig5_endpoints_20261105.py`
regenerates it using the frozen records in the S7 archive.

## Files

- `sections/`: introduction, related work, system architecture, operation
  mechanisms, evaluation, and discussion/conclusion.
- `resources/`: manuscript figures and bibliography.
- `Supplementary-File-S7.tex` and `Supplementary-File-S7.pdf`: supplemental
  evidence and methods.
- `Supplementary-File-S7-data-2026-11-04.zip`: November 1--2 source records
  plus the November 3 follow-up scenario-pilot report, JSON, log, and checksums.
- `REPRODUCIBILITY.md`: run identifiers, provenance, and inference limits.
- `CITATION-VERIFICATION-2026-11-05.md`: source-by-source citation checks
  and remaining verification limits.
- `REVISION-NOTES-2026-11-05.md`: corrections to the scripted endpoint and
  batch timing descriptions, plus remaining research limits.
- `PAPER-LOGIC-AND-EXPERIMENT-PLAN-2026-11-04.md`: paper-type positioning,
  logic chain, and evidence-bounded experimental plan.
- `POST-EDIT-TII-VERIFICATION-2026-11-04.md`: independent post-edit review,
  TII exemplars consulted, verified checks, and remaining evidence gates.
- `AI-DISCLOSURE.md`: private author-confirmation note for the IEEE AI-use
  disclosure; the submission channel still needs confirmation for TII's
  double-blind workflow.

The manuscript uses the IEEEtran two-column journal layout. Related-work
results are attributed to their cited publications and are not findings from
the current system evaluation.

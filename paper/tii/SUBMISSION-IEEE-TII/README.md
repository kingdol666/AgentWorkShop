# IEEE TII manuscript package

Current revision: 2026-10-24, narrative, evidence-boundary and figure revision.
The compiled anonymous manuscript has **10 pages**, including six vector
figures and **30 references**, within the at-most-ten-page requirement.
The delivery manifest records the actual page count. IEEEtran journal body/bibliography
type and margins are unchanged.

The story follows task intent and production context through acquisition,
diagnostics, knowledge retrieval, model training, bounded proposals, governed
execution, response observation and retained recipes. The current system is
described through its operating contracts; repaired development defects are
not part of the main narrative. The injection case shows pressure requests,
platform snapshots and quality outputs together. The process evidence uses
repository simulators, with its actual scope stated in Engineering Interpretation
and the self-contained figure captions.

## Files

- `main.tex` / `main.pdf`: source and compiled anonymous manuscript.
- `sections/`: six chapter sources.
- `resources/`: active vector figures, editable SVG/PNG companions, verified
  active bibliography, and result macros.
- `figures/make-system-2026.py`: three implementation schematics.
- `figures/make-evaluation-2026.py`: three data-driven experimental figures.
- `REPRODUCIBILITY.md`: R1-R12 evidence units, objective definitions, protocol
  and interpretation of the archived process measurements.
- `FILE-MANIFEST.json`: hashes of the active manuscript and resources.

The manuscript-source ZIP and `IEEE-TII-anonymous-evidence-2026-10-24.zip` are separate
deliverables. The latter contains available raw/derived archives, original
engine logs, replay source snapshots, redaction/hash manifests, and a
claim-to-artifact map. Available scripts are labelled by interface era; the
supplement does not claim a standalone runtime or an exact historical source
snapshot when only an archived commit marker is available. The October 24
evidence package extends the historical anonymous bundle with the October 23
failed boundary checks and new original/delivered hashes; those checks are
not represented as successful process replications.

## Compile

From this folder, with TeX Live and IEEEtran installed:

```text
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
```

The agent's checks use the latex-paper-en `compile.py` wrapper with shell
escape disabled. Use a Python environment with PyMuPDF for PDF preflight.
Current official requirements, evidence/prose audits, figure QA, page renders,
evidence packaging and final verification are in `../revision-2026-10-24/`.
The October 20 checks and five-seat review remain historical records.
Unchanged primary-source citation audits
remain in `../revision-2026-10-20-tenpage/`; original experimental figure
source-data mappings remain in `../revision-2026-10-20/`.

The current `../revision-2026-10-24/requirements/IEEE-TII-REQUIREMENTS.md`
distinguishes official rules from project choices. TII sets a ten-page
ceiling; exactly ten pages is unnecessary. Thirty references results from separating two standards,
not a journal reference ceiling. Earlier review/build records are historical
artifacts and do not describe the current PDF.

## Editorial and citation scope

The current bibliography contains the actually cited works; the previous
background library and nine-page draft are preserved separately. AgentSpec
uses its ICSE 2026 publication; the R2R book lists editors; MCP is versioned;
ISA-88 and ISA-95 have distinct references. DOI links are printed where available.
The primary-source reports distinguish full-text, author-abstract, catalog and
same-day prior-metadata checks rather than claiming every source was read fully.

Formatting and citation verification are distinct from journal peer review.
The paper reports the mechanisms and process observations its archives support,
and states the simulator/sample scope. The prior five-seat review is preserved
as a historical editorial input; this pass has its own read-only verification.
AI assistance is disclosed, including image-generation composition drafts
for Figures 1 and 2 and their final editable vector reconstruction. The
official requirements record the AI-disclosure placement issue for anonymous
review; the final portal instructions still govern submission placement.
No external journal submission is performed.

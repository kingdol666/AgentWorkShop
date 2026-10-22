# IEEE TII manuscript package

Current revision: 2026-10-20, component-architecture and evidence-lifecycle
revision. The anonymous manuscript targets **10 pages**, including six vector
figures and **30 references**. The final preflight records the actual abstract
word count. IEEEtran journal body/bibliography type and margins are unchanged.

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
- `REPRODUCIBILITY.md`: R1-R10 evidence units, objective definitions, protocol
  and interpretation of the archived process measurements.
- `FILE-MANIFEST.json`: hashes of the active manuscript and resources.

The manuscript-source ZIP and `IEEE-TII-anonymous-evidence.zip` are separate
deliverables. The latter contains available raw/derived archives, original
engine logs, replay source snapshots, redaction/hash manifests, and a
claim-to-artifact map. Available scripts are labelled by interface era; the
supplement does not claim a standalone runtime or an exact historical source
snapshot when only an archived commit marker is available.

## Compile

From this folder, with TeX Live and IEEEtran installed:

```text
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
```

The agent's checks additionally use the latex-paper-en `compile.py` wrapper
with shell escape disabled. The current repository preflight is:

```text
python ../final-revision-2026-10-20/verify_final.py --render
```

Use a Python environment with PyMuPDF. Current figure QA, page renders,
five-seat review, evidence packaging and final verification are in
`../final-revision-2026-10-20/`. Unchanged primary-source citation audits
remain in `../revision-2026-10-20-tenpage/`; original experimental figure
source-data mappings remain in `../revision-2026-10-20/`.

The current `IEEE-REQUIREMENTS.md` distinguishes official rules from project
choices. TII sets a ten-page ceiling; exactly ten pages is this author's current
delivery requirement. Thirty references results from separating two standards,
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
AI assistance is disclosed. No external journal submission is performed.

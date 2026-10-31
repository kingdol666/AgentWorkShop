# IEEE TII manuscript — self-contained source package

This package contains the current anonymous review manuscript and its source
dependencies. The author block and PDF metadata are empty; acknowledgments are
held for the journal-approved channel.

## Compile

    pdflatex main && bibtex main && pdflatex main && pdflatex main

or simply `latexmk -pdf main.tex`. `IEEEtran.cls` is vendored so the folder
needs no extra class installation; a system IEEEtran is also fine. `main.bbl`
is included, so even a single `pdflatex main` pass renders the references.

Expected result: a 10-page, US Letter, two-column paper. The bibliography is
included in `main.bbl` for a single-pass reference build.

## Contents

- `main.tex` — manuscript entry point
- `sections/` — Sections I–VII sources (`modules.tex` inputs `mechanisms.tex`)
- `resources/refs.bib` — bibliography (includes the IEEEtranBSTCTL record)
- `resources/fig-*.pdf|svg` — the five vector figures used by the manuscript:
  the introduction control path, architecture, task flow, admission/HITL, and
  four-scenario control sequences
- `resources/figure-source-data/` — CSV/JSON data behind the figures
- `figures/*.py` — figure generators: `make-agent-control-figure.py`,
  `make-system-2026.py`, `make-admission-figure.py`, and
  `plot-missions-origin.py`; the scenario generator reads the included
  four-scenario source data
- `tools/audit-figures.py` — figure QA gate (min font size, Arial-only,
  text-width budget, raster check)
- `main.pdf`, `main.bbl` — compiled reference output

## Notes

- Figures and tables are content-frozen for this manuscript; regenerate only
  via the included scripts if data changes.
- The supplementary evidence unit (Supplementary File S1) is submitted
  separately and is not part of this source package.

# IEEE TII manuscript — current integrated-run package

This clean package contains the current anonymous manuscript, the figures it
references, and Supplementary File S6 for the single integrated simulator run.
Older run data and inactive figure assets are excluded.

## Compile

    latexmk -pdf main.tex

`IEEEtran.cls` is vendored. The included PDFs are the verified manuscript and
supplementary build; `main.bbl` is provided for a single-pass reference build.

## Contents

- `main.tex`, `sections/`, `resources/refs.bib` — manuscript source
- `resources/*.pdf` — the six figures referenced in the paper
- `figures/build_current_run_figures.py` and `resources/current-run-data/` —
  source data and script for regenerating the two current-run result figures
- `Supplementary-File-S6.*` — the current-run supplement and selected evidence
- `REPRODUCIBILITY.md` — run conditions and evidence limits

The evidence bundle contains selected records from the latest integrated run;
it is not a runtime image and includes no physical-plant data.

# TII manuscript handoff — 2026-09-17 revision

## Status and page policy

This revision targets an **11-page complete working manuscript**, including six figures and references. Compilation and independent review results are recorded in `reviews/`; do not infer readiness from this checklist.

The IEEE Industrial Electronics Society TII page, checked on 2026-09-17, states that Regular Research Papers first submitted on/after 2025-01-01 have a strict **10-page initial-submission maximum**, and a **12-page accepted-final maximum**. An 11-page working draft is therefore **not initial-submission page-compliant**. No acceptance or reviewer endorsement is claimed.

Official source: https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics

## Before an initial submission

- [ ] Produce and independently verify a <=10-page initial-submission version, without shrinking IEEEtran body text or margins and without concealing limitations.
- [ ] Resolve submission stage and double-blind requirements. The anonymous author block alone does not anonymize identifying repository links or supplementary artifacts.
- [ ] Authors verify every reference and bibliographic field against its original source. This revision does not certify the entire bibliography.
- [ ] Authors confirm authorship, ORCID, affiliations, funding, conflicts, disclosure, originality, and exclusive-submission declarations. None was invented by the editing agent.
- [ ] Prepare an appropriately anonymized, frozen artifact and archival identifier. Do not claim a DOI exists before one is registered.
- [ ] Decide whether to recover missing historical ablation data. Current replacement figure uses only the complete traceable baseline; do not silently restore the old nine-repetition claim.
- [ ] Resolve or explicitly retain the documented integrated comparison-tool limitation. No benchmark code was changed and no new experiment run was performed in this editorial revision.
- [ ] Treat LLM historical script scores as non-comparable outputs; do not turn missing observations into valid optimization scores.
- [ ] Preserve actual source-dependent checks, asynchronous execution boundaries, unsigned attribution records, and prompt-only small-step guidance in the submitted paper.
- [ ] Check all six vector PDFs at actual printed width and in grayscale; verify captions, order, embedded fonts, references and page count.
- [ ] Rebuild from source and archive the exact manuscript, figure generator, data manifest, source hashes and build log.

## Build and figure sources

From `paper/tii`: `latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex`.
The six authoritative new figure sources/exports are in `figures/publication/`. Older files outside this directory are retained as historical assets, not active publication sources.

## Editorial scope

The present changes concern manuscript text, diagrams and evidence presentation only. Product implementation, benchmark code, archived raw results and simulator dynamics are not changed to match the paper. Missing evidence remains missing; additional experiments need separate authorization.

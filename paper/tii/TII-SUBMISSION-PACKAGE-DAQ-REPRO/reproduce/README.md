# TII manuscript reproduction notes

This revision is based on the submitted-layout manuscript in `TII-SUBMISSION-PACKAGE-FINAL`. Use the LaTeX PDF as the submission master; the Word copies are editable derivatives. The original package, its nine-page S7 narrative, and the archived S7 data remain unchanged.

## Evidence files

- `ACQUISITION-TRACE.md`: acquisition and control mappings, separately timed agent turns, approval, write receipt, independent simulator read and subsequent DAQ aggregate. The historical records do not contain the original `daq_query` return.
- `REPRO-HISTORICAL.md`: independent offline E6 recalculation, a recount of direct probes, and the boundaries of the record-level reproduction.
- The current local simulator checks are a separate dataset. Do not combine them with E6 or E7 or use them as a physical-plant or autonomous control result.

## Repeating the cast-film check (local development environment only)

The experiment runner is `scripts/experiments/tii-daq-repro.mjs`, relative to the AgentWorkShop checkout root. The delivery archive includes a copy of the executed runner in `reproduce/` for inspection; to repeat it, place that copy at the named checkout path rather than running it from the archive. Use it only with the disposable simulator and the local model server. The observed setup was Windows x64, Node 24.19.0, AgentWorkShop 0.13.0, omp 18.12.2, and LM Studio serving only `google/gemma-4-12b-qat` at 65,536 context and one prediction slot. It also needs installed repository and simulator dependencies, a built `.output`, Docker Desktop's Linux engine, and pre-cached `timescale/timescaledb:latest-pg16` and `eclipse-mosquitto:2` images. The runner uses disposable loopback listeners and does not pull images. Do not point it at plant equipment, shared storage, or a shared broker.

From the checkout root, run `node scripts/experiments/tii-daq-repro.mjs` to attempt the acquisition-only path. The `--trial` variant used for this paper's reproduction attempt may approve a simulated one-step candidate only after the preceding evidence checks pass; that branch was not reached here and is not a verified reproduction. The driver probe is a separate observation. The final run reached sample-row validation but retained no validated series and submitted no agent task. The runtime bundle digest was captured, but the bundle-to-source build equivalence was not verified. See the archived run summary for the failure boundary before attempting any repeat.

## Rebuilding the manuscript

Extract the Overleaf source ZIP into a clean directory. Confirm that `main.tex`, `README.txt`, `sections/`, and `resources/` appear at its root. Compile using pdfLaTeX and BibTeX (`latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex`). Use Overleaf's pdfLaTeX setting if compiling there. The source archive contains only manuscript inputs. The evidence archive is separate.

The `reproduce/build-word.py` helper synchronizes the revised prose with the corresponding original editable layout. It verifies the source-to-baseline paragraphs before replacing them and preserves the existing Word figures, tables, references, and section settings. It is not a general LaTeX-to-Word converter. Run `python -I reproduce/build-word.py --help` for inputs, new output paths, and optional LibreOffice preview export.

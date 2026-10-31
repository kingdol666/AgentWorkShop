# IEEE TII Manuscript Package

The active anonymous-review manuscript is `main.tex`. It presents a
configuration-driven architecture for connecting industrial task execution,
production-scene context, semantic acquisition and control nodes, and
protocol-specific device access through a shared operation boundary.

## Experimental scope

The manuscript and Supplementary File S6 report only the integrated simulator
execution identified in `REPRODUCIBILITY.md`. That execution used a
deterministic tool adapter; it did not run an active language-model loop or
physical equipment. Its workflow checks, protocol/guard probes, fixed-seed
objective cases, and BOPET task are reported as distinct evidence blocks
within one pipeline execution. The fixed seeds are not system-level
replications, and the BOPET optimization record remains open and unjudged.

## Files

- `sections/`: introduction, related work, system architecture, operation
  mechanisms, evaluation, and discussion/conclusion.
- `resources/`: manuscript figures, bibliography, and current-run source data
  for the plotted objective and BOPET observations.
- `figures/build_current_run_figures.py`: regenerates the two current-run
  results figures from the CSV files under `resources/current-run-data/`.
- `Supplementary-File-S6.tex` and `Supplementary-File-S6-Evidence.zip`:
  supplemental measurements, selected logs, source tables, figure assets, and
  delivery-time checksums for the same run.

The manuscript uses the IEEEtran two-column journal layout. Related-work
results are attributed to their cited publications and are not findings from
the current system evaluation.

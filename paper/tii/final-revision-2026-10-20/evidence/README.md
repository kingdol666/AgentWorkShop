# Anonymous experimental evidence supplement

This supplement accompanies the ten-page manuscript dated 2026-10-20. It
contains archived evidence R1–R10, original-output log copies, source inspection
snapshots, a claim map and validation receipts. All process experiments use
software simulators. No process run was rerun to prepare this package.

Use `CLAIM-MAP.json` to locate each claim by manuscript label, evidence unit,
relative file and JSON Pointer or 1-based line. `MANIFEST.json` lists each
source artifact's original and delivered SHA-256, byte counts, source-version
status and transformations. `FILES.json` hashes every delivered file except
itself. `VALIDATION.json` records structural, numeric, privacy and key-result
checks. Missing fields remain null in `MISSING-EVIDENCE.json`.

R1 is the integrated September archive; R2 is its mock admission ablation.
R3 contains all nine dated suite outputs with their timelines and reports;
R4 is an explicit copy of the final R3 timeline. R5 supplies dated ACK
reports and the original baseline console output. R6 is one successful
sequential recipe trajectory plus companion read-only agent evidence. R7
retains the earlier cadence-bound summary and all three archived failed
real-injection harness attempts. R8 is the separate later check from another
starting state. R9/R10 contain current isolated test sources and existing
outputs, including the pre-repair failure. Failed/boundary records are not
removed or converted into successful replicates.

`DUPLICATES.json` identifies repeated copies and overlapping software tests.
782 means software assertions across nine sequential suites; four pressure
commands and five quality snapshots in R6 are not five independent trials.
R6's companion summary is byte-identical in the original archive and does
not add replication. R8 is not appended to R6. The engine log terminal
51.7 micrometers and the logged 52.02-micrometer window mean are distinct
statistics, as are annealing 99.84-HV write-after and 100.08-HV terminal values.

Only copied files were anonymized: local account identifiers, credentials,
private path prefixes, project identity and identity-bearing repository URLs.
Stable generated task/node/recipe/run IDs, protocol names, measured values,
units, times, seeds, verification grades, success/failure results and their
join relations remain unchanged. Public manifests reveal no original local
source paths. Archive prose is historical evidence: its wording (including
claims of real execution) does not establish physical-plant validation.

Two original omp logs were explicitly confirmed by the author as outputs
saved when the experiment ran. That confirmation supersedes only the old
absence statement in R1/ARTIFACT-NOTES.md. File hashes are not independent
verification of capture origin. See DEPENDENCIES-AND-REPLAY.md before using
the inspection code; this package is not a standalone executable platform.

# Anonymous evidence package verification

Date: 2026-10-20. Scope: copied archive packaging and offline verification, not a new process experiment.

## Delivered artifact

- File: `IEEE-TII-anonymous-evidence.zip`
- SHA-256: `578a14539c6ca8e17226106f93fed302d43a83ff5eb81ea01c2a560e1f394ae3`
- Bytes: 981848
- Files: 187 (176 source-artifact copies plus maps, notes, manifests and verifier).
- Original archives remain unchanged. `INTERNAL-EVIDENCE-PROVENANCE.json` retains local original paths outside the public ZIP.

## Fresh checks

1. `python paper/tii/final-revision-2026-10-20/build_evidence.py` — exit 0. ZIP CRC, delivered hashes, duplicate accounting, original-source hashes, JSON/JSONL numeric/boolean/null shape, CSV numerical cells, local claim paths and bounded privacy scan PASS.
2. `python paper/tii/final-revision-2026-10-20/verify_evidence.py` — exit 0. 186 file hashes, 13 claim rows with resolved JSON Pointers or 1-based line anchors, nine suites/782 passing assertions, four R6 confirmation receipts, R6 measurement-note alignment and duplicate accounting PASS.
3. Fresh extraction to a temporary directory and `python verify_bundle.py` — exit 0, same checks PASS.
4. `node --check` on all 81 delivered `.mjs` copies — 81 passed, zero failures. No script was executed against a service. Python AST parsing for the builder and verifier PASS.
5. Credential inspection found legacy literal access tokens and test passwords in source snapshots. They are redacted only in delivered copies; no credential values are reproduced in the QA report. The final scan covers private Windows home/workspace prefixes, case-insensitive project and named-author identifiers, identity-bearing repository URLs, local access tokens, JWTs, and known credential values. This bounded scan does not establish universal anonymity.
6. Seven remaining executable project-identity occurrences are aliased only in inspection copies: the CLI bin key uses `platform`, and six test files use `PLATFORM_TEST`. `DEPENDENCIES-AND-REPLAY.md` explains that a compatible full checkout must consistently restore or adopt the aliases before execution. Raw source originals were not changed.
7. Independent source recheck verified 139 live original files and 37 exported Git objects against all 176 original-source manifest hashes. See `qa/evidence-final-independent-source-check.json`. Builder assertions preserve 13,723 JSON/JSONL numeric/boolean/null fields and 1,919 numeric CSV cells; no process replay was executed.

## Coverage and limits

R1–R10 include the integrated numerical records, original omp output logs, all nine Q5 suite JSON/timeline/report sets, ACK baseline console output, primary/earlier/later recipe summaries, all three earlier failed harness logs, current isolated software tests and their encompassing 65-test output, derived figure tables, and current/recorded source inspection snapshots. `CLAIM-MAP.json` preserves n, units, interface era, configurations, versions where recorded, and missing fields as null.

R6's companion summary and R4's timeline are identified duplicates, not replicates; R9 software cases are a subset of R10. Missing melt temperature and per-sensor timestamps are preserved. Archived historical prose is not relabelled as physical-plant evidence.

`R6-MEASUREMENT-NOTES.json` distinguishes the plotted `/final` observation (32.30 g, 0.019% flash, 1.277% sink) from different numbers in the later `/update` rationale (32.34 g, 0.012% flash, 1.276% sink). The rationale has no linked raw measurement or per-sensor timestamps, so it is not treated as another observed sample or substituted into the plot. Both raw archive fields remain intact. The Q2 map records two engine tasks, and Q6 resolves to `sec:recipeexperiment`.

R1 records commit `e692df1`, an 11-file harness count and hash `9f2756dce4a4cbb3`. That committed pipeline fingerprints nine files; the current 11-file source snapshot also differs. `SOURCE-SNAPSHOT-STATUS.json` reports both calculated hashes. The exact dirty runtime worktree is not reconstructed or asserted to be present. The release supplies data and inspection sources, not the full application/runtime/provider account. `MISSING-EVIDENCE.json` records the absent historical source snapshots, raw fields and log coverage rather than inventing them.

The original omp capture classification follows the author's explicit confirmation. Hashes verify observed copies, not capture origin independently. No process replay, new baseline, source-code runtime modification or physical-plant validation was performed.

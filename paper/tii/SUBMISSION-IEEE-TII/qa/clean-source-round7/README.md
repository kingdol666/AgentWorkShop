# IEEE TII Manuscript Package

Current manuscript: **AgentWorkShop: A Reference Implementation for Task-to-Device Integration in Industrial Agents**. The anonymous IEEEtran journal-format PDF is nine pages with three vector figures and three purpose-specific tables. It stays within the TII 10-page limit for new research manuscripts. The source omits author-identifying material for review.

The paper presents AgentWorkShop as a modular reference implementation connecting collaborative tasks and registered harnesses to per-turn production context, per-call operation checks, semantic I/O, configured protocol drivers, and service-owned evidence. Its specific contribution is the traceable software path from task context through a verified route receipt to a later active-run-tagged measurement. It does not claim a new protocol or process-control algorithm, and it does not test an immutable context snapshot across prompt, approval, and dispatch.

## Evaluation scope

The primary R20 run uses one registered harness across cast-film and annealing simulator scenes with different signal and protocol mappings. Six sequential tasks completed with synthetic approval and a verified device receipt. All six records passed task-to-approval, receipt, and active-run sample linkage checks. The runner verified the route ACK and trial result, waited 20 s, then probed, ingested, and queried one active-run-tagged value; it checked task state after the query, so task-completion-to-sample latency is not recorded. Three executions per scene share one simulator instance, and the sample path uses an isolated SQLite time-series fallback. All six samples remained outside their target bands. These results demonstrate the tested software path, not process attainment, convergence, or cross-harness portability.

R21 is a separate deterministic fixture replay of the current v0.8.0 task route. One task in each scene exercised synthetic approval, verified receipt, readback, and a run-tagged sample without an LLM decision. All 31 runner assertions passed, including cleanup checks. It verifies a scripted software path and is not an independent real-agent or process-performance replication.

A separate local v0.8.0 software regression run records 65 passing tests across eight suites. It exercises scope/grant checks, approval denial and expiry, route-state revalidation, node limits, and role-specific tool exposure with temporary or mock state; it is not process-level evidence and is separate from the R20 and R21 runner assertions. R13 is secondary exploratory protocol and data-lineage evidence: five protocol-family probes and bounded writes with readback were recorded across two simulator scenes, but the exact runtime source was not pinned. Its gate metrics and run-boundary audit are documented in the reproducibility supplement, not used for the primary result.

## Files

- `main.tex` / `main.pdf`: anonymous manuscript source and compiled PDF.
- `sections/`: introduction, related work, system design, module functions, experimental evaluation, and discussion/conclusion.
- `resources/`: active figures and bibliography.
- `figures/`: figure source and generation assets.
- `REPRODUCIBILITY.md`: evidence units, run provenance, and measurement interpretation.
- `CLAIM-EVIDENCE-LEDGER.md`: claims mapped to their evidence and limits.
- `FILE-MANIFEST.json`: hashes for the active manuscript and resources.

The manuscript-source ZIP and anonymous-evidence ZIP are separate deliverables. The anonymous evidence archive is intended as Supplementary File S1; `R20-TRACE-MATRIX.csv` gives the six execution keys and task, active-run, approval, trial, receipt, and sample IDs. The archive also contains the separate R21 fixture records and logs, source reconstruction materials, historical evidence, and claim mappings. Evidence units are not pooled or presented as matched strategy comparisons. The local checks and blind reviews support revision quality but do not guarantee IEEE TII acceptance.

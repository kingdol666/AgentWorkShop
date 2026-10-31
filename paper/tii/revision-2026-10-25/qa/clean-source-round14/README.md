# IEEE TII Manuscript Package

Current manuscript: **AgentWorkShop: A Reference Implementation for Task-to-Device Integration in Industrial Agents**. The anonymous IEEEtran journal-format PDF is ten pages with three vector figures and three purpose-specific tables. It stays within the TII 10-page limit for new research manuscripts. The source omits author-identifying material for review.

The paper presents AgentWorkShop as a modular reference implementation connecting collaborative tasks and registered harnesses to per-turn production context, per-call operation checks, semantic I/O, configured protocol drivers, and service-owned evidence. The tested path links task context to approval, verified route receipt, and a later active-run-tagged probe-and-ingest sample; task state was checked after the sample query. A separate mock-state regression confirms that a recipe action is refused before actuation if its active line/product/recipe/run context changes during an approval wait. The paper does not claim a new protocol or process-control algorithm; context reuse, alternate harnesses, and comparative integration benefit remain untested.

## Evaluation scope

The primary R20 run uses one registered harness across cast-film and annealing simulator scenes with different signal and protocol mappings. Six sequential tasks received synthetic approval and a verified device receipt. After each receipt, the runner waited 20 s, then probed, ingested, and queried one sample under the active production run ID through an isolated SQLite time-series fallback; task state was checked after the query. The separate trial-run ID identifies the recipe-trial operation and is linked to the active-run record through the task and approval. All six records passed the reported task, approval, receipt, and sample-link checks, but no task-completion-to-sample latency is available. Three executions per scene share one simulator instance. All six samples remained outside their target bands. These results demonstrate the tested software path, not normal online DAQ operation, process attainment, convergence, or cross-harness portability.

R21 is a separate deterministic fixture replay of the current v0.8.0 task route. One task in each scene exercised synthetic approval, verified receipt, readback, and a run-tagged sample without an LLM decision. All 31 runner assertions passed, including cleanup checks. It verifies a scripted software path and is not an independent real-agent or process-performance replication.

The current local unit suite passed 546/546 tests across seven suites. It covers scope/grant checks, approval denial and expiry, route-state revalidation, node limits, and role-specific tool exposure with temporary or mock state; it is separate from the R20 and R21 runner assertions. These results are software-test evidence, not process-level or overall architecture evidence. R13 is secondary exploratory protocol and data-lineage evidence: five protocol-family probes and bounded writes with readback were recorded across two simulator scenes, but the exact runtime source was not pinned. Its gate metrics and run-boundary audit are documented in the reproducibility supplement, not used for the primary result.

The recipe-approval snapshot suite passed 12/12 cases. Four pending-approval context mutations—line, product, recipe, and active run—are each refused before a mock-driver write and create no new execution record. This is a mock-state software-contract check only, not process-level or overall architecture evidence. Source and run logs are included in Supplementary File S1.

## Files

- `main.tex` / `main.pdf`: anonymous manuscript source and compiled PDF.
- `sections/`: introduction, related work, system design, module functions, experimental evaluation, and discussion/conclusion.
- `resources/`: active figures and bibliography.
- `figures/`: figure source and generation assets.
- `REPRODUCIBILITY.md`: evidence units, run provenance, and measurement interpretation.
- `CLAIM-EVIDENCE-LEDGER.md`: claims mapped to their evidence and limits.
- `FILE-MANIFEST.json`: hashes for the active manuscript and resources.

The manuscript-source ZIP and anonymous-evidence ZIP are separate deliverables. The anonymous evidence archive is intended as Supplementary File S1; `R20-TRACE-MATRIX.csv` gives the six execution keys and task, active-run, approval, trial, receipt, and sample IDs. The archive also contains the separate R21 fixture records and logs, source reconstruction materials, historical evidence, and claim mappings. Evidence units are not pooled or presented as matched strategy comparisons. The local checks and role-separated simulated blind reviews support revision quality but do not guarantee IEEE TII acceptance.

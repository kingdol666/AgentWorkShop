# Manuscript prose revision — 2026-10-20

## Authorized scope and preserved evidence

Only the active manuscript sections, the abstract's approval qualifier, and source comments in `resources/results-macros.tex` were changed. No bibliography, figure source, experiment archive, runtime code, equation, or result-macro definition was changed by this prose pass.

A before/after in-memory snapshot check found identical multisets of `\\cite{}`, `\\ref{}`, `\\label{}`, `\\eqref{}`, `\\path{}`, and `\\res*` result macros in every owned file. Both displayed equation environments remain byte-identical. Whitespace-token counts over the eight owned source files changed from 7011 to 6956 (55 fewer; this is a source-size proxy, not rendered word or page count).

## Changes

- **Argument and contribution:** merged the duplicated contribution introduction into one execution-and-evidence contract; preserved the four contribution items and their evidence boundaries. Shortened the section roadmap and split the strategy/platform responsibilities into two sentences.
- **Architecture and Figure 1:** replaced the obsolete five-row execution-order description with three cooperating component groups: team/strategy, governance, and industrial integration. Shared production context, evidence stores, and sanctioned interfaces remain explicit. Revised the caption to distinguish commanded control `u`, acquisition `y`, and equipment-side protection.
- **Protocol coverage:** explicitly named Modbus TCP, OPC UA, MQTT, and HTTP simulator writes in Q1; RTU-over-TCP remains acquisition-only. The mock-driver ablation is a separate experiment.
- **Runtime and Figure 2:** documented that a successful changed-value node write opens the node-optimization record before the wait; the exploration summary is saved after target observation. Recipe batch/per-parameter receipts return to a caller that waits, queries, and decides. Recipe retention requires a separate update.
- **Route-specific checks:** removed a blanket implication that all pacing checks precede approval. The recipe-operation interval may reject at proposal; other checks follow their actual route. Abstract wording now says required approvals govern actuation.
- **Evidence units:** Q1–Q4 are historical direct-node evidence; the 65 current profile/composition tests use temporary/mock storage; Q6 is recipe-path evidence. Replaced two live engine “turns” with two engine “tasks.” The six-stage procedure now explicitly applies to process missions.
- **Q1 interpretation:** replaced window-edge wording with soft-window probes. Moved the CSV-versus-report bookkeeping dispute out of the narrative while retaining the archive/report provenance.
- **Q3 interpretation:** described energy and throughput terms as screw-speed/line-speed proxies; the finite restricted grid is a reference normalization, not a global continuous optimum.
- **Q6 pacing:** `AW_TRIAL_INTERVAL_MS=0` disables the per-line cadence; `emergency=true` bypasses the separate recipe-operation interval. Approval, admission, and confirmation remain active; no special emergency authorization is invented.
- **Scope and availability:** consolidated simulator and evidence-unit facts in the experimental setup and discussion; retained scripted approvals, single Q6 trajectory, missing melt temperature, sensor-freshness coverage, and lack of a current complete AML exploration process trial. Data availability now distinguishes the separate anonymous experimental evidence bundle from manuscript sources.
- **Source provenance comments:** superseded the obsolete statement that the two original omp logs were absent, using the author's confirmation that they were saved at execution time.

## Rewrite contract

### Introduction and abstract
`Changed:` duplicate contribution lead removed; responsibilities split; roadmap shortened; required-approval qualifier clarified.  
`Protected:` all citation/reference/label tokens, numerical abstract results, result macros.  
`Meaning-Check:` PRESERVED — LLM proposal, subject to author verification.  
`Risk-Flags:` none.

### System and mechanisms
`Changed:` component organization and route-specific record timing clarified; Figure 1/2 captions aligned to the approved redesign; protocol inventory corrected from archived evidence.  
`Protected:` all citations, references, labels, equations, result macros, timing values, API names.  
`Meaning-Check:` PRESERVED for polish; factual corrections checked against the named implementation/archive.  
`Risk-Flags:` none.

### Evaluation and discussion
`Changed:` evidence units, controller proxies, grid interpretation, pacing configuration, and evidence delivery scope clarified; redundant defensive/source-field prose reduced.  
`Protected:` all citations, references, labels, equations, result macros, observed measurements, targets, receipts, sample units, and simulation disclosures.  
`Meaning-Check:` PRESERVED — no result strength increased.  
`Risk-Flags:` none.

## Verification and diagnostic interpretation

All commands ran with exit code 0. This pass deliberately did not compile: the coordinating agent owns final figure integration, compilation, and pagination.

- `uv run python -B C:/Users/87287/.agents/skills/latex-paper-en/scripts/analyze_grammar.py paper/tii/SUBMISSION-IEEE-TII/main.tex`: no rule-based grammar issues.
- `uv run python -B C:/Users/87287/.agents/skills/latex-paper-en/scripts/check_claim_forward.py paper/tii/SUBMISSION-IEEE-TII/main.tex`: no claim-forward patterns.
- `uv run python -B C:/Users/87287/.agents/skills/latex-paper-en/scripts/analyze_logic.py paper/tii/SUBMISSION-IEEE-TII/main.tex --motivation-thread`: promise and closure maps match. The gap/abstract keyword diagnostics still fire despite an explicit final related-work systems question and numerical abstract results; these are heuristic observations, not established defects.
- `uv run python -B C:/Users/87287/.agents/skills/latex-paper-en/scripts/analyze_experiment.py paper/tii/SUBMISSION-IEEE-TII/main.tex --section evaluation`: flags comparator/metric/variance keywords. Manual review retains system-contract claims, one-trajectory boundaries, and nearby concrete measures; no significance or optimization-superiority claim was introduced.
- `uv run python -B C:/Users/87287/.agents/skills/latex-paper-en/scripts/analyze_sentences.py paper/tii/SUBMISSION-IEEE-TII/main.tex`: enumerations, captions, and short parallel lists dominate the reported comma-based complexity findings. Mechanically suggested splits were not applied.
- `uv run python -B C:/Users/87287/.agents/skills/latex-paper-en/scripts/analyze_abstract.py paper/tii/SUBMISSION-IEEE-TII/main.tex`: the script reports 203 words within 150–250, but its keyword structure check says FAIL. Manual review identifies the problem, framework, mechanisms, numerical results, simulator scope, and final execution-chain conclusion in the abstract; no invented aims/results were added to satisfy regex triggers.

## Required downstream checks

## Final review-response authoring delta

After the five seats committed their baseline reports, the final authoring
pass clarified the integration contribution as three evidence contracts
(production-scoped authority, graded command confirmation, route-specific
records) and mapped them to Q1/current profile tests, Q5, and Q4/Q6. The
abstract now states scripted approvals and limits its conclusion to exercised
routes. The discussion explicitly distinguishes the design from the absence
of one current-version study jointly varying strategy, protocol and context.
The conclusion defines accountability as traceable authorization/evidence
attribution. Q6 distinguishes the plotted final snapshot from later update
rationale figures with no linked raw measurement. The stale implementation
version label became "inspected implementation". Repeated roadmap and
interpretation prose was shortened to retain exactly ten pages.

Changed: evidence boundaries and contribution mapping clarified; repetition
removed. Protected: numerical results, units, result macros, equations,
bibliography and figure assets. Meaning-Check: PRESERVED for polish; explicit
claim narrowing and provenance correction are deliberate, not silent meaning
equivalence. Risk-Flags: none; no claim strength increase.

Two compile.py builds exited 0 with shell escape disabled. The first delta
produced eleven pages; removing repeated prose restored ten pages without
changing body size, figure text, margins, or bibliography leading. Final
preflight passed all gates at PDF SHA256
`c4a8018c9e7c5b50eae592c1efecf1eb22634851116e330294a389fb5b6a976b`.
The baseline review scores are retained and are not author-upgraded.

- Compile through the skill's `compile.py` wrapper after Figure 1/2 resources are ready.
- Verify exactly 10 pages, actual placed figure type size, clipping, and cross-references on the final PDF.
- Confirm the evidence bundle's delivered file inventory matches the new data-availability sentence; missing replay dependencies must be disclosed in that bundle rather than silently promised.
- Independent reviewer seats must assess scientific sufficiency and final wording; this implementation log is not an acceptance decision.


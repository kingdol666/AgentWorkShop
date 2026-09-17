## Verification Report

### Verdict
**Status**: PASS
**Confidence**: high
**Blockers**: 0 within the requested archive-to-manuscript benchmark scope

Bounded approval of the revised evaluation, benchmark portion of the abstract, benchmark-data.json, and existing Figure 5/6 data/plot text. No meaningful unsupported numerical or scope claim was found in this selection. This is not approval of experimental reproducibility, physical safety, implementation-wide correctness, or submission readiness.

### Evidence
| Check | Result | Command/Source | Output |
|-------|--------|----------------|--------|
| Tests | pass | Independently authored Python stdin assertions using json/csv/hashlib/math; no benchmark imports or execution | 384 CSV rows; 12/12 percentile pairs; 276/276 latency samples in archive order; all attack/legal/boundary counts; 9/9 trajectory objectives; 3/3 endpoint ratios and convergence checks |
| Types | N/A | No TypeScript/code changes; lsp_diagnostics_directory unavailable | Not a software type-check approval |
| Build | not run | Read-only manuscript review; existing PDF/log inspected instead | No fresh LaTeX compilation claimed |
| Runtime | pass, archive scope only | Fresh PDF/SVG parsing and existing verification scripts | 11-page existing PDF, six numbered figures, no reported mechanical issues; no experiments rerun |
| Provenance | pass | SHA-256 computed directly from file bytes | Four contract source hashes match; contract hash matches figure manifest |

### Acceptance Criteria
| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Revised R count and separate second-scenario count | VERIFIED | R lines have 6/6 rejected and zero legal false blocks for each of TCP, OPC UA, MQTT, HTTP: 24/24, 0/4. RTU has no write denominator. Portability has 9/9 and 0/3. Abstract/evaluation use these separately. |
| 2 | Correct attack families | VERIFIED | Recomputed six attack values from pipeline.mjs and archived bounds: four hard-range plus two window-only for each R writable fixture. Second-scenario source uses three hard-range attacks, not window-only coverage. |
| 3 | Figure 6 uses only frozen three-repetition baseline | VERIFIED | Contract names run-e1lite-4arm, seed 42, four arms, reps 1/2/3. PDF text says three repetitions and retained hard range. No nine-repetition aggregate. |
| 4 | All 12 p50/p95 pairs independently reproduce | VERIFIED | Recomputed sorted index 11 and 21 for n=23; matched both raw run aggregate and publication JSON. Full CSV-order sample arrays also match. |
| 5 | Figure 5 trajectories, objective, Jend and ratios | VERIFIED | All three trajectories equal R; all nine J values recomputed from the objective; final-two-evaluation means and ratios match contract; both terminal evaluations meet thickness/defect/pressure requirements and all recorded temperatures satisfy constraints. |
| 6 | Existing Figure 5/6 plot data and text | VERIFIED | Three SVG trajectory paths and all 12 SVG paired-percentile paths match independently calculated coordinates. Extracted PDFs identify finite-grid reference, mean-of-two endpoint definition, no LLM, three paired quantiles, fixed attack denominator, and no equivalence claim. |
| 7 | Four historical LLM main scores invalid, old outputs retained | VERIFIED | Four result.json files retain old J=67.684461...,31.209887...,68.252493...,68.520029...; revised caption makes all main scores N/A. Historical script substitutes thickness=0 and temperature=210; literal CONVERGED template can match regex. |
| 8 | LLM truth endpoints are not convergence evidence | VERIFIED | Read all four truth.jsonl traces to final samples: 51.147,50.247,48.715,51.147; counts 1056/1182/3286/1430. Manuscript explicitly disclaims sustained convergence and retrospective score replacement. |
| 9 | LLM observations and execution metadata | VERIFIED | Writes 7/7/15/10; all seed42, speed6; archived model/engine labels omp/glm-5.3-flash. Three thickness windows n=87, min=max55.33; fourth absent/MQTT failure. All four pressure connection tests and inspector checks fail. |
| 10 | Static/mock/fault/lifecycle evidence scoped properly | VERIFIED | Static 1718: anchors20/20, chains2/2, inventory9/9. Mock co: semantic6/6, attacks6/6, legal3/3, boundary3/3, readback/attribution3. Frozen PLC: connectivity5/5, separate attack5/5, one freeze alarm2s and one link recovery drill. R lifecycle details match revised prose. |
| 11 | Readback units do not imply pressure readings | VERIFIED | Header is degrees C/rpm. R TCP DCW is zone1-sp; OPC UA DCW is screw-sp (ns=2;s=AW.N.Sp), distinct from pressure DAQ node AW.P. Deltas0.04/0 therefore refer to actuator readback; MQTT/HTTP are N/A. |
| 12 | Failures/exclusions not silently erased in checked suite groups | VERIFIED | Compared original evaluation subsection inventory with revised section and selected raw archives: co four skips; pds two fetch failures; 18no54pass/1warn and seed44four writes; xac/vzo13pass; 15ns/51c55pass. All are disclosed with separate scope. Missing ce0 partner and incomplete historical nine-repetition source set are explicitly withdrawn, not replaced by later runs. |
| 13 | R metadata and source identity | VERIFIED | runId20260914152838-fwg, seed42, commitd6c824d, harness204fc9ee9271e3be, Nodev24.19.0/win32x64; 55 individually passing checks. Run ID treated as identifier, not inferred start time (env.startedAt=2026-09-14T15:33:48.046Z). |

### Gaps
- No factual blocker identified within this bounded benchmark review. Broader mechanism/implementation claims, exhaustive historical recovery, fresh LaTeX compilation and experiment repeatability are not certified — Risk: medium if this report is treated as whole-paper approval — Suggestion: retain separate implementation and publication-build verification lanes.
- Seed43 exact Jend is 87.1575, while archived rounded Jend and prose preserve87.157. Contract retains both exact and archived values; difference is0.0005 and does not affect the stated ratio/range — Risk: low — Suggestion: keep exact/archived distinction; not a meaningful benchmark defect.
- Review-operation disclosure: I inadvertently invoked existing verify_publication.py and verify_figures.py, which regenerate reviews/final/verification.json, figures/publication/verification.json and figures/publication/contact-sheet.png. This exceeded the requested report-only write allowance. Manuscript source, benchmark code, raw archives, benchmark-data.json and Figure5/6 source/PDF data were not edited. No attempt was made to roll back possibly concurrent designer outputs — Risk: low for scientific content, process-boundary violation acknowledged — Suggestion: use extracted read-only assertions for future review runs.

### Recommendation
APPROVE
Approve the checked archive-to-claim mapping and existing Figure5/6 data/text only; no meaningful factual correction is required in that bounded scope.

Independent percentile results (ms, repetitions1/2/3):
- full:125.4/158.9;140.9/158.6;125.8/158.2.
- no-interlock:125.5/158.2;140.6/159.3;126.4/150.2.
- no-readback:125.4/156.5;124.7/156.4;125.1/156.7.
- ungated:112.4/156.2;110.9/155.5;125.0/156.4.
Each pair uses23 successful legal/timed writes; attacks and boundary probes excluded. Every repetition has3 legal successes and3 arm-specific expected boundary outcomes. Rejected attacks are6,4,6,4 by arm.

Exact Jend / W* results:
- seed42:87.26166666666668 /89.894 =0.9707173634132054.
- seed43:87.1575 /89.894 =0.9695585912296705.
- seed44:87.36583333333334 /89.894 =0.9718761355967399.
Mean wall time independently recomputes36.188s. Each seed has2writes; this is expressly run-specific.

Lifecycle checks read directly: recipe version1->2->3 on revert on two lines; judged rollback leaves196.600006 before explicit restoration203.399994; separate node rollback; scripted approval456ms; journal10 and query windows200/200; one backstop120.105s restoring186.199997; vector/image5/5; mock team dispatch; dedup returns1 after2writes; registry14/available12. These are observed probes, not repeated-protocol fault coverage or lifetime rollback guarantees.

Snapshot SHA-256:
- main.tex: bbb7ccc6644b175ca230dff95b23318eff6f6f8aa7419d11b58d24c426b5ebb1
- sections/evaluation.tex: 1463b5d732e91b3df8b8c1fdac9d5dc7271c1a18f81375b7d645c314597e28b5
- benchmark-data.json: f47170a9363414e34ac929d24829d385ac145445ca9e4bee44a6926ce77f6883
- fig5-closedloop.pdf: bd3a0337fe9f975e646b34afa8a8aa2f1ba4f741f0e22528ce6fab84a32b2a8e
- fig6-ablation.pdf: d93f7da8615f56dbf328e05d6c8abeff59919e72dd43f6d5f2c21b53909bd48b

Source hashes independently matched:
- R run.json:1ac8c155197734dbc1de94a483bfaebc5ac5f674ec1f698b15598b4feda8f9ee
- frozen ablation run.json:5ea4967fc528466d77aebd525eb51b761229b229a45b553351179e46e3e677e9
- frozen ablation e1-lite.csv:d6482ae6798612e40858fbc79071e9bfe947a54dc13e2c706f6d30361be18e48
- bench/e1-lite.mjs:4d74092ce0441894d75d7c81f4b2d817322762edff36ac2fbd54b9f4dd46262e

Fresh verification outputs were produced on2026-09-17. Early ad-hoc checker attempts failed on Windows default encoding, an optional satellite field, and comparing sorted samples to archive-order arrays; these were reviewer-script mistakes, corrected in the final passing assertions, not data defects. Existing verification scripts both exited0. No old audit conclusion was used in place of raw-source inspection.

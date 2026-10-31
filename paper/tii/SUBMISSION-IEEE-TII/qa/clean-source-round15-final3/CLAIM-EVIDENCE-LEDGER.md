# Claim–evidence ledger — 2026-10-25 revision

This ledger describes the 2026-10-25 manuscript revision. Original numerical
archives were not edited; the current-version simulator runs are separate,
timestamped evidence units. Earlier verification reports remain historical
records. The ledger maps claims to their evidence scope and does not establish
publication readiness or journal acceptance.

| Claim | Owning evidence | Scope |
|---|---|---|
| Current profile/capability architecture | server/services/workshop/agents/host-tool-bridge/dispatch.ts; industrial/optimization-tools.ts; recipe-gate.ts; aml/twin/channel-profile.ts | Implementation inspection; exploration need not have a model; model aid has a separate gate |
| Optimizer recommendation boundary | server/services/workshop/agents/industrial/optimizer-tools.ts; host-tool-bridge/optimizer-gate.ts | Separately bound/versioned recommendations with eligibility/state evidence; no actuation authority; not experimentally evaluated here |
| Node journal and exploration summary timing | dcw/dcw-controller/write.ts; dcw/recipe-rollback-manager/lock.ts; industrial/optimization-tools.ts | Successful changed node write opens node journal; platform wait and target query precede the separate exploration-summary record |
| Recipe batch and response timing | dcw/dcw-controller/recipes.ts; industrial/ops-tools.ts | Batch run is created before parameter writes/verification; caller receives graded result before arranging observation and separate recipe save |
| Online versus recipe admission | dcw/param-limits.ts; dcw-controller/write.ts | Four-layer online intersection; dispatch skips the old recipe window |
| ACK versus final verdict | shared/dcw-protocol/line.ts; dcw-controller/actuation.ts and write-verify.ts; drivers/mes-rest.ts | Acceptance ACK and verified/unverified/failed are separate; no-read-map MES is not device verification |
| Rejection/control/snapshot repairs | tests/manual-approval-optimization.test.ts; tests/recipe-approval-snapshot.test.ts; ../revision-2026-10-24/qa/current-software-tests.log | Same 65 combined isolated checks passed October 20 and October 24, not 130 distinct checks or a process E2E experiment |
| Q1 protocol closure and latency | bench/results/20260921184204-10lc/run.json, metrics.csv, report.md; bench/lib/metrics.mjs | Five acquired families, four written; six writes per line; fourth order statistic (upper median) and observed maximum |
| Q1 four-arm ablation | bench/results/20260921181234-e1lite/e1-lite.csv; bench/e1-lite.mjs; companion report | Mock-driver API fixture, six attack classes × three deterministic repetitions; full/no-readback18/18, no-interlock/ungated12/18; boundary checks separate |
| Q2 engine integration | R1 structured run/report plus original agent-loop-omp.log and agent-goal-loop-omp.log | Original capture confirmed by author; terminal51.7μm and logged52.02μm mean are distinct |
| Q3 score normalization | bench/lib/closedloop.mjs; simulator plant-model.ts; R1 run.json | Three seeds, two governed writes each; weighted dimensionless score and finite grid, not optimizer superiority |
| Q4 controls and outputs | R1 scenarios.json results[].mission | One trace per process; write requests not independent device waveforms; WWTP mixed quantities separated; annealing99.84 and terminal100.08 kept distinct |
| Q5 782 checks | Nine original docs/benchmarks/benchmark-20261007*–20261009* benchmark.json checks[] | 237+273+272, nine sequential v0.7.57 software-suite executions, zero failed assertions; historical evidence, not current v0.8.0 validation |
| Q5 timing and 65/65/65 | docs/benchmarks/benchmark-20261009033810/timeline.jsonl | 96.105s S4,69.014s cadence; converged=false;66.046s S5 wait-to-restoration span |
| Q5 fault grades | docs/audit/2026-10-08-production-hardening-report.md; 2026-10-17-ack-baseline.md | Fault outcomes and flag-only contrast, not real-world fault-rate estimates |
| Q6 primary trajectory | bench/results/injection-pressure-loop-2026-10-18T12-37-22-157Z/summary.json | n=1,4+5bar steps,hold6s,weight31.28→32.30g,sink1.977→1.277%,flash0.019%final |
| Q6 partial guards and configuration | Same summary; scripts/e2e-injection-recipe-closedloop.mjs; real-harness-injection-20261018/report.md | Missing melt allowed; freshness uses newest available timestamp and does not establish per-sensor simultaneous freshness; scripted approval, emergency and trial interval0 disclosed |
| Q6 later check | injection-pressure-loop-2026-10-18T17-32-16-585Z/summary.json | Separate65→70bar,32.29→32.55g,not concatenated or counted as matched replication |
| October 23 direct-node boundary | bench/results/20261023151709-1pjk/scenarios.json and scenarios-benchmark.md | Eight refused candidates, zero writes, 31.25g final, attained=false; historical harness incompatible with current public route |
| October 23 recipe cadence boundary | bench/results/injection-pressure-loop-2026-10-23T15-25-20-318Z/summary.json | One1/1 verified45→50bar trial; refusals at66/132s under300s cadence; weight31.46g,sink1.837%,finalOk=false,update=null; restoration assertion also failed |
| Anonymous evidence availability | ../revision-2026-10-24/IEEE-TII-anonymous-evidence-2026-10-24.zip and its manifest/claim map | Historical anonymous bundle plus anonymous R11/R12 copies and original/delivered hashes; distinct from manuscript-source ZIP |
| Historical profile/composition checks | Evidence ZIP `revision-2026-10-25/software/current-software-tests.log` | Same focused 65 temporary/mock checks recorded on the v0.8.0 working tree on October 20, 24, and 25; historical software-contract evidence, not process-level evidence |
| Current revision unit suite | Evidence ZIP `revision-2026-10-25/software/current-full-software-tests.log` | 554/554 tests pass across seven suites, including the 20-case recipe-approval snapshot suite; temporary/mock-state software tests, not process-level or overall architecture evidence |
| Q7 current two-scene integration (R13) | `docs/audit/evidence/2026-10-25-current-cross-scene/phymvmqa0bv/report.json`; evidence ZIP `revision-2026-10-25/R13/{report.json,dataset-film,dataset-anneal,job-film-artifacts,job-anneal-artifacts}` and `R13-PROVENANCE.json` | Application-level scripted run: 50 pass, 0 fail, 2 model-gate refusals; 697/696 DAQ points, 658/655 dataset rows, 220/218 held-out test rows; no accepted model, optimization profile, recommendation, or dispatch. Archive correlations are 0.094874 (film, lag 2) and 0.052593 (anneal, lag 3); run-block-preserving recalculation from retained arrays gives 0.023668 (film, lag 1) and 0.046485 (anneal, lag 1). Runtime source was not pinned, so this is an audit calculation, not a replay. |
| Q7 exploratory pilot (R14) | `docs/audit/evidence/2026-10-23-optimizer-physical/phymvmpr1ld/report.json`; evidence ZIP `revision-2026-10-25/R14/{report.json,dataset-film,dataset-anneal,job-film-artifacts,job-anneal-artifacts}` | Initial alternative signal pairs; 51 pass, 0 fail, 2 model-gate refusals; included as selection history, not pooled with R13 |
| Current registered-harness E2E attempt | `docs/audit/evidence/2026-10-23-optimizer-physical/phymvmouh7w/report.json` | Attempt stopped before application-line creation because isolated loopback API was unavailable; excluded from outcome counts |
| Q8 current registered-harness simulator execution (R20) | Supplementary File S1: `revision-2026-10-25/R20/{evidence.json,R20-TRACE-MATRIX.csv,agentworkshop.log,simulator.log}`, runner and source snapshot | Six sequential model-selected task executions (three per scene); all six task, approval, receipt, active-run tag, and sample links pass; 76 checks passed, 0 failed; verified route ACK/result precedes 20-s delay and sample probe/ingest/query; task state checked after sample query, but task-completion-to-sample latency is not recorded; all six samples outside target; one simulator instance per scene, so not independent replicates; source package is a reconstruction kit, not an immutable replay release |
| Deterministic fixture replay (R21) | Supplementary File S1: `revision-2026-10-25/R21/{evidence.json,agentworkshop.log,simulator.log,fixture-cast-film.json,fixture-annealing.json}` plus runner source | Fresh isolated v0.8.0 app/simulator environment; two deterministic fixture tasks (one per scene); no LLM decision; both task-to-approval-to-trial-receipt/readback-to-active-run sample joins pass; 31/31 runner assertions pass including cleanup; software-path verification only, not a process replication or attainment test |
| Approval-context mutation refusal | `tests/recipe-approval-snapshot.test.ts`; Supplementary File S1 `software/approval-context-regression.log` | The 20-case mock-state approval suite passes; 12 pending-approval context mutations cover line, product, recipe, and active run for each of `recipe_apply`, `recipe_trial`, and `recipe_rollback(dispatch=true)`; every case is refused before a mock-driver write and creates no new execution record; software-contract evidence only, not process-level or overall architecture evidence |
| Q8 deterministic fixture diagnostic (R16) | Evidence ZIP `revision-2026-10-25/R16/evidence.json`, fixture traces, app/simulator logs, runner and fixture source | Earlier deterministic local OMP-RPC fixture, one approved `recipe_trial` per scene and one run-tagged sample after 20 s; no LLM; retained as a separate diagnostic, not pooled with R20 |
| Revised format | main.pdf; FILE-MANIFEST.json; `revision-2026-10-25/qa/` | Actual compiled page/type/figure/reference checks must use this revision's output; scholarly assessment is separate |

## Non-claims and remaining conditions

All reported plants are software simulators. Actual protocol I/O and real
engine tasks are not physical-plant evidence. Q7 is an exploratory two-scene
integration run after pilot-based signal-pair selection; both datasets failed
optimization eligibility or validation gates. Q8 completes six
model-selected, bounded registered-harness tasks with synthetic approval and
verified device receipts; each has one post-trial sample, and all six samples
remain outside their target bands. These executions share one simulator
instance per scene and use a SQLite fallback, not independent replications or
the normal online DAQ backend. They are not process-response trajectories.
The gate value is the maximum-
absolute Pearson correlation of first-differenced, row-aligned MV/CV values at
lags 1--3; it is distinct from the dataset report's raw-level cross-correlation
from the first training run. Held-out rows are overlapping 1-s windows from
two of six simulator runs per scene, not independent replications. No current successful
optimization_explore process-response trajectory, comparative optimization
benefit, human-oversight benefit, hard real-time guarantee or safety assurance
is established. Archive copies and within-trajectory commands are not
independent repetitions. The journal is attributable and deduplicated, not
an exhaustive tamper-evident ledger. Repaired software tests do not alter
historical records or retroactively validate historical behavior.

Historical reviews remain in earlier revision folders. The October 25
validation evidence is in `paper/tii/revision-2026-10-25/qa/`; the separate
blind reviewer round is recorded with that revision. Local checks do not
claim journal acceptance. See REPRODUCIBILITY.md for R1–R21 inputs,
objective definitions, original-log provenance and procedural replay limits.


# Claim–evidence ledger — 2026-10-26 revision

**Current evidence:** The active paper uses the September 28 simulator
protocol summary and four-scenario records indexed in
`resources/figure-source-data/four-scenario-2026-09-28.json`, a separate
onboarding replay in `qa/onboarding-repro-2026-10-26-v083-online/`, and the
mock approval-context tests identified in `REPRODUCIBILITY.md`. Each process
scenario contributes one deterministic trajectory; these checks do not
validate every feature of the architecture or human approval performance.

**Historical ledger:** The material below describes an earlier manuscript;
its claims about which tests are current, figure contents, and delivery packages
do not describe the active paper.

The earlier manuscript used a
four-path route study (R20--R23), an approval-context guard and ablation, and a
documented coating-line onboarding replay (R24). Fig. 6 and the optimization
subsection use the archived seed-42 four-scenario direct-node record in
`resources/figure-source-data/source-data-missions.json` and
`figures/make-missions-4x2.py`; that record is historical and is not pooled with
the route results. The 2026-09-28 campaign is retained in the archive as an
alternative record but is not used in this revision. Protocol inventories are
configuration metadata. The original mission logs were not edited. This ledger does not
establish publication readiness or journal acceptance.

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
| Current route-linked process samples (R20--R23) | Supplementary File S1: revision-2026-10-25 R20/R21/R22/R23 evidence; resources/figure-source-data/current-route-observations.csv | Twelve raw post-trial samples across four execution paths and two preconfigured simulator scenes; all below target. The route runs did not use the production MQTT/Timescale backends; R22 ran isolated with an in-process queue and SQLite storage. Not pooled with the archived four-scenario optimization record |
| Current coating-line onboarding replay (R24) | qa/onboarding-repro-2026-10-26-v083-online evidence | One documented simulator onboarding replay with a test-only smoke write; four DCW setpoints and seven DAQ nodes; separate from the archived four-scenario optimization record and not used to claim process quality |
| Archived four-scenario optimization record (Fig. 6) | `resources/figure-source-data/source-data-missions.json`; `figures/make-missions-4x2.py`; `bench/results/20260921184204-10lc/scenarios.json` | One seed-42 scripted direct-node trajectory per scenario; injection 31.25 -> 32.17 g, BOPET 28.10 -> 25.66 um, annealing 97.88--99.84 HV with a 100.08 HV endpoint, wastewater DO 0.214 -> 3.517 mg/L with a 3.50 mg/L mission-final reading; requests are not device readbacks; historical, not current-route, repeatability, or physical-plant evidence |
| Alternative 2026-09-28 campaign (not used in this revision) | `bench/results/20260928020612-1juc/`; `resources/figure-source-data/four-scenario-2026-09-28.json` | One deterministic simulator trajectory per scene; values differ from the seed-42 record used in Fig. 6; retained as an archived alternative and not mixed with the manuscript figure |
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
| Current revision unit suite | Evidence ZIP `revision-2026-10-25/software/current-full-software-tests.log` | 566/566 tests pass across seven suites, including the 20-case recipe-approval snapshot suite and 12-case context-guard ablation; temporary/mock-state software tests, not process-level or overall architecture evidence |
| Q7 current two-scene integration (R13; supplemental history, not a manuscript result) | `docs/audit/evidence/2026-10-25-current-cross-scene/phymvmqa0bv/report.json`; evidence ZIP `revision-2026-10-25/R13/{report.json,dataset-film,dataset-anneal,job-film-artifacts,job-anneal-artifacts}` and `R13-PROVENANCE.json` | Application-level scripted run: 50 pass, 0 fail, 2 model-gate refusals; 697/696 DAQ points, 658/655 dataset rows, 220/218 held-out test rows; no accepted model, optimization profile, recommendation, or dispatch. Archive correlations are 0.094874 (film, lag 2) and 0.052593 (anneal, lag 3); run-block-preserving recalculation from retained arrays gives 0.023668 (film, lag 1) and 0.046485 (anneal, lag 1). Runtime source was not pinned, so this is an audit calculation, not a replay. |
| Q7 exploratory pilot (R14) | `docs/audit/evidence/2026-10-23-optimizer-physical/phymvmpr1ld/report.json`; evidence ZIP `revision-2026-10-25/R14/{report.json,dataset-film,dataset-anneal,job-film-artifacts,job-anneal-artifacts}` | Initial alternative signal pairs; 51 pass, 0 fail, 2 model-gate refusals; included as selection history, not pooled with R13 |
| Current registered-harness E2E attempt | `docs/audit/evidence/2026-10-23-optimizer-physical/phymvmouh7w/report.json` | Attempt stopped before application-line creation because isolated loopback API was unavailable; excluded from outcome counts |
| Current registered-harness simulator execution (R20) | Supplementary File S1 R20 evidence, runner, and source snapshot | Six sequential task executions, three per scene; route links pass, but all six post-trial samples are outside target. This route study is reported in Section V-B and is not pooled with the archived four-scenario record |
| Deterministic fixture replay (R21) | Supplementary File S1: `revision-2026-10-25/R21/{evidence.json,agentworkshop.log,simulator.log,fixture-cast-film.json,fixture-annealing.json}` plus runner source | Fresh isolated v0.8.0 app/simulator environment; two deterministic fixture tasks (one per scene); no LLM decision; both task-to-approval-to-trial-receipt/readback-to-active-run sample joins pass; 31/31 runner assertions pass including cleanup; software-path verification only, not a process replication or attainment test |
| Approval-context guard and targeted ablation | `tests/recipe-approval-snapshot.test.ts`, `tests/recipe-approval-context-ablation.test.ts`; Supplementary File S1 `software/{approval-context-regression.log,approval-context-ablation.log}` | Production handler refused all 12 line/product/recipe/run mutations across three recipe routes before writes or execution records. A test-only variant omitting only the tuple comparison allowed 6/12 product/run mutations to proceed, each with two mock writes and one execution record; other checks blocked all line/recipe mutations. Component-level mock-state evidence only; not a platform-level baseline or process-level safety evidence |
| Direct operation route (R22) | `docs/audit/evidence/2026-10-25-current-cross-scene/direct-rest-trial-2026-10-25/run-EycMP7/{evidence.json,agentworkshop.log,simulator.log,README.md}` and `scripts/e2e-direct-rest-simulator-paper.mjs`; Supplementary File S1 `revision-2026-10-25/R22/` | One direct REST recipe-trial call per scene, no task/harness transport/LLM; synthetic approval and 1/1 verified receipt/readback per call; one active-run-tagged sample per scene, both outside target; 19/19 runner checks passed. This tests a second invocation route and two signal/protocol mappings, not another registered harness, process response, or attainment. |
| Second registered task adapter (R23) | `docs/audit/evidence/2026-10-25-current-cross-scene/r23-pi-registered-harness-20261025-031055-5cfe66/{evidence.json,agentworkshop.log,simulator.log,pi-model-api-trace.json,e2e-pi-simulator-paper.mjs}` and `scripts/e2e-pi-simulator-paper.mjs`; Supplementary File S1 `revision-2026-10-25/R23/` | One deterministic-fixture Pi task per simulator scene; both completed with synthetic approval, 1/1 verified ACK/readback, task-to-approval/trial/active-run/sample links, and run-tagged samples; 37 application and 28 isolation checks passed. Cast-film 46.38 μm (48–52 μm) and annealing 674.40 °C (700–760 °C), both below target. Tests this registered adapter configuration only, not model quality, process response, or general interchangeability. |
| Q8 deterministic fixture diagnostic (R16) | Evidence ZIP `revision-2026-10-25/R16/evidence.json`, fixture traces, app/simulator logs, runner and fixture source | Earlier deterministic local OMP-RPC fixture, one approved `recipe_trial` per scene and one run-tagged sample after 20 s; no LLM; retained as a separate diagnostic, not pooled with R20 |
| Revised format | main.pdf; FILE-MANIFEST.json; `revision-2026-10-25/qa/` | Actual compiled page/type/figure/reference checks must use this revision's output; scholarly assessment is separate |

## Non-claims and remaining conditions

All process outcomes in the current manuscript are generated by local
simulators. The current-version evidence is software-integration evidence:
route record links and node-binding preconditions (R20--R23), an
approval-context guard and ablation, and one documented blueprint-onboarding
replay (R24). The Fig. 6 seed-42 record is historical and contains one
trajectory per scene; it does not establish physical-plant behavior,
independent repeatability, or general portability. Its mission routines are
deterministic rather than model-selected. Route, onboarding, and
approval-context rows are manuscript findings, but none is a process-quality or
platform-baseline result.

Historical reviews remain in earlier revision folders. The October 25
validation evidence is in `paper/tii/revision-2026-10-25/qa/`; the separate
blind reviewer round is recorded with that revision. Local checks do not
claim journal acceptance. See REPRODUCIBILITY.md for R1–R25 inputs,
objective definitions, original-log provenance and procedural replay limits.


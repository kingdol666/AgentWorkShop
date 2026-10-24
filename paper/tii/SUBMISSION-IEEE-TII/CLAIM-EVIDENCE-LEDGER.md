# Claim–evidence ledger — 2026-10-24 revision

This ledger describes the current revision. Original numerical archives were
not edited. It supersedes earlier manuscript QA claims; publication readiness
is evaluated separately in revision-2026-10-24. Earlier verification reports
remain historical records.

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
| Q5 782 checks | Nine original docs/benchmarks/benchmark-20261007*–20261009* benchmark.json checks[] | 237+273+272, nine sequential software suite executions, zero failed assertions |
| Q5 timing and 65/65/65 | docs/benchmarks/benchmark-20261009033810/timeline.jsonl | 96.105s S4,69.014s cadence; converged=false;66.046s S5 wait-to-restoration span |
| Q5 fault grades | docs/audit/2026-10-08-production-hardening-report.md; 2026-10-17-ack-baseline.md | Fault outcomes and flag-only contrast, not real-world fault-rate estimates |
| Q6 primary trajectory | bench/results/injection-pressure-loop-2026-10-18T12-37-22-157Z/summary.json | n=1,4+5bar steps,hold6s,weight31.28→32.30g,sink1.977→1.277%,flash0.019%final |
| Q6 partial guards and configuration | Same summary; scripts/e2e-injection-recipe-closedloop.mjs; real-harness-injection-20261018/report.md | Missing melt allowed, max timestamp freshness, scripted approval, emergency and trial interval0 disclosed |
| Q6 later check | injection-pressure-loop-2026-10-18T17-32-16-585Z/summary.json | Separate65→70bar,32.29→32.55g,not concatenated or counted as matched replication |
| October 23 direct-node boundary | bench/results/20261023151709-1pjk/scenarios.json and scenarios-benchmark.md | Eight refused candidates, zero writes, 31.25g final, attained=false; historical harness incompatible with current public route |
| October 23 recipe cadence boundary | bench/results/injection-pressure-loop-2026-10-23T15-25-20-318Z/summary.json | One1/1 verified45→50bar trial; refusals at66/132s under300s cadence; weight31.46g,sink1.837%,finalOk=false,update=null; restoration assertion also failed |
| Anonymous evidence availability | ../revision-2026-10-24/IEEE-TII-anonymous-evidence-2026-10-24.zip and its manifest/claim map | Historical anonymous bundle plus anonymous R11/R12 copies and original/delivered hashes; distinct from manuscript-source ZIP |
| Revised format | main.pdf; FILE-MANIFEST.json; ../revision-2026-10-24/qa/ | Actual compiled page/type/figure/reference checks must use this revision's output; scholarly assessment is separate |

## Non-claims and remaining conditions

All reported plants are software simulators. Actual protocol I/O and real
engine tasks are not physical-plant evidence. No current complete
optimization_explore process-response trajectory, comparative optimization
benefit, human-oversight benefit, hard real-time guarantee or safety assurance
is established. Archive copies and within-trajectory commands are not
independent repetitions. The journal is attributable and deduplicated, not
an exhaustive tamper-evident ledger. Repaired software tests do not alter
historical records or retroactively validate historical behavior.

Historical reviews remain in earlier revision folders, including the October
20 five-seat review and final verification. This revision's evidence audit,
official requirements and validation records are in
../revision-2026-10-24/. Local checks do not claim journal acceptance. See
REPRODUCIBILITY.md for R1–R12 inputs,
objective definitions, original-log provenance and procedural replay limits.


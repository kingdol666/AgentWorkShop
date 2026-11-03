# Reproducibility Notes: Simulated Multi-Scene Evaluation

This note records the evidence used by the current manuscript and its
Supplementary File S7. It replaces the earlier single-run note that referenced
Supplementary File S6 and commit `60fa983e`.

## Recorded environment

- Runtime: Node.js 24.19.0, Windows 11 x64.
- Platform: isolated service on port 3005; scenario simulator on port 4011.
- Platform manifests record source commit `da627d21`.
- The experiment runners were uncommitted at execution time and were later
  committed as `40533741`. The recorded commit therefore identifies the
  platform source, not a hermetic working tree.
- E1, E2, E4, and the approval/authorization calls ran with
  `AW_BENCH_MODE=1`, which relaxes normal timing and hold-window guards.
  Production-guard checks ran in a separate process with the variable absent.
- The platform and simulator were already running; no cold-start deployment
  was tested.

## Evidence blocks

| Block | Run identifier(s) | Recorded outcome |
|---|---|---|
| Integrated pipeline | `20261101103641-9j8`, `20261101104849-xu0` | 77/77 assertions each, 0 warnings, 0 failures, 17 phases |
| E1 scene--protocol probes | `20261101121221-scenario-probes` | 220/220 admissible accepted, 219/219 collected structural rejected, 216/216 available readbacks matched |
| E2 C0 no-write | `20261101111725`, `20261101112030`, `20261101112336`, `20261101112641`, `20261101112947` | 0/15 endpoints in band; seed 42 began from residual state |
| E2 C1 scripted | `20261101110211`, `20261101110502`, `20261101110755`, `20261101111053`, `20261101111330` | 15/15 first in-band readings; 12 blueprint-matched pairs |
| E4 four-arm ablation | `20261101103356-e1lite` | 18/18 vs 12/18 negative rejections; 0/6 vs 6/6 targeted violations |
| E4 production guards | `20261101113644-production-guards` | L2--L6 each rejected with the expected code; legal baseline accepted |
| E3 approval route | `20261101121436-approval-gate` | Four scripted calls; approved 202→204.8, rejected 216→216 |
| E3 authorization | `20261101121415-authorization` | Unbound and cross-node rejected; bound write accepted 240→241 |
| E5 Agent pilot | `20261102103639-agent-multiround`, `20261102105040-agent-multiround` | Two recorded episodes, zero governed writes; one implicit `COMPLETED`, one `BUDGET_TIMEOUT` |

## Inference limits

- C0 and C1 were not time-matched. C1 used the `recipe_trial` batch route, not
  the single-node `optimization_explore` route, and stopped at its first
  in-band reading. The comparison is descriptive; no p-values or
  population-level intervals are reported.
- C0 seed 42 began from residual state rather than the scenario blueprint;
  the manuscript reports both the 12 blueprint-matched pairs and the 15-run
  totals.
- E1 admissible and structural values were derived from the same configured
  minimum and maximum used by the guard. The result is a consistency check of
  the configured mapping, not an independent estimate of range correctness.
  Simulator readback is an echo of the configured value, not actuator
  application.
- E4 uses three technical repetitions of deterministic stimuli, not
  independent trials. Counts are reported without p-values.
- The positive blocks used direct or scripted clients. No live harness issued
  a governed write. The Agent pilot is reported as a negative result.
- No physical plant, PID/model-predictive baseline, operator study, or
  cold-start deployment was tested.

## Data package

Supplementary File S7 contains the run manifests, selected raw CSVs, per-seed
outcomes, ablation records, the production-guard log, the approval and
authorization records, and the negative Agent pilot. The delivered package
preserves source records; it is not a complete runtime image.

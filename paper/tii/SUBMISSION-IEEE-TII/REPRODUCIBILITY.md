# Reproducibility Notes: Simulated Multi-Scene Evaluation

This note identifies the records used in the manuscript and states what can
and cannot be reproduced from the archived package. It supersedes the earlier
single-run note that referred to Supplementary File S6 and commit `60fa983e`.

## Recorded environment

- Node.js 24.19.0 on Windows 11 x64.
- An isolated platform service on port 3005 and scenario simulator on port
  4011.
- Platform manifests record source commit `da627d21`.
- The runners were uncommitted during execution and were later committed as
  `40533741`. The recorded platform commit does not identify a hermetic
  runtime tree.
- The integrated pipeline, mapping probes, policy comparison, guard ablation,
  and approval/authorization calls ran with `AW_BENCH_MODE=1`; this relaxes
  normal timing and hold-window checks. Production-mode guard checks used a
  separate process without that setting.
- The platform and simulator were already running. Cold-start deployment was
  not tested.

## Evidence records

| Evidence block | Run identifiers | Recorded result |
|---|---|---|
| Integrated pipeline | `20261101103641-9j8`, `20261101104849-xu0` | 77 passing assertions per run, no warnings or failures, 17 phases |
| Scene--protocol probes | `20261101121221-scenario-probes` | 220/220 admissible requests accepted, 219/219 collected structural probes rejected, 216/216 available readbacks matched |
| No-write control | `20261101111725`, `20261101112030`, `20261101112336`, `20261101112641`, `20261101112947` | 0/15 endpoints in band; seed-42 injection and wastewater runs began from residual states |
| Scripted setpoint policy | `20261101110211`, `20261101110502`, `20261101110755`, `20261101111053`, `20261101111330` | 15/15 final recorded endpoints in band; 12 blueprint-matched pairs |
| Process-window guard ablation | `20261101103356-e1lite` | 18/18 versus 12/18 negative probes rejected; 0/6 versus 6/6 targeted violations reached the driver |
| Production-mode guard checks | `20261101113644-production-guards` | The five configured negative cases were rejected as expected; the legal baseline was accepted |
| Approval-route pilot | `20261101121436-approval-gate` | Four scripted calls; approved request changed 202 to 204.8, rejected request remained at 216 |
| Authorization probe | `20261101121415-authorization` | Unbound and cross-node requests rejected; bound write accepted, 240 to 241 |
| Live-Agent pilot | `20261102103639-agent-multiround`, `20261102105040-agent-multiround` | Two recorded episodes, zero governed writes; one `COMPLETED` status outside the target band and one `BUDGET_TIMEOUT` |
| Follow-up injection pilot | `pexp-mw0dmt4v-na04`; 2026-11-03 07:43:08 UTC; line `ln-00e0726d` | One simulated-twin execution, three setpoint interventions, one contrast marked identifiable by the script, matching readback after a later write, and a 32.224-g observation inside the configured band |

The structured pilot record gives the baseline weight as 31.502563 g
(31.503 g rounded), whereas its accompanying report states 31.508 g. Both
are below the stated target band; the difference has not been resolved from
the archived source records.

The follow-up pilot is separate from the November 1 batch. Its manifest sets
`realPlant=false`; an acceptance script ran the workflow, not an active Agent.
The JSON records three intervention verdicts (`no_resolvable_effect`,
`underpowered`, and `identifiable_effect`), along with aggregate effect and
minimum-detectable-effect fields. It does not include the sample series or the
rule used to calculate the MDE and assign those verdicts. The reported gain of
0.05035 g/bar is the stored 55-to-60 effect divided by the 5-bar step; it is a
source-reported single-run ratio, not an independently verified process
model. The final observation followed a 60-s wait and averaged
the three latest 15-s DAQ buckets. Its 15/15 result counts assertions from one
execution, not independent trials. The acceptance report describes a v0.9.4
starting point with same-PR fixes and a resulting v0.9.5 version; the run
record has no platform commit, simulator snapshot/configuration hash, or
runner-source hash. It does not identify a hermetic source snapshot.

Later system-acceptance suites are software QA using different fixtures, not
additional paper outcomes. For example, the November 3 scientific-fullchain
suite used a mock device layer, an injected response fixture, and an
SQLite-emulated time-series backend. Its assertion counts are not comparable
to the process observations above.

## Runner and configuration provenance

The no-write/scripted-policy runner pair records harness hash
`c1a7be7f279732fa`. The `optimization-control.mjs` and
`bench/lib/scenarios.mjs` files from commit `40533741` reproduce that hash
with the Windows checkout line endings. This is the only experiment block
with a verified runner-pair match in the available source history.

Other provenance is incomplete. The integrated-pipeline harness hash
`f706e5b4d0fa4462` does not match the corresponding available source version.
The scene--protocol record's `a66769851fa03de5` value is a harness hash, not
a configuration hash. The guard-ablation configuration hash
`3a57e722d4764b98` has no archived configuration preimage. Approval,
authorization, production-guard, and live-Agent records do not include a
matching runner-source hash. The November 3 pilot is also missing a platform
commit, simulator/configuration snapshot, and runner-source hash.

The archive preserves run outputs and metadata, but it is not a complete
runtime image. Re-running commands may create new result identifiers and
different simulator trajectories if service state or environment changes.
The frozen evidence package is
`Supplementary-File-S7-data-2026-11-04.zip` (SHA-256
`44b37d775b943b7d14a6b2038057edde0842ea2adaf4c9e07c2a7503a968fdaf`).

## Inference limits

- The no-write control and scripted setpoint policy were not time-matched.
  The policy used the `recipe_trial` batch route and recorded the final
  process value after scenario-specific steps; the control used a fixed 60-s
  interval and a final-five sample mean. The contrast is descriptive; no p-values or population-level
  intervals are reported.
- The reported 150.41–172.90 s values are the wall times of the three-scene
  parallel batches, including setup, not individual scene times to target.
- The no-write seed-42 injection and wastewater runs began from residual
  states (32.378 g and 2.894 mg/L, respectively), both inside the target band.
  The 12 blueprint-matched pairs use seeds 43--46 across the three scenes; the
  manuscript also reports totals for all 15 runs per routine.
- Admissible and structural probe values were derived from the same configured
  minimum and maximum used by the guard. This checks consistency with the
  configured mapping, not whether the limits are independently correct.
  Simulator readback echoes the configured value; it does not prove actuator
  application.
- One planned structural probe was not collected. HTTP nodes do not expose
  readback, and the full scene--protocol matrix remains incomplete.
- The guard ablation used three technical repetitions of deterministic
  stimuli, not independent trials. No readback-mismatch stimulus was included.
- Approval decisions were scripted. The positive blocks used direct or
  scripted clients; no live harness issued a governed write.
- The follow-up injection pilot was one scripted simulated-twin execution.
  Its single contrast marked "identifiable" by the script does not provide a
  replicated gain estimate or establish active-Agent or physical-plant
  performance.
- No physical plant, PID/model-predictive baseline, operator study, or
  cold-start deployment was tested.

## Data package

Supplementary File S7 contains the run manifests, selected raw CSVs, per-seed
outcomes, guard-ablation records, production-guard log, approval and
authorization records, negative live-Agent pilot, and the separately
documented follow-up injection pilot. The earlier November 2 archive is
preserved separately.

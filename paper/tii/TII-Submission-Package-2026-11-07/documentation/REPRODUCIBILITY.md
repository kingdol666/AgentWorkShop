# Reproducibility Notes: Simulated Multi-Scene Evaluation

This note summarizes the archived experiments. The curated package's runnable
entry points and file locations are documented in the package-root `README.md`;
the selected offline tools are under `reproducibility-tools/`.
Repository paths such as `bench/lib/...` below identify the original full
AgentWorkShop checkout and archived-run provenance; that full source tree is
not part of this paper package.

This note identifies the records used in the manuscript and states what can
and cannot be reproduced from the archived package. It supersedes the earlier
single-run note that referred to Supplementary File S6 and commit `60fa983e`.

## Package identity and current workspace status (2026-11-07)

The November 1--2 core batch is `Supplementary-File-S7-data-2026-11-04.zip`
(SHA-256
`44b37d775b943b7d14a6b2038057edde0842ea2adaf4c9e07c2a7503a968fdaf`).
The curated `S7-core.zip` preserves its raw evidence files and adds an
interpretation note for the runner-derived driver-arrival labels, with refreshed
internal manifests. It is not byte-identical to the source archive; the
byte-identical original is preserved at
`paper/tii/build-artifacts/TII-Submission-Package-2026-11-07/S7-core-original-before-interpretation-note.zip`. The corrected
November 5 follow-up is `Supplementary-File-S7-followup-2026-11-05-r1.zip`
(SHA-256
`704ef332646fee0b9bbb3919f1a456b31e920c8deaf75867033bb0c233518622`);
`S7-followup.zip` is its byte-identical alias. Both follow-up archives remain
separate from the core results. `S7-agent-followup.zip` (SHA-256
`3189562d644e08ebe4d53dcb4ceb2d28bbc39823bc2bca692cb675cc4f4cee74`) contains
selected Agent records, not a complete event trace or frozen runtime.

`Supplementary-File-S7-data-2026-11-05.zip` has a stale internal manifest and
is not included in this curated package. Use the separate `S7-core.zip`,
`S7-followup.zip`, and `S7-agent-followup.zip` archives in `supplementary/`.
The package-root `manifest.json` records SHA-256 hashes of the curated package
files; it excludes itself and generated `build/` files. It identifies this
package snapshot, not a frozen source revision or runtime image. The individual
S7 archive hashes identify the preserved evidence batches.

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
| Process-window guard ablation | `20261101103356-e1lite` | 18/18 versus 12/18 negative probes rejected; 0/6 versus 6/6 targeted violations returned HTTP 200; driver calls were not independently logged |
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
The source core ZIP before the package-level interpretation note had SHA-256
`44b37d775b943b7d14a6b2038057edde0842ea2adaf4c9e07c2a7503a968fdaf`. The
curated archive preserves the original report and CSV bytes; its current
package hash is recorded in `manifest.json`.

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

## Latest E6/E7 records and remaining scope (2026-11-07)

The canonical E0--E7 execution contract is
`PAPER-EVIDENCE-PIPELINE.md` in this documentation folder. The archive `S7-e6-e7-2026-11-07.zip` preserves a frozen E6 plan, a separate
pilot, 11 post-pilot fixed-horizon scene--seed attempts, and three E7 simulator
episodes. E6 is a partial, exploratory two-arm comparison: nine pairs were
valid, two were retained as invalid because C0 had a sampling gap, and all nine
valid paired IAE differences were positive. The deterministic `recipe_trial`
policy was compared with no-write; no PID or Agent policy arm was included.
The E7 episodes were all canceled and remained below the target band. The local
recorder reports two writes in two rounds per episode, but the archive lacks a
server-side journal export for independent reconciliation. These observations
are not a powered control-effect estimate or an Agent success-rate estimate.

The included E6 trajectory validator checks fixed-grid, fixed-horizon paired
`no_write`/`scripted` fixture data and calculates per-scene trapezoidal IAE and
paired differences; it is not the acquisition adapter and does not independently
verify reset, DAQ freshness, or source events. PID and Agent arms are not
supported by its current schema. The E7 utility registers Harness/model
configurations and inventories episode outcomes but does not call a model or
live harness. New multi-arm E6 acquisition and controlled cross-Harness E7
comparison remain unimplemented. The earlier 15/15 versus 0/15 endpoints came
from unequal protocols and remain historical descriptive evidence only.

## Data package

`supplementary/S7-core.zip` contains the core run manifests, selected raw CSVs,
per-seed outcomes, guard-ablation records, approval and authorization records,
and the negative live-Agent pilot. `S7-followup.zip`, `S7-agent-followup.zip`, and
`S7-e6-e7-2026-11-07.zip` preserve separate later batches; they are not pooled.

## November 5 follow-up (separate batch)

`supplementary/S7-followup.zip` is the corrected, self-contained follow-up
package. It restores the preflight `qualify.json` record and two Agent logs,
adds an interpretation erratum for the readback-delta label, and includes a
root manifest for its other members. The batch is not pooled with the frozen
November 1 data. The matrix returned 110/110 recipe-window rejections; the one
injected simulated readback mismatch was marked unverified; two Agent episodes
were canceled with zero writes. The preflight listed available model names but
did not execute a completion, and its governed write was scripted, not issued
by an Agent. Already-running service versions and the complete configuration
were not captured; the mismatch runner has no recorded hash. The batch report
marks the Agent result unknown and the overall result not passing.

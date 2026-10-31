# Anonymous reproducibility notes

This document accompanies the 2026-10-25 revision, targeting at most ten pages.
Paths below are relative
to the repository root. Reported plant experiments use software simulators;
registered protocol-driver execution against them and live language-model
tasks do not constitute physical-plant validation. On October 25, the local v0.8.0 working-tree
application completed a two-scene simulator integration run. Protocol reads,
bounded writes, readback and dataset lineage passed in both scenes; both
process-model candidates were rejected by the configured eligibility or
validation gates. An initial exploratory run with alternative signal pairs
also failed the gates and is retained as selection-history evidence. These
runs establish neither successful optimization nor a confirmatory estimate
of model performance. R16 is an earlier deterministic fixture diagnostic.
R20 is the reportable live-agent registered-harness run: six model-selected task
executions, three sequential per scene, each completed with synthetic
approval and a verified receipt. After verifying the trial result and route
readback, the runner waited 20 s and then obtained, ingested, and queried one
run-tagged sample through an isolated SQLite fallback. Task state was checked
after the sample query, so task-completion-to-sample latency is not recorded.
All six samples remained outside their target bands. R21 is a separate
deterministic fixture replay on a fresh isolated current-version application
and simulator: one task per scene, no LLM decision, and 31/31 runner
assertions passed, including cleanup. It verifies a scripted software path,
not an independent real-agent or process-performance replication. An earlier
harness attempt stopped before application-line
setup because its isolated loopback application was unavailable and is
excluded from outcome claims.

## Separate delivery packages

The LaTeX source ZIP contains the manuscript, active figure assets and figure
source data. The separate `IEEE-TII-anonymous-evidence.zip` contains copied,
anonymized experimental archives, original engine-log evidence, available
execution logs, replay/analysis source snapshots, and a claim-to-artifact map.
Its manifest identifies original and delivered SHA-256 hashes and redaction
rules. The private originals remain unchanged. The claim map records unknown
fields as null and identifies duplicated archives without counting replicates.
The delivered bundle is retained at
`paper/tii/revision-2026-10-25/IEEE-TII-anonymous-evidence-2026-10-25.zip`.
It extends the October 20 anonymous bundle with anonymous R11/R12 copies, the
current v0.8.0 software rerun, the blocked harness-attempt record, the two
current-version simulator runs (Q7/R13 and its exploratory pilot/R14), the
R16 fixture diagnostic, the model-driven registered-harness run (Q8/R20), the
current deterministic fixture replay (R21), and an updated
original/delivered-hash manifest. The delivered root index and claim map are
updated to cover Q7--Q8 and R21; historical numerical entries are preserved. The
underlying historical bundle's
root `README.md`, `CLAIM-MAP.json`, `MANIFEST.json`, `FILES.json`,
`DUPLICATES.json` and `MISSING-EVIDENCE.json` explain the archive layout,
locate Q1--Q7 claims, and distinguish absent fields from zero values.
`python verify_bundle.py` checks the extracted copy using only Python's
standard library; it does not contact a service or issue controls.

Historical and current source snapshots are labelled separately. A source
commit recorded in a run does not prove that every uncommitted harness file
matched that commit. The supplement therefore distinguishes exact archived
outputs from available replay source; it is not a standalone full-runtime
distribution or a claim that old scripts execute unchanged against current
channel profiles. R6 has no archived exact commit, seed, or per-sensor timestamp
series; the delivered mapping keeps those fields unavailable.
Specifically, R1 records commit `e692df1` and an 11-file harness fingerprint
`9f2756dce4a4cbb3`, while that committed pipeline fingerprints nine files.
The bundle includes both the recorded commit and current inspection
snapshots, with their separate hashes in `SOURCE-SNAPSHOT-STATUS.json`;
neither is silently substituted for the unarchived exact runtime worktree.

## Evidence tiers

| ID | Manuscript | Owning artifacts | Evidence unit and limit |
|---|---|---|---|
| R1 | Q1–Q4 integrated snapshot | `bench/results/20260921184204-10lc/{run.json,report.md,scenarios.json,metrics.csv}` | Historical direct-node interface; seed 42 scenario trajectories, three seeds only for Q3 |
| R2 | Q1 admission ablation | `bench/results/20260921181234-e1lite/{e1-lite.csv,report.md,run.json}` and companion integrated report | Six probe classes × three deterministic repetitions per arm; not independent production batches |
| R3 | Q5 historical regression | `docs/benchmarks/benchmark-20261007*`, `benchmark-20261008*`, `benchmark-20261009*` | Nine sequential v0.7.57 suite executions; 237 + 273 + 272 = 782 assertions, not 782 plant samples or v0.8.0 results |
| R4 | Q5 timestamp figure | `docs/benchmarks/benchmark-20261009033810/timeline.jsonl` | 21 archived events; S4 observation-to-verification 96.105 s; no converged terminal quality claim |
| R5 | Q5 write grading | `docs/audit/2026-10-08-production-hardening-report.md`, `docs/audit/2026-10-17-ack-baseline.md` and associated log | Injected fault outcomes; not estimates of fault frequency |
| R6 | Q6 primary recipe trajectory | `bench/results/injection-pressure-loop-2026-10-18T12-37-22-157Z/summary.json` | One sequential trajectory, four +5 bar requests, five quality snapshots; fixed hold time 6 s |
| R7 | Q6 failed earlier attempt | `bench/results/injection-recipe-closedloop-2026-10-18T11-23-30-084Z/summary.json` | Cadence refusal and missed quality target, retained as a boundary |
| R8 | Q6 separate October 18 check | `bench/results/injection-pressure-loop-2026-10-18T17-32-16-585Z/summary.json` | Separate 65→70 bar check from a different initial state; not appended to R6 |
| R9 | Interface isolation | `tests/high-risk-tool-scope.test.ts`, `tests/tool-profile-observer.test.ts`, `tests/recipe-propose.test.ts` | 26 tests within the combined R10 set, in temporary/mock state; not an end-to-end process experiment |
| R10 | Composition regressions | `tests/manual-approval-optimization.test.ts`, `tests/recipe-approval-snapshot.test.ts`, and related approval/profile/recipe suites | Same 65 checks passed October 20, 24, and 25; the October 25 run used the local v0.8.0 working tree; repeated checks are not additional assertions and do not constitute process E2E |
| R11 | October 23 direct-node replay boundary | `bench/results/20261023151709-1pjk/{scenarios.json,scenarios-benchmark.md}` | Current public interface refused eight attempts; zero writes, final weight 31.25 g, target not attained |
| R12 | October 23 recipe cadence boundary | `bench/results/injection-pressure-loop-2026-10-23T15-25-20-318Z/summary.json` | One verified pressure trial; later cadence refusals, target and restoration assertions failed, no saved update |

The separate infrastructure-blocked harness attempt is included as
`revision-2026-10-25/software/current-simulator-harness-blocked.json`. It
loaded the cast-film simulator model but failed to reach the isolated
loopback application before creating a line or collecting samples. It is not
the October 25 Q7 run and is not counted as a process outcome.

## Q7 current-version simulator integration

Q7 ran against the local v0.8.0 working tree with an isolated application,
temporary TimescaleDB, data home and two repository simulator presets. The
cast-film configuration connected `ScrewSpeedSP` (OPC UA) to `thick` (MQTT);
the annealing configuration connected the zone-3 furnace setpoint to
`StripTemp` through Modbus TCP. Across the two presets, all five configured
driver families passed read probes. Each initial DCW write and all six
bounded setpoint steps per scene were verified by readback. Six sequential
120-s windows were collected per scene at a 1-s cadence. The DAQ reported 697
cast-film points and 696 annealing points; the lineage-verified model datasets
contained 658 and 655 rows, respectively. This is one dataset per scene, not
six independent process replicates. Starting values were 125 rpm and
735$^{\circ}$C. Each 1-s-sampled window stepped to the scene's initial value
$\pm15$ at 60 s, alternating sign across the six windows; every adjacent
change was at most 30 units. The versioned specifications used trainer
`linear_arx@1` (which emits `linear_state_space@1` artifacts), first-order
input/output, ridge $10^{-4}$, eight history steps, a four-step horizon and
seed 42. Requested validation and test split ratios were each 40\%, with
rows grouped by run ID; each split contained two of the six runs per scene.
The resulting train/validation/test row counts were 219/219/220 for cast film
and 218/219/218 for annealing.

The available candidate eligibility evaluator, which is not source-pinned to
R13, builds one aligned MV/CV value per dataset row: $m_i$ is the final sample
of row $i$'s history window and $c_i$ is the first sample of its target
horizon. It first-differences both rowwise series, then computes
\[
r_{\Delta}(\ell)=\operatorname{corr}(\Delta m_i,\Delta c_{i+\ell})
\]
for positive lags 1 through $\max(1,\lceil\mathrm{delayMs}/\mathrm{beatMs}\rceil+3)$,
using rows for which both shifted values are defined.
For R13, delayMs was 0 and beatMs was 1000, so the search covered lags 1--3
rows; the candidate evaluator reports the coefficient at the lag with greatest
absolute magnitude and blocks if $|r_{\Delta}|<0.2$. The archived report gives 0.094874 at lag 2
for cast film and 0.052593 at lag 3 for annealing.

The retained arrays are ordered in the six run blocks listed in each dataset
manifest. A retrospective calculation that keeps those blocks separate and
does not difference across run boundaries yields maximum absolute
correlations of 0.023668 at lag 1 for cast film and 0.046485 at lag 1 for
annealing. These coefficients differ from the archived full-array values.
Since the R13 runtime source was not pinned, the archive cannot establish
whether the discrepancy arose in the executed eligibility implementation;
the manuscript reports both the archived outputs and this run-aware audit
result.

The dataset builder also emits a separate descriptive lag estimate from raw
control and target levels in the first training run, scanning lags from -20
through 20 rows. This report gave $r=0.986$ at lag 8 for cast film and
$r=0.852$ at lag 13 for annealing. These estimates differ in transform,
population, and lag search from the eligibility statistic; they are not used
by the gate and are not interpreted as causal-response evidence.

The held-out test split used two of six run IDs per scene: 220 sliding rows
for cast film and 218 for annealing. These one-second windows overlap within
each run and are serially dependent, not independent replications. The
reported test NRMSE is one-step. Four-step rollout NRMSE was 0.279019
(cast film) and 0.366115 (annealing), against persistence NRMSE 0.324848 and
0.384704, respectively. Relative rollout reduction is
$1-\mathrm{NRMSE}_{\mathrm{rollout}}/\mathrm{NRMSE}_{\mathrm{persistence}}$,
giving 14.1078\% and 4.8321\%; the configured minimum is 20\%. The one-step
test NRMSE values were 0.258734 and 0.363223, against a configured maximum of
0.10. Both candidates were fitted but blocked by eligibility or validation
gates; no accepted model, optimization profile, recommendation or dispatch was
produced. The run recorded 50 passed checks,
zero failed checks and two gate-blocked outcomes.

The checked-in candidate evaluator computes normalized RMSE as
$\mathrm{RMSE}/s_{\mathrm{train}}$, where $s_{\mathrm{train}}$ is the target
standard deviation from the training split. The R13 report does not identify
the exact application revision or evaluator hash, so this formula cannot be
conclusively attributed to the archived run's NRMSE values. The paper reports
the retained metrics without claiming that this retrospective candidate
implementation is the verified runtime definition.

The reported signal pairs were selected after an exploratory pilot using
screw-speed-to-melt-pressure and zone-1-to-furnace-temperature pairs. The
pilot produced 582 DAQ points per scene and 539/538 fit rows; delayed-response
correlations were 0.132956 and 0.086654, while test NRMSE values were 0.1119 and
0.5896. The annealing pilot's rollout improvement was $-15.0\%$. Both
pilot models failed gates. The pilot is included separately as R14, along
with its report, datasets and fit diagnostics. Q7/R13 is therefore an
integration and gate-behavior demonstration after exploratory pair selection,
not a pre-registered or unbiased model-performance evaluation. Neither run
used physical equipment, an external language-model service, or the simulator
truth/optimum endpoint. Raw reports, dataset arrays, model diagnostics and the
available candidate test script are provided under `revision-2026-10-25/R13/`
and `R14/` in the anonymous evidence ZIP. The R13 report does not record the
exact application revision, test-script hash, lockfile hashes, or installed
dependency trees. `revision-2026-10-25/R13-PROVENANCE.json` documents
retrospective source observations and their limits; it does not establish a
fully source-pinned replay.

| ID | Manuscript | Owning artifacts | Evidence unit and limit |
|---|---|---|---|
| R13 | Q7 final two-scene simulator integration | `revision-2026-10-25/R13/{report.json,execution.log,dataset-film/,dataset-anneal/,job-film-artifacts/,job-anneal-artifacts/}` and `revision-2026-10-25/R13-PROVENANCE.json` | One local v0.8.0 application-level run; 50 checks passed, 2 model-gate outcomes blocked, no accepted model/profile/recommendation/dispatch; exact run-time source and dependencies were not pinned |
| R14 | Q7 exploratory signal-pair pilot | `revision-2026-10-25/R14/{report.json,execution.log,dataset-film/,dataset-anneal/,job-film-artifacts/,job-anneal-artifacts/}` | Alternative pairs; both model gates failed; selection history only, not pooled with R13; exact run-time source was not recorded |
| R15 | Earlier infrastructure-blocked harness attempt | `revision-2026-10-25/software/current-simulator-harness-blocked.json` | No application line or process samples; excluded from process outcome claims |
| R16 | Deterministic registered-harness fixture diagnostic | `revision-2026-10-25/R16/{evidence.json,agentworkshop.log,simulator.log,fixture-cast-film.json,fixture-annealing.json}` plus runner and fixture source | One deterministic OMP-RPC `recipe_trial` per scene; synthetic approval; 1/1 verified ACK/readback; one 20-s run-tagged sample per scene; no LLM; kept separate from R20 |
| R20 | Current registered-harness simulator execution (Q8) | `revision-2026-10-25/R20/{evidence.json,R20-TRACE-MATRIX.csv,agentworkshop.log,simulator.log,R20-SUMMARY.md}` and runner source | Six model-selected sequential tasks, three per scene; 6/6 task-to-approval-to-verified-receipt-to-run-tagged-sample links pass; 76 checks passed, 0 failed; verified route ACK/result precedes the 20-s delay and sample probe/ingest/query; task state checked after the query, but task-completion-to-sample latency is not recorded; all samples outside target; not independent replications |
| R21 | Deterministic fixture replay of current registered-harness path | `revision-2026-10-25/R21/{evidence.json,agentworkshop.log,simulator.log,fixture-cast-film.json,fixture-annealing.json}` plus runner source | Fresh isolated current-version app/simulator environment; one deterministic task per scene; no LLM decision; both scenes pass dispatch, synthetic approval, verified receipt/readback, and run-tagged probe checks; 31/31 runner assertions pass including cleanup; scripted path verification only, not process replication or attainment |

`bench/results/real-harness-injection-20261018/closedloop-summary.json`
duplicates R6 byte for byte. It does not add a replicate. Its `report.md`
documents the simulator endpoint and live read-only agent task. Three
`real-injection-closed-loop` execution logs record failed attempts rather
than successful repetitions.

R11 and R12 are newer than the October 20 anonymous evidence ZIP. They are
separate evidence units, not additional successful repetitions of R6. The
October 25 supplement extends that historical bundle; the older ZIP alone
does not cover these new manuscript statements.

## Q1 latency statistic

The archive's `p50` implementation in `bench/lib/metrics.mjs` returns the
ascending-order element at zero-based index `floor(n/2)`, hence the fourth
of six write latencies. The manuscript calls this the **upper median**.
It is not the arithmetic mean of the third and fourth observations. The
reported `p95` is the sixth observation for this sample size, so it is
described as the observed maximum, not a population tail estimate. No
unarchived individual latencies are reconstructed or substituted.

## Q3 objective and admissible reference grid

The cast-film score is dimensionless:

```text
J = 55*J_thickness + 25*J_quality + 8*J_energy + 7*J_throughput
e = abs(thickness_um - 50)
J_thickness = 1                       if e <= 2
              max(0, 1-(e-2)/10)     otherwise
J_quality = 1 - min(defect_percent, 8)/8
J_energy = 1 - (screw_rpm-50)/150
J_throughput = line_speed_m_per_min/120
```

The energy and throughput terms are simulator/control proxies, not
independently measured plant energy or output. A state is ineligible if
melt temperature is outside 195–225 degrees Celsius or melt pressure
exceeds 22 MPa. `bench/lib/closedloop.mjs:34` encodes the observation-side
score; `plc-node-simulator/src/server/engine/plant-model.ts:290` encodes
the simulator-side score.

`gridSearchOptimum` in that simulator source enumerates equal zone
setpoints 195–225 degrees Celsius in 2.5-degree steps, screw speed
50–200 rpm in 5-rpm steps, and line speed 20–120 m/min in 2.5-m/min
steps, with die gap fixed at 1 mm. It evaluates the model's steady state,
omits ineligible states and retains the best score. The archived best
score is 89.894. This finite restricted grid is not a proof of a global
continuous optimum; the reported ratio is only the archive's reference
normalization. Seed-wise observations and terminal statistics are retained
in R1's `run.json` rather than treated as new independent plants.

## Q2 log provenance and measurement definitions

The current R1 directory contains `agent-loop-omp.log` and
`agent-goal-loop-omp.log`. In this revision, the author confirmed that
both are original outputs saved when the experiment was conducted. The
older `ARTIFACT-NOTES.md` statement that they are absent is superseded
by this author confirmation and the observed files. Their current hashes
and capture metadata are recorded in
`paper/tii/revision-2026-10-20/LOG-PROVENANCE.json`; file timestamps and
hashes attest the observed files, not independent proof of capture origin.
The anonymous bundle records this author-confirmed classification and the
original/delivered log hashes in `MANIFEST.json`, without distributing the
private original paths.
The reported 51.7-micrometer value comes from the structured run-summary
terminal field. A 52.02-micrometer window mean in the goal log is a
different observation/aggregation and is not substituted for it.

## Q6 execution procedure and interpretation

The archived replay entry is `scripts/e2e-injection-recipe-closedloop.mjs`.
Provision or select the recorded simulator preset, semantic control/DAQ
nodes, recipe capability and active production context. Record baseline
control and quality values. For each candidate, submit `recipe_trial`,
answer the structured approval request, preserve the dispatch receipt,
wait 65 s, then read the platform control-node values and quality DAQ
snapshots. Apply the script's observed quality predicates before the next
proposal. The successful run used four pressure increments and then saved
recipe version 2 with `recipe_update`; overshoot compensation and hold-time
fallback are defined by the replay but were not required in that trace.

The successful harness set `AW_TRIAL_INTERVAL_MS=0`, disabling the per-line
trial cadence, and used `emergency=true` trials to bypass the separate
recipe-operation interval. It did not test the default 300-s trial cadence
throughout that sequence. Approvals were supplied by a script, not human subjects. Each
receipt reports one parameter verified, while the separate persisted
control snapshots are platform state, not a raw physical PLC waveform.
Melt temperature was absent; the quality predicate allowed that absence.
The freshness assertion uses the maximum timestamp across available
sensors and does not verify freshness of every sensor individually.
The raw `/final` snapshot contains 32.30 g, 0.019% flash, and 1.277% sink
mark; the later `/update` rationale contains different quality figures
without a linked raw sample or per-sensor timestamps. The plot uses
`/final`. The supplement retains both fields unchanged and explains their
different provenance in `R6-MEASUREMENT-NOTES.json`.

Executing the replay changes its selected line and recipe. It was not
rerun against an active shared service during this revision. Use an
isolated simulator and data directory for a new study; reproduce initial
state, source version, governance configuration and raw capture together.
Historical replay entries may require their matching interface snapshot.

The two pacing settings have distinct roles: `AW_TRIAL_INTERVAL_MS=0`
disables the per-line recipe-trial cadence, whereas `emergency=true` bypasses
the separate recipe-operation interval. Neither setting removes required
approval, parameter admission, or command verification.

## October 23 boundary checks

R11 replayed the historical direct-node mission harness against the current
public interface. All eight candidates were refused because direct public
node control was disabled. The task status was `COMPLETED`, but the process
result was `attained=false`: zero writes and a final weight of 31.25 g.
Task closure is therefore not reported as successful process attainment.
This replay does not reproduce the historical direct-node route on its
original software version.

R12 used the recipe route with the default 300-s per-line trial cadence.
The baseline was 45 bar/6 s, 31.21 g, and 2.138% sink mark. The first
45-to-50-bar trial had a 1/1 verified receipt. Subsequent pressure and
hold-time proposals, at 66 and 132 s after the preceding trial, were refused
by the cadence. Final weight was 31.46 g, sink mark 1.837%, and flash 0%;
`finalOk=false` and `update=null`. The restoration assertion also failed:
the platform pressure remained 50 bar rather than the requested 45-bar
baseline. Four of eight harness assertions passed. These raw outcomes are
retained, including the failed restoration; no successful recovery is
inferred from task status or the first verified receipt.

R12 differs from the accelerated R6 configuration and initial observations.
It tests a pacing boundary and does not provide an independent successful
replicate, a current complete optimization-exploration trajectory, or an
estimate of comparative control performance.

## Figure construction

The manuscript uses four externally drawn vector PDFs under `resources/`:
`fig-architecture-2026-9pt`, `fig-runtime-2026-9pt`, `fig-admission-hitl-2026`, and
`fig-missions-controls`. Figure 3 is typeset pseudocode. Editable SVG and
600-dpi PNG companions remain available for the four external figures. The
earlier `fig-injection-controls` and `fig-governance-timeline` are revision
assets outside the active-figure set; they are not used in the manuscript.
S4/S5 timing from the deployment study is summarized in Evaluation.

`figures/make-system-2026.py` builds the implementation schematics. For the
2026-10-25 revision, Figure 1 maps the six implementation bands and their
separate evidence records; Figure 2 traces task entry through the shared
dispatch gate to the read/analysis or write/recipe route and back to the task
result and route-specific evidence.
Earlier image-generation concepts were exploratory and are not used in the
current figures; where such raster drafts are retained, they are design
inputs, not process observations or quantitative evidence.
`figures/make-evaluation-2026.py` parses archived JSON/JSONL for the
multi-process and recipe-path experimental figures; it also retains the
governance-timeline generator for audit traceability. Derived CSV/JSON source data, source hashes,
transformation rules and geometry audits are retained in
`paper/tii/revision-2026-10-20/`.

All R6 snapshots are used. Index 0 is baseline state, not a command issued
by that trial. No continuous physical response or confidence interval is
interpolated from snapshots. Historical control curves carry unchanged
requested values forward only to display command intent. Their ordinate
is percentage change from each knob's engineering-unit baseline; raw
values and terminal units are also supplied. WWTP pH/TP observations are
not plotted as dissolved oxygen. The annealing write-after observation
99.84 HV and the later terminal 100.08 HV are separate data points; its
first temperature intervention has no archived optimization-record ID.

## Build and local checks

From this LaTeX folder, using the installed latex-paper-en skill:

```text
uv run python -B <latex-paper-en-skill-dir>/scripts/compile.py main.tex
```

The wrapper disables shell escape. No shell-escape override is used for this
manuscript. The command requires the skill's compile wrapper and a compatible
TeX installation; the wrapper is not redistributed in the source package.

Current revision checks and rendered pages are recorded under
`paper/tii/revision-2026-10-25/qa/`. Verify the actual compiled page count
(at most ten, including references), template use, unresolved citations,
active figure files and placed type size, placeholders, page clipping,
anonymity, and layout warnings. These are formatting checks, not scientific
approval or journal acceptance. The October 20 verifier and its outputs are
historical records with an exact-ten-page condition that is not this
revision's delivery requirement.

The October 25 isolated software rerun used the following command from the
repository root:

```text
node node_modules/tsx/dist/cli.mjs --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit --test-concurrency=1 tests/high-risk-tool-scope.test.ts tests/tool-profile-observer.test.ts tests/recipe-propose.test.ts tests/manual-approval-optimization.test.ts tests/recipe-approval-snapshot.test.ts tests/manual-approval.test.ts tests/tool-approvals-choice.test.ts tests/recipe-op-interval.test.ts
```

It recorded 65 tests, 65 passes and zero failures in
`paper/tii/SUBMISSION-IEEE-TII/revision-2026-10-25/qa/current-software-tests-v0.8.0.log`.
The anonymized copy is included at
`revision-2026-10-25/software/current-software-tests.log` in the evidence ZIP.
The package declares version 0.8.0; the run used the local working tree. The
suites use temporary/mock state and do not measure plant-response performance.
This is the same 65-check set recorded on October 20 and 24, not 65 additional
independent process observations. An earlier invocation omitted the required tsconfig and
failed on alias imports; its diagnostic log is retained separately rather
than classified as a tested execution-contract failure.

The current optimization profile snapshots its starting control and records
refused approvals as rejected interventions; recipe apply checks the approved
definition and dispatches copied approved values. R10 exercises these
composition contracts in temporary storage with mock I/O. The archived
experiments do not supply a complete current `optimization_explore`
request-to-control-to-response process trial. Software regressions and
process-response experiments are separate evidence units; R1–R8 remain
unchanged. A future comparative study must add matched
initial states, independent seeds/batches and complete timestamped
request, approval, driver readback and sensor-window records.

## Current registered-harness experiment (R20)

R20 is the reportable current registered-harness run. Its source evidence is
`revision-2026-10-25/R20/evidence.json`, with the application and simulator
logs and exact runner source alongside it. The `R20/source-snapshot/` kit
contains app and simulator diffs from the recorded base commits, the app's
untracked source file, dependency lockfiles, all 17 runtime prompt assets, and
verified source-tree and prompt-tree hashes. Package manifests are recovered
from the recorded base commits. This allows conditional reconstruction of the
local code state; the
external model service remains nondeterministic, so identical model-selected
settings are not promised. R20 ran the local v0.8.0 working tree with the
registered `omp` adapter and `glm-5.3-flash` model. Six task
executions were run in sequence: three cast-film runs and three annealing
runs. Each run created a separate line, product, recipe, run, channel, agent,
and task context, but each set of three used one persistent simulator
instance; they are not independent replications.

Cast film used an OPC UA screw-speed control and an MQTT thickness probe;
annealing used Modbus TCP for the zone-3 setpoint and strip-temperature probe.
The model selected one setting from a three-value prevalidated set in each
run. A synthetic administrator approved each proposal. Each route log records
one recipe trial and one 1/1 verified readback receipt, and all six tasks
reached `COMPLETED`. The test runner recorded 76 passing checks and no
failures. Task history includes mirrored event projections from two journal
listeners; operation counts are therefore taken from the route-specific
recipe and acknowledgement records.

Each run then waited 20 s, performed one explicit driver probe, ingested that
single sample, and queried it by line, node, active run, and timestamp. The
isolated application's MQTT/Timescale services were unavailable, so this
query used the local SQLite time-series fallback. The six post-trial samples
were 45.69, 46.69, and 45.69 μm against a 48--52 μm cast-film band,
and 679.60, 677.70, and 678.10 °C against a 700--760 °C
annealing band. None reached its target. A single sample at 20 s is not a
trajectory or settled-state measurement. This run validates a bounded
application/harness/route/evidence path, not the normal online DAQ backend,
profile/binding adaptation in a controlled comparison, optimization quality,
process convergence, or plant performance. The earlier R16 deterministic
fixture remains a separate diagnostic and is not pooled with R20.

## Deterministic fixture replay (R21)

R21 was run on October 25, 2026, against the local v0.8.0 application and
repository simulators in a new isolated environment. The default fixture mode
of `e2e-registered-harness-simulator-paper.mjs` supplied a fixed OMP-RPC tool
call; it did not invoke an external model or make an autonomous harness
decision. One task in each scene exercised dispatch, synthetic approval,
recipe-trial handling, verified device readback, and one sample queried under
the active-run ID. The evidence records two tasks and two active runs; the
trial-run IDs are separate from active-run IDs, and the sample query matches
the active run in each scene. All 31 runner assertions passed, including
process-stop and port-release checks. The samples are single probes, and R21
is not an independent process replication or attainment test.

To repeat the deterministic software-path check in a provisioned repository
with the required dependencies installed and the runner's loopback ports free,
run `node scripts/e2e-registered-harness-simulator-paper.mjs` from the
repository root with `PAPER_E2E_HARNESS_MODE` unset (the default `fixture`
mode). The script creates a fresh isolated `AW_HOME`, starts the application
and simulator locally, stores evidence under `.omc/`, and verifies process
and port cleanup before reporting success. This command reproduces the fixture
path; it does not replay R20's external model decisions.

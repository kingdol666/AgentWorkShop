# Anonymous reproducibility notes

This document accompanies the 2026-10-20 ten-page manuscript. Paths below are relative
to the repository root. Reported plant experiments use software simulators;
real protocol stacks and a live language-model engine do not constitute
physical-plant validation. No new plant experiments were performed during
this manuscript revision.

## Separate delivery packages

The LaTeX source ZIP contains the manuscript, active figure assets and figure
source data. The separate `IEEE-TII-anonymous-evidence.zip` contains copied,
anonymized experimental archives, original engine-log evidence, available
execution logs, replay/analysis source snapshots, and a claim-to-artifact map.
Its manifest identifies original and delivered SHA-256 hashes and redaction
rules. The private originals remain unchanged. The claim map records unknown
fields as null and identifies duplicated archives without counting replicates.
The delivered bundle is retained at
`paper/tii/final-revision-2026-10-20/IEEE-TII-anonymous-evidence.zip`. Its
root `README.md`, `CLAIM-MAP.json`, `MANIFEST.json`, `FILES.json`,
`DUPLICATES.json` and `MISSING-EVIDENCE.json` explain the archive layout,
locate all Q1--Q6 claims, and distinguish absent fields from zero values.
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
| R3 | Q5 regression | `docs/benchmarks/benchmark-20261007*`, `benchmark-20261008*`, `benchmark-20261009*` | Nine sequential suite executions; 237 + 273 + 272 = 782 assertions, not 782 plant samples |
| R4 | Q5 timestamp figure | `docs/benchmarks/benchmark-20261009033810/timeline.jsonl` | 21 archived events; S4 observation-to-verification 96.105 s; no converged terminal quality claim |
| R5 | Q5 write grading | `docs/audit/2026-10-08-production-hardening-report.md`, `docs/audit/2026-10-17-ack-baseline.md` and associated log | Injected fault outcomes; not estimates of fault frequency |
| R6 | Q6 primary recipe trajectory | `bench/results/injection-pressure-loop-2026-10-18T12-37-22-157Z/summary.json` | One sequential trajectory, four +5 bar requests, five quality snapshots; fixed hold time 6 s |
| R7 | Q6 failed earlier attempt | `bench/results/injection-recipe-closedloop-2026-10-18T11-23-30-084Z/summary.json` | Cadence refusal and missed quality target, retained as a boundary |
| R8 | Q6 separate latest check | `bench/results/injection-pressure-loop-2026-10-18T17-32-16-585Z/summary.json` | Separate 65→70 bar check from a different initial state; not appended to R6 |
| R9 | Current interface isolation | `tests/high-risk-tool-scope.test.ts`, `tests/tool-profile-observer.test.ts`, `tests/recipe-propose.test.ts` | 26 tests in temporary/mock state, not an end-to-end exploration process experiment |
| R10 | Current composition regressions | `tests/manual-approval-optimization.test.ts`, `tests/recipe-approval-snapshot.test.ts`, and related approval/profile/recipe suites | 65 combined tests passed in a separate fresh verification; repairs preserve rejection status, starting control and approved recipe snapshot; no process E2E |

`bench/results/real-harness-injection-20261018/closedloop-summary.json`
duplicates R6 byte for byte. It does not add a replicate. Its `report.md`
documents the simulator endpoint and live read-only agent task. Three
`real-injection-closed-loop` execution logs record failed attempts rather
than successful repetitions.

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

Executing the replay changes its selected line and recipe. It was not
rerun against an active shared service during this revision. Use an
isolated simulator and data directory for a new study; reproduce initial
state, source version, governance configuration and raw capture together.
Historical replay entries may require their matching interface snapshot.

The two pacing settings have distinct roles: `AW_TRIAL_INTERVAL_MS=0`
disables the per-line recipe-trial cadence, whereas `emergency=true` bypasses
the separate recipe-operation interval. Neither setting removes required
approval, parameter admission, or command verification.

## Figure construction

The active figures are six vector PDFs under `resources/`:
`fig-architecture-2026`, `fig-runtime-2026`, `fig-admission-hitl-2026`,
`fig-missions-controls`, `fig-governance-timeline`, and
`fig-injection-controls`. Editable SVG and 600-dpi PNG companions remain
available. The PDF versions are used in the manuscript.

`figures/make-system-2026.py` builds the implementation schematics.
`figures/make-evaluation-2026.py` parses archived JSON/JSONL for the
experimental figures. Derived CSV/JSON source data, source hashes,
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

The project-local revised PDF check is
`paper/tii/final-revision-2026-10-20/verify_final.py`. It checks actual
compiled page count (exactly 10 for this delivery), template use, unresolved citations,
active figure files and source type size, placeholders, page clipping,
anonymity, and layout warnings. Its output is a formatting preflight,
not scientific approval or journal acceptance.

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

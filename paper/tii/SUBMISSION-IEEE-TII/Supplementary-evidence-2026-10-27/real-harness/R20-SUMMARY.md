**Editorial note for this supplementary bundle:** The following is the original archive description. This bundle does not include the full R20 evidence.json, application/simulator logs, runner, or source-snapshot/reconstruction assets. It supplies only a selected projection and trace summary; see MANIFEST.json for source hashes and omissions.

# R20 registered-harness simulator run

## Scope and setup

R20 ran the local v0.8.0 working-tree application with the registered OMP
adapter and `glm-5.3-flash` (`zhipu-coding-plan`). It used the repository's
cast-film and annealing simulators. Each of six executions created its own
line, product, recipe, run, channel, agent, and task context. Three executions
were run sequentially against one simulator instance per scene; they are not
independent replications. All approvals came from a synthetic isolated
administrator.

Cast-film control/readback used OPC UA for `ScrewSpeedSP`; its thickness
probe used MQTT. Annealing control/readback and the `StripTemp` probe used
Modbus TCP. Each task supplied the model with the current control read, a
process measurement, the target band, and a three-value prevalidated set.

## Recorded outcomes

| Execution | Pre-task CV | Target band | Setpoint: start → trial | Run-tagged sample |
|---|---:|---:|---:|---:|
| Cast film 1 | 55.82 μm | 48–52 μm | 120 → 125 rpm | 45.69 μm |
| Cast film 2 | 45.69 μm | 48–52 μm | 120 → 130 rpm | 46.69 μm |
| Cast film 3 | 46.69 μm | 48–52 μm | 120 → 125 rpm | 45.69 μm |
| Annealing 1 | 675.40 °C | 700–760 °C | 730 → 745 °C | 679.60 °C |
| Annealing 2 | 678.30 °C | 700–760 °C | 730 → 745 °C | 677.70 °C |
| Annealing 3 | 676.90 °C | 700–760 °C | 730 → 745 °C | 678.10 °C |

All six tasks were in `COMPLETED` state when the runner checked after the
sample query. Each record contains one approved proposal, one route-specific
recipe-trial record, one 1/1 verified device receipt, and one run-tagged
sample query matching the explicit probe/ingest value. The runner reported 76
passing checks, zero failed checks, and a passed isolation status. All six
samples remained outside their configured target bands.

The runner verified the route ACK and returned trial result, initiated a 20-s
delay, then performed the driver probe, ingest, and run-tagged query. The
20-s delay is anchored to that receipt/readback checkpoint. The task-state
read happened after the sample query; no task-completion timestamp is retained,
so the archive does not establish a task-completion-to-sample interval. The
sample persistence and tagged query used the local SQLite time-series fallback
because the application could not reach its isolated MQTT queue and Timescale
service endpoints. The probe is a single explicit DAQ read, not an online time
series or settled-state measurement. Task history includes mirrored event
projections; operation counts use route-specific recipe and ACK records. R20
demonstrates the configured software path, not target attainment, convergence,
optimization quality, normal online DAQ behavior, controlled
profile/binding adaptation, independent replication, or plant performance.

`evidence.json` retains the machine-readable checks, simulator settings,
model proposals, approvals, route receipts, task states, sample values, run
tags, and source hashes. `agentworkshop.log` and `simulator.log` preserve the
corresponding application and simulator logs. Request-level model token usage
and cost were not exposed by the task/channel endpoints and are not reported.

The source-snapshot directory contains app and simulator working-tree diffs
from the recorded base commits, the app's untracked source file, both
dependency lockfiles, all 17 runtime prompt assets, and a reconstruction
guide. Package manifests are recovered from the recorded base commits.
Recomputed app, simulator, and prompt-tree hashes match the hashes recorded
by the R20 runner. This is a conditional reconstruction kit: base repositories,
the OMP CLI, model-service credentials, and simulator runtime must be supplied
separately. The external model service does not guarantee deterministic replay
of proposals.

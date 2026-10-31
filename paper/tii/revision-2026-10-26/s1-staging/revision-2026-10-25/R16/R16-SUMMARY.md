# R16: Registered-harness simulator integration

**Status:** completed; 31 runner checks passed and none failed. The run used a
fresh isolated `AW_HOME`, loopback-only application/simulator endpoints, an
in-process DAQ queue, and the isolated SQLite time-series fallback. The
application reports v0.8.0. The saved `evidence.json` records source-tree
hashes and working-tree state; the application had one modified DAQ queue
module, while the simulator had three modified model/runtime files. Those
patches are included here. This is a current working-tree experiment, not a
claim that a clean commit alone reproduces it.

For each scene, the registered `omp` adapter launched the included local
deterministic OMP-RPC fixture. The fixture emitted exactly one predeclared
`recipe_trial`; it did not use an LLM or make a control decision. A synthetic
isolated administrator approved the manual-binding request through the
protected approval API. The normal dispatcher and recipe/DCW handlers then
issued one bounded simulator write and verified it by readback.

| Scene | Requested trial | ACK/readback | Post-trial DAQ snapshot |
|---|---|---|---|
| Cast film | Screw speed 120 to 125 rpm (OPC UA) | 1/1 verified | One probe/ingest value: 46.37 µm; tagged to active run `rr-7b903fb6` |
| Annealing | Zone-3 setpoint 730 to 735 °C (Modbus TCP) | 1/1 verified | One probe/ingest value: 674.799988 °C; tagged to active run `rr-0322d2a4` |

Each snapshot followed a 20-s wait and one explicit protocol-driver probe and
ingest request. The SQLite query returned exactly one point for the active
run ID. These single snapshots are not continuous acquisition records,
process trajectories, settled responses, convergence measures, or product
quality outcomes. No recipe update or optimization recommendation was made.
The synthetic approval does not measure operator performance. The run
demonstrates completion of the configured harness-to-process software path in
two simulator scenes only.

## Provenance and artifacts

- `evidence.json`: run result, all 31 isolation/application/data checks,
  approvals, tool calls, ACK/readback, run tags, software versions, source
  hashes, and fixture hashes. Absolute local paths are redacted only in the
  delivered anonymous copy.
- `agentworkshop.log`, `simulator.log`, and `fixture-*.json`: raw execution
  records.
- `e2e-registered-harness-simulator-paper.mjs` and
  `omp-paper-harness.mjs`: run driver and deterministic adapter fixture.
- `runtime-settings.json` and `plugins-state.json`: effective isolated
  runtime settings and plugin allowlist.
- `application-daq-queue.patch` / `daq-bus-index.ts`: working-tree queue
  change and captured file used by the application run.
- `simulator-model.patch`: simulator working-tree changes used by this run.

The test scope was local software simulators with explicit loopback endpoints.
It does not establish physical PLC/plant behavior, continuous DAQ operation,
LLM or multi-harness behavior, process improvement, or safety assurance.

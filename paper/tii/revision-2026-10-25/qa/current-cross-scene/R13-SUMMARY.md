# R13: current-version two-scene integration

This summary is derived from `raw/report.json`, the retained dataset manifests,
and the failed model-evaluation artifacts. Those files are the authoritative
records; this summary introduces no new measurements.

## Configuration and procedure

- Application: local v0.8.0 working tree, with an isolated temporary data home
  and TimescaleDB container. The retained report does not identify the
  application's Git revision, exact test-script source, lockfile hashes, or
  installed dependency trees. This application-level run did not exercise a
  registered agent harness as part of the process trial.
- Scenes: repository cast-film and annealing simulator presets at real-time
  scale. The simulator truth/optimum endpoint and external LLM services were
  not used; no physical equipment or shared business instance was accessed.
- Cast film: `ScrewSpeedSP` over OPC UA to thickness `thick` over MQTT.
- Annealing: zone-3 furnace setpoint to `StripTemp` over Modbus TCP.
- All five configured protocol-driver families passed read probes across the
  two presets. Initial writes and six bounded stimulus steps per scene returned
  verified readbacks.
- Six sequential 120-s collection windows per scene; DAQ sampling interval
  was 1 s. The setpoint alternated between the initial value plus/minus 15 at
  60 s in each window; each adjacent change was at most 30 units.
- Process models used `linear_arx@1`, first-order input/output, ridge
  regularization `1e-4`, eight history steps, four-step horizon, fixed 1-s
  timing, seed 42, and 40% validation / 40% test splits.

## Outcomes

| Scene | DAQ points | Dataset rows | Test rows | Full-dataset eligibility statistic | Held-out model gates | Disposition |
|---|---:|---:|---:|---|---|---|
| Cast film | 697 | 658 | 220 | $|r_\Delta|=0.094874$ at row lag 2 | One-step NRMSE 0.258734 > 0.10; four-step rollout NRMSE reduction 14.1078% < 20% | No optimization eligibility |
| Annealing | 696 | 655 | 218 | $|r_\Delta|=0.052593$ at row lag 3 | One-step NRMSE 0.363223 > 0.10; four-step rollout NRMSE reduction 4.8321% < 20% | No optimization eligibility |

Both datasets have verified lineage across six run IDs. The scripted test
recorded 50 passing checks, zero failed checks, and two model-gate refusals. It created
no accepted model, optimization profile, recommendation, or dispatch. These
results support protocol integration, bounded-write/readback behavior, DAQ
collection, lineage, and gate enforcement. They do not establish successful
optimization or cross-scene model transfer.

The archived eligibility values refer to first-differenced rowwise series
formed from the last history value of the manipulated variable (MV) and the
first target value (CV), maximized in absolute value over row lags 1--3. They
are archive outputs, not a source-pinned replay; the run-block-preserving
recalculation appears below. These values are distinct from the dataset
builder's separate raw-level correlation report from the first training run
over lags +/-20, which returned 0.986 at row lag 8 for cast film and 0.852 at
row lag 13 for annealing. Those metrics use different transformations,
populations, and lag ranges; neither is treated as a causal effect estimate.
The held-out test rows are overlapping 1-s windows from two of six sequential
120-s runs per scene, not independent replications. Four-step rollout
improvement is relative to the persistence NRMSE baseline.

The signal pairs were selected after exploratory pilot R14 and inspection of
the repository simulator mappings. Accordingly, R13 is an integration and
gate-behavior demonstration, not a confirmatory model-performance estimate.

## Source identity and replay limits

`R13-PROVENANCE.json` records the post-run source snapshot and its limits.
The root application files were clean at retrospective review, the retained
simulator source matches the available current simulator tree, and the run
outputs are hash-identified. These facts support auditing but do not prove
which exact application, test script, simulator, or installed dependencies
ran: the original report did not record those identities, and the available
candidate test script was modified after the run. R13 is therefore an
auditable archived integration run, not a fully source-pinned replay.

## Run-boundary audit added during manuscript revision

The retained dataset manifests divide the row arrays into six run blocks.
Recomputing the maximum absolute first-difference correlation separately
within those blocks, without differencing across adjacent run boundaries,
gives 0.023668 at lag 1 for cast film and 0.046485 at lag 1 for annealing.
The archived report's full-array values are 0.094874 at lag 2 and 0.052593 at
lag 3, respectively. Both sets are below the configured 0.2 gate, but they
differ. Since the runtime source is not pinned, this audit does not claim to
reproduce the executed eligibility implementation. The manuscript identifies
the archived and recalculated values separately and treats R13 as exploratory
gate-behavior evidence.

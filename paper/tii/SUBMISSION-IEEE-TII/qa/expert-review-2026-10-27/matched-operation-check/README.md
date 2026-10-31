# Matched-operation route-check evidence

This archive contains copies of the two isolated local-simulator run records used for the separate route-integration check in the manuscript. The evidence files retain source-generated configuration, approval, command-result, readback, probe, ingestion, active-run query, and cleanup checks.

The registered-task path used a deterministic local harness fixture and no LLM decision. Each invocation produced a pending recipe approval that a synthetic administrator in the isolated application home approved through the protected approval endpoint. The same operation and candidate were used for both entry paths within each configuration, but each path ran in an independent simulator instance; initial process states were not paired.

The cast-film configuration wrote 125 rpm and sampled thickness at 46.37 um against 48--52 um. The annealing configuration wrote 735 C and sampled strip temperature at 674.8 C through the registered task and 675.2 C through direct REST against 700--760 C. Each operation returned one readback-verified command result (1/1), followed by one active-run-tagged sample after a 20-s post-readback wait. The configured driver was explicitly probed once and the result was ingested to the isolated SQLite time-series fallback.

These are software-integration observations, not repeated process trials, online MQTT/Timescale DAQ tests, steady-state measurements, target-attainment results, or evidence of route equivalence. The runner records do not include the selected internal handler identifier.

SHA-256:
- `registered-task-evidence.json`: 91bbddf94ede155923d0097a2a3e15e02b4ddf23a57f80f5f93c5eef404ce805
- `direct-rest-evidence.json`: de885a71f1e52018a23ee7e166683b9a701d8ea39b5f5926ebc76370b9e4a9f2

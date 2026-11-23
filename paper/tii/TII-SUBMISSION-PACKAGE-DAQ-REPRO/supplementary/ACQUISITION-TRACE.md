# Acquisition and setpoint evidence: two simulator studies

## A. Historical injection-simulator trace

This record is separate from the 60 to 63.7 bar simulated-twin demonstration, the E6 scripted-policy comparison and the three E7 episodes. It describes two separately prompted channel turns in one simulation acceptance exercise. It is an annotated extraction from retained records, not a raw model/tool transcript, a new run or a replay of E7. Times below are in the run's local time (UTC+08:00); dates, host addresses, account names and internal identifiers are omitted. Aliases preserve the documented joins.

## Parameter connections

| Alias | Variable and direction | Configured protocol address | Engineering unit | Platform mapping |
|---|---|---|---|---|
| PV-1 | Part mass, acquisition | Modbus TCP, unit 1, holding register 40009, Float32, big-endian | g | DAQ node; 1 s configured sampling interval |
| SP-1 | Holding pressure, control | Modbus TCP, unit 1, holding register 40001, Float32, big-endian | MPa | DCW node; 45–85 MPa range, 2 MPa step limit |

The recorded channel used the associated simulated line. The acquisition and control registers are distinct. An application read role does not imply permission to write a setpoint.

## Evidence timeline

| Time | Boundary | Observation retained | Evidence strength |
|---|---|---|---|
| Approx. 01:04–01:09 | Agent acquisition report | The lead attributed a 32.619 g mean, 32.606–32.624 g range and 89 samples for PV-1 to a five-minute `daq_query`. The channel message was recorded at 01:11:58.873. | Agent output; the exact call/result and its raw samples were not archived. |
| 01:18:29.340 | Proposal approval A1 | The approval record identifies SP-1, 62 → 63 MPa, single parameter, with a separately prompted `recipe_propose` turn. | Persisted approval record. |
| 01:18:45.298 | Decision for A1 | Confirmed; the acceptance record identifies a human test decision selecting the proposal. | Persisted decision; not a study of operator judgment. |
| 01:18:45.300–01:18:45.325 | Recipe receipt R1 and journal J1 | R1 reports `readback-verified`, 63 MPa and 1/1 verified. J1 attributes SP-1 62 → 63 MPa to the agent and stores both A1 and R1. | Correlated application records; not a packet-level protocol capture. |
| Bucket beginning 01:19:00 | Later process measurement | PV-1 mean 32.7075 g, min 32.69 g, max 32.72 g, 28 samples. | Stored aggregate, not an independent causal comparison or the setpoint readback. |
| 01:20:54.323 | Separate device read | Another read returned raw 63 and engineering value 63 MPa. | Separate simulated-device read; not a physical PLC result. |

The earlier acquisition report and later proposal share the channel agent, not a task/call identifier. The approval, write journal, and recipe receipt join by recorded IDs. The later device read and process bucket are separate retained records in the same scene. This supports the stated integration observations, not the full observation-to-decision mechanism, process effect, or iterative optimization. `TRACE-RECORDS.json` contains field-level extracts; it is not a replacement for the missing tool transcript.

## B. New cast-film reproduction attempt

This attempt used a fresh application home and a disposable simulator (seed 42). The configured acquisition path was MQTT topic `aw/sim/thick` → film-thickness DAQ node (µm). The separate control path was OPC UA node `ns=2;s=AW.N.Sp` → screw-speed setpoint (rpm). The manual approval path was configured but not invoked. Line startup applied a 120 rpm baseline as fixture setup; this was not an agent write.

| Run alias | Measurement (UTC) | Result and stopping point |
|---|---|---|
| F1 | — | The ingest request returned HTTP 503. This record does not preserve a protocol measurement. |
| F2 | 17:08:23.493, 55.44 µm | Direct MQTT driver probe, not an ingest or an agent call. The runner did not retrieve four matching run-tagged rows within its nominal 16-s observation period. |
| F3 | 17:11:13.672, 55.44 µm | Direct probe with a separate Mosquitto queue; an unclassified runtime error stopped the run before sample verification. |
| F4 | 17:12:54.129, 55.04 µm | Direct probe with Mosquitto and TimescaleDB. The runner reached its post-query validation of four matching rows, but the combined value, state, quality and ingestion-time assertion failed. The individual rows were not retained, so neither the failing field nor a raw series is established. |

A successful driver probe is not proof of a fresh time-series window or retrieval by a model. No Gemma task, agent `daq_query`, approval, trial write, or post-trial readback was observed in these attempts. The final run stopped the simulated line, removed its disposable services and released the test ports. No physical plant was connected.

# AW-IndustrialBench · Integrated Pipeline Report

> **FAIL** — score **73.4**/100, grade **F**. Hard gate tripped: at least one check/phase failed; the score is informational only.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20260922040459-ft0` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `9f2756dce4a4cbb3` (sha256 over 11 checker sources) |
| Git commit | `e692df1` |
| Runtime | v24.19.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3001 · http://127.0.0.1:4010 |
| Tool harness | opencode (deterministic) · LLM agent: (none) |
| Reproduce | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 56 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 17.922 ms | incl. real protocol transactions |
| Closed-loop J/J* | 90.6 % | n=3 seeds · worst 78.4% · J*=89.894 |
| Tool-level loops | 0 | dcw→daq→judge ×3 convergence |
| Param-layer governance | 2/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | not fired | P8b drill requires scenario 2 |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 3 knobs · 3 writes → 25.68μm ✔ |
| LLM agent loop | off | --agent omp enables |
| Verdict | FAIL | 52/74 checks · hard gate tripped |

## Simulated production line profile

> Preset `cast-film-physics` — Cast-film extrusion digital twin (plant-model physics engine). An extrusion cast-film line: resin → screw melting → die → casting → thickness gauge. Six writable setpoints (3 zone temperatures, screw speed, line speed, die gap) act on a physics engine whose observable process quantities are melt temperature, melt pressure, film thickness, defect rate and gels count.

**Physics.** Deterministic plant model (seeded): first-order thermal lag on melt temperature, algebraic thickness h ∝ N/v from mass conservation, pressure/defect couplings — scored by J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput.
 Plant engine state at report time: phase=`warmup`, seed=`42`.

**Totals.** 5 PLC devices across 5 protocols (modbus-tcp, modbus-rtu, opcua, mqtt, http); **6 writable setpoints (SP → DCW nodes)** and **7 process quantities (PV → DAQ nodes)**; the platform side provisions 15 lines with 46 write nodes and 44 acquisition nodes.

### Devices & fieldbus endpoints

| # | Device | Protocol | Endpoint | Signals (SP+PV) |
|---:|---|---|---|---:|
| 1 | 挤出主机PLC(Modbus TCP) | `modbus-tcp` | `0.0.0.0:16040 unit=1` | 4 |
| 2 | 晶点计数从站(Modbus RTU) | `modbus-rtu` | `0.0.0.0:15041 unit=1` | 1 |
| 3 | 熔体泵送单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:5840` | 2 |
| 4 | 在线测厚仪(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 2 |
| 5 | CCD检测站(HTTP) | `http` | `http endpoint` | 4 |

### Signal inventory (writable setpoints first, then process quantities)

| Device | Signal | Kind | Unit | Range | Decimals | Strategy |
|---|---|---|---|---|---:|---|
| 挤出主机PLC(Modbus TCP) | 加热区1SP (`zone1-sp`) | SP (writable setpoint) | ℃ | [120, 260] | 1 | `manual` |
| 挤出主机PLC(Modbus TCP) | 加热区2SP (`zone2-sp`) | SP (writable setpoint) | ℃ | [120, 260] | 1 | `manual` |
| 挤出主机PLC(Modbus TCP) | 加热区3SP (`zone3-sp`) | SP (writable setpoint) | ℃ | [120, 260] | 1 | `manual` |
| 挤出主机PLC(Modbus TCP) | 熔体温度 (`melt-temp`) | PV (process quantity) | ℃ | [0, 400] | 2 | `constant` |
| 晶点计数从站(Modbus RTU) | 晶点计数 (`gels-count`) | PV (process quantity) | 个/m² | [0, 500] | 0 | `constant` |
| 熔体泵送单元(OPC UA) | ScrewSpeedSP (`screw-sp`) | SP (writable setpoint) | rpm | [50, 200] | 0 | `manual` |
| 熔体泵送单元(OPC UA) | MeltPressure (`melt-pressure`) | PV (process quantity) | MPa | [0, 45] | 3 | `constant` |
| 在线测厚仪(MQTT) | lineSpeedSP (`linespeed-sp`) | SP (writable setpoint) | m/min | [20, 120] | 1 | `manual` |
| 在线测厚仪(MQTT) | thick (`film-thickness`) | PV (process quantity) | μm | [0, 400] | 2 | `constant` |
| CCD检测站(HTTP) | dieGapSP (`diegap-sp`) | SP (writable setpoint) | mm | [0.5, 2] | 2 | `manual` |
| CCD检测站(HTTP) | profile (`thickness-profile`) | PV (process quantity) | μm | [0, 400] | 3 | `constant` |
| CCD检测站(HTTP) | ccd (`ccd-image`) | PV (process quantity) | 灰度 | [0, 255] | 2 | `constant` |
| CCD检测站(HTTP) | defect (`defect-rate`) | PV (process quantity) | % | [0, 100] | 3 | `constant` |

### Platform-side node mapping (AW write-control / acquisition nodes)

| Node | Kind | Driver | Line | Unit | Range |
|---|---|---|---|---|---|
| 演示·Coating Oven PLC·Temp SP (`dw-82878ad`) | DCW write | `modbus-tcp` | 演示线1·Coating Oven PLC | ℃ | [0, 260] |
| 演示·OPC UA Temp Controller·SetTemp (`dw-7b49f7d`) | DCW write | `opcua` | 演示线2·OPC UA Temp Control | ℃ | [0, 260] |
| 演示·MQTT Temp Sensor·tempSP (`dw-13a625c`) | DCW write | `mqtt` | 演示线3·MQTT Temp Sensor | ℃ | [0, 100] |
| L1-DCW-modbus-tcp ip16husa (`dw-6d589fc`) | DCW write | `modbus-tcp` | Integrated线1 ip16husa | ℃ | [120, 260] |
| L2-DCW-opcua ip16husa (`dw-9688117`) | DCW write | `opcua` | Integrated线2 ip16husa | rpm | [50, 200] |
| L3-DCW-mqtt ip16husa (`dw-6148bb2`) | DCW write | `mqtt` | Integrated线3 ip16husa | m/min | [20, 120] |
| L4-DCW-http ip16husa (`dw-05ac764`) | DCW write | `http` | Integrated线4 ip16husa | mm | [0.5, 2] |
| 加热区1SP ip16husacl (`dw-38ee80d`) | DCW write | `modbus-tcp` | CastFilm线 ip16husacl | ℃ | [120, 260] |
| 加热区2SP ip16husacl (`dw-ba44577`) | DCW write | `modbus-tcp` | CastFilm线 ip16husacl | ℃ | [120, 260] |
| 加热区3SP ip16husacl (`dw-4626644`) | DCW write | `modbus-tcp` | CastFilm线 ip16husacl | ℃ | [120, 260] |
| ScrewSpeedSP ip16husacl (`dw-03770d7`) | DCW write | `opcua` | CastFilm线 ip16husacl | rpm | [50, 200] |
| lineSpeedSP ip16husacl (`dw-7e620fa`) | DCW write | `mqtt` | CastFilm线 ip16husacl | m/min | [20, 120] |
| dieGapSP ip16husacl (`dw-c2782e4`) | DCW write | `http` | CastFilm线 ip16husacl | mm | [0.5, 2] |
| L1-DCW-modbus-tcp ip16husap8 (`dw-497ba60`) | DCW write | `modbus-tcp` | Integrated线1 ip16husap8 | ℃ | [0, 260] |
| L2-DCW-opcua ip16husap8 (`dw-1b8fd9f`) | DCW write | `opcua` | Integrated线2 ip16husap8 | ℃ | [0, 260] |
| L3-DCW-mqtt ip16husap8 (`dw-a571a46`) | DCW write | `mqtt` | Integrated线3 ip16husap8 | ℃ | [0, 100] |
| 干燥温度SP·ip16husa (`dw-57e3776`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16husa | ℃ | [120, 200] |
| 露点SP·ip16husa (`dw-973474b`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16husa | ℃ | [-80, -20] |
| 喂料速率SP·ip16husa (`dw-ce8803b`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16husa | kg/h | [100, 1200] |
| 机筒温度区1SP·ip16husa (`dw-07b2c91`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | ℃ | [220, 300] |
| 机筒温度区2SP·ip16husa (`dw-f862192`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | ℃ | [220, 300] |
| 机筒温度区3SP·ip16husa (`dw-148a96f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | ℃ | [220, 300] |
| 机筒温度区4SP·ip16husa (`dw-eb5ac7c`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | ℃ | [220, 300] |
| 机筒温度区5SP·ip16husa (`dw-72a9996`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | ℃ | [220, 300] |
| 螺杆转速SP·ip16husa (`dw-e03405c`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | rpm | [20, 100] |
| 计量泵转速SP·ip16husa (`dw-0f2854f`) | DCW write | `modbus-rtu` | 双拉薄膜产线 biax-ip16husa | rpm | [15, 60] |
| 模唇温度SP·ip16husa (`dw-8185272`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | ℃ | [250, 300] |
| 急冷辊温度SP·ip16husa (`dw-6521c6a`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | ℃ | [10, 60] |
| 铸片辊速度SP·ip16husa (`dw-0fcfe00`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | m/min | [10, 60] |
| 静电吸附电压SP·ip16husa (`dw-8c3c4ea`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | kV | [4, 12] |
| 预热辊1温度SP·ip16husa (`dw-751d9e7`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | ℃ | [70, 140] |
| 预热辊2温度SP·ip16husa (`dw-0bf5407`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | ℃ | [70, 140] |
| 预热辊3温度SP·ip16husa (`dw-5722b7d`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | ℃ | [70, 140] |
| 慢辊线速度SP·ip16husa (`dw-0185c63`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | m/min | [10, 80] |
| 快辊线速度SP·ip16husa (`dw-ddef4da`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | m/min | [30, 260] |
| 纵拉退火辊SP·ip16husa (`dw-bf07445`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16husa | ℃ | [90, 170] |
| TDO预热段SP·ip16husa (`dw-a1cb129`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16husa | ℃ | [80, 140] |
| TDO拉伸段SP·ip16husa (`dw-b0a0514`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16husa | ℃ | [90, 150] |
| TDO定型段SP·ip16husa (`dw-164bb90`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16husa | ℃ | [180, 250] |
| 链夹速度SP·ip16husa (`dw-5101b90`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16husa | m/min | [40, 260] |
| 演示·Coating Oven PLC·Temp PV (`dn-576c281`) | DAQ acquire | `modbus-tcp` | 演示线1·Coating Oven PLC | ℃ | [0, 260] |
| 演示·Coating Oven PLC·Pressure PV (`dn-0795aed`) | DAQ acquire | `modbus-tcp` | 演示线1·Coating Oven PLC | MPa | [0, 2] |
| 演示·Coating Oven PLC·Tension PV (`dn-fcdc736`) | DAQ acquire | `modbus-tcp` | 演示线1·Coating Oven PLC | N | [0, 200] |
| 演示·Coating Oven PLC·Speed PV (`dn-8046dc2`) | DAQ acquire | `modbus-tcp` | 演示线1·Coating Oven PLC | m/min | [0, 300] |
| 演示·Remote RTU Temp Slave·Furnace Temp (`dn-0cfc6c8`) | DAQ acquire | `modbus-rtu` | 演示线1·Coating Oven PLC | ℃ | [0, 100] |
| 演示·OPC UA Temp Controller·Temp (`dn-ce2b3af`) | DAQ acquire | `opcua` | 演示线2·OPC UA Temp Control | ℃ | [0, 260] |
| 演示·MQTT Temp Sensor·temp (`dn-4ed321c`) | DAQ acquire | `mqtt` | 演示线3·MQTT Temp Sensor | ℃ | [0, 100] |
| 演示·HTTP Flow Meter·Flow (`dn-21c3631`) | DAQ acquire | `http` | 演示线1·Coating Oven PLC | L/min | [0, 100] |
| L1-DAQ-modbus-tcp ip16husa (`dn-3b339ef`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16husa | ℃ | [0, 400] |
| L2-DAQ-opcua ip16husa (`dn-b73935d`) | DAQ acquire | `opcua` | Integrated线2 ip16husa | MPa | [0, 45] |
| L3-DAQ-mqtt ip16husa (`dn-f82b8ad`) | DAQ acquire | `mqtt` | Integrated线3 ip16husa | μm | [0, 400] |
| L4-DAQ-http ip16husa (`dn-00a7157`) | DAQ acquire | `http` | Integrated线4 ip16husa | μm | [0, 400] |
| L5-DAQ-modbus-rtu ip16husa(sat) (`dn-0cbec06`) | DAQ acquire | `modbus-rtu` | Integrated线4 ip16husa | 个/m² | [0, 500] |
| 熔体温度 ip16husacl (`dn-8401a20`) | DAQ acquire | `modbus-tcp` | CastFilm线 ip16husacl | ℃ | [0, 400] |
| 晶点计数 ip16husacl (`dn-9bcb2c1`) | DAQ acquire | `modbus-rtu` | CastFilm线 ip16husacl | 个/m² | [0, 500] |
| MeltPressure ip16husacl (`dn-a17596d`) | DAQ acquire | `opcua` | CastFilm线 ip16husacl | MPa | [0, 45] |
| thick ip16husacl (`dn-bb4b618`) | DAQ acquire | `mqtt` | CastFilm线 ip16husacl | μm | [0, 400] |
| defect ip16husacl (`dn-cd0ee4f`) | DAQ acquire | `http` | CastFilm线 ip16husacl | % | [0, 100] |
| profile ip16husa (`dn-5181d01`) | DAQ acquire | `http` | Integrated线1 ip16husa | mm | [0.4, 0.65] |
| ccd ip16husa (`dn-f7995a1`) | DAQ acquire | `http` | Integrated线1 ip16husa | 灰度 | [0, 255] |
| L1-DAQ-modbus-tcp ip16husap8 (`dn-a73b799`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16husap8 | ℃ | [0, 260] |
| L2-DAQ-opcua ip16husap8 (`dn-0ba93aa`) | DAQ acquire | `opcua` | Integrated线2 ip16husap8 | ℃ | [0, 260] |
| L3-DAQ-mqtt ip16husap8 (`dn-f7aa37d`) | DAQ acquire | `mqtt` | Integrated线3 ip16husap8 | ℃ | [0, 100] |
| L4-DAQ-modbus-rtu ip16husap8(sat) (`dn-5b1f854`) | DAQ acquire | `modbus-rtu` | Integrated线3 ip16husap8 | ℃ | [0, 100] |

_(showing first 40 DCW / 24 DAQ nodes; full inventory in `line-profile.json`)_

## Phase scorecard (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---:|---:|---:|---:|---:|---:|
| P0 | Bootstrap · simulator & platform | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P1 | Plant model + offline optimum W* | 3 | 0 | 0 | 0 | 100.0 | 1 |
| P2 | Multi-protocol line provisioning | 6 | 0 | 0 | 0 | 100.0 | 2 |
| P3 | DAQ · governed write · F5 interlock | 1 | 0 | 4 | 0 | 20.0 | 3 |
| P4 | Agent-tool closed loop (3-cycle convergence) | 3 | 4 | 0 | 0 | 71.4 | 3 |
| P4b | Rollback & optimization records | 2 | 2 | 0 | 0 | 75.0 | 2 |
| P4c | HITL approval gate | 0 | 1 | 0 | 0 | 50.0 | 2 |
| P4d | Audit / ledger read surfaces | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P4e | Recipe lifecycle | 2 | 0 | 0 | 0 | 100.0 | 2 |
| P4f | Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits) | 2 | 0 | 2 | 0 | 50.0 | 3 |
| P4m | AgentTeam optimization mission (task board → governed writes → attainment) | 4 | 1 | 1 | 0 | 75.0 | 3 |
| P6 | Closed-loop optimization benchmark (multi-seed) | 3 | 2 | 1 | 0 | 66.7 | 3 |
| P7 | Multimodal acquisition (vector/image) | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P8 | Cross-scenario portability | 8 | 0 | 3 | 0 | 72.7 | 3 |
| P8b | System backstop drill (bounded autonomy) | 2 | 0 | 1 | 0 | 66.7 | 3 |
| P9 | Platform subsystems (team / memory / registry) | 3 | 0 | 0 | 0 | 100.0 | 1 |
| P10 | Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop) | 10 | 0 | 0 | 0 | 100.0 | 3 |
| **Overall** | | | | | | **73.4** | 37 |

## Closed-loop optimization · per-seed

| Seed | J0 | Jend | J* | J/J* % | Iters | Governed writes | Rejected | Converged |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 42 | 68.54 | 86.66 | 89.89 | 96.4 | 4 | 4 | 3 | yes |
| 43 | 87.27 | 87.27 | 89.89 | 97.1 | 0 | 0 | 0 | yes |
| 44 | 67.89 | 70.50 | 89.89 | 78.4 | 8 | 7 | 5 | no |

## AgentTeam closed-loop tuning walkthrough

How an optimization team is assembled and drives the line, end to end: (1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; (2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); (3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; (4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; (5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.

### Biax (BOPET) multi-node mission — iteration trace

| Iter | Knob | Node | From → To | Thickness μm | Note |
|---|---|---|---|---:|---|
| 0 | — | `—` | — | 28.07 |  |
| 1 | cast-spd-sp | `dw-0fcfe006` | 32 → 33.7 | 26.46 |  |
| 2 | fast-roll-sp | `dw-ddef4da9` | 118 → 120.3 | 26.10 |  |
| 3 | rail-out-sp | `dw-c0dcaf7a` | 3000 → 3038 | 25.68 |  |

Governed writes: **3** on 3 distinct knob(s) · optimization records: 3 · target window 25 ± 0.7 μm · final thickness reading **25.68 μm** · target attained: **no**.

### Deterministic closed-loop benchmark — seed 42 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.50 | 0.133 | 18.65 | 206.9 | 150 | 95.0 | 200.0 | 68.54 | 0 |
| 1 | 54.33 | 0.500 | 18.30 | 203.2 | 150 | 95.0 | 200.0 | 73.81 | 24.139 |
| 2 | 54.63 | 0.533 | 18.23 | 201.2 | 150 | 95.0 | 200.0 | 72.06 | 36.197 |
| 3 | 49.07 | 0.733 | 16.62 | 200.9 | 137 | 95.0 | 200.0 | 86.61 | 48.26 |
| 4 | 48.93 | 0.700 | 16.57 | 200.2 | 137 | 95.0 | 200.0 | 86.71 | 60.302 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **96.4 %**; governed writes 4 (rejected 3), optimization records 1.

### Deterministic closed-loop benchmark — seed 43 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 51.02 | 0.300 | 16.98 | 206.3 | 150 | 95.0 | 200.0 | 87.27 | 0 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.1 %**; governed writes 0 (rejected 0), optimization records 0.

### Deterministic closed-loop benchmark — seed 44 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.67 | 0.050 | 18.62 | 206.4 | 150 | 95.0 | 200.0 | 67.89 | 0 |
| 1 | 55.03 | 0.367 | 18.30 | 203.0 | 150 | 95.0 | 200.0 | 70.38 | 24.094 |
| 2 | 53.87 | 0.667 | 18.27 | 201.3 | 150 | 95.0 | 200.0 | 75.86 | 36.142 |
| 3 | 49.83 | 0.867 | 16.90 | 200.7 | 139 | 95.0 | 200.0 | 86.09 | 48.203 |
| 4 | 55.33 | 0.717 | 18.58 | 200.5 | 139 | 95.0 | 200.0 | 68.22 | 60.25 |
| 5 | 54.97 | 0.800 | 18.58 | 200.2 | 139 | 95.0 | 200.0 | 69.98 | 72.304 |
| 6 | 45.00 | 0.683 | 15.15 | 200.0 | 126 | 95.0 | 200.0 | 70.85 | 84.371 |
| 7 | 44.53 | 0.800 | 15.25 | 200.1 | 126 | 95.0 | 200.0 | 67.92 | 96.428 |
| 8 | 45.43 | 0.733 | 15.15 | 199.8 | 126 | 95.0 | 200.0 | 73.08 | 108.478 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **78.4 %**; governed writes 7 (rejected 5), optimization records 2.

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `agentteam-mission.log` | 0.7 KB | AgentTeam optimization mission — full task-board trajectory |
| `agentteam-biax.log` | 1.4 KB | AgentTeam biax multi-node mission — full trajectory |
| `line-profile.json` | 29.4 KB | Simulated line profile — devices, protocols, endpoints, SP/PV signal inventory, AW node mapping |
| `metrics.csv` | 2.5 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 98.7 KB | Full machine-readable results (checks, phases, evidence, KPIs, line profile, agent-team traces) |
| `summary.json` | 15.3 KB | Verdict + KPI + per-line summary (compare/aggregate input) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✔ **platform-reachable** (pass) — platform reachable & authenticated
  - 平台 http://127.0.0.1:3001：already-up
  - 鉴权 OK (login)
  - simulator http://127.0.0.1:4010：already up (reused)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass) — 预设 cast-film-physics 已应用
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **field-defaults** (pass) — 现场=蓝图默认值（6 信号核对）
  - 全部信号初始值=蓝图默认值
- ✔ **offline-optimum** (pass) — offline optimum W* (ground truth) available
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-22T04:05:05.421Z"}

### P10 — Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)

- ✔ **biax-ensure** (pass) — 节点探测补建(9 建缺失 / 0 修复 / 0 原样)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass) — 五协议多节点建线(DCW 30 + DAQ 19,驱动实测 9/9)
  - line=ln-71bf2e2e recipe=rc-d81e9258 started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass) — 测厚仪真实链路采样(3 点)
  - daq=dn-a2b9034e · samples=3
- ✔ **biax-agent-cards** (pass) — Agent 语义卡含双拉工艺描述(semantics 贯通)
  - 语义卡长度 22240 · 关键词命中 铸片辊速度/横向拉伸比/收卷张力
  - sample: #### ◆ L1-DCW-modbus-tcp ip16husa [id=dw-6d589fc1] - 物理量: 烘箱温度设定,单位 ℃,精度 1 位小数 - 工艺语义: 模拟器设备「挤出主机PLC(Modbus TCP)」的 加热区1SP（真实 modbus-tcp 写控） - 安全量程: [120, 260] ℃
- ✔ **biax-mission-board** (pass) — 任务板:双拉优化任务下达并由 lead 派发
  - parent task + lead child: ✔
- ✔ **biax-mission-multinode** (pass) — 多节点受治理写(3 个执行节点 / 3 写)
  - 1. task board: channel=238a28ee-d2ff-47c6-8de9-b72412102df7 parent=e8c5f74e-7976-4761-a09b-87a4b9f6b912 leadChild=5e3c0d5a-8787-479b-b38b-36d703bba7f6
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.1,3.5,1.6]
  - 3. initial thickness=28.07 μm(目标 25±0.7)
  - iter1: cast-spd-sp 32→33.7 ✔ record=opt-8241f6… · thickness→26.46μm · judge=keep✔
- ✔ **biax-mission-attained** (pass) — 厚度目标达成(|PV−25.0|≤0.7μm,final=25.68)
  - writes=3/6 · distinctKnobs=3 · final=25.68μm
  -         meltTemp=291.5℃(安全窗 268~300)
  - 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(1 条,含参数/判定/窗口): - opt-8241f6a3 [judged-keep] 铸片辊速度SP·ip16husa: 32 → 33.7,设定 12:09:16,判定 keep(agent:biax mission ite
  - 5. outcome: writes=3 distinctKnobs=3 final=25.68μm attained=true
- ✔ **biax-mission-journal** (pass) — 参数账本 Agent 归因(铸速节点)
- ✔ **biax-mission-closed** (pass) — 任务收口(父任务 COMPLETED)
  - terminal=COMPLETED
- ✔ **biax-restore** (pass) — 双拉线停止 + 第一场景恢复: cast-film-physics
  - rig left as found

### P2 — Multi-protocol line provisioning

- ✔ **gateway** (pass) — gateway controller start (idempotent)
  - POST /api/workshop/daq/controller {action:start}
  - 采样仍受「活动Line批」门控，故每台有 SP 的devices自成一可开跑Line
- ✔ **line-1-modbus-tcp** (pass) — Line1 [modbus-tcp] 供给
  - line=ln-22b88aff daq=dn-3b339ef1 dcw=dw-6d589fc1 recipe=rc-ed54efa0
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 210.6999969482422
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass) — Line2 [opcua] 供给
  - line=ln-8c4f33ee daq=dn-b73935d6 dcw=dw-9688117e recipe=rc-30d8b7e0
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 18.532
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass) — Line3 [mqtt] 供给
  - line=ln-54b51903 daq=dn-f82b8ad4 dcw=dw-6148bb2a recipe=rc-85ee307f
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,收到 aw/sim/thick = 55.81
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass) — Line4 [http] 供给
  - line=ln-dd118264 daq=dn-00a71578 dcw=dw-05ac7647 recipe=rc-24746c82
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 0.114
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass) — Line5 [modbus-rtu] 供给（satellite DAQ）
  - line=ln-dd118264 daq=dn-0cbec066 dcw=✘ recipe=rc-24746c82 ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 65.69999694824219
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ · governed write · F5 interlock

- ✘ **line-1-io** (fail) — Line1 [modbus-tcp] integration check
  - ✔ DAQ samples stored 10  points (modbus-tcp real driver）
  - ✔ 约6写 p50=17.714ms p95=24.883ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal writeblocked
- ✘ **line-2-io** (fail) — Line2 [opcua] integration check
  - ✔ DAQ samples stored 10  points (opcua real driver）
  - ✔ 约6写 p50=18.026ms p95=20.647ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal writeblocked
- ✘ **line-3-io** (fail) — Line3 [mqtt] integration check
  - ✔ DAQ samples stored 11  points (mqtt real driver）
  - ✔ 约6写 p50=17.424ms p95=18.299ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal writeblocked
- ✘ **line-4-io** (fail) — Line4 [http] integration check
  - ✔ DAQ samples stored 12  points (http real driver）
  - ✔ 约6写 p50=18.524ms p95=26.183ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal writeblocked
- ✔ **line-5-io** (pass) — Line5 [modbus-rtu] integration check
  - ✔ DAQ samples stored 13  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass) — 闭环夹具（channel+agent）
  - channel=3b96634e-0a2b-49ec-9621-ce66a2aabc99
  - agent=99393137-a659-4cb9-a24a-ceee2287bc60
  - harness=opencode
- ✔ **tool-bridge** (pass) — opencode 的 host 工具直调面可用
  - 探测 my_industrial_nodes → 你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。
- ▲ **line-1-loop** (warn) — Line1 [modbus-tcp] Agent 闭环收敛（0/3 轮）
  - iter1: SP→194.96 ✘ · 回读 203.39999389648438 ✘ · daq ✔ · judge ✘(无record)
  - iter2: SP→197.48 ✘ · 回读 203.39999389648438 ✘ · daq ✔ · judge ✘(无record)
  - iter3: SP→200 ✘ · 回读 203.39999389648438 ✘ · daq ✔ · judge ✘(无record)
  - 向窗口中心收敛 ✘ · 耗时 4.295s
- ▲ **line-2-loop** (warn) — Line2 [opcua] Agent 闭环收敛（0/3 轮）
  - iter1: SP→144.6 ✘ · 回读 154 ✘ · daq ✔ · judge ✘(无record)
  - iter2: SP→147.3 ✘ · 回读 154 ✘ · daq ✔ · judge ✘(无record)
  - iter3: SP→150 ✘ · 回读 154 ✘ · daq ✔ · judge ✘(无record)
  - 向窗口中心收敛 ✘ · 耗时 4.253s
- ▲ **line-3-loop** (warn) — Line3 [mqtt] Agent 闭环收敛（0/3 轮）
  - iter1: SP→91.4 ✘ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✘(无record)
  - iter2: SP→93.2 ✘ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✘(无record)
  - iter3: SP→95 ✘ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✘(无record)
  - 向窗口中心收敛 ✘ · 耗时 4.246s
- ▲ **line-4-loop** (warn) — Line4 [http] Agent 闭环收敛（0/3 轮）
  - iter1: SP→0.946 ✘ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✘(无record)
  - iter2: SP→0.973 ✘ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✘(无record)
  - iter3: SP→1 ✘ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✘(无record)
  - 向窗口中心收敛 ✘ · 耗时 4.277s
- ✔ **plant-response** (pass) — 工艺模型响应（SP→plant truth 随动）
  - 真值样本 6 → 72
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":216,"defect":0.653,"eng

### P4b — Rollback & optimization records

- ▲ **line-1-optrecord** (warn) — Line1 优化记录生命周期
  - current 203.39999389648438 → record A writes 206.76 (up)，记录 B writes 200.04 (down); opposite directions to dodge the rollback cooldown
  - ✘ (keep path) no record_id; receipt: 下发被拒绝:当前写入频繁:「L1-DCW-modbus-tcp ip16husa」处于写入保持窗口(剩余 4s),请稍后再试(节点 L1-DCW-modbus-tcp ip16husa,物理量 烘箱温度设定;设定值必须落在安全量程与活动配方工艺窗口内)
  - ✘ (rollback path) no record_id; receipt: 下发被拒绝:当前写入频繁:「L1-DCW-modbus-tcp ip16husa」处于写入保持窗口(剩余 4s),请稍后再试(节点 L1-DCW-modbus-tcp ip16husa,物理量 烘箱温度设定;设定值必须落在安全量程与活动配方工艺窗口内)
  - ✘ 优化记录查询面可见本节点记录 0  (judged=0）
- ✔ **line-1-rbjudge** (pass) — Line1 撤销记录 opt-2f352bac 判定关闭
  - REST judge keep → status 200
- ▲ **line-1-rollback** (warn) — Line1 node-level single-step rollback (undo stack)
  - ✘ write 205.04 effective (readback 203.39999389648438, before 203.39999389648438)
  - ✔ journal rollback 受理（status 200，记录 opt-2f352bac）
  - ✘ readback after rollback 200 (expected back to 203.39999389648438, tolerance 0.75)
- ✔ **param-ledger** (pass) — 参数台账（三值对照 + 在册历史）
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ▲ **line-2-hitl** (warn) — Line2 HITL 审批闭环
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-0866e6cb（detail: L2-DCW-opcua ip16husa(烘箱温度设定)设定 148.2rpm,有效写入区间 141~159rpm(节点安全量程 ∩ 配方）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 下发被拒绝:当前写入频繁:「L2-DCW-opcua ip16husa」处于写入保持窗口(剩余 5s),请稍后再试(节点 L2-DCW-opcua ip16husa,物理量 烘箱温
  - ✘ post-approval PLC effect: readback 154 (expected 148.2)
  - 审批裁决时延 11 ms（挂起→批准，含轮询周期）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass) — 治理只读面
  - ✔ 参数变更账本 journal：本产线 3  anchors (source coverage  rollback/manual/recipe）
  - ✔ audit: 178 entries
  - ✔ ops-logs: 178 entries
  - ✔ 报警记录：全局 12 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass) — Line1 [modbus-tcp] recipe lifecycle
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-49afee09 → lastGood=rr-49afee09
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass) — Line2 [opcua] recipe lifecycle
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-fa341e25 → lastGood=rr-fa341e25
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ✔ **param-facade** (pass) — Line2 [opcua] 参数面自动生成且无寄存器泄漏
  - param=pp-8d863ec1 key=temp-sp unit=rpm
  - 含 register/dataType/driverConfig? 无 ✔
- ✔ **param-limits** (pass) — Line2 基准限界 [143.7,156.3] + 产品限界 [146.22,153.78] 设定
  - 有效交集(含配方窗) 141~159 → param 143.7~156.3 → product 146.22~153.78 · node 层 50~200（四层收窄：node ∩ param ∩ product ∩ recipe）
- ✘ **param-write-governed** (fail) — Line2 参数面写入联锁（交集内写入 · 越产品层拦截 · 越基准层拦截 · 参数读回）
  - 148.866 → ✘ 当前写入频繁:「L2-DCW-opcua ip16husa」处于写入保持窗口(剩余 3s),请稍后再试
  - 155.04 → ✔ 产品层拦截
  - 157.65 → ✔ 基准限界层拦截
  - param read → ✔ 150rpm
- ✘ **agent-param-tools** (fail) — Line2 Agent param_control/param_read（语义写 · 越产品层拒 · 参数读 · 未绑定拒）
  - param_control 148.11 → ✘ 下发被拒绝:当前写入频繁:「L2-DCW-opcua ip16husa」处于写入保持窗口(剩余 3s),请稍后再试(工艺参数 temp-sp;有效写入区间 146.22~153.7
  - param_control 155.04 → ✔ 产品层拦截
  - param_read → ✔
  - unbound agent → ✔ 权限面拒绝

### P4m — AgentTeam optimization mission (task board → governed writes → attainment)

- ✔ **mission-board** (pass) — 任务板：优化任务下达并由 lead 派发
  - channel=f0dd2782-a7a3-4bbc-b79c-65221355f173 parent=4dff3b1e-91e0-4bc8-a3f0-90a858dd3a8e leadChild=b5cc4d22-3567-49e0-a5a5-a0632afc8fb6 assignee=83789bf9-4656-46ac-b67f-d865fcfbe348
- ✔ **mission-timescale-read** (pass) — 时段数据读取（daq_query from/to/bucket）
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip16husa(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-09-22T12:00 ~ 2026-09-22T12:05(降采样 1000ms)   样本 33 
- ✘ **mission-governed-write** (fail) — 受治理参数下发（0 写全开记录+判定）
  - iter1: write rejected → 下发被拒绝:当前写入频繁:「L1-DCW-modbus-tcp ip16husa」处于写入保持窗口(剩余 7s),请稍后再试(节点 L1-DCW-modbus-tcp ip16hu
- ✔ **mission-journal** (pass) — 参数账本归因（Agent source 可追溯）
  - journal sample: 窗口内无优化记录(该节点/配方尚无 Agent 调控历史)。
- ▲ **mission-attained** (warn) — 优化目标达成（|PV−204.704|≤0.75）
  - writes=0/3 · finalPV=203.39999389648438 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass) — 任务收口（lead 派发→worker 剧本完成→父任务聚合）
  - terminalState=COMPLETED · writes=0 · reached=false

### P6 — Closed-loop optimization benchmark (multi-seed)

- ✔ **twin-nodes** (pass) — cast-film twin node provisioning（执行器 + 传感器）
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass) — 离线最优 W*（ground truth）
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-22T04:05:05.421Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ▲ **seed-42** (warn) — seed=42 闭环优化（J/J*=0.964）
  - 预热 0.02s（熔体温度 201.1℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.50μm defect=0.133% P=18.65MPa T=206.9℃ N=150 v=95.0 → J=68.54
  - iter1 下发 N=135 v=95 z=200 → h=54.33μm defect=0.500% P=18.30MPa T=203.2℃ → J=73.81 
  - iter2 下发 N=138 v=95 z=200 → h=54.63μm defect=0.533% P=18.23MPa T=201.2℃ → J=72.06 
- ✔ **seed-43** (pass) — seed=43 闭环优化（J/J*=0.971）
  - 预热 0.018s（熔体温度 200.14℃，达工艺窗 [195,225]）
  - iter0 起点：h=51.02μm defect=0.300% P=16.98MPa T=206.3℃ N=150 v=95.0 → J=87.27
  - ✔ 连续两次评估满足收敛判据，第 1 轮前终止
  - 收敛=true · 迭代=0 · 写=0 · rejected=0 · J0=87.271 → Jend=87.271 · J*=89.894 · 比值=0.971
- ▲ **seed-44** (warn) — seed=44 闭环优化（J/J*=0.784）
  - 预热 0.018s（熔体温度 205.98℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.67μm defect=0.050% P=18.62MPa T=206.4℃ N=150 v=95.0 → J=67.89
  - iter1 下发 N=135 v=95 z=200 → h=55.03μm defect=0.367% P=18.30MPa T=203.0℃ → J=70.38 
  - iter2 下发 N=136 v=95 z=200 → h=53.87μm defect=0.667% P=18.27MPa T=201.3℃ → J=75.86 
- ✘ **closedloop-aggregate** (fail) — 闭环优化聚合（n=3）
  - J/J*：min 0.784 · mean 0.906 · max 0.971（J* = 89.894）
  - J start均值 74.566 → end均值 81.478
  - 平均迭代 4  · 总写 11 · 越界rejected 8 · 收敛 2/3 · 平均墙钟 60.283s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass) — 多形态数采（向量/图像帧）
  - ✔ 向量轮廓帧 2 （42.109,42.507,42.736,42.914,42.401,43.462,42.657,43.678,43.597,43.906,43.478,43.843,44.188,44.066,44.588,44.968,44.181,44.364,44.543,45.288,44.813,45.011,44.751,44.705,45.345,45.611,45.496,45.265,44.781,45.205,45.179,44.695,45.05
  - ✔ 图像帧 2 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass) — second plant scenario applied: film-line
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] provisioned
  - line=ln-326d8e2b daq=dn-a73b799b dcw=dw-497ba604
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass) — scenario[film-line] line 2 [opcua] provisioned
  - line=ln-4cbf0042 daq=dn-0ba93aa3 dcw=dw-1b8fd9f4
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass) — scenario[film-line] line 3 [mqtt] provisioned
  - line=ln-35fccaa2 daq=dn-f7aa37d9 dcw=dw-a571a463
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass) — scenario[film-line] line 4 [modbus-rtu] provisioned (satellite DAQ)
  - line=ln-35fccaa2 daq=dn-5b1f854e dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass) — scenario[film-line] line 5 [http] provisioned (satellite DAQ)
  - line=ln-35fccaa2 daq=dn-540609d7 dcw=✘
  - (no SP export → satellite DAQ)
- ✘ **port-1-modbus-tcp** (fail) — scenario[film-line] line 1 [modbus-tcp] integration
  - ✔ DAQ samples 11 pts (modbus-tcp real driver)
  - ✔ governed write 186.24 → HTTP 200
  - readback deviation 0.04
  - ✔ F5 out-of-window 3/3 rejected · legal write BLOCKED
- ✘ **port-2-opcua** (fail) — scenario[film-line] line 2 [opcua] integration
  - ✔ DAQ samples 11 pts (opcua real driver)
  - ✔ governed write 186.24 → HTTP 200
  - readback deviation 0
  - ✔ F5 out-of-window 3/3 rejected · legal write BLOCKED
- ✘ **port-3-mqtt** (fail) — scenario[film-line] line 3 [mqtt] integration
  - ✔ DAQ samples 11 pts (mqtt real driver)
  - ✔ governed write 62.4 → HTTP 200
  - ✔ F5 out-of-window 3/3 rejected · legal write BLOCKED
- ✔ **port-4-modbus-rtu** (pass) — scenario[film-line] line 4 [modbus-rtu] integration
  - ✔ DAQ samples 11 pts (modbus-rtu real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)
- ✔ **port-5-http** (pass) — scenario[film-line] line 5 [http] integration
  - ✔ DAQ samples 10 pts (http real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)

### P8b — System backstop drill (bounded autonomy)

- ✔ **cleanup** (pass) — 遗留 open 记录清场（关闭 1/1 条）
  - records closed: 1/1
- ✘ **open-record** (fail) — 开优化记录
  - 下发被拒绝:当前写入频繁:「L1-DCW-modbus-tcp ip16husap8」处于写入保持窗口(剩余 29s),请稍后再试(节点 L1-DCW-modbus-tcp ip16husap8,物理量 烘箱温度设定;设定值必须落在安全量程与活动配方工艺窗口内)
- ✔ **restore** (pass) — 过程量解冻 + 第一场景恢复: cast-film-physics
  - rig left as found

### P9 — Platform subsystems (team / memory / registry)

- ✔ **team-dispatch** (pass) — 团队调度（lead 派发 → worker 完成）
  - 终态 COMPLETED · assignee=1d9fa8ad-639f-4125-b590-244cdaa3111a（lead 认领父任务） · 子任务派发给 worker: ✔
- ✔ **team-memory** (pass) — 团队记忆写入 + dedupKey 幂等
  - POST×2 status 200/200 → 列表中匹配 1 条（期望 1）
- ✔ **harness-registry** (pass) — 引擎注册表枚举 + 可用性探测
  - 注册 14 引擎（期望 ≥14） · 环境可用 14 · 覆盖 mock/RPC/SDK/CLI 族

## Metric registry

| Group | Metric | Value | Unit | Note |
|---|---|---:|---|---|
| plant | W_star_objective | 89.894 |  | offline grid-search optimum (benchmark ground truth) |
| provision | lines_created | 4 |  | 可开跑Line（另有 1 satellite DAQ） |
| provision | daq_nodes | 5 |  | real-protocol DAQ nodes |
| gov | intercept_modbus-tcp | 1 |  | governance interception rate |
| gov | intercept_opcua | 1 |  | governance interception rate |
| gov | intercept_mqtt | 1 |  | governance interception rate |
| gov | intercept_http | 1 |  | governance interception rate |
| provision | lines_sampling | 5 |  | real driver produced samples |
| gov | intercept_rate_all | 1 |  | 全协议合并 |
| loop | tool_loops_ok | 0 |  lines | 工具级闭环达成 |
| loop | mission_writes | 0 |  | AgentTeam 优化任务受治理写次数 |
| loop | mission_attained | 0 |  | AgentTeam 优化任务达标 |
| gov | record_keep_rollback_ok | 0 |  | 优化记录判定/执行分离 |
| hitl | approval_latency_ms | 11 | ms | 挂起→批准（含 800ms 轮询粒度） |
| audit | journal_anchors | 3 |  | 本Line参数变更账本 |
| audit | audit_entries | 178 |  | 全局审计目 |
| audit | ops_logs | 178 |  | 全局运维日志 |
| recipe | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| gov | param_layer_checks_ok | 2 | /4 | 工艺参数映射层全链 |
| closedloop | J_over_Jstar_mean | 0.906 |  | n=3 seeds，写路径=governed |
| closedloop | J_over_Jstar_min | 0.784 |  | 最差 seed（保守下界） |
| closedloop | J_end_mean | 81.478 |  | J* = 89.894 |
| closedloop | cl_iters_mean | 4 |  | 闭环收敛迭代数 |
| closedloop | cl_writes_total | 11 |  | 受治理的闭环写总数 |
| closedloop | cl_rejected_total | 8 |  | 越界被拒（治理拦截） |
| daq | vector_frames | 2 |  | 厚度横向轮廓 |
| daq | image_frames | 2 |  | CCD 表面图像 |
| portability | scenario2_lines | 3 |  | second preset "film-line" (config-only) |
| portability | scenario2_intercept_rate | 1 |  | F5 out-of-window interception on second scenario |
| portability | scenario2_false_blocks | 3 |  | legal in-window writes blocked on second scenario |
| biax | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| biax | sp_signals | 30 |  | 可写工艺 SP |
| biax | created_missing | 9 |  | 本次补建的缺失设备数 |
| biax | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| biax | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| biax | mission_writes | 3 |  | AgentTeam 双拉任务受治理写次数 |
| biax | mission_distinct_knobs | 3 |  | 参与闭环的执行节点数 |
| biax | mission_attained | 1 |  | 厚度达标 25.0±0.7μm |
| biax | mission_final_thickness | 25.68 | μm | 终态厚度 |
| team | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| memory | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| agent | harness_registry | 14 |  | environment-available 14 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict FAIL, grade F). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._
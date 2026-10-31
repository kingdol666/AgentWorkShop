# AW-IndustrialBench · Integrated Pipeline Report

> **FAIL** — score **83.4**/100, grade **F**. Hard gate tripped: at least one check/phase failed; the score is informational only.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20261029133020-1or0` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `7d2f6c6a288f4795` (sha256 over 11 checker sources) |
| Git commit | `356b5764` |
| Runtime | v24.19.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3005 · http://127.0.0.1:4016 |
| Tool harness | opencode (deterministic) · LLM agent: (none) |
| Reproduce | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 52 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 30.419 ms | incl. real protocol transactions |
| Closed-loop J/J* | 78.7 % | n=3 seeds · worst 77.7% · J*=89.894 |
| Tool-level loops | 0 | dcw→daq→judge ×3 convergence |
| Param-layer governance | 3/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | not fired | P8b drill requires scenario 2 |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 0 knobs · 0 writes → ?μm |
| LLM agent loop | off | --agent omp enables |
| Verdict | FAIL | 55/70 checks · hard gate tripped |

## Simulated production line profile

> Preset `cast-film-physics` — Cast-film extrusion digital twin (plant-model physics engine). An extrusion cast-film line: resin → screw melting → die → casting → thickness gauge. Six writable setpoints (3 zone temperatures, screw speed, line speed, die gap) act on a physics engine whose observable process quantities are melt temperature, melt pressure, film thickness, defect rate and gels count.

**Physics.** Deterministic plant model (seeded): first-order thermal lag on melt temperature, algebraic thickness h ∝ N/v from mass conservation, pressure/defect couplings — scored by J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput.
 Plant engine state at report time: phase=`warmup`, seed=`42`.

**Totals.** 5 PLC devices across 5 protocols (modbus-tcp, modbus-rtu, opcua, mqtt, http); **6 writable setpoints (SP → DCW nodes)** and **7 process quantities (PV → DAQ nodes)**; the platform side provisions 156 lines with 702 write nodes and 639 acquisition nodes.

### Devices & fieldbus endpoints

| # | Device | Protocol | Endpoint | Signals (SP+PV) |
|---:|---|---|---|---:|
| 1 | 挤出主机PLC(Modbus TCP) | `modbus-tcp` | `0.0.0.0:22040 unit=1` | 4 |
| 2 | 晶点计数从站(Modbus RTU) | `modbus-rtu` | `0.0.0.0:21041 unit=1` | 1 |
| 3 | 熔体泵送单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:11840` | 2 |
| 4 | 在线测厚仪(MQTT) | `mqtt` | `mqtt://127.0.0.1:24830` | 2 |
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
| L1-DCW-modbus-tcp ip16fw6w (`dw-1f63078`) | DCW write | `modbus-tcp` | Integrated线1 ip16fw6w | ℃ | [120, 260] |
| L2-DCW-opcua ip16fw6w (`dw-3167914`) | DCW write | `opcua` | Integrated线2 ip16fw6w | rpm | [50, 200] |
| L3-DCW-mqtt ip16fw6w (`dw-58ad195`) | DCW write | `mqtt` | Integrated线3 ip16fw6w | m/min | [20, 120] |
| L4-DCW-http ip16fw6w (`dw-c1e1b21`) | DCW write | `http` | Integrated线4 ip16fw6w | mm | [0.5, 2] |
| 加热区1SP ip16fw6wcl (`dw-bb95217`) | DCW write | `modbus-tcp` | CastFilm线 ip16fw6wcl | ℃ | [120, 260] |
| 加热区2SP ip16fw6wcl (`dw-13654b5`) | DCW write | `modbus-tcp` | CastFilm线 ip16fw6wcl | ℃ | [120, 260] |
| 加热区3SP ip16fw6wcl (`dw-43f4fd6`) | DCW write | `modbus-tcp` | CastFilm线 ip16fw6wcl | ℃ | [120, 260] |
| ScrewSpeedSP ip16fw6wcl (`dw-a3f11af`) | DCW write | `opcua` | CastFilm线 ip16fw6wcl | rpm | [50, 200] |
| lineSpeedSP ip16fw6wcl (`dw-5a84fd6`) | DCW write | `mqtt` | CastFilm线 ip16fw6wcl | m/min | [20, 120] |
| dieGapSP ip16fw6wcl (`dw-b8f490e`) | DCW write | `http` | CastFilm线 ip16fw6wcl | mm | [0.5, 2] |
| L1-DCW-modbus-tcp ip16fw6wp8 (`dw-cba45c0`) | DCW write | `modbus-tcp` | Integrated线1 ip16fw6wp8 | ℃ | [0, 260] |
| L2-DCW-opcua ip16fw6wp8 (`dw-1e41a79`) | DCW write | `opcua` | Integrated线2 ip16fw6wp8 | ℃ | [0, 260] |
| L3-DCW-mqtt ip16fw6wp8 (`dw-92a9024`) | DCW write | `mqtt` | Integrated线3 ip16fw6wp8 | ℃ | [0, 100] |
| 干燥温度SP·ip16fw6w (`dw-e0c741d`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [120, 200] |
| 露点SP·ip16fw6w (`dw-05dcc87`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [-80, -20] |
| 喂料速率SP·ip16fw6w (`dw-3dc5cc6`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16fw6w | kg/h | [100, 1200] |
| 机筒温度区1SP·ip16fw6w (`dw-92eba03`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [220, 300] |
| 机筒温度区2SP·ip16fw6w (`dw-3e5d649`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [220, 300] |
| 机筒温度区3SP·ip16fw6w (`dw-aac6ff7`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [220, 300] |
| 机筒温度区4SP·ip16fw6w (`dw-324871a`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [220, 300] |
| 机筒温度区5SP·ip16fw6w (`dw-3a1574c`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [220, 300] |
| 螺杆转速SP·ip16fw6w (`dw-434e8d5`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | rpm | [20, 100] |
| 计量泵转速SP·ip16fw6w (`dw-11adede`) | DCW write | `modbus-rtu` | 双拉薄膜产线 biax-ip16fw6w | rpm | [15, 60] |
| 模唇温度SP·ip16fw6w (`dw-30cef42`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [250, 300] |
| 急冷辊温度SP·ip16fw6w (`dw-0931ad8`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [10, 60] |
| 铸片辊速度SP·ip16fw6w (`dw-0c0a619`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | m/min | [10, 60] |
| 静电吸附电压SP·ip16fw6w (`dw-1df270b`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | kV | [4, 12] |
| 预热辊1温度SP·ip16fw6w (`dw-2db66cf`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [70, 140] |
| 预热辊2温度SP·ip16fw6w (`dw-25a04b3`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [70, 140] |
| 预热辊3温度SP·ip16fw6w (`dw-2006144`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [70, 140] |
| 慢辊线速度SP·ip16fw6w (`dw-5e0d135`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | m/min | [10, 80] |
| 快辊线速度SP·ip16fw6w (`dw-4f706c4`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | m/min | [30, 260] |
| 纵拉退火辊SP·ip16fw6w (`dw-38599c6`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [90, 170] |
| TDO预热段SP·ip16fw6w (`dw-57f5162`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [80, 140] |
| TDO拉伸段SP·ip16fw6w (`dw-6ea3791`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [90, 150] |
| TDO定型段SP·ip16fw6w (`dw-82d53f4`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [180, 250] |
| 链夹速度SP·ip16fw6w (`dw-441be48`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16fw6w | m/min | [40, 260] |
| 出口轨宽SP·ip16fw6w (`dw-639acaf`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16fw6w | mm | [1800, 4200] |
| coronaPower·ip16fw6w (`dw-f1c935c`) | DCW write | `http` | 双拉薄膜产线 biax-ip16fw6w | kW | [0.5, 8] |
| 收卷张力SP·ip16fw6w (`dw-fef5a72`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | N | [30, 180] |
| L1-DAQ-modbus-tcp ip16fw6w (`dn-422064a`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16fw6w | ℃ | [0, 400] |
| L2-DAQ-opcua ip16fw6w (`dn-ece7f1b`) | DAQ acquire | `opcua` | Integrated线2 ip16fw6w | MPa | [0, 45] |
| L3-DAQ-mqtt ip16fw6w (`dn-860c3d5`) | DAQ acquire | `mqtt` | Integrated线3 ip16fw6w | μm | [0, 400] |
| L4-DAQ-http ip16fw6w (`dn-79ce164`) | DAQ acquire | `http` | Integrated线4 ip16fw6w | μm | [0, 400] |
| L5-DAQ-modbus-rtu ip16fw6w(sat) (`dn-616dc83`) | DAQ acquire | `modbus-rtu` | Integrated线4 ip16fw6w | 个/m² | [0, 500] |
| 熔体温度 ip16fw6wcl (`dn-2b32abc`) | DAQ acquire | `modbus-tcp` | CastFilm线 ip16fw6wcl | ℃ | [0, 400] |
| 晶点计数 ip16fw6wcl (`dn-b09edf5`) | DAQ acquire | `modbus-rtu` | CastFilm线 ip16fw6wcl | 个/m² | [0, 500] |
| MeltPressure ip16fw6wcl (`dn-8471f14`) | DAQ acquire | `opcua` | CastFilm线 ip16fw6wcl | MPa | [0, 45] |
| thick ip16fw6wcl (`dn-15c3e75`) | DAQ acquire | `mqtt` | CastFilm线 ip16fw6wcl | μm | [0, 400] |
| defect ip16fw6wcl (`dn-61d5b35`) | DAQ acquire | `http` | CastFilm线 ip16fw6wcl | % | [0, 100] |
| profile ip16fw6w (`dn-956258c`) | DAQ acquire | `http` | Integrated线1 ip16fw6w | mm | [0.4, 0.65] |
| ccd ip16fw6w (`dn-28504eb`) | DAQ acquire | `http` | Integrated线1 ip16fw6w | 灰度 | [0, 255] |
| L1-DAQ-modbus-tcp ip16fw6wp8 (`dn-d1277b2`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16fw6wp8 | ℃ | [0, 260] |
| L2-DAQ-opcua ip16fw6wp8 (`dn-bb74bcd`) | DAQ acquire | `opcua` | Integrated线2 ip16fw6wp8 | ℃ | [0, 260] |
| L3-DAQ-mqtt ip16fw6wp8 (`dn-7fb3c76`) | DAQ acquire | `mqtt` | Integrated线3 ip16fw6wp8 | ℃ | [0, 100] |
| L4-DAQ-modbus-rtu ip16fw6wp8(sat) (`dn-6d9e6b8`) | DAQ acquire | `modbus-rtu` | Integrated线3 ip16fw6wp8 | ℃ | [0, 100] |
| L5-DAQ-http ip16fw6wp8(sat) (`dn-4451d2a`) | DAQ acquire | `http` | Integrated线3 ip16fw6wp8 | L/min | [0, 100] |
| 干燥塔温度·ip16fw6w (`dn-63e3df5`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [20, 220] |
| 切片残水·ip16fw6w (`dn-2a14f13`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16fw6w | ppm | [0, 120] |
| 熔体温度·ip16fw6w (`dn-9dce48b`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [200, 330] |
| 泵前熔压·ip16fw6w (`dn-92af173`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | MPa | [0, 35] |
| 泵出口压力·ip16fw6w (`dn-4333ae5`) | DAQ acquire | `modbus-rtu` | 双拉薄膜产线 biax-ip16fw6w | MPa | [0, 35] |
| 铸片辊面温度·ip16fw6w (`dn-7b8d296`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [0, 80] |
| 纵拉膜温·ip16fw6w (`dn-b46f3e6`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16fw6w | ℃ | [40, 160] |

_(showing first 40 DCW / 24 DAQ nodes; full inventory in `line-profile.json`)_

## Phase scorecard (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---:|---:|---:|---:|---:|---:|
| P0 | Bootstrap · simulator & platform | 2 | 0 | 0 | 0 | 100.0 | 1 |
| P1 | Plant model + offline optimum W* | 3 | 0 | 0 | 0 | 100.0 | 1 |
| P2 | Multi-protocol line provisioning | 6 | 0 | 0 | 0 | 100.0 | 2 |
| P3 | DAQ · governed write · F5 interlock | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P4 | Agent-tool closed loop (3-cycle convergence) | 3 | 4 | 0 | 0 | 71.4 | 3 |
| P4b | Rollback & optimization records | 3 | 1 | 0 | 0 | 87.5 | 2 |
| P4c | HITL approval gate | 0 | 1 | 0 | 0 | 50.0 | 2 |
| P4d | Audit / ledger read surfaces | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P4e | Recipe lifecycle | 2 | 0 | 0 | 0 | 100.0 | 2 |
| P4f | Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits) | 3 | 0 | 1 | 0 | 75.0 | 3 |
| P4m | AgentTeam optimization mission (task board → governed writes → attainment) | 4 | 1 | 1 | 0 | 75.0 | 3 |
| P6 | Closed-loop optimization benchmark (multi-seed) | 2 | 3 | 1 | 0 | 58.3 | 3 |
| P7 | Multimodal acquisition (vector/image) | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P8 | Cross-scenario portability | 11 | 0 | 0 | 0 | 100.0 | 3 |
| P8b | System backstop drill (bounded autonomy) | 2 | 0 | 1 | 0 | 66.7 | 3 |
| P9 | Platform subsystems (team / memory / registry) | 3 | 0 | 0 | 0 | 100.0 | 1 |
| P10 | Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop) | 4 | 1 | 0 | 0 | 90.0 | 3 |
| **Overall** | | | | | | **83.4** | 37 |

## Closed-loop optimization · per-seed

| Seed | J0 | Jend | J* | J/J* % | Iters | Governed writes | Rejected | Converged |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 42 | 64.16 | 71.63 | 89.89 | 79.7 | 8 | 8 | 8 | no |
| 43 | 66.44 | 69.81 | 89.89 | 77.7 | 8 | 8 | 8 | no |
| 44 | 67.06 | 70.75 | 89.89 | 78.7 | 8 | 8 | 8 | no |

## AgentTeam closed-loop tuning walkthrough

How an optimization team is assembled and drives the line, end to end: (1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; (2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); (3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; (4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; (5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.

### Deterministic closed-loop benchmark — seed 42 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 56.05 | 0.567 | 17.50 | 210.0 | 150 | 95.0 | 200.0 | 64.16 | 0 |
| 1 | 56.03 | 0.167 | 18.48 | 210.0 | 150 | 95.0 | 200.0 | 65.50 | 24.1 |
| 2 | 55.80 | 0.167 | 18.72 | 208.8 | 150 | 95.0 | 200.0 | 66.79 | 36.201 |
| 3 | 55.62 | 0.100 | 18.70 | 207.5 | 150 | 95.0 | 200.0 | 68.00 | 48.257 |
| 4 | 55.22 | 0.133 | 18.72 | 206.5 | 150 | 95.0 | 200.0 | 70.10 | 60.323 |
| 5 | 55.57 | 0.267 | 18.53 | 205.9 | 150 | 95.0 | 200.0 | 67.76 | 72.441 |
| 6 | 55.50 | 0.250 | 18.50 | 205.5 | 150 | 95.0 | 200.0 | 68.18 | 84.554 |
| 7 | 55.22 | 0.317 | 18.45 | 204.4 | 150 | 95.0 | 200.0 | 69.53 | 96.636 |
| 8 | 54.37 | 0.467 | 18.42 | 204.0 | 150 | 95.0 | 200.0 | 73.73 | 108.704 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **79.7 %**; governed writes 8 (rejected 8), optimization records 0.

### Deterministic closed-loop benchmark — seed 43 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.61 | 0.617 | 17.47 | 210.0 | 150 | 95.0 | 200.0 | 66.44 | 0 |
| 1 | 56.08 | 0.183 | 18.57 | 209.7 | 150 | 95.0 | 200.0 | 65.18 | 24.267 |
| 2 | 55.87 | 0.067 | 18.67 | 208.5 | 150 | 95.0 | 200.0 | 66.73 | 36.381 |
| 3 | 55.92 | 0.100 | 18.70 | 207.5 | 150 | 95.0 | 200.0 | 66.35 | 48.497 |
| 4 | 55.67 | 0.167 | 18.58 | 206.4 | 150 | 95.0 | 200.0 | 67.52 | 60.61 |
| 5 | 55.40 | 0.233 | 18.55 | 205.7 | 150 | 95.0 | 200.0 | 68.78 | 72.759 |
| 6 | 55.38 | 0.200 | 18.48 | 205.2 | 150 | 95.0 | 200.0 | 68.98 | 84.893 |
| 7 | 55.38 | 0.383 | 18.43 | 204.3 | 150 | 95.0 | 200.0 | 68.40 | 97.007 |
| 8 | 54.90 | 0.333 | 18.38 | 203.8 | 150 | 95.0 | 200.0 | 71.22 | 109.13 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **77.7 %**; governed writes 8 (rejected 8), optimization records 0.

### Deterministic closed-loop benchmark — seed 44 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.47 | 0.667 | 17.58 | 210.1 | 150 | 95.0 | 200.0 | 67.06 | 0 |
| 1 | 55.87 | 0.150 | 18.52 | 209.7 | 150 | 95.0 | 200.0 | 66.47 | 24.226 |
| 2 | 55.80 | 0.100 | 18.65 | 208.5 | 150 | 95.0 | 200.0 | 67.00 | 36.359 |
| 3 | 55.47 | 0.133 | 18.73 | 207.4 | 150 | 95.0 | 200.0 | 68.72 | 48.48 |
| 4 | 55.38 | 0.133 | 18.60 | 206.8 | 150 | 95.0 | 200.0 | 69.18 | 60.601 |
| 5 | 54.98 | 0.117 | 18.55 | 205.9 | 150 | 95.0 | 200.0 | 71.44 | 72.716 |
| 6 | 55.00 | 0.317 | 18.55 | 205.2 | 150 | 95.0 | 200.0 | 70.72 | 84.812 |
| 7 | 55.07 | 0.350 | 18.48 | 204.1 | 150 | 95.0 | 200.0 | 70.25 | 96.935 |
| 8 | 54.87 | 0.383 | 18.35 | 203.4 | 150 | 95.0 | 200.0 | 71.24 | 109.033 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **78.7 %**; governed writes 8 (rejected 8), optimization records 0.

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `agentteam-mission.log` | 0.8 KB | AgentTeam optimization mission — full task-board trajectory |
| `line-profile.json` | 351.5 KB | Simulated line profile — devices, protocols, endpoints, SP/PV signal inventory, AW node mapping |
| `metrics.csv` | 2.2 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 451.5 KB | Full machine-readable results (checks, phases, evidence, KPIs, line profile, agent-team traces) |
| `summary.json` | 13.6 KB | Verdict + KPI + per-line summary (compare/aggregate input) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✔ **platform-reachable** (pass) — platform reachable & authenticated
  - 平台 http://127.0.0.1:3005：自动分离启动 pid=92456（日志 D:\codes\ABO\aw-bench-platform.log）
  - 鉴权 OK (login)
  - simulator http://127.0.0.1:4016：自动启动 pid=60068
- ✔ **daq-sampling-ready** (pass) — 数采采样恢复(produced 增长)
  - 等待 7s(produced=20)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass) — 预设 cast-film-physics 已应用
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **field-defaults** (pass) — 现场=蓝图默认值（6 信号核对）
  - 全部信号初始值=蓝图默认值
- ✔ **offline-optimum** (pass) — offline optimum W* (ground truth) available
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-10-29T13:32:04.131Z"}

### P10 — Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)

- ✔ **biax-ensure** (pass) — 节点探测补建(9 建缺失 / 0 修复 / 0 原样)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass) — 五协议多节点建线(DCW 30 + DAQ 19,驱动实测 9/9)
  - line=ln-156b5bb6 recipe=rc-44b747d1 started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass) — 测厚仪真实链路采样(1 点)
  - daq=dn-1fa566a1 · samples=1
- ▲ **biax-agent-cards** (warn) — Agent 语义卡含双拉工艺描述(semantics 贯通)
  - 语义卡长度 16048 · 关键词命中 铸片辊速度
  - sample: ### ⚙ 频道执行模式:auto(默认,频道不加额外约束)—— 是否人工批准由产线总闸与你的绑定模式决定;自动执行的下发必须附带 hypothesis 依据,四层限界/单步上限/运行门照常生效  #### ◆ L1-DCW-modbus-tcp ip161igf [id=dw-e1853dc6] - 物理量: 烘箱温
- ✔ **biax-restore** (pass) — 双拉线停止 + 第一场景恢复: cast-film-physics
  - rig left as found

### P2 — Multi-protocol line provisioning

- ✔ **gateway** (pass) — gateway controller start (idempotent)
  - POST /api/workshop/daq/controller {action:start}
  - 采样仍受「活动Line批」门控，故每台有 SP 的devices自成一可开跑Line
- ✔ **line-1-modbus-tcp** (pass) — Line1 [modbus-tcp] 供给
  - line=ln-e429e77c daq=dn-2dac753f dcw=dw-e1853dc6 recipe=rc-a49eb7be
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 209.24000549316406
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass) — Line2 [opcua] 供给
  - line=ln-537de0cb daq=dn-02bbcf3c dcw=dw-daf4c057 recipe=rc-490e23bc
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 16.28
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass) — Line3 [mqtt] 供给
  - line=ln-77b04e2c daq=dn-b9a356b0 dcw=dw-0cd0ba48 recipe=rc-5366be51
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,aw/sim/thick → scalar 50.63(jsonPath=data.thick)(被动订阅:收到报文即入库)
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass) — Line4 [http] 供给
  - line=ln-43b40ee5 daq=dn-193d22c8 dcw=dw-8ea008be recipe=rc-573ca452
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 0.654
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass) — Line5 [modbus-rtu] 供给（satellite DAQ）
  - line=ln-43b40ee5 daq=dn-226f717a dcw=✘ recipe=rc-573ca452 ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 3
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ · governed write · F5 interlock

- ✔ **line-1-io** (pass) — Line1 [modbus-tcp] integration check
  - ✔ DAQ samples stored 9  points (modbus-tcp real driver）
  - ✔ 约6写 p50=47.153ms p95=57.987ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass) — Line2 [opcua] integration check
  - ✔ DAQ samples stored 10  points (opcua real driver）
  - ✔ 约6写 p50=20.719ms p95=26.226ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass) — Line3 [mqtt] integration check
  - ✔ DAQ samples stored 6  points (mqtt real driver）
  - ✔ 约6写 p50=20.114ms p95=36.991ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass) — Line4 [http] integration check
  - ✔ DAQ samples stored 13  points (http real driver）
  - ✔ 约6写 p50=33.689ms p95=34.58ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass) — Line5 [modbus-rtu] integration check
  - ✔ DAQ samples stored 14  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass) — 闭环夹具（channel+agent）
  - channel=24fec8a8-f004-4610-9ed5-3ef3f740187f
  - agent=d2bd2913-eb1e-4872-bb42-c390232f5534
  - harness=opencode
- ✔ **tool-bridge** (pass) — opencode 的 host 工具直调面可用
  - 探测 my_industrial_nodes → 你尚未绑定任何工业对象。请让用户或 lead 为你绑定:数控/数采节点(kind=daq 观察)或配方(kind=recipe,参数写入与下发)。
- ▲ **line-1-loop** (warn) — Line1 [modbus-tcp] Agent 闭环收敛（0/3 轮）
  - iter1: SP→194.96 ✘ · 回读 203.39999389648438 ✘ · daq ✔ · judge ✘(无record)
  - iter2: SP→197.48 ✘ · 回读 203.39999389648438 ✘ · daq ✔ · judge ✘(无record)
  - iter3: SP→200 ✘ · 回读 203.39999389648438 ✘ · daq ✔ · judge ✘(无record)
  - 向窗口中心收敛 ✘ · 耗时 8.666s
- ▲ **line-2-loop** (warn) — Line2 [opcua] Agent 闭环收敛（0/3 轮）
  - iter1: SP→144.6 ✘ · 回读 154 ✘ · daq ✔ · judge ✘(无record)
  - iter2: SP→147.3 ✘ · 回读 154 ✘ · daq ✔ · judge ✘(无record)
  - iter3: SP→150 ✘ · 回读 154 ✘ · daq ✔ · judge ✘(无record)
  - 向窗口中心收敛 ✘ · 耗时 4.32s
- ▲ **line-3-loop** (warn) — Line3 [mqtt] Agent 闭环收敛（0/3 轮）
  - iter1: SP→91.4 ✘ · 回读 97.4 ✘ · daq ✔ · judge ✘(无record)
  - iter2: SP→93.2 ✘ · 回读 97.4 ✘ · daq ✔ · judge ✘(无record)
  - iter3: SP→95 ✘ · 回读 97.4 ✘ · daq ✔ · judge ✘(无record)
  - 向窗口中心收敛 ✘ · 耗时 4.312s
- ▲ **line-4-loop** (warn) — Line4 [http] Agent 闭环收敛（0/3 轮）
  - iter1: SP→0.946 ✘ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✘(无record)
  - iter2: SP→0.973 ✘ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✘(无record)
  - iter3: SP→1 ✘ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✘(无record)
  - 向窗口中心收敛 ✘ · 耗时 4.336s
- ✔ **plant-response** (pass) — 工艺模型响应（SP→plant truth 随动）
  - 真值样本 6 → 82
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":1,"configuredTimeScale":6,"elapsedS"

### P4b — Rollback & optimization records

- ▲ **line-1-optrecord** (warn) — Line1 优化记录生命周期
  - current 203.39999389648438 → record A writes 206.76 (up)，记录 B writes 200.04 (down); opposite directions to dodge the rollback cooldown
  - ✘ (keep path) no record_id; receipt: 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验,不写版本)/ re
  - ✘ (rollback path) no record_id; receipt: 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验,不写版本)/ re
  - ✘ 优化记录查询面可见本节点记录 0  (judged=0）
- ✔ **line-1-rbjudge** (pass) — Line1 撤销记录 opt-d77dbe7e 判定关闭
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass) — Line1 node-level single-step rollback (undo stack)
  - ✔ write 205.04 effective (readback 205, before 203.39999389648438)
  - ✔ journal rollback 受理（status 200，记录 opt-d77dbe7e）
  - ✔ readback after rollback 203.39999389648438 (expected back to 203.39999389648438, tolerance 0.75)
- ✔ **param-ledger** (pass) — 参数台账（三值对照 + 在册历史）
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ▲ **line-2-hitl** (warn) — Line2 HITL 审批闭环
  - ✘ 下发在人工确认模式下**挂起**，审批面板出现待审项 （未出现）（detail: ）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass) — 治理只读面
  - ✔ 参数变更账本 journal：本产线 4  anchors (source coverage  rollback/manual/recipe）
  - ✔ audit: 200 entries
  - ✔ ops-logs: 200 entries
  - ✔ 报警记录：全局 142 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass) — Line1 [modbus-tcp] recipe lifecycle
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-bc8c3774 → lastGood=rr-bc8c3774
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass) — Line2 [opcua] recipe lifecycle
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-5cf92e57 → lastGood=rr-5cf92e57
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ✔ **param-facade** (pass) — Line2 [opcua] 参数面自动生成且无寄存器泄漏
  - param=pp-8d67e877 key=temp-sp unit=rpm
  - 含 register/dataType/driverConfig? 无 ✔
- ✔ **param-limits** (pass) — Line2 基准限界 [143.7,156.3] + 产品限界 [146.22,153.78] 设定
  - 有效交集(含配方窗) 141~159 → param 143.7~156.3 → product 146.22~153.78 · node 层 50~200（四层收窄：node ∩ param ∩ product ∩ recipe）
- ✔ **param-write-governed** (pass) — Line2 参数面写入联锁（交集内写入 · 越产品层拦截 · 越基准层拦截 · 参数读回）
  - 148.866 → ✔ 写入+回读
  - 155.04 → ✔ 产品层拦截
  - 157.65 → ✔ 基准限界层拦截
  - param read → ✔ 148.866rpm
- ✘ **agent-param-tools** (fail) — Line2 Agent param_control/param_read（语义写 · 越产品层拒 · 参数读 · 未绑定拒）
  - param_control 151.323 → ✘ 参数直写已禁用(权限模型 v2):Agent 不再直接改写运行中的工艺参数。请改用绑定的配方 —— recipe_update(写入新版本)/ recipe_apply(整批下发)
  - param_control 155.04 → ✘ 参数直写已禁用(权限模型 v2):Agent 不再直接改写运行中的工艺参数。请改用绑定的配方 —— recipe_update(写入新版本)/ recipe_apply(整批下发)
  - param_read → ✘ 未知工具: param_read
  - unbound agent → ✘ 参数直写已禁用(权限模型 v2):Agent 不再直接改写运行中的工艺参数。请改用绑定的配方 —— recipe_update(写入新版本)/ recipe_apply(整批下发)

### P4m — AgentTeam optimization mission (task board → governed writes → attainment)

- ✔ **mission-board** (pass) — 任务板：优化任务下达并由 lead 派发
  - channel=d33b6cf9-e804-4080-978e-3e3717e5edb0 parent=60156fbc-c383-4b85-8ab7-952ff3c952ab leadChild=ddfa0c69-5326-4044-b9a8-3e4296c77bcd assignee=f36f85f0-1c5a-4f66-8433-2f23bbbe7091
- ✔ **mission-timescale-read** (pass) — 时段数据读取（daq_query from/to/bucket）
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip161igf(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-10-29T21:27 ~ 2026-10-29T21:32(降采样 1000ms,聚合 avg)  
- ✘ **mission-governed-write** (fail) — 受治理参数下发（0 写全开记录+判定）
  - iter1: write rejected → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_ap
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
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-10-29T13:32:04.131Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ▲ **seed-42** (warn) — seed=42 闭环优化（J/J*=0.797）
  - 预热 0.037s（熔体温度 206.1℃，达工艺窗 [195,225]）
  - iter0 起点：h=56.05μm defect=0.567% P=17.50MPa T=210.0℃ N=150 v=95.0 → J=64.16
  - iter1 下发 N=134 v=95 z=200 → h=56.03μm defect=0.167% P=18.48MPa T=210.0℃ → J=65.50 
  - iter2 下发 N=134 v=95 z=200 → h=55.80μm defect=0.167% P=18.72MPa T=208.8℃ → J=66.79 
- ▲ **seed-43** (warn) — seed=43 闭环优化（J/J*=0.777）
  - 预热 0.046s（熔体温度 204.02℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.61μm defect=0.617% P=17.47MPa T=210.0℃ N=150 v=95.0 → J=66.44
  - iter1 下发 N=135 v=95 z=200 → h=56.08μm defect=0.183% P=18.57MPa T=209.7℃ → J=65.18 
  - iter2 下发 N=134 v=95 z=200 → h=55.87μm defect=0.067% P=18.67MPa T=208.5℃ → J=66.73 
- ▲ **seed-44** (warn) — seed=44 闭环优化（J/J*=0.787）
  - 预热 0.029s（熔体温度 203.8℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.47μm defect=0.667% P=17.58MPa T=210.1℃ N=150 v=95.0 → J=67.06
  - iter1 下发 N=135 v=95 z=200 → h=55.87μm defect=0.150% P=18.52MPa T=209.7℃ → J=66.47 
  - iter2 下发 N=134 v=95 z=200 → h=55.80μm defect=0.100% P=18.65MPa T=208.5℃ → J=67.00 
- ✘ **closedloop-aggregate** (fail) — 闭环优化聚合（n=3）
  - J/J*：min 0.777 · mean 0.787 · max 0.797（J* = 89.894）
  - J start均值 65.885 → end均值 70.728
  - 平均迭代 8  · 总写 24 · 越界rejected 24 · 收敛 0/3 · 平均墙钟 108.956s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass) — 多形态数采（向量/图像帧）
  - ✔ 向量轮廓帧 2 （51.767,52.222,51.28,52.124,52.115,52.039,52.485,52.221,53.409,53.459,52.515,53.228,53.82,53.233,53.453,53.839,53.862,53.83,53.81,53.926,54.267,54.181,54.809,54.378,55.537,55.023,55.063,55.376,54.361,54.171,54.968,54.381,54.592,55
  - ✔ 图像帧 2 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass) — second plant scenario applied: film-line
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] provisioned
  - line=ln-5d47224a daq=dn-ae5bf07e dcw=dw-8303b774
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass) — scenario[film-line] line 2 [opcua] provisioned
  - line=ln-2dbaa8f0 daq=dn-a6f25f5c dcw=dw-8db78d9c
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass) — scenario[film-line] line 3 [mqtt] provisioned
  - line=ln-9cd7a697 daq=dn-136d36b7 dcw=dw-b03d0a0f
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass) — scenario[film-line] line 4 [modbus-rtu] provisioned (satellite DAQ)
  - line=ln-9cd7a697 daq=dn-8cf8482e dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass) — scenario[film-line] line 5 [http] provisioned (satellite DAQ)
  - line=ln-9cd7a697 daq=dn-580336aa dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **port-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] integration
  - ✔ DAQ samples 12 pts (modbus-tcp real driver)
  - ✔ governed write 186.24 → HTTP 200
  - readback deviation 0.04
  - ✔ F5 out-of-window 3/3 rejected · legal write accepted (0 false block)
- ✔ **port-2-opcua** (pass) — scenario[film-line] line 2 [opcua] integration
  - ✔ DAQ samples 12 pts (opcua real driver)
  - ✔ governed write 186.24 → HTTP 200
  - readback deviation 0
  - ✔ F5 out-of-window 3/3 rejected · legal write accepted (0 false block)
- ✔ **port-3-mqtt** (pass) — scenario[film-line] line 3 [mqtt] integration
  - ✔ DAQ samples 6 pts (mqtt real driver)
  - ✔ governed write 62.4 → HTTP 200
  - readback deviation 0
  - ✔ F5 out-of-window 3/3 rejected · legal write accepted (0 false block)
- ✔ **port-4-modbus-rtu** (pass) — scenario[film-line] line 4 [modbus-rtu] integration
  - ✔ DAQ samples 11 pts (modbus-rtu real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)
- ✔ **port-5-http** (pass) — scenario[film-line] line 5 [http] integration
  - ✔ DAQ samples 11 pts (http real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)

### P8b — System backstop drill (bounded autonomy)

- ✔ **cleanup** (pass) — 遗留 open 记录清场（关闭 1/1 条）
  - records closed: 1/1
- ✘ **open-record** (fail) — 开优化记录
  - 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验,不写版本)/ recipe_rollback(回退);均为带理由与 HITL 
- ✔ **restore** (pass) — 过程量解冻 + 第一场景恢复: cast-film-physics
  - rig left as found

### P9 — Platform subsystems (team / memory / registry)

- ✔ **team-dispatch** (pass) — 团队调度（lead 派发 → worker 完成）
  - 终态 COMPLETED · assignee=5b69e5df-9416-4951-8970-bd9914ad66ef（lead 认领父任务） · 子任务派发给 worker: ✔
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
| audit | journal_anchors | 4 |  | 本Line参数变更账本 |
| audit | audit_entries | 200 |  | 全局审计目 |
| audit | ops_logs | 200 |  | 全局运维日志 |
| recipe | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| gov | param_layer_checks_ok | 3 | /4 | 工艺参数映射层全链 |
| closedloop | J_over_Jstar_mean | 0.787 |  | n=3 seeds，写路径=governed |
| closedloop | J_over_Jstar_min | 0.777 |  | 最差 seed（保守下界） |
| closedloop | J_end_mean | 70.728 |  | J* = 89.894 |
| closedloop | cl_iters_mean | 8 |  | 闭环收敛迭代数 |
| closedloop | cl_writes_total | 24 |  | 受治理的闭环写总数 |
| closedloop | cl_rejected_total | 24 |  | 越界被拒（治理拦截） |
| daq | vector_frames | 2 |  | 厚度横向轮廓 |
| daq | image_frames | 2 |  | CCD 表面图像 |
| portability | scenario2_lines | 3 |  | second preset "film-line" (config-only) |
| portability | scenario2_intercept_rate | 1 |  | F5 out-of-window interception on second scenario |
| portability | scenario2_false_blocks | 0 |  | legal in-window writes blocked on second scenario |
| biax | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| biax | sp_signals | 30 |  | 可写工艺 SP |
| biax | created_missing | 9 |  | 本次补建的缺失设备数 |
| biax | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| biax | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| team | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| memory | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| agent | harness_registry | 14 |  | environment-available 14 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict FAIL, grade F). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._
# AW-IndustrialBench · Integrated Pipeline Report

> **FAIL** — score **70.4**/100, grade **F**. Hard gate tripped: at least one check/phase failed; the score is informational only.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20261012060026-fd0` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `86e4be8671e085d2` (sha256 over 11 checker sources) |
| Git commit | `8c16ab8` |
| Runtime | v24.13.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3001 · http://127.0.0.1:4010 |
| Tool harness | omp (deterministic) · LLM agent: (none) |
| Reproduce | `node bench/pipeline.mjs --profile quick --seed 42 --lines 2 --tool-harness omp --cl-seeds 3` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 2 | +0 satellite DAQ · modbus-tcp/opcua |
| DAQ samples total | 15 | 2/2 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 2.425 ms | incl. real protocol transactions |
| Closed-loop J/J* | 85.7 % | n=3 seeds · worst 85.7% · J*=89.894 |
| Tool-level loops | 0 | dcw→daq→judge ×3 convergence |
| Param-layer governance | 3/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | not fired | P8b drill requires scenario 2 |
| Scenario portability | film-line | 2nd scenario: 2 lines + 0 sat · F5 6/6 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 0 knobs · 0 writes → 28.00μm |
| LLM agent loop | off | --agent omp enables |
| Verdict | FAIL | 38/60 checks · hard gate tripped |

## Simulated production line profile

> Preset `cast-film-physics` — Cast-film extrusion digital twin (plant-model physics engine). An extrusion cast-film line: resin → screw melting → die → casting → thickness gauge. Six writable setpoints (3 zone temperatures, screw speed, line speed, die gap) act on a physics engine whose observable process quantities are melt temperature, melt pressure, film thickness, defect rate and gels count.

**Physics.** Deterministic plant model (seeded): first-order thermal lag on melt temperature, algebraic thickness h ∝ N/v from mass conservation, pressure/defect couplings — scored by J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput.
 Plant engine state at report time: phase=`warmup`, seed=`42`.

**Totals.** 5 PLC devices across 5 protocols (modbus-tcp, modbus-rtu, opcua, mqtt, http); **6 writable setpoints (SP → DCW nodes)** and **7 process quantities (PV → DAQ nodes)**; the platform side provisions 104 lines with 193 write nodes and 311 acquisition nodes.

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
| 演示·挤出主机PLC(Modbus TCP)·加热区1SP (`dw-b90e235`) | DCW write | `modbus-tcp` | 演示线1·挤出主机PLC(Modbus TCP) | ℃ | [120, 260] |
| 演示·熔体泵送单元(OPC UA)·ScrewSpeedSP (`dw-9110ba3`) | DCW write | `opcua` | 演示线2·熔体泵送单元(OPC UA) | rpm | [50, 200] |
| 演示·在线测厚仪(MQTT)·lineSpeedSP (`dw-65bd425`) | DCW write | `mqtt` | 演示线3·在线测厚仪(MQTT) | m/min | [20, 120] |
| 演示·CCD检测站(HTTP)·dieGapSP (`dw-603f8a3`) | DCW write | `http` | 演示线4·CCD检测站(HTTP) | mm | [0.5, 2] |
| 演示·注塑主机PLC(Modbus TCP)·机筒温度区1SP (`dw-2ffe745`) | DCW write | `modbus-tcp` | 演示线5·注塑主机PLC(Modbus TCP) | ℃ | [160, 300] |
| 演示·模温机与锁模单元(Modbus RTU)·模具温度SP (`dw-bfc32c6`) | DCW write | `modbus-rtu` | 演示线6·模温机与锁模单元(Modbus RTU | ℃ | [20, 95] |
| 演示·注射/保压单元(OPC UA)·InjectSpeedSP (`dw-d5795c7`) | DCW write | `opcua` | 演示线7·注射/保压单元(OPC UA) | mm/s | [30, 130] |
| 演示·冷却水单元(MQTT)·CoolWaterSP (`dw-240b9fc`) | DCW write | `mqtt` | 演示线8·冷却水单元(MQTT) | ℃ | [10, 45] |
| 演示·加热段炉(Modbus TCP)·均热区1炉温SP (`dw-f94e2c0`) | DCW write | `modbus-tcp` | 演示线9·加热段炉(Modbus TCP) | ℃ | [600, 850] |
| 演示·炉内传动与速度单元(OPC UA)·LineSpeedSP (`dw-039bc5d`) | DCW write | `opcua` | 演示线10·炉内传动与速度单元(OPC UA) | m/min | [60, 220] |
| 演示·冷却与过时效段(Modbus RTU)·过时效温度SP (`dw-196586d`) | DCW write | `modbus-rtu` | 演示线11·冷却与过时效段(Modbus RTU | ℃ | [320, 480] |
| 演示·保护气单元(MQTT)·H2RatioSP (`dw-4036193`) | DCW write | `mqtt` | 演示线12·保护气单元(MQTT) | % | [3, 15] |
| 注塑一线·MES多字段直取(tem) (`dw-08012b7`) | DCW write | `mes-rest` | 注塑一线·克重窗口寻优 | ℃ | [20, 260] |
| 注塑一线·保压压力SP (`dw-e3f0a84`) | DCW write | `opcua` | 注塑一线·克重窗口寻优 | bar | [20, 110] |
| 注塑一线·保压时间SP (`dw-a44592d`) | DCW write | `opcua` | 注塑一线·克重窗口寻优 | s | [3, 15] |
| 注塑一线·模具温度SP (`dw-8636bdc`) | DCW write | `modbus-rtu` | 注塑一线·克重窗口寻优 | ℃ | [20, 95] |
| 注塑一线·螺杆转速SP (`dw-0a19340`) | DCW write | `modbus-tcp` | 注塑一线·克重窗口寻优 | rpm | [60, 200] |
| mock压力-mv2lkcia (`dw-065793e`) | DCW write | `mock` | ACK鉴定线-mv2lkcia | u | [0, 100] |
| mock温度-mv2lkcia (`dw-3bd6ad7`) | DCW write | `mock` | ACK鉴定线-mv2lkcia | u | [0, 100] |
| mqtt断链-mv2lkcia (`dw-fb66aad`) | DCW write | `mqtt` | ACK鉴定线-mv2lkcia | u | [0, 100] |
| mqtt在线-mv2lkcia (`dw-8f678d0`) | DCW write | `mqtt` | ACK鉴定线-mv2lkcia | u | [0, 100] |
| mock压力-mv2lm9z1 (`dw-5570145`) | DCW write | `mock` | ACK鉴定线-mv2lm9z1 | u | [0, 100] |
| mock温度-mv2lm9z1 (`dw-7badab4`) | DCW write | `mock` | ACK鉴定线-mv2lm9z1 | u | [0, 100] |
| mqtt断链-mv2lm9z1 (`dw-3bf4ea8`) | DCW write | `mqtt` | ACK鉴定线-mv2lm9z1 | u | [0, 100] |
| mqtt在线-mv2lm9z1 (`dw-8ae2494`) | DCW write | `mqtt` | ACK鉴定线-mv2lm9z1 | u | [0, 100] |
| 风机频率SP (`dw-0adcee2`) | DCW write | `modbus-tcp` | A2O污水生化处理线 | Hz | [20, 50] |
| 碱投加SP (`dw-ae9ecf5`) | DCW write | `opcua` | A2O污水生化处理线 | L/h | [0, 120] |
| 除磷投加SP (`dw-1187f0c`) | DCW write | `opcua` | A2O污水生化处理线 | L/h | [0, 90] |
| 内回流比SP (`dw-23739ce`) | DCW write | `modbus-rtu` | A2O污水生化处理线 | % | [20, 180] |
| 污泥回流比SP (`dw-b59607e`) | DCW write | `modbus-rtu` | A2O污水生化处理线 | % | [30, 120] |
| 排泥量SP (`dw-5fbb094`) | DCW write | `modbus-rtu` | A2O污水生化处理线 | m3/d | [50, 400] |
| 进水流量SP (`dw-c1e1275`) | DCW write | `mqtt` | A2O污水生化处理线 | m3/h | [400, 1600] |
| 机筒温度区3SP (`dw-f34124e`) | DCW write | `modbus-tcp` | 注塑成型二线 | ℃ | [160, 300] |
| 机筒温度区4SP (`dw-f251b7e`) | DCW write | `modbus-tcp` | 注塑成型二线 | ℃ | [160, 300] |
| 锁模力SP (`dw-c23b094`) | DCW write | `modbus-rtu` | 注塑成型二线 | kN | [800, 2500] |
| L1-DCW-modbus-tcp ip16jtij (`dw-b07485f`) | DCW write | `modbus-tcp` | Integrated线1 ip16jtij | ℃ | [120, 260] |
| L2-DCW-opcua ip16jtij (`dw-8c98758`) | DCW write | `opcua` | Integrated线2 ip16jtij | rpm | [50, 200] |
| 加热区1SP ip16jtijcl (`dw-6ceb50c`) | DCW write | `modbus-tcp` | CastFilm线 ip16jtijcl | ℃ | [120, 260] |
| 加热区2SP ip16jtijcl (`dw-de1dae7`) | DCW write | `modbus-tcp` | CastFilm线 ip16jtijcl | ℃ | [120, 260] |
| 加热区3SP ip16jtijcl (`dw-4c60e4c`) | DCW write | `modbus-tcp` | CastFilm线 ip16jtijcl | ℃ | [120, 260] |
| 隔离线B·温度PV (`dn-043ee3f`) | DAQ acquire | `mock` | 隔离线B-49307 | ℃ | [0, 300] |
| 隔离线B·温度PV (`dn-d1d6f78`) | DAQ acquire | `mock` | 隔离线B-66624 | ℃ | [0, 300] |
| 全功能PV-njy3i (`dn-636c462`) | DAQ acquire | `mock` | ln-883e070c | ℃ | [0, 300] |
| 全功能PV-nlvl3 (`dn-faade28`) | DAQ acquire | `mock` | ln-930e1abd | ℃ | [0, 300] |
| 全功能PV-x5yij (`dn-2d1a13e`) | DAQ acquire | `mock` | ln-c13c8f2b | ℃ | [0, 300] |
| L1-DAQ-modbus-tcp ip16d8zg (`dn-9bfe330`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16d8zg | ℃ | [0, 400] |
| L2-DAQ-opcua ip16d8zg (`dn-124795f`) | DAQ acquire | `opcua` | Integrated线2 ip16d8zg | MPa | [0, 45] |
| L3-DAQ-mqtt ip16d8zg (`dn-4df31c2`) | DAQ acquire | `mqtt` | Integrated线3 ip16d8zg | μm | [0, 400] |
| L4-DAQ-http ip16d8zg (`dn-0770e78`) | DAQ acquire | `http` | Integrated线4 ip16d8zg | μm | [0, 400] |
| L5-DAQ-modbus-rtu ip16d8zg(sat) (`dn-8829650`) | DAQ acquire | `modbus-rtu` | Integrated线4 ip16d8zg | 个/m² | [0, 500] |
| 熔体温度 ip16d8zgcl (`dn-c095939`) | DAQ acquire | `modbus-tcp` | CastFilm线 ip16d8zgcl | ℃ | [0, 400] |
| 晶点计数 ip16d8zgcl (`dn-3c6f834`) | DAQ acquire | `modbus-rtu` | CastFilm线 ip16d8zgcl | 个/m² | [0, 500] |
| MeltPressure ip16d8zgcl (`dn-1da97aa`) | DAQ acquire | `opcua` | CastFilm线 ip16d8zgcl | MPa | [0, 45] |
| thick ip16d8zgcl (`dn-14ce39a`) | DAQ acquire | `mqtt` | CastFilm线 ip16d8zgcl | μm | [0, 400] |
| defect ip16d8zgcl (`dn-9a0ae38`) | DAQ acquire | `http` | CastFilm线 ip16d8zgcl | % | [0, 100] |
| L1-DAQ-modbus-tcp ip16n13l (`dn-eff7280`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16n13l | ℃ | [0, 400] |
| L2-DAQ-opcua ip16n13l (`dn-57cf141`) | DAQ acquire | `opcua` | Integrated线2 ip16n13l | MPa | [0, 45] |
| L3-DAQ-mqtt ip16n13l (`dn-c31ffd0`) | DAQ acquire | `mqtt` | Integrated线3 ip16n13l | μm | [0, 400] |
| L4-DAQ-http ip16n13l (`dn-35ff04a`) | DAQ acquire | `http` | Integrated线4 ip16n13l | μm | [0, 400] |
| L5-DAQ-modbus-rtu ip16n13l(sat) (`dn-697b5a3`) | DAQ acquire | `modbus-rtu` | Integrated线4 ip16n13l | 个/m² | [0, 500] |
| 熔体温度 ip16n13lcl (`dn-c5fd455`) | DAQ acquire | `modbus-tcp` | CastFilm线 ip16n13lcl | ℃ | [0, 400] |
| 晶点计数 ip16n13lcl (`dn-f161d32`) | DAQ acquire | `modbus-rtu` | CastFilm线 ip16n13lcl | 个/m² | [0, 500] |
| MeltPressure ip16n13lcl (`dn-dd7d5f7`) | DAQ acquire | `opcua` | CastFilm线 ip16n13lcl | MPa | [0, 45] |
| thick ip16n13lcl (`dn-51b0203`) | DAQ acquire | `mqtt` | CastFilm线 ip16n13lcl | μm | [0, 400] |

_(showing first 40 DCW / 24 DAQ nodes; full inventory in `line-profile.json`)_

## Phase scorecard (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---:|---:|---:|---:|---:|---:|
| P0 | Bootstrap · simulator & platform | 2 | 0 | 0 | 0 | 100.0 | 1 |
| P1 | Plant model + offline optimum W* | 3 | 0 | 0 | 0 | 100.0 | 1 |
| P2 | Multi-protocol line provisioning | 3 | 0 | 0 | 0 | 100.0 | 2 |
| P3 | DAQ · governed write · F5 interlock | 0 | 0 | 2 | 0 | 0.0 | 3 |
| P4 | Agent-tool closed loop (3-cycle convergence) | 3 | 2 | 0 | 0 | 80.0 | 3 |
| P4b | Rollback & optimization records | 1 | 2 | 0 | 0 | 66.7 | 2 |
| P4c | HITL approval gate | 0 | 1 | 0 | 0 | 50.0 | 2 |
| P4d | Audit / ledger read surfaces | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P4e | Recipe lifecycle | 2 | 0 | 0 | 0 | 100.0 | 2 |
| P4f | Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits) | 3 | 0 | 1 | 0 | 75.0 | 3 |
| P4m | AgentTeam optimization mission (task board → governed writes → attainment) | 3 | 2 | 1 | 0 | 66.7 | 3 |
| P6 | Closed-loop optimization benchmark (multi-seed) | 2 | 4 | 0 | 0 | 66.7 | 3 |
| P7 | Multimodal acquisition (vector/image) | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P8 | Cross-scenario portability | 3 | 0 | 2 | 0 | 60.0 | 3 |
| P8b | System backstop drill (bounded autonomy) | 2 | 0 | 1 | 0 | 66.7 | 3 |
| P9 | Platform subsystems (team / memory / registry) | 3 | 0 | 0 | 0 | 100.0 | 1 |
| P10 | Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop) | 6 | 3 | 1 | 0 | 75.0 | 3 |
| **Overall** | | | | | | **70.4** | 37 |

## Closed-loop optimization · per-seed

| Seed | J0 | Jend | J* | J/J* % | Iters | Governed writes | Rejected | Converged |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 42 | 70.18 | 77.06 | 89.89 | 85.7 | 8 | 8 | 8 | no |
| 43 | 77.06 | 77.06 | 89.89 | 85.7 | 8 | 8 | 8 | no |
| 44 | 77.06 | 77.06 | 89.89 | 85.7 | 8 | 8 | 8 | no |

## AgentTeam closed-loop tuning walkthrough

How an optimization team is assembled and drives the line, end to end: (1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; (2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); (3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; (4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; (5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.

### Biax (BOPET) multi-node mission — iteration trace

| Iter | Knob | Node | From → To | Thickness μm | Note |
|---|---|---|---|---:|---|
| 0 | — | `—` | — | 28.00 |  |

Governed writes: **0** on 0 distinct knob(s) · optimization records: 0 · target window 25 ± 0.7 μm · final thickness reading **28.00 μm** · target attained: **no**.

### Deterministic closed-loop benchmark — seed 42 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.18 | 0.167 | 18.60 | 205.8 | 150 | 95.0 | 200.0 | 70.18 | 0 |
| 1 | 54.17 | 0.500 | 18.28 | 202.6 | 150 | 95.0 | 200.0 | 74.73 | 24.067 |
| 2 | 53.78 | 0.750 | 18.23 | 201.3 | 150 | 95.0 | 200.0 | 76.06 | 36.096 |
| 3 | 54.30 | 0.817 | 18.20 | 200.6 | 150 | 95.0 | 200.0 | 73.01 | 48.12 |
| 4 | 53.60 | 0.750 | 18.12 | 200.4 | 150 | 95.0 | 200.0 | 77.06 | 60.148 |
| 5 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 72.174 |
| 6 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 84.206 |
| 7 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 96.228 |
| 8 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 108.261 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **85.7 %**; governed writes 8 (rejected 8), optimization records 0.

### Deterministic closed-loop benchmark — seed 43 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 0 |
| 1 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 24.064 |
| 2 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 36.088 |
| 3 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 48.123 |
| 4 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 60.152 |
| 5 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 72.181 |
| 6 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 84.208 |
| 7 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 96.229 |
| 8 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 108.255 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **85.7 %**; governed writes 8 (rejected 8), optimization records 0.

### Deterministic closed-loop benchmark — seed 44 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 0 |
| 1 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 24.05 |
| 2 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 36.075 |
| 3 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 48.112 |
| 4 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 60.144 |
| 5 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 72.174 |
| 6 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 84.199 |
| 7 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 96.229 |
| 8 | 53.60 | 0.750 | 18.12 | 200.1 | 150 | 95.0 | 200.0 | 77.06 | 108.253 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **85.7 %**; governed writes 8 (rejected 8), optimization records 0.

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `agentteam-mission.log` | 0.8 KB | AgentTeam optimization mission — full task-board trajectory |
| `agentteam-biax.log` | 2.3 KB | AgentTeam biax multi-node mission — full trajectory |
| `line-profile.json` | 140.7 KB | Simulated line profile — devices, protocols, endpoints, SP/PV signal inventory, AW node mapping |
| `metrics.csv` | 1.9 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 216.7 KB | Full machine-readable results (checks, phases, evidence, KPIs, line profile, agent-team traces) |
| `summary.json` | 12.4 KB | Verdict + KPI + per-line summary (compare/aggregate input) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✔ **platform-reachable** (pass) — platform reachable & authenticated
  - 平台 http://127.0.0.1:3001：already-up
  - 鉴权 OK (login)
  - simulator http://127.0.0.1:4010：already up (reused)
- ✔ **daq-sampling-ready** (pass) — 数采采样恢复(produced 增长)
  - 等待 5s(produced=15250)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass) — 预设 cast-film-physics 已应用
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **field-defaults** (pass) — 现场=蓝图默认值（6 信号核对）
  - 全部信号初始值=蓝图默认值
- ✔ **offline-optimum** (pass) — offline optimum W* (ground truth) available
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-10-12T06:00:34.657Z"}

### P10 — Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)

- ✔ **biax-ensure** (pass) — 节点探测补建(9 建缺失 / 0 修复 / 0 原样)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass) — 五协议多节点建线(DCW 30 + DAQ 19,驱动实测 9/9)
  - line=ln-57e51ac9 recipe=rc-01ef21b3 started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass) — 测厚仪真实链路采样(1 点)
  - daq=dn-3ca81222 · samples=1
- ▲ **biax-agent-cards** (warn) — Agent 语义卡含双拉工艺描述(semantics 贯通)
  - 语义卡长度 6021 · 关键词命中 收卷张力
  - sample: #### ◇ L1-DAQ-modbus-tcp ip16feqt [id=dn-fb5fb343] - 物理量: 熔体/箱体温度,单位 ℃,正常量程 [0, 400] ℃ - 采集语义: 模拟器设备「挤出主机PLC(Modbus TCP)」的 熔体温度（真实 modbus-tcp 链路） - 预警带: [32, 36
- ✔ **biax-mission-board** (pass) — 任务板:双拉优化任务下达并由 lead 派发
  - parent task + lead child: ✔
- ✘ **biax-mission-multinode** (fail) — 多节点受治理写(0 个执行节点 / 0 写)
  - 1. task board: channel=b2bf8c28-ed4a-4e00-8083-d26ff6d6abda parent=77987bd7-f90e-40ec-a915-4a4865c7b114 leadChild=650a109c-7fa4-413c-a866-405e9b568fb7
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[3.5,1.6]
  - 3. initial thickness=28.00 μm(目标 25±0.7)
  - iter1: cast-spd-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/
- ▲ **biax-mission-attained** (warn) — 厚度目标达成(|PV−25.0|≤0.7μm,final=28.00)
  - writes=0/6 · distinctKnobs=0 · final=28.00μm
  - iter6: rail-out-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/
  - 4. journal(铸速节点)归因 Agent: ✘ · 无权查询节点 dw-034f5755 的账本(仅可查自己绑定的节点)。
  - 5. outcome: writes=0 distinctKnobs=0 final=28.00μm attained=false
- ▲ **biax-mission-journal** (warn) — 参数账本 Agent 归因(铸速节点)
- ✔ **biax-mission-closed** (pass) — 任务收口(父任务 COMPLETED)
  - terminal=COMPLETED
- ✔ **biax-restore** (pass) — 双拉线停止 + 第一场景恢复: cast-film-physics
  - rig left as found

### P2 — Multi-protocol line provisioning

- ✔ **gateway** (pass) — gateway controller start (idempotent)
  - POST /api/workshop/daq/controller {action:start}
  - 采样仍受「活动Line批」门控，故每台有 SP 的devices自成一可开跑Line
- ✔ **line-1-modbus-tcp** (pass) — Line1 [modbus-tcp] 供给
  - line=ln-18fddf0f daq=dn-fb5fb343 dcw=dw-3b0a5264 recipe=rc-eeec0139
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 210.6999969482422
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass) — Line2 [opcua] 供给
  - line=ln-3e953807 daq=dn-6241e10e dcw=dw-e284f546 recipe=rc-f5032ca6
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 18.147
  - SP 中心 150 窗口 [141, 159]

### P3 — DAQ · governed write · F5 interlock

- ✘ **line-1-io** (fail) — Line1 [modbus-tcp] integration check
  - ✔ DAQ samples stored 7  points (modbus-tcp real driver）
  - ✔ 约6写 p50=2.614ms p95=6.822ms，readback deviation 3.36
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal writeblocked
- ✘ **line-2-io** (fail) — Line2 [opcua] integration check
  - ✔ DAQ samples stored 8  points (opcua real driver）
  - ✔ 约6写 p50=2.236ms p95=2.699ms，readback deviation 3.6
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal writeblocked

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass) — 闭环夹具（channel+agent）
  - channel=3063b4ad-7780-491f-b984-cee5d982a3c9
  - agent=9d5fe9f6-6a5c-4d43-9c8d-2df435a4fd7c
  - harness=omp
- ✔ **tool-bridge** (pass) — omp 的 host 工具直调面可用
  - 探测 my_industrial_nodes → 你尚未绑定任何工业对象。请让用户或 lead 为你绑定:数控/数采节点(kind=daq 观察)或配方(kind=recipe,参数写入与下发)。
- ▲ **line-1-loop** (warn) — Line1 [modbus-tcp] Agent 闭环收敛（0/3 轮）
  - iter1: SP→194.96 ✘ · 回读 200 ✘ · daq ✔ · judge ✘(无record)
  - iter2: SP→197.48 ✘ · 回读 200 ✘ · daq ✔ · judge ✘(无record)
  - iter3: SP→200 ✘ · 回读 200 ✔ · daq ✔ · judge ✘(无record)
  - 向窗口中心收敛 ✘ · 耗时 4.161s
- ▲ **line-2-loop** (warn) — Line2 [opcua] Agent 闭环收敛（0/3 轮）
  - iter1: SP→144.6 ✘ · 回读 150 ✘ · daq ✔ · judge ✘(无record)
  - iter2: SP→147.3 ✘ · 回读 150 ✘ · daq ✔ · judge ✘(无record)
  - iter3: SP→150 ✘ · 回读 150 ✔ · daq ✔ · judge ✘(无record)
  - 向窗口中心收敛 ✘ · 耗时 4.126s
- ✔ **plant-response** (pass) — 工艺模型响应（SP→plant truth 随动）
  - 真值样本 6 → 43
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":129,"defect":0.458,"eng

### P4b — Rollback & optimization records

- ▲ **line-1-optrecord** (warn) — Line1 优化记录生命周期
  - current 200 → record A writes 203.36 (up)，记录 B writes 196.64 (down); opposite directions to dodge the rollback cooldown
  - ✘ (keep path) no record_id; receipt: 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验,不写版本)/ re
  - ✘ (rollback path) no record_id; receipt: 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验,不写版本)/ re
  - ✘ 优化记录查询面可见本节点记录 0  (judged=0）
- ▲ **line-1-rollback** (warn) — Line1 node-level single-step rollback (undo stack)
  - ✘ write 205.04 effective (readback 200, before 200)
  - ✘ journal rollback 受理（status 409，记录 —）
  - ✔ readback after rollback 200 (expected back to 200, tolerance 0.75)
- ✔ **param-ledger** (pass) — 参数台账（三值对照 + 在册历史）
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ▲ **line-2-hitl** (warn) — Line2 HITL 审批闭环
  - ✘ 下发在人工确认模式下**挂起**，审批面板出现待审项 （未出现）（detail: ）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass) — 治理只读面
  - ✔ 参数变更账本 journal：本产线 1  anchors (source coverage  recipe）
  - ✔ audit: 200 entries
  - ✔ ops-logs: 200 entries
  - ✔ 报警记录：全局 77 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass) — Line1 [modbus-tcp] recipe lifecycle
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-5d887691 → lastGood=rr-5d887691
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass) — Line2 [opcua] recipe lifecycle
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-164fadc7 → lastGood=rr-164fadc7
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ✔ **param-facade** (pass) — Line2 [opcua] 参数面自动生成且无寄存器泄漏
  - param=pp-76b3ed43 key=temp-sp unit=rpm
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
  - param_read → ✘ 你尚未绑定任何数控节点,无权读取控制通道数据。请在数字孪生界面绑定数控节点。
  - unbound agent → ✘ 参数直写已禁用(权限模型 v2):Agent 不再直接改写运行中的工艺参数。请改用绑定的配方 —— recipe_update(写入新版本)/ recipe_apply(整批下发)

### P4m — AgentTeam optimization mission (task board → governed writes → attainment)

- ✔ **mission-board** (pass) — 任务板：优化任务下达并由 lead 派发
  - channel=725fb3e2-de66-4eac-8dd6-1c1a14f44b0b parent=677ac841-6cb7-4c43-8afa-1ff1e2b0cf03 leadChild=4bf019f1-c5aa-4a6f-bc17-955f8a3bd706 assignee=c09db60a-2c8b-4ae2-8ce3-3e841b582d00
- ✔ **mission-timescale-read** (pass) — 时段数据读取（daq_query from/to/bucket）
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip16feqt(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-10-12T13:55 ~ 2026-10-12T14:00(降采样 1000ms)   当前活动批次
- ✘ **mission-governed-write** (fail) — 受治理参数下发（0 写全开记录+判定）
  - iter1: write rejected → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_ap
- ▲ **mission-journal** (warn) — 参数账本归因（Agent source 可追溯）
  - journal sample: 无权查询节点 dw-3b0a5264 的账本(仅可查自己绑定的节点)。
- ▲ **mission-attained** (warn) — 优化目标达成（|PV−204.704|≤0.75）
  - writes=0/3 · finalPV=200 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass) — 任务收口（lead 派发→worker 剧本完成→父任务聚合）
  - terminalState=COMPLETED · writes=0 · reached=false

### P6 — Closed-loop optimization benchmark (multi-seed)

- ✔ **twin-nodes** (pass) — cast-film twin node provisioning（执行器 + 传感器）
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass) — 离线最优 W*（ground truth）
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-10-12T06:00:34.657Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ▲ **seed-42** (warn) — seed=42 闭环优化（J/J*=0.857）
  - 预热 3.011s（熔体温度 209.65℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.18μm defect=0.167% P=18.60MPa T=205.8℃ N=150 v=95.0 → J=70.18
  - iter1 下发 N=136 v=95 z=200 → h=54.17μm defect=0.500% P=18.28MPa T=202.6℃ → J=74.73 
  - iter2 下发 N=138 v=95 z=200 → h=53.78μm defect=0.750% P=18.23MPa T=201.3℃ → J=76.06 
- ▲ **seed-43** (warn) — seed=43 闭环优化（J/J*=0.857）
  - 预热 0.004s（熔体温度 201.22℃，达工艺窗 [195,225]）
  - iter0 起点：h=53.60μm defect=0.750% P=18.12MPa T=200.1℃ N=150 v=95.0 → J=77.06
  - iter1 下发 N=140 v=95 z=200 → h=53.60μm defect=0.750% P=18.12MPa T=200.1℃ → J=77.06 
  - iter2 下发 N=140 v=95 z=200 → h=53.60μm defect=0.750% P=18.12MPa T=200.1℃ → J=77.06 
- ▲ **seed-44** (warn) — seed=44 闭环优化（J/J*=0.857）
  - 预热 0.004s（熔体温度 201.22℃，达工艺窗 [195,225]）
  - iter0 起点：h=53.60μm defect=0.750% P=18.12MPa T=200.1℃ N=150 v=95.0 → J=77.06
  - iter1 下发 N=140 v=95 z=200 → h=53.60μm defect=0.750% P=18.12MPa T=200.1℃ → J=77.06 
  - iter2 下发 N=140 v=95 z=200 → h=53.60μm defect=0.750% P=18.12MPa T=200.1℃ → J=77.06 
- ▲ **closedloop-aggregate** (warn) — 闭环优化聚合（n=3）
  - J/J*：min 0.857 · mean 0.857 · max 0.857（J* = 89.894）
  - J start均值 74.77 → end均值 77.065
  - 平均迭代 8  · 总写 24 · 越界rejected 24 · 收敛 0/3 · 平均墙钟 108.256s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass) — 多形态数采（向量/图像帧）
  - ✔ 向量轮廓帧 2 （50.495,51.227,50.68,50.816,51.128,51.426,51.16,51.484,51.868,52.2,52.323,52.039,53.078,52.047,52.438,53.289,52.555,52.938,53.111,53.22,52.473,53.675,52.572,53.721,53.512,53.782,53.15,53.49,53.803,53.548,54.075,54.429,53.371,53.48
  - ✔ 图像帧 2 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass) — second plant scenario applied: film-line
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] provisioned
  - line=ln-8db1a94d daq=dn-3c1a4774 dcw=dw-0535d4c2
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass) — scenario[film-line] line 2 [opcua] provisioned
  - line=ln-09607cb0 daq=dn-d0b362e7 dcw=dw-41484692
  - SP window [164.4, 195.6]
- ✘ **port-1-modbus-tcp** (fail) — scenario[film-line] line 1 [modbus-tcp] integration
  - ✔ DAQ samples 8 pts (modbus-tcp real driver)
  - ✘ governed write 186.24 → HTTP 409
  - readback deviation 6.24
  - ✔ F5 out-of-window 3/3 rejected · legal write BLOCKED
- ✘ **port-2-opcua** (fail) — scenario[film-line] line 2 [opcua] integration
  - ✔ DAQ samples 10 pts (opcua real driver)
  - ✘ governed write 186.24 → HTTP 409
  - readback deviation 6.24
  - ✔ F5 out-of-window 3/3 rejected · legal write BLOCKED

### P8b — System backstop drill (bounded autonomy)

- ✔ **cleanup** (pass) — 遗留 open 记录清场（关闭 0/0 条）
  - records closed: 0/0
- ✘ **open-record** (fail) — 开优化记录
  - 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验,不写版本)/ recipe_rollback(回退);均为带理由与 HITL 
- ✔ **restore** (pass) — 过程量解冻 + 第一场景恢复: cast-film-physics
  - rig left as found

### P9 — Platform subsystems (team / memory / registry)

- ✔ **team-dispatch** (pass) — 团队调度（lead 派发 → worker 完成）
  - 终态 COMPLETED · assignee=2e542fe5-488b-4106-b9fe-0d8370b3ef72（lead 认领父任务） · 子任务派发给 worker: ✔
- ✔ **team-memory** (pass) — 团队记忆写入 + dedupKey 幂等
  - POST×2 status 200/200 → 列表中匹配 1 条（期望 1）
- ✔ **harness-registry** (pass) — 引擎注册表枚举 + 可用性探测
  - 注册 14 引擎（期望 ≥14） · 环境可用 4 · 覆盖 mock/RPC/SDK/CLI 族

## Metric registry

| Group | Metric | Value | Unit | Note |
|---|---|---:|---|---|
| plant | W_star_objective | 89.894 |  | offline grid-search optimum (benchmark ground truth) |
| provision | lines_created | 2 |  | 可开跑Line（另有 0 satellite DAQ） |
| provision | daq_nodes | 2 |  | real-protocol DAQ nodes |
| gov | intercept_modbus-tcp | 1 |  | governance interception rate |
| gov | intercept_opcua | 1 |  | governance interception rate |
| provision | lines_sampling | 2 |  | real driver produced samples |
| gov | intercept_rate_all | 1 |  | 全协议合并 |
| loop | tool_loops_ok | 0 |  lines | 工具级闭环达成 |
| loop | mission_writes | 0 |  | AgentTeam 优化任务受治理写次数 |
| loop | mission_attained | 0 |  | AgentTeam 优化任务达标 |
| gov | record_keep_rollback_ok | 0 |  | 优化记录判定/执行分离 |
| audit | journal_anchors | 1 |  | 本Line参数变更账本 |
| audit | audit_entries | 200 |  | 全局审计目 |
| audit | ops_logs | 200 |  | 全局运维日志 |
| recipe | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| gov | param_layer_checks_ok | 3 | /4 | 工艺参数映射层全链 |
| closedloop | J_over_Jstar_mean | 0.857 |  | n=3 seeds，写路径=governed |
| closedloop | J_over_Jstar_min | 0.857 |  | 最差 seed（保守下界） |
| closedloop | J_end_mean | 77.065 |  | J* = 89.894 |
| closedloop | cl_iters_mean | 8 |  | 闭环收敛迭代数 |
| closedloop | cl_writes_total | 24 |  | 受治理的闭环写总数 |
| closedloop | cl_rejected_total | 24 |  | 越界被拒（治理拦截） |
| daq | vector_frames | 2 |  | 厚度横向轮廓 |
| daq | image_frames | 2 |  | CCD 表面图像 |
| portability | scenario2_lines | 2 |  | second preset "film-line" (config-only) |
| portability | scenario2_intercept_rate | 1 |  | F5 out-of-window interception on second scenario |
| portability | scenario2_false_blocks | 2 |  | legal in-window writes blocked on second scenario |
| biax | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| biax | sp_signals | 30 |  | 可写工艺 SP |
| biax | created_missing | 9 |  | 本次补建的缺失设备数 |
| biax | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| biax | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| biax | mission_writes | 0 |  | AgentTeam 双拉任务受治理写次数 |
| biax | mission_distinct_knobs | 0 |  | 参与闭环的执行节点数 |
| biax | mission_attained | 0 |  | 厚度达标 25.0±0.7μm |
| biax | mission_final_thickness | 28 | μm | 终态厚度 |
| team | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| memory | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| agent | harness_registry | 14 |  | environment-available 4 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict FAIL, grade F). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._
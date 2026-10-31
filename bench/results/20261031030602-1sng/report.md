# AW-IndustrialBench · Integrated Pipeline Report

> **PASS** — score **95.6**/100, grade **A**. Hard gate green: no failed checks or phases; skips are honest environmental exclusions.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20261031030602-1sng` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `f1b50e757e309bc6` (sha256 over 13 checker sources) |
| Git commit | `60fa983e` |
| Runtime | v24.19.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3005 · http://127.0.0.1:4011 |
| Tool harness | opencode (deterministic) · LLM agent: (none) |
| Reproduce | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 52 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 29.691 ms | incl. real protocol transactions |
| Closed-loop J/J* | 97.5 % | n=3 seeds · worst 95.7% · J*=89.894 |
| Tool-level loops | 3 | dcw→daq→judge ×3 convergence |
| Param-layer governance | 4/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | fired+restored | window breach → auto-rollback in 120.213s (env) |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 3 knobs · 3 writes → 24.80μm ✔ |
| LLM agent loop | off | --agent omp enables |
| Verdict | PASS | 73/77 checks · hard gate green |

## Simulated production line profile

> Preset `cast-film-physics` — Cast-film extrusion digital twin (plant-model physics engine). An extrusion cast-film line: resin → screw melting → die → casting → thickness gauge. Six writable setpoints (3 zone temperatures, screw speed, line speed, die gap) act on a physics engine whose observable process quantities are melt temperature, melt pressure, film thickness, defect rate and gels count.

**Physics.** Deterministic plant model (seeded): first-order thermal lag on melt temperature, algebraic thickness h ∝ N/v from mass conservation, pressure/defect couplings — scored by J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput.
 Plant engine state at report time: phase=`warmup`, seed=`42`.

**Totals.** 5 PLC devices across 5 protocols (modbus-tcp, modbus-rtu, opcua, mqtt, http); **6 writable setpoints (SP → DCW nodes)** and **7 process quantities (PV → DAQ nodes)**; the platform side provisions 36 lines with 156 write nodes and 132 acquisition nodes.

### Devices & fieldbus endpoints

| # | Device | Protocol | Endpoint | Signals (SP+PV) |
|---:|---|---|---|---:|
| 1 | 挤出主机PLC(Modbus TCP) | `modbus-tcp` | `127.0.0.1:17040 unit=1` | 4 |
| 2 | 晶点计数从站(Modbus RTU) | `modbus-rtu` | `127.0.0.1:16041 unit=1` | 1 |
| 3 | 熔体泵送单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:6840` | 2 |
| 4 | 在线测厚仪(MQTT) | `mqtt` | `mqtt://127.0.0.1:19830` | 2 |
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
| L1-DCW-modbus-tcp ip16l6x3 (`dw-89a79c9`) | DCW write | `modbus-tcp` | Integrated线1 ip16l6x3 | ℃ | [120, 260] |
| L2-DCW-opcua ip16l6x3 (`dw-65f8dbd`) | DCW write | `opcua` | Integrated线2 ip16l6x3 | rpm | [50, 200] |
| L3-DCW-mqtt ip16l6x3 (`dw-b9f7b38`) | DCW write | `mqtt` | Integrated线3 ip16l6x3 | m/min | [20, 120] |
| L4-DCW-http ip16l6x3 (`dw-8d21a0f`) | DCW write | `http` | Integrated线4 ip16l6x3 | mm | [0.5, 2] |
| 加热区1SP ip16l6x3cl (`dw-c3ae6c9`) | DCW write | `modbus-tcp` | CastFilm线 ip16l6x3cl | ℃ | [120, 260] |
| 加热区2SP ip16l6x3cl (`dw-09ddb5f`) | DCW write | `modbus-tcp` | CastFilm线 ip16l6x3cl | ℃ | [120, 260] |
| 加热区3SP ip16l6x3cl (`dw-4b0d1ad`) | DCW write | `modbus-tcp` | CastFilm线 ip16l6x3cl | ℃ | [120, 260] |
| ScrewSpeedSP ip16l6x3cl (`dw-eadc3f6`) | DCW write | `opcua` | CastFilm线 ip16l6x3cl | rpm | [50, 200] |
| lineSpeedSP ip16l6x3cl (`dw-0072cba`) | DCW write | `mqtt` | CastFilm线 ip16l6x3cl | m/min | [20, 120] |
| dieGapSP ip16l6x3cl (`dw-1b76d55`) | DCW write | `http` | CastFilm线 ip16l6x3cl | mm | [0.5, 2] |
| L1-DCW-modbus-tcp ip16l6x3p8 (`dw-6fc2c66`) | DCW write | `modbus-tcp` | Integrated线1 ip16l6x3p8 | ℃ | [0, 260] |
| L2-DCW-opcua ip16l6x3p8 (`dw-1d8fff3`) | DCW write | `opcua` | Integrated线2 ip16l6x3p8 | ℃ | [0, 260] |
| L3-DCW-mqtt ip16l6x3p8 (`dw-7c8162d`) | DCW write | `mqtt` | Integrated线3 ip16l6x3p8 | ℃ | [0, 100] |
| 干燥温度SP·ip16l6x3 (`dw-5f2078a`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [120, 200] |
| 露点SP·ip16l6x3 (`dw-f7410b9`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [-80, -20] |
| 喂料速率SP·ip16l6x3 (`dw-cb18d08`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16l6x3 | kg/h | [100, 1200] |
| 机筒温度区1SP·ip16l6x3 (`dw-ea00443`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [220, 300] |
| 机筒温度区2SP·ip16l6x3 (`dw-49a3b72`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [220, 300] |
| 机筒温度区3SP·ip16l6x3 (`dw-265951c`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [220, 300] |
| 机筒温度区4SP·ip16l6x3 (`dw-c46cee4`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [220, 300] |
| 机筒温度区5SP·ip16l6x3 (`dw-4a35f7a`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [220, 300] |
| 螺杆转速SP·ip16l6x3 (`dw-0996f11`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | rpm | [20, 100] |
| 计量泵转速SP·ip16l6x3 (`dw-ce70c94`) | DCW write | `modbus-rtu` | 双拉薄膜产线 biax-ip16l6x3 | rpm | [15, 60] |
| 模唇温度SP·ip16l6x3 (`dw-c77e03e`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [250, 300] |
| 急冷辊温度SP·ip16l6x3 (`dw-fc99198`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [10, 60] |
| 铸片辊速度SP·ip16l6x3 (`dw-137a013`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | m/min | [10, 60] |
| 静电吸附电压SP·ip16l6x3 (`dw-fb51816`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | kV | [4, 12] |
| 预热辊1温度SP·ip16l6x3 (`dw-0fe7d5f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [70, 140] |
| 预热辊2温度SP·ip16l6x3 (`dw-a8bc62b`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [70, 140] |
| 预热辊3温度SP·ip16l6x3 (`dw-7e13527`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [70, 140] |
| 慢辊线速度SP·ip16l6x3 (`dw-4ddbc96`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | m/min | [10, 80] |
| 快辊线速度SP·ip16l6x3 (`dw-a378e80`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | m/min | [30, 260] |
| 纵拉退火辊SP·ip16l6x3 (`dw-f026a94`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [90, 170] |
| TDO预热段SP·ip16l6x3 (`dw-722f0fb`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [80, 140] |
| TDO拉伸段SP·ip16l6x3 (`dw-645e0f3`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [90, 150] |
| TDO定型段SP·ip16l6x3 (`dw-3dd9242`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [180, 250] |
| 链夹速度SP·ip16l6x3 (`dw-38830dd`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16l6x3 | m/min | [40, 260] |
| 出口轨宽SP·ip16l6x3 (`dw-b857650`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16l6x3 | mm | [1800, 4200] |
| coronaPower·ip16l6x3 (`dw-fa458fb`) | DCW write | `http` | 双拉薄膜产线 biax-ip16l6x3 | kW | [0.5, 8] |
| 收卷张力SP·ip16l6x3 (`dw-aee35cb`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | N | [30, 180] |
| L1-DAQ-modbus-tcp ip16l6x3 (`dn-97590a5`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16l6x3 | ℃ | [0, 400] |
| L2-DAQ-opcua ip16l6x3 (`dn-bc564b2`) | DAQ acquire | `opcua` | Integrated线2 ip16l6x3 | MPa | [0, 45] |
| L3-DAQ-mqtt ip16l6x3 (`dn-c58bb95`) | DAQ acquire | `mqtt` | Integrated线3 ip16l6x3 | μm | [0, 400] |
| L4-DAQ-http ip16l6x3 (`dn-d8b1f72`) | DAQ acquire | `http` | Integrated线4 ip16l6x3 | μm | [0, 400] |
| L5-DAQ-modbus-rtu ip16l6x3(sat) (`dn-95a3609`) | DAQ acquire | `modbus-rtu` | Integrated线4 ip16l6x3 | 个/m² | [0, 500] |
| 熔体温度 ip16l6x3cl (`dn-06236be`) | DAQ acquire | `modbus-tcp` | CastFilm线 ip16l6x3cl | ℃ | [0, 400] |
| 晶点计数 ip16l6x3cl (`dn-edce5dd`) | DAQ acquire | `modbus-rtu` | CastFilm线 ip16l6x3cl | 个/m² | [0, 500] |
| MeltPressure ip16l6x3cl (`dn-af87470`) | DAQ acquire | `opcua` | CastFilm线 ip16l6x3cl | MPa | [0, 45] |
| thick ip16l6x3cl (`dn-4125955`) | DAQ acquire | `mqtt` | CastFilm线 ip16l6x3cl | μm | [0, 400] |
| defect ip16l6x3cl (`dn-253f1ea`) | DAQ acquire | `http` | CastFilm线 ip16l6x3cl | % | [0, 100] |
| profile ip16l6x3 (`dn-d0dbd49`) | DAQ acquire | `http` | Integrated线1 ip16l6x3 | mm | [0.4, 0.65] |
| ccd ip16l6x3 (`dn-adea72a`) | DAQ acquire | `http` | Integrated线1 ip16l6x3 | 灰度 | [0, 255] |
| L1-DAQ-modbus-tcp ip16l6x3p8 (`dn-d7f8584`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16l6x3p8 | ℃ | [0, 260] |
| L2-DAQ-opcua ip16l6x3p8 (`dn-4815f92`) | DAQ acquire | `opcua` | Integrated线2 ip16l6x3p8 | ℃ | [0, 260] |
| L3-DAQ-mqtt ip16l6x3p8 (`dn-6316520`) | DAQ acquire | `mqtt` | Integrated线3 ip16l6x3p8 | ℃ | [0, 100] |
| L4-DAQ-modbus-rtu ip16l6x3p8(sat) (`dn-0d70b47`) | DAQ acquire | `modbus-rtu` | Integrated线3 ip16l6x3p8 | ℃ | [0, 100] |
| L5-DAQ-http ip16l6x3p8(sat) (`dn-9761bd0`) | DAQ acquire | `http` | Integrated线3 ip16l6x3p8 | L/min | [0, 100] |
| 干燥塔温度·ip16l6x3 (`dn-bdfb171`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [20, 220] |
| 切片残水·ip16l6x3 (`dn-bc6bdb2`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16l6x3 | ppm | [0, 120] |
| 熔体温度·ip16l6x3 (`dn-c123d21`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [200, 330] |
| 泵前熔压·ip16l6x3 (`dn-e84a04e`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | MPa | [0, 35] |
| 泵出口压力·ip16l6x3 (`dn-32830ca`) | DAQ acquire | `modbus-rtu` | 双拉薄膜产线 biax-ip16l6x3 | MPa | [0, 35] |
| 铸片辊面温度·ip16l6x3 (`dn-07ac421`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [0, 80] |
| 纵拉膜温·ip16l6x3 (`dn-3527c35`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16l6x3 | ℃ | [40, 160] |

_(showing first 40 DCW / 24 DAQ nodes; full inventory in `line-profile.json`)_

## Phase scorecard (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---:|---:|---:|---:|---:|---:|
| P0 | Bootstrap · simulator & platform | 1 | 1 | 0 | 0 | 75.0 | 1 |
| P1 | Plant model + offline optimum W* | 3 | 0 | 0 | 0 | 100.0 | 1 |
| P2 | Multi-protocol line provisioning | 6 | 0 | 0 | 0 | 100.0 | 2 |
| P3 | DAQ · governed write · F5 interlock | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P4 | Agent-tool closed loop (3-cycle convergence) | 6 | 1 | 0 | 0 | 92.9 | 3 |
| P4b | Rollback & optimization records | 4 | 0 | 0 | 0 | 100.0 | 2 |
| P4c | HITL approval gate | 0 | 1 | 0 | 0 | 50.0 | 2 |
| P4d | Audit / ledger read surfaces | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P4e | Recipe lifecycle | 2 | 0 | 0 | 0 | 100.0 | 2 |
| P4f | Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits) | 4 | 0 | 0 | 0 | 100.0 | 3 |
| P4m | AgentTeam optimization mission (task board → governed writes → attainment) | 6 | 0 | 0 | 0 | 100.0 | 3 |
| P6 | Closed-loop optimization benchmark (multi-seed) | 6 | 0 | 0 | 0 | 100.0 | 3 |
| P7 | Multimodal acquisition (vector/image) | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P8 | Cross-scenario portability | 11 | 0 | 0 | 0 | 100.0 | 3 |
| P8b | System backstop drill (bounded autonomy) | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P9 | Platform subsystems (team / memory / registry) | 3 | 0 | 0 | 0 | 100.0 | 1 |
| P10 | Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop) | 9 | 1 | 0 | 0 | 95.0 | 3 |
| **Overall** | | | | | | **95.6** | 37 |

## Closed-loop optimization · per-seed

| Seed | J0 | Jend | J* | J/J* % | Iters | Governed writes | Rejected | Converged |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 42 | 63.59 | 88.78 | 89.89 | 98.8 | 2 | 2 | 0 | yes |
| 43 | 85.89 | 88.07 | 89.89 | 98.0 | 3 | 3 | 0 | yes |
| 44 | 86.07 | 86.07 | 89.89 | 95.7 | 0 | 0 | 0 | yes |

## AgentTeam closed-loop tuning walkthrough

How an optimization team is assembled and drives the line, end to end: (1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; (2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); (3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; (4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; (5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.

### Biax (BOPET) multi-node mission — iteration trace

| Iter | Knob | Node | From → To | Thickness μm | Note |
|---|---|---|---|---:|---|
| 0 | — | `—` | — | 28.05 |  |
| 1 | cast-spd-sp | `dw-51806bbf` | 32 → 33.7 | 28.00 |  |
| 2 | fast-roll-sp | `dw-e33500d3` | 118 → 122.4 | 27.98 |  |
| 3 | rail-out-sp | `dw-43eafe70` | 3000 → 3096 | 24.80 |  |

Governed writes: **3** on 3 distinct knob(s) · optimization records: 0 · target window 25 ± 0.7 μm · final thickness reading **24.80 μm** · target attained: **yes**.

### Deterministic closed-loop benchmark — seed 42 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 56.18 | 0.517 | 17.48 | 209.9 | 150 | 95.0 | 200.0 | 63.59 | 0 |
| 1 | 51.43 | 0.100 | 16.83 | 208.6 | 133 | 95.0 | 200.0 | 88.80 | 34.179 |
| 2 | 49.58 | 0.183 | 16.08 | 207.2 | 129 | 95.0 | 200.0 | 88.76 | 56.292 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **98.8 %**; governed writes 2 (rejected 0), optimization records 2.

### Deterministic closed-loop benchmark — seed 43 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 52.10 | 0.567 | 17.57 | 209.9 | 150 | 95.0 | 200.0 | 85.89 | 0 |
| 1 | 53.98 | 0.033 | 18.07 | 208.8 | 144 | 95.0 | 200.0 | 77.52 | 34.258 |
| 2 | 49.20 | 0.333 | 16.67 | 207.0 | 133 | 95.0 | 200.0 | 88.07 | 56.408 |
| 3 | 49.62 | 0.300 | 16.62 | 205.3 | 135 | 95.0 | 200.0 | 88.07 | 78.584 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **98.0 %**; governed writes 3 (rejected 0), optimization records 3.

### Deterministic closed-loop benchmark — seed 44 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 51.63 | 0.683 | 17.43 | 210.0 | 150 | 95.0 | 200.0 | 86.07 | 0 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **95.7 %**; governed writes 0 (rejected 0), optimization records 0.

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `agentteam-mission.log` | 1.1 KB | AgentTeam optimization mission — full task-board trajectory |
| `agentteam-biax.log` | 1.5 KB | AgentTeam biax multi-node mission — full trajectory |
| `line-profile.json` | 80.3 KB | Simulated line profile — devices, protocols, endpoints, SP/PV signal inventory, AW node mapping |
| `metrics.csv` | 2.8 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 149.5 KB | Full machine-readable results (checks, phases, evidence, KPIs, line profile, agent-team traces) |
| `summary.json` | 15.9 KB | Verdict + KPI + per-line summary (compare/aggregate input) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✔ **platform-reachable** (pass) — platform reachable & authenticated
  - 平台 http://127.0.0.1:3005：自动分离启动 pid=78540（日志 D:\codes\ABO\aw-bench-platform.log）
  - 鉴权 OK (login)
  - simulator http://127.0.0.1:4011：自动启动 pid=18232
  - 隔离配置根 D:/codes/ABO/AgentWorkShop/../aw-bench-home
- ▲ **daq-sampling-ready** (warn) — 数采采样恢复(produced 增长)
  - 150s 内未观察到采样增长(数采基础设施降级?后续数采类检查可能如实失败)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass) — 预设 cast-film-physics 已应用
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **field-defaults** (pass) — 现场=蓝图默认值（6 信号核对）
  - 全部信号初始值=蓝图默认值
- ✔ **offline-optimum** (pass) — offline optimum W* (ground truth) available
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-10-31T03:10:13.754Z"}

### P10 — Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)

- ✔ **biax-ensure** (pass) — 节点探测补建(9 建缺失 / 0 修复 / 0 原样)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass) — 五协议多节点建线(DCW 30 + DAQ 19,驱动实测 9/9)
  - line=ln-1b30343d recipe=rc-3ec0b31e started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass) — 测厚仪真实链路采样(1 点)
  - daq=dn-9c35071b · samples=1
- ▲ **biax-agent-cards** (warn) — Agent 语义卡含双拉工艺描述(semantics 贯通)
  - 语义卡长度 16048 · 关键词命中 铸片辊速度
  - sample: ### ⚙ 频道执行模式:auto(默认,频道不加额外约束)—— 是否人工批准由产线总闸与你的绑定模式决定;自动执行的下发必须附带 hypothesis 依据,四层限界/单步上限/运行门照常生效  #### ◆ L1-DCW-modbus-tcp ip16pix2 [id=dw-e0125def] - 物理量: 烘箱温
- ✔ **biax-mission-board** (pass) — 任务板:双拉优化任务下达并由 lead 派发
  - parent task + lead child: ✔
- ✔ **biax-mission-multinode** (pass) — 多节点受治理写(3 个执行节点 / 3 写)
  - 1. task board: channel=7c84a6fd-7e30-4f18-aeb8-d2674463a078 parent=9ece2e7d-91c7-4b0e-9ae6-4b314c136b10 leadChild=d1511907-44bc-4436-9713-9e917453980d
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.1,3.5,1.6]
  - 3. initial thickness=28.05 μm(目标 25±0.7)
  - iter1: cast-spd-sp 32→33.7 ✔ batch=(未回传) · thickness→28.00μm · 复测待判读
- ✔ **biax-mission-attained** (pass) — 厚度目标达成(|PV−25.0|≤0.7μm,final=24.80)
  - writes=3/6 · distinctKnobs=3 · final=24.80μm
  -         meltTemp=292.0℃(安全窗 268~300)
  - 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(1 条,含参数/判定/窗口): - opt-a70915b6 [open] 铸片辊速度SP·ip16pix2: 32 → 33.7,设定 11:19:44,判定 未判定,进行中   假设: biax mission iter 1:
  - 5. outcome: writes=3 distinctKnobs=3 final=24.80μm attained=true
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
  - line=ln-a0cfb80e daq=dn-4ff6862f dcw=dw-e0125def recipe=rc-a550cd32
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 209.24000549316406
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass) — Line2 [opcua] 供给
  - line=ln-441966d3 daq=dn-4fe909d9 dcw=dw-90f32f6f recipe=rc-d2198a53
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 16.28
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass) — Line3 [mqtt] 供给
  - line=ln-b5599e19 daq=dn-c638bc19 dcw=dw-4722d1c7 recipe=rc-e1fe076c
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,aw/sim/thick → scalar 49.51(jsonPath=data.thick)(被动订阅:收到报文即入库)
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass) — Line4 [http] 供给
  - line=ln-662c0028 daq=dn-ee2cc952 dcw=dw-3476a700 recipe=rc-684d1c35
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 0.654
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass) — Line5 [modbus-rtu] 供给（satellite DAQ）
  - line=ln-662c0028 daq=dn-ec895752 dcw=✘ recipe=rc-684d1c35 ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 3
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ · governed write · F5 interlock

- ✔ **line-1-io** (pass) — Line1 [modbus-tcp] integration check
  - ✔ DAQ samples stored 10  points (modbus-tcp real driver）
  - ✔ 约6写 p50=38.316ms p95=48.687ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass) — Line2 [opcua] integration check
  - ✔ DAQ samples stored 10  points (opcua real driver）
  - ✔ 约6写 p50=21.519ms p95=21.744ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass) — Line3 [mqtt] integration check
  - ✔ DAQ samples stored 5  points (mqtt real driver）
  - ✔ 约6写 p50=24.044ms p95=27.682ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass) — Line4 [http] integration check
  - ✔ DAQ samples stored 13  points (http real driver）
  - ✔ 约6写 p50=34.884ms p95=39.837ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass) — Line5 [modbus-rtu] integration check
  - ✔ DAQ samples stored 14  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass) — 闭环夹具（channel+agent）
  - channel=1290202d-cc15-474e-87ab-d498fa77efd1
  - agent=fb153e62-fe23-403f-81d1-bd37ddcf77bc
  - harness=opencode
- ✔ **tool-bridge** (pass) — opencode 的 host 工具直调面可用
  - 探测 my_industrial_nodes → 你尚未绑定任何工业对象。请让用户或 lead 为你绑定:数控/数采节点(kind=daq 观察)或配方(kind=recipe,参数写入与下发)。
- ✔ **line-1-loop** (pass) — Line1 [modbus-tcp] Agent 闭环收敛（3/3 轮）
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔
  - 向窗口中心收敛 ✔ · 耗时 35.327s
- ✔ **line-2-loop** (pass) — Line2 [opcua] Agent 闭环收敛（3/3 轮）
  - iter1: SP→144.6 ✔ · 回读 145 ✔ · daq ✔
  - iter2: SP→147.3 ✔ · 回读 147 ✔ · daq ✔
  - iter3: SP→150 ✔ · 回读 150 ✔ · daq ✔
  - 向窗口中心收敛 ✔ · 耗时 34.576s
- ▲ **line-3-loop** (warn) — Line3 [mqtt] Agent 闭环收敛（0/3 轮）
  - iter1: SP→91.4 ✔ · 回读 98 ✘ · daq ✔
  - iter2: SP→93.2 ✔ · 回读 97.4 ✘ · daq ✔
  - iter3: SP→95 ✔ · 回读 98 ✘ · daq ✔
  - 向窗口中心收敛 ✘ · 耗时 34.627s
- ✔ **line-4-loop** (pass) — Line4 [http] Agent 闭环收敛（3/3 轮）
  - iter1: SP→0.946 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔
  - iter2: SP→0.973 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔
  - iter3: SP→1 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔
  - 向窗口中心收敛 ✔ · 耗时 34.611s
- ✔ **plant-response** (pass) — 工艺模型响应（SP→plant truth 随动）
  - 真值样本 6 → 201
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":1,"configuredTimeScale":6,"elapsedS"

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass) — Line1 优化记录生命周期
  - current 204.6999969482422 → record A writes 208.06 (up)，记录 B writes 201.34 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-26b0a9c2 verdict keep → status 200
  - ✔ (rollback path) record opt-3d052886 verdict rollback (recorded only; PLC still 201.3000030517578)
  - ✔ rollback executed (status 200) → readback 208.10000610351562 (expected record B from=208.06)
- ✔ **line-1-rbjudge** (pass) — Line1 撤销记录 opt-79e17c17 判定关闭
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass) — Line1 node-level single-step rollback (undo stack)
  - ✔ write 205.04 effective (readback 205, before 208.10000610351562)
  - ✔ journal rollback 受理（status 200，记录 opt-79e17c17）
  - ✔ readback after rollback 208.10000610351562 (expected back to 208.10000610351562, tolerance 0.75)
- ✔ **param-ledger** (pass) — 参数台账（三值对照 + 在册历史）
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ▲ **line-2-hitl** (warn) — Line2 HITL 审批闭环
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-dcee612a（detail: L2-DCW-opcua ip16pix2(烘箱温度设定)设定 148.2rpm,有效写入区间 141~159rpm(节点安全量程 ∩ 配方）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 探索步被拒绝(未写入产线,已记录 rejected): 下发被拒绝:回退冷却中:节点「L2-DCW-opcua ip16pix2」242s 内禁止同向重写(刚从 150 回退到 1
  - ✘ post-approval PLC effect: readback 147 (expected 148.2)
  - 审批裁决时延 464 ms（挂起→批准，含轮询周期）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass) — 治理只读面
  - ✔ 参数变更账本 journal：本产线 11  anchors (source coverage  rollback/manual/agent/recipe）
  - ✔ audit: 200 entries
  - ✔ ops-logs: 200 entries
  - ✔ 报警记录：全局 24 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass) — Line1 [modbus-tcp] recipe lifecycle
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-1b5335a5 → lastGood=rr-1b5335a5
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass) — Line2 [opcua] recipe lifecycle
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-78515642 → lastGood=rr-78515642
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ✔ **param-facade** (pass) — Line2 [opcua] 参数面自动生成且无寄存器泄漏
  - param=pp-fd4d92df key=temp-sp unit=rpm
  - 含 register/dataType/driverConfig? 无 ✔
- ✔ **param-limits** (pass) — Line2 基准限界 [143.7,156.3] + 产品限界 [146.22,153.78] 设定
  - 有效交集(含配方窗) 141~159 → param 143.7~156.3 → product 146.22~153.78 · node 层 50~200（四层收窄：node ∩ param ∩ product ∩ recipe）
- ✔ **param-write-governed** (pass) — Line2 参数面写入联锁（交集内写入 · 越产品层拦截 · 越基准层拦截 · 参数读回）
  - 148.866 → ✔ 写入+回读
  - 155.04 → ✔ 产品层拦截
  - 157.65 → ✔ 基准限界层拦截
  - param read → ✔ 148.866rpm
- ✔ **agent-param-tools** (pass) — Line2 Agent 参数写面 v2 契约（直写拒 · 摘除 param_read · 未绑定拒）
  - bound param_control → ✔ v2 拒绝+指引配方面
  - param_read → ✔ 已随 v2 摘除
  - unbound agent → ✔ v2 拒绝(不泄露授权面)

### P4m — AgentTeam optimization mission (task board → governed writes → attainment)

- ✔ **mission-board** (pass) — 任务板：优化任务下达并由 lead 派发
  - channel=9fe5ab77-6750-4ded-b9f5-7e30cb6ac60c parent=fb77d189-6d11-491d-9f7d-a1faaff47171 leadChild=36495721-dc61-42d8-b38b-c6285bffca33 assignee=ee40b746-8829-4ed7-ba3f-03ad7fc8d95d
- ✔ **mission-timescale-read** (pass) — 时段数据读取（daq_query from/to/bucket）
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip16pix2[id=dn-4ff6862f](熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-10-31T11:07 ~ 2026-10-31T11:12(降采样 
- ✔ **mission-governed-write** (pass) — 受治理参数下发（1 写全开记录+判定）
  - iter1: SP→204.704 ✔ · record=opened+judged · PV≈204.7 ✘
- ✔ **mission-journal** (pass) — 参数账本归因（Agent source 可追溯）
  - journal sample: 优化记录(4 条,含参数/判定/窗口): - opt-0397fb6e [open] L1-DCW-modbus-tcp ip16pix2: 200 → 204.704,设定 11:12:50,判定 未判定,进行中   假设: mission iter 1: reach 204.704±0.75 -
- ✔ **mission-attained** (pass) — 优化目标达成（|PV−204.704|≤0.75）
  - writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass) — 任务收口（lead 派发→worker 剧本完成→父任务聚合）
  - terminalState=COMPLETED · writes=1 · reached=true

### P6 — Closed-loop optimization benchmark (multi-seed)

- ✔ **twin-nodes** (pass) — cast-film twin node provisioning（执行器 + 传感器）
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass) — 离线最优 W*（ground truth）
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-10-31T03:10:13.754Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ✔ **seed-42** (pass) — seed=42 闭环优化（J/J*=0.988）
  - 预热 0.126s（熔体温度 200.6℃，达工艺窗 [195,225]）
  - iter0 起点：h=56.18μm defect=0.517% P=17.48MPa T=209.9℃ N=150 v=95.0 → J=63.59
  - iter1 下发 N=133 v=95 z=200 → h=51.43μm defect=0.100% P=16.83MPa T=208.6℃ → J=88.80 
  - iter2 下发 N=129 v=95 z=200 → h=49.58μm defect=0.183% P=16.08MPa T=207.2℃ → J=88.76 
- ✔ **seed-43** (pass) — seed=43 闭环优化（J/J*=0.98）
  - 预热 0.023s（熔体温度 207.06℃，达工艺窗 [195,225]）
  - iter0 起点：h=52.10μm defect=0.567% P=17.57MPa T=209.9℃ N=150 v=95.0 → J=85.89
  - iter1 下发 N=144 v=95 z=200 → h=53.98μm defect=0.033% P=18.07MPa T=208.8℃ → J=77.52 
  - iter2 下发 N=133 v=95 z=200 → h=49.20μm defect=0.333% P=16.67MPa T=207.0℃ → J=88.07 
- ✔ **seed-44** (pass) — seed=44 闭环优化（J/J*=0.957）
  - 预热 0.024s（熔体温度 205.28℃，达工艺窗 [195,225]）
  - iter0 起点：h=51.63μm defect=0.683% P=17.43MPa T=210.0℃ N=150 v=95.0 → J=86.07
  - ✔ 连续两次评估满足收敛判据，第 1 轮前终止
  - 收敛=true · 迭代=0 · 写=0 · rejected=0 · J0=86.073 → Jend=86.073 · J*=89.894 · 比值=0.957
- ✔ **closedloop-aggregate** (pass) — 闭环优化聚合（n=3）
  - J/J*：min 0.957 · mean 0.975 · max 0.988（J* = 89.894）
  - J start均值 78.515 → end均值 87.641
  - 平均迭代 1.667  · 总写 5 · 越界rejected 0 · 收敛 3/3 · 平均墙钟 49.008s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass) — 多形态数采（向量/图像帧）
  - ✔ 向量轮廓帧 2 （52.405,52.571,52.693,53.459,53.587,53.67,53.598,54.035,54.517,54.506,55.171,54.569,54.917,53.678,55.146,55.298,55.187,54.606,55.533,54.75,56.378,55.091,56.077,56.141,55.941,55.005,55.849,55.276,56.016,56.114,54.865,56.16,55.478,5
  - ✔ 图像帧 2 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass) — second plant scenario applied: film-line
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] provisioned
  - line=ln-e847fc9e daq=dn-92b0973a dcw=dw-672bb237
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass) — scenario[film-line] line 2 [opcua] provisioned
  - line=ln-c67ce90e daq=dn-1a8d41af dcw=dw-14e62008
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass) — scenario[film-line] line 3 [mqtt] provisioned
  - line=ln-41770dff daq=dn-b0191615 dcw=dw-66dd8654
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass) — scenario[film-line] line 4 [modbus-rtu] provisioned (satellite DAQ)
  - line=ln-41770dff daq=dn-06089870 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass) — scenario[film-line] line 5 [http] provisioned (satellite DAQ)
  - line=ln-41770dff daq=dn-d3f00dc4 dcw=✘
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
  - ✔ DAQ samples 10 pts (http real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)

### P8b — System backstop drill (bounded autonomy)

- ✔ **cleanup** (pass) — 遗留 open 记录清场（关闭 8/8 条）
  - records closed: 8/8
- ✔ **open-record** (pass) — 探索记录 opt-exploration-mvvtyx4w-gi4rjm 已开（基线 186.1999969482422 → 176.88，auto 策略）
  - 探索步完成(已真实写入产线并记录):   记录: opt-exploration-mvvtyx4w-gi4rjm   控制: L1-DCW-modbus-tcp ip16pix2p8(dw-672bb237) 186.2 → 176.88(步长 9.320,方向 down)   
- ✔ **freeze** (pass) — DAQ temp-pv 已冻结至 312（窗外，窗 [164.4, 195.6]）
  - device=dev-2eb75b06 signal=temp-pv
- ✔ **backstop-verdict** (pass) — 系统兜底判定回退 + 自动恢复基线
  - 判定 by=system verdict=rollback · 时延 120.213s（环境类，节拍决定）
  - PLC 值 186.1999969482422 → 期望基线 186.1999969482422（±0.75） ✔
- ✔ **restore** (pass) — 过程量解冻 + 第一场景恢复: cast-film-physics
  - rig left as found

### P9 — Platform subsystems (team / memory / registry)

- ✔ **team-dispatch** (pass) — 团队调度（lead 派发 → worker 完成）
  - 终态 COMPLETED · assignee=7351ba49-8434-4124-af98-6556abc05c73（lead 认领父任务） · 子任务派发给 worker: ✔
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
| loop | tool_loops_ok | 3 |  lines | 工具级闭环达成 |
| loop | mission_writes | 1 |  | AgentTeam 优化任务受治理写次数 |
| loop | mission_attained | 1 |  | AgentTeam 优化任务达标 |
| gov | record_keep_rollback_ok | 1 |  | 优化记录判定/执行分离 |
| hitl | approval_latency_ms | 464 | ms | 挂起→批准（含 800ms 轮询粒度） |
| audit | journal_anchors | 11 |  | 本Line参数变更账本 |
| audit | audit_entries | 200 |  | 全局审计目 |
| audit | ops_logs | 200 |  | 全局运维日志 |
| recipe | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| gov | param_layer_checks_ok | 4 | /4 | 工艺参数映射层全链 |
| closedloop | J_over_Jstar_mean | 0.975 |  | n=3 seeds，写路径=governed |
| closedloop | J_over_Jstar_min | 0.957 |  | 最差 seed（保守下界） |
| closedloop | J_end_mean | 87.641 |  | J* = 89.894 |
| closedloop | cl_iters_mean | 1.667 |  | 闭环收敛迭代数 |
| closedloop | cl_writes_total | 5 |  | 受治理的闭环写总数 |
| closedloop | cl_rejected_total | 0 |  | 越界被拒（治理拦截） |
| daq | vector_frames | 2 |  | 厚度横向轮廓 |
| daq | image_frames | 2 |  | CCD 表面图像 |
| portability | scenario2_lines | 3 |  | second preset "film-line" (config-only) |
| portability | scenario2_intercept_rate | 1 |  | F5 out-of-window interception on second scenario |
| portability | scenario2_false_blocks | 0 |  | legal in-window writes blocked on second scenario |
| gov | backstop_fired | 1 |  | system-judged rollback on window breach |
| gov | backstop_restored | 1 |  | auto-restore to record baseline |
| gov | backstop_latency_s | 120.213 | s | freeze → verdict (environmental) |
| biax | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| biax | sp_signals | 30 |  | 可写工艺 SP |
| biax | created_missing | 9 |  | 本次补建的缺失设备数 |
| biax | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| biax | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| biax | mission_writes | 3 |  | AgentTeam 双拉任务受治理写次数 |
| biax | mission_distinct_knobs | 3 |  | 参与闭环的执行节点数 |
| biax | mission_attained | 1 |  | 厚度达标 25.0±0.7μm |
| biax | mission_final_thickness | 24.8 | μm | 终态厚度 |
| team | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| memory | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| agent | harness_registry | 14 |  | environment-available 14 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict PASS, grade A). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._
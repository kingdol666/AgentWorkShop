# AW-IndustrialBench · Integrated Pipeline Report

> **PASS** — score **94.7**/100, grade **A**. Hard gate green: no failed checks or phases; skips are honest environmental exclusions.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20261030164820-124s` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `cbac812a4c09f527` (sha256 over 13 checker sources) |
| Git commit | `60fa983e` |
| Runtime | v24.19.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3005 · http://127.0.0.1:4011 |
| Tool harness | opencode (deterministic) · LLM agent: (none) |
| Reproduce | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 53 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 31.218 ms | incl. real protocol transactions |
| Closed-loop J/J* | 97.7 % | n=3 seeds · worst 96.0% · J*=89.894 |
| Tool-level loops | 2 | dcw→daq→judge ×3 convergence |
| Param-layer governance | 4/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | fired+restored | window breach → auto-rollback in 120.243s (env) |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 2 knobs · 2 writes → 25.62μm ✔ |
| LLM agent loop | off | --agent omp enables |
| Verdict | PASS | 71/77 checks · hard gate green |

## Simulated production line profile

> Preset `cast-film-physics` — Cast-film extrusion digital twin (plant-model physics engine). An extrusion cast-film line: resin → screw melting → die → casting → thickness gauge. Six writable setpoints (3 zone temperatures, screw speed, line speed, die gap) act on a physics engine whose observable process quantities are melt temperature, melt pressure, film thickness, defect rate and gels count.

**Physics.** Deterministic plant model (seeded): first-order thermal lag on melt temperature, algebraic thickness h ∝ N/v from mass conservation, pressure/defect couplings — scored by J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput.
 Plant engine state at report time: phase=`warmup`, seed=`42`.

**Totals.** 5 PLC devices across 5 protocols (modbus-tcp, modbus-rtu, opcua, mqtt, http); **6 writable setpoints (SP → DCW nodes)** and **7 process quantities (PV → DAQ nodes)**; the platform side provisions 9 lines with 43 write nodes and 36 acquisition nodes.

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
| P4 | Agent-tool closed loop (3-cycle convergence) | 5 | 2 | 0 | 0 | 85.7 | 3 |
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
| P10 | Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop) | 8 | 2 | 0 | 0 | 90.0 | 3 |
| **Overall** | | | | | | **94.7** | 37 |

## Closed-loop optimization · per-seed

| Seed | J0 | Jend | J* | J/J* % | Iters | Governed writes | Rejected | Converged |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 42 | 64.44 | 88.60 | 89.89 | 98.6 | 3 | 3 | 0 | yes |
| 43 | 86.33 | 86.33 | 89.89 | 96.0 | 0 | 0 | 0 | yes |
| 44 | 64.45 | 88.62 | 89.89 | 98.6 | 2 | 2 | 0 | yes |

## AgentTeam closed-loop tuning walkthrough

How an optimization team is assembled and drives the line, end to end: (1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; (2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); (3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; (4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; (5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.

### Biax (BOPET) multi-node mission — iteration trace

| Iter | Knob | Node | From → To | Thickness μm | Note |
|---|---|---|---|---:|---|
| 0 | — | `—` | — | 27.90 |  |
| 1 | cast-spd-sp | `dw-137a0135` | 32 → 33.7 | 27.96 |  |
| 2 | fast-roll-sp | `dw-a378e80b` | 118 → 122.4 | 25.62 |  |

Governed writes: **2** on 2 distinct knob(s) · optimization records: 0 · target window 25 ± 0.7 μm · final thickness reading **25.62 μm** · target attained: **yes**.

### Deterministic closed-loop benchmark — seed 42 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 56.00 | 0.567 | 17.50 | 209.9 | 150 | 95.0 | 200.0 | 64.44 | 0 |
| 1 | 52.17 | 0.200 | 16.87 | 208.6 | 134 | 95.0 | 200.0 | 87.52 | 34.135 |
| 2 | 49.00 | 0.200 | 15.98 | 207.0 | 128 | 95.0 | 200.0 | 88.76 | 56.25 |
| 3 | 50.22 | 0.250 | 16.12 | 205.7 | 131 | 95.0 | 200.0 | 88.44 | 78.388 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **98.6 %**; governed writes 3 (rejected 0), optimization records 3.

### Deterministic closed-loop benchmark — seed 43 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 51.55 | 0.600 | 17.45 | 210.2 | 150 | 95.0 | 200.0 | 86.33 | 0 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **96.0 %**; governed writes 0 (rejected 0), optimization records 0.

### Deterministic closed-loop benchmark — seed 44 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.95 | 0.650 | 17.50 | 210.0 | 150 | 95.0 | 200.0 | 64.45 | 0 |
| 1 | 49.75 | 0.117 | 16.90 | 208.8 | 134 | 95.0 | 200.0 | 88.70 | 34.215 |
| 2 | 49.73 | 0.150 | 16.72 | 207.2 | 135 | 95.0 | 200.0 | 88.54 | 56.362 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **98.6 %**; governed writes 2 (rejected 0), optimization records 2.

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `agentteam-mission.log` | 1.1 KB | AgentTeam optimization mission — full task-board trajectory |
| `agentteam-biax.log` | 1.3 KB | AgentTeam biax multi-node mission — full trajectory |
| `line-profile.json` | 25.9 KB | Simulated line profile — devices, protocols, endpoints, SP/PV signal inventory, AW node mapping |
| `metrics.csv` | 2.8 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 91.1 KB | Full machine-readable results (checks, phases, evidence, KPIs, line profile, agent-team traces) |
| `summary.json` | 15.7 KB | Verdict + KPI + per-line summary (compare/aggregate input) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✔ **platform-reachable** (pass) — platform reachable & authenticated
  - 平台 http://127.0.0.1:3005：already-up
  - 鉴权 OK (register-first-admin)
  - simulator http://127.0.0.1:4011：already up (reused)
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
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-10-30T16:51:00.027Z"}

### P10 — Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)

- ✔ **biax-ensure** (pass) — 节点探测补建(9 建缺失 / 0 修复 / 0 原样)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass) — 五协议多节点建线(DCW 30 + DAQ 19,驱动实测 9/9)
  - line=ln-e397cb7c recipe=rc-0c2e2e2a started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass) — 测厚仪真实链路采样(1 点)
  - daq=dn-8c15e1dd · samples=1
- ▲ **biax-agent-cards** (warn) — Agent 语义卡含双拉工艺描述(semantics 贯通)
  - 语义卡长度 16048 · 关键词命中 铸片辊速度
  - sample: ### ⚙ 频道执行模式:auto(默认,频道不加额外约束)—— 是否人工批准由产线总闸与你的绑定模式决定;自动执行的下发必须附带 hypothesis 依据,四层限界/单步上限/运行门照常生效  #### ◆ L1-DCW-modbus-tcp ip16l6x3 [id=dw-89a79c9d] - 物理量: 烘箱温
- ✔ **biax-mission-board** (pass) — 任务板:双拉优化任务下达并由 lead 派发
  - parent task + lead child: ✔
- ▲ **biax-mission-multinode** (warn) — 多节点受治理写(2 个执行节点 / 2 写)
  - 1. task board: channel=775172b4-ee94-43fc-8961-da7342c1a4b3 parent=193a37ec-ca66-4418-968b-5e5770b2a18c leadChild=21f5d36e-43aa-41b2-a0fb-4c7264db7774
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[27.8,3.5,1.6]
  - 3. initial thickness=27.90 μm(目标 25±0.7)
  - iter1: cast-spd-sp 32→33.7 ✔ batch=(未回传) · thickness→27.96μm · 复测待判读
- ✔ **biax-mission-attained** (pass) — 厚度目标达成(|PV−25.0|≤0.7μm,final=25.62)
  - writes=2/6 · distinctKnobs=2 · final=25.62μm
  -         meltTemp=291.7℃(安全窗 268~300)
  - 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(1 条,含参数/判定/窗口): - opt-d1e22b1d [open] 铸片辊速度SP·ip16l6x3: 32 → 33.7,设定 00:59:39,判定 未判定,进行中   假设: biax mission iter 1:
  - 5. outcome: writes=2 distinctKnobs=2 final=25.62μm attained=true
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
  - line=ln-d451e059 daq=dn-97590a51 dcw=dw-89a79c9d recipe=rc-18d2791d
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 209.9600067138672
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass) — Line2 [opcua] 供给
  - line=ln-0893781d daq=dn-bc564b20 dcw=dw-65f8dbd5 recipe=rc-2206d7dc
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 16.44
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass) — Line3 [mqtt] 供给
  - line=ln-6de9d5ff daq=dn-c58bb959 dcw=dw-b9f7b385 recipe=rc-e4fb0582
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,aw/sim/thick → scalar 49.66(jsonPath=data.thick)(被动订阅:收到报文即入库)
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass) — Line4 [http] 供给
  - line=ln-30f165fe daq=dn-d8b1f727 dcw=dw-8d21a0f0 recipe=rc-451a05ce
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 0.426
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass) — Line5 [modbus-rtu] 供给（satellite DAQ）
  - line=ln-30f165fe daq=dn-95a36092 dcw=✘ recipe=rc-451a05ce ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 5
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ · governed write · F5 interlock

- ✔ **line-1-io** (pass) — Line1 [modbus-tcp] integration check
  - ✔ DAQ samples stored 10  points (modbus-tcp real driver）
  - ✔ 约6写 p50=47.739ms p95=48.14ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass) — Line2 [opcua] integration check
  - ✔ DAQ samples stored 11  points (opcua real driver）
  - ✔ 约6写 p50=20.98ms p95=22.355ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass) — Line3 [mqtt] integration check
  - ✔ DAQ samples stored 6  points (mqtt real driver）
  - ✔ 约6写 p50=22.576ms p95=22.946ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass) — Line4 [http] integration check
  - ✔ DAQ samples stored 12  points (http real driver）
  - ✔ 约6写 p50=33.576ms p95=34.326ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass) — Line5 [modbus-rtu] integration check
  - ✔ DAQ samples stored 14  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass) — 闭环夹具（channel+agent）
  - channel=cd8d69f7-8dcc-4011-b7a2-38350d6bb399
  - agent=96974c58-763b-4518-a9ee-e1fc9033c7ed
  - harness=opencode
- ✔ **tool-bridge** (pass) — opencode 的 host 工具直调面可用
  - 探测 my_industrial_nodes → 你尚未绑定任何工业对象。请让用户或 lead 为你绑定:数控/数采节点(kind=daq 观察)或配方(kind=recipe,参数写入与下发)。
- ✔ **line-1-loop** (pass) — Line1 [modbus-tcp] Agent 闭环收敛（3/3 轮）
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔
  - 向窗口中心收敛 ✔ · 耗时 34.957s
- ✔ **line-2-loop** (pass) — Line2 [opcua] Agent 闭环收敛（3/3 轮）
  - iter1: SP→144.6 ✔ · 回读 145 ✔ · daq ✔
  - iter2: SP→147.3 ✔ · 回读 147 ✔ · daq ✔
  - iter3: SP→150 ✔ · 回读 150 ✔ · daq ✔
  - 向窗口中心收敛 ✔ · 耗时 34.448s
- ▲ **line-3-loop** (warn) — Line3 [mqtt] Agent 闭环收敛（0/3 轮）
  - iter1: SP→91.4 ✘ 探索步被拒绝(未写入产线,已记录 rejected): 下发被拒绝:设定值 20m/min 低于下限 配方「Integrated工艺3 ip16l6x3」工艺窗 · 回读 97.4 ✘ · daq ✔
  - iter2: SP→93.2 ✘ 探索步被拒绝(未写入产线,已记录 rejected): 下发被拒绝:设定值 20m/min 低于下限 配方「Integrated工艺3 ip16l6x3」工艺窗 · 回读 97.4 ✘ · daq ✔
  - iter3: SP→95 ✘ 探索步被拒绝(未写入产线,已记录 rejected): 下发被拒绝:设定值 20m/min 低于下限 配方「Integrated工艺3 ip16l6x3」工艺窗 · 回读 97.4 ✘ · daq ✔
  - 向窗口中心收敛 ✘ · 耗时 4.372s
- ▲ **line-4-loop** (warn) — Line4 [http] Agent 闭环收敛（1/3 轮）
  - iter1: SP→0.946 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔
  - iter2: SP→0.973 ✘ 探索步被拒绝(未写入产线,已记录 rejected): 下发被拒绝:设定值 0.895mm 低于下限 配方「Integrated工艺4 ip16l6x3」工艺窗 · 回读 n/a(该驱动不回读) ✔ · daq ✔
  - iter3: SP→1 ✘ 探索步被拒绝(未写入产线,已记录 rejected): 下发被拒绝:设定值 0.895mm 低于下限 配方「Integrated工艺4 ip16l6x3」工艺窗 · 回读 n/a(该驱动不回读) ✔ · daq ✔
  - 向窗口中心收敛 ✘ · 耗时 14.49s
- ✔ **plant-response** (pass) — 工艺模型响应（SP→plant truth 随动）
  - 真值样本 8 → 201
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":1,"configuredTimeScale":6,"elapsedS"

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass) — Line1 优化记录生命周期
  - current 204.6999969482422 → record A writes 208.06 (up)，记录 B writes 201.34 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-e32d765b verdict keep → status 200
  - ✔ (rollback path) record opt-c856d877 verdict rollback (recorded only; PLC still 201.3000030517578)
  - ✔ rollback executed (status 200) → readback 208.10000610351562 (expected record B from=208.06)
- ✔ **line-1-rbjudge** (pass) — Line1 撤销记录 opt-5c06e6be 判定关闭
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass) — Line1 node-level single-step rollback (undo stack)
  - ✔ write 205.04 effective (readback 205, before 208.10000610351562)
  - ✔ journal rollback 受理（status 200，记录 opt-5c06e6be）
  - ✔ readback after rollback 208.10000610351562 (expected back to 208.10000610351562, tolerance 0.75)
- ✔ **param-ledger** (pass) — 参数台账（三值对照 + 在册历史）
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ▲ **line-2-hitl** (warn) — Line2 HITL 审批闭环
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-3cba1ceb（detail: L2-DCW-opcua ip16l6x3(烘箱温度设定)设定 148.2rpm,有效写入区间 141~159rpm(节点安全量程 ∩ 配方）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 探索步被拒绝(未写入产线,已记录 rejected): 下发被拒绝:回退冷却中:节点「L2-DCW-opcua ip16l6x3」293s 内禁止同向重写(刚从 150 回退到 1
  - ✘ post-approval PLC effect: readback 147 (expected 148.2)
  - 审批裁决时延 450 ms（挂起→批准，含轮询周期）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass) — 治理只读面
  - ✔ 参数变更账本 journal：本产线 11  anchors (source coverage  rollback/manual/agent/recipe）
  - ✔ audit: 200 entries
  - ✔ ops-logs: 96 entries
  - ✔ 报警记录：全局 4 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass) — Line1 [modbus-tcp] recipe lifecycle
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-3209c42b → lastGood=rr-3209c42b
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass) — Line2 [opcua] recipe lifecycle
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-494f6f86 → lastGood=rr-494f6f86
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ✔ **param-facade** (pass) — Line2 [opcua] 参数面自动生成且无寄存器泄漏
  - param=pp-a36fadd2 key=temp-sp unit=rpm
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
  - channel=1124059e-c79d-40c7-a6ac-7b7587387ae5 parent=ee4fce20-a946-423d-b41e-f04de6c16323 leadChild=c31e6080-59ae-4519-9f0c-209b9b486b68 assignee=9805c38a-5c99-4a77-a7b0-23fa7fd076bb
- ✔ **mission-timescale-read** (pass) — 时段数据读取（daq_query from/to/bucket）
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip16l6x3[id=dn-97590a51](熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-10-31T00:47 ~ 2026-10-31T00:52(降采样 
- ✔ **mission-governed-write** (pass) — 受治理参数下发（1 写全开记录+判定）
  - iter1: SP→204.704 ✔ · record=opened+judged · PV≈204.7 ✘
- ✔ **mission-journal** (pass) — 参数账本归因（Agent source 可追溯）
  - journal sample: 优化记录(4 条,含参数/判定/窗口): - opt-419f1d2a [open] L1-DCW-modbus-tcp ip16l6x3: 200 → 204.704,设定 00:52:45,判定 未判定,进行中   假设: mission iter 1: reach 204.704±0.75 -
- ✔ **mission-attained** (pass) — 优化目标达成（|PV−204.704|≤0.75）
  - writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass) — 任务收口（lead 派发→worker 剧本完成→父任务聚合）
  - terminalState=COMPLETED · writes=1 · reached=true

### P6 — Closed-loop optimization benchmark (multi-seed)

- ✔ **twin-nodes** (pass) — cast-film twin node provisioning（执行器 + 传感器）
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass) — 离线最优 W*（ground truth）
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-10-30T16:51:00.027Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ✔ **seed-42** (pass) — seed=42 闭环优化（J/J*=0.986）
  - 预热 0.055s（熔体温度 200.9℃，达工艺窗 [195,225]）
  - iter0 起点：h=56.00μm defect=0.567% P=17.50MPa T=209.9℃ N=150 v=95.0 → J=64.44
  - iter1 下发 N=134 v=95 z=200 → h=52.17μm defect=0.200% P=16.87MPa T=208.6℃ → J=87.52 
  - iter2 下发 N=128 v=95 z=200 → h=49.00μm defect=0.200% P=15.98MPa T=207.0℃ → J=88.76 
- ✔ **seed-43** (pass) — seed=43 闭环优化（J/J*=0.96）
  - 预热 0.033s（熔体温度 205.6℃，达工艺窗 [195,225]）
  - iter0 起点：h=51.55μm defect=0.600% P=17.45MPa T=210.2℃ N=150 v=95.0 → J=86.33
  - ✔ 连续两次评估满足收敛判据，第 1 轮前终止
  - 收敛=true · 迭代=0 · 写=0 · rejected=0 · J0=86.333 → Jend=86.333 · J*=89.894 · 比值=0.96
- ✔ **seed-44** (pass) — seed=44 闭环优化（J/J*=0.986）
  - 预热 0.03s（熔体温度 210.08℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.95μm defect=0.650% P=17.50MPa T=210.0℃ N=150 v=95.0 → J=64.45
  - iter1 下发 N=134 v=95 z=200 → h=49.75μm defect=0.117% P=16.90MPa T=208.8℃ → J=88.70 
  - iter2 下发 N=135 v=95 z=200 → h=49.73μm defect=0.150% P=16.72MPa T=207.2℃ → J=88.54 
- ✔ **closedloop-aggregate** (pass) — 闭环优化聚合（n=3）
  - J/J*：min 0.96 · mean 0.977 · max 0.986（J* = 89.894）
  - J start均值 71.741 → end均值 87.85
  - 平均迭代 1.667  · 总写 5 · 越界rejected 0 · 收敛 3/3 · 平均墙钟 48.949s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass) — 多形态数采（向量/图像帧）
  - ✔ 向量轮廓帧 2 （46.563,47.303,46.785,47.543,47.862,47.559,47.646,47.931,47.942,48.076,48.319,48.899,48.018,48.969,48.765,48.889,48.802,49.347,49.51,48.907,49.592,49.407,50.221,49.878,49.27,50.371,50.121,49.559,49.582,49.644,49.645,50.153,49.211,
  - ✔ 图像帧 2 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass) — second plant scenario applied: film-line
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] provisioned
  - line=ln-9f1ddbe6 daq=dn-d7f85844 dcw=dw-6fc2c66e
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass) — scenario[film-line] line 2 [opcua] provisioned
  - line=ln-c52ab8e9 daq=dn-4815f921 dcw=dw-1d8fff3b
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass) — scenario[film-line] line 3 [mqtt] provisioned
  - line=ln-71d57f3e daq=dn-6316520a dcw=dw-7c8162d5
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass) — scenario[film-line] line 4 [modbus-rtu] provisioned (satellite DAQ)
  - line=ln-71d57f3e daq=dn-0d70b47a dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass) — scenario[film-line] line 5 [http] provisioned (satellite DAQ)
  - line=ln-71d57f3e daq=dn-9761bd06 dcw=✘
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

- ✔ **cleanup** (pass) — 遗留 open 记录清场（关闭 2/2 条）
  - records closed: 2/2
- ✔ **open-record** (pass) — 探索记录 opt-exploration-mvv7tgfj-g72rfs 已开（基线 186.1999969482422 → 176.88，auto 策略）
  - 探索步完成(已真实写入产线并记录):   记录: opt-exploration-mvv7tgfj-g72rfs   控制: L1-DCW-modbus-tcp ip16l6x3p8(dw-6fc2c66e) 186.2 → 176.88(步长 9.320,方向 down)   
- ✔ **freeze** (pass) — DAQ temp-pv 已冻结至 312（窗外，窗 [164.4, 195.6]）
  - device=dev-2f4cf5c2 signal=temp-pv
- ✔ **backstop-verdict** (pass) — 系统兜底判定回退 + 自动恢复基线
  - 判定 by=system verdict=rollback · 时延 120.243s（环境类，节拍决定）
  - PLC 值 186.1999969482422 → 期望基线 186.1999969482422（±0.75） ✔
- ✔ **restore** (pass) — 过程量解冻 + 第一场景恢复: cast-film-physics
  - rig left as found

### P9 — Platform subsystems (team / memory / registry)

- ✔ **team-dispatch** (pass) — 团队调度（lead 派发 → worker 完成）
  - 终态 COMPLETED · assignee=82d903b0-1396-45ad-973d-7a2b14e92e9b（lead 认领父任务） · 子任务派发给 worker: ✔
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
| loop | tool_loops_ok | 2 |  lines | 工具级闭环达成 |
| loop | mission_writes | 1 |  | AgentTeam 优化任务受治理写次数 |
| loop | mission_attained | 1 |  | AgentTeam 优化任务达标 |
| gov | record_keep_rollback_ok | 1 |  | 优化记录判定/执行分离 |
| hitl | approval_latency_ms | 450 | ms | 挂起→批准（含 800ms 轮询粒度） |
| audit | journal_anchors | 11 |  | 本Line参数变更账本 |
| audit | audit_entries | 200 |  | 全局审计目 |
| audit | ops_logs | 96 |  | 全局运维日志 |
| recipe | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| gov | param_layer_checks_ok | 4 | /4 | 工艺参数映射层全链 |
| closedloop | J_over_Jstar_mean | 0.977 |  | n=3 seeds，写路径=governed |
| closedloop | J_over_Jstar_min | 0.96 |  | 最差 seed（保守下界） |
| closedloop | J_end_mean | 87.85 |  | J* = 89.894 |
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
| gov | backstop_latency_s | 120.243 | s | freeze → verdict (environmental) |
| biax | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| biax | sp_signals | 30 |  | 可写工艺 SP |
| biax | created_missing | 9 |  | 本次补建的缺失设备数 |
| biax | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| biax | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| biax | mission_writes | 2 |  | AgentTeam 双拉任务受治理写次数 |
| biax | mission_distinct_knobs | 2 |  | 参与闭环的执行节点数 |
| biax | mission_attained | 1 |  | 厚度达标 25.0±0.7μm |
| biax | mission_final_thickness | 25.619999999999997 | μm | 终态厚度 |
| team | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| memory | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| agent | harness_registry | 14 |  | environment-available 14 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict PASS, grade A). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._
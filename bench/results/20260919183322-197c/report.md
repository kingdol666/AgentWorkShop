# AW-IndustrialBench · Integrated Pipeline Report

> **PASS** — score **99.2**/100, grade **A**. Hard gate green: no failed checks or phases; skips are honest environmental exclusions.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20260919183322-197c` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `d481d7cf1177b1e6` (sha256 over 9 checker sources) |
| Git commit | `29313c5` |
| Runtime | v24.19.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3320 · http://127.0.0.1:4010 |
| Tool harness | opencode (deterministic) · LLM agent: (none) |
| Reproduce | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 60 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 29.547 ms | incl. real protocol transactions |
| Closed-loop J/J* | 97.1 % | n=3 seeds · worst 97.0% · J*=89.894 |
| Tool-level loops | 4 | dcw→daq→judge ×3 convergence |
| Param-layer governance | 4/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | fired+restored | window breach → auto-rollback in 130.151s (env) |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 1 knobs · 1 writes → 0.08μm |
| LLM agent loop | off | --agent omp enables |
| Verdict | PASS | 73/75 checks · hard gate green |

## Simulated production line profile

> Preset `cast-film-physics` — Cast-film extrusion digital twin (plant-model physics engine). An extrusion cast-film line: resin → screw melting → die → casting → thickness gauge. Six writable setpoints (3 zone temperatures, screw speed, line speed, die gap) act on a physics engine whose observable process quantities are melt temperature, melt pressure, film thickness, defect rate and gels count.

**Physics.** Deterministic plant model (seeded): first-order thermal lag on melt temperature, algebraic thickness h ∝ N/v from mass conservation, pressure/defect couplings — scored by J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput.
 Plant engine state at report time: phase=`warmup`, seed=`42`.

**Totals.** 5 PLC devices across 5 protocols (modbus-tcp, modbus-rtu, opcua, mqtt, http); **6 writable setpoints (SP → DCW nodes)** and **7 process quantities (PV → DAQ nodes)**; the platform side provisions 9 lines with 43 write nodes and 36 acquisition nodes.

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
| L1-DCW-modbus-tcp ip16710z (`dw-cf45353`) | DCW write | `modbus-tcp` | Integrated线1 ip16710z | ℃ | [120, 260] |
| L2-DCW-opcua ip16710z (`dw-a3eea07`) | DCW write | `opcua` | Integrated线2 ip16710z | rpm | [50, 200] |
| L3-DCW-mqtt ip16710z (`dw-9ea4fab`) | DCW write | `mqtt` | Integrated线3 ip16710z | m/min | [20, 120] |
| L4-DCW-http ip16710z (`dw-a25b571`) | DCW write | `http` | Integrated线4 ip16710z | mm | [0.5, 2] |
| 加热区1SP ip16710zcl (`dw-e6f6a63`) | DCW write | `modbus-tcp` | CastFilm线 ip16710zcl | ℃ | [120, 260] |
| 加热区2SP ip16710zcl (`dw-91b2aff`) | DCW write | `modbus-tcp` | CastFilm线 ip16710zcl | ℃ | [120, 260] |
| 加热区3SP ip16710zcl (`dw-7f3ac1e`) | DCW write | `modbus-tcp` | CastFilm线 ip16710zcl | ℃ | [120, 260] |
| ScrewSpeedSP ip16710zcl (`dw-1befe17`) | DCW write | `opcua` | CastFilm线 ip16710zcl | rpm | [50, 200] |
| lineSpeedSP ip16710zcl (`dw-e2a018b`) | DCW write | `mqtt` | CastFilm线 ip16710zcl | m/min | [20, 120] |
| dieGapSP ip16710zcl (`dw-9fafd57`) | DCW write | `http` | CastFilm线 ip16710zcl | mm | [0.5, 2] |
| L1-DCW-modbus-tcp ip16710zp8 (`dw-1b2a078`) | DCW write | `modbus-tcp` | Integrated线1 ip16710zp8 | ℃ | [0, 260] |
| L2-DCW-opcua ip16710zp8 (`dw-8b57828`) | DCW write | `opcua` | Integrated线2 ip16710zp8 | ℃ | [0, 260] |
| L3-DCW-mqtt ip16710zp8 (`dw-f4dddcc`) | DCW write | `mqtt` | Integrated线3 ip16710zp8 | ℃ | [0, 100] |
| 干燥温度SP·ip16710z (`dw-554ecbe`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16710z | ℃ | [120, 200] |
| 露点SP·ip16710z (`dw-e64d949`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16710z | ℃ | [-80, -20] |
| 喂料速率SP·ip16710z (`dw-f22c196`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16710z | kg/h | [100, 1200] |
| 机筒温度区1SP·ip16710z (`dw-000b341`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [220, 300] |
| 机筒温度区2SP·ip16710z (`dw-ddc68b4`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [220, 300] |
| 机筒温度区3SP·ip16710z (`dw-a49ec31`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [220, 300] |
| 机筒温度区4SP·ip16710z (`dw-fb65710`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [220, 300] |
| 机筒温度区5SP·ip16710z (`dw-91916eb`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [220, 300] |
| 螺杆转速SP·ip16710z (`dw-6ae8e4f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | rpm | [20, 100] |
| 计量泵转速SP·ip16710z (`dw-16bc89d`) | DCW write | `modbus-rtu` | 双拉薄膜产线 biax-ip16710z | rpm | [15, 60] |
| 模唇温度SP·ip16710z (`dw-eb05b43`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [250, 300] |
| 急冷辊温度SP·ip16710z (`dw-3996a30`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [10, 60] |
| 铸片辊速度SP·ip16710z (`dw-afbab32`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | m/min | [10, 60] |
| 静电吸附电压SP·ip16710z (`dw-f292c93`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | kV | [4, 12] |
| 预热辊1温度SP·ip16710z (`dw-55d2222`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [70, 140] |
| 预热辊2温度SP·ip16710z (`dw-f663a08`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [70, 140] |
| 预热辊3温度SP·ip16710z (`dw-6d0c0f1`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [70, 140] |
| 慢辊线速度SP·ip16710z (`dw-874c422`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | m/min | [10, 80] |
| 快辊线速度SP·ip16710z (`dw-88599be`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | m/min | [30, 260] |
| 纵拉退火辊SP·ip16710z (`dw-f21f151`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [90, 170] |
| TDO预热段SP·ip16710z (`dw-8104865`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16710z | ℃ | [80, 140] |
| TDO拉伸段SP·ip16710z (`dw-5d67c0d`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16710z | ℃ | [90, 150] |
| TDO定型段SP·ip16710z (`dw-206c633`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16710z | ℃ | [180, 250] |
| 链夹速度SP·ip16710z (`dw-168694e`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16710z | m/min | [40, 260] |
| 出口轨宽SP·ip16710z (`dw-e027775`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16710z | mm | [1800, 4200] |
| coronaPower·ip16710z (`dw-e2b1d96`) | DCW write | `http` | 双拉薄膜产线 biax-ip16710z | kW | [0.5, 8] |
| 收卷张力SP·ip16710z (`dw-2208733`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | N | [30, 180] |
| L1-DAQ-modbus-tcp ip16710z (`dn-9206fc6`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16710z | ℃ | [0, 400] |
| L2-DAQ-opcua ip16710z (`dn-81ef697`) | DAQ acquire | `opcua` | Integrated线2 ip16710z | MPa | [0, 45] |
| L3-DAQ-mqtt ip16710z (`dn-67ce6e5`) | DAQ acquire | `mqtt` | Integrated线3 ip16710z | μm | [0, 400] |
| L4-DAQ-http ip16710z (`dn-1d40c66`) | DAQ acquire | `http` | Integrated线4 ip16710z | μm | [0, 400] |
| L5-DAQ-modbus-rtu ip16710z(sat) (`dn-0eea79d`) | DAQ acquire | `modbus-rtu` | Integrated线4 ip16710z | 个/m² | [0, 500] |
| 熔体温度 ip16710zcl (`dn-e56d6b6`) | DAQ acquire | `modbus-tcp` | CastFilm线 ip16710zcl | ℃ | [0, 400] |
| 晶点计数 ip16710zcl (`dn-552d3de`) | DAQ acquire | `modbus-rtu` | CastFilm线 ip16710zcl | 个/m² | [0, 500] |
| MeltPressure ip16710zcl (`dn-c968846`) | DAQ acquire | `opcua` | CastFilm线 ip16710zcl | MPa | [0, 45] |
| thick ip16710zcl (`dn-a42a57a`) | DAQ acquire | `mqtt` | CastFilm线 ip16710zcl | μm | [0, 400] |
| defect ip16710zcl (`dn-f1b29ea`) | DAQ acquire | `http` | CastFilm线 ip16710zcl | % | [0, 100] |
| profile ip16710z (`dn-0f25d38`) | DAQ acquire | `http` | Integrated线1 ip16710z | mm | [0.4, 0.65] |
| ccd ip16710z (`dn-529ae1d`) | DAQ acquire | `http` | Integrated线1 ip16710z | 灰度 | [0, 255] |
| L1-DAQ-modbus-tcp ip16710zp8 (`dn-0e76f95`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16710zp8 | ℃ | [0, 260] |
| L2-DAQ-opcua ip16710zp8 (`dn-51815a4`) | DAQ acquire | `opcua` | Integrated线2 ip16710zp8 | ℃ | [0, 260] |
| L3-DAQ-mqtt ip16710zp8 (`dn-ad1f212`) | DAQ acquire | `mqtt` | Integrated线3 ip16710zp8 | ℃ | [0, 100] |
| L4-DAQ-modbus-rtu ip16710zp8(sat) (`dn-e40a226`) | DAQ acquire | `modbus-rtu` | Integrated线3 ip16710zp8 | ℃ | [0, 100] |
| L5-DAQ-http ip16710zp8(sat) (`dn-7217570`) | DAQ acquire | `http` | Integrated线3 ip16710zp8 | L/min | [0, 100] |
| 干燥塔温度·ip16710z (`dn-95aeb6d`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16710z | ℃ | [20, 220] |
| 切片残水·ip16710z (`dn-3512214`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16710z | ppm | [0, 120] |
| 熔体温度·ip16710z (`dn-01d2809`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [200, 330] |
| 泵前熔压·ip16710z (`dn-27ab3b4`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | MPa | [0, 35] |
| 泵出口压力·ip16710z (`dn-76fe71c`) | DAQ acquire | `modbus-rtu` | 双拉薄膜产线 biax-ip16710z | MPa | [0, 35] |
| 铸片辊面温度·ip16710z (`dn-8402903`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [0, 80] |
| 纵拉膜温·ip16710z (`dn-667fac9`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16710z | ℃ | [40, 160] |

_(showing first 40 DCW / 24 DAQ nodes; full inventory in `line-profile.json`)_

## Phase scorecard (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---:|---:|---:|---:|---:|---:|
| P0 | Bootstrap · simulator & platform | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P1 | Plant model + offline optimum W* | 2 | 0 | 0 | 0 | 100.0 | 1 |
| P2 | Multi-protocol line provisioning | 6 | 0 | 0 | 0 | 100.0 | 2 |
| P3 | DAQ · governed write · F5 interlock | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P4 | Agent-tool closed loop (3-cycle convergence) | 7 | 0 | 0 | 0 | 100.0 | 3 |
| P4b | Rollback & optimization records | 4 | 0 | 0 | 0 | 100.0 | 2 |
| P4c | HITL approval gate | 1 | 0 | 0 | 0 | 100.0 | 2 |
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
| **Overall** | | | | | | **99.2** | 37 |

## Closed-loop optimization · per-seed

| Seed | J0 | Jend | J* | J/J* % | Iters | Governed writes | Rejected | Converged |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 42 | 67.80 | 87.26 | 89.89 | 97.1 | 2 | 2 | 0 | yes |
| 43 | 68.91 | 87.24 | 89.89 | 97.0 | 2 | 2 | 0 | yes |
| 44 | 66.95 | 87.44 | 89.89 | 97.3 | 2 | 2 | 0 | yes |

## AgentTeam closed-loop tuning walkthrough

How an optimization team is assembled and drives the line, end to end: (1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; (2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); (3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; (4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; (5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.

### Biax (BOPET) multi-node mission — iteration trace

| Iter | Knob | Node | From → To | Thickness μm | Note |
|---|---|---|---|---:|---|
| 0 | — | `—` | — | 28.10 |  |
| 1.rebase | recipe-apply | `rc-4fae6969` | — | 0.08 |  |

Governed writes: **1** on 1 distinct knob(s) · optimization records: 1 · target window 25 ± 0.7 μm · final thickness reading **0.08 μm** · target attained: **no**.

### Deterministic closed-loop benchmark — seed 42 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.62 | 0.167 | 18.53 | 205.5 | 150 | 95.0 | 200.0 | 67.80 | 0 |
| 1 | 48.98 | 0.467 | 16.45 | 202.7 | 135 | 95.0 | 200.0 | 87.55 | 24.147 |
| 2 | 49.45 | 0.600 | 16.75 | 201.2 | 138 | 95.0 | 200.0 | 86.97 | 36.212 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.1 %**; governed writes 2 (rejected 0), optimization records 2.

### Deterministic closed-loop benchmark — seed 43 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.37 | 0.250 | 18.60 | 206.6 | 150 | 95.0 | 200.0 | 68.91 | 0 |
| 1 | 49.57 | 0.417 | 16.45 | 202.6 | 135 | 95.0 | 200.0 | 87.71 | 24.094 |
| 2 | 49.17 | 0.700 | 16.48 | 201.2 | 136 | 95.0 | 200.0 | 86.77 | 36.144 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.0 %**; governed writes 2 (rejected 0), optimization records 2.

### Deterministic closed-loop benchmark — seed 44 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.67 | 0.350 | 18.62 | 207.1 | 150 | 95.0 | 200.0 | 66.95 | 0 |
| 1 | 49.08 | 0.400 | 16.47 | 202.9 | 135 | 95.0 | 200.0 | 87.76 | 24.089 |
| 2 | 50.00 | 0.550 | 16.75 | 201.1 | 138 | 95.0 | 200.0 | 87.13 | 36.155 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.3 %**; governed writes 2 (rejected 0), optimization records 2.

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `agentteam-mission.log` | 1.0 KB | AgentTeam optimization mission — full task-board trajectory |
| `agentteam-biax.log` | 1.3 KB | AgentTeam biax multi-node mission — full trajectory |
| `line-profile.json` | 25.9 KB | Simulated line profile — devices, protocols, endpoints, SP/PV signal inventory, AW node mapping |
| `metrics.csv` | 2.8 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 89.9 KB | Full machine-readable results (checks, phases, evidence, KPIs, line profile, agent-team traces) |
| `summary.json` | 15.2 KB | Verdict + KPI + per-line summary (compare/aggregate input) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✔ **platform-reachable** (pass) — platform reachable & authenticated
  - 平台 http://127.0.0.1:3320：自动分离启动 pid=57204（日志 D:\codes\ABO\aw-bench-platform.log）
  - 鉴权 OK (register-first-admin)
  - simulator http://127.0.0.1:4010：already up (reused)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass) — 预设 cast-film-physics 已应用
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **offline-optimum** (pass) — offline optimum W* (ground truth) available
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-19T18:33:27.524Z"}

### P10 — Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)

- ✔ **biax-ensure** (pass) — 节点探测补建(9 建缺失 / 0 修复 / 0 原样)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass) — 五协议多节点建线(DCW 30 + DAQ 19,驱动实测 9/9)
  - line=ln-11b5c2ec recipe=rc-4fae6969 started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass) — 测厚仪真实链路采样(1 点)
  - daq=dn-dbc35129 · samples=1
- ✔ **biax-agent-cards** (pass) — Agent 语义卡含双拉工艺描述(semantics 贯通)
  - 语义卡长度 22553 · 关键词命中 铸片辊速度/横向拉伸比/收卷张力
  - sample: #### ◆ L1-DCW-modbus-tcp ip16710z [id=dw-cf45353c] - 物理量: 烘箱温度设定,单位 ℃,精度 1 位小数 - 工艺语义: 模拟器设备「挤出主机PLC(Modbus TCP)」的 加热区1SP（真实 modbus-tcp 写控） - 安全量程: [120, 260] ℃
- ✔ **biax-mission-board** (pass) — 任务板:双拉优化任务下达并由 lead 派发
  - parent task + lead child: ✔
- ▲ **biax-mission-multinode** (warn) — 多节点受治理写(1 个执行节点 / 1 写)
  - 1. task board: channel=5b794eb3-9fe0-4b31-ab5b-b54e2d77b9f3 parent=1cfd4965-e889-486f-823c-eb14d52574ad leadChild=e67c8927-13eb-41f4-941c-2fe3743300f3
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.1,3.5,1.6]
  - 3. initial thickness=28.10 μm(目标 25±0.7)
  - iter1: 检出断膜量级读数(-0.08μm << 目标 25μm)——暂停纠偏,重下配方基线恢复
- ▲ **biax-mission-attained** (warn) — 厚度目标达成(|PV−25.0|≤0.7μm,final=0.08)
  - writes=1/6 · distinctKnobs=1 · final=0.08μm
  - iter1: 基线恢复失败,如实终止(植物侧流量/拉伸异常,非治理写路径或任务数学缺陷)
  - 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(1 条,含参数/判定/窗口): - opt-b3ad2d57 [superseded] 铸片辊速度SP·ip16710z: 32 → 33.8,设定 02:38:52,判定 未判定,关闭于 02:39:52(superseded)
  - 5. outcome: writes=1 distinctKnobs=1 final=0.08μm attained=false
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
  - line=ln-c2be42f0 daq=dn-9206fc6b dcw=dw-cf45353c recipe=rc-dbc9de98
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 31.329999923706055
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass) — Line2 [opcua] 供给
  - line=ln-65afa412 daq=dn-81ef6977 dcw=dw-a3eea077 recipe=rc-c695bcf6
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 6.783
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass) — Line3 [mqtt] 供给
  - line=ln-1ad7adee daq=dn-67ce6e5f dcw=dw-9ea4fab9 recipe=rc-cb4ae317
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,收到 aw/sim/thick = 21.9
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass) — Line4 [http] 供给
  - line=ln-4259a4ca daq=dn-1d40c667 dcw=dw-a25b5712 recipe=rc-c5522170
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 99.849
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass) — Line5 [modbus-rtu] 供给（satellite DAQ）
  - line=ln-4259a4ca daq=dn-0eea79df dcw=✘ recipe=rc-c5522170 ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 5
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ · governed write · F5 interlock

- ✔ **line-1-io** (pass) — Line1 [modbus-tcp] integration check
  - ✔ DAQ samples stored 11  points (modbus-tcp real driver）
  - ✔ 约6写 p50=47.322ms p95=47.439ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass) — Line2 [opcua] integration check
  - ✔ DAQ samples stored 11  points (opcua real driver）
  - ✔ 约6写 p50=19.521ms p95=19.748ms，readback deviation 0.4
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass) — Line3 [mqtt] integration check
  - ✔ DAQ samples stored 12  points (mqtt real driver）
  - ✔ 约6写 p50=19.105ms p95=19.636ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass) — Line4 [http] integration check
  - ✔ DAQ samples stored 12  points (http real driver）
  - ✔ 约6写 p50=32.239ms p95=32.58ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass) — Line5 [modbus-rtu] integration check
  - ✔ DAQ samples stored 14  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass) — 闭环夹具（channel+agent）
  - channel=8e07f83a-1e1d-46bb-9f16-afae540850c0
  - agent=06818cbf-905f-459c-b7f4-a3881ec00819
  - harness=opencode
- ✔ **tool-bridge** (pass) — opencode 的 host 工具直调面可用
  - 探测 my_industrial_nodes → 你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。
- ✔ **line-1-loop** (pass) — Line1 [modbus-tcp] Agent 闭环收敛（3/3 轮）
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔ · judge ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔ · judge ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.435s
- ✔ **line-2-loop** (pass) — Line2 [opcua] Agent 闭环收敛（3/3 轮）
  - iter1: SP→144.6 ✔ · 回读 145 ✔ · daq ✔ · judge ✔
  - iter2: SP→147.3 ✔ · 回读 147 ✔ · daq ✔ · judge ✔
  - iter3: SP→150 ✔ · 回读 150 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.376s
- ✔ **line-3-loop** (pass) — Line3 [mqtt] Agent 闭环收敛（3/3 轮）
  - iter1: SP→91.4 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→93.2 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→95 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.301s
- ✔ **line-4-loop** (pass) — Line4 [http] Agent 闭环收敛（3/3 轮）
  - iter1: SP→0.946 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→0.973 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→1 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.329s
- ✔ **plant-response** (pass) — 工艺模型响应（SP→plant truth 随动）
  - 真值样本 6 → 77
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":231,"defect":4.27}

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass) — Line1 优化记录生命周期
  - current 204.6999969482422 → record A writes 208.06 (up)，记录 B writes 201.34 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-31a0e504 verdict keep → 判定已入册:记录 opt-31a0e504 → keep(bench: 回读一致，判定 keep)。已定档为已验证经验(配方已标记 last
  - ✔ (rollback path) record opt-70cdef24 verdict rollback (recorded only; PLC still 201.3000030517578)
  - ✔ rollback executed (status 200) → readback 208.10000610351562 (expected record B from=208.06)
- ✔ **line-1-rbjudge** (pass) — Line1 撤销记录 opt-7c24aedd 判定关闭
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass) — Line1 node-level single-step rollback (undo stack)
  - ✔ write 205.04 effective (readback 205, before 208.10000610351562)
  - ✔ journal rollback 受理（status 200，记录 opt-7c24aedd）
  - ✔ readback after rollback 208.10000610351562 (expected back to 208.10000610351562, tolerance 0.75)
- ✔ **param-ledger** (pass) — 参数台账（三值对照 + 在册历史）
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ✔ **line-2-hitl** (pass) — Line2 HITL 审批闭环
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-2a07067c（detail: L2-DCW-opcua ip16710z(烘箱温度设定)设定 148.2rpm,有效写入区间 141~159rpm(节点安全量程 ∩ 配方）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 下发成功:L2-DCW-opcua ip16710z(烘箱温度设定)设定 148.2rpm → PLC 原始值 148.2;回读 148.2rpm一致。当前活动配方「Integra
  - ✔ post-approval PLC effect: readback 148 (expected 148.2)
  - 审批裁决时延 17 ms（挂起→批准，含轮询周期）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass) — 治理只读面
  - ✔ 参数变更账本 journal：本产线 11  anchors (source coverage  rollback/manual/agent/recipe）
  - ✔ audit: 87 entries
  - ✔ ops-logs: 87 entries
  - ✔ 报警记录：全局 4 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass) — Line1 [modbus-tcp] recipe lifecycle
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-83c3f4ef → lastGood=rr-83c3f4ef
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass) — Line2 [opcua] recipe lifecycle
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-ae74fecb → lastGood=rr-ae74fecb
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ✔ **param-facade** (pass) — Line2 [opcua] 参数面自动生成且无寄存器泄漏
  - param=pp-3d1a5e68 key=temp-sp unit=rpm
  - 含 register/dataType/driverConfig? 无 ✔
- ✔ **param-limits** (pass) — Line2 基准限界 [143.7,156.3] + 产品限界 [146.22,153.78] 设定
  - 有效交集(含配方窗) 141~159 → param 143.7~156.3 → product 146.22~153.78 · node 层 50~200（四层收窄：node ∩ param ∩ product ∩ recipe）
- ✔ **param-write-governed** (pass) — Line2 参数面写入联锁（交集内写入 · 越产品层拦截 · 越基准层拦截 · 参数读回）
  - 148.866 → ✔ 写入+回读
  - 155.04 → ✔ 产品层拦截
  - 157.65 → ✔ 基准限界层拦截
  - param read → ✔ 149rpm
- ✔ **agent-param-tools** (pass) — Line2 Agent param_control/param_read（语义写 · 越产品层拒 · 参数读 · 未绑定拒）
  - param_control 151.39 → ✔ record=opt-bd17c823
  - param_control 155.04 → ✔ 产品层拦截
  - param_read → ✔
  - unbound agent → ✔ 权限面拒绝

### P4m — AgentTeam optimization mission (task board → governed writes → attainment)

- ✔ **mission-board** (pass) — 任务板：优化任务下达并由 lead 派发
  - channel=7d9d6fda-552b-4f0a-9d2f-19c97ef5d9fa parent=f626c5eb-0d60-455f-8be2-d28e0540a424 leadChild=1f81e67c-4f25-4a2e-949f-c04fd3d0785d assignee=63aa1081-0167-47e0-bdb3-4a126a4f0a20
- ✔ **mission-timescale-read** (pass) — 时段数据读取（daq_query from/to/bucket）
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip16710z(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 alarm,时间窗 2026-09-20T02:29 ~ 2026-09-20T02:34(降采样 1000ms)   样本 
- ✔ **mission-governed-write** (pass) — 受治理参数下发（1 写全开记录+判定）
  - iter1: SP→204.704 ✔ · record=opened+judged · PV≈204.7 ✔
- ✔ **mission-journal** (pass) — 参数账本归因（Agent source 可追溯）
  - journal sample: 优化记录(4 条,含参数/判定/窗口): - opt-f85efef0 [judged-keep] L1-DCW-modbus-tcp ip16710z: 200 → 204.704,设定 02:34:03,判定 keep(agent:mission iter 1: PV=204.7 target=
- ✔ **mission-attained** (pass) — 优化目标达成（|PV−204.704|≤0.75）
  - writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass) — 任务收口（lead 派发→worker 剧本完成→父任务聚合）
  - terminalState=COMPLETED · writes=1 · reached=true

### P6 — Closed-loop optimization benchmark (multi-seed)

- ✔ **twin-nodes** (pass) — cast-film twin node provisioning（执行器 + 传感器）
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass) — 离线最优 W*（ground truth）
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-19T18:33:27.524Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ✔ **seed-42** (pass) — seed=42 闭环优化（J/J*=0.971）
  - 预热 3.035s（熔体温度 203.8℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.62μm defect=0.167% P=18.53MPa T=205.5℃ N=150 v=95.0 → J=67.80
  - iter1 下发 N=135 v=95 z=200 → h=48.98μm defect=0.467% P=16.45MPa T=202.7℃ → J=87.55 
  - iter2 下发 N=138 v=95 z=200 → h=49.45μm defect=0.600% P=16.75MPa T=201.2℃ → J=86.97 
- ✔ **seed-43** (pass) — seed=43 闭环优化（J/J*=0.97）
  - 预热 0.003s（熔体温度 201℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.37μm defect=0.250% P=18.60MPa T=206.6℃ N=150 v=95.0 → J=68.91
  - iter1 下发 N=135 v=95 z=200 → h=49.57μm defect=0.417% P=16.45MPa T=202.6℃ → J=87.71 
  - iter2 下发 N=136 v=95 z=200 → h=49.17μm defect=0.700% P=16.48MPa T=201.2℃ → J=86.77 
- ✔ **seed-44** (pass) — seed=44 闭环优化（J/J*=0.973）
  - 预热 0.018s（熔体温度 200.96℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.67μm defect=0.350% P=18.62MPa T=207.1℃ N=150 v=95.0 → J=66.95
  - iter1 下发 N=135 v=95 z=200 → h=49.08μm defect=0.400% P=16.47MPa T=202.9℃ → J=87.76 
  - iter2 下发 N=138 v=95 z=200 → h=50.00μm defect=0.550% P=16.75MPa T=201.1℃ → J=87.13 
- ✔ **closedloop-aggregate** (pass) — 闭环优化聚合（n=3）
  - J/J*：min 0.97 · mean 0.971 · max 0.973（J* = 89.894）
  - J start均值 67.885 → end均值 87.314
  - 平均迭代 2  · 总写 6 · 越界rejected 0 · 收敛 3/3 · 平均墙钟 36.17s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass) — 多形态数采（向量/图像帧）
  - ✔ 向量轮廓帧 5 （46.431,46.488,47.311,46.823,47.74,47.525,48.408,47.85,48.458,47.519,48.9,48.323,48.38,49.242,48.298,48.327,48.586,48.749,49.079,48.984,49.084,49.351,49.18,49.912,49.702,49.464,49.82,49.308,49.663,49.859,49.23,49.629,49.821,49.279
  - ✔ 图像帧 5 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass) — second plant scenario applied: film-line
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] provisioned
  - line=ln-e5d30698 daq=dn-0e76f959 dcw=dw-1b2a0787
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass) — scenario[film-line] line 2 [opcua] provisioned
  - line=ln-b504db62 daq=dn-51815a4e dcw=dw-8b578280
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass) — scenario[film-line] line 3 [mqtt] provisioned
  - line=ln-4c5dab8b daq=dn-ad1f212b dcw=dw-f4dddccf
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass) — scenario[film-line] line 4 [modbus-rtu] provisioned (satellite DAQ)
  - line=ln-4c5dab8b daq=dn-e40a226e dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass) — scenario[film-line] line 5 [http] provisioned (satellite DAQ)
  - line=ln-4c5dab8b daq=dn-72175706 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **port-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] integration
  - ✔ DAQ samples 12 pts (modbus-tcp real driver)
  - ✔ governed write 186.24 → HTTP 200
  - readback deviation 0.04
  - ✔ F5 out-of-window 3/3 rejected · legal write accepted (0 false block)
- ✔ **port-2-opcua** (pass) — scenario[film-line] line 2 [opcua] integration
  - ✔ DAQ samples 11 pts (opcua real driver)
  - ✔ governed write 186.24 → HTTP 200
  - readback deviation 0
  - ✔ F5 out-of-window 3/3 rejected · legal write accepted (0 false block)
- ✔ **port-3-mqtt** (pass) — scenario[film-line] line 3 [mqtt] integration
  - ✔ DAQ samples 11 pts (mqtt real driver)
  - ✔ governed write 62.4 → HTTP 200
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
- ✔ **open-record** (pass) — 优化记录 opt-c887b169 已开（基线 186.1999969482422 → 176.88，auto 策略）
  - 下发成功:L1-DCW-modbus-tcp ip16710zp8(烘箱温度设定)设定 176.88℃ → PLC 原始值 176.88;回读 176.89999389648438℃一致。当前活动配方「Integrated工艺1 ip16710zp8」。写入并回读一致:176.8
- ✔ **freeze** (pass) — DAQ temp-pv 已冻结至 150（窗外，窗 [164.4, 195.6]）
  - device=dev-4f5a11dd signal=temp-pv
- ✔ **backstop-verdict** (pass) — 系统兜底判定回退 + 自动恢复基线
  - 判定 by=system verdict=rollback · 时延 130.151s（环境类，节拍决定）
  - PLC 值 186.1999969482422 → 期望基线 186.1999969482422（±0.75） ✔
- ✔ **restore** (pass) — 过程量解冻 + 第一场景恢复: cast-film-physics
  - rig left as found

### P9 — Platform subsystems (team / memory / registry)

- ✔ **team-dispatch** (pass) — 团队调度（lead 派发 → worker 完成）
  - 终态 COMPLETED · assignee=ef5435b2-34bd-4676-839c-0720eadafc14（lead 认领父任务） · 子任务派发给 worker: ✔
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
| loop | tool_loops_ok | 4 |  lines | 工具级闭环达成 |
| loop | mission_writes | 1 |  | AgentTeam 优化任务受治理写次数 |
| loop | mission_attained | 1 |  | AgentTeam 优化任务达标 |
| gov | record_keep_rollback_ok | 1 |  | 优化记录判定/执行分离 |
| hitl | approval_latency_ms | 17 | ms | 挂起→批准（含 800ms 轮询粒度） |
| audit | journal_anchors | 11 |  | 本Line参数变更账本 |
| audit | audit_entries | 87 |  | 全局审计目 |
| audit | ops_logs | 87 |  | 全局运维日志 |
| recipe | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| gov | param_layer_checks_ok | 4 | /4 | 工艺参数映射层全链 |
| closedloop | J_over_Jstar_mean | 0.971 |  | n=3 seeds，写路径=governed |
| closedloop | J_over_Jstar_min | 0.97 |  | 最差 seed（保守下界） |
| closedloop | J_end_mean | 87.314 |  | J* = 89.894 |
| closedloop | cl_iters_mean | 2 |  | 闭环收敛迭代数 |
| closedloop | cl_writes_total | 6 |  | 受治理的闭环写总数 |
| closedloop | cl_rejected_total | 0 |  | 越界被拒（治理拦截） |
| daq | vector_frames | 5 |  | 厚度横向轮廓 |
| daq | image_frames | 5 |  | CCD 表面图像 |
| portability | scenario2_lines | 3 |  | second preset "film-line" (config-only) |
| portability | scenario2_intercept_rate | 1 |  | F5 out-of-window interception on second scenario |
| portability | scenario2_false_blocks | 0 |  | legal in-window writes blocked on second scenario |
| gov | backstop_fired | 1 |  | system-judged rollback on window breach |
| gov | backstop_restored | 1 |  | auto-restore to record baseline |
| gov | backstop_latency_s | 130.151 | s | freeze → verdict (environmental) |
| biax | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| biax | sp_signals | 30 |  | 可写工艺 SP |
| biax | created_missing | 9 |  | 本次补建的缺失设备数 |
| biax | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| biax | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| biax | mission_writes | 1 |  | AgentTeam 双拉任务受治理写次数 |
| biax | mission_distinct_knobs | 1 |  | 参与闭环的执行节点数 |
| biax | mission_attained | 0 |  | 厚度达标 25.0±0.7μm |
| biax | mission_final_thickness | 0.08 | μm | 终态厚度 |
| team | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| memory | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| agent | harness_registry | 14 |  | environment-available 14 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict PASS, grade A). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._
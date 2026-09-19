# AW-IndustrialBench · Integrated Pipeline Report

> **PASS** — score **99.2**/100, grade **A**. Hard gate green: no failed checks or phases; skips are honest environmental exclusions.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20260919184400-1a8s` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `d481d7cf1177b1e6` (sha256 over 9 checker sources) |
| Git commit | `e96c25d` |
| Runtime | v24.19.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3320 · http://127.0.0.1:4010 |
| Tool harness | opencode (deterministic) · LLM agent: (none) |
| Reproduce | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 59 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 29.465 ms | incl. real protocol transactions |
| Closed-loop J/J* | 97.1 % | n=3 seeds · worst 97.0% · J*=89.894 |
| Tool-level loops | 4 | dcw→daq→judge ×3 convergence |
| Param-layer governance | 4/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | fired+restored | window breach → auto-rollback in 130.16s (env) |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 1 knobs · 1 writes → 0.12μm |
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
| L1-DCW-modbus-tcp ip16kove (`dw-f288a07`) | DCW write | `modbus-tcp` | Integrated线1 ip16kove | ℃ | [120, 260] |
| L2-DCW-opcua ip16kove (`dw-91b7aca`) | DCW write | `opcua` | Integrated线2 ip16kove | rpm | [50, 200] |
| L3-DCW-mqtt ip16kove (`dw-14fb53a`) | DCW write | `mqtt` | Integrated线3 ip16kove | m/min | [20, 120] |
| L4-DCW-http ip16kove (`dw-91c2487`) | DCW write | `http` | Integrated线4 ip16kove | mm | [0.5, 2] |
| 加热区1SP ip16kovecl (`dw-216237a`) | DCW write | `modbus-tcp` | CastFilm线 ip16kovecl | ℃ | [120, 260] |
| 加热区2SP ip16kovecl (`dw-32bbfdd`) | DCW write | `modbus-tcp` | CastFilm线 ip16kovecl | ℃ | [120, 260] |
| 加热区3SP ip16kovecl (`dw-4273f44`) | DCW write | `modbus-tcp` | CastFilm线 ip16kovecl | ℃ | [120, 260] |
| ScrewSpeedSP ip16kovecl (`dw-f23e01a`) | DCW write | `opcua` | CastFilm线 ip16kovecl | rpm | [50, 200] |
| lineSpeedSP ip16kovecl (`dw-f0658f9`) | DCW write | `mqtt` | CastFilm线 ip16kovecl | m/min | [20, 120] |
| dieGapSP ip16kovecl (`dw-2e17e09`) | DCW write | `http` | CastFilm线 ip16kovecl | mm | [0.5, 2] |
| L1-DCW-modbus-tcp ip16kovep8 (`dw-1856f2b`) | DCW write | `modbus-tcp` | Integrated线1 ip16kovep8 | ℃ | [0, 260] |
| L2-DCW-opcua ip16kovep8 (`dw-a8c20d1`) | DCW write | `opcua` | Integrated线2 ip16kovep8 | ℃ | [0, 260] |
| L3-DCW-mqtt ip16kovep8 (`dw-7684060`) | DCW write | `mqtt` | Integrated线3 ip16kovep8 | ℃ | [0, 100] |
| 干燥温度SP·ip16kove (`dw-4e68b5f`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16kove | ℃ | [120, 200] |
| 露点SP·ip16kove (`dw-62a23a6`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16kove | ℃ | [-80, -20] |
| 喂料速率SP·ip16kove (`dw-228fed0`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16kove | kg/h | [100, 1200] |
| 机筒温度区1SP·ip16kove (`dw-e31872d`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [220, 300] |
| 机筒温度区2SP·ip16kove (`dw-b57ee42`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [220, 300] |
| 机筒温度区3SP·ip16kove (`dw-72923e8`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [220, 300] |
| 机筒温度区4SP·ip16kove (`dw-c5da3be`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [220, 300] |
| 机筒温度区5SP·ip16kove (`dw-64a4eec`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [220, 300] |
| 螺杆转速SP·ip16kove (`dw-f752c66`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | rpm | [20, 100] |
| 计量泵转速SP·ip16kove (`dw-c3286df`) | DCW write | `modbus-rtu` | 双拉薄膜产线 biax-ip16kove | rpm | [15, 60] |
| 模唇温度SP·ip16kove (`dw-b4e3671`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [250, 300] |
| 急冷辊温度SP·ip16kove (`dw-c07384f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [10, 60] |
| 铸片辊速度SP·ip16kove (`dw-9d2e3ed`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | m/min | [10, 60] |
| 静电吸附电压SP·ip16kove (`dw-ca89db2`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | kV | [4, 12] |
| 预热辊1温度SP·ip16kove (`dw-9b48ca1`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [70, 140] |
| 预热辊2温度SP·ip16kove (`dw-a0dd3e2`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [70, 140] |
| 预热辊3温度SP·ip16kove (`dw-21fc1e9`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [70, 140] |
| 慢辊线速度SP·ip16kove (`dw-1ef36b5`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | m/min | [10, 80] |
| 快辊线速度SP·ip16kove (`dw-249323f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | m/min | [30, 260] |
| 纵拉退火辊SP·ip16kove (`dw-5165b6d`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [90, 170] |
| TDO预热段SP·ip16kove (`dw-ac42f8d`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16kove | ℃ | [80, 140] |
| TDO拉伸段SP·ip16kove (`dw-1f90e90`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16kove | ℃ | [90, 150] |
| TDO定型段SP·ip16kove (`dw-7be25e0`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16kove | ℃ | [180, 250] |
| 链夹速度SP·ip16kove (`dw-1e7fe20`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16kove | m/min | [40, 260] |
| 出口轨宽SP·ip16kove (`dw-00793b8`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16kove | mm | [1800, 4200] |
| coronaPower·ip16kove (`dw-d5c81c4`) | DCW write | `http` | 双拉薄膜产线 biax-ip16kove | kW | [0.5, 8] |
| 收卷张力SP·ip16kove (`dw-5851a7f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | N | [30, 180] |
| L1-DAQ-modbus-tcp ip16kove (`dn-98637c7`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16kove | ℃ | [0, 400] |
| L2-DAQ-opcua ip16kove (`dn-eda4553`) | DAQ acquire | `opcua` | Integrated线2 ip16kove | MPa | [0, 45] |
| L3-DAQ-mqtt ip16kove (`dn-49ec5ee`) | DAQ acquire | `mqtt` | Integrated线3 ip16kove | μm | [0, 400] |
| L4-DAQ-http ip16kove (`dn-88aadb3`) | DAQ acquire | `http` | Integrated线4 ip16kove | μm | [0, 400] |
| L5-DAQ-modbus-rtu ip16kove(sat) (`dn-53ea4d7`) | DAQ acquire | `modbus-rtu` | Integrated线4 ip16kove | 个/m² | [0, 500] |
| 熔体温度 ip16kovecl (`dn-783787f`) | DAQ acquire | `modbus-tcp` | CastFilm线 ip16kovecl | ℃ | [0, 400] |
| 晶点计数 ip16kovecl (`dn-71d4257`) | DAQ acquire | `modbus-rtu` | CastFilm线 ip16kovecl | 个/m² | [0, 500] |
| MeltPressure ip16kovecl (`dn-980cb10`) | DAQ acquire | `opcua` | CastFilm线 ip16kovecl | MPa | [0, 45] |
| thick ip16kovecl (`dn-e957296`) | DAQ acquire | `mqtt` | CastFilm线 ip16kovecl | μm | [0, 400] |
| defect ip16kovecl (`dn-652e88e`) | DAQ acquire | `http` | CastFilm线 ip16kovecl | % | [0, 100] |
| profile ip16kove (`dn-32e37d8`) | DAQ acquire | `http` | Integrated线1 ip16kove | mm | [0.4, 0.65] |
| ccd ip16kove (`dn-c0b2ce8`) | DAQ acquire | `http` | Integrated线1 ip16kove | 灰度 | [0, 255] |
| L1-DAQ-modbus-tcp ip16kovep8 (`dn-97911ea`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16kovep8 | ℃ | [0, 260] |
| L2-DAQ-opcua ip16kovep8 (`dn-8ef0fc7`) | DAQ acquire | `opcua` | Integrated线2 ip16kovep8 | ℃ | [0, 260] |
| L3-DAQ-mqtt ip16kovep8 (`dn-8917a8a`) | DAQ acquire | `mqtt` | Integrated线3 ip16kovep8 | ℃ | [0, 100] |
| L4-DAQ-modbus-rtu ip16kovep8(sat) (`dn-9331f69`) | DAQ acquire | `modbus-rtu` | Integrated线3 ip16kovep8 | ℃ | [0, 100] |
| L5-DAQ-http ip16kovep8(sat) (`dn-3aaef73`) | DAQ acquire | `http` | Integrated线3 ip16kovep8 | L/min | [0, 100] |
| 干燥塔温度·ip16kove (`dn-532a241`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16kove | ℃ | [20, 220] |
| 切片残水·ip16kove (`dn-4c68f6a`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16kove | ppm | [0, 120] |
| 熔体温度·ip16kove (`dn-0d18c25`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [200, 330] |
| 泵前熔压·ip16kove (`dn-152d60a`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | MPa | [0, 35] |
| 泵出口压力·ip16kove (`dn-821fdfd`) | DAQ acquire | `modbus-rtu` | 双拉薄膜产线 biax-ip16kove | MPa | [0, 35] |
| 铸片辊面温度·ip16kove (`dn-d907d85`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [0, 80] |
| 纵拉膜温·ip16kove (`dn-f60d1d2`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16kove | ℃ | [40, 160] |

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
| 43 | 68.91 | 87.29 | 89.89 | 97.1 | 2 | 2 | 0 | yes |
| 44 | 67.05 | 87.21 | 89.89 | 97.0 | 2 | 2 | 0 | yes |

## AgentTeam closed-loop tuning walkthrough

How an optimization team is assembled and drives the line, end to end: (1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; (2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); (3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; (4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; (5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.

### Biax (BOPET) multi-node mission — iteration trace

| Iter | Knob | Node | From → To | Thickness μm | Note |
|---|---|---|---|---:|---|
| 0 | — | `—` | — | 28.10 |  |
| 1.rebase | recipe-apply | `rc-f5cb18cd` | — | 0.12 |  |

Governed writes: **1** on 1 distinct knob(s) · optimization records: 1 · target window 25 ± 0.7 μm · final thickness reading **0.12 μm** · target attained: **no**.

### Deterministic closed-loop benchmark — seed 42 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.62 | 0.167 | 18.53 | 205.5 | 150 | 95.0 | 200.0 | 67.80 | 0 |
| 1 | 48.98 | 0.467 | 16.43 | 202.5 | 135 | 95.0 | 200.0 | 87.55 | 24.114 |
| 2 | 49.70 | 0.600 | 16.73 | 201.2 | 138 | 95.0 | 200.0 | 86.97 | 36.173 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.1 %**; governed writes 2 (rejected 0), optimization records 2.

### Deterministic closed-loop benchmark — seed 43 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.37 | 0.250 | 18.60 | 206.6 | 150 | 95.0 | 200.0 | 68.91 | 0 |
| 1 | 49.57 | 0.417 | 16.45 | 202.8 | 135 | 95.0 | 200.0 | 87.71 | 24.114 |
| 2 | 49.37 | 0.667 | 16.50 | 201.2 | 136 | 95.0 | 200.0 | 86.87 | 36.179 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.1 %**; governed writes 2 (rejected 0), optimization records 2.

### Deterministic closed-loop benchmark — seed 44 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.67 | 0.317 | 18.62 | 207.1 | 150 | 95.0 | 200.0 | 67.05 | 0 |
| 1 | 49.37 | 0.400 | 16.47 | 203.1 | 135 | 95.0 | 200.0 | 87.76 | 24.1 |
| 2 | 49.50 | 0.717 | 16.67 | 201.4 | 137 | 95.0 | 200.0 | 86.66 | 36.166 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.0 %**; governed writes 2 (rejected 0), optimization records 2.

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `agentteam-mission.log` | 1.0 KB | AgentTeam optimization mission — full task-board trajectory |
| `agentteam-biax.log` | 1.3 KB | AgentTeam biax multi-node mission — full trajectory |
| `line-profile.json` | 25.9 KB | Simulated line profile — devices, protocols, endpoints, SP/PV signal inventory, AW node mapping |
| `metrics.csv` | 2.8 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 90.1 KB | Full machine-readable results (checks, phases, evidence, KPIs, line profile, agent-team traces) |
| `summary.json` | 15.3 KB | Verdict + KPI + per-line summary (compare/aggregate input) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✔ **platform-reachable** (pass) — platform reachable & authenticated
  - 平台 http://127.0.0.1:3320：自动分离启动 pid=52488（日志 D:\codes\ABO\aw-bench-platform.log）
  - 鉴权 OK (register-first-admin)
  - simulator http://127.0.0.1:4010：already up (reused)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass) — 预设 cast-film-physics 已应用
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **offline-optimum** (pass) — offline optimum W* (ground truth) available
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-19T18:44:04.952Z"}

### P10 — Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)

- ✔ **biax-ensure** (pass) — 节点探测补建(9 建缺失 / 0 修复 / 0 原样)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass) — 五协议多节点建线(DCW 30 + DAQ 19,驱动实测 9/9)
  - line=ln-ab68957d recipe=rc-f5cb18cd started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass) — 测厚仪真实链路采样(1 点)
  - daq=dn-39ec4a85 · samples=1
- ✔ **biax-agent-cards** (pass) — Agent 语义卡含双拉工艺描述(semantics 贯通)
  - 语义卡长度 22553 · 关键词命中 铸片辊速度/横向拉伸比/收卷张力
  - sample: #### ◆ L1-DCW-modbus-tcp ip16kove [id=dw-f288a07b] - 物理量: 烘箱温度设定,单位 ℃,精度 1 位小数 - 工艺语义: 模拟器设备「挤出主机PLC(Modbus TCP)」的 加热区1SP（真实 modbus-tcp 写控） - 安全量程: [120, 260] ℃
- ✔ **biax-mission-board** (pass) — 任务板:双拉优化任务下达并由 lead 派发
  - parent task + lead child: ✔
- ▲ **biax-mission-multinode** (warn) — 多节点受治理写(1 个执行节点 / 1 写)
  - 1. task board: channel=db4bf8bd-eda3-4732-91d0-cdc60f4a5bd9 parent=6e9733fb-aa21-445b-927a-ad75872538a2 leadChild=bbd60cbd-193b-448b-a758-2593f415b376
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.1,3.5,1.6]
  - 3. initial thickness=28.10 μm(目标 25±0.7)
  - iter1: 检出断膜量级读数(0.00μm << 目标 25μm)——暂停纠偏,重下配方基线恢复
- ▲ **biax-mission-attained** (warn) — 厚度目标达成(|PV−25.0|≤0.7μm,final=0.12)
  - writes=1/6 · distinctKnobs=1 · final=0.12μm
  - iter1: 基线恢复失败,如实终止(植物侧流量/拉伸异常,非治理写路径或任务数学缺陷)
  - 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(1 条,含参数/判定/窗口): - opt-bccca041 [superseded] 铸片辊速度SP·ip16kove: 32 → 33.8,设定 02:49:29,判定 未判定,关闭于 02:50:30(superseded)
  - 5. outcome: writes=1 distinctKnobs=1 final=0.12μm attained=false
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
  - line=ln-b8eb3df1 daq=dn-98637c7c dcw=dw-f288a07b recipe=rc-aca66231
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 31.329999923706055
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass) — Line2 [opcua] 供给
  - line=ln-b1554145 daq=dn-eda45530 dcw=dw-91b7aca6 recipe=rc-effece71
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 6.783
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass) — Line3 [mqtt] 供给
  - line=ln-c6c3309a daq=dn-49ec5eef dcw=dw-14fb53a3 recipe=rc-5e4f864f
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,收到 aw/sim/thick = 21.9
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass) — Line4 [http] 供给
  - line=ln-e72f3dae daq=dn-88aadb30 dcw=dw-91c24879 recipe=rc-437d0e5e
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 99.849
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass) — Line5 [modbus-rtu] 供给（satellite DAQ）
  - line=ln-e72f3dae daq=dn-53ea4d71 dcw=✘ recipe=rc-437d0e5e ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 5
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ · governed write · F5 interlock

- ✔ **line-1-io** (pass) — Line1 [modbus-tcp] integration check
  - ✔ DAQ samples stored 11  points (modbus-tcp real driver）
  - ✔ 约6写 p50=47.005ms p95=47.383ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass) — Line2 [opcua] integration check
  - ✔ DAQ samples stored 10  points (opcua real driver）
  - ✔ 约6写 p50=19.024ms p95=20.595ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass) — Line3 [mqtt] integration check
  - ✔ DAQ samples stored 11  points (mqtt real driver）
  - ✔ 约6写 p50=19.174ms p95=19.628ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass) — Line4 [http] integration check
  - ✔ DAQ samples stored 13  points (http real driver）
  - ✔ 约6写 p50=32.659ms p95=33.263ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass) — Line5 [modbus-rtu] integration check
  - ✔ DAQ samples stored 14  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass) — 闭环夹具（channel+agent）
  - channel=9b42e85f-da86-4939-8c54-02de3f57d3fb
  - agent=be4b7d75-3fab-40cc-877d-f061b13feb2d
  - harness=opencode
- ✔ **tool-bridge** (pass) — opencode 的 host 工具直调面可用
  - 探测 my_industrial_nodes → 你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。
- ✔ **line-1-loop** (pass) — Line1 [modbus-tcp] Agent 闭环收敛（3/3 轮）
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔ · judge ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔ · judge ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.45s
- ✔ **line-2-loop** (pass) — Line2 [opcua] Agent 闭环收敛（3/3 轮）
  - iter1: SP→144.6 ✔ · 回读 145 ✔ · daq ✔ · judge ✔
  - iter2: SP→147.3 ✔ · 回读 147 ✔ · daq ✔ · judge ✔
  - iter3: SP→150 ✔ · 回读 150 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.357s
- ✔ **line-3-loop** (pass) — Line3 [mqtt] Agent 闭环收敛（3/3 轮）
  - iter1: SP→91.4 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→93.2 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→95 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.286s
- ✔ **line-4-loop** (pass) — Line4 [http] Agent 闭环收敛（3/3 轮）
  - iter1: SP→0.946 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→0.973 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→1 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.347s
- ✔ **plant-response** (pass) — 工艺模型响应（SP→plant truth 随动）
  - 真值样本 6 → 77
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":231,"defect":4.27}

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass) — Line1 优化记录生命周期
  - current 204.6999969482422 → record A writes 208.06 (up)，记录 B writes 201.34 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-f058a373 verdict keep → 判定已入册:记录 opt-f058a373 → keep(bench: 回读一致，判定 keep)。已定档为已验证经验(配方已标记 last
  - ✔ (rollback path) record opt-3cedb89d verdict rollback (recorded only; PLC still 201.3000030517578)
  - ✔ rollback executed (status 200) → readback 208.10000610351562 (expected record B from=208.06)
- ✔ **line-1-rbjudge** (pass) — Line1 撤销记录 opt-0e338797 判定关闭
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass) — Line1 node-level single-step rollback (undo stack)
  - ✔ write 205.04 effective (readback 205, before 208.10000610351562)
  - ✔ journal rollback 受理（status 200，记录 opt-0e338797）
  - ✔ readback after rollback 208.10000610351562 (expected back to 208.10000610351562, tolerance 0.75)
- ✔ **param-ledger** (pass) — 参数台账（三值对照 + 在册历史）
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ✔ **line-2-hitl** (pass) — Line2 HITL 审批闭环
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-d1ca116e（detail: L2-DCW-opcua ip16kove(烘箱温度设定)设定 148.2rpm,有效写入区间 141~159rpm(节点安全量程 ∩ 配方）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 下发成功:L2-DCW-opcua ip16kove(烘箱温度设定)设定 148.2rpm → PLC 原始值 148.2;回读 148.2rpm一致。当前活动配方「Integra
  - ✔ post-approval PLC effect: readback 148 (expected 148.2)
  - 审批裁决时延 16 ms（挂起→批准，含轮询周期）

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
  - ✔ (3) 标记已知良好批次 runId=rr-a9f92984 → lastGood=rr-a9f92984
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass) — Line2 [opcua] recipe lifecycle
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-5ff0522c → lastGood=rr-5ff0522c
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ✔ **param-facade** (pass) — Line2 [opcua] 参数面自动生成且无寄存器泄漏
  - param=pp-952ec9f2 key=temp-sp unit=rpm
  - 含 register/dataType/driverConfig? 无 ✔
- ✔ **param-limits** (pass) — Line2 基准限界 [143.7,156.3] + 产品限界 [146.22,153.78] 设定
  - 有效交集(含配方窗) 141~159 → param 143.7~156.3 → product 146.22~153.78 · node 层 50~200（四层收窄：node ∩ param ∩ product ∩ recipe）
- ✔ **param-write-governed** (pass) — Line2 参数面写入联锁（交集内写入 · 越产品层拦截 · 越基准层拦截 · 参数读回）
  - 148.866 → ✔ 写入+回读
  - 155.04 → ✔ 产品层拦截
  - 157.65 → ✔ 基准限界层拦截
  - param read → ✔ 148.866rpm
- ✔ **agent-param-tools** (pass) — Line2 Agent param_control/param_read（语义写 · 越产品层拒 · 参数读 · 未绑定拒）
  - param_control 151.323 → ✔ record=opt-e0779036
  - param_control 155.04 → ✔ 产品层拦截
  - param_read → ✔
  - unbound agent → ✔ 权限面拒绝

### P4m — AgentTeam optimization mission (task board → governed writes → attainment)

- ✔ **mission-board** (pass) — 任务板：优化任务下达并由 lead 派发
  - channel=05880222-d853-4621-843e-337edf25129d parent=f6810154-9c8d-4cd6-9eda-e83f8efe5f51 leadChild=e6738928-2d49-41bd-ae8e-f3ac82d13bcb assignee=f68410ee-1632-47a0-8771-e0afd91dca4b
- ✔ **mission-timescale-read** (pass) — 时段数据读取（daq_query from/to/bucket）
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip16kove(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 alarm,时间窗 2026-09-20T02:39 ~ 2026-09-20T02:44(降采样 1000ms)   样本 
- ✔ **mission-governed-write** (pass) — 受治理参数下发（1 写全开记录+判定）
  - iter1: SP→204.704 ✔ · record=opened+judged · PV≈204.7 ✔
- ✔ **mission-journal** (pass) — 参数账本归因（Agent source 可追溯）
  - journal sample: 优化记录(4 条,含参数/判定/窗口): - opt-7b68ff22 [judged-keep] L1-DCW-modbus-tcp ip16kove: 200 → 204.704,设定 02:44:41,判定 keep(agent:mission iter 1: PV=204.7 target=
- ✔ **mission-attained** (pass) — 优化目标达成（|PV−204.704|≤0.75）
  - writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass) — 任务收口（lead 派发→worker 剧本完成→父任务聚合）
  - terminalState=COMPLETED · writes=1 · reached=true

### P6 — Closed-loop optimization benchmark (multi-seed)

- ✔ **twin-nodes** (pass) — cast-film twin node provisioning（执行器 + 传感器）
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass) — 离线最优 W*（ground truth）
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-19T18:44:04.952Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ✔ **seed-42** (pass) — seed=42 闭环优化（J/J*=0.971）
  - 预热 3.081s（熔体温度 203.8℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.62μm defect=0.167% P=18.53MPa T=205.5℃ N=150 v=95.0 → J=67.80
  - iter1 下发 N=135 v=95 z=200 → h=48.98μm defect=0.467% P=16.43MPa T=202.5℃ → J=87.55 
  - iter2 下发 N=138 v=95 z=200 → h=49.70μm defect=0.600% P=16.73MPa T=201.2℃ → J=86.97 
- ✔ **seed-43** (pass) — seed=43 闭环优化（J/J*=0.971）
  - 预热 0.017s（熔体温度 201℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.37μm defect=0.250% P=18.60MPa T=206.6℃ N=150 v=95.0 → J=68.91
  - iter1 下发 N=135 v=95 z=200 → h=49.57μm defect=0.417% P=16.45MPa T=202.8℃ → J=87.71 
  - iter2 下发 N=136 v=95 z=200 → h=49.37μm defect=0.667% P=16.50MPa T=201.2℃ → J=86.87 
- ✔ **seed-44** (pass) — seed=44 闭环优化（J/J*=0.97）
  - 预热 0.018s（熔体温度 200.96℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.67μm defect=0.317% P=18.62MPa T=207.1℃ N=150 v=95.0 → J=67.05
  - iter1 下发 N=135 v=95 z=200 → h=49.37μm defect=0.400% P=16.47MPa T=203.1℃ → J=87.76 
  - iter2 下发 N=137 v=95 z=200 → h=49.50μm defect=0.717% P=16.67MPa T=201.4℃ → J=86.66 
- ✔ **closedloop-aggregate** (pass) — 闭环优化聚合（n=3）
  - J/J*：min 0.97 · mean 0.971 · max 0.971（J* = 89.894）
  - J start均值 67.919 → end均值 87.254
  - 平均迭代 2  · 总写 6 · 越界rejected 0 · 收敛 3/3 · 平均墙钟 36.173s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass) — 多形态数采（向量/图像帧）
  - ✔ 向量轮廓帧 5 （46.094,46.151,46.968,46.484,47.394,47.181,48.057,47.503,48.106,47.175,48.546,47.973,48.03,48.885,47.948,47.977,48.234,48.396,48.724,48.629,48.728,48.993,48.824,49.551,49.341,49.106,49.459,48.951,49.303,49.498,48.873,49.269,49.46,
  - ✔ 图像帧 5 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass) — second plant scenario applied: film-line
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] provisioned
  - line=ln-fc4b6ad1 daq=dn-97911ea5 dcw=dw-1856f2b0
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass) — scenario[film-line] line 2 [opcua] provisioned
  - line=ln-f3006539 daq=dn-8ef0fc75 dcw=dw-a8c20d1e
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass) — scenario[film-line] line 3 [mqtt] provisioned
  - line=ln-382570c4 daq=dn-8917a8a0 dcw=dw-76840600
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass) — scenario[film-line] line 4 [modbus-rtu] provisioned (satellite DAQ)
  - line=ln-382570c4 daq=dn-9331f69c dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass) — scenario[film-line] line 5 [http] provisioned (satellite DAQ)
  - line=ln-382570c4 daq=dn-3aaef737 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **port-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] integration
  - ✔ DAQ samples 11 pts (modbus-tcp real driver)
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
  - ✔ DAQ samples 10 pts (http real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)

### P8b — System backstop drill (bounded autonomy)

- ✔ **cleanup** (pass) — 遗留 open 记录清场（关闭 1/1 条）
  - records closed: 1/1
- ✔ **open-record** (pass) — 优化记录 opt-a9f1ebff 已开（基线 186.1999969482422 → 176.88，auto 策略）
  - 下发成功:L1-DCW-modbus-tcp ip16kovep8(烘箱温度设定)设定 176.88℃ → PLC 原始值 176.88;回读 176.89999389648438℃一致。当前活动配方「Integrated工艺1 ip16kovep8」。写入并回读一致:176.8
- ✔ **freeze** (pass) — DAQ temp-pv 已冻结至 150（窗外，窗 [164.4, 195.6]）
  - device=dev-0aa7f06b signal=temp-pv
- ✔ **backstop-verdict** (pass) — 系统兜底判定回退 + 自动恢复基线
  - 判定 by=system verdict=rollback · 时延 130.16s（环境类，节拍决定）
  - PLC 值 186.1999969482422 → 期望基线 186.1999969482422（±0.75） ✔
- ✔ **restore** (pass) — 过程量解冻 + 第一场景恢复: cast-film-physics
  - rig left as found

### P9 — Platform subsystems (team / memory / registry)

- ✔ **team-dispatch** (pass) — 团队调度（lead 派发 → worker 完成）
  - 终态 COMPLETED · assignee=fd8ecc6b-bb7b-4018-ad78-7b34d654a2c8（lead 认领父任务） · 子任务派发给 worker: ✔
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
| hitl | approval_latency_ms | 16 | ms | 挂起→批准（含 800ms 轮询粒度） |
| audit | journal_anchors | 11 |  | 本Line参数变更账本 |
| audit | audit_entries | 87 |  | 全局审计目 |
| audit | ops_logs | 87 |  | 全局运维日志 |
| recipe | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| gov | param_layer_checks_ok | 4 | /4 | 工艺参数映射层全链 |
| closedloop | J_over_Jstar_mean | 0.971 |  | n=3 seeds，写路径=governed |
| closedloop | J_over_Jstar_min | 0.97 |  | 最差 seed（保守下界） |
| closedloop | J_end_mean | 87.254 |  | J* = 89.894 |
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
| gov | backstop_latency_s | 130.16 | s | freeze → verdict (environmental) |
| biax | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| biax | sp_signals | 30 |  | 可写工艺 SP |
| biax | created_missing | 9 |  | 本次补建的缺失设备数 |
| biax | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| biax | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| biax | mission_writes | 1 |  | AgentTeam 双拉任务受治理写次数 |
| biax | mission_distinct_knobs | 1 |  | 参与闭环的执行节点数 |
| biax | mission_attained | 0 |  | 厚度达标 25.0±0.7μm |
| biax | mission_final_thickness | 0.12000000000000002 | μm | 终态厚度 |
| team | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| memory | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| agent | harness_registry | 14 |  | environment-available 14 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict PASS, grade A). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._
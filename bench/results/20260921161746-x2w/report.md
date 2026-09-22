# AW-IndustrialBench · Integrated Pipeline Report

> **PASS** — score **100.0**/100, grade **A**. Hard gate green: no failed checks or phases; skips are honest environmental exclusions.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20260921161746-x2w` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `11f00c625a936e68` (sha256 over 11 checker sources) |
| Git commit | `e692df1` |
| Runtime | v24.19.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3005 · http://127.0.0.1:4011 |
| Tool harness | opencode (deterministic) · LLM agent: omp |
| Reproduce | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3 --agent omp` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 58 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 29.543 ms | incl. real protocol transactions |
| Closed-loop J/J* | 97.0 % | n=3 seeds · worst 96.9% · J*=89.894 |
| Tool-level loops | 4 | dcw→daq→judge ×3 convergence |
| Param-layer governance | 4/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | fired+restored | window breach → auto-rollback in 130.224s (env) |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 3 knobs · 4 writes → 25.32μm ✔ |
| LLM agent loop | COMPLETED | omp |
| Verdict | PASS | 82/82 checks · hard gate green |

## Simulated production line profile

> Preset `cast-film-physics` — Cast-film extrusion digital twin (plant-model physics engine). An extrusion cast-film line: resin → screw melting → die → casting → thickness gauge. Six writable setpoints (3 zone temperatures, screw speed, line speed, die gap) act on a physics engine whose observable process quantities are melt temperature, melt pressure, film thickness, defect rate and gels count.

**Physics.** Deterministic plant model (seeded): first-order thermal lag on melt temperature, algebraic thickness h ∝ N/v from mass conservation, pressure/defect couplings — scored by J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput.
 Plant engine state at report time: phase=`warmup`, seed=`42`.

**Totals.** 20 PLC devices across 5 protocols (modbus-tcp, modbus-rtu, opcua, mqtt, http); **31 writable setpoints (SP → DCW nodes)** and **46 process quantities (PV → DAQ nodes)**; the platform side provisions 47 lines with 187 write nodes and 164 acquisition nodes.

### Devices & fieldbus endpoints

| # | Device | Protocol | Endpoint | Signals (SP+PV) |
|---:|---|---|---|---:|
| 1 | 挤出主机PLC(Modbus TCP) | `modbus-tcp` | `0.0.0.0:17040 unit=1` | 4 |
| 2 | 晶点计数从站(Modbus RTU) | `modbus-rtu` | `0.0.0.0:16041 unit=1` | 1 |
| 3 | 熔体泵送单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:6840` | 2 |
| 4 | 在线测厚仪(MQTT) | `mqtt` | `mqtt://127.0.0.1:19830` | 2 |
| 5 | CCD检测站(HTTP) | `http` | `http endpoint` | 4 |
| 6 | 注塑主机PLC(Modbus TCP) | `modbus-tcp` | `0.0.0.0:17052 unit=1` | 7 |
| 7 | 曝气风机站(Modbus TCP) | `modbus-tcp` | `0.0.0.0:17054 unit=1` | 3 |
| 8 | 加热段炉(Modbus TCP) | `modbus-tcp` | `0.0.0.0:17056 unit=1` | 5 |
| 9 | 模温机与锁模单元(Modbus RTU) | `modbus-rtu` | `0.0.0.0:16052 unit=1` | 4 |
| 10 | 加药单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:6844` | 4 |
| 11 | 炉内传动与速度单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:6845` | 2 |
| 12 | 注射/保压单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:6843` | 4 |
| 13 | 回流与排泥单元(Modbus RTU) | `modbus-rtu` | `0.0.0.0:16054 unit=1` | 4 |
| 14 | 进水泵房(MQTT) | `mqtt` | `mqtt://127.0.0.1:19830` | 3 |
| 15 | 冷却水单元(MQTT) | `mqtt` | `mqtt://127.0.0.1:19830` | 3 |
| 16 | 冷却与过时效段(Modbus RTU) | `modbus-rtu` | `0.0.0.0:16056 unit=1` | 3 |
| 17 | 出水水质检测站(HTTP) | `http` | `http endpoint` | 6 |
| 18 | 制品质量检测站(HTTP) | `http` | `http endpoint` | 7 |
| 19 | 保护气单元(MQTT) | `mqtt` | `mqtt://127.0.0.1:19830` | 3 |
| 20 | 成品质量检测站(HTTP) | `http` | `http endpoint` | 6 |

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
| 注塑主机PLC(Modbus TCP) | 机筒温度区1SP (`barrel-temp-1-sp`) | SP (writable setpoint) | ℃ | [160, 300] | 1 | `manual` |
| 注塑主机PLC(Modbus TCP) | 机筒温度区2SP (`barrel-temp-2-sp`) | SP (writable setpoint) | ℃ | [160, 300] | 1 | `manual` |
| 注塑主机PLC(Modbus TCP) | 机筒温度区3SP (`barrel-temp-3-sp`) | SP (writable setpoint) | ℃ | [160, 300] | 1 | `manual` |
| 注塑主机PLC(Modbus TCP) | 机筒温度区4SP (`barrel-temp-4-sp`) | SP (writable setpoint) | ℃ | [160, 300] | 1 | `manual` |
| 注塑主机PLC(Modbus TCP) | 螺杆转速SP (`screw-speed-sp`) | SP (writable setpoint) | rpm | [60, 200] | 0 | `manual` |
| 注塑主机PLC(Modbus TCP) | MeltTemp (`melt-temp-pv`) | PV (process quantity) | ℃ | [20, 320] | 1 | `constant` |
| 注塑主机PLC(Modbus TCP) | MeltPress (`melt-pressure-pv`) | PV (process quantity) | bar | [0, 160] | 1 | `constant` |
| 曝气风机站(Modbus TCP) | 风机频率SP (`blower-hz-sp`) | SP (writable setpoint) | Hz | [20, 50] | 1 | `manual` |
| 曝气风机站(Modbus TCP) | AirPress (`air-pressure-pv`) | PV (process quantity) | kPa | [20, 90] | 1 | `constant` |
| 曝气风机站(Modbus TCP) | DO (`do-pv`) | PV (process quantity) | mg/L | [0, 10] | 2 | `constant` |
| 加热段炉(Modbus TCP) | 均热区1炉温SP (`zone1-sp`) | SP (writable setpoint) | ℃ | [600, 850] | 1 | `manual` |
| 加热段炉(Modbus TCP) | 均热区2炉温SP (`zone2-sp`) | SP (writable setpoint) | ℃ | [600, 850] | 1 | `manual` |
| 加热段炉(Modbus TCP) | 均热区3炉温SP (`zone3-sp`) | SP (writable setpoint) | ℃ | [600, 850] | 1 | `manual` |
| 加热段炉(Modbus TCP) | FurnaceTemp (`furnace-temp-pv`) | PV (process quantity) | ℃ | [20, 900] | 1 | `constant` |
| 加热段炉(Modbus TCP) | StripTemp (`strip-temp-pv`) | PV (process quantity) | ℃ | [20, 900] | 1 | `constant` |
| 模温机与锁模单元(Modbus RTU) | 模具温度SP (`mold-temp-sp`) | SP (writable setpoint) | ℃ | [20, 95] | 1 | `manual` |
| 模温机与锁模单元(Modbus RTU) | 锁模力SP (`clamp-force-sp`) | SP (writable setpoint) | kN | [800, 2500] | 0 | `manual` |
| 模温机与锁模单元(Modbus RTU) | MoldTempPV (`mold-temp-pv`) | PV (process quantity) | ℃ | [10, 110] | 1 | `constant` |
| 模温机与锁模单元(Modbus RTU) | ClampPV (`clamp-force-pv`) | PV (process quantity) | kN | [0, 2600] | 0 | `constant` |
| 加药单元(OPC UA) | NaohDoseSP (`naoh-dose-sp`) | SP (writable setpoint) | L/h | [0, 120] | 0 | `manual` |
| 加药单元(OPC UA) | PacDoseSP (`pac-dose-sp`) | SP (writable setpoint) | L/h | [0, 90] | 0 | `manual` |
| 加药单元(OPC UA) | NaohFlow (`naoh-flow-pv`) | PV (process quantity) | L/h | [0, 130] | 1 | `constant` |
| 加药单元(OPC UA) | PacFlow (`pac-flow-pv`) | PV (process quantity) | L/h | [0, 100] | 1 | `constant` |
| 炉内传动与速度单元(OPC UA) | LineSpeedSP (`line-speed-sp`) | SP (writable setpoint) | m/min | [60, 220] | 0 | `manual` |
| 炉内传动与速度单元(OPC UA) | ActSpeed (`act-speed-pv`) | PV (process quantity) | m/min | [0, 240] | 1 | `constant` |
| 注射/保压单元(OPC UA) | InjectSpeedSP (`inject-speed-sp`) | SP (writable setpoint) | mm/s | [30, 130] | 0 | `manual` |
| 注射/保压单元(OPC UA) | HoldPressSP (`hold-pressure-sp`) | SP (writable setpoint) | bar | [20, 110] | 1 | `manual` |
| 注射/保压单元(OPC UA) | HoldTimeSP (`hold-time-sp`) | SP (writable setpoint) | s | [3, 15] | 1 | `manual` |
| 注射/保压单元(OPC UA) | InjPressPV (`inj-pressure-pv`) | PV (process quantity) | bar | [0, 180] | 1 | `constant` |
| 回流与排泥单元(Modbus RTU) | 内回流比SP (`recycle-int-sp`) | SP (writable setpoint) | % | [20, 180] | 0 | `manual` |
| 回流与排泥单元(Modbus RTU) | 污泥回流比SP (`recycle-sludge-sp`) | SP (writable setpoint) | % | [30, 120] | 0 | `manual` |
| 回流与排泥单元(Modbus RTU) | 排泥量SP (`waste-sludge-sp`) | SP (writable setpoint) | m³/d | [50, 400] | 0 | `manual` |
| 回流与排泥单元(Modbus RTU) | MLSS (`mlss-pv`) | PV (process quantity) | mg/L | [1000, 8000] | 0 | `constant` |
| 进水泵房(MQTT) | InflowSP (`influent-flow-sp`) | SP (writable setpoint) | m³/h | [400, 1600] | 0 | `manual` |
| 进水泵房(MQTT) | CodIn (`cod-in-pv`) | PV (process quantity) | mg/L | [100, 900] | 0 | `constant` |
| 进水泵房(MQTT) | Nh3In (`nh3-in-pv`) | PV (process quantity) | mg/L | [10, 80] | 1 | `constant` |
| 冷却水单元(MQTT) | CoolWaterSP (`cool-water-sp`) | SP (writable setpoint) | ℃ | [10, 45] | 1 | `manual` |
| 冷却水单元(MQTT) | WaterTempPV (`water-temp-pv`) | PV (process quantity) | ℃ | [5, 60] | 1 | `constant` |
| 冷却水单元(MQTT) | CoolFlowPV (`cool-flow-pv`) | PV (process quantity) | L/min | [0, 80] | 1 | `constant` |
| 冷却与过时效段(Modbus RTU) | 过时效温度SP (`oa-temp-sp`) | SP (writable setpoint) | ℃ | [320, 480] | 1 | `manual` |
| 冷却与过时效段(Modbus RTU) | 冷却档位SP (`cool-rate-sp`) | SP (writable setpoint) | % | [20, 100] | 0 | `manual` |
| 冷却与过时效段(Modbus RTU) | OaTempPV (`oa-temp-pv`) | PV (process quantity) | ℃ | [20, 520] | 1 | `constant` |
| 出水水质检测站(HTTP) | CodOut (`eff-cod`) | PV (process quantity) | mg/L | [0, 300] | 1 | `constant` |
| 出水水质检测站(HTTP) | Nh3Out (`eff-nh3`) | PV (process quantity) | mg/L | [0, 60] | 2 | `constant` |
| 出水水质检测站(HTTP) | TpOut (`eff-tp`) | PV (process quantity) | mg/L | [0, 8] | 3 | `constant` |
| 出水水质检测站(HTTP) | PhOut (`eff-ph`) | PV (process quantity) | pH | [4, 11] | 2 | `constant` |
| 出水水质检测站(HTTP) | Turbidity (`eff-turbidity`) | PV (process quantity) | NTU | [0, 60] | 2 | `constant` |
| 出水水质检测站(HTTP) | DoProfile (`do-profile`) | PV (process quantity) | mg/L | [0, 10] | 3 | `constant` |
| 制品质量检测站(HTTP) | PartWeight (`part-weight`) | PV (process quantity) | g | [25, 40] | 2 | `constant` |
| 制品质量检测站(HTTP) | FlashRate (`flash-rate`) | PV (process quantity) | % | [0, 5] | 3 | `constant` |
| 制品质量检测站(HTTP) | SinkMark (`sink-mark`) | PV (process quantity) | % | [0, 10] | 3 | `constant` |
| 制品质量检测站(HTTP) | DimDev (`dim-dev`) | PV (process quantity) | mm | [-0.5, 0.5] | 3 | `constant` |
| 制品质量检测站(HTTP) | CycleTime (`cycle-time`) | PV (process quantity) | s | [5, 60] | 1 | `constant` |
| 制品质量检测站(HTTP) | WallProfile (`wall-profile`) | PV (process quantity) | mm | [1, 5] | 4 | `constant` |
| 制品质量检测站(HTTP) | SurfaceImg (`surface-image`) | PV (process quantity) | 灰度 | [0, 255] | 2 | `constant` |
| 保护气单元(MQTT) | H2RatioSP (`h2-ratio-sp`) | SP (writable setpoint) | % | [3, 15] | 1 | `manual` |
| 保护气单元(MQTT) | DewPoint (`dew-point-pv`) | PV (process quantity) | ℃ | [-70, 0] | 1 | `constant` |
| 保护气单元(MQTT) | H2Act (`h2-act-pv`) | PV (process quantity) | % | [0, 20] | 1 | `constant` |
| 成品质量检测站(HTTP) | Hardness (`hardness`) | PV (process quantity) | HV | [60, 200] | 1 | `constant` |
| 成品质量检测站(HTTP) | Tensile (`tensile`) | PV (process quantity) | MPa | [200, 500] | 1 | `constant` |
| 成品质量检测站(HTTP) | YieldStr (`yield-str`) | PV (process quantity) | MPa | [100, 400] | 1 | `constant` |
| 成品质量检测站(HTTP) | GrainSize (`grain-size`) | PV (process quantity) | μm | [2, 30] | 2 | `constant` |
| 成品质量检测站(HTTP) | SurfaceDef (`surface-defect`) | PV (process quantity) | % | [0, 5] | 3 | `constant` |
| 成品质量检测站(HTTP) | Flatness (`flatness`) | PV (process quantity) | I | [0, 100] | 2 | `constant` |

### Platform-side node mapping (AW write-control / acquisition nodes)

| Node | Kind | Driver | Line | Unit | Range |
|---|---|---|---|---|---|
| L1-DCW-modbus-tcp ip163936 (`dw-3c9c61d`) | DCW write | `modbus-tcp` | Integrated线1 ip163936 | ℃ | [120, 260] |
| L2-DCW-opcua ip163936 (`dw-d916642`) | DCW write | `opcua` | Integrated线2 ip163936 | rpm | [50, 200] |
| L3-DCW-mqtt ip163936 (`dw-58ecda1`) | DCW write | `mqtt` | Integrated线3 ip163936 | m/min | [20, 120] |
| L4-DCW-http ip163936 (`dw-f1047e0`) | DCW write | `http` | Integrated线4 ip163936 | mm | [0.5, 2] |
| 加热区1SP ip163936gl (`dw-0b7246d`) | DCW write | `modbus-tcp` | CastFilm线 ip163936gl | ℃ | [120, 260] |
| 加热区2SP ip163936gl (`dw-2a7f6f8`) | DCW write | `modbus-tcp` | CastFilm线 ip163936gl | ℃ | [120, 260] |
| 加热区3SP ip163936gl (`dw-9fe883b`) | DCW write | `modbus-tcp` | CastFilm线 ip163936gl | ℃ | [120, 260] |
| ScrewSpeedSP ip163936gl (`dw-edca997`) | DCW write | `opcua` | CastFilm线 ip163936gl | rpm | [50, 200] |
| lineSpeedSP ip163936gl (`dw-b47d9e9`) | DCW write | `mqtt` | CastFilm线 ip163936gl | m/min | [20, 120] |
| dieGapSP ip163936gl (`dw-67b3b51`) | DCW write | `http` | CastFilm线 ip163936gl | mm | [0.5, 2] |
| 加热区1SP ip163936cl (`dw-7d44f5a`) | DCW write | `modbus-tcp` | CastFilm线 ip163936cl | ℃ | [120, 260] |
| 加热区2SP ip163936cl (`dw-9a00243`) | DCW write | `modbus-tcp` | CastFilm线 ip163936cl | ℃ | [120, 260] |
| 加热区3SP ip163936cl (`dw-9dc5fe0`) | DCW write | `modbus-tcp` | CastFilm线 ip163936cl | ℃ | [120, 260] |
| ScrewSpeedSP ip163936cl (`dw-cb2b6bb`) | DCW write | `opcua` | CastFilm线 ip163936cl | rpm | [50, 200] |
| lineSpeedSP ip163936cl (`dw-b0e1bdd`) | DCW write | `mqtt` | CastFilm线 ip163936cl | m/min | [20, 120] |
| dieGapSP ip163936cl (`dw-52cc628`) | DCW write | `http` | CastFilm线 ip163936cl | mm | [0.5, 2] |
| L1-DCW-modbus-tcp ip163936p8 (`dw-5c480f4`) | DCW write | `modbus-tcp` | Integrated线1 ip163936p8 | ℃ | [0, 260] |
| L2-DCW-opcua ip163936p8 (`dw-42d5b40`) | DCW write | `opcua` | Integrated线2 ip163936p8 | ℃ | [0, 260] |
| L3-DCW-mqtt ip163936p8 (`dw-658ba17`) | DCW write | `mqtt` | Integrated线3 ip163936p8 | ℃ | [0, 100] |
| 干燥温度SP·ip163936 (`dw-f57dd43`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip163936 | ℃ | [120, 200] |
| 露点SP·ip163936 (`dw-0cff65c`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip163936 | ℃ | [-80, -20] |
| 喂料速率SP·ip163936 (`dw-811ad3a`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip163936 | kg/h | [100, 1200] |
| 机筒温度区1SP·ip163936 (`dw-9cc092e`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | ℃ | [220, 300] |
| 机筒温度区2SP·ip163936 (`dw-71b8417`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | ℃ | [220, 300] |
| 机筒温度区3SP·ip163936 (`dw-53583a5`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | ℃ | [220, 300] |
| 机筒温度区4SP·ip163936 (`dw-af0eb6f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | ℃ | [220, 300] |
| 机筒温度区5SP·ip163936 (`dw-a4dd947`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | ℃ | [220, 300] |
| 螺杆转速SP·ip163936 (`dw-9f13b69`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | rpm | [20, 100] |
| 计量泵转速SP·ip163936 (`dw-3a70e49`) | DCW write | `modbus-rtu` | 双拉薄膜产线 biax-ip163936 | rpm | [15, 60] |
| 模唇温度SP·ip163936 (`dw-df62dd4`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | ℃ | [250, 300] |
| 急冷辊温度SP·ip163936 (`dw-e78caca`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | ℃ | [10, 60] |
| 铸片辊速度SP·ip163936 (`dw-fb620c8`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | m/min | [10, 60] |
| 静电吸附电压SP·ip163936 (`dw-76fbfb8`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | kV | [4, 12] |
| 预热辊1温度SP·ip163936 (`dw-3228a39`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | ℃ | [70, 140] |
| 预热辊2温度SP·ip163936 (`dw-7251004`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | ℃ | [70, 140] |
| 预热辊3温度SP·ip163936 (`dw-6905024`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | ℃ | [70, 140] |
| 慢辊线速度SP·ip163936 (`dw-73d819a`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | m/min | [10, 80] |
| 快辊线速度SP·ip163936 (`dw-67a18a0`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | m/min | [30, 260] |
| 纵拉退火辊SP·ip163936 (`dw-42b0e32`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip163936 | ℃ | [90, 170] |
| TDO预热段SP·ip163936 (`dw-76d4dcc`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip163936 | ℃ | [80, 140] |
| L1-DAQ-modbus-tcp ip163936 (`dn-b41cda5`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip163936 | ℃ | [0, 400] |
| L2-DAQ-opcua ip163936 (`dn-992fdcf`) | DAQ acquire | `opcua` | Integrated线2 ip163936 | MPa | [0, 45] |
| L3-DAQ-mqtt ip163936 (`dn-a9d0900`) | DAQ acquire | `mqtt` | Integrated线3 ip163936 | μm | [0, 400] |
| L4-DAQ-http ip163936 (`dn-f8cd8a0`) | DAQ acquire | `http` | Integrated线4 ip163936 | μm | [0, 400] |
| L5-DAQ-modbus-rtu ip163936(sat) (`dn-e6cfed6`) | DAQ acquire | `modbus-rtu` | Integrated线4 ip163936 | 个/m² | [0, 500] |
| 熔体温度 ip163936gl (`dn-c7545b6`) | DAQ acquire | `modbus-tcp` | CastFilm线 ip163936gl | ℃ | [0, 400] |
| 晶点计数 ip163936gl (`dn-17c5af5`) | DAQ acquire | `modbus-rtu` | CastFilm线 ip163936gl | 个/m² | [0, 500] |
| MeltPressure ip163936gl (`dn-fa2624e`) | DAQ acquire | `opcua` | CastFilm线 ip163936gl | MPa | [0, 45] |
| thick ip163936gl (`dn-dc179d9`) | DAQ acquire | `mqtt` | CastFilm线 ip163936gl | μm | [0, 400] |
| defect ip163936gl (`dn-4a2f586`) | DAQ acquire | `http` | CastFilm线 ip163936gl | % | [0, 100] |
| 熔体温度 ip163936cl (`dn-89d6d14`) | DAQ acquire | `modbus-tcp` | CastFilm线 ip163936cl | ℃ | [0, 400] |
| 晶点计数 ip163936cl (`dn-b8298a8`) | DAQ acquire | `modbus-rtu` | CastFilm线 ip163936cl | 个/m² | [0, 500] |
| MeltPressure ip163936cl (`dn-0fbf13b`) | DAQ acquire | `opcua` | CastFilm线 ip163936cl | MPa | [0, 45] |
| thick ip163936cl (`dn-8922c21`) | DAQ acquire | `mqtt` | CastFilm线 ip163936cl | μm | [0, 400] |
| defect ip163936cl (`dn-4f3c2f5`) | DAQ acquire | `http` | CastFilm线 ip163936cl | % | [0, 100] |
| profile ip163936 (`dn-79b7357`) | DAQ acquire | `http` | Integrated线1 ip163936 | mm | [0.4, 0.65] |
| ccd ip163936 (`dn-e725678`) | DAQ acquire | `http` | Integrated线1 ip163936 | 灰度 | [0, 255] |
| L1-DAQ-modbus-tcp ip163936p8 (`dn-57e0a04`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip163936p8 | ℃ | [0, 260] |
| L2-DAQ-opcua ip163936p8 (`dn-0f0bbc9`) | DAQ acquire | `opcua` | Integrated线2 ip163936p8 | ℃ | [0, 260] |
| L3-DAQ-mqtt ip163936p8 (`dn-55ebbaf`) | DAQ acquire | `mqtt` | Integrated线3 ip163936p8 | ℃ | [0, 100] |
| L4-DAQ-modbus-rtu ip163936p8(sat) (`dn-ebf247f`) | DAQ acquire | `modbus-rtu` | Integrated线3 ip163936p8 | ℃ | [0, 100] |
| L5-DAQ-http ip163936p8(sat) (`dn-205f131`) | DAQ acquire | `http` | Integrated线3 ip163936p8 | L/min | [0, 100] |
| 干燥塔温度·ip163936 (`dn-0bd53c9`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip163936 | ℃ | [20, 220] |
| 切片残水·ip163936 (`dn-74c3a75`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip163936 | ppm | [0, 120] |

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
| P5 |  | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P5b |  | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P6 | Closed-loop optimization benchmark (multi-seed) | 6 | 0 | 0 | 0 | 100.0 | 3 |
| P7 | Multimodal acquisition (vector/image) | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P8 | Cross-scenario portability | 11 | 0 | 0 | 0 | 100.0 | 3 |
| P8b | System backstop drill (bounded autonomy) | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P9 | Platform subsystems (team / memory / registry) | 3 | 0 | 0 | 0 | 100.0 | 1 |
| P10 | Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop) | 10 | 0 | 0 | 0 | 100.0 | 3 |
| P11 |  | 5 | 0 | 0 | 0 | 100.0 | 1 |
| **Overall** | | | | | | **100.0** | 40 |

## Closed-loop optimization · per-seed

| Seed | J0 | Jend | J* | J/J* % | Iters | Governed writes | Rejected | Converged |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 42 | 66.53 | 87.29 | 89.89 | 97.1 | 2 | 2 | 0 | yes |
| 43 | 68.05 | 87.26 | 89.89 | 97.1 | 2 | 2 | 0 | yes |
| 44 | 65.32 | 87.11 | 89.89 | 96.9 | 2 | 2 | 0 | yes |

## AgentTeam closed-loop tuning walkthrough

How an optimization team is assembled and drives the line, end to end: (1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; (2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); (3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; (4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; (5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.

### Biax (BOPET) multi-node mission — iteration trace

| Iter | Knob | Node | From → To | Thickness μm | Note |
|---|---|---|---|---:|---|
| 0 | — | `—` | — | 28.00 |  |
| 1 | cast-spd-sp | `dw-7adf0c58` | 32 → 33.7 | 26.70 |  |
| 2 | fast-roll-sp | `dw-35efc330` | 118 → 120.6 | 25.94 |  |
| 3 | rail-out-sp | `dw-72554674` | 3000 → 3033 | 25.74 |  |
| 4 | cast-spd-sp | `dw-7adf0c58` | 33.70000076293945 → 34.2 | 25.32 |  |

Governed writes: **4** on 3 distinct knob(s) · optimization records: 4 · target window 25 ± 0.7 μm · final thickness reading **25.32 μm** · target attained: **no**.

### Deterministic closed-loop benchmark — seed 42 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.87 | 0.133 | 18.65 | 206.7 | 150 | 95.0 | 200.0 | 66.52 | 0 |
| 1 | 49.23 | 0.450 | 16.37 | 203.0 | 134 | 95.0 | 200.0 | 87.66 | 24.111 |
| 2 | 49.28 | 0.650 | 16.55 | 201.3 | 136 | 95.0 | 200.0 | 86.92 | 36.162 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.1 %**; governed writes 2 (rejected 0), optimization records 2.

### Deterministic closed-loop benchmark — seed 43 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.53 | 0.233 | 18.65 | 206.6 | 150 | 95.0 | 200.0 | 68.05 | 0 |
| 1 | 49.43 | 0.483 | 16.45 | 202.8 | 135 | 95.0 | 200.0 | 87.50 | 24.115 |
| 2 | 49.68 | 0.600 | 16.63 | 201.3 | 137 | 95.0 | 200.0 | 87.03 | 36.178 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.1 %**; governed writes 2 (rejected 0), optimization records 2.

### Deterministic closed-loop benchmark — seed 44 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 56.13 | 0.050 | 18.65 | 207.0 | 150 | 95.0 | 200.0 | 65.32 | 0 |
| 1 | 48.10 | 0.517 | 16.43 | 203.2 | 134 | 95.0 | 200.0 | 87.45 | 24.098 |
| 2 | 50.50 | 0.650 | 16.87 | 201.5 | 139 | 95.0 | 200.0 | 86.76 | 36.165 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **96.9 %**; governed writes 2 (rejected 0), optimization records 2.

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `agentteam-mission.log` | 1.0 KB | AgentTeam optimization mission — full task-board trajectory |
| `agentteam-biax.log` | 1.6 KB | AgentTeam biax multi-node mission — full trajectory |
| `line-profile.json` | 117.2 KB | Simulated line profile — devices, protocols, endpoints, SP/PV signal inventory, AW node mapping |
| `agent-loop-omp.log` | 4.9 KB | Execution / trajectory log (verbatim archive) |
| `agent-goal-loop-omp.log` | 18.1 KB | Execution / trajectory log (verbatim archive) |
| `metrics.csv` | 3.8 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 196.3 KB | Full machine-readable results (checks, phases, evidence, KPIs, line profile, agent-team traces) |
| `summary.json` | 17.8 KB | Verdict + KPI + per-line summary (compare/aggregate input) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✔ **platform-reachable** (pass) — platform reachable & authenticated
  - 平台 http://127.0.0.1:3005：already-up
  - 鉴权 OK (login)
  - simulator http://127.0.0.1:4011：already up (reused)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass) — 预设 cast-film-physics 已应用
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **offline-optimum** (pass) — offline optimum W* (ground truth) available
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-21T16:17:49.481Z"}

### P10 — Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)

- ✔ **biax-ensure** (pass) — 节点探测补建(9 建缺失 / 0 修复 / 0 原样)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass) — 五协议多节点建线(DCW 30 + DAQ 19,驱动实测 9/9)
  - line=ln-fd67ca32 recipe=rc-9c1acf43 started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass) — 测厚仪真实链路采样(1 点)
  - daq=dn-ab68d99d · samples=1
- ✔ **biax-agent-cards** (pass) — Agent 语义卡含双拉工艺描述(semantics 贯通)
  - 语义卡长度 22595 · 关键词命中 铸片辊速度/横向拉伸比/收卷张力
  - sample: #### ◆ L1-DCW-modbus-tcp ip168b09 [id=dw-f3d0038d] - 物理量: 烘箱温度设定,单位 ℃,精度 1 位小数 - 工艺语义: 模拟器设备「挤出主机PLC(Modbus TCP)」的 加热区1SP（真实 modbus-tcp 写控） - 安全量程: [120, 260] ℃
- ✔ **biax-mission-board** (pass) — 任务板:双拉优化任务下达并由 lead 派发
  - parent task + lead child: ✔
- ✔ **biax-mission-multinode** (pass) — 多节点受治理写(3 个执行节点 / 4 写)
  - 1. task board: channel=d1fa3bbf-bc23-4909-988d-991fab9e0764 parent=cdcbcee2-3f2b-4fce-af1b-48ecbe958546 leadChild=bd9c979e-3f58-4cf8-8267-408e827f7e02
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[3.5,1.6]
  - 3. initial thickness=28.00 μm(目标 25±0.7)
  - iter1: cast-spd-sp 32→33.7 ✔ record=opt-b52c95… · thickness→26.70μm · judge=keep✔
- ✔ **biax-mission-attained** (pass) — 厚度目标达成(|PV−25.0|≤0.7μm,final=25.32)
  - writes=4/6 · distinctKnobs=3 · final=25.32μm
  -         meltTemp=291.5℃(安全窗 268~300)
  - 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(2 条,含参数/判定/窗口): - opt-a5231637 [judged-keep] 铸片辊速度SP·ip168b09: 33.7 → 34.2,设定 00:35:37,判定 keep(agent:biax mission i
  - 5. outcome: writes=4 distinctKnobs=3 final=25.32μm attained=true
- ✔ **biax-mission-journal** (pass) — 参数账本 Agent 归因(铸速节点)
- ✔ **biax-mission-closed** (pass) — 任务收口(父任务 COMPLETED)
  - terminal=COMPLETED
- ✔ **biax-restore** (pass) — 双拉线停止 + 第一场景恢复: cast-film-physics
  - rig left as found

### P11 — 

- ✔ **scen-injection** (pass) — 注塑成型质量窗口寻优(writes=3, wall=34.38s, 线复用)
  - baseline 克重=31.30g(目标 32.5±0.35)
  - iter1: hold-pressure-sp 45→57.73 ✔ record=yes · 克重→31.89g
  - iter2: hold-time-sp 6→10.85 ✔ record=yes · 克重→32.15g
  - iter3: hold-pressure-sp 57.7→61.4 ✔ record=yes · 克重→32.32g
- ✔ **scen-wwtp** (pass) — A2O 污水生化处理达标降耗(writes=15, wall=181.24s, 线复用)
  - baseline DO=0.23 COD=360 NH3=34.5 TP=0.65 pH=6.59 → 不达标
  - iter1(曝气): 风机 26→30.03 ✔
  - iter2(曝气): 风机 30→31.6 ✔
  - iter3(曝气): 风机 31.600000381469727→32.4 ✔
- ✔ **scen-anneal** (pass) — 连续退火质量窗内产能最大化(writes=6, wall=66.74s, 线复用)
  - baseline 硬度=134.9HV 抗拉=310MPa 线速=140m/min → 窗外
  - iter1: zone3-sp 730→850 ✔
  - trim1: zone2-sp 710→722 硬度→99.4HV(修剪线 ≤98)
  - trim2: zone2-sp 722→734 硬度→99.2HV(修剪线 ≤98)
- ✔ **scen-biax** (pass) — 双拉(BOPET)薄膜产线多节点闭环(writes=4, wall=nulls, 线复用)
  - 1. task board: channel=d1fa3bbf-bc23-4909-988d-991fab9e0764 parent=cdcbcee2-3f2b-4fce-af1b-48ecbe958546 leadChild=bd9c979e-3f58-4cf8-8267-408e827f7e02
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[3.5,1.6]
  - 3. initial thickness=28.00 μm(目标 25±0.7)
  - iter1: cast-spd-sp 32→33.7 ✔ record=opt-b52c95… · thickness→26.70μm · judge=keep✔
- ✔ **scen-report** (pass) — 多场景 benchmark 报告(scenarios-benchmark.md/.html)
  - bench/results/20260921161746-x2w/scenarios-benchmark.md
  - 并行 wall=184.25s

### P2 — Multi-protocol line provisioning

- ✔ **gateway** (pass) — gateway controller start (idempotent)
  - POST /api/workshop/daq/controller {action:start}
  - 采样仍受「活动Line批」门控，故每台有 SP 的devices自成一可开跑Line
- ✔ **line-1-modbus-tcp** (pass) — Line1 [modbus-tcp] 供给
  - line=ln-105db828 daq=dn-f455501b dcw=dw-f3d0038d recipe=rc-58f720b2
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 210.6999969482422
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass) — Line2 [opcua] 供给
  - line=ln-a8feef8e daq=dn-e20d396e dcw=dw-3b2b2ccc recipe=rc-0ef534dd
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 18.532
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass) — Line3 [mqtt] 供给
  - line=ln-87a9378e daq=dn-7d329d02 dcw=dw-dcef1f8f recipe=rc-251a5be7
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,收到 aw/sim/thick = 56.65
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass) — Line4 [http] 供给
  - line=ln-8a8ff6d8 daq=dn-5bacf894 dcw=dw-bb5a8b3a recipe=rc-f37730bd
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 0.147
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass) — Line5 [modbus-rtu] 供给（satellite DAQ）
  - line=ln-8a8ff6d8 daq=dn-628a32ed dcw=✘ recipe=rc-f37730bd ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 3
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ · governed write · F5 interlock

- ✔ **line-1-io** (pass) — Line1 [modbus-tcp] integration check
  - ✔ DAQ samples stored 9  points (modbus-tcp real driver）
  - ✔ 约6写 p50=47.392ms p95=64.769ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass) — Line2 [opcua] integration check
  - ✔ DAQ samples stored 11  points (opcua real driver）
  - ✔ 约6写 p50=19.18ms p95=21.075ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass) — Line3 [mqtt] integration check
  - ✔ DAQ samples stored 12  points (mqtt real driver）
  - ✔ 约6写 p50=19.462ms p95=22.818ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass) — Line4 [http] integration check
  - ✔ DAQ samples stored 12  points (http real driver）
  - ✔ 约6写 p50=32.136ms p95=32.666ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass) — Line5 [modbus-rtu] integration check
  - ✔ DAQ samples stored 14  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass) — 闭环夹具（channel+agent）
  - channel=c0eb4d43-e262-44ac-b09b-25594d49bfc9
  - agent=e3629f57-0959-455f-94db-d9042586e394
  - harness=opencode
- ✔ **tool-bridge** (pass) — opencode 的 host 工具直调面可用
  - 探测 my_industrial_nodes → 你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。
- ✔ **line-1-loop** (pass) — Line1 [modbus-tcp] Agent 闭环收敛（3/3 轮）
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔ · judge ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔ · judge ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.443s
- ✔ **line-2-loop** (pass) — Line2 [opcua] Agent 闭环收敛（3/3 轮）
  - iter1: SP→144.6 ✔ · 回读 145 ✔ · daq ✔ · judge ✔
  - iter2: SP→147.3 ✔ · 回读 147 ✔ · daq ✔ · judge ✔
  - iter3: SP→150 ✔ · 回读 150 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.316s
- ✔ **line-3-loop** (pass) — Line3 [mqtt] Agent 闭环收敛（3/3 轮）
  - iter1: SP→91.4 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→93.2 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→95 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.314s
- ✔ **line-4-loop** (pass) — Line4 [http] Agent 闭环收敛（3/3 轮）
  - iter1: SP→0.946 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→0.973 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→1 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.341s
- ✔ **plant-response** (pass) — 工艺模型响应（SP→plant truth 随动）
  - 真值样本 6 → 72
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":216,"defect":0.655,"eng

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass) — Line1 优化记录生命周期
  - current 204.6999969482422 → record A writes 208.06 (up)，记录 B writes 201.34 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-dd43f986 verdict keep → 判定已入册:记录 opt-dd43f986 → keep(bench: 回读一致，判定 keep)。已定档为已验证经验(配方已标记 last
  - ✔ (rollback path) record opt-7c69ea60 verdict rollback (recorded only; PLC still 201.3000030517578)
  - ✔ rollback executed (status 200) → readback 208.10000610351562 (expected record B from=208.06)
- ✔ **line-1-rbjudge** (pass) — Line1 撤销记录 opt-fcfa977c 判定关闭
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass) — Line1 node-level single-step rollback (undo stack)
  - ✔ write 205.04 effective (readback 205, before 208.10000610351562)
  - ✔ journal rollback 受理（status 200，记录 opt-fcfa977c）
  - ✔ readback after rollback 208.10000610351562 (expected back to 208.10000610351562, tolerance 0.75)
- ✔ **param-ledger** (pass) — 参数台账（三值对照 + 在册历史）
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ✔ **line-2-hitl** (pass) — Line2 HITL 审批闭环
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-27cda004（detail: L2-DCW-opcua ip168b09(烘箱温度设定)设定 148.2rpm,有效写入区间 141~159rpm(节点安全量程 ∩ 配方）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 下发成功:L2-DCW-opcua ip168b09(烘箱温度设定)设定 148.2rpm → PLC 原始值 148.2;回读 148.2rpm一致。当前活动配方「Integra
  - ✔ post-approval PLC effect: readback 148 (expected 148.2)
  - 审批裁决时延 450 ms（挂起→批准，含轮询周期）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass) — 治理只读面
  - ✔ 参数变更账本 journal：本产线 11  anchors (source coverage  rollback/manual/agent/recipe）
  - ✔ audit: 200 entries
  - ✔ ops-logs: 200 entries
  - ✔ 报警记录：全局 36 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass) — Line1 [modbus-tcp] recipe lifecycle
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-cedcddb3 → lastGood=rr-cedcddb3
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass) — Line2 [opcua] recipe lifecycle
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-4c5f623c → lastGood=rr-4c5f623c
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ✔ **param-facade** (pass) — Line2 [opcua] 参数面自动生成且无寄存器泄漏
  - param=pp-dc3cfbf0 key=temp-sp unit=rpm
  - 含 register/dataType/driverConfig? 无 ✔
- ✔ **param-limits** (pass) — Line2 基准限界 [143.7,156.3] + 产品限界 [146.22,153.78] 设定
  - 有效交集(含配方窗) 141~159 → param 143.7~156.3 → product 146.22~153.78 · node 层 50~200（四层收窄：node ∩ param ∩ product ∩ recipe）
- ✔ **param-write-governed** (pass) — Line2 参数面写入联锁（交集内写入 · 越产品层拦截 · 越基准层拦截 · 参数读回）
  - 148.866 → ✔ 写入+回读
  - 155.04 → ✔ 产品层拦截
  - 157.65 → ✔ 基准限界层拦截
  - param read → ✔ 148.866rpm
- ✔ **agent-param-tools** (pass) — Line2 Agent param_control/param_read（语义写 · 越产品层拒 · 参数读 · 未绑定拒）
  - param_control 151.323 → ✔ record=opt-7bff5229
  - param_control 155.04 → ✔ 产品层拦截
  - param_read → ✔
  - unbound agent → ✔ 权限面拒绝

### P4m — AgentTeam optimization mission (task board → governed writes → attainment)

- ✔ **mission-board** (pass) — 任务板：优化任务下达并由 lead 派发
  - channel=66bca9f5-1c88-4231-a4a4-815123a8b68d parent=a821eedb-2f09-40de-87ea-af66ae105d60 leadChild=b8800aeb-e03c-460f-843d-6770938400ad assignee=536af93d-16fd-4805-b7b6-bae93e6f7c97
- ✔ **mission-timescale-read** (pass) — 时段数据读取（daq_query from/to/bucket）
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip168b09(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-09-22T00:13 ~ 2026-09-22T00:18(降采样 1000ms)   样本 33 
- ✔ **mission-governed-write** (pass) — 受治理参数下发（1 写全开记录+判定）
  - iter1: SP→204.704 ✔ · record=opened+judged · PV≈204.7 ✔
- ✔ **mission-journal** (pass) — 参数账本归因（Agent source 可追溯）
  - journal sample: 优化记录(4 条,含参数/判定/窗口): - opt-ab931b26 [judged-keep] L1-DCW-modbus-tcp ip168b09: 200 → 204.704,设定 00:18:23,判定 keep(agent:mission iter 1: PV=204.7 target=
- ✔ **mission-attained** (pass) — 优化目标达成（|PV−204.704|≤0.75）
  - writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass) — 任务收口（lead 派发→worker 剧本完成→父任务聚合）
  - terminalState=COMPLETED · writes=1 · reached=true

### P5 — 

- ✔ **agent-loop** (pass) — 真实 LLM Agent 闭环（omp）
  - 任务终态 COMPLETED（78.209s）
  - ✔ 交付含 INTEGRATED-CLOSEDLOOP-OK
  - harness=omp provider=zhipu-coding-plan model=glm-5.3-flash
  - 过程日志 → bench/results/20260921161746-x2w/agent-loop-omp.log（1 条消息）

### P5b — 

- ✔ **agent-goal** (pass) — 目标驱动闭环寻优（omp）
  - 任务终态 COMPLETED（498.994s）
  - ✔ GOAL-OPT-OK · 写≈3/6 · judge≈3 · 配方保存✔
  - 最终厚度 52.067 μm，目标 52±0.8 → 达标
  - 过程日志 → agent-goal-loop-omp.log

### P6 — Closed-loop optimization benchmark (multi-seed)

- ✔ **twin-nodes** (pass) — cast-film twin node provisioning（执行器 + 传感器）
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass) — 离线最优 W*（ground truth）
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-21T16:17:49.481Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ✔ **seed-42** (pass) — seed=42 闭环优化（J/J*=0.971）
  - 预热 0.004s（熔体温度 200.1℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.87μm defect=0.133% P=18.65MPa T=206.7℃ N=150 v=95.0 → J=66.52
  - iter1 下发 N=134 v=95 z=200 → h=49.23μm defect=0.450% P=16.37MPa T=203.0℃ → J=87.66 
  - iter2 下发 N=136 v=95 z=200 → h=49.28μm defect=0.650% P=16.55MPa T=201.3℃ → J=86.92 
- ✔ **seed-43** (pass) — seed=43 闭环优化（J/J*=0.971）
  - 预热 0.017s（熔体温度 201.3℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.53μm defect=0.233% P=18.65MPa T=206.6℃ N=150 v=95.0 → J=68.05
  - iter1 下发 N=135 v=95 z=200 → h=49.43μm defect=0.483% P=16.45MPa T=202.8℃ → J=87.50 
  - iter2 下发 N=137 v=95 z=200 → h=49.68μm defect=0.600% P=16.63MPa T=201.3℃ → J=87.03 
- ✔ **seed-44** (pass) — seed=44 闭环优化（J/J*=0.969）
  - 预热 0.014s（熔体温度 201.26℃，达工艺窗 [195,225]）
  - iter0 起点：h=56.13μm defect=0.050% P=18.65MPa T=207.0℃ N=150 v=95.0 → J=65.32
  - iter1 下发 N=134 v=95 z=200 → h=48.10μm defect=0.517% P=16.43MPa T=203.2℃ → J=87.45 
  - iter2 下发 N=139 v=95 z=200 → h=50.50μm defect=0.650% P=16.87MPa T=201.5℃ → J=86.76 
- ✔ **closedloop-aggregate** (pass) — 闭环优化聚合（n=3）
  - J/J*：min 0.969 · mean 0.97 · max 0.971（J* = 89.894）
  - J start均值 66.63 → end均值 87.219
  - 平均迭代 2  · 总写 6 · 越界rejected 0 · 收敛 3/3 · 平均墙钟 36.168s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass) — 多形态数采（向量/图像帧）
  - ✔ 向量轮廓帧 2 （47.189,46.64,47.516,47.69,47.675,48.247,48.644,48.413,48.361,48.259,49.283,48.983,49.427,49.751,49.574,49.392,48.705,49.891,48.693,49.85,49.798,49.727,49.258,50.216,49.912,50.082,50.706,50.21,49.649,50.217,50.47,49.906,49.5,50.67
  - ✔ 图像帧 2 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass) — second plant scenario applied: film-line
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] provisioned
  - line=ln-0089acb2 daq=dn-341ffa94 dcw=dw-d59a5c5f
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass) — scenario[film-line] line 2 [opcua] provisioned
  - line=ln-1ee61708 daq=dn-137a1e8d dcw=dw-f64e405a
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass) — scenario[film-line] line 3 [mqtt] provisioned
  - line=ln-51dade9b daq=dn-1e06a07b dcw=dw-0c004be0
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass) — scenario[film-line] line 4 [modbus-rtu] provisioned (satellite DAQ)
  - line=ln-51dade9b daq=dn-29ce0ba1 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass) — scenario[film-line] line 5 [http] provisioned (satellite DAQ)
  - line=ln-51dade9b daq=dn-ad7ae2c9 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **port-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] integration
  - ✔ DAQ samples 11 pts (modbus-tcp real driver)
  - ✔ governed write 186.24 → HTTP 200
  - readback deviation 0.04
  - ✔ F5 out-of-window 3/3 rejected · legal write accepted (0 false block)
- ✔ **port-2-opcua** (pass) — scenario[film-line] line 2 [opcua] integration
  - ✔ DAQ samples 12 pts (opcua real driver)
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

- ✔ **cleanup** (pass) — 遗留 open 记录清场（关闭 0/0 条）
  - records closed: 0/0
- ✔ **open-record** (pass) — 优化记录 opt-804ac690 已开（基线 186.1999969482422 → 176.88，auto 策略）
  - 下发成功:L1-DCW-modbus-tcp ip168b09p8(烘箱温度设定)设定 176.88℃ → PLC 原始值 176.88;回读 176.89999389648438℃一致。当前活动配方「Integrated工艺1 ip168b09p8」。写入并回读一致:176.8
- ✔ **freeze** (pass) — DAQ temp-pv 已冻结至 150（窗外，窗 [164.4, 195.6]）
  - device=dev-cd2f207f signal=temp-pv
- ✔ **backstop-verdict** (pass) — 系统兜底判定回退 + 自动恢复基线
  - 判定 by=system verdict=rollback · 时延 130.224s（环境类，节拍决定）
  - PLC 值 186.1999969482422 → 期望基线 186.1999969482422（±0.75） ✔
- ✔ **restore** (pass) — 过程量解冻 + 第一场景恢复: cast-film-physics
  - rig left as found

### P9 — Platform subsystems (team / memory / registry)

- ✔ **team-dispatch** (pass) — 团队调度（lead 派发 → worker 完成）
  - 终态 COMPLETED · assignee=6f2b2770-9fb6-45c4-8b46-2b2f76e65396（lead 认领父任务） · 子任务派发给 worker: ✔
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
| hitl | approval_latency_ms | 450 | ms | 挂起→批准（含 800ms 轮询粒度） |
| audit | journal_anchors | 11 |  | 本Line参数变更账本 |
| audit | audit_entries | 200 |  | 全局审计目 |
| audit | ops_logs | 200 |  | 全局运维日志 |
| recipe | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| gov | param_layer_checks_ok | 4 | /4 | 工艺参数映射层全链 |
| agent | agent_wall_s | 78.209 | s | omp |
| agent | agent_oracle_pass | 1 |  | 交付判据命中 |
| agent | goal_wall_s | 498.994 | s | omp |
| agent | goal_attained | 1 |  | 模型自定参数达成目标值 |
| closedloop | J_over_Jstar_mean | 0.97 |  | n=3 seeds，写路径=governed |
| closedloop | J_over_Jstar_min | 0.969 |  | 最差 seed（保守下界） |
| closedloop | J_end_mean | 87.219 |  | J* = 89.894 |
| closedloop | cl_iters_mean | 2 |  | 闭环收敛迭代数 |
| closedloop | cl_writes_total | 6 |  | 受治理的闭环写总数 |
| closedloop | cl_rejected_total | 0 |  | 越界被拒（治理拦截） |
| daq | vector_frames | 2 |  | 厚度横向轮廓 |
| daq | image_frames | 2 |  | CCD 表面图像 |
| portability | scenario2_lines | 3 |  | second preset "film-line" (config-only) |
| portability | scenario2_intercept_rate | 1 |  | F5 out-of-window interception on second scenario |
| portability | scenario2_false_blocks | 0 |  | legal in-window writes blocked on second scenario |
| gov | backstop_fired | 1 |  | system-judged rollback on window breach |
| gov | backstop_restored | 1 |  | auto-restore to record baseline |
| gov | backstop_latency_s | 130.224 | s | freeze → verdict (environmental) |
| biax | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| biax | sp_signals | 30 |  | 可写工艺 SP |
| biax | created_missing | 9 |  | 本次补建的缺失设备数 |
| biax | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| biax | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| biax | mission_writes | 4 |  | AgentTeam 双拉任务受治理写次数 |
| biax | mission_distinct_knobs | 3 |  | 参与闭环的执行节点数 |
| biax | mission_attained | 1 |  | 厚度达标 25.0±0.7μm |
| biax | mission_final_thickness | 25.32 | μm | 终态厚度 |
| scenario | injection_attained | 1 |  | 注塑成型质量窗口寻优 |
| scenario | injection_writes | 3 |  | 注塑成型质量窗口寻优 |
| scenario | wwtp_attained | 1 |  | A2O 污水生化处理达标降耗 |
| scenario | wwtp_writes | 15 |  | A2O 污水生化处理达标降耗 |
| scenario | anneal_attained | 1 |  | 连续退火质量窗内产能最大化 |
| scenario | anneal_writes | 6 |  | 连续退火质量窗内产能最大化 |
| scenario | biax_attained | 1 |  | 双拉(BOPET)薄膜产线多节点闭环 |
| scenario | biax_writes | 4 |  | 双拉(BOPET)薄膜产线多节点闭环 |
| team | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| memory | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| agent | harness_registry | 14 |  | environment-available 14 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict PASS, grade A). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._
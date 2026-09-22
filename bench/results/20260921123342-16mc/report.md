# AW-IndustrialBench · Integrated Pipeline Report

> **PASS** — score **98.8**/100, grade **A**. Hard gate green: no failed checks or phases; skips are honest environmental exclusions.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20260921123342-16mc` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `0c8f9705e2e8502f` (sha256 over 11 checker sources) |
| Git commit | `e692df1` |
| Runtime | v24.19.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3005 · http://127.0.0.1:4011 |
| Tool harness | opencode (deterministic) · LLM agent: (none) |
| Reproduce | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 58 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 30.191 ms | incl. real protocol transactions |
| Closed-loop J/J* | 97.1 % | n=3 seeds · worst 97.0% · J*=89.894 |
| Tool-level loops | 4 | dcw→daq→judge ×3 convergence |
| Param-layer governance | 4/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | fired+restored | window breach → auto-rollback in 130.157s (env) |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 3 knobs · 6 writes → 12.22μm |
| LLM agent loop | off | --agent omp enables |
| Verdict | PASS | 76/80 checks · hard gate green |

## Simulated production line profile

> Preset `cast-film-physics` — Cast-film extrusion digital twin (plant-model physics engine). An extrusion cast-film line: resin → screw melting → die → casting → thickness gauge. Six writable setpoints (3 zone temperatures, screw speed, line speed, die gap) act on a physics engine whose observable process quantities are melt temperature, melt pressure, film thickness, defect rate and gels count.

**Physics.** Deterministic plant model (seeded): first-order thermal lag on melt temperature, algebraic thickness h ∝ N/v from mass conservation, pressure/defect couplings — scored by J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput.
 Plant engine state at report time: phase=`warmup`, seed=`42`.

**Totals.** 20 PLC devices across 5 protocols (modbus-tcp, modbus-rtu, opcua, mqtt, http); **31 writable setpoints (SP → DCW nodes)** and **46 process quantities (PV → DAQ nodes)**; the platform side provisions 12 lines with 68 write nodes and 75 acquisition nodes.

### Devices & fieldbus endpoints

| # | Device | Protocol | Endpoint | Signals (SP+PV) |
|---:|---|---|---|---:|
| 1 | 挤出主机PLC(Modbus TCP) | `modbus-tcp` | `0.0.0.0:17040 unit=1` | 4 |
| 2 | 晶点计数从站(Modbus RTU) | `modbus-rtu` | `0.0.0.0:16041 unit=1` | 1 |
| 3 | 熔体泵送单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:6840` | 2 |
| 4 | 在线测厚仪(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 2 |
| 5 | CCD检测站(HTTP) | `http` | `http endpoint` | 4 |
| 6 | 注塑主机PLC(Modbus TCP) | `modbus-tcp` | `0.0.0.0:17052 unit=1` | 7 |
| 7 | 曝气风机站(Modbus TCP) | `modbus-tcp` | `0.0.0.0:17054 unit=1` | 3 |
| 8 | 加热段炉(Modbus TCP) | `modbus-tcp` | `0.0.0.0:17056 unit=1` | 5 |
| 9 | 模温机与锁模单元(Modbus RTU) | `modbus-rtu` | `0.0.0.0:16052 unit=1` | 4 |
| 10 | 加药单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:6844` | 4 |
| 11 | 炉内传动与速度单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:6845` | 2 |
| 12 | 注射/保压单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:6843` | 4 |
| 13 | 回流与排泥单元(Modbus RTU) | `modbus-rtu` | `0.0.0.0:16054 unit=1` | 4 |
| 14 | 冷却与过时效段(Modbus RTU) | `modbus-rtu` | `0.0.0.0:16056 unit=1` | 3 |
| 15 | 进水泵房(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 3 |
| 16 | 冷却水单元(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 3 |
| 17 | 保护气单元(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 3 |
| 18 | 出水水质检测站(HTTP) | `http` | `http endpoint` | 6 |
| 19 | 制品质量检测站(HTTP) | `http` | `http endpoint` | 7 |
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
| 冷却与过时效段(Modbus RTU) | 过时效温度SP (`oa-temp-sp`) | SP (writable setpoint) | ℃ | [320, 480] | 1 | `manual` |
| 冷却与过时效段(Modbus RTU) | 冷却档位SP (`cool-rate-sp`) | SP (writable setpoint) | % | [20, 100] | 0 | `manual` |
| 冷却与过时效段(Modbus RTU) | OaTempPV (`oa-temp-pv`) | PV (process quantity) | ℃ | [20, 520] | 1 | `constant` |
| 进水泵房(MQTT) | InflowSP (`influent-flow-sp`) | SP (writable setpoint) | m³/h | [400, 1600] | 0 | `manual` |
| 进水泵房(MQTT) | CodIn (`cod-in-pv`) | PV (process quantity) | mg/L | [100, 900] | 0 | `constant` |
| 进水泵房(MQTT) | Nh3In (`nh3-in-pv`) | PV (process quantity) | mg/L | [10, 80] | 1 | `constant` |
| 冷却水单元(MQTT) | CoolWaterSP (`cool-water-sp`) | SP (writable setpoint) | ℃ | [10, 45] | 1 | `manual` |
| 冷却水单元(MQTT) | WaterTempPV (`water-temp-pv`) | PV (process quantity) | ℃ | [5, 60] | 1 | `constant` |
| 冷却水单元(MQTT) | CoolFlowPV (`cool-flow-pv`) | PV (process quantity) | L/min | [0, 80] | 1 | `constant` |
| 保护气单元(MQTT) | H2RatioSP (`h2-ratio-sp`) | SP (writable setpoint) | % | [3, 15] | 1 | `manual` |
| 保护气单元(MQTT) | DewPoint (`dew-point-pv`) | PV (process quantity) | ℃ | [-70, 0] | 1 | `constant` |
| 保护气单元(MQTT) | H2Act (`h2-act-pv`) | PV (process quantity) | % | [0, 20] | 1 | `constant` |
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
| 成品质量检测站(HTTP) | Hardness (`hardness`) | PV (process quantity) | HV | [60, 200] | 1 | `constant` |
| 成品质量检测站(HTTP) | Tensile (`tensile`) | PV (process quantity) | MPa | [200, 500] | 1 | `constant` |
| 成品质量检测站(HTTP) | YieldStr (`yield-str`) | PV (process quantity) | MPa | [100, 400] | 1 | `constant` |
| 成品质量检测站(HTTP) | GrainSize (`grain-size`) | PV (process quantity) | μm | [2, 30] | 2 | `constant` |
| 成品质量检测站(HTTP) | SurfaceDef (`surface-defect`) | PV (process quantity) | % | [0, 5] | 3 | `constant` |
| 成品质量检测站(HTTP) | Flatness (`flatness`) | PV (process quantity) | I | [0, 100] | 2 | `constant` |

### Platform-side node mapping (AW write-control / acquisition nodes)

| Node | Kind | Driver | Line | Unit | Range |
|---|---|---|---|---|---|
| L1-DCW-modbus-tcp ip16879b (`dw-a359574`) | DCW write | `modbus-tcp` | Integrated线1 ip16879b | ℃ | [120, 260] |
| L2-DCW-opcua ip16879b (`dw-14c06db`) | DCW write | `opcua` | Integrated线2 ip16879b | rpm | [50, 200] |
| L3-DCW-mqtt ip16879b (`dw-d16c298`) | DCW write | `mqtt` | Integrated线3 ip16879b | m/min | [20, 120] |
| L4-DCW-http ip16879b (`dw-fa202f8`) | DCW write | `http` | Integrated线4 ip16879b | mm | [0.5, 2] |
| 加热区1SP ip16879bcl (`dw-f09d5b8`) | DCW write | `modbus-tcp` | CastFilm线 ip16879bcl | ℃ | [120, 260] |
| 加热区2SP ip16879bcl (`dw-e2d08c5`) | DCW write | `modbus-tcp` | CastFilm线 ip16879bcl | ℃ | [120, 260] |
| 加热区3SP ip16879bcl (`dw-7982084`) | DCW write | `modbus-tcp` | CastFilm线 ip16879bcl | ℃ | [120, 260] |
| ScrewSpeedSP ip16879bcl (`dw-00039fc`) | DCW write | `opcua` | CastFilm线 ip16879bcl | rpm | [50, 200] |
| lineSpeedSP ip16879bcl (`dw-7126e9d`) | DCW write | `mqtt` | CastFilm线 ip16879bcl | m/min | [20, 120] |
| dieGapSP ip16879bcl (`dw-746ee77`) | DCW write | `http` | CastFilm线 ip16879bcl | mm | [0.5, 2] |
| L1-DCW-modbus-tcp ip16879bp8 (`dw-2ef1c03`) | DCW write | `modbus-tcp` | Integrated线1 ip16879bp8 | ℃ | [0, 260] |
| L2-DCW-opcua ip16879bp8 (`dw-41261b8`) | DCW write | `opcua` | Integrated线2 ip16879bp8 | ℃ | [0, 260] |
| L3-DCW-mqtt ip16879bp8 (`dw-3909eb2`) | DCW write | `mqtt` | Integrated线3 ip16879bp8 | ℃ | [0, 100] |
| 干燥温度SP·ip16879b (`dw-b328b8e`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16879b | ℃ | [120, 200] |
| 露点SP·ip16879b (`dw-566609b`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16879b | ℃ | [-80, -20] |
| 喂料速率SP·ip16879b (`dw-f8803c9`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16879b | kg/h | [100, 1200] |
| 机筒温度区1SP·ip16879b (`dw-b200256`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [220, 300] |
| 机筒温度区2SP·ip16879b (`dw-51f7b16`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [220, 300] |
| 机筒温度区3SP·ip16879b (`dw-518ddd1`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [220, 300] |
| 机筒温度区4SP·ip16879b (`dw-f8f78e9`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [220, 300] |
| 机筒温度区5SP·ip16879b (`dw-0e1bc39`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [220, 300] |
| 螺杆转速SP·ip16879b (`dw-baecfd2`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | rpm | [20, 100] |
| 计量泵转速SP·ip16879b (`dw-07ccc81`) | DCW write | `modbus-rtu` | 双拉薄膜产线 biax-ip16879b | rpm | [15, 60] |
| 模唇温度SP·ip16879b (`dw-6e974ba`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [250, 300] |
| 急冷辊温度SP·ip16879b (`dw-27fe70b`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [10, 60] |
| 铸片辊速度SP·ip16879b (`dw-3cb90b7`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | m/min | [10, 60] |
| 静电吸附电压SP·ip16879b (`dw-4bd812a`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | kV | [4, 12] |
| 预热辊1温度SP·ip16879b (`dw-978806c`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [70, 140] |
| 预热辊2温度SP·ip16879b (`dw-96a15b9`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [70, 140] |
| 预热辊3温度SP·ip16879b (`dw-e322a7f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [70, 140] |
| 慢辊线速度SP·ip16879b (`dw-510c163`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | m/min | [10, 80] |
| 快辊线速度SP·ip16879b (`dw-471afb7`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | m/min | [30, 260] |
| 纵拉退火辊SP·ip16879b (`dw-bcd2045`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [90, 170] |
| TDO预热段SP·ip16879b (`dw-2bb66f9`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16879b | ℃ | [80, 140] |
| TDO拉伸段SP·ip16879b (`dw-ca742a7`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16879b | ℃ | [90, 150] |
| TDO定型段SP·ip16879b (`dw-56c6b56`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16879b | ℃ | [180, 250] |
| 链夹速度SP·ip16879b (`dw-7a0e24d`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16879b | m/min | [40, 260] |
| 出口轨宽SP·ip16879b (`dw-568d058`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16879b | mm | [1800, 4200] |
| coronaPower·ip16879b (`dw-24b8284`) | DCW write | `http` | 双拉薄膜产线 biax-ip16879b | kW | [0.5, 8] |
| 收卷张力SP·ip16879b (`dw-aa3a645`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | N | [30, 180] |
| L1-DAQ-modbus-tcp ip16879b (`dn-c6acc33`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16879b | ℃ | [0, 400] |
| L2-DAQ-opcua ip16879b (`dn-3798c17`) | DAQ acquire | `opcua` | Integrated线2 ip16879b | MPa | [0, 45] |
| L3-DAQ-mqtt ip16879b (`dn-191dba4`) | DAQ acquire | `mqtt` | Integrated线3 ip16879b | μm | [0, 400] |
| L4-DAQ-http ip16879b (`dn-42576a9`) | DAQ acquire | `http` | Integrated线4 ip16879b | μm | [0, 400] |
| L5-DAQ-modbus-rtu ip16879b(sat) (`dn-3267adf`) | DAQ acquire | `modbus-rtu` | Integrated线4 ip16879b | 个/m² | [0, 500] |
| 熔体温度 ip16879bcl (`dn-63c50ee`) | DAQ acquire | `modbus-tcp` | CastFilm线 ip16879bcl | ℃ | [0, 400] |
| 晶点计数 ip16879bcl (`dn-20fa188`) | DAQ acquire | `modbus-rtu` | CastFilm线 ip16879bcl | 个/m² | [0, 500] |
| MeltPressure ip16879bcl (`dn-1d42c16`) | DAQ acquire | `opcua` | CastFilm线 ip16879bcl | MPa | [0, 45] |
| thick ip16879bcl (`dn-d06fabb`) | DAQ acquire | `mqtt` | CastFilm线 ip16879bcl | μm | [0, 400] |
| defect ip16879bcl (`dn-62c425e`) | DAQ acquire | `http` | CastFilm线 ip16879bcl | % | [0, 100] |
| profile ip16879b (`dn-9b169fd`) | DAQ acquire | `http` | Integrated线1 ip16879b | mm | [0.4, 0.65] |
| ccd ip16879b (`dn-0dddcb4`) | DAQ acquire | `http` | Integrated线1 ip16879b | 灰度 | [0, 255] |
| L1-DAQ-modbus-tcp ip16879bp8 (`dn-94aef9f`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16879bp8 | ℃ | [0, 260] |
| L2-DAQ-opcua ip16879bp8 (`dn-bf60092`) | DAQ acquire | `opcua` | Integrated线2 ip16879bp8 | ℃ | [0, 260] |
| L3-DAQ-mqtt ip16879bp8 (`dn-5533899`) | DAQ acquire | `mqtt` | Integrated线3 ip16879bp8 | ℃ | [0, 100] |
| L4-DAQ-modbus-rtu ip16879bp8(sat) (`dn-7ad4202`) | DAQ acquire | `modbus-rtu` | Integrated线3 ip16879bp8 | ℃ | [0, 100] |
| L5-DAQ-http ip16879bp8(sat) (`dn-539984e`) | DAQ acquire | `http` | Integrated线3 ip16879bp8 | L/min | [0, 100] |
| 干燥塔温度·ip16879b (`dn-f617738`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16879b | ℃ | [20, 220] |
| 切片残水·ip16879b (`dn-ade99e3`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16879b | ppm | [0, 120] |
| 熔体温度·ip16879b (`dn-d7933a4`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [200, 330] |
| 泵前熔压·ip16879b (`dn-4f65326`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | MPa | [0, 35] |
| 泵出口压力·ip16879b (`dn-d0d94a4`) | DAQ acquire | `modbus-rtu` | 双拉薄膜产线 biax-ip16879b | MPa | [0, 35] |
| 铸片辊面温度·ip16879b (`dn-dce5a90`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [0, 80] |
| 纵拉膜温·ip16879b (`dn-c0f4556`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16879b | ℃ | [40, 160] |

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
| P10 | Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop) | 9 | 1 | 0 | 0 | 95.0 | 3 |
| P11 |  | 2 | 3 | 0 | 0 | 70.0 | 1 |
| **Overall** | | | | | | **98.8** | 38 |

## Closed-loop optimization · per-seed

| Seed | J0 | Jend | J* | J/J* % | Iters | Governed writes | Rejected | Converged |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 42 | 68.36 | 87.29 | 89.89 | 97.1 | 2 | 2 | 0 | yes |
| 43 | 68.87 | 87.24 | 89.89 | 97.0 | 2 | 2 | 0 | yes |
| 44 | 69.81 | 87.29 | 89.89 | 97.1 | 2 | 2 | 0 | yes |

## AgentTeam closed-loop tuning walkthrough

How an optimization team is assembled and drives the line, end to end: (1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; (2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); (3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; (4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; (5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.

### Biax (BOPET) multi-node mission — iteration trace

| Iter | Knob | Node | From → To | Thickness μm | Note |
|---|---|---|---|---:|---|
| 0 | — | `—` | — | 9.37 |  |
| 0 | — | `—` | — | 27.90 | post-rebase#1 |
| 1 | cast-spd-sp | `dw-3cb90b7a` | 32 → 33.7 | 21.30 |  |
| 2 | fast-roll-sp | `dw-471afb71` | 118 → 110.8 | 28.38 |  |
| 3 | rail-out-sp | `dw-568d0586` | 3000 → 3107 | 21.84 |  |
| 4 | cast-spd-sp | `dw-3cb90b7a` | 33.70000076293945 → 31.3 | 23.56 |  |
| 5 | fast-roll-sp | `dw-471afb71` | 110.80000305175781 → 108.4 | 24.04 |  |
| 6 | rail-out-sp | `dw-568d0586` | 3107 → 3070 | 12.22 |  |

Governed writes: **6** on 3 distinct knob(s) · optimization records: 6 · target window 25 ± 0.7 μm · final thickness reading **12.22 μm** · target attained: **no**.

### Deterministic closed-loop benchmark — seed 42 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.53 | 0.133 | 18.65 | 206.6 | 150 | 95.0 | 200.0 | 68.36 | 0 |
| 1 | 48.95 | 0.450 | 16.48 | 203.0 | 135 | 95.0 | 200.0 | 87.60 | 24.108 |
| 2 | 50.00 | 0.600 | 16.75 | 201.2 | 138 | 95.0 | 200.0 | 86.97 | 36.154 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.1 %**; governed writes 2 (rejected 0), optimization records 2.

### Deterministic closed-loop benchmark — seed 43 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.38 | 0.233 | 18.67 | 207.1 | 150 | 95.0 | 200.0 | 68.87 | 0 |
| 1 | 49.20 | 0.500 | 16.50 | 202.8 | 135 | 95.0 | 200.0 | 87.45 | 24.092 |
| 2 | 49.62 | 0.600 | 16.62 | 201.3 | 137 | 95.0 | 200.0 | 87.03 | 36.152 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.0 %**; governed writes 2 (rejected 0), optimization records 2.

### Deterministic closed-loop benchmark — seed 44 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.32 | 0.050 | 18.72 | 207.1 | 150 | 95.0 | 200.0 | 69.81 | 0 |
| 1 | 49.68 | 0.433 | 16.67 | 203.1 | 136 | 95.0 | 200.0 | 87.60 | 24.107 |
| 2 | 49.48 | 0.617 | 16.63 | 201.4 | 137 | 95.0 | 200.0 | 86.97 | 36.175 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.1 %**; governed writes 2 (rejected 0), optimization records 2.

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `agentteam-mission.log` | 1.0 KB | AgentTeam optimization mission — full task-board trajectory |
| `agentteam-biax.log` | 2.0 KB | AgentTeam biax multi-node mission — full trajectory |
| `line-profile.json` | 62.7 KB | Simulated line profile — devices, protocols, endpoints, SP/PV signal inventory, AW node mapping |
| `metrics.csv` | 3.1 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 136.8 KB | Full machine-readable results (checks, phases, evidence, KPIs, line profile, agent-team traces) |
| `summary.json` | 18.0 KB | Verdict + KPI + per-line summary (compare/aggregate input) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✔ **platform-reachable** (pass) — platform reachable & authenticated
  - 平台 http://127.0.0.1:3005：自动分离启动 pid=59736（日志 D:\codes\ABO\aw-bench-platform.log）
  - 鉴权 OK (register-first-admin)
  - simulator http://127.0.0.1:4011：already up (reused)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass) — 预设 cast-film-physics 已应用
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **offline-optimum** (pass) — offline optimum W* (ground truth) available
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-21T12:33:47.698Z"}

### P10 — Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)

- ✔ **biax-ensure** (pass) — 节点探测补建(9 建缺失 / 0 修复 / 0 原样)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass) — 五协议多节点建线(DCW 30 + DAQ 19,驱动实测 9/9)
  - line=ln-84e65096 recipe=rc-dcd0b499 started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass) — 测厚仪真实链路采样(3 点)
  - daq=dn-97ec0414 · samples=3
- ✔ **biax-agent-cards** (pass) — Agent 语义卡含双拉工艺描述(semantics 贯通)
  - 语义卡长度 22543 · 关键词命中 铸片辊速度/横向拉伸比/收卷张力
  - sample: #### ◆ L1-DCW-modbus-tcp ip16879b [id=dw-a359574e] - 物理量: 烘箱温度设定,单位 ℃,精度 1 位小数 - 工艺语义: 模拟器设备「挤出主机PLC(Modbus TCP)」的 加热区1SP（真实 modbus-tcp 写控） - 安全量程: [120, 260] ℃
- ✔ **biax-mission-board** (pass) — 任务板:双拉优化任务下达并由 lead 派发
  - parent task + lead child: ✔
- ✔ **biax-mission-multinode** (pass) — 多节点受治理写(3 个执行节点 / 6 写)
  - 1. task board: channel=900f61ac-155c-4af6-a124-a0e81bfe81d4 parent=b9428e85-5a5f-40b9-ba32-c8084fcb83e8 leadChild=6c95e93e-2747-4e9f-ba6d-262d4f9f7cdf
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.1,3.5,1.6]
  - 3. initial thickness=9.37 μm(目标 25±0.7)
  - 2.5 断膜恢复#1: warm 复位(✘ ) + 配方基线重下(✔)
- ▲ **biax-mission-attained** (warn) — 厚度目标达成(|PV−25.0|≤0.7μm,final=12.22)
  - writes=6/6 · distinctKnobs=3 · final=12.22μm
  -         meltTemp=291.5℃(安全窗 268~300)
  - 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(2 条,含参数/判定/窗口): - opt-d13cc950 [judged-keep] 铸片辊速度SP·ip16879b: 33.7 → 31.3,设定 20:42:13,判定 keep(agent:biax mission i
  - 5. outcome: writes=6 distinctKnobs=3 final=12.22μm attained=false
- ✔ **biax-mission-journal** (pass) — 参数账本 Agent 归因(铸速节点)
- ✔ **biax-mission-closed** (pass) — 任务收口(父任务 COMPLETED)
  - terminal=COMPLETED
- ✔ **biax-restore** (pass) — 双拉线停止 + 第一场景恢复: cast-film-physics
  - rig left as found

### P11 — 

- ✔ **scen-injection** (pass) — 注塑成型质量窗口寻优(writes=3, wall=34.16s)
  - baseline 克重=31.28g(目标 32.5±0.35)
  - iter1: hold-pressure-sp 45→57.92 ✔ record=yes · 克重→31.92g
  - iter2: hold-time-sp 6→10.61 ✔ record=yes · 克重→32.15g
  - iter3: hold-pressure-sp 57.9→61.64 ✔ record=yes · 克重→32.31g
- ✔ **scen-wwtp** (pass) — A2O 污水生化处理达标降耗(writes=15, wall=156.88s)
  - baseline DO=0.23 COD=360 NH3=34.5 TP=0.66 pH=6.58 → 不达标
  - iter1(曝气): 风机 26→30.04 ✔
  - iter2(曝气): 风机 30→31.7 ✔
  - iter3(曝气): 风机 31.700000762939453→32.5 ✔
- ▲ **scen-anneal** (warn) — 连续退火质量窗内产能最大化(writes=3, wall=58.11s)
  - baseline 硬度=134.7HV 抗拉=311MPa 线速=140m/min → 窗外
  - iter1: zone3-sp 730→850 ✔
  - iter6(产能): 线速 140→152 ✔ 硬度 100.7HV 仍在窗内
  - iter7(产能): 线速 152→164 硬度 101.5HV 出窗 → 回退 ✔
- ▲ **scen-biax** (warn) — 双拉(BOPET)薄膜产线多节点闭环(writes=6, wall=nulls, 线复用)
  - 1. task board: channel=900f61ac-155c-4af6-a124-a0e81bfe81d4 parent=b9428e85-5a5f-40b9-ba32-c8084fcb83e8 leadChild=6c95e93e-2747-4e9f-ba6d-262d4f9f7cdf
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.1,3.5,1.6]
  - 3. initial thickness=9.37 μm(目标 25±0.7)
  - 2.5 断膜恢复#1: warm 复位(✘ ) + 配方基线重下(✔)
- ▲ **scen-report** (warn) — 多场景 benchmark 报告(scenarios-benchmark.md/.html)
  - bench/results/20260921123342-16mc/scenarios-benchmark.md
  - 并行 wall=159.89s

### P2 — Multi-protocol line provisioning

- ✔ **gateway** (pass) — gateway controller start (idempotent)
  - POST /api/workshop/daq/controller {action:start}
  - 采样仍受「活动Line批」门控，故每台有 SP 的devices自成一可开跑Line
- ✔ **line-1-modbus-tcp** (pass) — Line1 [modbus-tcp] 供给
  - line=ln-09aa721d daq=dn-c6acc33d dcw=dw-a359574e recipe=rc-819dc39e
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 210.6999969482422
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass) — Line2 [opcua] 供给
  - line=ln-75fdb422 daq=dn-3798c17a dcw=dw-14c06dbf recipe=rc-41ea86bb
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 18.479
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass) — Line3 [mqtt] 供给
  - line=ln-6c26afed daq=dn-191dba47 dcw=dw-d16c298c recipe=rc-b116ad8d
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,收到 aw/sim/thick = 55.73
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass) — Line4 [http] 供给
  - line=ln-9b0ab90b daq=dn-42576a96 dcw=dw-fa202f8c recipe=rc-66568acc
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 0.325
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass) — Line5 [modbus-rtu] 供给（satellite DAQ）
  - line=ln-9b0ab90b daq=dn-3267adf4 dcw=✘ recipe=rc-66568acc ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 4
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ · governed write · F5 interlock

- ✔ **line-1-io** (pass) — Line1 [modbus-tcp] integration check
  - ✔ DAQ samples stored 11  points (modbus-tcp real driver）
  - ✔ 约6写 p50=47.977ms p95=48.871ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass) — Line2 [opcua] integration check
  - ✔ DAQ samples stored 10  points (opcua real driver）
  - ✔ 约6写 p50=20.288ms p95=21.177ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass) — Line3 [mqtt] integration check
  - ✔ DAQ samples stored 11  points (mqtt real driver）
  - ✔ 约6写 p50=19.689ms p95=20.796ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass) — Line4 [http] integration check
  - ✔ DAQ samples stored 12  points (http real driver）
  - ✔ 约6写 p50=32.81ms p95=33.86ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass) — Line5 [modbus-rtu] integration check
  - ✔ DAQ samples stored 14  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass) — 闭环夹具（channel+agent）
  - channel=1dedf80f-3b49-46e2-9a33-08821ff17038
  - agent=c20d7eb1-7a22-4ba9-b4ea-dda240ea42e6
  - harness=opencode
- ✔ **tool-bridge** (pass) — opencode 的 host 工具直调面可用
  - 探测 my_industrial_nodes → 你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。
- ✔ **line-1-loop** (pass) — Line1 [modbus-tcp] Agent 闭环收敛（3/3 轮）
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔ · judge ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔ · judge ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.459s
- ✔ **line-2-loop** (pass) — Line2 [opcua] Agent 闭环收敛（3/3 轮）
  - iter1: SP→144.6 ✔ · 回读 145 ✔ · daq ✔ · judge ✔
  - iter2: SP→147.3 ✔ · 回读 147 ✔ · daq ✔ · judge ✔
  - iter3: SP→150 ✔ · 回读 150 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.34s
- ✔ **line-3-loop** (pass) — Line3 [mqtt] Agent 闭环收敛（3/3 轮）
  - iter1: SP→91.4 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→93.2 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→95 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.33s
- ✔ **line-4-loop** (pass) — Line4 [http] Agent 闭环收敛（3/3 轮）
  - iter1: SP→0.946 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→0.973 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→1 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.366s
- ✔ **plant-response** (pass) — 工艺模型响应（SP→plant truth 随动）
  - 真值样本 6 → 81
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":243,"defect":0.69,"engi

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass) — Line1 优化记录生命周期
  - current 204.6999969482422 → record A writes 208.06 (up)，记录 B writes 201.34 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-46b05cdb verdict keep → 判定已入册:记录 opt-46b05cdb → keep(bench: 回读一致，判定 keep)。已定档为已验证经验(配方已标记 last
  - ✔ (rollback path) record opt-62299719 verdict rollback (recorded only; PLC still 201.3000030517578)
  - ✔ rollback executed (status 200) → readback 208.10000610351562 (expected record B from=208.06)
- ✔ **line-1-rbjudge** (pass) — Line1 撤销记录 opt-1297d21a 判定关闭
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass) — Line1 node-level single-step rollback (undo stack)
  - ✔ write 205.04 effective (readback 205, before 208.10000610351562)
  - ✔ journal rollback 受理（status 200，记录 opt-1297d21a）
  - ✔ readback after rollback 208.10000610351562 (expected back to 208.10000610351562, tolerance 0.75)
- ✔ **param-ledger** (pass) — 参数台账（三值对照 + 在册历史）
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ✔ **line-2-hitl** (pass) — Line2 HITL 审批闭环
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-f39f6ce6（detail: L2-DCW-opcua ip16879b(烘箱温度设定)设定 148.2rpm,有效写入区间 141~159rpm(节点安全量程 ∩ 配方）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 下发成功:L2-DCW-opcua ip16879b(烘箱温度设定)设定 148.2rpm → PLC 原始值 148.2;回读 148.2rpm一致。当前活动配方「Integra
  - ✔ post-approval PLC effect: readback 148 (expected 148.2)
  - 审批裁决时延 18 ms（挂起→批准，含轮询周期）

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
  - ✔ (3) 标记已知良好批次 runId=rr-b4a83d00 → lastGood=rr-b4a83d00
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass) — Line2 [opcua] recipe lifecycle
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-705bcde9 → lastGood=rr-705bcde9
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ✔ **param-facade** (pass) — Line2 [opcua] 参数面自动生成且无寄存器泄漏
  - param=pp-69a2ba27 key=temp-sp unit=rpm
  - 含 register/dataType/driverConfig? 无 ✔
- ✔ **param-limits** (pass) — Line2 基准限界 [143.7,156.3] + 产品限界 [146.22,153.78] 设定
  - 有效交集(含配方窗) 141~159 → param 143.7~156.3 → product 146.22~153.78 · node 层 50~200（四层收窄：node ∩ param ∩ product ∩ recipe）
- ✔ **param-write-governed** (pass) — Line2 参数面写入联锁（交集内写入 · 越产品层拦截 · 越基准层拦截 · 参数读回）
  - 148.866 → ✔ 写入+回读
  - 155.04 → ✔ 产品层拦截
  - 157.65 → ✔ 基准限界层拦截
  - param read → ✔ 148.866rpm
- ✔ **agent-param-tools** (pass) — Line2 Agent param_control/param_read（语义写 · 越产品层拒 · 参数读 · 未绑定拒）
  - param_control 151.323 → ✔ record=opt-98c84eca
  - param_control 155.04 → ✔ 产品层拦截
  - param_read → ✔
  - unbound agent → ✔ 权限面拒绝

### P4m — AgentTeam optimization mission (task board → governed writes → attainment)

- ✔ **mission-board** (pass) — 任务板：优化任务下达并由 lead 派发
  - channel=b27dc750-6f25-452f-84a9-9f2ab6e12e2f parent=9d259e4f-b45f-4f13-b3c6-100b58bc4430 leadChild=aefc3b7b-27c8-4f83-aebb-2667f3e6bc6f assignee=e89935b8-65e2-4c6b-ae62-d382d219c13d
- ✔ **mission-timescale-read** (pass) — 时段数据读取（daq_query from/to/bucket）
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip16879b(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-09-21T20:29 ~ 2026-09-21T20:34(降采样 1000ms)   样本 35 
- ✔ **mission-governed-write** (pass) — 受治理参数下发（1 写全开记录+判定）
  - iter1: SP→204.704 ✔ · record=opened+judged · PV≈204.7 ✔
- ✔ **mission-journal** (pass) — 参数账本归因（Agent source 可追溯）
  - journal sample: 优化记录(4 条,含参数/判定/窗口): - opt-d9b05df1 [judged-keep] L1-DCW-modbus-tcp ip16879b: 200 → 204.704,设定 20:34:26,判定 keep(agent:mission iter 1: PV=204.7 target=
- ✔ **mission-attained** (pass) — 优化目标达成（|PV−204.704|≤0.75）
  - writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass) — 任务收口（lead 派发→worker 剧本完成→父任务聚合）
  - terminalState=COMPLETED · writes=1 · reached=true

### P6 — Closed-loop optimization benchmark (multi-seed)

- ✔ **twin-nodes** (pass) — cast-film twin node provisioning（执行器 + 传感器）
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass) — 离线最优 W*（ground truth）
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-21T12:33:47.698Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ✔ **seed-42** (pass) — seed=42 闭环优化（J/J*=0.971）
  - 预热 0.02s（熔体温度 200.5℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.53μm defect=0.133% P=18.65MPa T=206.6℃ N=150 v=95.0 → J=68.36
  - iter1 下发 N=135 v=95 z=200 → h=48.95μm defect=0.450% P=16.48MPa T=203.0℃ → J=87.60 
  - iter2 下发 N=138 v=95 z=200 → h=50.00μm defect=0.600% P=16.75MPa T=201.2℃ → J=86.97 
- ✔ **seed-43** (pass) — seed=43 闭环优化（J/J*=0.97）
  - 预热 0.015s（熔体温度 201.24℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.38μm defect=0.233% P=18.67MPa T=207.1℃ N=150 v=95.0 → J=68.87
  - iter1 下发 N=135 v=95 z=200 → h=49.20μm defect=0.500% P=16.50MPa T=202.8℃ → J=87.45 
  - iter2 下发 N=137 v=95 z=200 → h=49.62μm defect=0.600% P=16.62MPa T=201.3℃ → J=87.03 
- ✔ **seed-44** (pass) — seed=44 闭环优化（J/J*=0.971）
  - 预热 0.017s（熔体温度 201.36℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.32μm defect=0.050% P=18.72MPa T=207.1℃ N=150 v=95.0 → J=69.81
  - iter1 下发 N=136 v=95 z=200 → h=49.68μm defect=0.433% P=16.67MPa T=203.1℃ → J=87.60 
  - iter2 下发 N=137 v=95 z=200 → h=49.48μm defect=0.617% P=16.63MPa T=201.4℃ → J=86.97 
- ✔ **closedloop-aggregate** (pass) — 闭环优化聚合（n=3）
  - J/J*：min 0.97 · mean 0.971 · max 0.971（J* = 89.894）
  - J start均值 69.013 → end均值 87.271
  - 平均迭代 2  · 总写 6 · 越界rejected 0 · 收敛 3/3 · 平均墙钟 36.16s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass) — 多形态数采（向量/图像帧）
  - ✔ 向量轮廓帧 2 （46.084,46.572,46.423,46.229,47.039,47.016,47.653,47.17,47.909,47.995,47.737,47.968,48.096,48.882,48.384,48.664,48.001,48.805,48.887,48.775,49.264,49.573,49.244,49.096,48.9,49.843,49.446,49.801,50.034,49.764,49.489,48.712,49.806,4
  - ✔ 图像帧 2 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass) — second plant scenario applied: film-line
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] provisioned
  - line=ln-1ac77288 daq=dn-94aef9f7 dcw=dw-2ef1c038
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass) — scenario[film-line] line 2 [opcua] provisioned
  - line=ln-d56f1bfb daq=dn-bf600926 dcw=dw-41261b88
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass) — scenario[film-line] line 3 [mqtt] provisioned
  - line=ln-614ffff5 daq=dn-5533899c dcw=dw-3909eb2f
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass) — scenario[film-line] line 4 [modbus-rtu] provisioned (satellite DAQ)
  - line=ln-614ffff5 daq=dn-7ad42022 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass) — scenario[film-line] line 5 [http] provisioned (satellite DAQ)
  - line=ln-614ffff5 daq=dn-539984ef dcw=✘
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
- ✔ **open-record** (pass) — 优化记录 opt-39e1947d 已开（基线 186.1999969482422 → 176.88，auto 策略）
  - 下发成功:L1-DCW-modbus-tcp ip16879bp8(烘箱温度设定)设定 176.88℃ → PLC 原始值 176.88;回读 176.89999389648438℃一致。当前活动配方「Integrated工艺1 ip16879bp8」。写入并回读一致:176.8
- ✔ **freeze** (pass) — DAQ temp-pv 已冻结至 150（窗外，窗 [164.4, 195.6]）
  - device=dev-4ce7441e signal=temp-pv
- ✔ **backstop-verdict** (pass) — 系统兜底判定回退 + 自动恢复基线
  - 判定 by=system verdict=rollback · 时延 130.157s（环境类，节拍决定）
  - PLC 值 186.1999969482422 → 期望基线 186.1999969482422（±0.75） ✔
- ✔ **restore** (pass) — 过程量解冻 + 第一场景恢复: cast-film-physics
  - rig left as found

### P9 — Platform subsystems (team / memory / registry)

- ✔ **team-dispatch** (pass) — 团队调度（lead 派发 → worker 完成）
  - 终态 COMPLETED · assignee=74e4304e-e5fb-48b0-ac20-c67703842c01（lead 认领父任务） · 子任务派发给 worker: ✔
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
| hitl | approval_latency_ms | 18 | ms | 挂起→批准（含 800ms 轮询粒度） |
| audit | journal_anchors | 11 |  | 本Line参数变更账本 |
| audit | audit_entries | 87 |  | 全局审计目 |
| audit | ops_logs | 87 |  | 全局运维日志 |
| recipe | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| gov | param_layer_checks_ok | 4 | /4 | 工艺参数映射层全链 |
| closedloop | J_over_Jstar_mean | 0.971 |  | n=3 seeds，写路径=governed |
| closedloop | J_over_Jstar_min | 0.97 |  | 最差 seed（保守下界） |
| closedloop | J_end_mean | 87.271 |  | J* = 89.894 |
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
| gov | backstop_latency_s | 130.157 | s | freeze → verdict (environmental) |
| biax | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| biax | sp_signals | 30 |  | 可写工艺 SP |
| biax | created_missing | 9 |  | 本次补建的缺失设备数 |
| biax | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| biax | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| biax | mission_writes | 6 |  | AgentTeam 双拉任务受治理写次数 |
| biax | mission_distinct_knobs | 3 |  | 参与闭环的执行节点数 |
| biax | mission_attained | 0 |  | 厚度达标 25.0±0.7μm |
| biax | mission_final_thickness | 12.22 | μm | 终态厚度 |
| scenario | injection_attained | 1 |  | 注塑成型质量窗口寻优 |
| scenario | injection_writes | 3 |  | 注塑成型质量窗口寻优 |
| scenario | wwtp_attained | 1 |  | A2O 污水生化处理达标降耗 |
| scenario | wwtp_writes | 15 |  | A2O 污水生化处理达标降耗 |
| scenario | anneal_attained | 0 |  | 连续退火质量窗内产能最大化 |
| scenario | anneal_writes | 3 |  | 连续退火质量窗内产能最大化 |
| scenario | biax_attained | 0 |  | 双拉(BOPET)薄膜产线多节点闭环 |
| scenario | biax_writes | 6 |  | 双拉(BOPET)薄膜产线多节点闭环 |
| team | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| memory | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| agent | harness_registry | 14 |  | environment-available 14 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict PASS, grade A). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._
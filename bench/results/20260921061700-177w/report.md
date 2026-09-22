# AW-IndustrialBench · Integrated Pipeline Report

> **PASS** — score **98.3**/100, grade **A**. Hard gate green: no failed checks or phases; skips are honest environmental exclusions.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20260921061700-177w` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `bd08743fd73302e2` (sha256 over 11 checker sources) |
| Git commit | `e692df1` |
| Runtime | v24.19.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3009 · http://127.0.0.1:4015 |
| Tool harness | opencode (deterministic) · LLM agent: (none) |
| Reproduce | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 57 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 29.541 ms | incl. real protocol transactions |
| Closed-loop J/J* | 96.9 % | n=3 seeds · worst 96.3% · J*=89.894 |
| Tool-level loops | 4 | dcw→daq→judge ×3 convergence |
| Param-layer governance | 4/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | fired+restored | window breach → auto-rollback in 130.131s (env) |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 3 knobs · 6 writes → 28.00μm |
| LLM agent loop | off | --agent omp enables |
| Verdict | PASS | 75/80 checks · hard gate green |

## Simulated production line profile

> Preset `cast-film-physics` — Cast-film extrusion digital twin (plant-model physics engine). An extrusion cast-film line: resin → screw melting → die → casting → thickness gauge. Six writable setpoints (3 zone temperatures, screw speed, line speed, die gap) act on a physics engine whose observable process quantities are melt temperature, melt pressure, film thickness, defect rate and gels count.

**Physics.** Deterministic plant model (seeded): first-order thermal lag on melt temperature, algebraic thickness h ∝ N/v from mass conservation, pressure/defect couplings — scored by J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput.
 Plant engine state at report time: phase=`warmup`, seed=`42`.

**Totals.** 20 PLC devices across 5 protocols (modbus-tcp, modbus-rtu, opcua, mqtt, http); **31 writable setpoints (SP → DCW nodes)** and **46 process quantities (PV → DAQ nodes)**; the platform side provisions 12 lines with 68 write nodes and 75 acquisition nodes.

### Devices & fieldbus endpoints

| # | Device | Protocol | Endpoint | Signals (SP+PV) |
|---:|---|---|---|---:|
| 1 | 挤出主机PLC(Modbus TCP) | `modbus-tcp` | `0.0.0.0:21040 unit=1` | 4 |
| 2 | 晶点计数从站(Modbus RTU) | `modbus-rtu` | `0.0.0.0:20041 unit=1` | 1 |
| 3 | 熔体泵送单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:10840` | 2 |
| 4 | 在线测厚仪(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 2 |
| 5 | CCD检测站(HTTP) | `http` | `http endpoint` | 4 |
| 6 | 加热段炉(Modbus TCP) | `modbus-tcp` | `0.0.0.0:21056 unit=1` | 5 |
| 7 | 注塑主机PLC(Modbus TCP) | `modbus-tcp` | `0.0.0.0:21052 unit=1` | 7 |
| 8 | 曝气风机站(Modbus TCP) | `modbus-tcp` | `0.0.0.0:21054 unit=1` | 3 |
| 9 | 炉内传动与速度单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:10845` | 2 |
| 10 | 模温机与锁模单元(Modbus RTU) | `modbus-rtu` | `0.0.0.0:20052 unit=1` | 4 |
| 11 | 加药单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:10844` | 4 |
| 12 | 注射/保压单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:10843` | 4 |
| 13 | 冷却水单元(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 3 |
| 14 | 回流与排泥单元(Modbus RTU) | `modbus-rtu` | `0.0.0.0:20054 unit=1` | 4 |
| 15 | 冷却与过时效段(Modbus RTU) | `modbus-rtu` | `0.0.0.0:20056 unit=1` | 3 |
| 16 | 进水泵房(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 3 |
| 17 | 保护气单元(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 3 |
| 18 | 制品质量检测站(HTTP) | `http` | `http endpoint` | 7 |
| 19 | 出水水质检测站(HTTP) | `http` | `http endpoint` | 6 |
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
| 加热段炉(Modbus TCP) | 均热区1炉温SP (`zone1-sp`) | SP (writable setpoint) | ℃ | [600, 850] | 1 | `manual` |
| 加热段炉(Modbus TCP) | 均热区2炉温SP (`zone2-sp`) | SP (writable setpoint) | ℃ | [600, 850] | 1 | `manual` |
| 加热段炉(Modbus TCP) | 均热区3炉温SP (`zone3-sp`) | SP (writable setpoint) | ℃ | [600, 850] | 1 | `manual` |
| 加热段炉(Modbus TCP) | FurnaceTemp (`furnace-temp-pv`) | PV (process quantity) | ℃ | [20, 900] | 1 | `constant` |
| 加热段炉(Modbus TCP) | StripTemp (`strip-temp-pv`) | PV (process quantity) | ℃ | [20, 900] | 1 | `constant` |
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
| 炉内传动与速度单元(OPC UA) | LineSpeedSP (`line-speed-sp`) | SP (writable setpoint) | m/min | [60, 220] | 0 | `manual` |
| 炉内传动与速度单元(OPC UA) | ActSpeed (`act-speed-pv`) | PV (process quantity) | m/min | [0, 240] | 1 | `constant` |
| 模温机与锁模单元(Modbus RTU) | 模具温度SP (`mold-temp-sp`) | SP (writable setpoint) | ℃ | [20, 95] | 1 | `manual` |
| 模温机与锁模单元(Modbus RTU) | 锁模力SP (`clamp-force-sp`) | SP (writable setpoint) | kN | [800, 2500] | 0 | `manual` |
| 模温机与锁模单元(Modbus RTU) | MoldTempPV (`mold-temp-pv`) | PV (process quantity) | ℃ | [10, 110] | 1 | `constant` |
| 模温机与锁模单元(Modbus RTU) | ClampPV (`clamp-force-pv`) | PV (process quantity) | kN | [0, 2600] | 0 | `constant` |
| 加药单元(OPC UA) | NaohDoseSP (`naoh-dose-sp`) | SP (writable setpoint) | L/h | [0, 120] | 0 | `manual` |
| 加药单元(OPC UA) | PacDoseSP (`pac-dose-sp`) | SP (writable setpoint) | L/h | [0, 90] | 0 | `manual` |
| 加药单元(OPC UA) | NaohFlow (`naoh-flow-pv`) | PV (process quantity) | L/h | [0, 130] | 1 | `constant` |
| 加药单元(OPC UA) | PacFlow (`pac-flow-pv`) | PV (process quantity) | L/h | [0, 100] | 1 | `constant` |
| 注射/保压单元(OPC UA) | InjectSpeedSP (`inject-speed-sp`) | SP (writable setpoint) | mm/s | [30, 130] | 0 | `manual` |
| 注射/保压单元(OPC UA) | HoldPressSP (`hold-pressure-sp`) | SP (writable setpoint) | bar | [20, 110] | 1 | `manual` |
| 注射/保压单元(OPC UA) | HoldTimeSP (`hold-time-sp`) | SP (writable setpoint) | s | [3, 15] | 1 | `manual` |
| 注射/保压单元(OPC UA) | InjPressPV (`inj-pressure-pv`) | PV (process quantity) | bar | [0, 180] | 1 | `constant` |
| 冷却水单元(MQTT) | CoolWaterSP (`cool-water-sp`) | SP (writable setpoint) | ℃ | [10, 45] | 1 | `manual` |
| 冷却水单元(MQTT) | WaterTempPV (`water-temp-pv`) | PV (process quantity) | ℃ | [5, 60] | 1 | `constant` |
| 冷却水单元(MQTT) | CoolFlowPV (`cool-flow-pv`) | PV (process quantity) | L/min | [0, 80] | 1 | `constant` |
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
| 保护气单元(MQTT) | H2RatioSP (`h2-ratio-sp`) | SP (writable setpoint) | % | [3, 15] | 1 | `manual` |
| 保护气单元(MQTT) | DewPoint (`dew-point-pv`) | PV (process quantity) | ℃ | [-70, 0] | 1 | `constant` |
| 保护气单元(MQTT) | H2Act (`h2-act-pv`) | PV (process quantity) | % | [0, 20] | 1 | `constant` |
| 制品质量检测站(HTTP) | PartWeight (`part-weight`) | PV (process quantity) | g | [25, 40] | 2 | `constant` |
| 制品质量检测站(HTTP) | FlashRate (`flash-rate`) | PV (process quantity) | % | [0, 5] | 3 | `constant` |
| 制品质量检测站(HTTP) | SinkMark (`sink-mark`) | PV (process quantity) | % | [0, 10] | 3 | `constant` |
| 制品质量检测站(HTTP) | DimDev (`dim-dev`) | PV (process quantity) | mm | [-0.5, 0.5] | 3 | `constant` |
| 制品质量检测站(HTTP) | CycleTime (`cycle-time`) | PV (process quantity) | s | [5, 60] | 1 | `constant` |
| 制品质量检测站(HTTP) | WallProfile (`wall-profile`) | PV (process quantity) | mm | [1, 5] | 4 | `constant` |
| 制品质量检测站(HTTP) | SurfaceImg (`surface-image`) | PV (process quantity) | 灰度 | [0, 255] | 2 | `constant` |
| 出水水质检测站(HTTP) | CodOut (`eff-cod`) | PV (process quantity) | mg/L | [0, 300] | 1 | `constant` |
| 出水水质检测站(HTTP) | Nh3Out (`eff-nh3`) | PV (process quantity) | mg/L | [0, 60] | 2 | `constant` |
| 出水水质检测站(HTTP) | TpOut (`eff-tp`) | PV (process quantity) | mg/L | [0, 8] | 3 | `constant` |
| 出水水质检测站(HTTP) | PhOut (`eff-ph`) | PV (process quantity) | pH | [4, 11] | 2 | `constant` |
| 出水水质检测站(HTTP) | Turbidity (`eff-turbidity`) | PV (process quantity) | NTU | [0, 60] | 2 | `constant` |
| 出水水质检测站(HTTP) | DoProfile (`do-profile`) | PV (process quantity) | mg/L | [0, 10] | 3 | `constant` |
| 成品质量检测站(HTTP) | Hardness (`hardness`) | PV (process quantity) | HV | [60, 200] | 1 | `constant` |
| 成品质量检测站(HTTP) | Tensile (`tensile`) | PV (process quantity) | MPa | [200, 500] | 1 | `constant` |
| 成品质量检测站(HTTP) | YieldStr (`yield-str`) | PV (process quantity) | MPa | [100, 400] | 1 | `constant` |
| 成品质量检测站(HTTP) | GrainSize (`grain-size`) | PV (process quantity) | μm | [2, 30] | 2 | `constant` |
| 成品质量检测站(HTTP) | SurfaceDef (`surface-defect`) | PV (process quantity) | % | [0, 5] | 3 | `constant` |
| 成品质量检测站(HTTP) | Flatness (`flatness`) | PV (process quantity) | I | [0, 100] | 2 | `constant` |

### Platform-side node mapping (AW write-control / acquisition nodes)

| Node | Kind | Driver | Line | Unit | Range |
|---|---|---|---|---|---|
| L1-DCW-modbus-tcp ip16tdvs (`dw-e14320e`) | DCW write | `modbus-tcp` | Integrated线1 ip16tdvs | ℃ | [120, 260] |
| L2-DCW-opcua ip16tdvs (`dw-b94fecc`) | DCW write | `opcua` | Integrated线2 ip16tdvs | rpm | [50, 200] |
| L3-DCW-mqtt ip16tdvs (`dw-115f0fc`) | DCW write | `mqtt` | Integrated线3 ip16tdvs | m/min | [20, 120] |
| L4-DCW-http ip16tdvs (`dw-b843f00`) | DCW write | `http` | Integrated线4 ip16tdvs | mm | [0.5, 2] |
| 加热区1SP ip16tdvscl (`dw-67564eb`) | DCW write | `modbus-tcp` | CastFilm线 ip16tdvscl | ℃ | [120, 260] |
| 加热区2SP ip16tdvscl (`dw-4c72347`) | DCW write | `modbus-tcp` | CastFilm线 ip16tdvscl | ℃ | [120, 260] |
| 加热区3SP ip16tdvscl (`dw-6cd13c4`) | DCW write | `modbus-tcp` | CastFilm线 ip16tdvscl | ℃ | [120, 260] |
| ScrewSpeedSP ip16tdvscl (`dw-92ade5c`) | DCW write | `opcua` | CastFilm线 ip16tdvscl | rpm | [50, 200] |
| lineSpeedSP ip16tdvscl (`dw-d3fa299`) | DCW write | `mqtt` | CastFilm线 ip16tdvscl | m/min | [20, 120] |
| dieGapSP ip16tdvscl (`dw-9992725`) | DCW write | `http` | CastFilm线 ip16tdvscl | mm | [0.5, 2] |
| L1-DCW-modbus-tcp ip16tdvsp8 (`dw-1b2eb8a`) | DCW write | `modbus-tcp` | Integrated线1 ip16tdvsp8 | ℃ | [0, 260] |
| L2-DCW-opcua ip16tdvsp8 (`dw-c626993`) | DCW write | `opcua` | Integrated线2 ip16tdvsp8 | ℃ | [0, 260] |
| L3-DCW-mqtt ip16tdvsp8 (`dw-81175e4`) | DCW write | `mqtt` | Integrated线3 ip16tdvsp8 | ℃ | [0, 100] |
| 干燥温度SP·ip16tdvs (`dw-ed5a7ff`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [120, 200] |
| 露点SP·ip16tdvs (`dw-7a48514`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [-80, -20] |
| 喂料速率SP·ip16tdvs (`dw-85460f6`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16tdvs | kg/h | [100, 1200] |
| 机筒温度区1SP·ip16tdvs (`dw-8a62d5f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [220, 300] |
| 机筒温度区2SP·ip16tdvs (`dw-b4d51ea`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [220, 300] |
| 机筒温度区3SP·ip16tdvs (`dw-69e2d1e`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [220, 300] |
| 机筒温度区4SP·ip16tdvs (`dw-5808606`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [220, 300] |
| 机筒温度区5SP·ip16tdvs (`dw-c2cf725`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [220, 300] |
| 螺杆转速SP·ip16tdvs (`dw-7c684b2`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | rpm | [20, 100] |
| 计量泵转速SP·ip16tdvs (`dw-d3eecd9`) | DCW write | `modbus-rtu` | 双拉薄膜产线 biax-ip16tdvs | rpm | [15, 60] |
| 模唇温度SP·ip16tdvs (`dw-d6f99f0`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [250, 300] |
| 急冷辊温度SP·ip16tdvs (`dw-b821529`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [10, 60] |
| 铸片辊速度SP·ip16tdvs (`dw-d6f315f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | m/min | [10, 60] |
| 静电吸附电压SP·ip16tdvs (`dw-494f6bb`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | kV | [4, 12] |
| 预热辊1温度SP·ip16tdvs (`dw-c54193c`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [70, 140] |
| 预热辊2温度SP·ip16tdvs (`dw-5ca3c32`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [70, 140] |
| 预热辊3温度SP·ip16tdvs (`dw-e316e07`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [70, 140] |
| 慢辊线速度SP·ip16tdvs (`dw-4b4773d`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | m/min | [10, 80] |
| 快辊线速度SP·ip16tdvs (`dw-0423113`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | m/min | [30, 260] |
| 纵拉退火辊SP·ip16tdvs (`dw-f40b5fd`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [90, 170] |
| TDO预热段SP·ip16tdvs (`dw-8f2bfda`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [80, 140] |
| TDO拉伸段SP·ip16tdvs (`dw-86c15ae`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [90, 150] |
| TDO定型段SP·ip16tdvs (`dw-edad756`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [180, 250] |
| 链夹速度SP·ip16tdvs (`dw-68f774d`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16tdvs | m/min | [40, 260] |
| 出口轨宽SP·ip16tdvs (`dw-011af9e`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16tdvs | mm | [1800, 4200] |
| coronaPower·ip16tdvs (`dw-494c768`) | DCW write | `http` | 双拉薄膜产线 biax-ip16tdvs | kW | [0.5, 8] |
| 收卷张力SP·ip16tdvs (`dw-88878a1`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | N | [30, 180] |
| L1-DAQ-modbus-tcp ip16tdvs (`dn-a6e8aff`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16tdvs | ℃ | [0, 400] |
| L2-DAQ-opcua ip16tdvs (`dn-185044b`) | DAQ acquire | `opcua` | Integrated线2 ip16tdvs | MPa | [0, 45] |
| L3-DAQ-mqtt ip16tdvs (`dn-a5d07d5`) | DAQ acquire | `mqtt` | Integrated线3 ip16tdvs | μm | [0, 400] |
| L4-DAQ-http ip16tdvs (`dn-13ae186`) | DAQ acquire | `http` | Integrated线4 ip16tdvs | μm | [0, 400] |
| L5-DAQ-modbus-rtu ip16tdvs(sat) (`dn-c3ce0b0`) | DAQ acquire | `modbus-rtu` | Integrated线4 ip16tdvs | 个/m² | [0, 500] |
| 熔体温度 ip16tdvscl (`dn-339335b`) | DAQ acquire | `modbus-tcp` | CastFilm线 ip16tdvscl | ℃ | [0, 400] |
| 晶点计数 ip16tdvscl (`dn-85a9aa6`) | DAQ acquire | `modbus-rtu` | CastFilm线 ip16tdvscl | 个/m² | [0, 500] |
| MeltPressure ip16tdvscl (`dn-86407a4`) | DAQ acquire | `opcua` | CastFilm线 ip16tdvscl | MPa | [0, 45] |
| thick ip16tdvscl (`dn-c9d82d7`) | DAQ acquire | `mqtt` | CastFilm线 ip16tdvscl | μm | [0, 400] |
| defect ip16tdvscl (`dn-76fd75d`) | DAQ acquire | `http` | CastFilm线 ip16tdvscl | % | [0, 100] |
| profile ip16tdvs (`dn-875da73`) | DAQ acquire | `http` | Integrated线1 ip16tdvs | mm | [0.4, 0.65] |
| ccd ip16tdvs (`dn-3ba913a`) | DAQ acquire | `http` | Integrated线1 ip16tdvs | 灰度 | [0, 255] |
| L1-DAQ-modbus-tcp ip16tdvsp8 (`dn-f297646`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16tdvsp8 | ℃ | [0, 260] |
| L2-DAQ-opcua ip16tdvsp8 (`dn-5b26221`) | DAQ acquire | `opcua` | Integrated线2 ip16tdvsp8 | ℃ | [0, 260] |
| L3-DAQ-mqtt ip16tdvsp8 (`dn-c53c0fd`) | DAQ acquire | `mqtt` | Integrated线3 ip16tdvsp8 | ℃ | [0, 100] |
| L4-DAQ-modbus-rtu ip16tdvsp8(sat) (`dn-aff9971`) | DAQ acquire | `modbus-rtu` | Integrated线3 ip16tdvsp8 | ℃ | [0, 100] |
| L5-DAQ-http ip16tdvsp8(sat) (`dn-89bf30f`) | DAQ acquire | `http` | Integrated线3 ip16tdvsp8 | L/min | [0, 100] |
| 干燥塔温度·ip16tdvs (`dn-6768350`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [20, 220] |
| 切片残水·ip16tdvs (`dn-04cc82d`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16tdvs | ppm | [0, 120] |
| 熔体温度·ip16tdvs (`dn-d1da65d`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [200, 330] |
| 泵前熔压·ip16tdvs (`dn-a0ba895`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | MPa | [0, 35] |
| 泵出口压力·ip16tdvs (`dn-bdb1d53`) | DAQ acquire | `modbus-rtu` | 双拉薄膜产线 biax-ip16tdvs | MPa | [0, 35] |
| 铸片辊面温度·ip16tdvs (`dn-371b6f4`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [0, 80] |
| 纵拉膜温·ip16tdvs (`dn-7fbff9f`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16tdvs | ℃ | [40, 160] |

_(showing first 40 DCW / 24 DAQ nodes; full inventory in `line-profile.json`)_

## Phase scorecard (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---:|---:|---:|---:|---:|---:|
| P0 | Bootstrap · simulator & platform | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P1 | Plant model + offline optimum W* | 2 | 0 | 0 | 0 | 100.0 | 1 |
| P2 | Multi-protocol line provisioning | 6 | 0 | 0 | 0 | 100.0 | 2 |
| P3 | DAQ · governed write · F5 interlock | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P4 | Agent-tool closed loop (3-cycle convergence) | 6 | 1 | 0 | 0 | 92.9 | 3 |
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
| **Overall** | | | | | | **98.3** | 38 |

## Closed-loop optimization · per-seed

| Seed | J0 | Jend | J* | J/J* % | Iters | Governed writes | Rejected | Converged |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 42 | 77.27 | 86.53 | 89.89 | 96.3 | 7 | 7 | 0 | yes |
| 43 | 68.02 | 87.24 | 89.89 | 97.0 | 2 | 2 | 0 | yes |
| 44 | 66.87 | 87.61 | 89.89 | 97.5 | 2 | 2 | 0 | yes |

## AgentTeam closed-loop tuning walkthrough

How an optimization team is assembled and drives the line, end to end: (1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; (2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); (3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; (4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; (5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.

### Biax (BOPET) multi-node mission — iteration trace

| Iter | Knob | Node | From → To | Thickness μm | Note |
|---|---|---|---|---:|---|
| 0 | — | `—` | — | 46.50 |  |
| 1 | cast-spd-sp | `dw-d6f315fd` | 32 → 39.4 | 39.14 |  |
| 2 | fast-roll-sp | `dw-04231132` | 118 → 132.9 | 28.00 |  |
| 3 | rail-out-sp | `dw-011af9ec` | 3000 → 3096 | 27.94 |  |
| 4 | cast-spd-sp | `dw-d6f315fd` | 39.400001525878906 → 41.5 | 27.94 |  |
| 5 | fast-roll-sp | `dw-04231132` | 132.89999389648438 → 137.8 | 27.94 |  |
| 6 | rail-out-sp | `dw-011af9ec` | 3096 → 3194 | 28.00 |  |

Governed writes: **6** on 3 distinct knob(s) · optimization records: 6 · target window 25 ± 0.7 μm · final thickness reading **28.00 μm** · target attained: **no**.

### Deterministic closed-loop benchmark — seed 42 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 53.87 | 0.217 | 18.58 | 205.3 | 150 | 95.0 | 200.0 | 77.26 | 0 |
| 1 | 52.13 | 0.433 | 16.97 | 202.4 | 139 | 95.0 | 200.0 | 86.71 | 24.124 |
| 2 | 47.50 | 0.667 | 16.02 | 201.2 | 133 | 95.0 | 200.0 | 84.28 | 36.183 |
| 3 | 52.03 | 0.683 | 16.97 | 200.6 | 140 | 95.0 | 200.0 | 86.42 | 48.244 |
| 4 | 51.27 | 0.683 | 16.28 | 200.1 | 135 | 95.0 | 200.0 | 86.87 | 60.293 |
| 5 | 47.70 | 0.767 | 15.90 | 199.9 | 132 | 95.0 | 200.0 | 85.12 | 72.347 |
| 6 | 51.90 | 0.817 | 16.62 | 199.9 | 138 | 95.0 | 200.0 | 86.30 | 84.387 |
| 7 | 51.10 | 0.750 | 16.00 | 200.0 | 133 | 95.0 | 200.0 | 86.77 | 96.449 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **96.3 %**; governed writes 7 (rejected 0), optimization records 7.

### Deterministic closed-loop benchmark — seed 43 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.57 | 0.183 | 18.65 | 207.1 | 150 | 95.0 | 200.0 | 68.02 | 0 |
| 1 | 51.80 | 0.500 | 16.45 | 203.1 | 135 | 95.0 | 200.0 | 87.45 | 24.095 |
| 2 | 50.37 | 0.717 | 15.78 | 201.5 | 130 | 95.0 | 200.0 | 87.04 | 36.155 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.0 %**; governed writes 2 (rejected 0), optimization records 2.

### Deterministic closed-loop benchmark — seed 44 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.77 | 0.200 | 18.67 | 206.9 | 150 | 95.0 | 200.0 | 66.87 | 0 |
| 1 | 51.38 | 0.383 | 16.43 | 203.1 | 134 | 95.0 | 200.0 | 87.86 | 24.101 |
| 2 | 50.53 | 0.617 | 15.78 | 201.5 | 130 | 95.0 | 200.0 | 87.35 | 36.161 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **97.5 %**; governed writes 2 (rejected 0), optimization records 2.

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `agentteam-mission.log` | 1.0 KB | AgentTeam optimization mission — full task-board trajectory |
| `agentteam-biax.log` | 1.9 KB | AgentTeam biax multi-node mission — full trajectory |
| `line-profile.json` | 62.7 KB | Simulated line profile — devices, protocols, endpoints, SP/PV signal inventory, AW node mapping |
| `metrics.csv` | 3.2 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 140.7 KB | Full machine-readable results (checks, phases, evidence, KPIs, line profile, agent-team traces) |
| `summary.json` | 17.8 KB | Verdict + KPI + per-line summary (compare/aggregate input) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✔ **platform-reachable** (pass) — platform reachable & authenticated
  - 平台 http://127.0.0.1:3009：自动分离启动 pid=3348（日志 D:\codes\ABO\aw-bench-platform.log）
  - 鉴权 OK (register-first-admin)
  - simulator http://127.0.0.1:4015：自动启动 pid=55032

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass) — 预设 cast-film-physics 已应用
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **offline-optimum** (pass) — offline optimum W* (ground truth) available
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-21T06:18:21.415Z"}

### P10 — Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)

- ✔ **biax-ensure** (pass) — 节点探测补建(9 建缺失 / 0 修复 / 0 原样)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass) — 五协议多节点建线(DCW 30 + DAQ 19,驱动实测 9/9)
  - line=ln-963df7ce recipe=rc-b3662235 started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass) — 测厚仪真实链路采样(1 点)
  - daq=dn-5a11b766 · samples=1
- ✔ **biax-agent-cards** (pass) — Agent 语义卡含双拉工艺描述(semantics 贯通)
  - 语义卡长度 22561 · 关键词命中 铸片辊速度/横向拉伸比/收卷张力
  - sample: #### ◆ L1-DCW-modbus-tcp ip16tdvs [id=dw-e14320e9] - 物理量: 烘箱温度设定,单位 ℃,精度 1 位小数 - 工艺语义: 模拟器设备「挤出主机PLC(Modbus TCP)」的 加热区1SP（真实 modbus-tcp 写控） - 安全量程: [120, 260] ℃
- ✔ **biax-mission-board** (pass) — 任务板:双拉优化任务下达并由 lead 派发
  - parent task + lead child: ✔
- ✔ **biax-mission-multinode** (pass) — 多节点受治理写(3 个执行节点 / 6 写)
  - 1. task board: channel=d79e603f-a577-4ecf-9a01-699569f43fdf parent=3fc1280e-ca2c-48f3-a8e3-9da3d8fa4181 leadChild=e54a626c-2c5e-4250-94c8-e7a9ca5e67d2
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[46.5,3.5,1.6]
  - 3. initial thickness=46.50 μm(目标 25±0.7)
  - iter1: cast-spd-sp 32→39.4 ✔ record=opt-85cb0c… · thickness→39.14μm · judge=keep✔
- ▲ **biax-mission-attained** (warn) — 厚度目标达成(|PV−25.0|≤0.7μm,final=28.00)
  - writes=6/6 · distinctKnobs=3 · final=28.00μm
  -         meltTemp=291.6℃(安全窗 268~300)
  - 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(2 条,含参数/判定/窗口): - opt-ac6861cf [judged-keep] 铸片辊速度SP·ip16tdvs: 39.4 → 41.5,设定 14:27:51,判定 keep(agent:biax mission i
  - 5. outcome: writes=6 distinctKnobs=3 final=28.00μm attained=false
- ✔ **biax-mission-journal** (pass) — 参数账本 Agent 归因(铸速节点)
- ✔ **biax-mission-closed** (pass) — 任务收口(父任务 COMPLETED)
  - terminal=COMPLETED
- ✔ **biax-restore** (pass) — 双拉线停止 + 第一场景恢复: cast-film-physics
  - rig left as found

### P11 — 

- ✔ **scen-injection** (pass) — 注塑成型质量窗口寻优(writes=3, wall=32.29s)
  - baseline 克重=31.25g(目标 32.5±0.35)
  - iter1: hold-pressure-sp 45→58.24 ✔ record=yes · 克重→31.96g
  - iter2: hold-time-sp 6→10.35 ✔ record=yes · 克重→32.14g
  - iter3: hold-pressure-sp 58.2→61.97 ✔ record=yes · 克重→32.36g
- ✔ **scen-wwtp** (pass) — A2O 污水生化处理达标降耗(writes=15, wall=176.18s)
  - baseline DO=0.21 COD=360 NH3=34.5 TP=0.66 pH=6.58 → 不达标
  - iter1(曝气): 风机 26→30.06 ✔
  - iter2(曝气): 风机 30.100000381469727→31.61 ✔
  - iter3(曝气): 风机 31.600000381469727→32.44 ✔
- ▲ **scen-anneal** (warn) — 连续退火质量窗内产能最大化(writes=5, wall=65.79s)
  - baseline 硬度=134.7HV 抗拉=311MPa 线速=140m/min → 窗外
  - iter1: zone3-sp 730→850 ✔
  - iter6(产能): 线速 140→152 ✔ 硬度 99.5HV 仍在窗内
  - iter7(产能): 线速 152→164 ✔ 硬度 101.0HV 仍在窗内
- ▲ **scen-biax** (warn) — 双拉(BOPET)薄膜产线多节点闭环(writes=6, wall=nulls, 线复用)
  - 1. task board: channel=d79e603f-a577-4ecf-9a01-699569f43fdf parent=3fc1280e-ca2c-48f3-a8e3-9da3d8fa4181 leadChild=e54a626c-2c5e-4250-94c8-e7a9ca5e67d2
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[46.5,3.5,1.6]
  - 3. initial thickness=46.50 μm(目标 25±0.7)
  - iter1: cast-spd-sp 32→39.4 ✔ record=opt-85cb0c… · thickness→39.14μm · judge=keep✔
- ▲ **scen-report** (warn) — 多场景 benchmark 报告(scenarios-benchmark.md/.html)
  - bench/results/20260921061700-177w/scenarios-benchmark.md
  - 并行 wall=179.18s

### P2 — Multi-protocol line provisioning

- ✔ **gateway** (pass) — gateway controller start (idempotent)
  - POST /api/workshop/daq/controller {action:start}
  - 采样仍受「活动Line批」门控，故每台有 SP 的devices自成一可开跑Line
- ✔ **line-1-modbus-tcp** (pass) — Line1 [modbus-tcp] 供给
  - line=ln-4749604f daq=dn-a6e8aff9 dcw=dw-e14320e9 recipe=rc-d9b2640b
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 31.329999923706055
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass) — Line2 [opcua] 供给
  - line=ln-38261331 daq=dn-185044b4 dcw=dw-b94fecca recipe=rc-024e86e5
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 6.783
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass) — Line3 [mqtt] 供给
  - line=ln-176ad5a4 daq=dn-a5d07d57 dcw=dw-115f0fcc recipe=rc-bd3dba99
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,收到 aw/sim/thick = 50.93
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass) — Line4 [http] 供给
  - line=ln-d8e4e0f2 daq=dn-13ae186f dcw=dw-b843f009 recipe=rc-f7a1af13
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 100
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass) — Line5 [modbus-rtu] 供给（satellite DAQ）
  - line=ln-d8e4e0f2 daq=dn-c3ce0b0c dcw=✘ recipe=rc-f7a1af13 ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 3
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ · governed write · F5 interlock

- ✔ **line-1-io** (pass) — Line1 [modbus-tcp] integration check
  - ✔ DAQ samples stored 10  points (modbus-tcp real driver）
  - ✔ 约6写 p50=47.047ms p95=48.048ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass) — Line2 [opcua] integration check
  - ✔ DAQ samples stored 10  points (opcua real driver）
  - ✔ 约6写 p50=19.346ms p95=20.3ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass) — Line3 [mqtt] integration check
  - ✔ DAQ samples stored 12  points (mqtt real driver）
  - ✔ 约6写 p50=19.042ms p95=19.99ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass) — Line4 [http] integration check
  - ✔ DAQ samples stored 12  points (http real driver）
  - ✔ 约6写 p50=32.73ms p95=33.289ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass) — Line5 [modbus-rtu] integration check
  - ✔ DAQ samples stored 13  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass) — 闭环夹具（channel+agent）
  - channel=041fa543-59ec-4575-a0ca-5b9f020d04ec
  - agent=abd3c8d7-b84e-49ba-a384-33e619ff5acb
  - harness=opencode
- ✔ **tool-bridge** (pass) — opencode 的 host 工具直调面可用
  - 探测 my_industrial_nodes → 你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。
- ✔ **line-1-loop** (pass) — Line1 [modbus-tcp] Agent 闭环收敛（3/3 轮）
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔ · judge ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔ · judge ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.458s
- ✔ **line-2-loop** (pass) — Line2 [opcua] Agent 闭环收敛（3/3 轮）
  - iter1: SP→144.6 ✔ · 回读 145 ✔ · daq ✔ · judge ✔
  - iter2: SP→147.3 ✔ · 回读 147 ✔ · daq ✔ · judge ✔
  - iter3: SP→150 ✔ · 回读 150 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.27s
- ✔ **line-3-loop** (pass) — Line3 [mqtt] Agent 闭环收敛（3/3 轮）
  - iter1: SP→91.4 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→93.2 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→95 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.315s
- ✔ **line-4-loop** (pass) — Line4 [http] Agent 闭环收敛（3/3 轮）
  - iter1: SP→0.946 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→0.973 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→1 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.326s
- ▲ **plant-response** (warn) — 工艺模型响应（SP→plant truth 随动）
  - 真值样本 0 → 0
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":507,"defect":0.888,"eng

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass) — Line1 优化记录生命周期
  - current 204.6999969482422 → record A writes 208.06 (up)，记录 B writes 201.34 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-2bfb4328 verdict keep → 判定已入册:记录 opt-2bfb4328 → keep(bench: 回读一致，判定 keep)。已定档为已验证经验(配方已标记 last
  - ✔ (rollback path) record opt-63efc56e verdict rollback (recorded only; PLC still 201.3000030517578)
  - ✔ rollback executed (status 200) → readback 208.10000610351562 (expected record B from=208.06)
- ✔ **line-1-rbjudge** (pass) — Line1 撤销记录 opt-b12c3153 判定关闭
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass) — Line1 node-level single-step rollback (undo stack)
  - ✔ write 205.04 effective (readback 205, before 208.10000610351562)
  - ✔ journal rollback 受理（status 200，记录 opt-b12c3153）
  - ✔ readback after rollback 208.10000610351562 (expected back to 208.10000610351562, tolerance 0.75)
- ✔ **param-ledger** (pass) — 参数台账（三值对照 + 在册历史）
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ✔ **line-2-hitl** (pass) — Line2 HITL 审批闭环
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-2630d540（detail: L2-DCW-opcua ip16tdvs(烘箱温度设定)设定 148.2rpm,有效写入区间 141~159rpm(节点安全量程 ∩ 配方）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 下发成功:L2-DCW-opcua ip16tdvs(烘箱温度设定)设定 148.2rpm → PLC 原始值 148.2;回读 148.2rpm一致。当前活动配方「Integra
  - ✔ post-approval PLC effect: readback 148 (expected 148.2)
  - 审批裁决时延 457 ms（挂起→批准，含轮询周期）

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
  - ✔ (3) 标记已知良好批次 runId=rr-bb9271f3 → lastGood=rr-bb9271f3
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass) — Line2 [opcua] recipe lifecycle
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-a107c747 → lastGood=rr-a107c747
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ✔ **param-facade** (pass) — Line2 [opcua] 参数面自动生成且无寄存器泄漏
  - param=pp-b665764b key=temp-sp unit=rpm
  - 含 register/dataType/driverConfig? 无 ✔
- ✔ **param-limits** (pass) — Line2 基准限界 [143.7,156.3] + 产品限界 [146.22,153.78] 设定
  - 有效交集(含配方窗) 141~159 → param 143.7~156.3 → product 146.22~153.78 · node 层 50~200（四层收窄：node ∩ param ∩ product ∩ recipe）
- ✔ **param-write-governed** (pass) — Line2 参数面写入联锁（交集内写入 · 越产品层拦截 · 越基准层拦截 · 参数读回）
  - 148.866 → ✔ 写入+回读
  - 155.04 → ✔ 产品层拦截
  - 157.65 → ✔ 基准限界层拦截
  - param read → ✔ 148.866rpm
- ✔ **agent-param-tools** (pass) — Line2 Agent param_control/param_read（语义写 · 越产品层拒 · 参数读 · 未绑定拒）
  - param_control 151.323 → ✔ record=opt-c377d06b
  - param_control 155.04 → ✔ 产品层拦截
  - param_read → ✔
  - unbound agent → ✔ 权限面拒绝

### P4m — AgentTeam optimization mission (task board → governed writes → attainment)

- ✔ **mission-board** (pass) — 任务板：优化任务下达并由 lead 派发
  - channel=4ba166f2-ce4f-4526-94da-df0ed1c7ef2b parent=d485aad1-fbc3-4044-b042-6d73e3a80188 leadChild=531f6daa-0a73-4797-99d2-8831528dede7 assignee=a03057d2-60f1-43a6-96af-c8a3a66fe82b
- ✔ **mission-timescale-read** (pass) — 时段数据读取（daq_query from/to/bucket）
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip16tdvs(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-09-21T14:14 ~ 2026-09-21T14:19(降采样 1000ms)   样本 60 
- ✔ **mission-governed-write** (pass) — 受治理参数下发（1 写全开记录+判定）
  - iter1: SP→204.704 ✔ · record=opened+judged · PV≈204.7 ✔
- ✔ **mission-journal** (pass) — 参数账本归因（Agent source 可追溯）
  - journal sample: 优化记录(4 条,含参数/判定/窗口): - opt-8ab16807 [judged-keep] L1-DCW-modbus-tcp ip16tdvs: 200 → 204.704,设定 14:19:45,判定 keep(agent:mission iter 1: PV=204.7 target=
- ✔ **mission-attained** (pass) — 优化目标达成（|PV−204.704|≤0.75）
  - writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass) — 任务收口（lead 派发→worker 剧本完成→父任务聚合）
  - terminalState=COMPLETED · writes=1 · reached=true

### P6 — Closed-loop optimization benchmark (multi-seed)

- ✔ **twin-nodes** (pass) — cast-film twin node provisioning（执行器 + 传感器）
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass) — 离线最优 W*（ground truth）
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-21T06:18:21.415Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ✔ **seed-42** (pass) — seed=42 闭环优化（J/J*=0.963）
  - 预热 3.027s（熔体温度 206.4℃，达工艺窗 [195,225]）
  - iter0 起点：h=53.87μm defect=0.217% P=18.58MPa T=205.3℃ N=150 v=95.0 → J=77.26
  - iter1 下发 N=139 v=95 z=200 → h=52.13μm defect=0.433% P=16.97MPa T=202.4℃ → J=86.71 
  - iter2 下发 N=133 v=95 z=200 → h=47.50μm defect=0.667% P=16.02MPa T=201.2℃ → J=84.28 
- ✔ **seed-43** (pass) — seed=43 闭环优化（J/J*=0.97）
  - 预热 0.004s（熔体温度 200.04℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.57μm defect=0.183% P=18.65MPa T=207.1℃ N=150 v=95.0 → J=68.02
  - iter1 下发 N=135 v=95 z=200 → h=51.80μm defect=0.500% P=16.45MPa T=203.1℃ → J=87.45 
  - iter2 下发 N=130 v=95 z=200 → h=50.37μm defect=0.717% P=15.78MPa T=201.5℃ → J=87.04 
- ✔ **seed-44** (pass) — seed=44 闭环优化（J/J*=0.975）
  - 预热 0.006s（熔体温度 201.46℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.77μm defect=0.200% P=18.67MPa T=206.9℃ N=150 v=95.0 → J=66.87
  - iter1 下发 N=134 v=95 z=200 → h=51.38μm defect=0.383% P=16.43MPa T=203.1℃ → J=87.86 
  - iter2 下发 N=130 v=95 z=200 → h=50.53μm defect=0.617% P=15.78MPa T=201.5℃ → J=87.35 
- ✔ **closedloop-aggregate** (pass) — 闭环优化聚合（n=3）
  - J/J*：min 0.963 · mean 0.969 · max 0.975（J* = 89.894）
  - J start均值 70.717 → end均值 87.127
  - 平均迭代 3.667  · 总写 11 · 越界rejected 0 · 收敛 3/3 · 平均墙钟 56.255s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass) — 多形态数采（向量/图像帧）
  - ✔ 向量轮廓帧 2 （44.134,43.621,44.44,44.603,44.589,45.123,45.495,45.279,45.23,45.135,46.092,45.812,46.227,46.53,46.365,46.194,45.552,46.661,45.541,46.623,46.574,46.508,46.069,46.966,46.681,46.84,47.424,46.959,46.435,46.966,47.203,46.676,46.296,47
  - ✔ 图像帧 2 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass) — second plant scenario applied: film-line
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] provisioned
  - line=ln-e1f9802e daq=dn-f2976465 dcw=dw-1b2eb8ab
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass) — scenario[film-line] line 2 [opcua] provisioned
  - line=ln-c72f4d36 daq=dn-5b262211 dcw=dw-c626993f
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass) — scenario[film-line] line 3 [mqtt] provisioned
  - line=ln-b0a20f07 daq=dn-c53c0fdb dcw=dw-81175e45
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass) — scenario[film-line] line 4 [modbus-rtu] provisioned (satellite DAQ)
  - line=ln-b0a20f07 daq=dn-aff99715 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass) — scenario[film-line] line 5 [http] provisioned (satellite DAQ)
  - line=ln-b0a20f07 daq=dn-89bf30ff dcw=✘
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
  - ✔ DAQ samples 11 pts (http real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)

### P8b — System backstop drill (bounded autonomy)

- ✔ **cleanup** (pass) — 遗留 open 记录清场（关闭 1/1 条）
  - records closed: 1/1
- ✔ **open-record** (pass) — 优化记录 opt-12f33906 已开（基线 186.1999969482422 → 176.88，auto 策略）
  - 下发成功:L1-DCW-modbus-tcp ip16tdvsp8(烘箱温度设定)设定 176.88℃ → PLC 原始值 176.88;回读 176.89999389648438℃一致。当前活动配方「Integrated工艺1 ip16tdvsp8」。写入并回读一致:176.8
- ✔ **freeze** (pass) — DAQ temp-pv 已冻结至 150（窗外，窗 [164.4, 195.6]）
  - device=dev-74901442 signal=temp-pv
- ✔ **backstop-verdict** (pass) — 系统兜底判定回退 + 自动恢复基线
  - 判定 by=system verdict=rollback · 时延 130.131s（环境类，节拍决定）
  - PLC 值 186.1999969482422 → 期望基线 186.1999969482422（±0.75） ✔
- ✔ **restore** (pass) — 过程量解冻 + 第一场景恢复: cast-film-physics
  - rig left as found

### P9 — Platform subsystems (team / memory / registry)

- ✔ **team-dispatch** (pass) — 团队调度（lead 派发 → worker 完成）
  - 终态 COMPLETED · assignee=856cfc08-cb55-4631-9157-0a4c58f1657d（lead 认领父任务） · 子任务派发给 worker: ✔
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
| hitl | approval_latency_ms | 457 | ms | 挂起→批准（含 800ms 轮询粒度） |
| audit | journal_anchors | 11 |  | 本Line参数变更账本 |
| audit | audit_entries | 87 |  | 全局审计目 |
| audit | ops_logs | 87 |  | 全局运维日志 |
| recipe | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| gov | param_layer_checks_ok | 4 | /4 | 工艺参数映射层全链 |
| closedloop | J_over_Jstar_mean | 0.969 |  | n=3 seeds，写路径=governed |
| closedloop | J_over_Jstar_min | 0.963 |  | 最差 seed（保守下界） |
| closedloop | J_end_mean | 87.127 |  | J* = 89.894 |
| closedloop | cl_iters_mean | 3.667 |  | 闭环收敛迭代数 |
| closedloop | cl_writes_total | 11 |  | 受治理的闭环写总数 |
| closedloop | cl_rejected_total | 0 |  | 越界被拒（治理拦截） |
| daq | vector_frames | 2 |  | 厚度横向轮廓 |
| daq | image_frames | 2 |  | CCD 表面图像 |
| portability | scenario2_lines | 3 |  | second preset "film-line" (config-only) |
| portability | scenario2_intercept_rate | 1 |  | F5 out-of-window interception on second scenario |
| portability | scenario2_false_blocks | 0 |  | legal in-window writes blocked on second scenario |
| gov | backstop_fired | 1 |  | system-judged rollback on window breach |
| gov | backstop_restored | 1 |  | auto-restore to record baseline |
| gov | backstop_latency_s | 130.131 | s | freeze → verdict (environmental) |
| biax | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| biax | sp_signals | 30 |  | 可写工艺 SP |
| biax | created_missing | 9 |  | 本次补建的缺失设备数 |
| biax | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| biax | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| biax | mission_writes | 6 |  | AgentTeam 双拉任务受治理写次数 |
| biax | mission_distinct_knobs | 3 |  | 参与闭环的执行节点数 |
| biax | mission_attained | 0 |  | 厚度达标 25.0±0.7μm |
| biax | mission_final_thickness | 28 | μm | 终态厚度 |
| scenario | injection_attained | 1 |  | 注塑成型质量窗口寻优 |
| scenario | injection_writes | 3 |  | 注塑成型质量窗口寻优 |
| scenario | wwtp_attained | 1 |  | A2O 污水生化处理达标降耗 |
| scenario | wwtp_writes | 15 |  | A2O 污水生化处理达标降耗 |
| scenario | anneal_attained | 0 |  | 连续退火质量窗内产能最大化 |
| scenario | anneal_writes | 5 |  | 连续退火质量窗内产能最大化 |
| scenario | biax_attained | 0 |  | 双拉(BOPET)薄膜产线多节点闭环 |
| scenario | biax_writes | 6 |  | 双拉(BOPET)薄膜产线多节点闭环 |
| team | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| memory | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| agent | harness_registry | 14 |  | environment-available 14 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict PASS, grade A). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._
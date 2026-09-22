# AW-IndustrialBench · Integrated Pipeline Report

> **FAIL** — score **86.4**/100, grade **F**. Hard gate tripped: at least one check/phase failed; the score is informational only.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20260921055223-15k8` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `e082ddfa6d9696e2` (sha256 over 11 checker sources) |
| Git commit | `e692df1` |
| Runtime | v24.19.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3005 · http://127.0.0.1:4010 |
| Tool harness | opencode (deterministic) · LLM agent: (none) |
| Reproduce | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 112 | 4/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 170.388 ms | incl. real protocol transactions |
| Closed-loop J/J* | 0.0 % | n=3 seeds · worst 0.0% · J*=89.894 |
| Tool-level loops | 3 | dcw→daq→judge ×3 convergence |
| Param-layer governance | 2/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | not fired | P8b drill requires scenario 2 |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 3 knobs · 6 writes → 39.18μm |
| LLM agent loop | off | --agent omp enables |
| Verdict | FAIL | 64/75 checks · hard gate tripped |

## Simulated production line profile

> Preset `cast-film-physics` — Cast-film extrusion digital twin (plant-model physics engine). An extrusion cast-film line: resin → screw melting → die → casting → thickness gauge. Six writable setpoints (3 zone temperatures, screw speed, line speed, die gap) act on a physics engine whose observable process quantities are melt temperature, melt pressure, film thickness, defect rate and gels count.

**Physics.** Deterministic plant model (seeded): first-order thermal lag on melt temperature, algebraic thickness h ∝ N/v from mass conservation, pressure/defect couplings — scored by J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput.
 Plant engine state at report time: phase=`warmup`, seed=`42`.

**Totals.** 29 PLC devices across 5 protocols (modbus-tcp, modbus-rtu, opcua, mqtt, http); **61 writable setpoints (SP → DCW nodes)** and **65 process quantities (PV → DAQ nodes)**; the platform side provisions 71 lines with 282 write nodes and 245 acquisition nodes.

### Devices & fieldbus endpoints

| # | Device | Protocol | Endpoint | Signals (SP+PV) |
|---:|---|---|---|---:|
| 1 | 挤出主机PLC(Modbus TCP) | `modbus-tcp` | `0.0.0.0:16040 unit=1` | 4 |
| 2 | 晶点计数从站(Modbus RTU) | `modbus-rtu` | `0.0.0.0:15041 unit=1` | 1 |
| 3 | 熔体泵送单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:5840` | 2 |
| 4 | 在线测厚仪(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 2 |
| 5 | CCD检测站(HTTP) | `http` | `http endpoint` | 4 |
| 6 | 注塑主机PLC(Modbus TCP) | `modbus-tcp` | `0.0.0.0:16052 unit=1` | 7 |
| 7 | 曝气风机站(Modbus TCP) | `modbus-tcp` | `0.0.0.0:16054 unit=1` | 3 |
| 8 | 加热段炉(Modbus TCP) | `modbus-tcp` | `0.0.0.0:16056 unit=1` | 5 |
| 9 | 原料干燥上料单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:5841` | 5 |
| 10 | 挤出主机PLC(Modbus TCP) | `modbus-tcp` | `0.0.0.0:16042 unit=1` | 8 |
| 11 | 模温机与锁模单元(Modbus RTU) | `modbus-rtu` | `0.0.0.0:15052 unit=1` | 4 |
| 12 | 加药单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:5844` | 4 |
| 13 | 炉内传动与速度单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:5845` | 2 |
| 14 | 注射/保压单元(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:5843` | 4 |
| 15 | 熔体计量泵站(Modbus RTU) | `modbus-rtu` | `0.0.0.0:15042 unit=1` | 2 |
| 16 | 模头铸片单元(Modbus TCP) | `modbus-tcp` | `0.0.0.0:16044 unit=1` | 5 |
| 17 | 回流与排泥单元(Modbus RTU) | `modbus-rtu` | `0.0.0.0:15054 unit=1` | 4 |
| 18 | 冷却与过时效段(Modbus RTU) | `modbus-rtu` | `0.0.0.0:15056 unit=1` | 3 |
| 19 | 进水泵房(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 3 |
| 20 | 保护气单元(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 3 |
| 21 | 冷却水单元(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 3 |
| 22 | 出水水质检测站(HTTP) | `http` | `http endpoint` | 6 |
| 23 | 制品质量检测站(HTTP) | `http` | `http endpoint` | 7 |
| 24 | 成品质量检测站(HTTP) | `http` | `http endpoint` | 6 |
| 25 | 纵向拉伸MDO单元(Modbus TCP) | `modbus-tcp` | `0.0.0.0:16046 unit=1` | 8 |
| 26 | 横向拉伸TDO烘箱(OPC UA) | `opcua` | `opc.tcp://127.0.0.1:5842` | 8 |
| 27 | 在线测厚仪(MQTT) | `mqtt` | `mqtt://127.0.0.1:18830` | 2 |
| 28 | 电晕处理与表面检测站(HTTP) | `http` | `http endpoint` | 5 |
| 29 | 收卷单元(Modbus TCP) | `modbus-tcp` | `0.0.0.0:16048 unit=1` | 6 |

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
| 原料干燥上料单元(OPC UA) | 干燥温度SP (`dry-temp-sp`) | SP (writable setpoint) | ℃ | [120, 200] | 1 | `manual` |
| 原料干燥上料单元(OPC UA) | 露点SP (`dew-point-sp`) | SP (writable setpoint) | ℃ | [-80, -20] | 0 | `manual` |
| 原料干燥上料单元(OPC UA) | 喂料速率SP (`feed-rate-sp`) | SP (writable setpoint) | kg/h | [100, 1200] | 0 | `manual` |
| 原料干燥上料单元(OPC UA) | 干燥塔温度 (`dry-temp-pv`) | PV (process quantity) | ℃ | [20, 220] | 1 | `constant` |
| 原料干燥上料单元(OPC UA) | 切片残水 (`moisture-pv`) | PV (process quantity) | ppm | [0, 120] | 1 | `constant` |
| 挤出主机PLC(Modbus TCP) | 机筒温度区1SP (`zone1-sp`) | SP (writable setpoint) | ℃ | [220, 300] | 1 | `manual` |
| 挤出主机PLC(Modbus TCP) | 机筒温度区2SP (`zone2-sp`) | SP (writable setpoint) | ℃ | [220, 300] | 1 | `manual` |
| 挤出主机PLC(Modbus TCP) | 机筒温度区3SP (`zone3-sp`) | SP (writable setpoint) | ℃ | [220, 300] | 1 | `manual` |
| 挤出主机PLC(Modbus TCP) | 机筒温度区4SP (`zone4-sp`) | SP (writable setpoint) | ℃ | [220, 300] | 1 | `manual` |
| 挤出主机PLC(Modbus TCP) | 机筒温度区5SP (`zone5-sp`) | SP (writable setpoint) | ℃ | [220, 300] | 1 | `manual` |
| 挤出主机PLC(Modbus TCP) | 螺杆转速SP (`screw-sp`) | SP (writable setpoint) | rpm | [20, 100] | 0 | `manual` |
| 挤出主机PLC(Modbus TCP) | 熔体温度 (`melt-temp`) | PV (process quantity) | ℃ | [200, 330] | 1 | `constant` |
| 挤出主机PLC(Modbus TCP) | 泵前熔压 (`melt-pressure`) | PV (process quantity) | MPa | [0, 35] | 2 | `constant` |
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
| 熔体计量泵站(Modbus RTU) | 计量泵转速SP (`pump-sp`) | SP (writable setpoint) | rpm | [15, 60] | 1 | `manual` |
| 熔体计量泵站(Modbus RTU) | 泵出口压力 (`pump-outlet`) | PV (process quantity) | MPa | [0, 35] | 2 | `constant` |
| 模头铸片单元(Modbus TCP) | 模唇温度SP (`die-lip-sp`) | SP (writable setpoint) | ℃ | [250, 300] | 1 | `manual` |
| 模头铸片单元(Modbus TCP) | 急冷辊温度SP (`chill-temp-sp`) | SP (writable setpoint) | ℃ | [10, 60] | 1 | `manual` |
| 模头铸片单元(Modbus TCP) | 铸片辊速度SP (`cast-spd-sp`) | SP (writable setpoint) | m/min | [10, 60] | 1 | `manual` |
| 模头铸片单元(Modbus TCP) | 静电吸附电压SP (`pinning-sp`) | SP (writable setpoint) | kV | [4, 12] | 1 | `manual` |
| 模头铸片单元(Modbus TCP) | 铸片辊面温度 (`cast-temp-pv`) | PV (process quantity) | ℃ | [0, 80] | 1 | `constant` |
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
| 冷却水单元(MQTT) | CoolWaterSP (`cool-water-sp`) | SP (writable setpoint) | ℃ | [10, 45] | 1 | `manual` |
| 冷却水单元(MQTT) | WaterTempPV (`water-temp-pv`) | PV (process quantity) | ℃ | [5, 60] | 1 | `constant` |
| 冷却水单元(MQTT) | CoolFlowPV (`cool-flow-pv`) | PV (process quantity) | L/min | [0, 80] | 1 | `constant` |
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
| 纵向拉伸MDO单元(Modbus TCP) | 预热辊1温度SP (`mdo-preheat1-sp`) | SP (writable setpoint) | ℃ | [70, 140] | 1 | `manual` |
| 纵向拉伸MDO单元(Modbus TCP) | 预热辊2温度SP (`mdo-preheat2-sp`) | SP (writable setpoint) | ℃ | [70, 140] | 1 | `manual` |
| 纵向拉伸MDO单元(Modbus TCP) | 预热辊3温度SP (`mdo-preheat3-sp`) | SP (writable setpoint) | ℃ | [70, 140] | 1 | `manual` |
| 纵向拉伸MDO单元(Modbus TCP) | 慢辊线速度SP (`slow-roll-sp`) | SP (writable setpoint) | m/min | [10, 80] | 1 | `manual` |
| 纵向拉伸MDO单元(Modbus TCP) | 快辊线速度SP (`fast-roll-sp`) | SP (writable setpoint) | m/min | [30, 260] | 1 | `manual` |
| 纵向拉伸MDO单元(Modbus TCP) | 纵拉退火辊SP (`mdo-anneal-sp`) | SP (writable setpoint) | ℃ | [90, 170] | 1 | `manual` |
| 纵向拉伸MDO单元(Modbus TCP) | 纵拉膜温 (`mdo-film-temp`) | PV (process quantity) | ℃ | [40, 160] | 1 | `constant` |
| 纵向拉伸MDO单元(Modbus TCP) | 纵拉实际拉伸比 (`mdo-ratio-pv`) | PV (process quantity) | — | [1, 5] | 2 | `constant` |
| 横向拉伸TDO烘箱(OPC UA) | TDO预热段SP (`tdo-preheat-sp`) | SP (writable setpoint) | ℃ | [80, 140] | 1 | `manual` |
| 横向拉伸TDO烘箱(OPC UA) | TDO拉伸段SP (`tdo-stretch-sp`) | SP (writable setpoint) | ℃ | [90, 150] | 1 | `manual` |
| 横向拉伸TDO烘箱(OPC UA) | TDO定型段SP (`tdo-anneal-sp`) | SP (writable setpoint) | ℃ | [180, 250] | 1 | `manual` |
| 横向拉伸TDO烘箱(OPC UA) | 链夹速度SP (`chain-sp`) | SP (writable setpoint) | m/min | [40, 260] | 0 | `manual` |
| 横向拉伸TDO烘箱(OPC UA) | 出口轨宽SP (`rail-out-sp`) | SP (writable setpoint) | mm | [1800, 4200] | 0 | `manual` |
| 横向拉伸TDO烘箱(OPC UA) | 烘箱膜温 (`tdo-temp-pv`) | PV (process quantity) | ℃ | [60, 260] | 1 | `constant` |
| 横向拉伸TDO烘箱(OPC UA) | 横拉实际拉伸比 (`td-ratio-pv`) | PV (process quantity) | — | [1, 5.5] | 2 | `constant` |
| 横向拉伸TDO烘箱(OPC UA) | 轨道实测宽度 (`rail-width-pv`) | PV (process quantity) | mm | [1500, 4500] | 0 | `constant` |
| 在线测厚仪(MQTT) | biaxThick (`biax-thickness`) | PV (process quantity) | μm | [0, 80] | 2 | `constant` |
| 在线测厚仪(MQTT) | biaxSigma (`thickness-sigma`) | PV (process quantity) | μm | [0, 10] | 3 | `constant` |
| 电晕处理与表面检测站(HTTP) | coronaPower (`corona-sp`) | SP (writable setpoint) | kW | [0.5, 8] | 1 | `manual` |
| 电晕处理与表面检测站(HTTP) | biaxProfile (`biax-profile`) | PV (process quantity) | μm | [0, 80] | 3 | `constant` |
| 电晕处理与表面检测站(HTTP) | biaxDefect (`biax-defect`) | PV (process quantity) | % | [0, 10] | 3 | `constant` |
| 电晕处理与表面检测站(HTTP) | biaxHaze (`biax-haze`) | PV (process quantity) | % | [0, 10] | 2 | `constant` |
| 电晕处理与表面检测站(HTTP) | biaxDyne (`dyne-level`) | PV (process quantity) | dyn/cm | [30, 60] | 0 | `constant` |
| 收卷单元(Modbus TCP) | 收卷张力SP (`winder-tension-sp`) | SP (writable setpoint) | N | [30, 180] | 1 | `manual` |
| 收卷单元(Modbus TCP) | 张力锥度SP (`taper-sp`) | SP (writable setpoint) | % | [10, 60] | 0 | `manual` |
| 收卷单元(Modbus TCP) | 接触辊压力SP (`contact-press-sp`) | SP (writable setpoint) | bar | [0.3, 4] | 2 | `manual` |
| 收卷单元(Modbus TCP) | 卷取速度上限SP (`winder-speed-sp`) | SP (writable setpoint) | m/min | [60, 320] | 0 | `manual` |
| 收卷单元(Modbus TCP) | 实际收卷张力 (`winder-tension-pv`) | PV (process quantity) | N | [0, 220] | 1 | `constant` |
| 收卷单元(Modbus TCP) | 卷径 (`roll-diameter`) | PV (process quantity) | m | [0.05, 1.5] | 3 | `constant` |

### Platform-side node mapping (AW write-control / acquisition nodes)

| Node | Kind | Driver | Line | Unit | Range |
|---|---|---|---|---|---|
| L1-DCW-modbus-tcp ip16606c (`dw-2fe1a76`) | DCW write | `modbus-tcp` | Integrated线1 ip16606c | ℃ | [120, 260] |
| L2-DCW-opcua ip16606c (`dw-536672e`) | DCW write | `opcua` | Integrated线2 ip16606c | rpm | [50, 200] |
| L3-DCW-mqtt ip16606c (`dw-65422b0`) | DCW write | `mqtt` | Integrated线3 ip16606c | m/min | [20, 120] |
| L4-DCW-http ip16606c (`dw-807fd73`) | DCW write | `http` | Integrated线4 ip16606c | mm | [0.5, 2] |
| 加热区1SP ip16606ccl (`dw-0ae8e7b`) | DCW write | `modbus-tcp` | CastFilm线 ip16606ccl | ℃ | [120, 260] |
| 加热区2SP ip16606ccl (`dw-6d2d1d2`) | DCW write | `modbus-tcp` | CastFilm线 ip16606ccl | ℃ | [120, 260] |
| 加热区3SP ip16606ccl (`dw-498d319`) | DCW write | `modbus-tcp` | CastFilm线 ip16606ccl | ℃ | [120, 260] |
| ScrewSpeedSP ip16606ccl (`dw-26e6d30`) | DCW write | `opcua` | CastFilm线 ip16606ccl | rpm | [50, 200] |
| lineSpeedSP ip16606ccl (`dw-ebba764`) | DCW write | `mqtt` | CastFilm线 ip16606ccl | m/min | [20, 120] |
| dieGapSP ip16606ccl (`dw-98a022e`) | DCW write | `http` | CastFilm线 ip16606ccl | mm | [0.5, 2] |
| L1-DCW-modbus-tcp ip16606cp8 (`dw-819fb0b`) | DCW write | `modbus-tcp` | Integrated线1 ip16606cp8 | ℃ | [0, 260] |
| L2-DCW-opcua ip16606cp8 (`dw-587d05d`) | DCW write | `opcua` | Integrated线2 ip16606cp8 | ℃ | [0, 260] |
| L3-DCW-mqtt ip16606cp8 (`dw-d0d9bde`) | DCW write | `mqtt` | Integrated线3 ip16606cp8 | ℃ | [0, 100] |
| 干燥温度SP·ip16606c (`dw-5fa0085`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16606c | ℃ | [120, 200] |
| 露点SP·ip16606c (`dw-e09d1ba`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16606c | ℃ | [-80, -20] |
| 喂料速率SP·ip16606c (`dw-ccfb2b8`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16606c | kg/h | [100, 1200] |
| 机筒温度区1SP·ip16606c (`dw-4ebcbc5`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [220, 300] |
| 机筒温度区2SP·ip16606c (`dw-2de1e8e`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [220, 300] |
| 机筒温度区3SP·ip16606c (`dw-db134f5`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [220, 300] |
| 机筒温度区4SP·ip16606c (`dw-e657ef6`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [220, 300] |
| 机筒温度区5SP·ip16606c (`dw-10f590d`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [220, 300] |
| 螺杆转速SP·ip16606c (`dw-098b9a2`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | rpm | [20, 100] |
| 计量泵转速SP·ip16606c (`dw-730af45`) | DCW write | `modbus-rtu` | 双拉薄膜产线 biax-ip16606c | rpm | [15, 60] |
| 模唇温度SP·ip16606c (`dw-9ebe88f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [250, 300] |
| 急冷辊温度SP·ip16606c (`dw-dce1102`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [10, 60] |
| 铸片辊速度SP·ip16606c (`dw-736648e`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | m/min | [10, 60] |
| 静电吸附电压SP·ip16606c (`dw-5b47398`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | kV | [4, 12] |
| 预热辊1温度SP·ip16606c (`dw-41d952f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [70, 140] |
| 预热辊2温度SP·ip16606c (`dw-3556a0f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [70, 140] |
| 预热辊3温度SP·ip16606c (`dw-37d4e4f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [70, 140] |
| 慢辊线速度SP·ip16606c (`dw-b15e33f`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | m/min | [10, 80] |
| 快辊线速度SP·ip16606c (`dw-768cfe5`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | m/min | [30, 260] |
| 纵拉退火辊SP·ip16606c (`dw-fc00e8e`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [90, 170] |
| TDO预热段SP·ip16606c (`dw-bbe86ed`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16606c | ℃ | [80, 140] |
| TDO拉伸段SP·ip16606c (`dw-1087d91`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16606c | ℃ | [90, 150] |
| TDO定型段SP·ip16606c (`dw-635a3f2`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16606c | ℃ | [180, 250] |
| 链夹速度SP·ip16606c (`dw-60c91ac`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16606c | m/min | [40, 260] |
| 出口轨宽SP·ip16606c (`dw-e14a8a9`) | DCW write | `opcua` | 双拉薄膜产线 biax-ip16606c | mm | [1800, 4200] |
| coronaPower·ip16606c (`dw-cf67af2`) | DCW write | `http` | 双拉薄膜产线 biax-ip16606c | kW | [0.5, 8] |
| 收卷张力SP·ip16606c (`dw-a987cbc`) | DCW write | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | N | [30, 180] |
| L1-DAQ-modbus-tcp ip16606c (`dn-b8a03d4`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16606c | ℃ | [0, 400] |
| L2-DAQ-opcua ip16606c (`dn-fd27be3`) | DAQ acquire | `opcua` | Integrated线2 ip16606c | MPa | [0, 45] |
| L3-DAQ-mqtt ip16606c (`dn-ed88202`) | DAQ acquire | `mqtt` | Integrated线3 ip16606c | μm | [0, 400] |
| L4-DAQ-http ip16606c (`dn-a200d6f`) | DAQ acquire | `http` | Integrated线4 ip16606c | μm | [0, 400] |
| L5-DAQ-modbus-rtu ip16606c(sat) (`dn-f6b7e87`) | DAQ acquire | `modbus-rtu` | Integrated线4 ip16606c | 个/m² | [0, 500] |
| 熔体温度 ip16606ccl (`dn-b832781`) | DAQ acquire | `modbus-tcp` | CastFilm线 ip16606ccl | ℃ | [0, 400] |
| 晶点计数 ip16606ccl (`dn-4a343b7`) | DAQ acquire | `modbus-rtu` | CastFilm线 ip16606ccl | 个/m² | [0, 500] |
| MeltPressure ip16606ccl (`dn-458ad4f`) | DAQ acquire | `opcua` | CastFilm线 ip16606ccl | MPa | [0, 45] |
| thick ip16606ccl (`dn-a73be8a`) | DAQ acquire | `mqtt` | CastFilm线 ip16606ccl | μm | [0, 400] |
| defect ip16606ccl (`dn-d2e952d`) | DAQ acquire | `http` | CastFilm线 ip16606ccl | % | [0, 100] |
| profile ip16606c (`dn-d944b74`) | DAQ acquire | `http` | Integrated线1 ip16606c | mm | [0.4, 0.65] |
| ccd ip16606c (`dn-9745dc6`) | DAQ acquire | `http` | Integrated线1 ip16606c | 灰度 | [0, 255] |
| L1-DAQ-modbus-tcp ip16606cp8 (`dn-bd529da`) | DAQ acquire | `modbus-tcp` | Integrated线1 ip16606cp8 | ℃ | [0, 260] |
| L2-DAQ-opcua ip16606cp8 (`dn-71d0a56`) | DAQ acquire | `opcua` | Integrated线2 ip16606cp8 | ℃ | [0, 260] |
| L3-DAQ-mqtt ip16606cp8 (`dn-73f5258`) | DAQ acquire | `mqtt` | Integrated线3 ip16606cp8 | ℃ | [0, 100] |
| L4-DAQ-modbus-rtu ip16606cp8(sat) (`dn-947c517`) | DAQ acquire | `modbus-rtu` | Integrated线3 ip16606cp8 | ℃ | [0, 100] |
| L5-DAQ-http ip16606cp8(sat) (`dn-42776fd`) | DAQ acquire | `http` | Integrated线3 ip16606cp8 | L/min | [0, 100] |
| 干燥塔温度·ip16606c (`dn-f391535`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16606c | ℃ | [20, 220] |
| 切片残水·ip16606c (`dn-69e7cd1`) | DAQ acquire | `opcua` | 双拉薄膜产线 biax-ip16606c | ppm | [0, 120] |
| 熔体温度·ip16606c (`dn-d2c8fd4`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [200, 330] |
| 泵前熔压·ip16606c (`dn-8dfbf55`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | MPa | [0, 35] |
| 泵出口压力·ip16606c (`dn-9aefdb0`) | DAQ acquire | `modbus-rtu` | 双拉薄膜产线 biax-ip16606c | MPa | [0, 35] |
| 铸片辊面温度·ip16606c (`dn-e43d53c`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [0, 80] |
| 纵拉膜温·ip16606c (`dn-81bc7bd`) | DAQ acquire | `modbus-tcp` | 双拉薄膜产线 biax-ip16606c | ℃ | [40, 160] |

_(showing first 40 DCW / 24 DAQ nodes; full inventory in `line-profile.json`)_

## Phase scorecard (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---:|---:|---:|---:|---:|---:|
| P0 | Bootstrap · simulator & platform | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P1 | Plant model + offline optimum W* | 2 | 0 | 0 | 0 | 100.0 | 1 |
| P2 | Multi-protocol line provisioning | 6 | 0 | 0 | 0 | 100.0 | 2 |
| P3 | DAQ · governed write · F5 interlock | 4 | 1 | 0 | 0 | 90.0 | 3 |
| P4 | Agent-tool closed loop (3-cycle convergence) | 6 | 1 | 0 | 0 | 92.9 | 3 |
| P4b | Rollback & optimization records | 4 | 0 | 0 | 0 | 100.0 | 2 |
| P4c | HITL approval gate | 0 | 1 | 0 | 0 | 50.0 | 2 |
| P4d | Audit / ledger read surfaces | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P4e | Recipe lifecycle | 2 | 0 | 0 | 0 | 100.0 | 2 |
| P4f | Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits) | 2 | 0 | 2 | 0 | 50.0 | 3 |
| P4m | AgentTeam optimization mission (task board → governed writes → attainment) | 6 | 0 | 0 | 0 | 100.0 | 3 |
| P6 | Closed-loop optimization benchmark (multi-seed) | 2 | 3 | 1 | 0 | 58.3 | 3 |
| P7 | Multimodal acquisition (vector/image) | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P8 | Cross-scenario portability | 11 | 0 | 0 | 0 | 100.0 | 3 |
| P8b | System backstop drill (bounded autonomy) | 4 | 0 | 1 | 0 | 80.0 | 3 |
| P9 | Platform subsystems (team / memory / registry) | 3 | 0 | 0 | 0 | 100.0 | 1 |
| P10 | Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop) | 9 | 1 | 0 | 0 | 95.0 | 3 |
| **Overall** | | | | | | **86.4** | 37 |

## Closed-loop optimization · per-seed

| Seed | J0 | Jend | J* | J/J* % | Iters | Governed writes | Rejected | Converged |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 42 | — | — | 89.89 | — | 8 | 8 | 8 | no |
| 43 | — | — | 89.89 | — | 8 | 8 | 8 | no |
| 44 | — | — | 89.89 | — | 8 | 8 | 8 | no |

## AgentTeam closed-loop tuning walkthrough

How an optimization team is assembled and drives the line, end to end: (1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; (2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); (3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; (4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; (5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.

### Biax (BOPET) multi-node mission — iteration trace

| Iter | Knob | Node | From → To | Thickness μm | Note |
|---|---|---|---|---:|---|
| 0 | — | `—` | — | 23.25 |  |
| 1 | cast-spd-sp | `dw-4cf17789` | 32 → 30.8 | 35.44 |  |
| 2 | fast-roll-sp | `dw-3f962f47` | 118 → 130.2 | 35.50 |  |
| 3 | rail-out-sp | `dw-a54f0e2d` | 3000 → 3266 | 39.14 |  |
| 4 | cast-spd-sp | `dw-4cf17789` | 30.799999237060547 → 36.4 | 39.16 |  |
| 5 | fast-roll-sp | `dw-3f962f47` | 130.1999969482422 → 146.7 | 39.20 |  |
| 6 | rail-out-sp | `dw-a54f0e2d` | 3266 → 3621 | 39.18 |  |

Governed writes: **6** on 3 distinct knob(s) · optimization records: 6 · target window 25 ± 0.7 μm · final thickness reading **39.18 μm** · target attained: **no**.

### Deterministic closed-loop benchmark — seed 42 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.35 | 0.167 | — | 201.8 | 150 | 95.0 | 200.0 | — | 0 |
| 1 | 54.68 | 0.500 | — | 201.8 | 150 | 95.0 | 200.0 | — | 24.114 |
| 2 | 54.63 | 0.533 | — | 200.5 | 150 | 95.0 | 200.0 | — | 36.178 |
| 3 | 53.68 | 0.717 | — | 200.2 | 150 | 95.0 | 200.0 | — | 48.22 |
| 4 | 54.70 | 0.717 | — | 200.6 | 150 | 95.0 | 200.0 | — | 60.279 |
| 5 | 54.03 | 0.717 | — | 200.6 | 150 | 95.0 | 200.0 | — | 72.351 |
| 6 | 53.90 | 0.683 | — | 199.8 | 150 | 95.0 | 200.0 | — | 84.421 |
| 7 | 53.80 | 0.783 | — | 200.2 | 150 | 95.0 | 200.0 | — | 96.465 |
| 8 | 53.77 | 0.833 | — | 200.1 | 150 | 95.0 | 200.0 | — | 108.523 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **— %**; governed writes 8 (rejected 8), optimization records 0.

### Deterministic closed-loop benchmark — seed 43 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55.63 | 0.200 | — | 199.8 | 150 | 95.0 | 200.0 | — | 0 |
| 1 | 54.23 | 0.483 | — | 199.7 | 150 | 95.0 | 200.0 | — | 24.111 |
| 2 | 54.02 | 0.617 | — | 199.8 | 150 | 95.0 | 200.0 | — | 36.173 |
| 3 | 53.63 | 0.750 | — | 199.0 | 150 | 95.0 | 200.0 | — | 48.235 |
| 4 | 53.77 | 0.733 | — | 200.4 | 150 | 95.0 | 200.0 | — | 60.295 |
| 5 | 53.50 | 0.817 | — | 199.4 | 150 | 95.0 | 200.0 | — | 72.344 |
| 6 | 53.75 | 0.767 | — | 198.7 | 150 | 95.0 | 200.0 | — | 84.405 |
| 7 | 53.93 | 0.783 | — | 200.0 | 150 | 95.0 | 200.0 | — | 96.462 |
| 8 | 54.10 | 0.700 | — | 200.5 | 150 | 95.0 | 200.0 | — | 108.529 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **— %**; governed writes 8 (rejected 8), optimization records 0.

### Deterministic closed-loop benchmark — seed 44 iteration trace

| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 54.95 | 0.350 | — | 200.2 | 150 | 95.0 | 200.0 | — | 0 |
| 1 | 54.52 | 0.567 | — | 201.1 | 150 | 95.0 | 200.0 | — | 24.122 |
| 2 | 53.77 | 0.533 | — | 200.7 | 150 | 95.0 | 200.0 | — | 36.19 |
| 3 | 53.82 | 0.733 | — | 199.7 | 150 | 95.0 | 200.0 | — | 48.254 |
| 4 | 54.07 | 0.700 | — | 199.3 | 150 | 95.0 | 200.0 | — | 60.302 |
| 5 | 53.67 | 0.783 | — | 199.7 | 150 | 95.0 | 200.0 | — | 72.36 |
| 6 | 53.68 | 0.883 | — | 199.3 | 150 | 95.0 | 200.0 | — | 84.425 |
| 7 | 53.83 | 0.800 | — | 200.6 | 150 | 95.0 | 200.0 | — | 96.481 |
| 8 | 53.67 | 0.750 | — | 199.9 | 150 | 95.0 | 200.0 | — | 108.537 |

Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **— %**; governed writes 8 (rejected 8), optimization records 0.

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `agentteam-mission.log` | 1.0 KB | AgentTeam optimization mission — full task-board trajectory |
| `agentteam-biax.log` | 1.9 KB | AgentTeam biax multi-node mission — full trajectory |
| `line-profile.json` | 178.8 KB | Simulated line profile — devices, protocols, endpoints, SP/PV signal inventory, AW node mapping |
| `metrics.csv` | 2.5 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 271.1 KB | Full machine-readable results (checks, phases, evidence, KPIs, line profile, agent-team traces) |
| `summary.json` | 16.0 KB | Verdict + KPI + per-line summary (compare/aggregate input) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✔ **platform-reachable** (pass) — platform reachable & authenticated
  - 平台 http://127.0.0.1:3005：already-up
  - 鉴权 OK (login)
  - simulator http://127.0.0.1:4010：already up (reused)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass) — 预设 cast-film-physics 已应用
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **offline-optimum** (pass) — offline optimum W* (ground truth) available
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-21T05:52:34.972Z"}

### P10 — Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)

- ✔ **biax-ensure** (pass) — 节点探测补建(9 建缺失 / 0 修复 / 0 原样)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass) — 五协议多节点建线(DCW 30 + DAQ 19,驱动实测 9/9)
  - line=ln-7cfd2980 recipe=rc-3f157783 started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass) — 测厚仪真实链路采样(1 点)
  - daq=dn-e352709b · samples=1
- ✔ **biax-agent-cards** (pass) — Agent 语义卡含双拉工艺描述(semantics 贯通)
  - 语义卡长度 22422 · 关键词命中 铸片辊速度/横向拉伸比/收卷张力
  - sample: #### ◆ L1-DCW-modbus-tcp ip16w8ot [id=dw-9c6f3b2a] - 物理量: 烘箱温度设定,单位 ℃,精度 1 位小数 - 工艺语义: 模拟器设备「挤出主机PLC(Modbus TCP)」的 加热区1SP（真实 modbus-tcp 写控） - 安全量程: [120, 260] ℃
- ✔ **biax-mission-board** (pass) — 任务板:双拉优化任务下达并由 lead 派发
  - parent task + lead child: ✔
- ✔ **biax-mission-multinode** (pass) — 多节点受治理写(3 个执行节点 / 6 写)
  - 1. task board: channel=5466db82-9d6b-4727-a85e-8b78a84246c1 parent=ba2ea425-b008-4241-8147-6601d9dcfd3d leadChild=7504b7d2-459d-4fe0-90d9-4abd76060cf6
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[-0.1,3.5,1.6]
  - 3. initial thickness=23.25 μm(目标 25±0.7)
  - iter1: cast-spd-sp 32→30.8 ✔ record=opt-a46fd5… · thickness→35.44μm · judge=keep✔
- ▲ **biax-mission-attained** (warn) — 厚度目标达成(|PV−25.0|≤0.7μm,final=39.18)
  - writes=6/6 · distinctKnobs=3 · final=39.18μm
  -         meltTemp=291.7℃(安全窗 268~300)
  - 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(2 条,含参数/判定/窗口): - opt-1a960107 [judged-keep] 铸片辊速度SP·ip16w8ot: 30.8 → 36.4,设定 14:07:36,判定 keep(agent:biax mission i
  - 5. outcome: writes=6 distinctKnobs=3 final=39.18μm attained=false
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
  - line=ln-333710d4 daq=dn-c4171a07 dcw=dw-9c6f3b2a recipe=rc-99bfd025
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 181.10000610351562
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass) — Line2 [opcua] 供给
  - line=ln-54aced61 daq=dn-b560ceab dcw=dw-df538552 recipe=rc-b982fe26
  - DAQ driver test ✘ 信号「MeltPressure」：OPC UA 连接失败: NodeId 读取状态异常: 0x80340000(检查 ns 与标识)
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass) — Line3 [mqtt] 供给
  - line=ln-cae781c6 daq=dn-c3e57735 dcw=dw-39e44835 recipe=rc-7aa3946f
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,收到 aw/sim/thick = 53.93
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass) — Line4 [http] 供给
  - line=ln-4777a0b6 daq=dn-d45a4e7e dcw=dw-5fbec7e7 recipe=rc-1db70b03
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 59.422
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass) — Line5 [modbus-rtu] 供给（satellite DAQ）
  - line=ln-4777a0b6 daq=dn-eadac020 dcw=✘ recipe=rc-1db70b03 ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 66.80000305175781
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ · governed write · F5 interlock

- ✔ **line-1-io** (pass) — Line1 [modbus-tcp] integration check
  - ✔ DAQ samples stored 9  points (modbus-tcp real driver）
  - ✔ 约6写 p50=609.944ms p95=1665.699ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ▲ **line-2-io** (warn) — Line2 [opcua] integration check
  - ✘ DAQ samples stored 0  points (opcua real driver）
  - ✔ 约6写 p50=18.617ms p95=18.959ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass) — Line3 [mqtt] integration check
  - ✔ DAQ samples stored 34  points (mqtt real driver）
  - ✔ 约6写 p50=20.437ms p95=24.51ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass) — Line4 [http] integration check
  - ✔ DAQ samples stored 34  points (http real driver）
  - ✔ 约6写 p50=32.555ms p95=32.703ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass) — Line5 [modbus-rtu] integration check
  - ✔ DAQ samples stored 35  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass) — 闭环夹具（channel+agent）
  - channel=b222d9c6-79a5-419d-acd9-058d415470db
  - agent=be7b1371-c6a7-418a-848f-d47e633bb00e
  - harness=opencode
- ✔ **tool-bridge** (pass) — opencode 的 host 工具直调面可用
  - 探测 my_industrial_nodes → 你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。
- ✔ **line-1-loop** (pass) — Line1 [modbus-tcp] Agent 闭环收敛（3/3 轮）
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔ · judge ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔ · judge ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.562s
- ▲ **line-2-loop** (warn) — Line2 [opcua] Agent 闭环收敛（0/3 轮）
  - iter1: SP→144.6 ✘ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✘(无record)
  - iter2: SP→147.3 ✘ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✘(无record)
  - iter3: SP→150 ✘ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✘(无record)
  - 向窗口中心收敛 ✘ · 耗时 4.257s
- ✔ **line-3-loop** (pass) — Line3 [mqtt] Agent 闭环收敛（3/3 轮）
  - iter1: SP→91.4 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→93.2 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→95 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.323s
- ✔ **line-4-loop** (pass) — Line4 [http] Agent 闭环收敛（3/3 轮）
  - iter1: SP→0.946 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→0.973 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→1 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.367s
- ✔ **plant-response** (pass) — 工艺模型响应（SP→plant truth 随动）
  - 真值样本 0 → 201
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":618,"defect":0.819,"eng

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass) — Line1 优化记录生命周期
  - current 204.6999969482422 → record A writes 208.06 (up)，记录 B writes 201.34 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-81c593ab verdict keep → 判定已入册:记录 opt-81c593ab → keep(bench: 回读一致，判定 keep)。已定档为已验证经验(配方已标记 last
  - ✔ (rollback path) record opt-1d6401c5 verdict rollback (recorded only; PLC still 201.3000030517578)
  - ✔ rollback executed (status 200) → readback 208.10000610351562 (expected record B from=208.06)
- ✔ **line-1-rbjudge** (pass) — Line1 撤销记录 opt-91c6503a 判定关闭
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass) — Line1 node-level single-step rollback (undo stack)
  - ✔ write 205.04 effective (readback 205, before 208.10000610351562)
  - ✔ journal rollback 受理（status 200，记录 opt-91c6503a）
  - ✔ readback after rollback 208.10000610351562 (expected back to 208.10000610351562, tolerance 0.75)
- ✔ **param-ledger** (pass) — 参数台账（三值对照 + 在册历史）
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ▲ **line-2-hitl** (warn) — Line2 HITL 审批闭环
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-8a61b9a4（detail: L2-DCW-opcua ip16w8ot(烘箱温度设定)设定 148.2rpm,有效写入区间 141~159rpm(节点安全量程 ∩ 配方）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 下发失败:回读偏差超容差:写 148.2,回读 0.0000(节点 L2-DCW-opcua ip16w8ot,物理量 烘箱温度设定,安全量程 50~200rpm;当前设定值保持 
  - ✘ post-approval PLC effect: readback null (expected 148.2)
  - 审批裁决时延 468 ms（挂起→批准，含轮询周期）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass) — 治理只读面
  - ✔ 参数变更账本 journal：本产线 12  anchors (source coverage  rollback/manual/agent/recipe）
  - ✔ audit: 200 entries
  - ✔ ops-logs: 200 entries
  - ✔ 报警记录：全局 61 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass) — Line1 [modbus-tcp] recipe lifecycle
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-649d6284 → lastGood=rr-649d6284
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass) — Line2 [opcua] recipe lifecycle
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-94e58107 → lastGood=rr-94e58107
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ✔ **param-facade** (pass) — Line2 [opcua] 参数面自动生成且无寄存器泄漏
  - param=pp-448e018f key=temp-sp unit=rpm
  - 含 register/dataType/driverConfig? 无 ✔
- ✔ **param-limits** (pass) — Line2 基准限界 [143.7,156.3] + 产品限界 [146.22,153.78] 设定
  - 有效交集(含配方窗) 141~159 → param 143.7~156.3 → product 146.22~153.78 · node 层 50~200（四层收窄：node ∩ param ∩ product ∩ recipe）
- ✘ **param-write-governed** (fail) — Line2 参数面写入联锁（交集内写入 · 越产品层拦截 · 越基准层拦截 · 参数读回）
  - 148.866 → ✘ ok
  - 155.04 → ✔ 产品层拦截
  - 157.65 → ✔ 基准限界层拦截
  - param read → ✘
- ✘ **agent-param-tools** (fail) — Line2 Agent param_control/param_read（语义写 · 越产品层拒 · 参数读 · 未绑定拒）
  - param_control 148.11 → ✘ 下发失败:回读偏差超容差:写 148.11,回读 0.0000(工艺参数 temp-sp,执行节点「L2-DCW-opcua ip16w8ot」;有效写入区间 146.22~153
  - param_control 155.04 → ✔ 产品层拦截
  - param_read → ✘ 读取失败:节点读取状态异常: 0x80340000(执行节点「L2-DCW-opcua ip16w8ot」驱动 opcua 可能不支持读取;可改用 daq_query 查关联数采通
  - unbound agent → ✔ 权限面拒绝

### P4m — AgentTeam optimization mission (task board → governed writes → attainment)

- ✔ **mission-board** (pass) — 任务板：优化任务下达并由 lead 派发
  - channel=00afa676-bd6b-4b1f-bd29-db52697de091 parent=dab9ae5c-587f-4721-a1f0-319004b6fdee leadChild=4313a6fc-1620-4918-ab4c-e85dcbf6cbef assignee=fb22a531-eef9-4eb0-860a-1e8b20068b88
- ✔ **mission-timescale-read** (pass) — 时段数据读取（daq_query from/to/bucket）
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip16w8ot(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-09-21T13:49 ~ 2026-09-21T13:54(降采样 1000ms)   样本 60 
- ✔ **mission-governed-write** (pass) — 受治理参数下发（1 写全开记录+判定）
  - iter1: SP→204.704 ✔ · record=opened+judged · PV≈204.7 ✔
- ✔ **mission-journal** (pass) — 参数账本归因（Agent source 可追溯）
  - journal sample: 优化记录(4 条,含参数/判定/窗口): - opt-d8ee8204 [judged-keep] L1-DCW-modbus-tcp ip16w8ot: 200 → 204.704,设定 13:54:09,判定 keep(agent:mission iter 1: PV=204.7 target=
- ✔ **mission-attained** (pass) — 优化目标达成（|PV−204.704|≤0.75）
  - writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass) — 任务收口（lead 派发→worker 剧本完成→父任务聚合）
  - terminalState=COMPLETED · writes=1 · reached=true

### P6 — Closed-loop optimization benchmark (multi-seed)

- ✔ **twin-nodes** (pass) — cast-film twin node provisioning（执行器 + 传感器）
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass) — 离线最优 W*（ground truth）
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-21T05:52:34.972Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ▲ **seed-42** (warn) — seed=42 闭环优化（J/J*=—）
  - 预热 0.034s（熔体温度 202.1℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.35μm defect=0.167% P=—MPa T=201.8℃ N=150 v=95.0 → J=n/a
  - iter1 下发 N=136 v=95 z=200 → h=54.68μm defect=0.500% P=—MPa T=201.8℃ → J=n/a (out of constraints: T or P exceeded)
  - iter2 下发 N=137 v=95 z=200 → h=54.63μm defect=0.533% P=—MPa T=200.5℃ → J=n/a (out of constraints: T or P exceeded)
- ▲ **seed-43** (warn) — seed=43 闭环优化（J/J*=—）
  - 预热 0.017s（熔体温度 199.94℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.63μm defect=0.200% P=—MPa T=199.8℃ N=150 v=95.0 → J=n/a
  - iter1 下发 N=135 v=95 z=200 → h=54.23μm defect=0.483% P=—MPa T=199.7℃ → J=n/a (out of constraints: T or P exceeded)
  - iter2 下发 N=138 v=95 z=200 → h=54.02μm defect=0.617% P=—MPa T=199.8℃ → J=n/a (out of constraints: T or P exceeded)
- ▲ **seed-44** (warn) — seed=44 闭环优化（J/J*=—）
  - 预热 0.017s（熔体温度 200.6℃，达工艺窗 [195,225]）
  - iter0 起点：h=54.95μm defect=0.350% P=—MPa T=200.2℃ N=150 v=95.0 → J=n/a
  - iter1 下发 N=136 v=95 z=200 → h=54.52μm defect=0.567% P=—MPa T=201.1℃ → J=n/a (out of constraints: T or P exceeded)
  - iter2 下发 N=138 v=95 z=200 → h=53.77μm defect=0.533% P=—MPa T=200.7℃ → J=n/a (out of constraints: T or P exceeded)
- ✘ **closedloop-aggregate** (fail) — 闭环优化聚合（n=3）
  - J/J*：min null · mean null · max null（J* = 89.894）
  - J start均值 null → end均值 null
  - 平均迭代 8  · 总写 24 · 越界rejected 24 · 收敛 0/3 · 平均墙钟 108.53s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass) — 多形态数采（向量/图像帧）
  - ✔ 向量轮廓帧 2 （50.495,51.227,50.68,50.816,51.128,51.426,51.16,51.484,51.868,52.2,52.323,52.039,53.078,52.047,52.438,53.289,52.555,52.938,53.111,53.22,52.473,53.675,52.572,53.721,53.512,53.782,53.15,53.49,53.803,53.548,54.075,54.429,53.371,53.48
  - ✔ 图像帧 2 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass) — second plant scenario applied: film-line
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] provisioned
  - line=ln-17c42f11 daq=dn-a1406ce7 dcw=dw-edf427df
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass) — scenario[film-line] line 2 [opcua] provisioned
  - line=ln-759299ae daq=dn-eb608f16 dcw=dw-41295f40
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass) — scenario[film-line] line 3 [mqtt] provisioned
  - line=ln-7f58a319 daq=dn-401ea5fd dcw=dw-85c170a6
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass) — scenario[film-line] line 4 [modbus-rtu] provisioned (satellite DAQ)
  - line=ln-7f58a319 daq=dn-e9eaf417 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass) — scenario[film-line] line 5 [http] provisioned (satellite DAQ)
  - line=ln-7f58a319 daq=dn-d6d4e137 dcw=✘
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
- ✔ **open-record** (pass) — 优化记录 opt-030da8d8 已开（基线 186.1999969482422 → 176.88，auto 策略）
  - 下发成功:L1-DCW-modbus-tcp ip16w8otp8(烘箱温度设定)设定 176.88℃ → PLC 原始值 176.88;回读 176.89999389648438℃一致。当前活动配方「Integrated工艺1 ip16w8otp8」。写入并回读一致:176.8
- ✔ **freeze** (pass) — DAQ temp-pv 已冻结至 150（窗外，窗 [164.4, 195.6]）
  - device=dev-56900e66 signal=temp-pv
- ✘ **backstop-verdict** (fail) — 系统兜底判定
  - 240s 内未观察到 system/rollback 判定（记录 opt-030da8d8）
- ✔ **restore** (pass) — 过程量解冻 + 第一场景恢复: cast-film-physics
  - rig left as found

### P9 — Platform subsystems (team / memory / registry)

- ✔ **team-dispatch** (pass) — 团队调度（lead 派发 → worker 完成）
  - 终态 COMPLETED · assignee=21394045-8c02-4f59-b92f-a97da53d5b01（lead 认领父任务） · 子任务派发给 worker: ✔
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
| provision | lines_sampling | 4 |  | real driver produced samples |
| gov | intercept_rate_all | 1 |  | 全协议合并 |
| loop | tool_loops_ok | 3 |  lines | 工具级闭环达成 |
| loop | mission_writes | 1 |  | AgentTeam 优化任务受治理写次数 |
| loop | mission_attained | 1 |  | AgentTeam 优化任务达标 |
| gov | record_keep_rollback_ok | 1 |  | 优化记录判定/执行分离 |
| hitl | approval_latency_ms | 468 | ms | 挂起→批准（含 800ms 轮询粒度） |
| audit | journal_anchors | 12 |  | 本Line参数变更账本 |
| audit | audit_entries | 200 |  | 全局审计目 |
| audit | ops_logs | 200 |  | 全局运维日志 |
| recipe | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| gov | param_layer_checks_ok | 2 | /4 | 工艺参数映射层全链 |
| closedloop | J_over_Jstar_mean | null |  | n=3 seeds，写路径=governed |
| closedloop | J_over_Jstar_min | null |  | 最差 seed（保守下界） |
| closedloop | J_end_mean | null |  | J* = 89.894 |
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
| biax | mission_writes | 6 |  | AgentTeam 双拉任务受治理写次数 |
| biax | mission_distinct_knobs | 3 |  | 参与闭环的执行节点数 |
| biax | mission_attained | 0 |  | 厚度达标 25.0±0.7μm |
| biax | mission_final_thickness | 39.18 | μm | 终态厚度 |
| team | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| memory | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| agent | harness_registry | 14 |  | environment-available 14 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict FAIL, grade F). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._
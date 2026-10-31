# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20261030171340-ob0` · 2026-10-30T17:15:07.744Z · wall 86.9s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=60fa983e · harness=6923856da6934c7d

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✘ | 1 | 8 | 21.98 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✘ | 1 | 4 | 50.39 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✘ | 1 | 5 | 14.16 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✘ | 0 | 0 | 20.16 |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:新建产线 `注塑成型质量窗口寻优 injection-ms16ecxd` line=ln-54c22f76 recipe=rc-0ade309b DCW=11 DAQ=14
- 驱动实测:inj-machine-mbtcp/机筒温度区1SP ✔ · inj-mold-rtu/模具温度SP ✔ · inj-inject-opcua/InjectSpeedSP ✔ · inj-cool-mqtt/WaterTempPV ✔ · inj-inspect-http/PartWeight ✔
- Channel:channel=3350dab0-33d4-48c5-8683-efcce8a08f24 toolAgent=0bc832f6-8647-4d51-8293-1414def2e72e task=b8fbfa82-103d-47cb-b467-046a9b330182 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `A2O 污水生化处理达标降耗 wwtp-ms16ecxd` line=ln-8331c05b recipe=rc-7df26e28 DCW=7 DAQ=13
- 驱动实测:wwtp-blower-mbtcp/风机频率SP ✔ · wwtp-dosing-opcua/NaohDoseSP ✔ · wwtp-return-rtu/内回流比SP ✔ · wwtp-influent-mqtt/CodIn ✔ · wwtp-effluent-http/CodOut ✔
- Channel:channel=9a17a442-9d67-4637-8df9-e6157ed6a52b toolAgent=cb9e8dfd-6b25-45ea-9a58-9959539f5612 task=5ae39f29-15f3-4e67-8baa-a8b69f12d215 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `连续退火质量窗内产能最大化 anneal-ms16ecxd` line=ln-692c4ffb recipe=rc-5edb9dc3 DCW=7 DAQ=12
- 驱动实测:anneal-heating-mbtcp/均热区1炉温SP ✔ · anneal-line-opcua/LineSpeedSP ✔ · anneal-cool-rtu/过时效温度SP ✔ · anneal-gas-mqtt/DewPoint ✔ · anneal-inspect-http/Hardness ✔
- Channel:channel=0cd09009-3db5-4e53-b5ec-b25f4b15936a toolAgent=9ad73783-ced2-4512-b31a-d2d236cd6b82 task=ac0cd4b7-f798-4cfe-8d98-41a29d19c823 终态=COMPLETED

### biax · 双拉(BOPET)薄膜产线多节点闭环
- 模拟器侧:{"missing":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"drifted":[],"created":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":9,"expectDevices":9,"signals":49,"sp":30,"pv":19,"descMissing":0,"protocols":["opcua","modbus-tcp","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `双拉(BOPET)薄膜产线多节点闭环 biax-ms16ecxd` line=ln-227fb62f recipe=rc-8bfd3d69 DCW=30 DAQ=19
- 驱动实测:biax-dryer-opcua/干燥温度SP ✔ · biax-extruder-mbtcp/机筒温度区1SP ✔ · biax-pump-rtu/计量泵转速SP ✔ · biax-casting-mbtcp/模唇温度SP ✔ · biax-mdo-mbtcp/预热辊1温度SP ✔ · biax-tdo-opcua/TDO预热段SP ✔ · biax-gauge-mqtt/biaxThick ✔ · biax-inspect-http/coronaPower ✔ · biax-winder-mbtcp/收卷张力SP ✔
- Channel:channel=b6ce62d2-c357-4c41-9907-26af5214f3c1 toolAgent=ccdc1f96-cd1a-419d-8281-569403f91fdf task=58dd5519-dde5-4f8b-b59e-b6ec1ae28fa6 终态=COMPLETED

## 2. 闭环优化过程(全轨迹)

### injection · 注塑成型质量窗口寻优

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 31.27 g | — |
| 1 | converge | hold-pressure-sp | 45 → 58.05 | 31.93 g | yes |

- baseline 克重=31.27g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→58.05 ✔ batch=yes · 克重→31.93g
- iter2: hold-time-sp 写被拒 → 试验下发失败:本产线上一次配方试验距今仅 8s,试验节拍为 ≥300s(防连发震荡),请等待 292s 后再试
- iter3: hold-pressure-sp 写被拒 → 试验下发失败:本产线上一次配方试验距今仅 8s,试验节拍为 ≥300s(防连发震荡),请等待 292s 后再试
- iter4: hold-time-sp 写被拒 → 试验下发失败:本产线上一次配方试验距今仅 8s,试验节拍为 ≥300s(防连发震荡),请等待 292s 后再试
- iter5: hold-pressure-sp 写被拒 → 试验下发失败:本产线上一次配方试验距今仅 8s,试验节拍为 ≥300s(防连发震荡),请等待 292s 后再试
- iter6: hold-time-sp 写被拒 → 试验下发失败:本产线上一次配方试验距今仅 8s,试验节拍为 ≥300s(防连发震荡),请等待 292s 后再试
- iter7: hold-pressure-sp 写被拒 → 试验下发失败:本产线上一次配方试验距今仅 8s,试验节拍为 ≥300s(防连发震荡),请等待 292s 后再试
- iter8: hold-time-sp 写被拒 → 试验下发失败:本产线上一次配方试验距今仅 9s,试验节拍为 ≥300s(防连发震荡),请等待 291s 后再试
- outcome: writes=1 final=31.93g attained=false guards={"飞边率":0.013600000000000001,"缩痕指数":1.5546}
- 守卫终值:飞边率=0.01 · 缩痕指数=1.55

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.25 mg/L | — |
| 1 | blower | blower-hz-sp | 26 → 30.01 | 1.53 mg/L | yes |

- baseline DO=0.25 COD=360 NH3=34.5 TP=0.66 pH=6.59 → 不达标
- iter1(曝气): 风机 26→30.01 ✔
- iter2(曝气): 风机 30→32.39 ✘ 试验下发失败:本产线上一次配方试验距今仅 28s,试验节拍为 ≥300s(防连发震荡),请等待 272s 后再试
- iter5(中和): NaOH 12→25.28 ✘ 试验下发失败:本产线上一次配方试验距今仅 29s,试验节拍为 ≥300s(防连发震荡),请等待 271s 后再试
- iter8(除磷): PAC 30→45 ✘ 试验下发失败:本产线上一次配方试验距今仅 29s,试验节拍为 ≥300s(防连发震荡),请等待 271s 后再试
- 达标未确认:{"出水COD":146.38,"出水氨氮":17.972,"出水总磷":0.6538,"出水pH":6.208,"出水浊度":0.6699999999999999,"DO":1.5259999999999998}
- recover(TP): PAC 30→45 ✘ 试验下发失败:本产线上一次配方试验距今仅 29s,试验节拍为 ≥300s(防连发震荡),请等待 271s 后再试
- recover: 风机 30→31.5 ✘ 试验下发失败:本产线上一次配方试验距今仅 29s,试验节拍为 ≥300s(防连发震荡),请等待 271s 后再试
- outcome: writes=1 DO=1.55 compliant=false cost —→117.1(省 —) attained=false
- **成本曲线**:首个达标运行成本 ≈— → 终态 ≈117.1(降 —,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=143.64 · 出水氨氮=17.97 · 出水总磷=0.65 · 出水pH=6.21 · 出水浊度=0.68 · DO=1.55

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.66 HV | — |
| 1 | converge | zone3-sp | 730 → 850 | 133.96 HV | yes |

- baseline 硬度=134.7HV 抗拉=311MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- iter2: zone2-sp 710→850 ✘ 试验下发失败:本产线上一次配方试验距今仅 4s,试验节拍为 ≥300s(防连发震荡),请等待 296s 后再试
- iter3: zone3-sp 校正量过小(850)
- iter4: zone2-sp 710→850 ✘ 试验下发失败:本产线上一次配方试验距今仅 4s,试验节拍为 ≥300s(防连发震荡),请等待 296s 后再试
- iter5: zone3-sp 校正量过小(850)
- outcome: writes=1 final=134.0HV attained=false(窗内+产能≥5%)
- **产能曲线**:线速 140 → — m/min(+—%,质量窗触边自动回退)
- 守卫终值:抗拉强度=310.40 · 表面缺陷率=0.13

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 27.95 μm | — |

- 1. task board: channel=8a422391-af23-4029-b5d7-4add02426de7 parent=541e735e-533e-448e-941b-a047ac7e51ba leadChild=39bbeb1a-41f7-4080-a7df-3b0be620ea96
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.01,3.5,1.6]
- 3. initial thickness=27.95 μm(目标 25±0.7)
- iter1: cast-spd-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter2: fast-roll-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter3: rail-out-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter4: cast-spd-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter5: fast-roll-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter6: rail-out-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- 4. journal(铸速节点)归因 Agent: ✘ · 无权查询节点 dw-86e462ea 的账本(仅可查你绑定范围内的对象:rc-8bfd3d69, dn-0d001c2b, dn-bcc52689, dn-4d3b91d9, dn-e8be4f60, dn-c9bd3338, dn-f19
- 5. outcome: writes=0 distinctKnobs=0 final=27.95μm attained=false
- 6. task terminal=COMPLETED

## 3. 诚实边界
- 全部写路径经平台治理(绑定配方上的 recipe_trial 整批试验下发,复测判读,不写配方版本);策略为确定性脚本(不经 LLM),与真实 LLM 变体共用同一工具面与治理链路。
- 物理数据由模拟器多引擎(cast-film/biax/injection/wwtp/anneal)产出,同 seed 确定性;J/W* 与真实产线存在仿真层级边界。
- 平台侧产线为「复用优先」:本报告如显示 reused,说明前次接入仍在,本次零重复建线(设计语义)。

## 4. 复现

```bash
NO_PROXY=127.0.0.1,localhost \
AW_BASE=http://127.0.0.1:3005 SIM_BASE=http://127.0.0.1:4011 \
  node bench/scenarios.mjs --seed 42 --tool-harness opencode
```


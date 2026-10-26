# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20261026175025-1ijw` · 2026-10-26T17:52:04.851Z · wall 96.8s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3600 · simulator=http://127.0.0.1:4010 · toolHarness=opencode · git=4437456c · harness=a0d2ecc8b79f13b8

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✘ | 5 | 8 | 35.55 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✘ | 10 | 10 | 56.78 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✘ | 2 | 5 | 22.71 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✘ | 6 | 6 | 93.75 |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:新建产线 `注塑成型质量窗口寻优 injection-ms16y9dg` line=ln-84fb36a6 recipe=rc-598bff6d DCW=11 DAQ=14
- 驱动实测:inj-machine-mbtcp/机筒温度区1SP ✔ · inj-mold-rtu/模具温度SP ✔ · inj-inject-opcua/InjectSpeedSP ✔ · inj-cool-mqtt/WaterTempPV ✔ · inj-inspect-http/PartWeight ✔
- Channel:channel=fa92137c-df77-45e0-9c6f-8490a4b5972e toolAgent=ee2937db-109e-48ea-abc5-9240cd511736 task=b319ce27-cdd5-46ee-850b-a3ab6eb96410 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `A2O 污水生化处理达标降耗 wwtp-ms16y9dg` line=ln-88201e21 recipe=rc-5ff3e9e9 DCW=7 DAQ=13
- 驱动实测:wwtp-blower-mbtcp/风机频率SP ✔ · wwtp-dosing-opcua/NaohDoseSP ✔ · wwtp-return-rtu/内回流比SP ✔ · wwtp-influent-mqtt/CodIn ✔ · wwtp-effluent-http/CodOut ✔
- Channel:channel=770a500f-61b3-4571-8811-415a90b3b166 toolAgent=31a1f6ae-0a84-4411-aa80-c74646b30868 task=878afcf6-4a99-4d0d-998c-b5c2f2f91f63 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `连续退火质量窗内产能最大化 anneal-ms16y9dg` line=ln-16be7f4d recipe=rc-209c7772 DCW=7 DAQ=12
- 驱动实测:anneal-heating-mbtcp/均热区1炉温SP ✔ · anneal-line-opcua/LineSpeedSP ✔ · anneal-cool-rtu/过时效温度SP ✔ · anneal-gas-mqtt/DewPoint ✔ · anneal-inspect-http/Hardness ✔
- Channel:channel=2780a392-6beb-45b2-8f8f-620a8d95e408 toolAgent=9674dbf1-00c1-41fa-aac1-82cebae904a5 task=7da83db8-8acf-431f-bd50-6afc499ef8ba 终态=COMPLETED

### biax · 双拉(BOPET)薄膜产线多节点闭环
- 模拟器侧:{"missing":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"drifted":[],"created":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":9,"expectDevices":9,"signals":49,"sp":30,"pv":19,"descMissing":0,"protocols":["opcua","modbus-tcp","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `双拉(BOPET)薄膜产线多节点闭环 biax-ms16y9dg` line=ln-86da7428 recipe=rc-ecb74c94 DCW=30 DAQ=19
- 驱动实测:biax-dryer-opcua/干燥温度SP ✔ · biax-extruder-mbtcp/机筒温度区1SP ✔ · biax-pump-rtu/计量泵转速SP ✔ · biax-casting-mbtcp/模唇温度SP ✔ · biax-mdo-mbtcp/预热辊1温度SP ✔ · biax-tdo-opcua/TDO预热段SP ✔ · biax-gauge-mqtt/biaxThick ✔ · biax-inspect-http/coronaPower ✔ · biax-winder-mbtcp/收卷张力SP ✔
- Channel:channel=d224bdd6-fe79-46fd-9d3b-82f2c093d960 toolAgent=fc740fdd-114b-4aa1-9f0d-82f13c3eecf9 task=91f23e86-459f-4f76-a27b-34de81019932 终态=COMPLETED

## 2. 闭环优化过程(全轨迹)

### injection · 注塑成型质量窗口寻优

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 31.26 g | — |
| 1 | converge | hold-pressure-sp | 45 → 58.16 | 31.26 g | yes |
| 2 | converge | hold-pressure-sp | 58.2 → 71.35 | 31.26 g | yes |
| 3 | converge | hold-pressure-sp | 71.3 → 84.45 | 31.26 g | yes |
| 4 | converge | hold-pressure-sp | 84.5 → 97.65 | 31.26 g | yes |
| 5 | converge | hold-pressure-sp | 97.7 → 110 | 31.26 g | yes |

- baseline 克重=31.26g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→58.16 ✔ batch=yes · 克重→31.26g
- iter2: hold-pressure-sp 58.2→71.35 ✔ batch=yes · 克重→31.26g
- iter3: hold-pressure-sp 71.3→84.45 ✔ batch=yes · 克重→31.26g
- iter4: hold-pressure-sp 84.5→97.65 ✔ batch=yes · 克重→31.26g
- iter5: hold-pressure-sp 97.7→110 ✔ batch=yes · 克重→31.26g
- iter6: hold-pressure-sp 校正量过小(110→110),换旋钮
- iter7: hold-pressure-sp 校正量过小(110→110),换旋钮
- iter8: hold-pressure-sp 校正量过小(110→110),换旋钮
- outcome: writes=5 final=31.26g attained=false guards={"飞边率":0.0172,"缩痕指数":2.0804}
- 守卫终值:飞边率=0.02 · 缩痕指数=2.08

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.22 mg/L | — |
| 1 | blower | blower-hz-sp | 26 → 30.05 | 0.23 mg/L | yes |
| 2 | blower | blower-hz-sp | 30 → 34.05 | 0.23 mg/L | yes |
| 3 | blower | blower-hz-sp | 34 → 38.05 | 0.23 mg/L | yes |
| 4 | blower | blower-hz-sp | 38 → 42.05 | 0.23 mg/L | yes |
| 5 | blower | blower-hz-sp | 42 → 46.05 | 0.23 mg/L | yes |
| 6 | blower | blower-hz-sp | 46 → 50 | 0.23 mg/L | yes |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.65 mg/L | yes |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.65 mg/L | yes |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.65 mg/L | yes |

- baseline DO=0.22 COD=360 NH3=34.5 TP=0.66 pH=6.58 → 不达标
- iter1(曝气): 风机 26→30.05 ✔
- iter2(曝气): 风机 30→34.05 ✔
- iter3(曝气): 风机 34→38.05 ✔
- iter4(曝气): 风机 38→42.05 ✔
- iter5(曝气): 风机 42→46.05 ✔
- iter6(曝气): 风机 46→50 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标未确认:{"出水COD":359.91999999999996,"出水氨氮":34.488,"出水总磷":0.661,"出水pH":6.5840000000000005,"出水浊度":4.360000000000001,"DO":0.21599999999999997}
- recover(TP): PAC 75→90 ✔
- recover: 风机 50→51.5 ✘ 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-3497b):scen-wwtp:dcw:blower-hz-sp→51.5Hz 被拒(设定值 51.5Hz 超出上限 节点工艺安全量程 的 50Hz —— 约束层:节点安全量程(当前有效写入区间 20~50)。假设:wwtp iter15(recover): 终态非达标(COD 
- outcome: writes=10 DO=0.22 compliant=false cost —→421.5(省 —) attained=false
- **成本曲线**:首个达标运行成本 ≈— → 终态 ≈421.5(降 —,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=359.92 · 出水氨氮=34.49 · 出水总磷=0.66 · 出水pH=6.58 · 出水浊度=4.36 · DO=0.22

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 135.00 HV | — |
| 1 | converge | zone3-sp | 730 → 850 | 135.00 HV | yes |
| 2 | converge | zone2-sp | 710 → 850 | 135.00 HV | yes |

- baseline 硬度=135.0HV 抗拉=311MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- iter2: zone2-sp 710→850 ✔
- iter3: zone3-sp 校正量过小(850)
- iter4: zone2-sp 校正量过小(850)
- iter5: zone3-sp 校正量过小(850)
- outcome: writes=2 final=135.0HV attained=false(窗内+产能≥5%)
- **产能曲线**:线速 140 → — m/min(+—%,质量窗触边自动回退)
- 守卫终值:抗拉强度=310.80 · 表面缺陷率=0.15

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 27.97 μm | — |
| 1 | converge | cast-spd-sp | 32 → 33.7 | 27.97 μm | yes |
| 2 | converge | fast-roll-sp | 118 → 122.4 | 27.97 μm | yes |
| 3 | converge | rail-out-sp | 3000 → 3095 | 27.97 μm | yes |
| 4 | converge | cast-spd-sp | 33.70000076293945 → 35.5 | 27.97 μm | yes |
| 5 | converge | fast-roll-sp | 122.4000015258789 → 126.9 | 27.98 μm | yes |
| 6 | converge | rail-out-sp | 3095 → 3194 | 28.00 μm | yes |

- 1. task board: channel=a73c2def-9163-4110-b6f1-7aff2eec9f29 parent=bd688825-95fa-413e-9548-d9e1d196ba25 leadChild=8149fa8b-0929-41eb-8368-ecec27005f4d
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[27.93,3.5,1.6]
- 3. initial thickness=27.97 μm(目标 25±0.7)
- iter1: cast-spd-sp 32→33.7 ✔ batch=rr-60cfa… · thickness→27.97μm · 复测待判读
-         meltTemp=291.4℃(安全窗 268~300)
- iter2: fast-roll-sp 118→122.4 ✔ batch=rr-1a496… · thickness→27.97μm · 复测待判读
-         meltTemp=291.4℃(安全窗 268~300)
- iter3: rail-out-sp 3000→3095 ✔ batch=rr-783f1… · thickness→27.97μm · 复测待判读
-         meltTemp=291.4℃(安全窗 268~300)
- iter4: cast-spd-sp 33.70000076293945→35.5 ✔ batch=rr-28058… · thickness→27.97μm · 复测待判读
-         meltTemp=291.4℃(安全窗 268~300)
- iter5: fast-roll-sp 122.4000015258789→126.9 ✔ batch=rr-6fdec… · thickness→27.98μm · 复测待判读
-         meltTemp=291.0℃(安全窗 268~300)
- iter6: rail-out-sp 3095→3194 ✔ batch=rr-39395… · thickness→28.00μm · 复测待判读
-         meltTemp=291.4℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✘ · 无权查询节点 dw-363ab0f9 的账本(仅可查你绑定范围内的对象:rc-ecb74c94, dn-c816f0d2, dn-46071b95, dn-c6be421f, dn-8b7b8b0e, dn-35f22f75, dn-dd1
- 5. outcome: writes=6 distinctKnobs=3 final=28.00μm attained=false
- 6. task terminal=COMPLETED

## 3. 诚实边界
- 全部写路径经平台治理(绑定配方上的 recipe_trial 整批试验下发,复测判读,不写配方版本);策略为确定性脚本(不经 LLM),与真实 LLM 变体共用同一工具面与治理链路。
- 物理数据由模拟器多引擎(cast-film/biax/injection/wwtp/anneal)产出,同 seed 确定性;J/W* 与真实产线存在仿真层级边界。
- 平台侧产线为「复用优先」:本报告如显示 reused,说明前次接入仍在,本次零重复建线(设计语义)。

## 4. 复现

```bash
NO_PROXY=127.0.0.1,localhost \
AW_BASE=http://127.0.0.1:3600 SIM_BASE=http://127.0.0.1:4010 \
  node bench/scenarios.mjs --seed 42 --tool-harness opencode
```


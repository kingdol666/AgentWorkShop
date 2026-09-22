# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20260921054222-13wo` · 2026-09-21T05:49:58.881Z · wall 380.1s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3007 · simulator=http://127.0.0.1:4013 · toolHarness=opencode · git=e692df1 · harness=069fda319c0cbac1

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 3 | 4 | 35.36 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✘ | 3 | 6 | 33.79 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✘ | 1 | 3 | 33.19 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✘ | 6 | 6 | 377.11 |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:新建产线 `注塑成型质量窗口寻优 injection-ms16kqv9` line=ln-5bd6e2ad recipe=rc-e1a95e9a DCW=11 DAQ=14
- 驱动实测:inj-machine-mbtcp/机筒温度区1SP ✔ · inj-mold-rtu/模具温度SP ✔ · inj-inject-opcua/InjectSpeedSP ✔ · inj-cool-mqtt/WaterTempPV ✔ · inj-inspect-http/PartWeight ✔
- Channel:channel=203cfe0e-859a-48f3-9ba3-6858b15fff89 toolAgent=31edeb7a-10db-419f-94a8-e250172527a9 task=aed445e4-4e31-4e69-8ae1-afa1aae73ae3 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `A2O 污水生化处理达标降耗 wwtp-ms16kqv9` line=ln-ddb2b95f recipe=rc-68c84696 DCW=7 DAQ=13
- 驱动实测:wwtp-blower-mbtcp/风机频率SP ✔ · wwtp-dosing-opcua/NaohDoseSP ✔ · wwtp-return-rtu/内回流比SP ✔ · wwtp-influent-mqtt/CodIn ✔ · wwtp-effluent-http/CodOut ✔
- Channel:channel=4cd014ab-086e-40dd-9913-a8db3369f9f7 toolAgent=5a62e965-e3e4-44f5-b64d-ad7e8f1595bb task=0bf62512-5c9d-43ea-bb68-29e6891425e1 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `连续退火质量窗内产能最大化 anneal-ms16kqv9` line=ln-ccb13d79 recipe=rc-bea557d2 DCW=7 DAQ=12
- 驱动实测:anneal-heating-mbtcp/均热区1炉温SP ✔ · anneal-line-opcua/LineSpeedSP ✔ · anneal-cool-rtu/过时效温度SP ✔ · anneal-gas-mqtt/DewPoint ✔ · anneal-inspect-http/Hardness ✔
- Channel:channel=1a6d1c44-848e-4245-b266-58ed9555d020 toolAgent=0db6bcc1-4a50-40c3-bdb2-e4f3ca070603 task=11ad7f1e-545a-4771-9705-0d3546b7fbf8 终态=COMPLETED

### biax · 双拉(BOPET)薄膜产线多节点闭环
- 模拟器侧:{"missing":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"drifted":[],"created":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":9,"expectDevices":9,"signals":49,"sp":30,"pv":19,"descMissing":0,"protocols":["opcua","modbus-tcp","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `双拉(BOPET)薄膜产线多节点闭环 biax-ms16kqv9` line=ln-baf039e6 recipe=rc-0b1b8532 DCW=30 DAQ=19
- 驱动实测:biax-dryer-opcua/干燥温度SP ✔ · biax-extruder-mbtcp/机筒温度区1SP ✔ · biax-pump-rtu/计量泵转速SP ✔ · biax-casting-mbtcp/模唇温度SP ✔ · biax-mdo-mbtcp/预热辊1温度SP ✔ · biax-tdo-opcua/TDO预热段SP ✔ · biax-gauge-mqtt/biaxThick ✔ · biax-inspect-http/coronaPower ✔ · biax-winder-mbtcp/收卷张力SP ✔
- Channel:channel=e8963afd-1ff3-4027-8b25-0fcf07d2ec09 toolAgent=880402d9-48b0-423f-8fec-73a9c5c6b3ab task=188b1043-ac8e-4b62-9ae4-5ad365855629 终态=COMPLETED

## 2. 闭环优化过程(全轨迹)

### injection · 注塑成型质量窗口寻优

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 31.26 g | — |  |
| 1 | converge | hold-pressure-sp | 45 → 58.14 | 31.95 g | yes | keep ✔ |
| 2 | converge | hold-time-sp | 6 → 10.37 | 32.14 g | yes | keep ✔ |
| 3 | converge | hold-pressure-sp | 58.1 → 61.87 | 32.32 g | yes | keep ✔ |

- baseline 克重=31.26g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→58.14 ✔ record=yes · 克重→31.95g
- iter2: hold-time-sp 6→10.37 ✔ record=yes · 克重→32.14g
- iter3: hold-pressure-sp 58.1→61.87 ✔ record=yes · 克重→32.32g
- outcome: writes=3 final=32.32g attained=true guards={"飞边率":0.0052,"缩痕指数":0.8989999999999998}
- 守卫终值:飞边率=0.01 · 缩痕指数=0.90

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.23 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30.04 | 0.29 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.55 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.45 mg/L | yes | keep ✔ |

- baseline DO=0.23 COD=360 NH3=34.5 TP=0.66 pH=6.58 → 不达标
- iter1(曝气): 风机 26→30.04 ✔
- iter2(曝气): 风机 null→20 ✘ blower-hz-sp 校正量过小或读失败(null)
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC null→15 ✘ pac-dose-sp 校正量过小或读失败(null)
- 达标未确认:{"出水COD":93.82,"出水氨氮":9.51,"出水总磷":0.465,"出水pH":6.048,"出水浊度":0.6900000000000001,"DO":0.252}
- recover: 风机 null→1.5 ✘ blower-hz-sp 校正量过小或读失败(null)
- outcome: writes=3 DO=0.25 compliant=false cost —→0.0(省 —) attained=false
- **成本曲线**:首个达标运行成本 ≈— → 终态 ≈0.0(降 —,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=93.82 · 出水氨氮=9.51 · 出水总磷=0.47 · 出水pH=6.05 · 出水浊度=0.69 · DO=0.25

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.72 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.16 HV | yes | keep ✔ |

- baseline 硬度=134.7HV 抗拉=311MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- iter6(产能): 写被拒 → 下发失败:OPC UA 写入失败: 连接已断开——将自动重建连接,若持续失败请检查线缆(Invalid Channel BadConnectionClosed)(节点 scen-anneal:dcw:line-speed-sp,物理量 烘箱
- 产能推进: 线速 140→null(+0%),pushed=0
- outcome: writes=1 final=99.2HV attained=false(窗内+产能≥5%)
- **产能曲线**:线速 140 → — m/min(+0.0%,质量窗触边自动回退)
- 守卫终值:抗拉强度=296.52 · 表面缺陷率=0.16

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 27.99 μm | — |  |
| 1 | converge | cast-spd-sp | 32 → 33.7 | 15.96 μm | yes | keep ✔ |
| 2 | converge | fast-roll-sp | 118 → 94.6 | 13.24 μm | yes | keep ✔ |
| 3 | converge | rail-out-sp | 3000 → 2201 | 45.15 μm | yes | keep ✔ |
| 4 | converge | cast-spd-sp | 33.70000076293945 → 41.2 | 14.85 μm | yes | keep ✔ |
| 5 | converge | fast-roll-sp | 94.5999984741211 → 72 | 29.09 μm | yes | keep ✔ |
| 6 | converge | rail-out-sp | 2201 → 2294 | 37.31 μm | yes | keep ✔ |

- 1. task board: channel=5869215a-30ee-44ba-9aee-52bbe1981fc3 parent=4069c695-5c80-4fa3-85f6-5260fe6953e9 leadChild=66536118-c9ba-453a-abb0-df39aa3e4148
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.07,3.5,1.6]
- 3. initial thickness=27.99 μm(目标 25±0.7)
- iter1: cast-spd-sp 32→33.7 ✔ record=opt-0c6ba4… · thickness→15.96μm · judge=keep✔
-         meltTemp=291.4℃(安全窗 268~300)
- iter2: fast-roll-sp 118→94.6 ✔ record=opt-e22c5d… · thickness→13.24μm · judge=keep✔
-         meltTemp=291.8℃(安全窗 268~300)
- iter3: rail-out-sp 3000→2201 ✔ record=opt-f5d2bd… · thickness→45.15μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- iter4: cast-spd-sp 33.70000076293945→41.2 ✔ record=opt-592849… · thickness→14.85μm · judge=keep✔
-         meltTemp=291.3℃(安全窗 268~300)
- iter5: fast-roll-sp 94.5999984741211→72 ✔ record=opt-881cc5… · thickness→29.09μm · judge=keep✔
-         meltTemp=291.4℃(安全窗 268~300)
- iter6: rail-out-sp 2201→2294 ✔ record=opt-e09ec1… · thickness→37.31μm · judge=keep✔
-         meltTemp=291.4℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(2 条,含参数/判定/窗口):
- opt-592849c0 [judged-keep] scen-biax:dcw:cast-spd-sp: 33.7 → 41.2,设定 13:46:52,判定 keep(agent:biax 
- 5. outcome: writes=6 distinctKnobs=3 final=37.31μm attained=false
- 6. task terminal=COMPLETED

## 3. 诚实边界
- 全部写路径经平台治理(dcw_control 自动开优化记录 + dcw_judge 判定收口);策略为确定性脚本(不经 LLM),与真实 LLM 变体共用同一工具面与治理链路。
- 物理数据由模拟器多引擎(cast-film/biax/injection/wwtp/anneal)产出,同 seed 确定性;J/W* 与真实产线存在仿真层级边界。
- 平台侧产线为「复用优先」:本报告如显示 reused,说明前次接入仍在,本次零重复建线(设计语义)。

## 4. 复现

```bash
NO_PROXY=127.0.0.1,localhost \
AW_BASE=http://127.0.0.1:3007 SIM_BASE=http://127.0.0.1:4013 \
  node bench/scenarios.mjs --seed 42 --tool-harness opencode
```


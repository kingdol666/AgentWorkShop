# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20260921155514-16lg` · 2026-09-21T16:15:04.355Z · wall 204.39s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=77d571c3f882a79d

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 3 | 4 | 34.47 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 16 | 13 | 201.38 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✘ | 2 | 3 | 42.21 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✔ | 3 | 3 | — |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:复用既有产线 `注塑成型质量窗口寻优 injection-undefined` line=ln-29a4e0b1 recipe=rc-ca872469 DCW=11 DAQ=14
- 驱动实测:—
- Channel:channel=dfd1139f-d67e-4f8a-9e8e-d289ef348018 toolAgent=323bd324-7319-44fb-a93f-137554b383e2 task=f165cf7b-b066-4586-833b-ece6a3c6f0d3 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `A2O 污水生化处理达标降耗 wwtp-undefined` line=ln-e8d027b1 recipe=rc-b40e0b47 DCW=7 DAQ=13
- 驱动实测:—
- Channel:channel=9e2210f0-11f3-4636-8468-b382b9544960 toolAgent=7ea323e3-09b5-48d5-9d49-13d0e9753413 task=ac939ed1-122d-4ae6-82ce-276997c8517a 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `连续退火质量窗内产能最大化 anneal-undefined` line=ln-aa33aa64 recipe=rc-06c6d5de DCW=7 DAQ=12
- 驱动实测:—
- Channel:channel=1922844e-1909-4258-a7e2-6d36c7207626 toolAgent=5bffba2a-31c1-4ee5-9455-26bff5c04075 task=bbdb086e-b830-4c6b-a7b1-ed40829ca0b3 终态=COMPLETED

### biax · 双拉(BOPET)薄膜产线多节点闭环
- 模拟器侧:{}
- 终验:{}
- 平台侧:复用既有产线 `` line=undefined recipe=undefined DCW=undefined DAQ=undefined
- 驱动实测:—
- Channel:—

## 2. 闭环优化过程(全轨迹)

### injection · 注塑成型质量窗口寻优

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 31.25 g | — |  |
| 1 | converge | hold-pressure-sp | 45 → 58.26 | 31.92 g | yes | keep ✔ |
| 2 | converge | hold-time-sp | 6 → 10.61 | 32.14 g | yes | keep ✔ |
| 3 | converge | hold-pressure-sp | 58.3 → 62.07 | 32.39 g | yes | keep ✔ |

- baseline 克重=31.25g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→58.26 ✔ record=yes · 克重→31.92g
- iter2: hold-time-sp 6→10.61 ✔ record=yes · 克重→32.14g
- iter3: hold-pressure-sp 58.3→62.07 ✔ record=yes · 克重→32.39g
- outcome: writes=3 final=32.39g attained=true guards={"飞边率":0.014000000000000002,"缩痕指数":0.841}
- 守卫终值:飞边率=0.01 · 缩痕指数=0.84

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.23 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30.03 | 2.16 mg/L | yes | keep ✔ |
| 2 | blower | blower-hz-sp | 30 → 31.6 | 2.74 mg/L | yes | keep ✔ |
| 3 | blower | blower-hz-sp | 31.600000381469727 → 32.48 | 3.11 mg/L | yes | keep ✔ |
| 4 | blower | blower-hz-sp | 32.5 → 33.3 | 3.17 mg/L | yes | keep ✔ |
| 5 | blower | blower-hz-sp | 33.29999923706055 → 34.1 | 3.50 mg/L | yes | keep ✔ |
| 5 | ph | naoh-dose-sp | 12 → 30.37 | 6.62 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.55 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.47 mg/L | yes | keep ✔ |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.41 mg/L | yes | keep ✔ |

- baseline DO=0.23 COD=360 NH3=34.4 TP=0.67 pH=6.58 → 不达标
- iter1(曝气): 风机 26→30.03 ✔
- iter2(曝气): 风机 30→31.6 ✔
- iter3(曝气): 风机 31.600000381469727→32.48 ✔
- iter4(曝气): 风机 32.5→33.3 ✔
- iter5(曝气): 风机 33.29999923706055→34.1 ✔
- iter5(中和): NaOH 12→30.37 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标确认 ✔ 首个达标运行成本 ≈182.3(风机 34.099998474121094/NaOH 30/PAC 75)
- iter11(降耗): 风机 34.099998474121094→32.9 复测非裕度达标(49/3.5) → 回退 ✔
- iter11(降耗): NaOH 30→26 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 34.099998474121094→32.9 复测非裕度达标(48/3.4) → 回退 ✔
- iter12(降耗): NaOH 26→22 复测非裕度达标(pH 6.30) → 回退 ✔
- outcome: writes=16 DO=3.60 compliant=true cost 182.3→181.1(省 1.2) attained=true
- **成本曲线**:首个达标运行成本 ≈182.3 → 终态 ≈181.1(降 1.2,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=41.10 · 出水氨氮=2.51 · 出水总磷=0.41 · 出水pH=6.46 · 出水浊度=0.62 · DO=3.60

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.92 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.42 HV | — | ✘ |

- baseline 硬度=134.9HV 抗拉=310MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- iter6(产能): 线速 140→152 硬度 100.5HV 出窗/无裕度 → 回退 ✔
- 产能推进: 线速 140→140(+0%),pushed=0
- outcome: writes=2 final=100.2HV attained=false(窗内+产能≥5%)
- **产能曲线**:线速 140 → 140 m/min(+0.0%,质量窗触边自动回退)
- 守卫终值:抗拉强度=297.24 · 表面缺陷率=0.16

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 28.00 μm | — |  |
| 1 | converge | cast-spd-sp | 32 → 33.7 | 26.64 μm | yes | keep ✔ |
| 2 | converge | fast-roll-sp | 118 → 120.5 | 26.06 μm | yes | keep ✔ |
| 3 | converge | rail-out-sp | 3000 → 3037 | 25.56 μm | yes | keep ✔ |

- 1. task board: channel=0c0a5a33-c365-481b-94e9-a2ab48cd2b3b parent=e2e07f99-ef3a-413d-a985-6278d51b7109 leadChild=681835fc-7a19-4e4e-9c06-83e714eecfd1
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[3.5,1.6]
- 3. initial thickness=28.00 μm(目标 25±0.7)
- iter1: cast-spd-sp 32→33.7 ✔ record=opt-a44397… · thickness→26.64μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- iter2: fast-roll-sp 118→120.5 ✔ record=opt-99836f… · thickness→26.06μm · judge=keep✔
-         meltTemp=291.8℃(安全窗 268~300)
- iter3: rail-out-sp 3000→3037 ✔ record=opt-285e8f… · thickness→25.56μm · judge=keep✔
-         meltTemp=291.8℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(1 条,含参数/判定/窗口):
- opt-a4439752 [judged-keep] 铸片辊速度SP·ip16fbfz: 32 → 33.7,设定 00:08:33,判定 keep(agent:biax mission ite
- 5. outcome: writes=3 distinctKnobs=3 final=25.56μm attained=true
- 6. task terminal=COMPLETED

## 3. 诚实边界
- 全部写路径经平台治理(dcw_control 自动开优化记录 + dcw_judge 判定收口);策略为确定性脚本(不经 LLM),与真实 LLM 变体共用同一工具面与治理链路。
- 物理数据由模拟器多引擎(cast-film/biax/injection/wwtp/anneal)产出,同 seed 确定性;J/W* 与真实产线存在仿真层级边界。
- 平台侧产线为「复用优先」:本报告如显示 reused,说明前次接入仍在,本次零重复建线(设计语义)。

## 4. 复现

```bash
NO_PROXY=127.0.0.1,localhost \
AW_BASE=http://127.0.0.1:3005 SIM_BASE=http://127.0.0.1:4011 \
  node bench/scenarios.mjs --seed 42 --tool-harness opencode
```


# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:PASS** · run `20260921161746-x2w` · 2026-09-21T16:39:47.794Z · wall 184.25s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=11f00c625a936e68

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 3 | 4 | 34.38 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 15 | 13 | 181.24 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✔ | 6 | 7 | 66.74 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✔ | 4 | 4 | — |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:复用既有产线 `注塑成型质量窗口寻优 injection-undefined` line=ln-29a4e0b1 recipe=rc-ca872469 DCW=11 DAQ=14
- 驱动实测:—
- Channel:channel=1e747ae2-05d6-4665-9375-8a8e00dd3e28 toolAgent=2669c092-0a2b-46a2-968b-777115790e1e task=167e68fd-1bc7-4dc9-ac82-0c775c4ba59e 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `A2O 污水生化处理达标降耗 wwtp-undefined` line=ln-e8d027b1 recipe=rc-b40e0b47 DCW=7 DAQ=13
- 驱动实测:—
- Channel:channel=e5b22721-9c39-4bf0-abcc-8df807519f41 toolAgent=c8c03a70-aca1-4239-926a-477e7cb704cc task=490c2973-40fb-472a-81f5-2f3c834b7695 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `连续退火质量窗内产能最大化 anneal-undefined` line=ln-aa33aa64 recipe=rc-06c6d5de DCW=7 DAQ=12
- 驱动实测:—
- Channel:channel=c102f4d7-5bd0-4f1b-a25d-73482a5eb8f7 toolAgent=d386a88a-6910-4f4f-9a81-c1b7012d4376 task=feb5b075-e217-4b41-a38a-5fbf40e16b0e 终态=COMPLETED

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
| 0 | baseline | — | — | 31.30 g | — |  |
| 1 | converge | hold-pressure-sp | 45 → 57.73 | 31.89 g | yes | keep ✔ |
| 2 | converge | hold-time-sp | 6 → 10.85 | 32.15 g | yes | keep ✔ |
| 3 | converge | hold-pressure-sp | 57.7 → 61.4 | 32.32 g | yes | keep ✔ |

- baseline 克重=31.30g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→57.73 ✔ record=yes · 克重→31.89g
- iter2: hold-time-sp 6→10.85 ✔ record=yes · 克重→32.15g
- iter3: hold-pressure-sp 57.7→61.4 ✔ record=yes · 克重→32.32g
- outcome: writes=3 final=32.32g attained=true guards={"飞边率":0.0078,"缩痕指数":0.9578}
- 守卫终值:飞边率=0.01 · 缩痕指数=0.96

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.23 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30.03 | 2.16 mg/L | yes | keep ✔ |
| 2 | blower | blower-hz-sp | 30 → 31.6 | 2.80 mg/L | yes | keep ✔ |
| 3 | blower | blower-hz-sp | 31.600000381469727 → 32.4 | 3.05 mg/L | yes | keep ✔ |
| 4 | blower | blower-hz-sp | 32.400001525878906 → 33.2 | 3.11 mg/L | yes | keep ✔ |
| 5 | blower | blower-hz-sp | 33.20000076293945 → 34 | 3.46 mg/L | yes | keep ✔ |
| 5 | ph | naoh-dose-sp | 12 → 31.02 | 6.67 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.54 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.46 mg/L | yes | keep ✔ |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.41 mg/L | yes | keep ✔ |

- baseline DO=0.23 COD=360 NH3=34.5 TP=0.65 pH=6.59 → 不达标
- iter1(曝气): 风机 26→30.03 ✔
- iter2(曝气): 风机 30→31.6 ✔
- iter3(曝气): 风机 31.600000381469727→32.4 ✔
- iter4(曝气): 风机 32.400001525878906→33.2 ✔
- iter5(曝气): 风机 33.20000076293945→34 ✔
- iter5(中和): NaOH 12→31.02 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标确认 ✔ 首个达标运行成本 ≈181.5(风机 34/NaOH 31/PAC 75)
- iter11(降耗): 风机 34→32.8 复测非裕度达标(49/3.4) → 回退 ✔
- iter11(降耗): NaOH 31→27 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 34→32.8 复测非裕度达标(49/3.4) → 回退 ✔
- iter12(降耗): NaOH 27→23 ✔ 带裕度复测达标,保留
- outcome: writes=15 DO=3.53 compliant=true cost 181.5→179.1(省 2.4) attained=true
- **成本曲线**:首个达标运行成本 ≈181.5 → 终态 ≈179.1(降 2.4,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=41.74 · 出水氨氮=2.56 · 出水总磷=0.41 · 出水pH=6.34 · 出水浊度=0.67 · DO=3.53

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.92 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.58 HV | — | ✘ |
| trim1 | margin | zone2-sp | 710 → 722 | 99.36 HV | yes | keep ✔ |
| trim2 | margin | zone2-sp | 722 → 734 | 99.20 HV | yes | keep ✔ |
| 6 | throughput | line-speed-sp | 140 → 152 | 99.00 HV | yes | keep ✔ |
| 7 | throughput | line-speed-sp | 152 → 164 | 98.84 HV | yes | keep ✔ |

- baseline 硬度=134.9HV 抗拉=310MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- trim1: zone2-sp 710→722 硬度→99.4HV(修剪线 ≤98)
- trim2: zone2-sp 722→734 硬度→99.2HV(修剪线 ≤98)
- iter6(产能): 线速 140→152 ✔ 硬度 99.0HV 留裕度窗内
- iter7(产能): 线速 152→164 ✔ 硬度 98.8HV 留裕度窗内
- iter8(产能): 线速 164→176 硬度 100.2HV 出窗/无裕度 → 回退 ✔
- 产能推进: 线速 140→164(+17.14%),pushed=2
- outcome: writes=6 final=99.7HV attained=true(窗内+产能≥5%)
- **产能曲线**:线速 140 → 164 m/min(+17.1%,质量窗触边自动回退)
- 守卫终值:抗拉强度=296.44 · 表面缺陷率=0.15

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 28.00 μm | — |  |
| 1 | converge | cast-spd-sp | 32 → 33.7 | 26.70 μm | yes | keep ✔ |
| 2 | converge | fast-roll-sp | 118 → 120.6 | 25.94 μm | yes | keep ✔ |
| 3 | converge | rail-out-sp | 3000 → 3033 | 25.74 μm | yes | keep ✔ |
| 4 | converge | cast-spd-sp | 33.70000076293945 → 34.2 | 25.32 μm | yes | keep ✔ |

- 1. task board: channel=d1fa3bbf-bc23-4909-988d-991fab9e0764 parent=cdcbcee2-3f2b-4fce-af1b-48ecbe958546 leadChild=bd9c979e-3f58-4cf8-8267-408e827f7e02
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[3.5,1.6]
- 3. initial thickness=28.00 μm(目标 25±0.7)
- iter1: cast-spd-sp 32→33.7 ✔ record=opt-b52c95… · thickness→26.70μm · judge=keep✔
-         meltTemp=291.6℃(安全窗 268~300)
- iter2: fast-roll-sp 118→120.6 ✔ record=opt-16d809… · thickness→25.94μm · judge=keep✔
-         meltTemp=291.9℃(安全窗 268~300)
- iter3: rail-out-sp 3000→3033 ✔ record=opt-40fbe3… · thickness→25.74μm · judge=keep✔
-         meltTemp=291.8℃(安全窗 268~300)
- iter4: cast-spd-sp 33.70000076293945→34.2 ✔ record=opt-a52316… · thickness→25.32μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(2 条,含参数/判定/窗口):
- opt-a5231637 [judged-keep] 铸片辊速度SP·ip168b09: 33.7 → 34.2,设定 00:35:37,判定 keep(agent:biax mission i
- 5. outcome: writes=4 distinctKnobs=3 final=25.32μm attained=true
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


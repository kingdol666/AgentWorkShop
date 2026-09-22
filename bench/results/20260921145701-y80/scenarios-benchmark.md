# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:PASS** · run `20260921145701-y80` · 2026-09-21T15:08:45.884Z · wall 148.31s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=77d571c3f882a79d

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 2 | 3 | 26.56 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 14 | 13 | 145.3 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✔ | 3 | 4 | 50.46 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✔ | 4 | 4 | — |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:复用既有产线 `注塑成型质量窗口寻优 injection-undefined` line=ln-ec526b67 recipe=rc-52efe285 DCW=11 DAQ=14
- 驱动实测:—
- Channel:channel=2f302099-badc-45b2-9330-f44e1a512ead toolAgent=386d4f6f-5829-427c-9271-f861c6703dd0 task=15f412c8-5a56-4a22-84ef-5ede14b58f52 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `A2O 污水生化处理达标降耗 wwtp-undefined` line=ln-df1f24df recipe=rc-bfe67a0d DCW=7 DAQ=13
- 驱动实测:—
- Channel:channel=688c96ee-70ca-4485-9008-f159b3df512f toolAgent=d8af907b-2abb-4496-ad5b-392c9b5140b9 task=33ede518-28a3-4219-b8c4-81730c28579e 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `连续退火质量窗内产能最大化 anneal-undefined` line=ln-2286e261 recipe=rc-53808ef0 DCW=7 DAQ=12
- 驱动实测:—
- Channel:channel=dda67827-a6c9-4fbe-a3cf-4ae78500912c toolAgent=3987c98d-575b-42d3-bde6-8628fbc27e9c task=ae7d7253-da56-45fb-a3f4-001c40507d01 终态=COMPLETED

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
| 1 | converge | hold-pressure-sp | 45 → 57.73 | 31.90 g | yes | keep ✔ |
| 2 | converge | hold-time-sp | 6 → 10.77 | 32.15 g | yes | keep ✔ |

- baseline 克重=31.30g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→57.73 ✔ record=yes · 克重→31.90g
- iter2: hold-time-sp 6→10.77 ✔ record=yes · 克重→32.15g
- outcome: writes=2 final=32.15g attained=true guards={"飞边率":0.0064,"缩痕指数":1.012}
- 守卫终值:飞边率=0.01 · 缩痕指数=1.01

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.21 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30.06 | 2.20 mg/L | yes | keep ✔ |
| 2 | blower | blower-hz-sp | 30.100000381469727 → 31.65 | 2.75 mg/L | yes | keep ✔ |
| 3 | blower | blower-hz-sp | 31.600000381469727 → 32.44 | 3.02 mg/L | yes | keep ✔ |
| 4 | blower | blower-hz-sp | 32.400001525878906 → 33.2 | 3.21 mg/L | yes | keep ✔ |
| 5 | blower | blower-hz-sp | 33.20000076293945 → 34 | 3.54 mg/L | yes | keep ✔ |
| 5 | ph | naoh-dose-sp | 12 → 31.02 | 6.67 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.55 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.47 mg/L | yes | keep ✔ |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.40 mg/L | yes | keep ✔ |

- baseline DO=0.21 COD=360 NH3=34.5 TP=0.67 pH=6.58 → 不达标
- iter1(曝气): 风机 26→30.06 ✔
- iter2(曝气): 风机 30.100000381469727→31.65 ✔
- iter3(曝气): 风机 31.600000381469727→32.44 ✔
- iter4(曝气): 风机 32.400001525878906→33.2 ✔
- iter5(曝气): 风机 33.20000076293945→34 ✔
- iter5(中和): NaOH 12→31.02 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标确认 ✔ 首个达标运行成本 ≈181.5(风机 34/NaOH 31/PAC 75)
- iter11(降耗): 风机 34→32.8 复测非裕度达标(49/3.5) → 回退 ✔
- iter11(降耗): NaOH 31→27 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 34→32.8 ✔ 带裕度复测达标,保留
- iter12(降耗): NaOH 27→23 ✔ 带裕度复测达标,保留
- outcome: writes=14 DO=3.24 compliant=true cost 181.5→166.8(省 14.75) attained=true
- **成本曲线**:首个达标运行成本 ≈181.5 → 终态 ≈166.8(降 14.8,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=49.20 · 出水氨氮=3.47 · 出水总磷=0.42 · 出水pH=6.38 · 出水浊度=0.61 · DO=3.24

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.92 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.52 HV | — | ✘ |
| 6 | throughput | line-speed-sp | 140 → 152 | 99.60 HV | — | ✘ |

- baseline 硬度=134.9HV 抗拉=310MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- iter6(产能): 线速 140→152 ✔ 硬度 99.6HV 留裕度窗内
- iter7(产能): 线速 152→164 硬度 100.2HV 出窗/无裕度 → 回退 ✔
- 产能推进: 线速 140→152(+8.57%),pushed=1
- outcome: writes=3 final=100.9HV attained=true(窗内+产能≥5%)
- **产能曲线**:线速 140 → 152 m/min(+8.6%,质量窗触边自动回退)
- 守卫终值:抗拉强度=297.36 · 表面缺陷率=0.15

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 28.00 μm | — |  |
| 1 | converge | cast-spd-sp | 32 → 33.7 | 26.64 μm | yes | keep ✔ |
| 2 | converge | fast-roll-sp | 118 → 120.5 | 25.98 μm | yes | keep ✔ |
| 3 | converge | rail-out-sp | 3000 → 3034 | 25.78 μm | yes | keep ✔ |
| 4 | converge | cast-spd-sp | 33.70000076293945 → 34.2 | 25.30 μm | yes | keep ✔ |

- 1. task board: channel=cbd25f94-ead5-4882-90ea-3381a8c7c2af parent=1d105985-4b36-430b-8836-e213b068b549 leadChild=c30ef14b-6b5b-4906-8506-28a1d509bb35
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[3.5,1.6]
- 3. initial thickness=28.00 μm(目标 25±0.7)
- iter1: cast-spd-sp 32→33.7 ✔ record=opt-1ab545… · thickness→26.64μm · judge=keep✔
-         meltTemp=291.6℃(安全窗 268~300)
- iter2: fast-roll-sp 118→120.5 ✔ record=opt-edece7… · thickness→25.98μm · judge=keep✔
-         meltTemp=291.4℃(安全窗 268~300)
- iter3: rail-out-sp 3000→3034 ✔ record=opt-a928fd… · thickness→25.78μm · judge=keep✔
-         meltTemp=291.4℃(安全窗 268~300)
- iter4: cast-spd-sp 33.70000076293945→34.2 ✔ record=opt-6c3270… · thickness→25.30μm · judge=keep✔
-         meltTemp=291.7℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(2 条,含参数/判定/窗口):
- opt-6c32709b [judged-keep] 铸片辊速度SP·ip16cijo: 33.7 → 34.2,设定 23:05:11,判定 keep(agent:biax mission i
- 5. outcome: writes=4 distinctKnobs=3 final=25.30μm attained=true
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


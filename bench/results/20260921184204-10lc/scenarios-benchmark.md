# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:PASS** · run `20260921184204-10lc` · 2026-09-21T19:08:02.941Z · wall 172.29s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=9f2756dce4a4cbb3

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 2 | 3 | 26.48 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 15 | 13 | 169.27 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✔ | 5 | 6 | 102.76 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✔ | 3 | 3 | — |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:复用既有产线 `注塑成型质量窗口寻优 injection-undefined` line=ln-e8350d53 recipe=rc-fb7b675b DCW=11 DAQ=14
- 驱动实测:—
- Channel:channel=c0686c76-c6e2-4984-90c1-61c22ecf5de1 toolAgent=79591bc7-4954-4981-a873-59b2f01e9d87 task=a79b48bb-8b0c-4b3c-bec7-97b9470fbc41 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `A2O 污水生化处理达标降耗 wwtp-undefined` line=ln-00f606d3 recipe=rc-ca808507 DCW=7 DAQ=13
- 驱动实测:—
- Channel:channel=c0e0b8e4-0cbe-47eb-8cc2-08324a13bec2 toolAgent=d4843ce7-626c-49aa-80e3-f9351ca30b6a task=d0492471-1e2a-440a-885c-306736542f6f 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `连续退火质量窗内产能最大化 anneal-undefined` line=ln-2757f3f4 recipe=rc-3c91c7af DCW=7 DAQ=12
- 驱动实测:—
- Channel:channel=fc7d20d5-d4c1-4333-830f-646f0556751c toolAgent=b8450619-4b9a-4c42-b7fc-4880642d07eb task=60bbc820-51cd-4216-9e90-b9339f768638 终态=COMPLETED

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
| 1 | converge | hold-pressure-sp | 45 → 58.2 | 31.92 g | yes | keep ✔ |
| 2 | converge | hold-time-sp | 6 → 10.64 | 32.17 g | yes | keep ✔ |

- baseline 克重=31.25g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→58.2 ✔ record=yes · 克重→31.92g
- iter2: hold-time-sp 6→10.64 ✔ record=yes · 克重→32.17g
- outcome: writes=2 final=32.17g attained=true guards={"飞边率":0.0184,"缩痕指数":0.9606}
- 守卫终值:飞边率=0.02 · 缩痕指数=0.96

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.21 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30.05 | 2.15 mg/L | yes | keep ✔ |
| 2 | blower | blower-hz-sp | 30 → 31.59 | 2.74 mg/L | yes | keep ✔ |
| 3 | blower | blower-hz-sp | 31.600000381469727 → 32.42 | 3.06 mg/L | yes | keep ✔ |
| 4 | blower | blower-hz-sp | 32.400001525878906 → 33.2 | 3.18 mg/L | yes | keep ✔ |
| 5 | blower | blower-hz-sp | 33.20000076293945 → 34 | 3.52 mg/L | yes | keep ✔ |
| 5 | ph | naoh-dose-sp | 12 → 30.85 | 6.69 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.54 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.47 mg/L | yes | keep ✔ |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.42 mg/L | yes | keep ✔ |

- baseline DO=0.21 COD=360 NH3=34.4 TP=0.66 pH=6.59 → 不达标
- iter1(曝气): 风机 26→30.05 ✔
- iter2(曝气): 风机 30→31.59 ✔
- iter3(曝气): 风机 31.600000381469727→32.42 ✔
- iter4(曝气): 风机 32.400001525878906→33.2 ✔
- iter5(曝气): 风机 33.20000076293945→34 ✔
- iter5(中和): NaOH 12→30.85 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标确认 ✔ 首个达标运行成本 ≈181.5(风机 34/NaOH 31/PAC 75)
- iter11(降耗): 风机 34→32.8 复测非裕度达标(48/3.3) → 回退 ✔
- iter11(降耗): NaOH 31→27 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 34→32.8 复测非裕度达标(47/3.2) → 回退 ✔
- iter12(降耗): NaOH 27→23 ✔ 带裕度复测达标,保留
- outcome: writes=15 DO=3.50 compliant=true cost 181.5→179.1(省 2.4) attained=true
- **成本曲线**:首个达标运行成本 ≈181.5 → 终态 ≈179.1(降 2.4,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=42.22 · 出水氨氮=2.63 · 出水总磷=0.42 · 出水pH=6.38 · 出水浊度=0.66 · DO=3.50

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.52 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.46 HV | — | ✘ |
| trim1 | margin | zone2-sp | 710 → 722 | 97.88 HV | yes | keep ✔ |
| 6 | throughput | line-speed-sp | 140 → 152 | 99.24 HV | yes | keep ✔ |
| 7 | throughput | line-speed-sp | 152 → 164 | 99.84 HV | yes | keep ✔ |

- baseline 硬度=134.5HV 抗拉=311MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- trim1: zone2-sp 710→722 硬度→97.9HV(修剪线 ≤98)
- iter6(产能): 线速 140→152 ✔ 硬度 99.2HV 留裕度窗内
- iter7(产能): 线速 152→164 ✔ 硬度 99.8HV 留裕度窗内
- iter8(产能): 线速 164→176 硬度 101.3HV 出窗/无裕度 → 回退 ✔
- 产能推进: 线速 140→164(+17.14%),pushed=2
- outcome: writes=5 final=100.1HV attained=true(窗内+产能≥5%)
- **产能曲线**:线速 140 → 164 m/min(+17.1%,质量窗触边自动回退)
- 守卫终值:抗拉强度=296.78 · 表面缺陷率=0.16

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 28.10 μm | — |  |
| 1 | converge | cast-spd-sp | 32 → 33.8 | 26.50 μm | yes | keep ✔ |
| 2 | converge | fast-roll-sp | 118 → 120.3 | 26.00 μm | yes | keep ✔ |
| 3 | converge | rail-out-sp | 3000 → 3035 | 25.66 μm | yes | keep ✔ |

- 1. task board: channel=eec4065c-cec5-4699-aace-378553bcf01f parent=5daad33a-75ea-406f-a889-a666a16ed65b leadChild=c98cee1e-8010-4916-bf4f-d3ac73196d07
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.1,3.5,1.6]
- 3. initial thickness=28.10 μm(目标 25±0.7)
- iter1: cast-spd-sp 32→33.8 ✔ record=opt-cbdee8… · thickness→26.50μm · judge=keep✔
-         meltTemp=291.4℃(安全窗 268~300)
- iter2: fast-roll-sp 118→120.3 ✔ record=opt-9a0567… · thickness→26.00μm · judge=keep✔
-         meltTemp=291.4℃(安全窗 268~300)
- iter3: rail-out-sp 3000→3035 ✔ record=opt-3197b2… · thickness→25.66μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(1 条,含参数/判定/窗口):
- opt-cbdee859 [judged-keep] 铸片辊速度SP·ip16flb0: 32 → 33.8,设定 03:02:01,判定 keep(agent:biax mission ite
- 5. outcome: writes=3 distinctKnobs=3 final=25.66μm attained=true
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


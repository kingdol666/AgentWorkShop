# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:PASS** · run `20260921151620-ykk` · 2026-09-21T15:51:27.255Z · wall 151.44s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=77d571c3f882a79d

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 3 | 4 | 38.02 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 14 | 12 | 148.43 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✔ | 3 | 4 | 49.85 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✔ | 3 | 3 | — |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:新建产线 `注塑成型质量窗口寻优 injection-undefined` line=ln-29a4e0b1 recipe=rc-ca872469 DCW=11 DAQ=14
- 驱动实测:inj-machine-mbtcp/机筒温度区1SP ✔ · inj-mold-rtu/模具温度SP ✔ · inj-inject-opcua/InjectSpeedSP ✔ · inj-cool-mqtt/WaterTempPV ✔ · inj-inspect-http/PartWeight ✔
- Channel:channel=11ae3a25-8047-4e06-b486-ee7a829201df toolAgent=b8ae0446-b983-47e1-9b3f-2f77340aafe1 task=06f1d54b-63b0-4e7f-885d-db4084ca8ee6 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `A2O 污水生化处理达标降耗 wwtp-undefined` line=ln-e8d027b1 recipe=rc-b40e0b47 DCW=7 DAQ=13
- 驱动实测:wwtp-blower-mbtcp/风机频率SP ✔ · wwtp-dosing-opcua/NaohDoseSP ✔ · wwtp-return-rtu/内回流比SP ✔ · wwtp-influent-mqtt/CodIn ✔ · wwtp-effluent-http/CodOut ✔
- Channel:channel=d46235cd-684c-4a5a-96fc-2e0756833681 toolAgent=837d6d1b-caf1-4a80-a546-f452bc263eae task=c7a4a7fd-fb8c-47a9-ad9c-d16aa3986ea0 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `连续退火质量窗内产能最大化 anneal-undefined` line=ln-aa33aa64 recipe=rc-06c6d5de DCW=7 DAQ=12
- 驱动实测:anneal-heating-mbtcp/均热区1炉温SP ✔ · anneal-line-opcua/LineSpeedSP ✔ · anneal-cool-rtu/过时效温度SP ✔ · anneal-gas-mqtt/DewPoint ✔ · anneal-inspect-http/Hardness ✔
- Channel:channel=807f3003-fce9-4032-949e-c13d5e6bdb23 toolAgent=bcfa72db-00a7-418e-9c69-aab6fb43e2b0 task=65aea51e-d89c-43dc-b734-366dd655822b 终态=COMPLETED

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
| 0 | baseline | — | — | 31.28 g | — |  |
| 1 | converge | hold-pressure-sp | 45 → 57.92 | 31.92 g | yes | keep ✔ |
| 2 | converge | hold-time-sp | 6 → 10.61 | 32.15 g | yes | keep ✔ |
| 3 | converge | hold-pressure-sp | 57.9 → 61.64 | 32.33 g | yes | keep ✔ |

- baseline 克重=31.28g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→57.92 ✔ record=yes · 克重→31.92g
- iter2: hold-time-sp 6→10.61 ✔ record=yes · 克重→32.15g
- iter3: hold-pressure-sp 57.9→61.64 ✔ record=yes · 克重→32.33g
- outcome: writes=3 final=32.33g attained=true guards={"飞边率":0.0158,"缩痕指数":0.8889999999999999}
- 守卫终值:飞边率=0.02 · 缩痕指数=0.89

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.23 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30.04 | 2.07 mg/L | yes | keep ✔ |
| 2 | blower | blower-hz-sp | 30 → 31.65 | 2.79 mg/L | yes | keep ✔ |
| 3 | blower | blower-hz-sp | 31.600000381469727 → 32.4 | 2.96 mg/L | yes | keep ✔ |
| 4 | blower | blower-hz-sp | 32.400001525878906 → 33.2 | 3.28 mg/L | yes | keep ✔ |
| 5 | ph | naoh-dose-sp | 12 → 29.76 | 6.66 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.51 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.47 mg/L | yes | keep ✔ |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.41 mg/L | yes | keep ✔ |

- baseline DO=0.23 COD=360 NH3=34.5 TP=0.66 pH=6.58 → 不达标
- iter1(曝气): 风机 26→30.04 ✔
- iter2(曝气): 风机 30→31.65 ✔
- iter3(曝气): 风机 31.600000381469727→32.4 ✔
- iter4(曝气): 风机 32.400001525878906→33.2 ✔
- iter5(中和): NaOH 12→29.76 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标确认 ✔ 首个达标运行成本 ≈172.9(风机 33.20000076293945/NaOH 30/PAC 75)
- iter11(降耗): 风机 33.20000076293945→32 复测非裕度达标(50/3.5) → 回退 ✔
- iter11(降耗): NaOH 30→26 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 33.20000076293945→32 复测非裕度达标(55/4.2) → 回退 ✔
- iter12(降耗): NaOH 26→22 ✔ 带裕度复测达标,保留
- outcome: writes=14 DO=3.27 compliant=true cost 172.9→170.5(省 2.4) attained=true
- **成本曲线**:首个达标运行成本 ≈172.9 → 终态 ≈170.5(降 2.4,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=47.18 · 出水氨氮=3.17 · 出水总磷=0.42 · 出水pH=6.31 · 出水浊度=0.65 · DO=3.27

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.72 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.16 HV | yes | keep ✔ |
| 6 | throughput | line-speed-sp | 140 → 152 | 99.50 HV | yes | keep ✔ |

- baseline 硬度=134.7HV 抗拉=311MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- iter6(产能): 线速 140→152 ✔ 硬度 99.5HV 留裕度窗内
- iter7(产能): 线速 152→164 硬度 101.0HV 出窗/无裕度 → 回退 ✔
- 产能推进: 线速 140→152(+8.57%),pushed=1
- outcome: writes=3 final=100.0HV attained=true(窗内+产能≥5%)
- **产能曲线**:线速 140 → 152 m/min(+8.6%,质量窗触边自动回退)
- 守卫终值:抗拉强度=296.98 · 表面缺陷率=0.14

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 28.10 μm | — |  |
| 1 | converge | cast-spd-sp | 32 → 33.8 | 26.50 μm | yes | keep ✔ |
| 2 | converge | fast-roll-sp | 118 → 120.3 | 26.00 μm | yes | keep ✔ |
| 3 | converge | rail-out-sp | 3000 → 3035 | 25.68 μm | yes | keep ✔ |

- 1. task board: channel=93c5baa6-0204-4af5-9ff8-3401472c3d19 parent=fea1a92c-8b28-41fb-947f-112ae2d52b38 leadChild=fca3678e-59c6-4a49-a93b-a32d772ae435
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.1,3.5,1.6]
- 3. initial thickness=28.10 μm(目标 25±0.7)
- iter1: cast-spd-sp 32→33.8 ✔ record=opt-bc959a… · thickness→26.50μm · judge=keep✔
-         meltTemp=291.7℃(安全窗 268~300)
- iter2: fast-roll-sp 118→120.3 ✔ record=opt-9bee36… · thickness→26.00μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- iter3: rail-out-sp 3000→3035 ✔ record=opt-99e534… · thickness→25.68μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(1 条,含参数/判定/窗口):
- opt-bc959a42 [judged-keep] 铸片辊速度SP·ip163936: 32 → 33.8,设定 23:45:46,判定 keep(agent:biax mission ite
- 5. outcome: writes=3 distinctKnobs=3 final=25.68μm attained=true
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


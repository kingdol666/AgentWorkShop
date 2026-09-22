# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20260921171251-1bgw` · 2026-09-21T17:38:11.574Z · wall 204.54s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=096c5dbc769c3f8f

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 2 | 3 | 30.39 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 15 | 13 | 201.53 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✘ | 7 | 8 | 87.05 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✔ | 3 | 3 | — |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:复用既有产线 `注塑成型质量窗口寻优 injection-undefined` line=ln-cb7f8b82 recipe=rc-e77a8aeb DCW=11 DAQ=14
- 驱动实测:—
- Channel:channel=33dcc697-6c98-4817-8a79-43d783df8996 toolAgent=aaa0bb17-b390-4372-870e-28c5601d2ea1 task=a01c9158-6b1b-4681-abd8-ee929eb8567b 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `A2O 污水生化处理达标降耗 wwtp-undefined` line=ln-5a1e2cb4 recipe=rc-4805e56b DCW=7 DAQ=13
- 驱动实测:—
- Channel:channel=10116783-65ae-459f-8911-e8f3cc2ed6aa toolAgent=dbf53804-7656-453b-8d93-039867535f9c task=53991643-012c-444d-8c45-dabcd926be37 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `连续退火质量窗内产能最大化 anneal-undefined` line=ln-d1e032bc recipe=rc-86ba1688 DCW=7 DAQ=12
- 驱动实测:—
- Channel:channel=16e61f35-7239-4907-bed0-ec4ebd11f599 toolAgent=eca287a4-4f70-40db-9519-2a0513dcc826 task=451e3c5d-b43f-4ba2-af04-45e5e0ca08d2 终态=COMPLETED

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
| 2 | converge | hold-time-sp | 6 → 10.64 | 32.18 g | yes | keep ✔ |

- baseline 克重=31.25g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→58.2 ✔ record=yes · 克重→31.92g
- iter2: hold-time-sp 6→10.64 ✔ record=yes · 克重→32.18g
- outcome: writes=2 final=32.18g attained=true guards={"飞边率":0.0068000000000000005,"缩痕指数":1.0088000000000001}
- 守卫终值:飞边率=0.01 · 缩痕指数=1.01

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.26 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30 | 2.15 mg/L | yes | keep ✔ |
| 2 | blower | blower-hz-sp | 30 → 31.59 | 2.80 mg/L | yes | keep ✔ |
| 3 | blower | blower-hz-sp | 31.600000381469727 → 32.4 | 3.06 mg/L | yes | keep ✔ |
| 4 | blower | blower-hz-sp | 32.400001525878906 → 33.2 | 3.22 mg/L | yes | keep ✔ |
| 5 | blower | blower-hz-sp | 33.20000076293945 → 34 | 3.50 mg/L | yes | keep ✔ |
| 5 | ph | naoh-dose-sp | 12 → 30.34 | 6.64 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.53 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.46 mg/L | yes | keep ✔ |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.42 mg/L | yes | keep ✔ |

- baseline DO=0.26 COD=360 NH3=34.5 TP=0.66 pH=6.59 → 不达标
- iter1(曝气): 风机 26→30 ✔
- iter2(曝气): 风机 30→31.59 ✔
- iter3(曝气): 风机 31.600000381469727→32.4 ✔
- iter4(曝气): 风机 32.400001525878906→33.2 ✔
- iter5(曝气): 风机 33.20000076293945→34 ✔
- iter5(中和): NaOH 12→30.34 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标确认 ✔ 首个达标运行成本 ≈181.2(风机 34/NaOH 30/PAC 75)
- iter11(降耗): 风机 34→32.8 复测非裕度达标(49/3.4) → 回退 ✔
- iter11(降耗): NaOH 30→26 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 34→32.8 复测非裕度达标(50/3.5) → 回退 ✔
- iter12(降耗): NaOH 26→22 ✔ 带裕度复测达标,保留
- outcome: writes=15 DO=3.57 compliant=true cost 181.2→178.8(省 2.4) attained=true
- **成本曲线**:首个达标运行成本 ≈181.2 → 终态 ≈178.8(降 2.4,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=41.70 · 出水氨氮=2.58 · 出水总磷=0.43 · 出水pH=6.32 · 出水浊度=0.57 · DO=3.57

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.48 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.50 HV | — | ✘ |
| trim1 | margin | zone2-sp | 710 → 722 | 98.24 HV | yes | keep ✔ |
| trim2 | margin | zone2-sp | 722 → 734 | 98.50 HV | yes | keep ✔ |
| 6 | throughput | line-speed-sp | 140 → 152 | 99.30 HV | yes | keep ✔ |
| 7 | throughput | line-speed-sp | 152 → 164 | 99.06 HV | yes | keep ✔ |
| 8 | throughput | line-speed-sp | 164 → 176 | 99.38 HV | yes | keep ✔ |

- baseline 硬度=134.5HV 抗拉=311MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- trim1: zone2-sp 710→722 硬度→98.2HV(修剪线 ≤98)
- trim2: zone2-sp 722→734 硬度→98.5HV(修剪线 ≤98)
- iter6(产能): 线速 140→152 ✔ 硬度 99.3HV 留裕度窗内
- iter7(产能): 线速 152→164 ✔ 硬度 99.1HV 留裕度窗内
- iter8(产能): 线速 164→176 ✔ 硬度 99.4HV 留裕度窗内
- iter9(产能): 线速 176→188 硬度 101.2HV 出窗/无裕度 → 回退 ✔
- 产能推进: 线速 140→176(+25.71%),pushed=3
- outcome: writes=7 final=101.4HV attained=false(窗内+产能≥5%)
- **产能曲线**:线速 140 → 176 m/min(+25.7%,质量窗触边自动回退)
- 守卫终值:抗拉强度=297.28 · 表面缺陷率=0.16

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 28.10 μm | — |  |
| 1 | converge | cast-spd-sp | 32 → 33.8 | 26.42 μm | yes | keep ✔ |
| 2 | converge | fast-roll-sp | 118 → 120.2 | 26.00 μm | yes | keep ✔ |
| 3 | converge | rail-out-sp | 3000 → 3035 | 25.70 μm | yes | keep ✔ |

- 1. task board: channel=5785d3f8-c9dc-4dd3-a6bd-32646c041ec9 parent=d5730000-e7d3-4988-9fa4-1b913b7c2ce7 leadChild=1f908bc9-2c88-41d4-9fec-1cd0a21054ef
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.1,3.5,1.6]
- 3. initial thickness=28.10 μm(目标 25±0.7)
- iter1: cast-spd-sp 32→33.8 ✔ record=opt-54c146… · thickness→26.42μm · judge=keep✔
-         meltTemp=291.8℃(安全窗 268~300)
- iter2: fast-roll-sp 118→120.2 ✔ record=opt-652668… · thickness→26.00μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- iter3: rail-out-sp 3000→3035 ✔ record=opt-ed0b1b… · thickness→25.70μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(1 条,含参数/判定/窗口):
- opt-54c1465c [judged-keep] 铸片辊速度SP·ip1674q1: 32 → 33.8,设定 01:31:40,判定 keep(agent:biax mission ite
- 5. outcome: writes=3 distinctKnobs=3 final=25.70μm attained=true
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


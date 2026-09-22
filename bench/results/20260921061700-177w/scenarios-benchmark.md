# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20260921061700-177w` · 2026-09-21T06:32:07.652Z · wall 179.18s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3009 · simulator=http://127.0.0.1:4015 · toolHarness=opencode · git=e692df1 · harness=bd08743fd73302e2

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 3 | 4 | 32.29 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 15 | 13 | 176.18 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✘ | 5 | 6 | 65.79 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✘ | 6 | 6 | — |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:新建产线 `注塑成型质量窗口寻优 injection-undefined` line=ln-5a607b0e recipe=rc-b6776dfb DCW=11 DAQ=14
- 驱动实测:inj-machine-mbtcp/机筒温度区1SP ✔ · inj-mold-rtu/模具温度SP ✔ · inj-inject-opcua/InjectSpeedSP ✔ · inj-cool-mqtt/WaterTempPV ✔ · inj-inspect-http/PartWeight ✔
- Channel:channel=c65a2fa8-01f0-4a6b-b911-74519b5cfec8 toolAgent=3c8d96df-4606-4b2e-b88a-2cf1bf88087f task=62f25d69-561f-4ddf-a5e7-3634467fea28 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `A2O 污水生化处理达标降耗 wwtp-undefined` line=ln-1e761909 recipe=rc-a5f5286b DCW=7 DAQ=13
- 驱动实测:wwtp-blower-mbtcp/风机频率SP ✔ · wwtp-dosing-opcua/NaohDoseSP ✔ · wwtp-return-rtu/内回流比SP ✔ · wwtp-influent-mqtt/CodIn ✔ · wwtp-effluent-http/CodOut ✔
- Channel:channel=536e42de-447a-4945-99da-e55553bf1800 toolAgent=10402481-4c74-45f1-9553-e60db387fd6b task=2bf335a2-73bd-4a61-8fcb-9bfd2bfaf80b 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `连续退火质量窗内产能最大化 anneal-undefined` line=ln-0d234bd7 recipe=rc-26912407 DCW=7 DAQ=12
- 驱动实测:anneal-heating-mbtcp/均热区1炉温SP ✔ · anneal-line-opcua/LineSpeedSP ✔ · anneal-cool-rtu/过时效温度SP ✔ · anneal-gas-mqtt/DewPoint ✔ · anneal-inspect-http/Hardness ✔
- Channel:channel=c468d33b-f8ab-4d68-b018-269fc5ab0a1c toolAgent=46cc0b37-a6ec-4b47-b709-4641cc556c74 task=766a37ab-512c-45e5-ad13-907369db736b 终态=COMPLETED

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
| 1 | converge | hold-pressure-sp | 45 → 58.24 | 31.96 g | yes | keep ✔ |
| 2 | converge | hold-time-sp | 6 → 10.35 | 32.14 g | yes | keep ✔ |
| 3 | converge | hold-pressure-sp | 58.2 → 61.97 | 32.36 g | yes | keep ✔ |

- baseline 克重=31.25g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→58.24 ✔ record=yes · 克重→31.96g
- iter2: hold-time-sp 6→10.35 ✔ record=yes · 克重→32.14g
- iter3: hold-pressure-sp 58.2→61.97 ✔ record=yes · 克重→32.36g
- outcome: writes=3 final=32.36g attained=true guards={"飞边率":0.0052,"缩痕指数":0.8752000000000001}
- 守卫终值:飞边率=0.01 · 缩痕指数=0.88

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.21 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30.06 | 2.22 mg/L | yes | keep ✔ |
| 2 | blower | blower-hz-sp | 30.100000381469727 → 31.61 | 2.76 mg/L | yes | keep ✔ |
| 3 | blower | blower-hz-sp | 31.600000381469727 → 32.44 | 2.96 mg/L | yes | keep ✔ |
| 4 | blower | blower-hz-sp | 32.400001525878906 → 33.2 | 3.24 mg/L | yes | keep ✔ |
| 5 | blower | blower-hz-sp | 33.20000076293945 → 34 | 3.43 mg/L | yes | keep ✔ |
| 5 | ph | naoh-dose-sp | 12 → 30.51 | 6.69 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.51 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.47 mg/L | yes | keep ✔ |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.41 mg/L | yes | keep ✔ |

- baseline DO=0.21 COD=360 NH3=34.5 TP=0.66 pH=6.58 → 不达标
- iter1(曝气): 风机 26→30.06 ✔
- iter2(曝气): 风机 30.100000381469727→31.61 ✔
- iter3(曝气): 风机 31.600000381469727→32.44 ✔
- iter4(曝气): 风机 32.400001525878906→33.2 ✔
- iter5(曝气): 风机 33.20000076293945→34 ✔
- iter5(中和): NaOH 12→30.51 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标确认 ✔ 首个达标运行成本 ≈181.5(风机 34/NaOH 31/PAC 75)
- iter11(降耗): 风机 34→32.8 复测非裕度达标(50/3.6) → 回退 ✔
- iter11(降耗): NaOH 31→27 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 34→32.8 复测非裕度达标(50/3.6) → 回退 ✔
- iter12(降耗): NaOH 27→23 ✔ 带裕度复测达标,保留
- outcome: writes=15 DO=3.59 compliant=true cost 181.5→179.1(省 2.4) attained=true
- **成本曲线**:首个达标运行成本 ≈181.5 → 终态 ≈179.1(降 2.4,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=41.74 · 出水氨氮=2.51 · 出水总磷=0.42 · 出水pH=6.32 · 出水浊度=0.66 · DO=3.59

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.72 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.44 HV | yes | keep ✔ |
| 6 | throughput | line-speed-sp | 140 → 152 | 99.50 HV | yes | keep ✔ |
| 7 | throughput | line-speed-sp | 152 → 164 | 100.96 HV | yes | keep ✔ |
| 8 | throughput | line-speed-sp | 164 → 176 | 100.84 HV | yes | keep ✔ |

- baseline 硬度=134.7HV 抗拉=311MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- iter6(产能): 线速 140→152 ✔ 硬度 99.5HV 仍在窗内
- iter7(产能): 线速 152→164 ✔ 硬度 101.0HV 仍在窗内
- iter8(产能): 线速 164→176 ✔ 硬度 100.8HV 仍在窗内
- iter9(产能): 线速 176→188 硬度 103.4HV 出窗 → 回退 ✔
- 产能推进: 线速 140→176(+25.71%),pushed=3
- outcome: writes=5 final=102.5HV attained=false(窗内+产能≥5%)
- **产能曲线**:线速 140 → 176 m/min(+25.7%,质量窗触边自动回退)
- 守卫终值:抗拉强度=298.76 · 表面缺陷率=0.13

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 46.50 μm | — |  |
| 1 | converge | cast-spd-sp | 32 → 39.4 | 39.14 μm | yes | keep ✔ |
| 2 | converge | fast-roll-sp | 118 → 132.9 | 28.00 μm | yes | keep ✔ |
| 3 | converge | rail-out-sp | 3000 → 3096 | 27.94 μm | yes | keep ✔ |
| 4 | converge | cast-spd-sp | 39.400001525878906 → 41.5 | 27.94 μm | yes | keep ✔ |
| 5 | converge | fast-roll-sp | 132.89999389648438 → 137.8 | 27.94 μm | yes | keep ✔ |
| 6 | converge | rail-out-sp | 3096 → 3194 | 28.00 μm | yes | keep ✔ |

- 1. task board: channel=d79e603f-a577-4ecf-9a01-699569f43fdf parent=3fc1280e-ca2c-48f3-a8e3-9da3d8fa4181 leadChild=e54a626c-2c5e-4250-94c8-e7a9ca5e67d2
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[46.5,3.5,1.6]
- 3. initial thickness=46.50 μm(目标 25±0.7)
- iter1: cast-spd-sp 32→39.4 ✔ record=opt-85cb0c… · thickness→39.14μm · judge=keep✔
-         meltTemp=291.4℃(安全窗 268~300)
- iter2: fast-roll-sp 118→132.9 ✔ record=opt-4edb99… · thickness→28.00μm · judge=keep✔
-         meltTemp=291.8℃(安全窗 268~300)
- iter3: rail-out-sp 3000→3096 ✔ record=opt-4685a0… · thickness→27.94μm · judge=keep✔
-         meltTemp=291.4℃(安全窗 268~300)
- iter4: cast-spd-sp 39.400001525878906→41.5 ✔ record=opt-ac6861… · thickness→27.94μm · judge=keep✔
-         meltTemp=291.6℃(安全窗 268~300)
- iter5: fast-roll-sp 132.89999389648438→137.8 ✔ record=opt-e9bb36… · thickness→27.94μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- iter6: rail-out-sp 3096→3194 ✔ record=opt-77239e… · thickness→28.00μm · judge=keep✔
-         meltTemp=291.6℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(2 条,含参数/判定/窗口):
- opt-ac6861cf [judged-keep] 铸片辊速度SP·ip16tdvs: 39.4 → 41.5,设定 14:27:51,判定 keep(agent:biax mission i
- 5. outcome: writes=6 distinctKnobs=3 final=28.00μm attained=false
- 6. task terminal=COMPLETED

## 3. 诚实边界
- 全部写路径经平台治理(dcw_control 自动开优化记录 + dcw_judge 判定收口);策略为确定性脚本(不经 LLM),与真实 LLM 变体共用同一工具面与治理链路。
- 物理数据由模拟器多引擎(cast-film/biax/injection/wwtp/anneal)产出,同 seed 确定性;J/W* 与真实产线存在仿真层级边界。
- 平台侧产线为「复用优先」:本报告如显示 reused,说明前次接入仍在,本次零重复建线(设计语义)。

## 4. 复现

```bash
NO_PROXY=127.0.0.1,localhost \
AW_BASE=http://127.0.0.1:3009 SIM_BASE=http://127.0.0.1:4015 \
  node bench/scenarios.mjs --seed 42 --tool-harness opencode
```


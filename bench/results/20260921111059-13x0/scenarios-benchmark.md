# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20260921111059-13x0` · 2026-09-21T11:21:19.585Z · wall 168.24s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=bd08743fd73302e2

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 2 | 3 | 25.61 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 15 | 13 | 165.23 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✘ | 4 | 5 | 66.09 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✘ | 6 | 6 | — |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:新建产线 `注塑成型质量窗口寻优 injection-undefined` line=ln-77a505ad recipe=rc-f32e3b32 DCW=11 DAQ=14
- 驱动实测:inj-machine-mbtcp/机筒温度区1SP ✔ · inj-mold-rtu/模具温度SP ✔ · inj-inject-opcua/InjectSpeedSP ✔ · inj-cool-mqtt/WaterTempPV ✔ · inj-inspect-http/PartWeight ✔
- Channel:channel=60ed2b3a-3190-4f15-bf8b-d57d7dd8c146 toolAgent=62412369-e0fd-48f2-9abf-e493ab5511f9 task=687fbc5d-db70-45fd-9454-afdf31c7d353 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `A2O 污水生化处理达标降耗 wwtp-undefined` line=ln-51807391 recipe=rc-ddfc14f0 DCW=7 DAQ=13
- 驱动实测:wwtp-blower-mbtcp/风机频率SP ✔ · wwtp-dosing-opcua/NaohDoseSP ✔ · wwtp-return-rtu/内回流比SP ✔ · wwtp-influent-mqtt/CodIn ✔ · wwtp-effluent-http/CodOut ✔
- Channel:channel=aa094350-ab25-4448-8fc5-f076cd55a974 toolAgent=963a8131-4c36-42b2-813c-1b6fb5442207 task=a8c53ec7-54c0-4c6d-b8a3-76b46f7d8396 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `连续退火质量窗内产能最大化 anneal-undefined` line=ln-ded7c9d8 recipe=rc-137018bb DCW=7 DAQ=12
- 驱动实测:anneal-heating-mbtcp/均热区1炉温SP ✔ · anneal-line-opcua/LineSpeedSP ✔ · anneal-cool-rtu/过时效温度SP ✔ · anneal-gas-mqtt/DewPoint ✔ · anneal-inspect-http/Hardness ✔
- Channel:channel=727b125d-70da-4cdc-9530-d073886a95e3 toolAgent=fa05f67b-497c-49bc-85f1-3de61107cb4f task=de0a9d24-6884-4313-9ac1-87430ba6fa0e 终态=COMPLETED

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
| 1 | converge | hold-pressure-sp | 45 → 58.26 | 31.95 g | yes | keep ✔ |
| 2 | converge | hold-time-sp | 6 → 10.4 | 32.16 g | yes | keep ✔ |

- baseline 克重=31.25g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→58.26 ✔ record=yes · 克重→31.95g
- iter2: hold-time-sp 6→10.4 ✔ record=yes · 克重→32.16g
- outcome: writes=2 final=32.16g attained=true guards={"飞边率":0.0092,"缩痕指数":1.0392000000000001}
- 守卫终值:飞边率=0.01 · 缩痕指数=1.04

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.21 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30.06 | 2.18 mg/L | yes | keep ✔ |
| 2 | blower | blower-hz-sp | 30.100000381469727 → 31.61 | 2.76 mg/L | yes | keep ✔ |
| 3 | blower | blower-hz-sp | 31.600000381469727 → 32.44 | 3.00 mg/L | yes | keep ✔ |
| 4 | blower | blower-hz-sp | 32.400001525878906 → 33.2 | 3.24 mg/L | yes | keep ✔ |
| 5 | blower | blower-hz-sp | 33.20000076293945 → 34 | 3.33 mg/L | yes | keep ✔ |
| 5 | ph | naoh-dose-sp | 12 → 31.02 | 6.67 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.54 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.48 mg/L | yes | keep ✔ |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.41 mg/L | yes | keep ✔ |

- baseline DO=0.21 COD=360 NH3=34.5 TP=0.66 pH=6.60 → 不达标
- iter1(曝气): 风机 26→30.06 ✔
- iter2(曝气): 风机 30.100000381469727→31.61 ✔
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
- iter12(降耗): 风机 34→32.8 复测非裕度达标(47/3.2) → 回退 ✔
- iter12(降耗): NaOH 27→23 ✔ 带裕度复测达标,保留
- outcome: writes=15 DO=3.54 compliant=true cost 181.5→179.1(省 2.4) attained=true
- **成本曲线**:首个达标运行成本 ≈181.5 → 终态 ≈179.1(降 2.4,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=41.72 · 出水氨氮=2.54 · 出水总磷=0.42 · 出水pH=6.35 · 出水浊度=0.63 · DO=3.54

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.72 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.16 HV | yes | keep ✔ |
| 6 | throughput | line-speed-sp | 140 → 152 | 100.44 HV | yes | keep ✔ |
| 7 | throughput | line-speed-sp | 152 → 164 | 100.92 HV | yes | keep ✔ |

- baseline 硬度=134.7HV 抗拉=311MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- iter6(产能): 线速 140→152 ✔ 硬度 100.4HV 仍在窗内
- iter7(产能): 线速 152→164 ✔ 硬度 100.9HV 仍在窗内
- iter8(产能): 线速 164→176 硬度 102.1HV 出窗 → 回退 ✔
- 产能推进: 线速 140→164(+17.14%),pushed=2
- outcome: writes=4 final=101.4HV attained=false(窗内+产能≥5%)
- **产能曲线**:线速 140 → 164 m/min(+17.1%,质量窗触边自动回退)
- 守卫终值:抗拉强度=297.56 · 表面缺陷率=0.15

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 28.05 μm | — |  |
| 1 | converge | cast-spd-sp | 32 → 33.7 | 27.98 μm | yes | keep ✔ |
| 2 | converge | fast-roll-sp | 118 → 122.4 | 27.96 μm | yes | keep ✔ |
| 3 | converge | rail-out-sp | 3000 → 3095 | 28.02 μm | yes | keep ✔ |
| 4 | converge | cast-spd-sp | 33.70000076293945 → 35.5 | 27.98 μm | yes | keep ✔ |
| 5 | converge | fast-roll-sp | 122.4000015258789 → 127 | 28.00 μm | yes | keep ✔ |
| 6 | converge | rail-out-sp | 3095 → 3194 | 28.02 μm | yes | keep ✔ |

- 1. task board: channel=9416551d-1014-47e1-a880-25a62946642c parent=8315a176-6877-45c9-9b97-b8e0310e0599 leadChild=9ca7f283-a021-483b-9729-caa8f35bd72d
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.1,3.5,1.6]
- 3. initial thickness=28.05 μm(目标 25±0.7)
- iter1: cast-spd-sp 32→33.7 ✔ record=opt-9f7b62… · thickness→27.98μm · judge=keep✔
-         meltTemp=291.3℃(安全窗 268~300)
- iter2: fast-roll-sp 118→122.4 ✔ record=opt-77fc5e… · thickness→27.96μm · judge=keep✔
-         meltTemp=291.6℃(安全窗 268~300)
- iter3: rail-out-sp 3000→3095 ✔ record=opt-fc811b… · thickness→28.02μm · judge=keep✔
-         meltTemp=291.8℃(安全窗 268~300)
- iter4: cast-spd-sp 33.70000076293945→35.5 ✔ record=opt-c70e06… · thickness→27.98μm · judge=keep✔
-         meltTemp=291.3℃(安全窗 268~300)
- iter5: fast-roll-sp 122.4000015258789→127 ✔ record=opt-2fcda8… · thickness→28.00μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- iter6: rail-out-sp 3095→3194 ✔ record=opt-0c4f21… · thickness→28.02μm · judge=keep✔
-         meltTemp=291.8℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(2 条,含参数/判定/窗口):
- opt-c70e06c3 [judged-keep] 铸片辊速度SP·ip16bgvy: 33.7 → 35.5,设定 19:17:28,判定 keep(agent:biax mission i
- 5. outcome: writes=6 distinctKnobs=3 final=28.02μm attained=false
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


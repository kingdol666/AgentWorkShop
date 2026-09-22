# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:PASS** · run `20260921174255-11sw` · 2026-09-21T18:11:19.674Z · wall 191.63s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=9f2756dce4a4cbb3

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 2 | 3 | 25.91 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 14 | 12 | 188.63 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✔ | 5 | 6 | 86.21 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✔ | 3 | 3 | — |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:新建产线 `注塑成型质量窗口寻优 injection-undefined` line=ln-e8350d53 recipe=rc-fb7b675b DCW=11 DAQ=14
- 驱动实测:inj-machine-mbtcp/机筒温度区1SP ✔ · inj-mold-rtu/模具温度SP ✔ · inj-inject-opcua/InjectSpeedSP ✔ · inj-cool-mqtt/WaterTempPV ✔ · inj-inspect-http/PartWeight ✔
- Channel:channel=e8cfa1d3-d98c-4a45-b71b-c54ab6545c53 toolAgent=65c47f96-6e79-454d-87f7-e1dba362aa20 task=f3b11462-8761-41f4-894d-b08b0b1c0533 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `A2O 污水生化处理达标降耗 wwtp-undefined` line=ln-00f606d3 recipe=rc-ca808507 DCW=7 DAQ=13
- 驱动实测:wwtp-blower-mbtcp/风机频率SP ✔ · wwtp-dosing-opcua/NaohDoseSP ✔ · wwtp-return-rtu/内回流比SP ✔ · wwtp-influent-mqtt/CodIn ✔ · wwtp-effluent-http/CodOut ✔
- Channel:channel=8fa746e4-82e9-407e-a140-ebd30979779e toolAgent=d86f7dfa-35c0-455d-a0d2-28917b1f84a6 task=20680d6d-08e0-4d9e-bc5e-deb077aab8d2 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `连续退火质量窗内产能最大化 anneal-undefined` line=ln-2757f3f4 recipe=rc-3c91c7af DCW=7 DAQ=12
- 驱动实测:anneal-heating-mbtcp/均热区1炉温SP ✔ · anneal-line-opcua/LineSpeedSP ✔ · anneal-cool-rtu/过时效温度SP ✔ · anneal-gas-mqtt/DewPoint ✔ · anneal-inspect-http/Hardness ✔
- Channel:channel=8d38def7-cdf6-4220-a5ba-3e2b1c67c66d toolAgent=1dca465a-9967-4ee7-90e3-b2d3e3816575 task=39f54f4e-3c0b-4e2a-9973-3ebbc6d17789 终态=COMPLETED

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
| 2 | converge | hold-time-sp | 6 → 10.43 | 32.16 g | yes | keep ✔ |

- baseline 克重=31.25g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→58.26 ✔ record=yes · 克重→31.95g
- iter2: hold-time-sp 6→10.43 ✔ record=yes · 克重→32.16g
- outcome: writes=2 final=32.16g attained=true guards={"飞边率":0.0092,"缩痕指数":1.0392000000000001}
- 守卫终值:飞边率=0.01 · 缩痕指数=1.04

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.22 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30.04 | 2.07 mg/L | yes | keep ✔ |
| 2 | blower | blower-hz-sp | 30 → 31.7 | 2.82 mg/L | yes | keep ✔ |
| 3 | blower | blower-hz-sp | 31.700000762939453 → 32.5 | 2.89 mg/L | yes | keep ✔ |
| 4 | blower | blower-hz-sp | 32.5 → 33.3 | 3.30 mg/L | yes | keep ✔ |
| 5 | ph | naoh-dose-sp | 12 → 30.03 | 6.65 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.51 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.47 mg/L | yes | keep ✔ |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.41 mg/L | yes | keep ✔ |

- baseline DO=0.22 COD=360 NH3=34.5 TP=0.66 pH=6.59 → 不达标
- iter1(曝气): 风机 26→30.04 ✔
- iter2(曝气): 风机 30→31.7 ✔
- iter3(曝气): 风机 31.700000762939453→32.5 ✔
- iter4(曝气): 风机 32.5→33.3 ✔
- iter5(中和): NaOH 12→30.03 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标确认 ✔ 首个达标运行成本 ≈173.9(风机 33.29999923706055/NaOH 30/PAC 75)
- iter11(降耗): 风机 33.29999923706055→32.1 复测非裕度达标(56/4.3) → 回退 ✔
- iter11(降耗): NaOH 30→26 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 33.29999923706055→32.1 复测非裕度达标(57/4.3) → 回退 ✔
- iter12(降耗): NaOH 26→22 ✔ 带裕度复测达标,保留
- outcome: writes=14 DO=3.35 compliant=true cost 173.9→171.5(省 2.4) attained=true
- **成本曲线**:首个达标运行成本 ≈173.9 → 终态 ≈171.5(降 2.4,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=46.28 · 出水氨氮=3.10 · 出水总磷=0.42 · 出水pH=6.34 · 出水浊度=0.61 · DO=3.35

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.36 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.44 HV | yes | keep ✔ |
| trim1 | margin | zone2-sp | 710 → 722 | 98.46 HV | yes | keep ✔ |
| trim2 | margin | zone2-sp | 722 → 734 | 98.50 HV | yes | keep ✔ |
| 6 | throughput | line-speed-sp | 140 → 152 | 97.82 HV | yes | keep ✔ |

- baseline 硬度=134.4HV 抗拉=311MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- trim1: zone2-sp 710→722 硬度→98.5HV(修剪线 ≤98)
- trim2: zone2-sp 722→734 硬度→98.5HV(修剪线 ≤98)
- iter6(产能): 线速 140→152 ✔ 硬度 97.8HV 留裕度窗内
- iter7(产能): 线速 152→164 硬度 100.0HV 出窗/无裕度 → 回退 ✔
- 产能推进: 线速 140→152(+8.57%),pushed=1
- outcome: writes=5 final=99.2HV attained=true(窗内+产能≥5%)
- **产能曲线**:线速 140 → 152 m/min(+8.6%,质量窗触边自动回退)
- 守卫终值:抗拉强度=296.34 · 表面缺陷率=0.16

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 28.10 μm | — |  |
| 1 | converge | cast-spd-sp | 32 → 33.8 | 26.42 μm | yes | keep ✔ |
| 2 | converge | fast-roll-sp | 118 → 120.2 | 26.06 μm | yes | keep ✔ |
| 3 | converge | rail-out-sp | 3000 → 3037 | 25.68 μm | yes | keep ✔ |

- 1. task board: channel=a797bf30-d8ca-4eb6-b9e5-8f2d63aa76cb parent=111412b1-83bb-44b3-9d21-0f0dd0afef61 leadChild=00922b3d-deb4-4c15-8c55-8a05c275b6ff
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.1,3.5,1.6]
- 3. initial thickness=28.10 μm(目标 25±0.7)
- iter1: cast-spd-sp 32→33.8 ✔ record=opt-ad14be… · thickness→26.42μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- iter2: fast-roll-sp 118→120.2 ✔ record=opt-2ad2ea… · thickness→26.06μm · judge=keep✔
-         meltTemp=291.3℃(安全窗 268~300)
- iter3: rail-out-sp 3000→3037 ✔ record=opt-3219ac… · thickness→25.68μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(1 条,含参数/判定/窗口):
- opt-ad14be26 [judged-keep] 铸片辊速度SP·ip16bhmf: 32 → 33.8,设定 02:04:58,判定 keep(agent:biax mission ite
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


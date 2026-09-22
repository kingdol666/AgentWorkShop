# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20260921123342-16mc` · 2026-09-21T12:48:00.325Z · wall 159.89s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=0c8f9705e2e8502f

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 3 | 4 | 34.16 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 15 | 13 | 156.88 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✘ | 3 | 4 | 58.11 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✘ | 6 | 6 | — |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:新建产线 `注塑成型质量窗口寻优 injection-undefined` line=ln-ec526b67 recipe=rc-52efe285 DCW=11 DAQ=14
- 驱动实测:inj-machine-mbtcp/机筒温度区1SP ✔ · inj-mold-rtu/模具温度SP ✔ · inj-inject-opcua/InjectSpeedSP ✔ · inj-cool-mqtt/WaterTempPV ✔ · inj-inspect-http/PartWeight ✔
- Channel:channel=4ae51706-8f87-41c4-9e2a-f4cd0f482b4d toolAgent=fd1d4585-9fd9-4432-a81f-94f934063de9 task=c4b187f4-e016-4caf-b860-443718437b23 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `A2O 污水生化处理达标降耗 wwtp-undefined` line=ln-df1f24df recipe=rc-bfe67a0d DCW=7 DAQ=13
- 驱动实测:wwtp-blower-mbtcp/风机频率SP ✔ · wwtp-dosing-opcua/NaohDoseSP ✔ · wwtp-return-rtu/内回流比SP ✔ · wwtp-influent-mqtt/CodIn ✔ · wwtp-effluent-http/CodOut ✔
- Channel:channel=057ba83a-330d-45ff-a224-47a3c7d431d8 toolAgent=897bdfd6-2a5b-4ac4-be99-8b13ee8baea0 task=5b467152-dd1e-4dad-b944-d63dcb530d52 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `连续退火质量窗内产能最大化 anneal-undefined` line=ln-2286e261 recipe=rc-53808ef0 DCW=7 DAQ=12
- 驱动实测:anneal-heating-mbtcp/均热区1炉温SP ✔ · anneal-line-opcua/LineSpeedSP ✔ · anneal-cool-rtu/过时效温度SP ✔ · anneal-gas-mqtt/DewPoint ✔ · anneal-inspect-http/Hardness ✔
- Channel:channel=6bdf0564-0176-46a3-853d-39bb5ccfcd10 toolAgent=b110a3cd-efce-431a-a2d0-052ae798ce9f task=e74d4e22-990f-49dc-b31d-789ceea11301 终态=COMPLETED

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
| 3 | converge | hold-pressure-sp | 57.9 → 61.64 | 32.31 g | yes | keep ✔ |

- baseline 克重=31.28g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→57.92 ✔ record=yes · 克重→31.92g
- iter2: hold-time-sp 6→10.61 ✔ record=yes · 克重→32.15g
- iter3: hold-pressure-sp 57.9→61.64 ✔ record=yes · 克重→32.31g
- outcome: writes=3 final=32.31g attained=true guards={"飞边率":0.014600000000000002,"缩痕指数":0.9411999999999999}
- 守卫终值:飞边率=0.01 · 缩痕指数=0.94

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.23 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30.04 | 2.07 mg/L | yes | keep ✔ |
| 2 | blower | blower-hz-sp | 30 → 31.7 | 2.82 mg/L | yes | keep ✔ |
| 3 | blower | blower-hz-sp | 31.700000762939453 → 32.5 | 3.07 mg/L | yes | keep ✔ |
| 4 | blower | blower-hz-sp | 32.5 → 33.3 | 3.24 mg/L | yes | keep ✔ |
| 5 | blower | blower-hz-sp | 33.29999923706055 → 34.1 | 3.51 mg/L | yes | keep ✔ |
| 5 | ph | naoh-dose-sp | 12 → 31.33 | 6.68 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.56 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.46 mg/L | yes | keep ✔ |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.41 mg/L | yes | keep ✔ |

- baseline DO=0.23 COD=360 NH3=34.5 TP=0.66 pH=6.58 → 不达标
- iter1(曝气): 风机 26→30.04 ✔
- iter2(曝气): 风机 30→31.7 ✔
- iter3(曝气): 风机 31.700000762939453→32.5 ✔
- iter4(曝气): 风机 32.5→33.3 ✔
- iter5(曝气): 风机 33.29999923706055→34.1 ✔
- iter5(中和): NaOH 12→31.33 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标确认 ✔ 首个达标运行成本 ≈182.6(风机 34.099998474121094/NaOH 31/PAC 75)
- iter11(降耗): 风机 34.099998474121094→32.9 复测非裕度达标(48/3.3) → 回退 ✔
- iter11(降耗): NaOH 31→27 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 34.099998474121094→32.9 复测非裕度达标(47/3.2) → 回退 ✔
- iter12(降耗): NaOH 27→23 ✔ 带裕度复测达标,保留
- outcome: writes=15 DO=3.53 compliant=true cost 182.6→180.2(省 2.4) attained=true
- **成本曲线**:首个达标运行成本 ≈182.6 → 终态 ≈180.2(降 2.4,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=42.08 · 出水氨氮=2.59 · 出水总磷=0.41 · 出水pH=6.38 · 出水浊度=0.67 · DO=3.53

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.72 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.16 HV | yes | keep ✔ |
| 6 | throughput | line-speed-sp | 140 → 152 | 100.72 HV | yes | keep ✔ |

- baseline 硬度=134.7HV 抗拉=311MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- iter6(产能): 线速 140→152 ✔ 硬度 100.7HV 仍在窗内
- iter7(产能): 线速 152→164 硬度 101.5HV 出窗 → 回退 ✔
- 产能推进: 线速 140→152(+8.57%),pushed=1
- outcome: writes=3 final=101.5HV attained=false(窗内+产能≥5%)
- **产能曲线**:线速 140 → 152 m/min(+8.6%,质量窗触边自动回退)
- 守卫终值:抗拉强度=296.90 · 表面缺陷率=0.14

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 9.37 μm | — |  |
| 0 | rebase | — | — | 27.90 μm | — |  |
| 1 | converge | cast-spd-sp | 32 → 33.7 | 21.30 μm | yes | keep ✔ |
| 2 | converge | fast-roll-sp | 118 → 110.8 | 28.38 μm | yes | keep ✔ |
| 3 | converge | rail-out-sp | 3000 → 3107 | 21.84 μm | yes | keep ✔ |
| 4 | converge | cast-spd-sp | 33.70000076293945 → 31.3 | 23.56 μm | yes | keep ✔ |
| 5 | converge | fast-roll-sp | 110.80000305175781 → 108.4 | 24.04 μm | yes | keep ✔ |
| 6 | converge | rail-out-sp | 3107 → 3070 | 12.22 μm | yes | keep ✔ |

- 1. task board: channel=900f61ac-155c-4af6-a124-a0e81bfe81d4 parent=b9428e85-5a5f-40b9-ba32-c8084fcb83e8 leadChild=6c95e93e-2747-4e9f-ba6d-262d4f9f7cdf
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.1,3.5,1.6]
- 3. initial thickness=9.37 μm(目标 25±0.7)
- 2.5 断膜恢复#1: warm 复位(✘ ) + 配方基线重下(✔)
- 2.5 断膜恢复#1: 基线回至 27.90μm(5s)
- 2.5 恢复后基线: 27.90 μm
- iter1: cast-spd-sp 32→33.7 ✔ record=opt-e78b50… · thickness→21.30μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- iter2: fast-roll-sp 118→110.8 ✔ record=opt-42f951… · thickness→28.38μm · judge=keep✔
-         meltTemp=291.3℃(安全窗 268~300)
- iter3: rail-out-sp 3000→3107 ✔ record=opt-3e777a… · thickness→21.84μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- iter4: cast-spd-sp 33.70000076293945→31.3 ✔ record=opt-d13cc9… · thickness→23.56μm · judge=keep✔
-         meltTemp=291.2℃(安全窗 268~300)
- iter5: fast-roll-sp 110.80000305175781→108.4 ✔ record=opt-565849… · thickness→24.04μm · judge=keep✔
-         meltTemp=291.7℃(安全窗 268~300)
- iter6: rail-out-sp 3107→3070 ✔ record=opt-3aca76… · thickness→12.22μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(2 条,含参数/判定/窗口):
- opt-d13cc950 [judged-keep] 铸片辊速度SP·ip16879b: 33.7 → 31.3,设定 20:42:13,判定 keep(agent:biax mission i
- 5. outcome: writes=6 distinctKnobs=3 final=12.22μm attained=false
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


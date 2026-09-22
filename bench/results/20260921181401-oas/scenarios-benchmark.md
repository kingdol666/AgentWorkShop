# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:PASS** · run `20260921181401-oas` · 2026-09-21T18:34:32.570Z · wall 184.45s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=9f2756dce4a4cbb3

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 3 | 4 | 34.55 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 15 | 13 | 181.44 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✔ | 7 | 8 | 94.85 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✔ | 3 | 3 | — |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:复用既有产线 `注塑成型质量窗口寻优 injection-undefined` line=ln-e8350d53 recipe=rc-fb7b675b DCW=11 DAQ=14
- 驱动实测:—
- Channel:channel=da477c93-b219-4703-91fe-5e8e843899b3 toolAgent=e659d8ea-9dbb-4db0-a90f-dd6aa7874ec5 task=57528f8e-f4d3-4916-a625-431f35afa7a6 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `A2O 污水生化处理达标降耗 wwtp-undefined` line=ln-00f606d3 recipe=rc-ca808507 DCW=7 DAQ=13
- 驱动实测:—
- Channel:channel=2960c868-c72e-42ce-b6d9-2dd76d0b4b91 toolAgent=0916c893-c546-4a31-a6d4-7358632a6096 task=468857ce-d48b-4d12-b3da-b4d8f64ed580 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `连续退火质量窗内产能最大化 anneal-undefined` line=ln-2757f3f4 recipe=rc-3c91c7af DCW=7 DAQ=12
- 驱动实测:—
- Channel:channel=95418033-b8e9-42f8-b214-a9a12a2c9be4 toolAgent=126e0b3c-f866-4895-b12e-ddc01cfe6cc1 task=8bf5e877-5bd5-43db-8b1e-e049c35859f3 终态=COMPLETED

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
| 2 | converge | hold-time-sp | 6 → 10.85 | 32.12 g | yes | keep ✔ |
| 3 | converge | hold-pressure-sp | 57.7 → 61.72 | 32.34 g | yes | keep ✔ |

- baseline 克重=31.30g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→57.73 ✔ record=yes · 克重→31.89g
- iter2: hold-time-sp 6→10.85 ✔ record=yes · 克重→32.12g
- iter3: hold-pressure-sp 57.7→61.72 ✔ record=yes · 克重→32.34g
- outcome: writes=3 final=32.34g attained=true guards={"飞边率":0.0078,"缩痕指数":0.944}
- 守卫终值:飞边率=0.01 · 缩痕指数=0.94

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.23 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30.03 | 2.15 mg/L | yes | keep ✔ |
| 2 | blower | blower-hz-sp | 30 → 31.59 | 2.74 mg/L | yes | keep ✔ |
| 3 | blower | blower-hz-sp | 31.600000381469727 → 32.44 | 3.06 mg/L | yes | keep ✔ |
| 4 | blower | blower-hz-sp | 32.400001525878906 → 33.2 | 3.20 mg/L | yes | keep ✔ |
| 5 | blower | blower-hz-sp | 33.20000076293945 → 34 | 3.50 mg/L | yes | keep ✔ |
| 5 | ph | naoh-dose-sp | 12 → 30.3 | 6.61 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.53 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.46 mg/L | yes | keep ✔ |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.42 mg/L | yes | keep ✔ |

- baseline DO=0.23 COD=360 NH3=34.5 TP=0.67 pH=6.58 → 不达标
- iter1(曝气): 风机 26→30.03 ✔
- iter2(曝气): 风机 30→31.59 ✔
- iter3(曝气): 风机 31.600000381469727→32.44 ✔
- iter4(曝气): 风机 32.400001525878906→33.2 ✔
- iter5(曝气): 风机 33.20000076293945→34 ✔
- iter5(中和): NaOH 12→30.3 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标确认 ✔ 首个达标运行成本 ≈181.2(风机 34/NaOH 30/PAC 75)
- iter11(降耗): 风机 34→32.8 复测非裕度达标(50/3.5) → 回退 ✔
- iter11(降耗): NaOH 30→26 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 34→32.8 复测非裕度达标(49/3.4) → 回退 ✔
- iter12(降耗): NaOH 26→22 ✔ 带裕度复测达标,保留
- outcome: writes=15 DO=3.55 compliant=true cost 181.2→178.8(省 2.4) attained=true
- **成本曲线**:首个达标运行成本 ≈181.2 → 终态 ≈178.8(降 2.4,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=41.80 · 出水氨氮=2.57 · 出水总磷=0.41 · 出水pH=6.30 · 出水浊度=0.67 · DO=3.55

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.52 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.50 HV | — | ✘ |
| trim1 | margin | zone2-sp | 710 → 722 | 98.40 HV | yes | keep ✔ |
| trim2 | margin | zone2-sp | 722 → 734 | 98.26 HV | yes | keep ✔ |
| 6 | throughput | line-speed-sp | 140 → 152 | 99.30 HV | — | ✘ |
| 7 | throughput | line-speed-sp | 152 → 164 | 99.60 HV | yes | keep ✔ |
| 8 | throughput | line-speed-sp | 164 → 176 | 99.80 HV | yes | keep ✔ |

- baseline 硬度=134.5HV 抗拉=311MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- trim1: zone2-sp 710→722 硬度→98.4HV(修剪线 ≤98)
- trim2: zone2-sp 722→734 硬度→98.3HV(修剪线 ≤98)
- iter6(产能): 线速 140→152 ✔ 硬度 99.3HV 留裕度窗内
- iter7(产能): 线速 152→164 ✔ 硬度 99.6HV 留裕度窗内
- iter8(产能): 线速 164→176 ✔ 硬度 99.8HV 留裕度窗内
- iter9(产能): 线速 176→188 硬度 101.1HV 出窗/无裕度 → 回退 ✔
- 产能推进: 线速 140→176(+25.71%),pushed=3
- outcome: writes=7 final=99.9HV attained=true(窗内+产能≥5%)
- **产能曲线**:线速 140 → 176 m/min(+25.7%,质量窗触边自动回退)
- 守卫终值:抗拉强度=295.80 · 表面缺陷率=0.15

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 28.00 μm | — |  |
| 1 | converge | cast-spd-sp | 32 → 33.7 | 26.66 μm | yes | keep ✔ |
| 2 | converge | fast-roll-sp | 118 → 120.6 | 25.98 μm | yes | keep ✔ |
| 3 | converge | rail-out-sp | 3000 → 3034 | 25.68 μm | yes | keep ✔ |

- 1. task board: channel=97f92a85-f699-460d-a614-10f799e2d942 parent=a0c7396b-df7d-42a3-8f71-651e6dc94312 leadChild=b077cc2e-caa7-4414-bf76-1ab016953ed2
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[3.5,1.6]
- 3. initial thickness=28.00 μm(目标 25±0.7)
- iter1: cast-spd-sp 32→33.7 ✔ record=opt-ed96fd… · thickness→26.66μm · judge=keep✔
-         meltTemp=291.5℃(安全窗 268~300)
- iter2: fast-roll-sp 118→120.6 ✔ record=opt-ed48c6… · thickness→25.98μm · judge=keep✔
-         meltTemp=291.4℃(安全窗 268~300)
- iter3: rail-out-sp 3000→3034 ✔ record=opt-66b6c6… · thickness→25.68μm · judge=keep✔
-         meltTemp=291.8℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(1 条,含参数/判定/窗口):
- opt-ed96fd00 [judged-keep] 铸片辊速度SP·ip16dt0e: 32 → 33.7,设定 02:28:21,判定 keep(agent:biax mission ite
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


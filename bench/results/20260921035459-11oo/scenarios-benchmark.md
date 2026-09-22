# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:PASS** · run `20260921035459-11oo` · 2026-09-21T04:05:23.819Z · wall 151.59s · 并行 3 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=50fb2e0e936bd45e

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 3 | 4 | 34.28 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 14 | 12 | 148.58 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✔ | 3 | 4 | 58.41 |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:复用既有产线 `注塑成型质量窗口寻优 injection-ms16s89p` line=ln-578787c4 recipe=rc-0844d785 DCW=11 DAQ=14
- 驱动实测:—
- Channel:channel=6a72faf2-8faf-422e-bdd0-4b5dbc43a57d toolAgent=5acc774c-c07d-40d0-8ca5-380aae37b121 task=d0ae2255-019a-4c3a-a71c-9196ef87780f 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `A2O 污水生化处理达标降耗 wwtp-ms16s89p` line=ln-56ddf10e recipe=rc-9212a4eb DCW=7 DAQ=13
- 驱动实测:—
- Channel:channel=51d2f317-e3dc-43da-b174-a1058eadfe49 toolAgent=40a0bb0f-b572-42ab-9052-0272c772a9ce task=7a03c551-c171-4066-b3f3-688416064ea7 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `连续退火质量窗内产能最大化 anneal-ms16s89p` line=ln-27cf6584 recipe=rc-1a7c9b43 DCW=7 DAQ=12
- 驱动实测:—
- Channel:channel=10e4dafb-ee89-498b-9d67-32089aa023b4 toolAgent=63a3a72a-97b4-46e7-a3e2-8f5b12b4926d task=fce85697-21d0-4b81-9e25-17f69ce360b2 终态=COMPLETED

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
| 0 | baseline | — | — | 0.21 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30.06 | 2.19 mg/L | yes | keep ✔ |
| 2 | blower | blower-hz-sp | 30.100000381469727 → 31.64 | 2.75 mg/L | yes | keep ✔ |
| 3 | blower | blower-hz-sp | 31.600000381469727 → 32.43 | 3.06 mg/L | yes | keep ✔ |
| 4 | blower | blower-hz-sp | 32.400001525878906 → 33.2 | 3.30 mg/L | yes | keep ✔ |
| 5 | ph | naoh-dose-sp | 12 → 30.37 | 6.64 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.55 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.46 mg/L | yes | keep ✔ |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.41 mg/L | yes | keep ✔ |

- baseline DO=0.21 COD=360 NH3=34.5 TP=0.67 pH=6.58 → 不达标
- iter1(曝气): 风机 26→30.06 ✔
- iter2(曝气): 风机 30.100000381469727→31.64 ✔
- iter3(曝气): 风机 31.600000381469727→32.43 ✔
- iter4(曝气): 风机 32.400001525878906→33.2 ✔
- iter5(中和): NaOH 12→30.37 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标确认 ✔ 首个达标运行成本 ≈172.9(风机 33.20000076293945/NaOH 30/PAC 75)
- iter11(降耗): 风机 33.20000076293945→32 复测非裕度达标(57/4.4) → 回退 ✔
- iter11(降耗): NaOH 30→26 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 33.20000076293945→32 复测非裕度达标(50/3.5) → 回退 ✔
- iter12(降耗): NaOH 26→22 ✔ 带裕度复测达标,保留
- outcome: writes=14 DO=3.26 compliant=true cost 172.9→170.5(省 2.4) attained=true
- **成本曲线**:首个达标运行成本 ≈172.9 → 终态 ≈170.5(降 2.4,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=47.96 · 出水氨氮=3.28 · 出水总磷=0.42 · 出水pH=6.33 · 出水浊度=0.63 · DO=3.26

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.92 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.58 HV | — | ✘ |
| 6 | throughput | line-speed-sp | 140 → 152 | 100.44 HV | — | ✘ |

- baseline 硬度=134.9HV 抗拉=310MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- iter6(产能): 线速 140→152 ✔ 硬度 100.4HV 仍在窗内
- iter7(产能): 线速 152→164 硬度 101.4HV 出窗 → 回退 ✔
- 产能推进: 线速 140→152(+8.57%),pushed=1
- outcome: writes=3 final=101.0HV attained=true(窗内+产能≥5%)
- **产能曲线**:线速 140 → 152 m/min(+8.6%,质量窗触边自动回退)
- 守卫终值:抗拉强度=297.14 · 表面缺陷率=0.13

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


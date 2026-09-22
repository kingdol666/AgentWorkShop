# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:PASS** · run `20260921031623-11yg` · 2026-09-21T03:18:14.079Z · wall 110.3s · 并行 3 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=892319ad0f3cb39d

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 0 | 1 | 5.58 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 8 | 6 | 107.31 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✔ | 4 | 5 | 37.95 |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:复用既有产线 `注塑成型质量窗口寻优 injection-ms16s89p` line=ln-578787c4 recipe=rc-0844d785 DCW=11 DAQ=14
- 驱动实测:—
- Channel:channel=79d28183-67c3-404a-ad2d-a735e0c70531 toolAgent=23d3f886-d0e6-4c1f-9d16-affb710ba49f task=441b5535-c77e-4b7b-8801-a45e4ceaa37e 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `A2O 污水生化处理达标降耗 wwtp-ms16s89p` line=ln-56ddf10e recipe=rc-9212a4eb DCW=7 DAQ=13
- 驱动实测:—
- Channel:channel=93b144e4-b8a0-4f7a-811e-1c36f44b7b23 toolAgent=5901173d-f24b-42a3-95d1-994c0689b271 task=abd1c376-da4e-4f71-9261-0eca91e9208a 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `连续退火质量窗内产能最大化 anneal-ms16s89p` line=ln-27cf6584 recipe=rc-1a7c9b43 DCW=7 DAQ=12
- 驱动实测:—
- Channel:channel=78db5a42-1789-4e7b-b248-19e8a04398bd toolAgent=a131c903-c68f-4899-8ed5-a855786be9ab task=63080f52-3c7e-49ad-b35d-e2cfaa8b4211 终态=COMPLETED

## 2. 闭环优化过程(全轨迹)

### injection · 注塑成型质量窗口寻优

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 32.28 g | — |  |

- baseline 克重=32.28g(目标 32.5±0.35)
- outcome: writes=0 final=32.28g attained=true guards={"飞边率":0,"缩痕指数":1.2200000000000002}
- 守卫终值:飞边率=0.00 · 缩痕指数=1.22

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 2.94 mg/L | — |  |
| 1 | blower | blower-hz-sp | 32.5 → 33.3 | 3.30 mg/L | yes | keep ✔ |

- baseline DO=2.94 COD=56 NH3=4.3 TP=0.40 pH=6.68 → 不达标
- iter1(曝气): 风机 32.5→33.3 ✔
- 达标确认 ✔ 首个达标运行成本 ≈173.9(风机 33.29999923706055/NaOH 30/PAC 75)
- iter11(降耗): 风机 33.29999923706055→32.1 复测非裕度达标(56/4.3) → 回退 ✔
- iter11(降耗): NaOH 30→26 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 33.29999923706055→32.1 复测非裕度达标(56/4.3) → 回退 ✔
- iter12(降耗): NaOH 26→22 复测非裕度达标(pH 6.30) → 回退 ✔
- outcome: writes=8 DO=3.34 compliant=true cost 173.9→172.7(省 1.2) attained=true
- **成本曲线**:首个达标运行成本 ≈173.9 → 终态 ≈172.7(降 1.2,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=46.70 · 出水氨氮=3.10 · 出水总磷=0.40 · 出水pH=6.50 · 出水浊度=0.62 · DO=3.34

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 99.34 HV | — |  |
| 6 | throughput | line-speed-sp | 200 → 212 | 100.12 HV | yes | keep ✔ |
| 7 | throughput | line-speed-sp | 212 → 220 | 100.10 HV | yes | keep ✔ |
| 8 | throughput | line-speed-sp | 220 → 220 | 100.46 HV | — | ✘ |
| 9 | throughput | line-speed-sp | 220 → 220 | 100.56 HV | — | ✘ |

- baseline 硬度=99.3HV 抗拉=295MPa 线速=200m/min → 窗内
- iter6(产能): 线速 200→212 ✔ 硬度 100.1HV 仍在窗内
- iter7(产能): 线速 212→220 ✔ 硬度 100.1HV 仍在窗内
- iter8(产能): 线速 220→220 ✔ 硬度 100.5HV 仍在窗内
- iter9(产能): 线速 220→220 ✔ 硬度 100.6HV 仍在窗内
- 产能推进: 线速 200→220(+10%),pushed=4
- outcome: writes=4 final=100.6HV attained=true(窗内+产能≥5%)
- **产能曲线**:线速 200 → 220 m/min(+10.0%,质量窗触边自动回退)
- 守卫终值:抗拉强度=296.62 · 表面缺陷率=0.12

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


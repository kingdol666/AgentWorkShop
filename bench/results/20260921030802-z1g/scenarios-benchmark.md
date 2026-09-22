# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20260921030802-z1g` · 2026-09-21T03:11:21.493Z · wall 198.7s · 并行 3 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=72c4f0727096b844

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 0 | 1 | 2.2 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✘ | 16 | 8 | 195.65 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✔ | 5 | 7 | 61.24 |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:新建产线 `注塑成型质量窗口寻优 injection-ms160n82` line=ln-373309f1 recipe=rc-118a418e DCW=11 DAQ=14 错误:标签产线 ln-578787c4 节点/配方不齐(dcw=true daq=false recipe=true)→ 新建;标签产线 ln-578787c4 节点/配方不齐(dcw=true daq=false recipe=true)→ 新建
- 驱动实测:inj-machine-mbtcp/机筒温度区1SP ✔ · inj-mold-rtu/模具温度SP ✔ · inj-inject-opcua/InjectSpeedSP ✔ · inj-cool-mqtt/WaterTempPV ✔ · inj-inspect-http/PartWeight ✔
- Channel:channel=210732fa-b6df-4f57-a328-561a7d3e6bf9 toolAgent=4dbb0de6-b6d0-49b5-b539-14667b437f74 task=6f57836c-d3f8-4a0f-96e7-7c7487134118 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `A2O 污水生化处理达标降耗 wwtp-ms160n82` line=ln-333a7187 recipe=rc-2aeabdfa DCW=7 DAQ=13 错误:标签产线 ln-56ddf10e 节点/配方不齐(dcw=true daq=false recipe=true)→ 新建;标签产线 ln-56ddf10e 节点/配方不齐(dcw=true daq=false recipe=true)→ 新建
- 驱动实测:wwtp-blower-mbtcp/风机频率SP ✔ · wwtp-dosing-opcua/NaohDoseSP ✔ · wwtp-return-rtu/内回流比SP ✔ · wwtp-influent-mqtt/CodIn ✔ · wwtp-effluent-http/CodOut ✔
- Channel:channel=7f5af3a0-9168-443b-b728-47a5959e1197 toolAgent=558aaa56-29a8-4460-8f93-084d6167ddfa task=c354305c-7a70-42af-bafc-b31e9da02a9a 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `连续退火质量窗内产能最大化 anneal-ms160n82` line=ln-29840af1 recipe=rc-38251d30 DCW=7 DAQ=12 错误:标签产线 ln-27cf6584 节点/配方不齐(dcw=true daq=false recipe=true)→ 新建;标签产线 ln-27cf6584 节点/配方不齐(dcw=true daq=false recipe=true)→ 新建
- 驱动实测:anneal-heating-mbtcp/均热区1炉温SP ✔ · anneal-line-opcua/LineSpeedSP ✔ · anneal-cool-rtu/过时效温度SP ✔ · anneal-gas-mqtt/DewPoint ✔ · anneal-inspect-http/Hardness ✔
- Channel:channel=eb3b850c-7484-46b5-a1df-94724a202c95 toolAgent=5edfbcae-e568-4c74-8ceb-b0145f2e16ba task=6956e1bd-1790-4cd1-9b39-f501f942c766 终态=COMPLETED

## 2. 闭环优化过程(全轨迹)

### injection · 注塑成型质量窗口寻优

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 32.20 g | — |  |

- baseline 克重=32.20g(目标 32.5±0.35)
- outcome: writes=0 final=32.20g attained=true guards={"飞边率":0,"缩痕指数":1.2}
- 守卫终值:飞边率=0.00 · 缩痕指数=1.20
- ⚠ 错误:标签产线 ln-578787c4 节点/配方不齐(dcw=true daq=false recipe=true)→ 新建;标签产线 ln-578787c4 节点/配方不齐(dcw=true daq=false recipe=true)→ 新建

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 1.43 mg/L | — |  |
| 1 | blower | blower-hz-sp | 31.200000762939453 → 33.7 | 3.47 mg/L | yes | keep ✔ |

- baseline DO=1.43 COD=154 NH3=19.3 TP=0.40 pH=7.03 → 不达标
- iter1(曝气): 风机 31.200000762939453→33.7 ✔
- 达标确认 ✔ 首个达标运行成本 ≈178.1(风机 33.70000076293945/NaOH 30/PAC 75)
- iter11(降耗): 风机 33.70000076293945→32.5 ✔ 复测仍达标
- iter11(降耗): NaOH 30→26 复测不达标 → 回退 ✔
- iter12(降耗): 风机 32.5→31.3 复测不达标 → 回退 ✔
- iter12(降耗): NaOH 30→26 复测不达标 → 回退 ✔
- iter13(降耗): 风机 32.5→31.3 复测不达标 → 回退 ✔
- iter13(降耗): NaOH 30→26 复测不达标 → 回退 ✔
- iter14(降耗): 风机 32.5→31.3 复测不达标 → 回退 ✔
- iter14(降耗): NaOH 30→26 复测不达标 → 回退 ✔
- outcome: writes=16 DO=3.06 compliant=false cost 178.1→165.9(省 12.17) attained=false
- **成本曲线**:首个达标运行成本 ≈178.1 → 终态 ≈165.9(降 12.2,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=53.48 · 出水氨氮=3.96 · 出水总磷=0.40 · 出水pH=6.64 · 出水浊度=0.60 · DO=3.06
- ⚠ 错误:标签产线 ln-56ddf10e 节点/配方不齐(dcw=true daq=false recipe=true)→ 新建;标签产线 ln-56ddf10e 节点/配方不齐(dcw=true daq=false recipe=true)→ 新建

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 115.30 HV | — |  |
| 2 | converge | zone2-sp | 710 → 795 | 97.58 HV | yes | keep ✔ |
| 6 | throughput | line-speed-sp | 152 → 164 | 97.40 HV | yes | keep ✔ |
| 7 | throughput | line-speed-sp | 164 → 176 | 97.90 HV | yes | keep ✔ |
| 8 | throughput | line-speed-sp | 176 → 188 | 97.96 HV | yes | keep ✔ |
| 9 | throughput | line-speed-sp | 188 → 200 | 99.16 HV | yes | keep ✔ |

- baseline 硬度=115.3HV 抗拉=303MPa 线速=150m/min → 窗外
- iter1: zone3-sp 校正量过小(850)
- iter2: zone2-sp 710→795 ✔
- iter6(产能): 线速 152→164 ✔ 硬度 97.4HV 仍在窗内
- iter7(产能): 线速 164→176 ✔ 硬度 97.9HV 仍在窗内
- iter8(产能): 线速 176→188 ✔ 硬度 98.0HV 仍在窗内
- iter9(产能): 线速 188→200 ✔ 硬度 99.2HV 仍在窗内
- 产能推进: 线速 152→200(+31.58%),pushed=4
- outcome: writes=5 final=99.2HV attained=true(窗内+产能≥5%)
- **产能曲线**:线速 150 → 200 m/min(+31.6%,质量窗触边自动回退)
- 守卫终值:抗拉强度=297.42 · 表面缺陷率=0.14
- ⚠ 错误:标签产线 ln-27cf6584 节点/配方不齐(dcw=true daq=false recipe=true)→ 新建;标签产线 ln-27cf6584 节点/配方不齐(dcw=true daq=false recipe=true)→ 新建

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


# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20260921031935-wvw` · 2026-09-21T03:23:04.144Z · wall 208.2s · 并行 3 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=e692df1 · harness=69fd7c4a857f277d

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 3 | 4 | 46.04 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✘ | 15 | 13 | 205.23 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✔ | 3 | 4 | 74.12 |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:复用既有产线 `注塑成型质量窗口寻优 injection-ms16s89p` line=ln-578787c4 recipe=rc-0844d785 DCW=11 DAQ=14
- 驱动实测:—
- Channel:channel=e88d83fb-6f20-4c19-9f99-c5e3b7836190 toolAgent=18b661e2-036a-49f6-bddc-11778fb2c7a8 task=e04d56ec-5759-4fc2-9d9a-32642c8559fa 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `A2O 污水生化处理达标降耗 wwtp-ms16s89p` line=ln-56ddf10e recipe=rc-9212a4eb DCW=7 DAQ=13
- 驱动实测:—
- Channel:channel=1c769a37-d4c8-4f2c-b2fc-92bb27f06671 toolAgent=a701ec49-4243-4579-88ed-2c7b6d01bab7 task=c51ef04d-5bc6-4261-9896-9d9cac1d5f76 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `连续退火质量窗内产能最大化 anneal-ms16s89p` line=ln-27cf6584 recipe=rc-1a7c9b43 DCW=7 DAQ=12
- 驱动实测:—
- Channel:channel=7a5b18b1-f572-4a74-8232-021929ac0de5 toolAgent=9f9c1f9d-409e-490b-aa21-a26ccbc91670 task=e3a852cf-889e-4417-af49-322c417659b5 终态=COMPLETED

## 2. 闭环优化过程(全轨迹)

### injection · 注塑成型质量窗口寻优

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 31.28 g | — |  |
| 1 | converge | hold-pressure-sp | 45 → 57.9 | 31.90 g | yes | keep ✔ |
| 2 | converge | hold-time-sp | 6 → 10.8 | 32.13 g | yes | keep ✔ |
| 3 | converge | hold-pressure-sp | 57.9 → 61.78 | 32.37 g | yes | keep ✔ |

- baseline 克重=31.28g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→57.9 ✔ record=yes · 克重→31.90g
- iter2: hold-time-sp 6→10.8 ✔ record=yes · 克重→32.13g
- iter3: hold-pressure-sp 57.9→61.78 ✔ record=yes · 克重→32.37g
- outcome: writes=3 final=32.37g attained=true guards={"飞边率":0,"缩痕指数":0.8400000000000001}
- 守卫终值:飞边率=0.00 · 缩痕指数=0.84

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.22 mg/L | — |  |
| 1 | blower | blower-hz-sp | 26 → 30.05 | 2.20 mg/L | yes | keep ✔ |
| 2 | blower | blower-hz-sp | 30 → 31.58 | 2.80 mg/L | yes | keep ✔ |
| 3 | blower | blower-hz-sp | 31.600000381469727 → 32.4 | 3.00 mg/L | yes | keep ✔ |
| 4 | blower | blower-hz-sp | 32.400001525878906 → 33.2 | 3.20 mg/L | yes | keep ✔ |
| 5 | blower | blower-hz-sp | 33.20000076293945 → 34 | 3.43 mg/L | yes | keep ✔ |
| 5 | ph | naoh-dose-sp | 12 → 30.1 | 6.63 mg/L | yes | keep ✔ |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.53 mg/L | yes | keep ✔ |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.47 mg/L | yes | keep ✔ |

- baseline DO=0.22 COD=360 NH3=34.5 TP=0.66 pH=6.58 → 不达标
- iter1(曝气): 风机 26→30.05 ✔
- iter2(曝气): 风机 30→31.58 ✔
- iter3(曝气): 风机 31.600000381469727→32.4 ✔
- iter4(曝气): 风机 32.400001525878906→33.2 ✔
- iter5(曝气): 风机 33.20000076293945→34 ✔
- iter5(中和): NaOH 12→30.1 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- 达标确认 ✔ 首个达标运行成本 ≈174.5(风机 34/NaOH 30/PAC 60)
- iter11(降耗): 风机 34→32.8 复测非裕度达标(49/3.5) → 回退 ✔
- iter11(降耗): NaOH 30→26 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 34→32.8 复测非裕度达标(47/3.2) → 回退 ✔
- iter12(降耗): NaOH 26→22 ✔ 带裕度复测达标,保留
- recover: 风机 34→35.5 ✔
- outcome: writes=15 DO=3.92 compliant=false cost 174.5→188.5(省 -14.05) attained=false
- **成本曲线**:首个达标运行成本 ≈174.5 → 终态 ≈188.5(降 -14.1,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=34.56 · 出水氨氮=1.80 · 出水总磷=0.50 · 出水pH=6.30 · 出水浊度=0.60 · DO=3.92

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.52 HV | — |  |
| 1 | converge | zone3-sp | 730 → 850 | 99.50 HV | — | ✘ |
| 6 | throughput | line-speed-sp | 140 → 152 | 99.34 HV | yes | keep ✔ |

- baseline 硬度=134.5HV 抗拉=310MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- iter6(产能): 线速 140→152 ✔ 硬度 99.3HV 仍在窗内
- iter7(产能): 线速 152→164 硬度 101.7HV 出窗 → 回退 ✔
- 产能推进: 线速 140→152(+8.57%),pushed=1
- outcome: writes=3 final=100.2HV attained=true(窗内+产能≥5%)
- **产能曲线**:线速 140 → 152 m/min(+8.6%,质量窗触边自动回退)
- 守卫终值:抗拉强度=297.50 · 表面缺陷率=0.20

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


# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20260921053416-yd0` · 2026-09-21T05:39:26.877Z · wall 235.1s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4010 · toolHarness=opencode · git=e692df1 · harness=069fda319c0cbac1

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 0 | 1 | 14.02 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 7 | 6 | 82.03 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✘ | 2 | 3 | 46.33 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✘ | 1 | 1 | 232.12 |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:复用既有产线 `注塑成型质量窗口寻优 injection-ms16s89p` line=ln-578787c4 recipe=rc-0844d785 DCW=11 DAQ=14
- 驱动实测:—
- Channel:channel=eefb1f7d-ef58-42fe-be8e-b9ae5d11ae25 toolAgent=5576559b-965c-48e2-8964-8c00c90a0dda task=1bfb01f1-f2f3-44ef-bebf-f35a5c908631 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `A2O 污水生化处理达标降耗 wwtp-ms16s89p` line=ln-56ddf10e recipe=rc-9212a4eb DCW=7 DAQ=13
- 驱动实测:—
- Channel:channel=00f7d445-7e48-4ef9-98a6-7d5bf9821019 toolAgent=daaee166-0fc9-4b97-8c69-5448cb4daab2 task=ca1ba3f5-eb44-420b-8f07-58dbf418a188 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `连续退火质量窗内产能最大化 anneal-ms16s89p` line=ln-27cf6584 recipe=rc-1a7c9b43 DCW=7 DAQ=12
- 驱动实测:—
- Channel:channel=882571f8-ed10-4b4b-9eba-e835c3449e6a toolAgent=66809910-4e30-4134-9db6-bea4d83c9979 task=689ec795-fd25-4a9b-9b56-29c0b3d7bed2 终态=COMPLETED

### biax · 双拉(BOPET)薄膜产线多节点闭环
- 模拟器侧:{"missing":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"drifted":[],"created":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":9,"expectDevices":9,"signals":49,"sp":30,"pv":19,"descMissing":0,"protocols":["opcua","modbus-tcp","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `双拉(BOPET)薄膜产线多节点闭环 biax-ms16ab37` line=ln-9c727d83 recipe=rc-a9e7b3f4 DCW=30 DAQ=19
- 驱动实测:biax-dryer-opcua/干燥温度SP ✔ · biax-extruder-mbtcp/机筒温度区1SP ✔ · biax-pump-rtu/计量泵转速SP ✔ · biax-casting-mbtcp/模唇温度SP ✔ · biax-mdo-mbtcp/预热辊1温度SP ✔ · biax-tdo-opcua/TDO预热段SP ✔ · biax-gauge-mqtt/biaxThick ✔ · biax-inspect-http/coronaPower ✔ · biax-winder-mbtcp/收卷张力SP ✔
- Channel:channel=2f38bb6d-d5c7-4dc6-a646-8b02a4cd3e45 toolAgent=abe7d28d-733c-4d1a-bb02-922f827128e3 task=6c91b7ad-3f2e-4664-b7bc-b3663ac61916 终态=COMPLETED

## 2. 闭环优化过程(全轨迹)

### injection · 注塑成型质量窗口寻优

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 32.33 g | — |  |

- baseline 克重=32.33g(目标 32.5±0.35)
- outcome: writes=0 final=32.33g attained=true guards={"飞边率":0.004,"缩痕指数":0.8652}
- 守卫终值:飞边率=0.00 · 缩痕指数=0.87

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 3.34 mg/L | — |  |
| 5 | ph | naoh-dose-sp | 22 → 34.02 | 6.81 mg/L | yes | keep ✔ |

- baseline DO=3.34 COD=47 NH3=3.2 TP=0.41 pH=6.30 → 达标
- iter5(中和): NaOH 22→34.02 ✔
- 达标确认 ✔ 首个达标运行成本 ≈174.1(风机 33.20000076293945/NaOH 34/PAC 75)
- iter11(降耗): 风机 33.20000076293945→32 复测非裕度达标(57/4.4) → 回退 ✔
- iter11(降耗): NaOH 34→30 ✔ 带裕度复测达标,保留
- iter12(降耗): 风机 33.20000076293945→32 复测非裕度达标(49/3.4) → 回退 ✔
- iter12(降耗): NaOH 30→26 ✔ 带裕度复测达标,保留
- outcome: writes=7 DO=3.25 compliant=true cost 174.1→171.7(省 2.4) attained=true
- **成本曲线**:首个达标运行成本 ≈174.1 → 终态 ≈171.7(降 2.4,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=47.56 · 出水氨氮=3.19 · 出水总磷=0.42 · 出水pH=6.50 · 出水浊度=0.63 · DO=3.25

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 99.90 HV | — |  |
| 6 | throughput | line-speed-sp | 152 → 164 | 100.20 HV | yes | keep ✔ |

- baseline 硬度=99.9HV 抗拉=296MPa 线速=152m/min → 窗内
- iter6(产能): 线速 152→164 ✔ 硬度 100.2HV 仍在窗内
- iter7(产能): 线速 164→176 硬度 102.5HV 出窗 → 回退 ✔
- 产能推进: 线速 152→164(+7.89%),pushed=1
- outcome: writes=2 final=101.4HV attained=false(窗内+产能≥5%)
- **产能曲线**:线速 152 → 164 m/min(+7.9%,质量窗触边自动回退)
- 守卫终值:抗拉强度=296.10 · 表面缺陷率=0.15

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 27.05 μm | — |  |
| 1.rebase | converge | warm-reset+recipe-apply | — | -0.07 μm | — |  |

- 1. task board: channel=e3996add-5b59-431a-9a3d-38e7fa5e446d parent=68d04531-51b3-45c7-8b0e-5b88532e9cef leadChild=64fd1eab-85f2-4c63-84be-01705ca06822
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[27.21,3.5,1.6]
- 3. initial thickness=27.05 μm(目标 25±0.7)
- iter1: 检出断膜量级读数(0.04μm << 目标 25μm)——暂停纠偏,warm 复位+配方基线恢复
- iter1.rebase#1: warm 复位(✘ ) + 配方基线重下(✔)
- iter1.rebase#2: warm 复位(✘ ) + 配方基线重下(✔)
- iter1.rebase: 恢复后读数 -0.07μm
- iter1: 基线恢复失败,如实终止(植物侧流量/拉伸异常,非治理写路径或任务数学缺陷)
- 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(1 条,含参数/判定/窗口):
- opt-c5852482 [superseded] scen-biax:dcw:cast-spd-sp: 32 → 33.2,设定 13:36:18,判定 未判定,关闭于 13:37:19(su
- 5. outcome: writes=1 distinctKnobs=1 final=-0.07μm attained=false
- 6. task terminal=COMPLETED

## 3. 诚实边界
- 全部写路径经平台治理(dcw_control 自动开优化记录 + dcw_judge 判定收口);策略为确定性脚本(不经 LLM),与真实 LLM 变体共用同一工具面与治理链路。
- 物理数据由模拟器多引擎(cast-film/biax/injection/wwtp/anneal)产出,同 seed 确定性;J/W* 与真实产线存在仿真层级边界。
- 平台侧产线为「复用优先」:本报告如显示 reused,说明前次接入仍在,本次零重复建线(设计语义)。

## 4. 复现

```bash
NO_PROXY=127.0.0.1,localhost \
AW_BASE=http://127.0.0.1:3005 SIM_BASE=http://127.0.0.1:4010 \
  node bench/scenarios.mjs --seed 42 --tool-harness opencode
```


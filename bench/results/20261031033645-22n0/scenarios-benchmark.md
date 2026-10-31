# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20261031033645-22n0` · 2026-10-31T03:39:37.448Z · wall 171.4s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=60fa983e · harness=e3fc36250d48e6b0

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 3 | 4 | 32.14 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 11 | 12 | 168.37 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✔ | 8 | 9 | 125.41 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✘ | 0 | 0 | 13.94 |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:复用既有产线 `注塑成型质量窗口寻优 injection-ms16ecxd` line=ln-54c22f76 recipe=rc-0ade309b DCW=11 DAQ=14
- 驱动实测:—
- Channel:channel=99310110-f118-440e-923b-a2f242c460ac toolAgent=44bf09d6-13c1-4752-a9e3-222ec3dffb66 task=2b5d773e-8218-4e75-98f4-ba904f347a00 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `A2O 污水生化处理达标降耗 wwtp-ms16ecxd` line=ln-8331c05b recipe=rc-7df26e28 DCW=7 DAQ=13
- 驱动实测:—
- Channel:channel=946430df-c969-4a15-949c-a71933f1c175 toolAgent=b4ae1014-cdbd-4bf6-82cd-79041db8c781 task=b6b65085-d551-4c3b-8af1-347578590181 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `连续退火质量窗内产能最大化 anneal-ms16ecxd` line=ln-692c4ffb recipe=rc-5edb9dc3 DCW=7 DAQ=12
- 驱动实测:—
- Channel:channel=8f566091-ea1c-4c89-a447-0b1fcd702cad toolAgent=f58b15ef-b02e-4a00-a417-fce0764be245 task=88a2a937-d03c-412b-a1bf-59b699fcd85e 终态=COMPLETED

### biax · 双拉(BOPET)薄膜产线多节点闭环
- 模拟器侧:{"missing":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"drifted":[],"created":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":9,"expectDevices":9,"signals":49,"sp":30,"pv":19,"descMissing":0,"protocols":["opcua","modbus-tcp","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `双拉(BOPET)薄膜产线多节点闭环 biax-ms16ecxd` line=ln-227fb62f recipe=rc-8bfd3d69 DCW=30 DAQ=19
- 驱动实测:—
- Channel:channel=e31db007-2694-40ae-8c04-d17f15bbdfcf toolAgent=53fb96be-4a5d-4ca6-a97e-2b2f34e92004 task=5afdd4f8-5284-4e66-845b-1728300ee7fd 终态=COMPLETED

## 2. 闭环优化过程(全轨迹)

### injection · 注塑成型质量窗口寻优

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 31.25 g | — |
| 1 | converge | hold-pressure-sp | 45 → 58.22 | 31.94 g | yes |
| 2 | converge | hold-time-sp | 6 → 10.51 | 32.15 g | yes |
| 3 | converge | hold-pressure-sp | 58.2 → 61.9 | 32.37 g | yes |

- baseline 克重=31.25g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→58.22 ✔ batch=yes · 克重→31.94g
- iter2: hold-time-sp 6→10.51 ✔ batch=yes · 克重→32.15g
- iter3: hold-pressure-sp 58.2→61.9 ✔ batch=yes · 克重→32.37g
- outcome: writes=3 final=32.37g attained=true guards={"飞边率":0.0068000000000000005,"缩痕指数":0.9154}
- 守卫终值:飞边率=0.01 · 缩痕指数=0.92

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.24 mg/L | — |
| 1 | blower | blower-hz-sp | 26 → 30.02 | 1.80 mg/L | yes |
| 2 | blower | blower-hz-sp | 30 → 32.07 | 1.88 mg/L | yes |
| 3 | blower | blower-hz-sp | 32.099998474121094 → 34.05 | 3.05 mg/L | yes |
| 4 | blower | blower-hz-sp | 34 → 34.8 | 3.24 mg/L | yes |
| 5 | blower | blower-hz-sp | 34.79999923706055 → 35.6 | 3.38 mg/L | yes |
| 5 | ph | naoh-dose-sp | 12 → 30.68 | 6.68 mg/L | yes |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.55 mg/L | yes |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.48 mg/L | yes |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.41 mg/L | yes |

- baseline DO=0.24 COD=360 NH3=34.5 TP=0.66 pH=6.59 → 不达标
- iter1(曝气): 风机 26→30.02 ✔
- iter2(曝气): 风机 30→32.07 ✔
- iter3(曝气): 风机 32.099998474121094→34.05 ✔
- iter4(曝气): 风机 34→34.8 ✔
- iter5(曝气): 风机 34.79999923706055→35.6 ✔
- iter5(中和): NaOH 12→30.68 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标确认 ✔ 首个达标运行成本 ≈199.1(风机 35.599998474121094/NaOH 31/PAC 75)
- iter11(降耗): 风机 35.599998474121094→34.4 ✔ 带裕度复测达标,保留
- iter11(降耗): NaOH 31→27 ✔ 带裕度复测达标,保留
- outcome: writes=11 DO=3.74 compliant=true cost 199.1→184.6(省 14.51) attained=true
- **成本曲线**:首个达标运行成本 ≈199.1 → 终态 ≈184.6(降 14.5,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=37.64 · 出水氨氮=2.16 · 出水总磷=0.42 · 出水pH=6.51 · 出水浊度=0.57 · DO=3.74

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.48 HV | — |
| 1 | converge | zone3-sp | 730 → 850 | 106.78 HV | yes |
| 2 | converge | zone2-sp | 710 → 759 | 99.20 HV | yes |
| trim1 | margin | zone2-sp | 759 → 771 | 98.58 HV | yes |
| trim2 | margin | zone2-sp | 771 → 783 | 97.54 HV | yes |
| 6 | throughput | line-speed-sp | 140 → 152 | 97.22 HV | yes |
| 7 | throughput | line-speed-sp | 152 → 164 | 97.20 HV | yes |
| 8 | throughput | line-speed-sp | 164 → 176 | 98.22 HV | yes |
| 9 | throughput | line-speed-sp | 176 → 188 | 97.80 HV | yes |

- baseline 硬度=134.5HV 抗拉=311MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- iter2: zone2-sp 710→759 ✔
- trim1: zone2-sp 759→771 硬度→98.6HV(修剪线 ≤98)
- trim2: zone2-sp 771→783 硬度→97.5HV(修剪线 ≤98)
- iter6(产能): 线速 140→152 ✔ 硬度 97.2HV 留裕度窗内
- iter7(产能): 线速 152→164 ✔ 硬度 97.2HV 留裕度窗内
- iter8(产能): 线速 164→176 ✔ 硬度 98.2HV 留裕度窗内
- iter9(产能): 线速 176→188 ✔ 硬度 97.8HV 留裕度窗内
- 产能推进: 线速 140→188(+34.29%),pushed=4
- outcome: writes=8 final=98.5HV attained=true(窗内+产能≥5%)
- **产能曲线**:线速 140 → 188 m/min(+34.3%,质量窗触边自动回退)
- 守卫终值:抗拉强度=296.74 · 表面缺陷率=0.14

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 27.40 μm | — |

- 1. task board: channel=2ab10aab-e859-415e-b517-8f98525df3f1 parent=38154322-4ffe-4a3b-8216-68a885b55fdf leadChild=5b449533-285e-4644-90af-440dee327b64
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.01,3.5,1.6]
- 3. initial thickness=27.40 μm(目标 25±0.7)
- iter1: cast-spd-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter2: fast-roll-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter3: rail-out-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter4: cast-spd-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter5: fast-roll-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter6: rail-out-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- 4. journal(铸速节点)归因 Agent: ✘ · 无权查询节点 dw-86e462ea 的账本(仅可查你绑定范围内的对象:rc-8bfd3d69, dn-0d001c2b, dn-bcc52689, dn-4d3b91d9, dn-e8be4f60, dn-c9bd3338, dn-f19
- 5. outcome: writes=0 distinctKnobs=0 final=27.40μm attained=false
- 6. task terminal=COMPLETED

## 3. 诚实边界
- 全部写路径经平台治理(绑定配方上的 recipe_trial 整批试验下发,复测判读,不写配方版本);策略为确定性脚本(不经 LLM),与真实 LLM 变体共用同一工具面与治理链路。
- 物理数据由模拟器多引擎(cast-film/biax/injection/wwtp/anneal)产出,同 seed 确定性;J/W* 与真实产线存在仿真层级边界。
- 平台侧产线为「复用优先」:本报告如显示 reused,说明前次接入仍在,本次零重复建线(设计语义)。

## 4. 复现

```bash
NO_PROXY=127.0.0.1,localhost \
AW_BASE=http://127.0.0.1:3005 SIM_BASE=http://127.0.0.1:4011 \
  node bench/scenarios.mjs --seed 42 --tool-harness opencode
```


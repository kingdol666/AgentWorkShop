# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20261030171953-alg` · 2026-10-30T17:21:01.572Z · wall 67.7s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3005 · simulator=http://127.0.0.1:4011 · toolHarness=opencode · git=60fa983e · harness=6923856da6934c7d

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✘ | 0 | 8 | 17.68 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✘ | 3 | 5 | 53.74 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✘ | 1 | 5 | 58.63 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✘ | 0 | 0 | 22.53 |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:复用既有产线 `注塑成型质量窗口寻优 injection-ms16ecxd` line=ln-54c22f76 recipe=rc-0ade309b DCW=11 DAQ=14
- 驱动实测:—
- Channel:channel=f3094ee4-edcf-46d9-9317-c772efb76635 toolAgent=02db6431-52ee-4a41-a371-f8a6db745127 task=c82a34f9-71a6-4a76-bd34-473043f85f4d 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `A2O 污水生化处理达标降耗 wwtp-ms16ecxd` line=ln-8331c05b recipe=rc-7df26e28 DCW=7 DAQ=13
- 驱动实测:—
- Channel:channel=a918ef78-defb-4a4f-9a37-45a5c1fb4f48 toolAgent=87498811-37da-43ac-b8a7-cdb0a44d6afe task=419d278e-f19d-4093-badf-797f0792469d 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `连续退火质量窗内产能最大化 anneal-ms16ecxd` line=ln-692c4ffb recipe=rc-5edb9dc3 DCW=7 DAQ=12
- 驱动实测:—
- Channel:channel=4b38b0e6-0090-44bf-af87-71c67691235e toolAgent=401e8464-85a8-4af8-aa49-f2f46b5ea19d task=528b19b0-3288-4f25-90c5-291991ec8730 终态=COMPLETED

### biax · 双拉(BOPET)薄膜产线多节点闭环
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"]}
- 终验:{"devices":9,"expectDevices":9,"signals":49,"sp":30,"pv":19,"descMissing":0,"protocols":["opcua","modbus-tcp","modbus-rtu","mqtt","http"]}
- 平台侧:复用既有产线 `双拉(BOPET)薄膜产线多节点闭环 biax-ms16ecxd` line=ln-227fb62f recipe=rc-8bfd3d69 DCW=30 DAQ=19
- 驱动实测:—
- Channel:channel=266b6a4b-7a12-4375-a8cc-1afd0ac14410 toolAgent=c1bca305-f3e9-45a3-bc92-d2a15050fd0f task=5bfbe067-c722-4def-a8c1-6b54c544b3bb 终态=COMPLETED

## 2. 闭环优化过程(全轨迹)

### injection · 注塑成型质量窗口寻优

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 31.27 g | — |

- baseline 克重=31.27g(目标 32.5±0.35)
- iter1: hold-pressure-sp 写被拒 → 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-9529b):scen-injection:dcw:hold-pressure-sp→57.99bar 被拒(节点「scen-injection:dcw:hold-pressure-sp」正在优化试验中(opt-37c5e577,)。假设:inj iter1: 克重 31.27g 
- iter2: hold-pressure-sp 写被拒 → 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-c949a):scen-injection:dcw:hold-pressure-sp→57.99bar 被拒(节点「scen-injection:dcw:hold-pressure-sp」正在优化试验中(opt-37c5e577,)。假设:inj iter2: 克重 31.27g 
- iter3: hold-pressure-sp 写被拒 → 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-b76bc):scen-injection:dcw:hold-pressure-sp→57.99bar 被拒(节点「scen-injection:dcw:hold-pressure-sp」正在优化试验中(opt-37c5e577,)。假设:inj iter3: 克重 31.27g 
- iter4: hold-pressure-sp 写被拒 → 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-37254):scen-injection:dcw:hold-pressure-sp→57.99bar 被拒(节点「scen-injection:dcw:hold-pressure-sp」正在优化试验中(opt-37c5e577,)。假设:inj iter4: 克重 31.27g 
- iter5: hold-pressure-sp 写被拒 → 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-36e9e):scen-injection:dcw:hold-pressure-sp→57.99bar 被拒(节点「scen-injection:dcw:hold-pressure-sp」正在优化试验中(opt-37c5e577,)。假设:inj iter5: 克重 31.27g 
- iter6: hold-pressure-sp 写被拒 → 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-3ce4c):scen-injection:dcw:hold-pressure-sp→57.99bar 被拒(节点「scen-injection:dcw:hold-pressure-sp」正在优化试验中(opt-37c5e577,)。假设:inj iter6: 克重 31.27g 
- iter7: hold-pressure-sp 写被拒 → 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-44efc):scen-injection:dcw:hold-pressure-sp→57.99bar 被拒(节点「scen-injection:dcw:hold-pressure-sp」正在优化试验中(opt-37c5e577,)。假设:inj iter7: 克重 31.27g 
- iter8: hold-pressure-sp 写被拒 → 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-fabbf):scen-injection:dcw:hold-pressure-sp→57.99bar 被拒(节点「scen-injection:dcw:hold-pressure-sp」正在优化试验中(opt-37c5e577,)。假设:inj iter8: 克重 31.27g 
- outcome: writes=0 final=31.27g attained=false guards={"飞边率":0.0184,"缩痕指数":2.1488}
- 守卫终值:飞边率=0.02 · 缩痕指数=2.15

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.22 mg/L | — |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.54 mg/L | yes |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.46 mg/L | yes |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.41 mg/L | yes |

- baseline DO=0.22 COD=360 NH3=34.5 TP=0.65 pH=6.59 → 不达标
- iter1(曝气): 风机 26→30.05 ✘ 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-68f79):scen-wwtp:dcw:blower-hz-sp→30.05Hz 被拒(节点「scen-wwtp:dcw:blower-hz-sp」正在优化试验中(opt-f01ff24e,由 cb9e8df)。假设:wwtp iter1(blower): DO 0.22 校正,
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标未确认:{"出水COD":359.84,"出水氨氮":34.518,"出水总磷":0.42000000000000004,"出水pH":6.5680000000000005,"出水浊度":4.4719999999999995,"DO":0.22800000000000004}
- recover: 风机 26→27.5 ✘ 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-67dd7):scen-wwtp:dcw:blower-hz-sp→27.5Hz 被拒(节点「scen-wwtp:dcw:blower-hz-sp」正在优化试验中(opt-f01ff24e,由 cb9e8df)。假设:wwtp iter15(recover): 终态非达标(COD 
- outcome: writes=3 DO=0.21 compliant=false cost —→106.3(省 —) attained=false
- **成本曲线**:首个达标运行成本 ≈— → 终态 ≈106.3(降 —,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=359.92 · 出水氨氮=34.52 · 出水总磷=0.42 · 出水pH=6.57 · 出水浊度=4.47 · DO=0.21

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.92 HV | — |
| 2 | converge | zone2-sp | 710 → 850 | 104.36 HV | yes |

- baseline 硬度=134.9HV 抗拉=310MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✘ 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-3c5c5):scen-anneal:dcw:zone3-sp→850℃ 被拒(节点「scen-anneal:dcw:zone3-sp」正在优化试验中(opt-683e4891,由 9ad73783-)。假设:anneal iter1: 硬度 134.9HV 偏硬(欠退火),zon
- iter2: zone2-sp 710→850 ✔
- iter3: zone3-sp 730→788 ✘ 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-4df5b):scen-anneal:dcw:zone3-sp→788℃ 被拒(节点「scen-anneal:dcw:zone3-sp」正在优化试验中(opt-683e4891,由 9ad73783-)。假设:anneal iter3: 硬度 104.4HV 偏硬(欠退火),zon
- iter4: zone2-sp 校正量过小(850)
- iter5: zone3-sp 730→788 ✘ 试验下发 ACK 鉴定未全绿(证实 0/1,未证实 0,失败 1,批次 rr-dfac8):scen-anneal:dcw:zone3-sp→788℃ 被拒(节点「scen-anneal:dcw:zone3-sp」正在优化试验中(opt-683e4891,由 9ad73783-)。假设:anneal iter5: 硬度 104.4HV 偏硬(欠退火),zon
- outcome: writes=1 final=104.4HV attained=false(窗内+产能≥5%)
- **产能曲线**:线速 140 → — m/min(+—%,质量窗触边自动回退)
- 守卫终值:抗拉强度=298.16 · 表面缺陷率=0.13

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 27.99 μm | — |

- 1. task board: channel=91ed2d31-8377-41c4-a609-332df6e7429c parent=d72bf560-384c-4490-9359-86ec127a5603 leadChild=3150291d-c981-4936-8d36-1dec0313e60b
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[27.95,3.5,1.6]
- 3. initial thickness=27.99 μm(目标 25±0.7)
- iter1: cast-spd-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter2: fast-roll-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter3: rail-out-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter4: cast-spd-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter5: fast-roll-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- iter6: rail-out-sp 试验被拒 → optimization_explore 仅适用于工艺优化 Channel(当前 profile=legacy)。
- 4. journal(铸速节点)归因 Agent: ✘ · 无权查询节点 dw-86e462ea 的账本(仅可查你绑定范围内的对象:rc-8bfd3d69, dn-0d001c2b, dn-bcc52689, dn-4d3b91d9, dn-e8be4f60, dn-c9bd3338, dn-f19
- 5. outcome: writes=0 distinctKnobs=0 final=27.99μm attained=false
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


# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20261027043152-u80` · 2026-10-27T04:35:57.529Z · wall 168.2s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3600 · simulator=http://127.0.0.1:4010 · toolHarness=opencode · git=5c6d081a · harness=4b4b543bc1153de2

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✔ | 3 | 4 | 39.68 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✔ | 11 | 12 | 165.13 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✔ | 6 | 7 | 95.61 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✘ | 6 | 6 | 87.31 |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:新建产线 `注塑成型质量窗口寻优 injection-ms16wrgc` line=ln-b9e3ac64 recipe=rc-a959fedf DCW=11 DAQ=14
- 驱动实测:inj-machine-mbtcp/机筒温度区1SP ✔ · inj-mold-rtu/模具温度SP ✔ · inj-inject-opcua/InjectSpeedSP ✔ · inj-cool-mqtt/WaterTempPV ✔ · inj-inspect-http/PartWeight ✔
- Channel:channel=488f26bd-8c15-40af-bcd5-998299a6561e toolAgent=3d4e6c12-dc54-495a-aa53-341e0c188c18 task=83aeff1e-bdf3-4c3f-a13a-fefd9c07b391 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `A2O 污水生化处理达标降耗 wwtp-ms16wrgc` line=ln-f3a0b528 recipe=rc-f617d953 DCW=7 DAQ=13
- 驱动实测:wwtp-blower-mbtcp/风机频率SP ✔ · wwtp-dosing-opcua/NaohDoseSP ✔ · wwtp-return-rtu/内回流比SP ✔ · wwtp-influent-mqtt/CodIn ✔ · wwtp-effluent-http/CodOut ✔
- Channel:channel=2fffc827-0f4d-491e-a66d-fb733aa30e6f toolAgent=4344ccd6-b64e-489d-81ab-45436adbfa8a task=04864c77-8d0f-4923-b60f-b9cabdff3b43 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `连续退火质量窗内产能最大化 anneal-ms16wrgc` line=ln-ed652acc recipe=rc-ac4f95e9 DCW=7 DAQ=12
- 驱动实测:anneal-heating-mbtcp/均热区1炉温SP ✔ · anneal-line-opcua/LineSpeedSP ✔ · anneal-cool-rtu/过时效温度SP ✔ · anneal-gas-mqtt/DewPoint ✔ · anneal-inspect-http/Hardness ✔
- Channel:channel=f37975e2-e3b1-4f36-b90d-9f7898cd8970 toolAgent=9b3a5480-2fbe-4407-9c5d-5a2915c577f9 task=94dc62e5-dc68-476f-8f74-6102c8a6d123 终态=COMPLETED

### biax · 双拉(BOPET)薄膜产线多节点闭环
- 模拟器侧:{"missing":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"drifted":[],"created":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":9,"expectDevices":9,"signals":49,"sp":30,"pv":19,"descMissing":0,"protocols":["opcua","modbus-tcp","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `双拉(BOPET)薄膜产线多节点闭环 biax-ms16wrgc` line=ln-c3efa10c recipe=rc-f1e51325 DCW=30 DAQ=19
- 驱动实测:biax-dryer-opcua/干燥温度SP ✔ · biax-extruder-mbtcp/机筒温度区1SP ✔ · biax-pump-rtu/计量泵转速SP ✔ · biax-casting-mbtcp/模唇温度SP ✔ · biax-mdo-mbtcp/预热辊1温度SP ✔ · biax-tdo-opcua/TDO预热段SP ✔ · biax-gauge-mqtt/biaxThick ✔ · biax-inspect-http/coronaPower ✔ · biax-winder-mbtcp/收卷张力SP ✔
- Channel:channel=3087ba6f-a455-4586-bfb6-f4dbf8e304aa toolAgent=142830f4-fc28-4c67-80c9-ed20fb20af4b task=294b547f-d6c1-40f5-a23c-e6e68eb01730 终态=COMPLETED

## 2. 闭环优化过程(全轨迹)

### injection · 注塑成型质量窗口寻优

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 31.27 g | — |
| 1 | converge | hold-pressure-sp | 45 → 58.01 | 31.95 g | yes |
| 2 | converge | hold-time-sp | 6 → 10.37 | 32.13 g | yes |
| 3 | converge | hold-pressure-sp | 58 → 61.88 | 32.18 g | yes |

- baseline 克重=31.27g(目标 32.5±0.35)
- iter1: hold-pressure-sp 45→58.01 ✔ batch=yes · 克重→31.95g
- iter2: hold-time-sp 6→10.37 ✔ batch=yes · 克重→32.13g
- iter3: hold-pressure-sp 58→61.88 ✔ batch=yes · 克重→32.18g
- outcome: writes=3 final=32.18g attained=true guards={"飞边率":0.0004,"缩痕指数":1.0104}
- 守卫终值:飞边率=0.00 · 缩痕指数=1.01

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.21 mg/L | — |
| 1 | blower | blower-hz-sp | 26 → 30.06 | 1.40 mg/L | yes |
| 2 | blower | blower-hz-sp | 30.100000381469727 → 32.67 | 2.59 mg/L | yes |
| 3 | blower | blower-hz-sp | 32.70000076293945 → 33.74 | 2.68 mg/L | yes |
| 4 | blower | blower-hz-sp | 33.70000076293945 → 34.61 | 3.14 mg/L | yes |
| 5 | blower | blower-hz-sp | 34.599998474121094 → 35.4 | 3.44 mg/L | yes |
| 5 | ph | naoh-dose-sp | 12 → 30.75 | 6.69 mg/L | yes |
| 8 | tp | pac-dose-sp | 30 → 45 | 0.54 mg/L | yes |
| 9 | tp | pac-dose-sp | 45 → 60 | 0.46 mg/L | yes |
| 10 | tp | pac-dose-sp | 60 → 75 | 0.46 mg/L | yes |

- baseline DO=0.21 COD=360 NH3=34.5 TP=0.67 pH=6.57 → 不达标
- iter1(曝气): 风机 26→30.06 ✔
- iter2(曝气): 风机 30.100000381469727→32.67 ✔
- iter3(曝气): 风机 32.70000076293945→33.74 ✔
- iter4(曝气): 风机 33.70000076293945→34.61 ✔
- iter5(曝气): 风机 34.599998474121094→35.4 ✔
- iter5(中和): NaOH 12→30.75 ✔
- iter8(除磷): PAC 30→45 ✔
- iter9(除磷): PAC 45→60 ✔
- iter10(除磷): PAC 60→75 ✔
- 达标确认 ✔ 首个达标运行成本 ≈196.8(风机 35.400001525878906/NaOH 31/PAC 75)
- iter11(降耗): 风机 35.400001525878906→34.2 ✔ 带裕度复测达标,保留
- iter11(降耗): NaOH 31→27 ✔ 带裕度复测达标,保留
- outcome: writes=11 DO=3.83 compliant=true cost 196.8→182.4(省 14.39) attained=true
- **成本曲线**:首个达标运行成本 ≈196.8 → 终态 ≈182.4(降 14.4,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=36.38 · 出水氨氮=1.95 · 出水总磷=0.42 · 出水pH=6.63 · 出水浊度=0.66 · DO=3.83

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 135.08 HV | — |
| 1 | converge | zone3-sp | 730 → 850 | 134.68 HV | yes |
| 2 | converge | zone2-sp | 710 → 850 | 97.82 HV | yes |
| 6 | throughput | line-speed-sp | 140 → 152 | 97.52 HV | yes |
| 7 | throughput | line-speed-sp | 152 → 164 | 97.54 HV | yes |
| 8 | throughput | line-speed-sp | 164 → 176 | 97.84 HV | yes |
| 9 | throughput | line-speed-sp | 176 → 188 | 97.06 HV | yes |

- baseline 硬度=135.1HV 抗拉=311MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✔
- iter2: zone2-sp 710→850 ✔
- iter6(产能): 线速 140→152 ✔ 硬度 97.5HV 留裕度窗内
- iter7(产能): 线速 152→164 ✔ 硬度 97.5HV 留裕度窗内
- iter8(产能): 线速 164→176 ✔ 硬度 97.8HV 留裕度窗内
- iter9(产能): 线速 176→188 ✔ 硬度 97.1HV 留裕度窗内
- 产能推进: 线速 140→188(+34.29%),pushed=4
- outcome: writes=6 final=97.8HV attained=true(窗内+产能≥5%)
- **产能曲线**:线速 140 → 188 m/min(+34.3%,质量窗触边自动回退)
- 守卫终值:抗拉强度=295.66 · 表面缺陷率=0.15

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 试验批次 |
|---|---|---|---|---|---|
| 0 | baseline | — | — | 28.00 μm | — |
| 1 | converge | cast-spd-sp | 32 → 33.7 | 28.00 μm | yes |
| 2 | converge | fast-roll-sp | 118 → 122.4 | 28.00 μm | yes |
| 3 | converge | rail-out-sp | 3000 → 3096 | 28.00 μm | yes |
| 4 | converge | cast-spd-sp | 33.70000076293945 → 35.5 | 28.00 μm | yes |
| 5 | converge | fast-roll-sp | 122.4000015258789 → 127 | 27.98 μm | yes |
| 6 | converge | rail-out-sp | 3096 → 3195 | 27.93 μm | yes |

- 1. task board: channel=a30c1b3a-5d68-42c7-a52d-31a3d652dd5a parent=82684f07-024b-4dc1-bed9-dc6f8f3e68d7 leadChild=76601da4-8dda-4237-93bd-b14fa93027fd
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[27.99,3.5,1.6]
- 3. initial thickness=28.00 μm(目标 25±0.7)
- iter1: cast-spd-sp 32→33.7 ✔ batch=rr-1b31b… · thickness→28.00μm · 复测待判读
-         meltTemp=291.4℃(安全窗 268~300)
- iter2: fast-roll-sp 118→122.4 ✔ batch=rr-b8483… · thickness→28.00μm · 复测待判读
-         meltTemp=291.4℃(安全窗 268~300)
- iter3: rail-out-sp 3000→3096 ✔ batch=rr-bb79c… · thickness→28.00μm · 复测待判读
-         meltTemp=291.4℃(安全窗 268~300)
- iter4: cast-spd-sp 33.70000076293945→35.5 ✔ batch=rr-37303… · thickness→28.00μm · 复测待判读
-         meltTemp=291.4℃(安全窗 268~300)
- iter5: fast-roll-sp 122.4000015258789→127 ✔ batch=rr-153f1… · thickness→27.98μm · 复测待判读
-         meltTemp=291.6℃(安全窗 268~300)
- iter6: rail-out-sp 3096→3195 ✔ batch=rr-28471… · thickness→27.93μm · 复测待判读
-         meltTemp=291.4℃(安全窗 268~300)
- 4. journal(铸速节点)归因 Agent: ✘ · 无权查询节点 dw-5d2003fe 的账本(仅可查你绑定范围内的对象:rc-f1e51325, dn-690e5dba, dn-6a8ddd7c, dn-f9060a25, dn-44e4b4af, dn-05942d5e, dn-e08
- 5. outcome: writes=6 distinctKnobs=3 final=27.93μm attained=false
- 6. task terminal=COMPLETED

## 3. 诚实边界
- 全部写路径经平台治理(绑定配方上的 recipe_trial 整批试验下发,复测判读,不写配方版本);策略为确定性脚本(不经 LLM),与真实 LLM 变体共用同一工具面与治理链路。
- 物理数据由模拟器多引擎(cast-film/biax/injection/wwtp/anneal)产出,同 seed 确定性;J/W* 与真实产线存在仿真层级边界。
- 平台侧产线为「复用优先」:本报告如显示 reused,说明前次接入仍在,本次零重复建线(设计语义)。

## 4. 复现

```bash
NO_PROXY=127.0.0.1,localhost \
AW_BASE=http://127.0.0.1:3600 SIM_BASE=http://127.0.0.1:4010 \
  node bench/scenarios.mjs --seed 42 --tool-harness opencode
```


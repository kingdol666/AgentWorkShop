# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20261026033108-8c4` · 2026-10-26T03:32:17.376Z · wall 60.2s · 并行 4 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3001 · simulator=http://127.0.0.1:4010 · toolHarness=opencode · git=44221f6c · harness=fbe52608c7b86c35

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✘ | 0 | 8 | 14.63 |
| wwtp(A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。… | 好氧池溶解氧 | 3.4±0.6mg/L | ✘ | 0 | 3 | 14.97 |
| anneal(连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏… | 维氏硬度 | 95±6HV | ✘ | 0 | 5 | 14.44 |
| biax(双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭… | 成品膜厚 | 25±0.7μm | ✘ | 0 | 0 | 17.49 |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":[],"drifted":[],"created":[],"repaired":[],"started":[],"untouched":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:新建产线 `注塑成型质量窗口寻优 injection-ms169cef` line=ln-2d69be73 recipe=rc-6fe66b31 DCW=11 DAQ=14
- 驱动实测:inj-machine-mbtcp/机筒温度区1SP ✔ · inj-mold-rtu/模具温度SP ✔ · inj-inject-opcua/InjectSpeedSP ✔ · inj-cool-mqtt/WaterTempPV ✔ · inj-inspect-http/PartWeight ✔
- Channel:channel=74ca3f93-6ea4-48fd-9293-7c58b62ca085 toolAgent=89cadcdd-fa7f-48d2-936f-b2530e4bc8b3 task=0c864c42-1a54-484b-a08d-795a334b6f29 终态=COMPLETED

### wwtp · A2O 污水生化处理达标降耗
- 模拟器侧:{"missing":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"drifted":[],"created":["wwtp-blower-mbtcp","wwtp-dosing-opcua","wwtp-return-rtu","wwtp-influent-mqtt","wwtp-effluent-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":20,"sp":7,"pv":13,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `A2O 污水生化处理达标降耗 wwtp-ms169cef` line=ln-ffdf2a0a recipe=rc-df22628d DCW=7 DAQ=13
- 驱动实测:wwtp-blower-mbtcp/风机频率SP ✔ · wwtp-dosing-opcua/NaohDoseSP ✔ · wwtp-return-rtu/内回流比SP ✔ · wwtp-influent-mqtt/CodIn ✔ · wwtp-effluent-http/CodOut ✔
- Channel:channel=602b9d75-fe79-4023-9558-65bef26ff2b5 toolAgent=051701fa-f001-45cd-91a4-d9fa32708bfa task=83b65539-b806-4aca-a6a5-2d3baa2c5373 终态=COMPLETED

### anneal · 连续退火质量窗内产能最大化
- 模拟器侧:{"missing":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"drifted":[],"created":["anneal-heating-mbtcp","anneal-line-opcua","anneal-cool-rtu","anneal-gas-mqtt","anneal-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":19,"sp":7,"pv":12,"descMissing":0,"protocols":["modbus-tcp","opcua","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `连续退火质量窗内产能最大化 anneal-ms169cef` line=ln-f6c8820e recipe=rc-5a549d2a DCW=7 DAQ=12
- 驱动实测:anneal-heating-mbtcp/均热区1炉温SP ✔ · anneal-line-opcua/LineSpeedSP ✔ · anneal-cool-rtu/过时效温度SP ✔ · anneal-gas-mqtt/DewPoint ✔ · anneal-inspect-http/Hardness ✔
- Channel:channel=788b802a-205e-45f5-96a8-be8c0c06c898 toolAgent=1e18b362-5982-4c52-a58b-fcc5b92599de task=282d2dce-4448-4a06-af85-fd1adb01b978 终态=COMPLETED

### biax · 双拉(BOPET)薄膜产线多节点闭环
- 模拟器侧:{"missing":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"drifted":[],"created":["biax-dryer-opcua","biax-extruder-mbtcp","biax-pump-rtu","biax-casting-mbtcp","biax-mdo-mbtcp","biax-tdo-opcua","biax-gauge-mqtt","biax-inspect-http","biax-winder-mbtcp"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":9,"expectDevices":9,"signals":49,"sp":30,"pv":19,"descMissing":0,"protocols":["opcua","modbus-tcp","modbus-rtu","mqtt","http"]}
- 平台侧:新建产线 `双拉(BOPET)薄膜产线多节点闭环 biax-ms169cef` line=ln-dfac0791 recipe=rc-ef3566a3 DCW=30 DAQ=19
- 驱动实测:biax-dryer-opcua/干燥温度SP ✔ · biax-extruder-mbtcp/机筒温度区1SP ✔ · biax-pump-rtu/计量泵转速SP ✔ · biax-casting-mbtcp/模唇温度SP ✔ · biax-mdo-mbtcp/预热辊1温度SP ✔ · biax-tdo-opcua/TDO预热段SP ✔ · biax-gauge-mqtt/biaxThick ✔ · biax-inspect-http/coronaPower ✔ · biax-winder-mbtcp/收卷张力SP ✔
- Channel:channel=573dce56-4aa0-42df-b40f-0d708a4e3242 toolAgent=d7670e7a-02da-4738-887e-d64d5c8d9559 task=72bda950-bb9d-4999-97fe-255533af8901 终态=COMPLETED

## 2. 闭环优化过程(全轨迹)

### injection · 注塑成型质量窗口寻优

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 31.58 g | — |  |

- baseline 克重=31.58g(目标 32.5±0.35)
- iter1: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter2: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter3: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter4: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter5: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter6: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter7: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter8: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- outcome: writes=0 final=31.58g attained=false guards={"飞边率":0.013800000000000002,"缩痕指数":1.8314}
- 守卫终值:飞边率=0.01 · 缩痕指数=1.83

### wwtp · A2O 污水生化处理达标降耗

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 0.23 mg/L | — |  |

- baseline DO=0.23 COD=360 NH3=34.5 TP=0.66 pH=6.60 → 不达标
- iter1(曝气): 风机 26→30.04 ✘ 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter8(除磷): PAC 30→45 ✘ 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- 达标未确认:{"出水COD":359.73999999999995,"出水氨氮":34.468,"出水总磷":0.6612,"出水pH":6.595999999999999,"出水浊度":4.348000000000001,"DO":0.22599999999999998}
- recover(TP): PAC 30→45 ✘ 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- recover: 风机 26→27.5 ✘ 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- outcome: writes=0 DO=0.23 compliant=false cost —→86.0(省 —) attained=false
- **成本曲线**:首个达标运行成本 ≈— → 终态 ≈86.0(降 —,在排放达标约束内「脱气退药」)
- 守卫终值:出水COD=359.74 · 出水氨氮=34.47 · 出水总磷=0.66 · 出水pH=6.60 · 出水浊度=4.35 · DO=0.23

### anneal · 连续退火质量窗内产能最大化

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 134.96 HV | — |  |

- baseline 硬度=135.0HV 抗拉=310MPa 线速=140m/min → 窗外
- iter1: zone3-sp 730→850 ✘ 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter2: zone2-sp 710→850 ✘ 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter3: zone3-sp 730→850 ✘ 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter4: zone2-sp 710→850 ✘ 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter5: zone3-sp 730→850 ✘ 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- outcome: writes=0 final=135.0HV attained=false(窗内+产能≥5%)
- **产能曲线**:线速 140 → — m/min(+—%,质量窗触边自动回退)
- 守卫终值:抗拉强度=310.24 · 表面缺陷率=0.14

### biax · 双拉(BOPET)薄膜产线多节点闭环

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 27.98 μm | — |  |

- 1. task board: channel=891b4d81-fb41-447a-8ae4-8adb5e3f5e17 parent=e398a725-71e0-4a6f-89c0-6f396a3dcae1 leadChild=fd6127f4-bb74-49fd-9c48-0c16b521b508
- 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[27.99,3.5,1.6]
- 3. initial thickness=27.98 μm(目标 25±0.7)
- iter1: cast-spd-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/
- iter2: fast-roll-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/
- iter3: rail-out-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/
- iter4: cast-spd-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/
- iter5: fast-roll-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/
- iter6: rail-out-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/
- 4. journal(铸速节点)归因 Agent: ✘ · 工具调用被拒(引用校验,dcw_journal):node_id = 「dw-5850b78a」不在你的授权范围内(节点「scen-biax:dcw:cast-spd-sp」,归属产线 ln-dfac0791)。
该节点不在你的绑定范围内。
- 5. outcome: writes=0 distinctKnobs=0 final=27.98μm attained=false
- 6. task terminal=COMPLETED

## 3. 诚实边界
- 全部写路径经平台治理(dcw_control 自动开优化记录 + dcw_judge 判定收口);策略为确定性脚本(不经 LLM),与真实 LLM 变体共用同一工具面与治理链路。
- 物理数据由模拟器多引擎(cast-film/biax/injection/wwtp/anneal)产出,同 seed 确定性;J/W* 与真实产线存在仿真层级边界。
- 平台侧产线为「复用优先」:本报告如显示 reused,说明前次接入仍在,本次零重复建线(设计语义)。

## 4. 复现

```bash
NO_PROXY=127.0.0.1,localhost \
AW_BASE=http://127.0.0.1:3001 SIM_BASE=http://127.0.0.1:4010 \
  node bench/scenarios.mjs --seed 42 --tool-harness opencode
```


# AW-IndustrialBench · 多场景并行闭环优化基准报告

> **判定:FAIL** · run `20261023151709-1pjk` · 2026-10-23T15:17:31.448Z · wall 21.4s · 并行 1 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)
> platform=http://127.0.0.1:3111 · simulator=http://127.0.0.1:4050 · toolHarness=opencode · git=7c8f4e7a · harness=fbe52608c7b86c35

被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):

| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |
|---|---|---|---|---|---|---|---|
| injection(注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 m… | 制品克重 | 32.5±0.35g | ✘ | 0 | 8 | 18.43 |

## 1. 接入过程(差分 ensure → 平台建线,幂等)

### injection · 注塑成型质量窗口寻优
- 模拟器侧:{"missing":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"drifted":[],"created":["inj-machine-mbtcp","inj-mold-rtu","inj-inject-opcua","inj-cool-mqtt","inj-inspect-http"],"repaired":[],"started":[],"untouched":[]}
- 终验:{"devices":5,"expectDevices":5,"signals":25,"sp":11,"pv":14,"descMissing":0,"protocols":["modbus-tcp","modbus-rtu","opcua","mqtt","http"]}
- 平台侧:新建产线 `注塑成型质量窗口寻优 injection-ms165k33` line=ln-4acdb2c8 recipe=rc-252ed08e DCW=11 DAQ=14
- 驱动实测:inj-machine-mbtcp/机筒温度区1SP ✔ · inj-mold-rtu/模具温度SP ✔ · inj-inject-opcua/InjectSpeedSP ✔ · inj-cool-mqtt/WaterTempPV ✔ · inj-inspect-http/PartWeight ✔
- Channel:channel=2acd7c21-7dd1-40aa-99b2-3c8bd6d497b8 toolAgent=0cb402d9-b8de-427a-b182-a2563dacbe29 task=52537c95-5322-4c2b-a327-3a10a4eb2050 终态=COMPLETED

## 2. 闭环优化过程(全轨迹)

### injection · 注塑成型质量窗口寻优

| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |
|---|---|---|---|---|---|---|
| 0 | baseline | — | — | 31.25 g | — |  |

- baseline 克重=31.25g(目标 32.5±0.35)
- iter1: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter2: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter3: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter4: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter5: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter6: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter7: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- iter8: hold-pressure-sp 写被拒 → 直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验
- outcome: writes=0 final=31.25g attained=false guards={"飞边率":0.0102,"缩痕指数":2.0904}
- 守卫终值:飞边率=0.01 · 缩痕指数=2.09

## 3. 诚实边界
- 全部写路径经平台治理(dcw_control 自动开优化记录 + dcw_judge 判定收口);策略为确定性脚本(不经 LLM),与真实 LLM 变体共用同一工具面与治理链路。
- 物理数据由模拟器多引擎(cast-film/biax/injection/wwtp/anneal)产出,同 seed 确定性;J/W* 与真实产线存在仿真层级边界。
- 平台侧产线为「复用优先」:本报告如显示 reused,说明前次接入仍在,本次零重复建线(设计语义)。

## 4. 复现

```bash
NO_PROXY=127.0.0.1,localhost \
AW_BASE=http://127.0.0.1:3111 SIM_BASE=http://127.0.0.1:4050 \
  node bench/scenarios.mjs --seed 42 --tool-harness opencode
```


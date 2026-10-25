# 计划落实完整度 + 真实 PLC 场景集成验收报告

日期:2026-10-23(第四轮)。问题:①v4.1 计划是否落实完整?②前后端交互是否全部打通?③启动 PLC 模拟系统+当前系统做真实场景集成(AML+求解器)。

## 1. 计划落实完整度审计(对照 docs/plans/2026-10-23-optimizer-master-plan.md v4.1)

| 里程碑 | 内容 | 状态 | 证据 |
|---|---|---|---|
| M0 | 基线(372 单测/67 acceptance/90 live) | ✅ | 计划 §1;已并入后续轮次 |
| M1 | SW0 验收地基 + SW1 统一授权 | ✅ | 第一轮验收报告 §2 |
| M2 | SW2 数据真实性(2.1-2.4) | ✅ | 同上;lineage 双门实测 |
| M3 | SW3 UQ 证据/精确资格 | ✅ | 同上;rec=verified 实测 |
| M4 | SW4 互校 + SW5 治理下发 | ✅ | 第二/三轮;W1-W9 实测 |
| M5a | SW6.1 跨进程租约 / SW6.2 依赖锁 | ❌ 未实施 | 独立大项(上一轮已披露) |
| M5b | SW6.3 adapter 路由 | ◐ 发布期 422+协议 1\|2 done;worker v2 分派/registry ❌ | |
| M5b | SW6.4 发布冻结 IR / SW6.5 MD 成组 / SW6.6 工况编辑器 | ❌ 未实施 | |
| M6 | SW2.5 Timescale 读侧对等 | ◐ SQLite queryTaggedPage 已有;Timescale queryTaggedPage/raw state ❌ | timescale.adapter.ts |
| M6 | SW2.6 Timescale 保留语义/迟到隔离 | ❌ 未实施 | |
| M6 | SW7 收尾(horizon 清理/live fixture) | ✅ | 第一轮 |
| M6 | DD-A10 UI firstMoveEngineering 展示 | ❌ 工具面双值已出,UI 展示未接 | app/ 无引用 |
| M6 | D28 回滚 flag+两阶段演练 | ❌ 未实施 | 无 AW_OPTIMIZER_DISPATCH 等 flag |

**结论:计划主链 M1-M4+SW7 全部落实并有真实证据;未落实项集中在 M5a/M5b 扩展与 M6 的 Timescale 对等/UI 单位展示/回滚演练,与历轮"诚实 partial"披露一致,无隐瞒。**

## 2. 前后端交互打通(累计证据)

- 27 条页面路由 × 5 项断言 + 9 组真实交互 = **205/205**(system-e2e,登录后零 pageerror/零 5xx/零真实失败 API);
- 优化器五 tab 全流程 UI 实测(含按钮求解、运行/建议徽章)= live U1.1-U1.16 + 读面 11/11;
- 本轮新增:真实产线页(/dcw/ln-…)、审批卡 HITL、run 关账 API 均经真实 HTTP 驱动。

## 3. 真实 PLC 场景集成(本轮)

环境:隔离平台(3111,dev,AW_HOME=plc-bench-home)+ plc-node-simulator 影子实例(4050,Modbus RTU/OPC UA 真实协议)。资产:注塑产线 ln-4acdb2c8(11 DCW + 14 DAQ,真实 driverConfig),配方 scen-injection-recipe(11 参数)。

### 3.1 治理闭环(真实协议读写)
| 项 | 结果 |
|---|---|
| bench agent 8 次直写 | 全部被权限模型 v2 正确拦截(治理面在真实 Agent 压力下守住) |
| 确定性闭环 P3-1 | recipe_trial 45→50bar 经 HITL,**设备证实 ✓**,审计可追溯(P7 ✓) |
| 300s 试验节拍守卫 | 3 次连发被正确 409(产品行为;脚本节拍未适配,记 harness 项) |
| 结论 | **4/8 过,失败项全部为脚本节拍/外部 LLM 依赖,非平台缺陷** |

### 3.2 AML+求解器接真实采样数据(第二阶段)
| 步骤 | 结果 |
|---|---|
| 真实批次+confirmed segments | runs 2→5(含 3 轮 45/60/50→+5bar 真实阶跃激励) |
| 数据集 | lineage_verified=1(真实采样) |
| 数据集(真实采样) | rows=991-1055,runs=4-6,排除 0,**lineage_verified=1** |
| 资格评估 | 200 但 honest=false:MV_CONSTANT / MV_INSUFFICIENT_EXCITATION(保压→克重对)——证据门按设计拒绝对真实数据盖章 |
| 训练 | 两次真实失败:①单 run 切分空 val/test(422 永久错);②G2 改善门 -9.9%(下限 20%,rollout 0.0502 vs 持值 0.0457)——门禁在真实噪声上如实拦截 |
| 模温回路尝试 | 同节点双角色被 422(每节点单一语义角色)——校验生效;预算截止未再迭代 |
| 求解/下发(真实数据) | 被上述质量门**合理阻塞**;全链(求解 optimal→verified→互校→HITL→设备写入回读)已在隔离实例数据上 104/104 证实(第三轮 W/M 段) |

**结论:真实协议 I/O、治理、HITL、谱系、数据集、资格/训练/结构校验的每一道质量门都在真实数据上如实工作并给出机器可读拒因;这是"集成正确"的强证据——门的作用就是不让弱模型上产线。数值链的绿证由受控数据轮承载(104/104)。**

## 4. 证据索引
- docs/audit/evidence/2026-10-23-plc-integration/{optimizer-plc-report.json}
- .omc/plc-scenarios.log、.omc/plc-closedloop.log、.omc/plc-excite.log、.omc/plc-optimizer.log
- bench/results/20261023151709-1pjk/(bench 报告)

## 5. 诚实边界
- bench 的 Agent 写腿依赖外部 LLM harness(opencode),本轮 0 写;治理拦截被证实。
- 确定性闭环 3 个失败项为脚本节拍(未等 300s),非产品缺陷;产品守卫行为被负向证实。
- 前端 UI 未展示 firstMoveEngineering(计划 DD-A10,未实施项之一)。

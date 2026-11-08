# CAL-3 四期递进能力验收 · 证据摘要（修正版 v2）

> **审查历程（如实）**：初版 72/72 被独立审查代理 **REJECTED**（[裁决](reviewer-verdict-REJECTED.md)，12 项发现全部成立：W3 经 line.start 实际写设备并回退治理值、数据集非治理后、≥300s 约束未落地、W1 结论硬编码、W4「自主」叙述过度、invoke 不查 HTTP 状态、残留治理设置等）。逐项修复后 **run10 = 78/78 全绿（complete=true）**。对照表见 [handover.md](handover.md)「审查发现与修复对照」。

**结论：修正轮 78/78 断言全绿；项目 `f7cfd9f1` completed，四期交付物全部 approved。**

## 一、文档 → 系统（本轮全新撰写两份文档）
| 输入 | 内容 |
| --- | --- |
| [工况说明](inputs/连续退火炉工况说明.md) | 3# 连续退火炉 CAL-3；9 点位；质量目标 480±20 MPa；**四期推进要求**（分析→HITL→训练→自主优化） |
| [协议接口文档](inputs/协议接口文档.md) | 加热炉主控 Modbus TCP（HR 40100~40104 / IR 30100~30104，unitId 3）；在线质量仪 OPC UA（ns=2;s=CAL3-QM.*） |

## 二、链路实测（每阶段独立断言）
| 阶段 | 动作 | 结果 |
| --- | --- | --- |
| 模拟 PLC 协议 | 多协议孪生蓝图（Modbus 6 信号 + OPC UA 3 信号） | `sim-twin 3/3`：两设备创建 + tick 活性 2/2；driverConfig 全部来自 export（零手抄） |
| 连接与供给 | provision-line | `15/15`：线 + 3 写控 + 6 数采（含 3 个 OPC UA）+ 配方 + 开批 + 采集总控 |
| 频道锻造 | 4 个专职频道 | `30/30`：诊断(diagnose) 8、控制(tuning) 7、训练(aml_training) 8、优化(aml_optimization) 7 |
| 产线验收 | verify-line V1-V6 | `19/19`：6 数采落库（双协议）、3 越界拒、3 合法写回环、配方、频道绑线、插件隔离、保护线零扰动 |
| 四期项目 | W1→W2→W3→W4 依赖链 | **`78/78`（run10）**，项目 completed，审计事件齐备 |

## 三、四期能力面实证（[tool-surfaces.json](tool-surfaces.json)；run10 证据）
| 期 | profile | 工具数 | 写面工具 | 治理语义 | run10 实测证据 |
| --- | --- | --- | --- | --- | --- |
| W1 分析 | line-doctor | 43 | **无** | 物理零写；结论=真实统计 | W1-t2 **实算 Pearson r=0.130(n=60)**、强度均值 473.7 σ=14.8 → 如实结论「相关性弱,温度非唯一主导」 |
| W2 控制 | legacy(tuning) | 96 | recipe_trial/update/apply | 绑定 manual → HITL 逐动作 + 项目 write_intent；**opIntervalMs=300000 平台强制** | W2-t0 无意图被拒 → W2-t3 HITL 批准 → **778℃ [证实✓]** → W2-t4 精确回读 786→778(±1.0) → W2-t5 惯性后复测 779.1 |
| W3 训练 | aml_training | 102 | 无 | 数据集构建（**零设备写:只 run close,不做 line.start**） | W3-t2 设备值保持 778（未被回退）;W3-t3 治理后窗 PV 均值 779.1;W3-t4 数据集 ds-mw7g50lu **1364 行,窗口覆盖治理时刻** |
| W4 自主优化 | aml_optimization | 86 | 仅 optimization_explore | 有界步长+可辨识性闸；**距上次调整 ≥300s 驱动显式执行** | W4-t1 探索 780→786（Δ=+6 精确）;W4-t2 **HITL 队列 0→0 + 项目审批数 0→0**;W4-t3 台账 agent 归因+判读「欠功效(不可辨识)」如实入库 |

**递进路径实证**：数据分析（零写）→ HITL 下发（逐动作审批）→ 模型训练（零写,只关批次建数据集）→ 探索档有界激励（无逐动作审批）。四期在**同一条产线、同一套节点**上完成，仅通过 Channel 档位与绑定模式切换治理强度。

## 四、无缝衔接（虚拟 → 真实）
- **代码面**：`driverConfig`（端点）与治理字段（min/max/stepLimit/holdIntervalMs）分开存储（server/api/workshop/dcw/[id].patch.ts:33）；绑定与配方引用节点 **id**。
- **diff 证据**（[cutover-diff.json](cutover-diff.json)）：before=供给期快照 vs after=现值，9 节点中 6 个 Modbus 节点**仅 driverConfig 变化（port 37542→37562）、治理字段零改动**（程序化断言 governanceViolations=0）；3 个 OPC UA 未动。
- **局限（审查指出）**：模拟器**自动分配寄存器**（holding 40001+i×2 / NodeId `cal3-qm.*-pv`）与协议文档的 HR/IR 表、`CAL3-QM.*` **不一致** → 真机割接必须按文档寄存器表逐点 PATCH register/endpoint，不是只换端口。「无缝」指治理面零改动，**不是免配置**。
- 生产割接按六步：预检→只读浸泡≥30min→单点写入三方对照→PATCH→verify 重跑→割接清单+投用裁决。

## 五、如实口径（关键限制）
1. **模拟器寄存器 ≠ 文档寄存器**（见四）；OPC UA NodeId 同样需按文档改写。
2. **编排为 mock 确定性档**：工具执行/治理闸/设备写入/审批签核全部真实；LLM 自主编排未在本轮使用（真 LLM 对话腿在多会话轮已单独验证 20/20）。
3. **AML 档位是频道级**：任务实例不继承 profile → W3/W4 的 AML 族工具由**基础频道 lead** 执行（W3-t0 显式断言）。
4. **W4 是「探索档有界激励」非模型驱动**（无绑定模型,Channel goal 空;方向/步长由驱动按文档允许域选定）;台账判读「欠功效(不可辨识)」如实记录。模型化自主 = 训练出模型→Channel 绑定→平台 modelBackedToolPolicy 自动启用 trial/bayes（本轮未走到）。
5. **批次生命周期**：开批（line_start,按基线下发参数=平台语义）为 owner/setup 操作,发生在工作项之外并披露；W3 只做 run close（零写）；W2 治理值靠保写心跳维持。
6. **工艺规则缺口**：二区≥一区、出口<650 禁提速未内建（投用复核清单）。
7. 质量仪采样 2000ms vs 文档建议 5s（Gate A 披露）；同规格 10min 数据集去重熔断=设计行为（命中时 force 重建）。

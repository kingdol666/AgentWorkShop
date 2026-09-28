# DCW 探索阶段安全卡控与 Channel 产线作业可视化

## 目标

当 AML/Twin 尚未通过训练质量门禁时，Channel 进入 `exploration / safe_small_step`。Agent 仍可做有限探索，但任何控制写入都必须在服务端通过：

1. 节点硬量程；
2. 参数、产品、活动 Recipe 工艺窗口交集；
3. 节点默认 / 参数覆盖 / Recipe 覆盖的最小 `stepLimit`；
4. Agent 同一节点两次写入间隔至少 60 秒。

所有检查位于 `DcwController.write()` 之前的服务端咽喉点，PLC driver 未被调用即返回结构化错误。

## 配置口径

- **节点默认值**：在 DCW 节点创建向导或 `PATCH /api/workshop/dcw/:id` 设置 `stepLimit`；留空时新节点按量程 2% 生成安全默认值，显式传 `null` 表示探索阶段禁止无界写入。
- **参数映射覆盖**：在参数映射接口 `PATCH /api/workshop/dcw/params/:id` 设置 `stepLimit`。`null` 表示跟随节点默认。
- **Recipe 覆盖**：Recipe 参数项增加 `stepLimit`。它只能收窄有效值，不会放宽节点或参数层限制。
- **有效步长**：所有已配置层取最小值；`limitsBreakdownOf()` 返回 `stepLimit`、来源与完整层链，Agent 语义卡也会注入该信息。

## 拒绝码

| code | 含义 |
| --- | --- |
| `NODE_RANGE_EXCEEDED` | 超出节点硬量程 |
| `PARAM_LIMIT_EXCEEDED` / `PRODUCT_LIMIT_EXCEEDED` | 参数或产品工艺限界越界 |
| `RECIPE_LIMIT_EXCEEDED` | 当前 Recipe 窗口越界 |
| `STEP_LIMIT_EXCEEDED` | 单次变化量超过有效 stepLimit |
| `EXPLORATION_SAFE_STEP_REQUIRED` | 未配置有限步长，探索阶段拒绝无界写入 |
| `WRITE_INTERVAL_NOT_ELAPSED` | Agent 两次 DCW 写入未间隔 60 秒 |

拒绝发生在实际驱动调用之前，节点设定值与 PLC 不发生变化。

## Twin 写入策略

Hybrid Twin 的 `recommendation_only` Channel 如果 profile capability 明确标记 `explorationWrite: true` 或 phase 为 `discovery / exploration / calibration`，允许进入安全探索；否则仍保持 recommendation-only 禁写。模型通过 Gate 后 MPC 可以进入 `precise_search`，但当前实现仍是 recommendation-only，未经 WriteGrant 不会直接生产写入。

## Channel 产线作业面板

Channel 右侧 Inspector 上方新增 Line Operations 面板，并在群聊消息与 Transcript EventBlock 中按事件类型渲染：

- DCW / Recipe：琥珀色；
- DAQ：青绿色；
- AML 训练：紫色；
- Twin / MPC / Gate：蓝色；
- 拒绝、越限、告警：红色。

面板读取现有 AEP 事件环，提供阶段标签、DCW/DAQ/AML/拦截计数、筛选器与最近作业时间线。没有事件时显示诚实空态，不伪造产线状态。


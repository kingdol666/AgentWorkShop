# Project 模式：从蓝图到交付

> Channel 回答“团队怎么协作”，Project 回答“这批工作什么时候算交付完成”。
> Project 模式把计划、工作项、技术复核、Owner 验收与交付物绑在一份可审计的契约里。

## 什么时候用 Project

- 一项任务需要**多个 Channel / 多支团队**按依赖顺序协作；
- 完成标准不是“聊完了”，而是**交付物通过 L1 技术复核 + L2 Owner 验收**；
- 需要在中断、重启、返工后仍能对账，并留下可追溯的事件与决策。

单个 Channel 能完成的事，不必升格为 Project。

## 对象模型

| 对象 | 说明 |
|---|---|
| **Project** | 交付契约；生命周期状态唯一写者是 `ProjectService` |
| **办公室频道** | 创建项目时自动生成的 private Channel，承载 `project_leader`（`agent_kind='project_leader'`） |
| **成员 Channel** | 绑定到项目的普通 Channel，带 charter；项目通过这些频道实际执行工作 |
| **WorkItem** | 工作项：关联一个交付物与一个成员频道，可带 `dependsOn`、验收标准、执行预算 |
| **Attempt** | 工作项的一次执行；`attemptNo` 递增，保留失败/返工历史 |
| **Deliverable** | 交付物：项目完成度的分母；必选交付物必须通过验收 |
| **Result** | 成果：summary / method / evidence / payload；可被 review、supersede |
| **Approval** | `plan_approval` · `deliverable_acceptance` · `project_complete` |
| **Event / Decision** | 项目事件账本与决策记录，供对账与审计 |

## 创建与激活

```bash
# 1) 创建项目（leaderHarness 必填；演示可显式传 mock）
curl -X POST http://localhost:3001/api/workshop/projects \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{
    "name": "CAL-3 四期复跑",
    "objective": "只读归因 → HITL 控制 → 数据集 → 有界自主优化",
    "mode": "supervised",
    "leaderHarness": "mock",
    "routingPolicy": "technical"
  }'

# 2) 绑定成员频道（owner only）
curl -X POST http://localhost:3001/api/workshop/projects/<projectId>/channels \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"channelId":"<channelId>","charter":"只读归因"}'

# 3) 激活（需要 ≥1 成员频道 + ≥1 必选交付物 + 已批准计划）
curl -X POST http://localhost:3001/api/workshop/projects/<projectId>/activate \
  -H "authorization: Bearer <token>"
```

**激活硬前提**：

1. 办公室频道 + Project Leader 已装配；
2. 至少一个成员 Channel 绑定，且频道有 lead；
3. 至少一个必选交付物（或 Owner 显式豁免）；
4. 至少一个已批准的 plan 版本（`observe` 允许 draft 计划，但不派发）。

`leaderHarness` **没有默认值**：不允许“用户不选就静默得到 mock 做生产 Leader”。演示/验收请显式传 `mock`。

## 蓝图一键实例化

```bash
curl -X POST http://localhost:3001/api/workshop/projects/instantiate \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{
    "template": "line-optimisation",
    "nameOverride": "CAL-3 rerun"
  }'
```

也可以直接传 `blueprint` 文档，核心字段：

```jsonc
{
  "name": "…",
  "objective": "…",
  "routingPolicy": "technical",          // legacy | technical
  "planApprovalRequired": true,
  "autoDispatch": true,
  "mode": "supervised",                  // observe | supervised | auto
  "leaderHarness": "omp",
  "leaderProvider": "…",
  "leaderModel": "…",
  "channels": [
    { "key": "analysis", "name": "分析", "charter": "只读归因", "leadHarness": "omp" }
  ],
  "plan": {
    "deliverables": [ { "key": "report", "name": "归因报告", "required": true } ],
    "work_items": [ { "key": "w1", "deliverableKey": "report", "channelKey": "analysis" } ]
  }
}
```

`planApprovalRequired=false` 的蓝图可直接激活；否则返回 `pending_plan_approval` 与 `planApprovalId`，Owner 在项目页批准后进入 `active`。

## 工作项状态机

```text
DRAFT ─▶ DISPATCHING ─▶ DISPATCHED ─▶ RUNNING ─▶ COMPLETED
                    │             │           │
                    ▼             ▼           ├─▶ REWORK ─▶ DISPATCHING
                  BLOCKED       BLOCKED       ├─▶ FAILED ─▶ DISPATCHING
                                              ├─▶ CANCELED
                                              └─▶ SUPERSEDED
```

- **状态是投影**：`reconcileWorkItem()` 以 attempt 表与 root task 为锚推导；DB 里的 `state` 只是缓存投影，重启、tick、任务状态变化都会对账；
- `dependsOn` 未全部完成（或显式 waived）时，下游保持 `BLOCKED`；
- 项目 `routingPolicy=technical` 时，上游成果必须先通过技术复核才放行下游；`legacy` 是兼容口径；
- 一个工作项可返工多次；`attemptNo` 递增，旧 attempt 关闭后不再参与投影。

## 交付物、L1 与 L2

```text
planned ─▶ active ─▶ submitted ─▶ approved / rejected / waived
```

1. **自动草稿**：项目 root task 完成时，平台从 task artifacts/history 生成 draft 成果；
2. **Channel lead 提交**：`project_submit_result` 补充 summary / method / evidence；
3. **L1 技术复核**：`project_review_result` 写 review proposal，执行器落到 `reviewed` 或 `rejected`（附理由）；
4. **L2 Owner 验收**：`project_approvals(kind='deliverable_acceptance')` → `approved` / `rejected`；
5. **取代**：新成果 `supersedes_id` 指向旧版本，旧版本置 `superseded`。

证据必须是真实引用：`task_id` / `artifact` / `analysis_report_id` / URL。服务端会校验 task 属于本项目/本 Channel、artifact 存在于该 task；**禁止自造 evidence 字符串**。

## 三种项目模式

| 模式 | 计划 | 派发 | 成果复核 | 完成 | 适用 |
|---|---|---|---|---|---|
| `observe` | Leader 提案，只记录 | 不执行（影子） | 只记录建议 | 不执行 | 首次上线 / 影子评估 |
| `supervised`（默认） | Leader 提案，Owner 批准/可改 | 批准后自动派发；破坏性动作审批 | Leader 复核 + Owner 验收 | Owner 批准 | 常规 |
| `auto` | Leader 自主提案，replan 仍需审批 | 自动派发 / 催办 | Leader 复核 + 必选交付物 Owner 验收 | Owner 批准 | 成熟项目 |

项目模式与 Channel `execution_mode` **独立**：前者管项目动作，后者管工业写。Project Leader 永远不能替 Channel 提高写权限。

## 生命周期操作

| 动作 | API | 语义 |
|---|---|---|
| 暂停 | `POST /projects/:id/pause` | 停调度循环；不杀频道内在飞任务；不再派发新工作项 |
| 恢复 | `POST /projects/:id/resume` | 重建循环；全量对账；恢复派发 |
| 继续开发 | `POST /projects/:id/continue` | completed 项目收到补充需求 → 重开 → Leader 读现状 → plan vN+1 |
| 对账 | `POST /projects/:id/reconcile` | 以 attempt / root task 为锚重新投影 |
| 完成 | `POST /projects/:id/complete` | 门禁通过后创建 `project_complete` 审批 |
| 归档 | `POST /projects/:id/archive` | 只读；保留绑定历史；列表默认隐藏 |

## 项目页

项目页围绕交付而不是聊天组织：

- **概览**：Leader 对话、项目快照（就绪/执行中/等待/阻塞、工作项完成率、交付物签核率）、频道绑定、周报；
- **计划与工作**：plan 版本、工作项依赖、派发状态；
- **交付物**：交付物 / 成果 / 证据 / 取代关系；
- **审批**：plan、交付物验收、项目完成；
- **决策与事件**：决策记录与事件账本（可对账）。

界面细节见 [Harness 控制台与 Project 详情](/guide/harness-ui)。

## 实机场景：CAL-3 四期递进

同一 Project 依赖链，四期依次放行（真实产线，非 mock 设备）：

1. **W1 数据分析（只读零写）**：`daq_query` 拉取炉温/定量/性能数据，结论入台账；L1+L2 通过；
2. **W2 HITL 下发控制**：申请 `write_intent` → 独立 admin 批准 → `recipe_trial` HITL 卡 → 批准 → 设备回读收敛（228.32 °C，按步限夹紧）；
3. **W3 训练数据集**：`aml_dataset_build` + 质量报告；零写佐证“设备值保持治理值，未被 line.start 回退”；
4. **W4 受控自主优化**：`aml_optimization` 探索档，有界激励 +6（≤步限、界内），**无新增审批**，干预台账可查。

结果 **78/78**；两次调整间隔 ≥300s、在线写间隔闸 60s 真实生效。完整报告：[`docs/audit/evidence/2026-11-08-industrial-acceptance/REPORT.md`](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-08-industrial-acceptance/REPORT.md)。

## API 速查

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET/POST` | `/api/workshop/projects` | 列表 / 创建 |
| `POST` | `/api/workshop/projects/instantiate` | 蓝图或模板一键实例化 |
| `POST` | `/api/workshop/projects/:id/activate` | 激活 |
| `POST` | `/api/workshop/projects/:id/pause` · `resume` · `complete` · `archive` | 生命周期 |
| `POST` | `/api/workshop/projects/:id/continue` | 持续开发 |
| `GET/POST` | `/api/workshop/projects/:id/channels` | 成员频道绑定 |
| `GET/POST` | `/api/workshop/projects/:id/work-items` | 工作项 |
| `GET/POST` | `/api/workshop/projects/:id/deliverables` | 交付物 |
| `POST` | `/api/workshop/projects/:id/results/:rid/review` | L1 成果复核 |
| `GET` | `/api/workshop/projects/:id/approvals` | 审批列表 |
| `POST` | `/api/workshop/projects/:id/approvals/:aid/decide` | 批准 / 拒绝 |
| `GET` | `/api/workshop/projects/:id/sessions` | 项目 / 任务会话目录（仅简报） |
| `GET` | `/api/workshop/projects/:id/observability` | 观测面（工作项、交付物、预算） |

## 边界与已知限制

Project 模式已经可以承担真实交付，但以下边界必须知道：

- **completed 项目仍持有频道绑定**：重新跑同一批频道会返回 `CHANNEL_ALREADY_BOUND`；当前需要先显式解绑（`DELETE /projects/:id/channels/:cid`）。自动释放已列入 P0；
- **没有持久化工作流引擎**：派发、提交、验收靠事件 + 对账拼接，跨步骤失败依赖重试与人工对账；
- **节拍闸是“事后拒绝”**：300s / 60s 闸会把计划打回，Agent 只能等待/重试，调度器尚未预留时间窗；
- **Leader 可用 mock**：`leaderHarness` 已强制显式，但演示/验收仍可能使用 mock；真实项目应选真实引擎；
- **L1/L2 的独立性**：当前是“技术复核 + Owner 验收”两段，不包含多评审员辩论协议。

> 相关阅读：[Channel 多会话与 Agent 生命周期](/guide/channels-sessions) · [Harness 控制台](/guide/harness-ui) · [HITL 审批](/guide/hitl) · [产线权限](/guide/line-permissions)

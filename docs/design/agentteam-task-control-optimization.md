# AgentTeam 任务治理与收口机制优化设计方案

> 设计日期：2026-09-23  
> 设计状态：**已确认，第一阶段实现已落地**  
> 适用范围：AgentTeam 任务创建、Lead 分解、worker 执行、任务取消、任务收口、SchedulerLoop 恢复与 Lead prompt 约束  
> 本文性质：技术设计、实施边界与验收契约；第一阶段代码已按本文落地，后续扩展仍需遵循本文。

---

## 0. 决策摘要

本方案针对 2026-09-23 AgentTeam P3 E2E 暴露的收敛问题：同一条“日志清理作业方案”诉求被 Lead 通过改标题、取消、重派和再次创建根任务不断扩张，最终出现 10 个子任务、8 个 CANCELED、多个仍在 WORKING/ASSIGNED 的任务，且 15 分钟窗口内没有闭环。

最终采用以下平台级决策：

| 决策项 | 最终规则 |
|---|---|
| 根任务身份 | 同一 Channel 内，同一个 `sourceChatMessageId` 只能对应一个根任务 |
| 普通任务嵌套 | 最大深度为 1；Lead 可直接派 worker，worker 不得递归创建孙任务 |
| 根任务累计后代预算 | 默认最多 6 个子任务尝试；完成、失败、取消都计入；改标题不能清零 |
| 同时未结束后代 | 默认最多 4 个；超过后拒绝新派发 |
| 取消预算 | 每个根任务最多 3 个 CANCELED 子任务；取消后重建会继续消耗预算 |
| 失败重试 | 优先 `reassign_task` 复用原 task，不新建子任务，不消耗子任务数量预算 |
| Lead 动态建员 | 每个 Channel 默认最多 8 个 worker 实例；禁用成员仍计数；已有超限 Channel 不删除但禁止继续新增 |
| 普通根任务总时限 | 默认 15 分钟；到期关闭根任务及活动后代 |
| 超时状态 | 第一阶段不新增 `TIMED_OUT` 状态；根任务使用 `FAILED + close_reason=ROOT_TIMEOUT`，后代使用 `CANCELED + close_reason=ROOT_TIMEOUT` |
| 模式任务 | `goal/pipeline/loop` 不直接套普通 root timeout；使用各自有限预算。`loop` 必须配置有限 `maxIterations` 或 `maxDurationMs` |
| 父任务取消 | 取消父任务同步级联取消全部非终态后代，并按 task ID 精确中断相关运行 |
| 成功收口 | `COMPLETED` 仍要求全部子任务完成、交付物可验收、Lead 提交验收总结 |
| 部分完成 | 不伪装为 `COMPLETED`；采用 `FAILED` 或 `CANCELED` 并附带结构化总结与关闭原因 |
| UI 范围 | 第一阶段后端、运行时、数据库、prompt、测试优先；任务预算字段和 close reason 通过 API/task detail 暴露，UI 展示可后置 |

核心原则：

> Prompt 负责引导，TaskEngine 负责裁决；标题负责展示，持久化来源 ID 负责幂等；Lead 负责业务判断，平台负责预算、权限、终止和收口上界。

---

## 1. 背景与问题定义

### 1.1 事故现象

在 2026-09-23 的真实 LLM AgentTeam P3 场景中，同一个日志清理方案诉求出现了以下行为：

1. 先创建执行方案和回滚方案两个子任务。
2. 两个子任务完成后，Lead 继续取消原任务。
3. Lead 使用不同标题重新创建“统一契约版”“按冻结契约”“接口对齐修正”等任务。
4. Lead 又创建第二个根任务派发“独立交叉核验”。
5. 在 15 分钟窗口结束时，仍有 WORKING、ASSIGNED 任务。

持久化数据证明：

- 一个根任务拥有 10 个后代，其中 2 个 COMPLETED、8 个 CANCELED。
- 同一原始用户诉求后来产生了标题不同的第二个根任务。
- 历史同类任务只需要 1–3 个子任务即可收敛。

### 1.2 根因分类

#### 模型行为方差

- Lead 对“修订”“核验”“对齐”的边界理解不稳定。
- Lead 可能把标题重命名当成新任务。
- Lead 可能把取消后重派当成普通计划调整。
- Lead 可能在没有新证据时继续自我修订。

#### 平台缺少硬上界

- 没有根任务累计子任务预算。
- 没有同时未结束任务上限。
- 没有取消后重派闸门。
- 没有稳定的根任务来源身份。
- 没有普通根任务 wall-clock deadline。
- 取消只影响单个 task，不会可靠级联到后代。
- `abortCurrent()` 没有 task ID，存在误中断同一 worker 其他任务的风险。

#### 多入口绕过

当前子任务创建不只经过 Manager：

```text
ManagerTasks.dispatchTask()
TaskEngine.dispatch()
SchedulerLoop.execute() 直接调用 TaskEngine.dispatch()
HostToolBridge dispatch_task
REST / MCP / Agent runtime
```

因此任何只放在 HostTool 或 Manager 层的限制都不是最终安全边界。

---

## 2. 当前系统架构与关键调用链

### 2.1 根任务登记

```text
群聊用户消息
  ↓
ManagerChat.sendChatMessage / deliverChatToAgent
  ↓  metadata:
     x-aw-source-chat-message-id
     x-aw-delivery-id
     x-aw-requester-user-id
  ↓
Mailbox / messages 表
  ↓
AgentRuntime.processMessage()
  ↓
BaseAgent.run()
  ↓
Lead 调用 submit_task
  ↓
HostToolBridge.handleSubmitTask()
  ↓
AgentWorkspace.submitTask()
  ↓
ManagerWorkspace.submitLeadRootTask()
  ↓
TaskEngine.create()
  ↓
TaskRepo.create()
  ↓
tasks 表
```

当前缺口：`sourceChatMessageId` 在进入 Agent 后没有传递到 `submit_task` 和 `tasks` 表。

### 2.2 子任务派发

```text
Lead 调用 dispatch_task
  ↓
HostToolBridge.handleDispatchTask()
  ↓
AgentWorkspace.dispatchTask()
  ↓
ManagerTasks.dispatchTask()
  ↓
TaskEngine.dispatch()
  ↓
TaskRepo.create()
  ↓
MessageRepo / worker mailbox
  ↓
AgentRuntime.processMessage()
  ↓
worker harness 执行
```

当前缺口：`TaskEngine.dispatch()` 只有同父同标题防重，没有根任务级预算。

### 2.3 任务收口

```text
worker complete_task
  ↓
ManagerTasks.completeTask()
  ↓
TaskEngine.complete()
  ↓
child COMPLETED
  ↓
TaskEngine.onChildCompleted()
  ↓
唤醒 Lead
  ↓
Lead 读取 child artifacts
  ↓
Lead 提交验收总结
  ↓
complete_task(parent)
  ↓
parent COMPLETED
```

必须保留以下语义：

- worker `COMPLETED` 只是提交成果。
- Lead 必须审查真实 artifact。
- 父任务不能因为子任务刚完成就自动 COMPLETED。
- 父任务成功必须有 Lead acceptance summary。

---

## 3. 目标与非目标

### 3.1 目标

1. 保证 Lead 对每个根任务的创建和拆解有有限预算。
2. 防止通过改标题、换 assignee 或新建根任务绕过预算。
3. 让同一条群聊用户请求具备持久化幂等身份。
4. 取消一个任务后，相关后代和运行中的 harness 能真正停止。
5. 取消排队任务时，不误中断同一 worker 正在执行的其他任务。
6. 给普通根任务增加绝对总时限。
7. 保持简单任务不拆解、正常 1–3 个子任务场景和 Lead 验收流程不回归。
8. 让超限、超时、取消、失败都能被 Lead 看懂并采取正确动作。
9. 让所有关键限制在 TaskEngine/数据库权威边界生效，而不是依赖模型自律。

### 3.2 非目标

本计划第一阶段不做：

- 不重写 AgentRuntime 的整体并发模型。
- 不重写所有 harness adapter。
- 不修改工业控制、DAQ、AML 业务逻辑。
- 不改变 goal/pipeline/loop 的核心业务语义，只为其增加有限预算约束。
- 不在第一阶段大规模改造前端任务看板。
- 不把普通 task quota 扩展成全局 API rate limit。
- 不通过删除旧任务记录来“释放预算”。

---

## 4. 任务状态与业务语义

### 4.1 现有状态继续保留

```text
SUBMITTED → WORKING / ASSIGNED / CANCELED / COMPLETED
ASSIGNED  → WORKING / CANCELED
WORKING   → WAITING / COMPLETED / FAILED / CANCELED
WAITING   → WORKING / COMPLETED / CANCELED
FAILED    → ASSIGNED / CANCELED
COMPLETED → terminal
CANCELED  → terminal
```

第一阶段不新增 `TIMED_OUT`，以减少状态机、API、前端和测试的扩散范围。

### 4.2 close_reason

增加任务关闭原因，至少支持：

```text
USER_CANCEL
LEAD_CANCEL
ROOT_TIMEOUT
QUOTA_EXHAUSTED
DELIVERY_FAILED
RETRY_EXHAUSTED
AGENT_REMOVED
HARNESS_FAILURE
```

`close_reason` 仅描述关闭原因，不替代 `state`。

示例：

```text
state=FAILED,   close_reason=ROOT_TIMEOUT
state=CANCELED, close_reason=ROOT_TIMEOUT
state=CANCELED, close_reason=LEAD_CANCEL
state=FAILED,   close_reason=RETRY_EXHAUSTED
```

### 4.3 成功与非成功收口

| 场景 | 状态 | 是否允许视为用户成功完成 |
|---|---|---:|
| 全部子任务交付，Lead 验收通过 | COMPLETED | 是 |
| Lead 直接完成简单任务 | COMPLETED | 是 |
| 子任务失败后原任务重派并完成 | COMPLETED | 是 |
| 子任务取消，Lead 仍想提交结果 | FAILED/CANCELED | 否，除非后续重新补齐并验收 |
| 根任务超时 | FAILED | 否 |
| 用户主动终止 | CANCELED | 否 |
| 配额耗尽 | FAILED 或 CANCELED，取决于触发对象 | 否 |

禁止用 `COMPLETED` 隐藏未完成的子任务。

---

## 5. 根任务身份与幂等设计

### 5.1 主身份

根任务来源身份使用：

```text
sourceChatMessageId
```

唯一约束：

```text
(channel_id, source_chat_message_id)
```

仅对以下行生效：

```text
parent_id IS NULL
source_chat_message_id IS NOT NULL
```

同一个用户群聊消息即使 Lead 改变标题、描述或路由 worker，也必须复用同一个根任务。

### 5.2 不使用 deliveryId 作为根任务主身份

`deliveryId` 是某条 chat message 投递到某个 Agent 的投递记录，不是用户请求本身。

因此：

- `sourceChatMessageId`：请求身份，用于 root idempotency。
- `sourceChatDeliveryId`：调试、审计、回复投递关联，可保存但不作为 root 唯一键。

### 5.3 无 sourceChatMessageId 的任务

对于直接 API、定时任务或非群聊调用：

- 保留原有精确标题幂等作为兼容策略。
- 标题不被视为强身份。
- 后续如有 `clientRequestId`，可扩展为显式请求幂等键。

### 5.4 数据库改动

涉及文件：

```text
server/services/workshop/db/database/schema.ts
server/services/workshop/db/schema.sql
server/services/workshop/db/database/rows.ts
server/services/workshop/db/task.repo.ts
server/services/workshop/db/database/open.ts
server/services/workshop/db/database/migrations.ts
```

建议字段：

```sql
source_chat_message_id TEXT NULL
source_chat_delivery_id TEXT NULL
close_reason TEXT NOT NULL DEFAULT ''
deadline_at TEXT NULL
```

第一阶段至少必须有：

```text
source_chat_message_id
close_reason
```

`deadline_at` 建议一并加入，便于审计和重启后保持同一个 deadline。

迁移要求：

1. 旧数据库所有新字段使用安全默认值。
2. 不根据旧标题反推 source ID。
3. 先完成 tasks 表重建迁移，再添加依赖新字段的索引。
4. 添加 root-only partial unique index。
5. 迁移可重复执行。
6. 迁移失败不能破坏旧任务数据。

---

## 6. 任务预算策略

### 6.1 配置项

扩展 `WorkshopSettings` 和配置描述符：

```text
workshop.max_descendants_per_root       = 6
workshop.max_active_descendants_per_root = 4
workshop.max_canceled_descendants_per_root = 3
workshop.max_task_depth                 = 1
workshop.root_timeout_ms                = 900000
workshop.max_lead_created_workers       = 8
```

涉及：

```text
server/services/workshop/settings.ts
config.yml
app/config/schema.ts
shared/config/schema.json
```

建议每个配置都有：

- 默认值
- 最小值
- 最大值
- 中文 label
- 说明和适用范围
- restart/live 语义

### 6.2 根任务预算定义

对任意待创建子任务，通过 `parent_id` 找到 ultimate root。

累计后代任务统计包含：

```text
SUBMITTED
ASSIGNED
WORKING
WAITING
COMPLETED
FAILED
CANCELED
```

也就是说，只要曾经创建过，就消耗累计子任务预算。

默认规则：

```text
descendant_count + 1 <= max_descendants_per_root
```

### 6.3 同时未结束预算

统计后代中：

```text
SUBMITTED / ASSIGNED / WORKING / WAITING
```

默认：

```text
active_descendant_count < 4
```

超过后拒绝新建，并提示 Lead：

- 等待现有任务完成
- 检查已有交付物
- reassign 原任务
- 不要改标题重建

### 6.4 取消预算

统计后代中：

```text
state = CANCELED
```

默认：

```text
canceled_descendant_count < 3
```

达到上限后：

- 不允许通过新标题继续派发同一根任务的新子任务。
- 允许对 FAILED 原 task 做有限 reassign，具体由 retryCount 控制。
- Lead 必须向用户报告阻塞或终止原因。

### 6.5 深度预算

普通任务默认：

```text
root depth = 0
worker child depth = 1
```

当 `parent.depth >= 1` 时，普通 `dispatch_task` 拒绝创建孙任务。

复杂阶段必须使用：

- pipeline
- Lead 自己统一调度
- 或由用户明确创建新的根任务

但同一 source chat message 仍不能产生第二个根任务。

### 6.6 reassign 不消耗子任务数量

以下操作复用原任务记录：

```text
FAILED → ASSIGNED
更换 assignee
retryCount + 1
```

不增加：

```text
descendant_count
canceled_descendant_count
```

这保证失败重试不会被错误地当成新的拆解任务。

### 6.7 最终权威位置

最终预算检查必须放在：

```text
TaskEngine.dispatch()
```

Manager 仍做前置权限和友好错误校验，但不能作为唯一保护。

这样可以覆盖 scheduler 直接调用 TaskEngine 的路径。

---

## 7. TaskEngine 与数据库边界设计

### 7.1 推荐新增策略模块

建议增加：

```text
server/services/workshop/runtime/task-engine/policy.ts
```

职责：

- 纯策略计算
- 预算计数
- root lineage 计算
- 深度计算
- 模式任务识别
- 错误码和诊断数据生成

TaskEngine 负责调用策略并决定是否创建；策略模块不直接写数据库。

### 7.2 创建顺序

正确顺序：

```text
1. 读取 parent
2. 校验 parent/channel/terminal
3. 计算 root
4. 计算预算
5. 校验深度
6. 校验模式规则
7. 通过后创建 child
8. 投递 assign
9. 父任务转 WAITING
10. 广播 task change
```

不得出现：

```text
先创建 child
再发现父任务不能迁移
最后留下孤儿 child
```

### 7.3 原子性

任务创建与预算判断应尽量在同一个同步数据库操作边界内完成。

最低要求：

- 同一 Node 进程中不能有“检查后 await，再创建”的窗口。
- repository 层提供直接创建所需的查询/插入接口。
- 如实现中使用 SQLite transaction，必须避免嵌套 transaction 破坏现有调用。
- 预算失败时不改变父任务状态、不创建 child、不发送 assign。

---

## 8. 根任务来源 ID 传递设计

### 8.1 HostToolSessionState

当前状态包含：

```text
currentTaskId
replyContext
```

增加当前请求上下文：

```ts
sourceChatMessageId: string | null
sourceChatDeliveryId: string | null
```

上下文必须是“当前回合级”，不能永久残留到下一条用户消息。

### 8.2 AgentRuntime 到 BaseAgent

`AgentRuntime.toRequest()` 已经能看到完整 A2A message metadata。

建议在 BaseAgent 的一次 `run()` 开始时，将：

```text
x-aw-source-chat-message-id
x-aw-delivery-id
```

写入 session state；回合结束时清空。

所有 harness 复用 BaseAgent 的 host tool bridge，因此不需要为每种 harness 单独实现一套身份传递。

### 8.3 submit_task 参数

`submit_task` 不要求模型手写 source ID。

平台从当前回合上下文自动注入：

```text
ws.submitTask({
  title,
  description,
  sourceChatMessageId: state.sourceChatMessageId,
  sourceChatDeliveryId: state.sourceChatDeliveryId,
})
```

这样可以避免模型伪造或遗漏幂等身份。

---

## 9. 取消、级联和精确中断

### 9.1 TaskEngine.cancelTree

建议新增：

```ts
cancelTree(taskId, by, reason): {
  canceled: WorkspaceTask[]
  preservedTerminal: WorkspaceTask[]
}
```

操作顺序：

```text
后代优先，父任务最后
```

只处理非终态任务。

已完成、已失败、已取消的任务保留原结果，不重新改写状态。

### 9.2 ManagerTasks.cancelTask

Manager 负责：

1. 权限校验
2. 模式任务取消权限校验
3. 调用 `cancelTree`
4. 对返回的每个 canceled task：
   - 作废 pending assign
   - 找到 assignee runtime
   - 调用 `abortTask(task.id)`
5. 唤醒 Lead/父任务调度
6. 返回级联取消结果

### 9.3 AgentRuntime 中断 API

将无范围的：

```ts
abortCurrent()
```

补充为：

```ts
abortTask(taskId: string): boolean
```

规则：

```text
currentTaskId === taskId → abort
currentTaskId !== taskId → 不影响当前 run
currentTaskId 为 null → 不操作
```

显式 `stop()` 仍可停止整个 AgentRuntime，不受 task-scoped abort 限制。

### 9.4 Lead supervise 决策过期保护

旧 Lead 决策可能在用户取消之后返回，因此 Scheduler 执行每条决策前重新读取 task：

```text
目标已 CANCELED → 丢弃 dispatch/complete/reassign
目标已 COMPLETED → complete 幂等跳过
目标已 FAILED 且已 ROOT_TIMEOUT → 不再 reassign
```

### 9.5 取消通知

`x-aw-task-kind=cancel` 作为 control message：

- 直接消费
- 不进入普通 workerTurn
- 不调用新的 harness run
- 不触发新的任务交付
- 只做 runtime 状态刷新和可选的审计广播

### 9.6 迟到事件

所有完成路径重新检查：

```text
task.state === WORKING
```

只有满足时才允许：

- apply artifact
- implicit complete
- transition COMPLETED
- onChildCompleted
- 唤醒父任务验收

---

## 10. 普通根任务总时限

### 10.1 deadline 设置

普通根任务创建时设置：

```text
deadline_at = created_at + workshop.root_timeout_ms
```

这样运行中动态修改配置不会改变已创建任务的既定 deadline。

### 10.2 适用范围

适用于：

```text
普通 root task
```

不直接覆盖：

```text
goal
pipeline
loop
```

模式任务使用自己的有限预算；如果模式没有有限预算，创建或启动时应被拒绝。

### 10.3 Scheduler 行为

Scheduler 每轮快照后先执行 deadline 检查，再执行 Lead supervise 和恢复规则：

```text
1. 找到超时普通 root
2. 关闭 root 及活动后代
3. 中断相关 runtime
4. 作废 pending assign
5. 广播 close_reason=ROOT_TIMEOUT
6. 不执行旧的 Lead dispatch 决策
7. 不触发 retry/reassign
```

### 10.4 超时结果

```text
root       = FAILED + close_reason ROOT_TIMEOUT
children   = CANCELED + close_reason ROOT_TIMEOUT
```

根任务保存一条结构化关闭 artifact 或 history：

```text
任务在 deadline_at 到期时未完成。
已完成交付物、未完成任务、取消任务和下一步建议如下：...
```

不得将超时任务伪装为 COMPLETED。

---

## 11. goal / pipeline / loop 模式边界

### 11.1 goal

goal 可以继续由 Lead 判断是否满足目标，但必须增加有限预算：

- 复用普通根任务累计后代预算
- 不能通过反复补派绕过 6 个后代上限
- 可增加 `maxDurationMs`
- goal 的显式 complete 仍保留 goal-summary 兜底

### 11.2 pipeline

pipeline 的阶段数天然是有限结构：

- 每个 stage 只能有一个主交付任务
- stage 重试优先复用原 task
- 不允许任意追加新阶段绕过 root 预算
- stages 配置必须在任务创建时冻结

### 11.3 loop

当前 loop 的 `maxIterations` 可以默认为 Infinity，这是无界风险。

新规则：

```text
maxIterations 或 maxDurationMs 至少提供一个
```

否则拒绝创建或启动 loop。

Loop 每次重放仍应保留：

- 原始 loop root identity
- 当前 iteration
- 总 iteration 上限
- deadline 或 maxDuration

不能把每次 loop 当成完全无关联的新用户根任务，也不能让 sourceChatMessageId 唯一索引阻止合法的 loop iteration。

---

## 12. Lead 动态建员上限

### 12.1 配置

```text
workshop.max_lead_created_workers = 8
```

上限按 Channel 计算，不是全局上限。

### 12.2 计数规则

计数包含：

- enabled worker
- disabled worker
- 暂时停止运行时的 worker
- 由 Lead 动态创建的历史 worker 实例

禁用后重新启用不能释放名额。

### 12.3 兼容旧 Channel

如果现有 Channel 已经超过 8 个 worker：

- 不自动删除
- 不自动禁用
- 允许现有成员继续运行
- 不允许 Lead 继续创建新的 worker

### 12.4 创建顺序

在创建 Agent 模板和 Channel 实例之前检查名册上限：

```text
1. 权限检查
2. 统计现有 worker
3. 超限则直接返回 TEAM_WORKER_LIMIT
4. 通过后才创建模板
5. 再加入 Channel
6. 再装配 runtime
```

避免超限失败留下孤儿模板。

---

## 13. Prompt 和工具契约改动

### 13.1 Lead supervisor prompt

文件：

```text
.AgentWorkShop/prompts/lead-supervise.md
```

必须补充：

1. 简单任务直接完成，不要为“保险”创建 worker。
2. 普通任务先做最小拆解，默认只允许一级子任务。
3. 首次派发后冻结 task ID、标题、目标、交付格式和验收标准。
4. 不要通过取消、改标题、换描述来继续同一目标。
5. 修订优先使用原 task 的 notify、update、reassign。
6. 取消任务会消耗根任务预算。
7. 配额耗尽后不得新建根任务，应报告阻塞。
8. 一个 source chat message 只能维护一个根任务。
9. worker COMPLETED 只是提交，必须读取实际 artifact。
10. 只有所有子任务接受后才能 complete parent。
11. 超时、取消和失败必须如实报告，不得写成成功。
12. 模式任务必须遵守自己的有限 iteration/deadline。

### 13.2 host-tools.json

更新 `submit_task`、`dispatch_task`、`cancel_task`、`create_team_agent` 的描述：

- 说明预算和剩余配额
- 禁止标题改名绕过
- 说明 reassign 不等于创建新任务
- 说明 cancel parent 会级联
- 说明超限后应报告，不要继续尝试
- 说明 `loop` 必须有限

### 13.3 错误消息

错误必须给 Lead 可执行建议：

```text
当前预算：6/6
活动任务：4/4
取消任务：3/3
建议：检查现有 artifacts；对 FAILED 原任务 reassign；或向用户报告无法继续。
```

---

## 14. 计划修改文件清单

### 14.1 任务策略与引擎

```text
server/services/workshop/runtime/task-engine/policy.ts       新增
server/services/workshop/runtime/task-engine/02-create.ts   修改
server/services/workshop/runtime/task-engine/03-transition.ts 修改
server/services/workshop/runtime/task-engine/04-lifecycle.ts 修改
server/services/workshop/runtime/task-engine/helpers.ts     视需要修改
server/services/workshop/runtime/task-engine/types.ts       视需要修改
```

### 14.2 Manager

```text
server/services/workshop/runtime/manager/04-workspace.ts
server/services/workshop/runtime/manager/11-lead-team.ts
server/services/workshop/runtime/manager/14-tasks.ts
server/services/workshop/runtime/manager/16-host-tools.ts
```

### 14.3 Runtime 与 Scheduler

```text
server/services/workshop/runtime/agent-runtime/00-state.ts
server/services/workshop/runtime/agent-runtime/02-supervise.ts
server/services/workshop/runtime/agent-runtime/03-message.ts
server/services/workshop/runtime/agent-runtime/types.ts
server/services/workshop/runtime/scheduler-loop/01-tick.ts
server/services/workshop/runtime/scheduler-loop/02-snapshot.ts
server/services/workshop/runtime/scheduler-loop/03-rules.ts
server/services/workshop/runtime/scheduler-loop/04-execute.ts
server/services/workshop/runtime/scheduler-loop/types.ts
```

### 14.4 Host tool 与接口

```text
server/services/workshop/agents/agent-interface.ts
server/services/workshop/agents/base-agent.ts
server/services/workshop/agents/host-tool-bridge/types.ts
server/services/workshop/agents/host-tool-bridge/session.ts
server/services/workshop/agents/host-tool-bridge/dispatch.ts
server/services/workshop/agents/host-tool-bridge/tools/tasks.ts
server/services/workshop/agents/host-tool-bridge/tools/team.ts
```

### 14.5 配置与数据库

```text
server/services/workshop/settings.ts
config.yml
app/config/schema.ts
shared/config/schema.json
server/services/workshop/db/database/schema.ts
server/services/workshop/db/schema.sql
server/services/workshop/db/database/rows.ts
server/services/workshop/db/task.repo.ts
server/services/workshop/db/database/open.ts
server/services/workshop/db/database/migrations.ts
```

### 14.6 Prompt 与测试

```text
.AgentWorkShop/prompts/lead-supervise.md
.AgentWorkShop/prompts/host-tools.json
scripts/test-task-engine.ts
scripts/test-agent-runtime.ts
scripts/test-agentteam-workflow.ts
scripts/e2e-task-queue.ts
scripts/e2e-agentteam-real-triage.mjs
scripts/e2e-agentteam-task-flow-real.ts
```

不修改与本功能无关的 UI、工业控制、AML、论文、benchmark 和插件文件。

---

## 15. 分阶段实施顺序

### 阶段 A：数据模型和配置

内容：

- 增加 tasks 新字段
- 增加迁移
- 增加配置描述符
- 增加 settings 类型
- 做旧数据库迁移测试

验收：

- 新数据库可启动
- 旧数据库可升级
- 任务历史不丢失
- 老任务没有 source ID 时仍能查询

### 阶段 B：根任务幂等

内容：

- 传递 source chat message ID
- 根任务持久化来源身份
- root-only unique index
- 同消息不同标题复用 root
- 不同 source message 可建立不同 root

验收：

- 复现日志清理第二根任务场景时不再产生第二个 root
- 同 title 不同 source message 不会错误合并
- 并发重复提交不会产生两个 root

### 阶段 C：子任务预算

内容：

- policy 模块
- TaskEngine.dispatch 硬闸门
- active/canceled/depth 统计
- scheduler 直接 dispatch 覆盖
- 明确错误码和剩余预算

验收：

- 改标题不能突破 6 个累计预算
- 嵌套不能突破 root 预算
- 取消 3 个后继续派发被拒绝
- reassign 原任务不增加 child count
- 正常 1–3 子任务仍通过

### 阶段 D：取消级联和 task-scoped abort

内容：

- cancelTree
- abortTask(taskId)
- cancel control message
- 迟到 event/complete 保护
- Scheduler 和 Manager 统一取消语义

验收：

- 取消排队 B 不影响运行中的 A
- 取消父任务会停止全部活动后代
- 取消后 worker 不会执行过期 assign
- 迟到 artifact 不污染 CANCELED task
- 已完成 child 不被回滚

### 阶段 E：普通根任务超时

内容：

- deadline_at
- root timeout scheduler rule
- close_reason
- timeout 后禁止 retry/reassign
- 模式任务例外

验收：

- 普通 root 到期关闭
- 活动后代全部关闭
- 相关 runtime 停止
- 重启 scheduler 后仍能识别 deadline
- 超时不被重新派发

### 阶段 F：Lead prompt 与工具说明

内容：

- 更新 supervisor contract
- 更新 host tool 描述
- 更新错误文本
- 删除诱导改标题重派的提示

验收：

- prompt 明确冻结合同
- prompt 明确预算和超时
- prompt 明确验收和报告阻塞
- tool 返回错误时给出下一步

### 阶段 G：真实场景验证

内容：

- mock 确定性回归
- queue cancel 回归
- AgentTeam workflow 回归
- 真实 LLM P1/P2/P3 E2E

验收：

- P1 简单任务：Lead 直接完成、零子任务
- P2 专业任务：1–3 个子任务、worker 交付、Lead 验收
- P3 群聊任务：单 root、预算受限、最终有界关闭
- 不再出现 10 个子任务和多个同源 root

---

## 16. 测试矩阵

| 测试项 | 层级 | 关键断言 |
|---|---|---|
| 状态机合法迁移 | TaskEngine | 现有状态语义不回归 |
| 同父同标题防重 | TaskEngine | 保留原有行为 |
| 改标题突破预算 | TaskEngine | 拒绝创建 |
| 取消后重派 | TaskEngine | 消耗 canceled/total budget |
| reassign 原 task | TaskEngine | 不增加 child count |
| 嵌套孙任务 | TaskEngine | depth=1 后拒绝 |
| source message root idempotency | DB/Manager | 不产生第二 root |
| 不同 source message | DB/Manager | 允许不同 root |
| 取消 parent cascade | Manager/TaskEngine | 后代全部 terminal |
| 排队 B cancel | AgentRuntime | A 不被 abort |
| 迟到 artifact | AgentRuntime/TaskEngine | CANCELED 不被污染 |
| cancel control message | AgentRuntime | 不启动 harness |
| root timeout | Scheduler | root/children 关闭且不 retry |
| finite loop | Scheduler | 没有无限重放 |
| worker roster cap | Manager | 禁用成员仍计数 |
| 正常简单任务 | E2E | Lead 直接完成 |
| 正常专业任务 | E2E | 1–3 child 正常收口 |
| P3 复现 | E2E | root 和 child 都有上界 |

测试运行命令：

```powershell
pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-task-engine.ts
pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-agent-runtime.ts
pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-agentteam-workflow.ts
pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-task-queue.ts
pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-agentteam-task-flow-real.ts
node scripts/e2e-agentteam-real-triage.mjs
pnpm typecheck
pnpm lint
```

真实 Harness E2E 受本机 harness、模型、网络和运行时配置影响，不能替代 TaskEngine 确定性测试。

---

## 17. 兼容性与迁移风险

### 17.1 旧任务

旧任务没有 source chat ID：

- 不回填
- 不强行合并
- 继续按 task ID 管理
- 参与新预算统计
- 已有 10 个子任务的旧根任务不能因为迁移自动删除

### 17.2 已超预算的旧根

旧根任务如果迁移后已经超过新预算：

- 不回滚历史
- 不删除历史任务
- 禁止继续新增子任务
- 允许 Lead 验收已有可接受成果
- 允许对 FAILED 原 task 做有限 retry/reassign
- 必要时由用户显式关闭

### 17.3 已超 worker 上限的旧 Channel

- 不自动删 worker
- 不自动取消 worker 任务
- 新增 worker 直接拒绝
- 旧成员仍可执行现有任务

### 17.4 模式任务兼容

旧 loop 任务如果没有 `maxIterations`：

- 迁移后不立即破坏正在运行的旧 loop
- 新建 loop 必须提供有限预算
- 旧 loop 需要通过兼容 deadline 或用户重新配置完成收口
- 后续版本可以逐步移除 Infinity 默认值

---

## 18. 可观测性与错误报告

所有预算拒绝和自动关闭都应有：

- task event
- close reason
- 操作者或触发源
- root task ID
- 当前预算计数
- deadline
- 被影响 task IDs
- 被 abort 的 assignee IDs

建议事件 metadata：

```json
{
  "rootTaskId": "...",
  "reason": "ROOT_TIMEOUT",
  "source": "scheduler",
  "budget": {
    "descendants": 6,
    "active": 4,
    "canceled": 3
  },
  "affectedTaskIds": ["..."],
  "affectedAgentIds": ["..."]
}
```

这样可以直接回答：

- 为什么没有继续派发？
- 是谁取消了任务？
- 为什么 worker 停止？
- 哪些任务被级联关闭？
- 当前根任务还剩多少预算？

---

## 19. 回滚策略

每个实施阶段必须可独立回滚。

### 代码回滚

- 配置有安全默认值
- policy 模块可通过 feature flag 关闭强限制，但不关闭终态和取消安全保护
- 不删除历史字段
- 不删除历史任务

### 数据库回滚

新增字段采用 nullable/default，不破坏旧版本读取。

如果需要暂时回退代码：

- source ID 字段可被旧代码忽略
- close_reason 可被旧代码忽略
- deadline_at 可被旧代码忽略
- unique index 必须确认旧代码不会尝试重复创建同 source root

数据库迁移本身不做破坏性删除。

---

## 20. 最终验收标准

本计划实施完成后，必须同时满足：

### 正确性

- 同一 source chat message 不会产生多个根任务。
- 不同标题不能绕过根任务预算。
- 普通根任务最多 6 个累计后代。
- 同时未结束后代最多 4 个。
- 取消预算最多 3 个。
- 普通任务不允许超过一级嵌套。
- Lead 动态 worker 数量受 per-channel 上限约束。

### 生命周期

- 取消父任务会同步关闭所有活动后代。
- 取消排队任务不会误中断另一个运行任务。
- CANCELED 任务不会继续执行或被迟到事件复活。
- 超时根任务不会继续 retry/reassign。
- COMPLETED 仍然只表示真正验收通过。

### 正常场景无回归

- 简单任务仍由 Lead 直接完成。
- 1–3 个子任务的历史正常场景仍然成功。
- worker 失败后仍可复用原 task 重派。
- goal/pipeline/loop 的核心语义保持不变。
- Channel、Agent、Mailbox、A2A 权限边界不被放宽。

### 事故复现闭环

使用 2026-09-23 的日志清理场景重跑后，应满足：

```text
根任务数量：1
累计子任务：<= 6
CANCELED 子任务：<= 3
同一时刻 active 子任务：<= 4
超过预算后 Lead 不再产生新 task
根任务在 deadline 内 COMPLETED，或在 deadline 后明确 FAILED/CANCELED
所有被关闭的任务都不再运行
```

---

## 21. 实施前的工程纪律

1. 等当前文件拆分完全稳定后再修改代码。
2. 每阶段只修改本方案列出的 AgentTeam 相关文件。
3. 不触碰论文、UI、工业控制、AML、插件等无关改动。
4. 先写/扩展确定性测试，再实现对应逻辑，或至少同一阶段完成测试。
5. 每完成一个阶段立即运行目标测试。
6. 代码作者与验证作者分离；实施后进行独立 review。
7. 不以“模型应该遵守 prompt”作为验收依据。
8. 不以“任务最后没报错”作为收口依据；必须验证 task 状态、子任务树、运行时状态和事件记录。

---

## 22. 当前状态与下一步

当前状态：

```text
设计确认：完成
代码修改：未开始
数据库迁移：未开始
测试补丁：未开始
```

下一步执行顺序：

1. 确认工作区拆分结束。
2. 记录并重新运行当前基线测试。
3. 实施数据库字段和配置阶段。
4. 实施 source chat root idempotency。
5. 实施 TaskEngine quota policy。
6. 实施 cancelTree 和 task-scoped abort。
7. 实施 root timeout 和 mode budget。
8. 更新 Lead prompt/tool descriptions。
9. 运行确定性测试和真实 AgentTeam E2E。
10. 使用独立 verifier 对照本文的最终验收标准复核。

本文是后续代码实施的唯一设计依据；如果实施中发现与当前代码结构冲突，应先更新本文或补充 ADR，再修改实现，禁止在代码中临时改变任务语义。


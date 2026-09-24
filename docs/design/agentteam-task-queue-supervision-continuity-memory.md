# AgentTeam 根任务队列、监督 Watchdog、Harness 连续性与 Channel 记忆优化实施方案

> 设计日期：2026-09-24  
> 设计状态：已确认，进入实施阶段  
> 适用范围：AgentTeam 任务创建、根任务排队、Leader 监督、worker 协同、Harness/OMP 会话生命周期、Channel 过程记忆、前后端展示与真实 OMP E2E  
> 前置设计：`docs/design/agentteam-task-control-optimization.md`

---

## 0. 本轮已确认的产品语义

### 0.1 同一来源消息与根任务

`(channel_id, source_chat_message_id)` 是根任务幂等键：

- 同一个 Channel、同一条来源消息只能有一个根任务；Lead 改标题、重复 submit、重复投递都返回原根任务。
- 即使原根任务已经 `COMPLETED`、`FAILED` 或 `CANCELED`，仍然返回原根任务，不因为重复投递而创建第二个根任务。
- 不同来源消息可以在同一个 Channel 创建不同根任务。
- `source_chat_delivery_id` 仅用于投递审计，不参与根任务唯一性。
- 需要重新执行时复用原任务/原任务树的 retry/attempt 语义；真正的新需求必须产生新的来源消息。

因此，Channel 不是只能有一个根任务，而是：

```text
同一来源消息 -> 一个 canonical root
同一 Channel -> 可以有多个 roots
多个 roots -> 按 FIFO 排队
```

### 0.2 根任务队列

默认采用“单活跃根任务、内部 worker 并行”的策略：

- 一个 Channel 同时只有一个 `activeRoot` 被 Leader 规划、派发、验收。
- activeRoot 内可以并行派发多个 worker 子任务。
- 后续不同来源消息创建的根任务进入 `QUEUED` 逻辑队列，不提前被 Lead 拆分。
- activeRoot 进入终态后，最早的下一个非终态 root 自动晋升为 activeRoot。
- 不重启 Channel、不重启 Leader Harness、不丢失 Channel 上下文。

### 0.3 Supervise watchdog

`superviseWatchdogMs` 是观察阈值，不是任务取消阈值：

- 达到默认 90 秒时只记录 watchdog 信号。
- 不发送 OMP `abort`。
- 不取消任务。
- 不重新派发任务。
- 不重启 OMP。
- 不启动第二个并发 Lead session。
- 支持安全 steer 的 Harness 向当前 Lead session 注入结构化监督提示；不支持 steer 的 Harness 等当前回合结束后再处理。
- 根任务绝对 deadline 仍然是最终安全边界；用户/HITL cancel、Runtime stop、Harness 崩溃仍可硬中断。

### 0.4 Harness 连续性

- OMP、OpenCode、Codex、DSH、Claude 等持久型 Harness 在任务或队列未空闲前复用同一 Runtime、进程和 session/thread。
- 只有进程退出、RPC 断裂、明确 stop/kill、服务重启或明确检测到不可恢复僵死时才创建新会话。
- 一次性 CLI Harness 明确标记为 `per_turn`，平台不虚假承诺同进程复用。
- Worker 即使短暂进入 runtime `idle`，只要仍有非终态任务或 pending mailbox，也不得被卸载。

### 0.5 记忆

- 不记录 token 流和每一次轮询。
- 记录根任务和子任务的关键状态变化、dispatch、artifact、worker 报告、Lead 决策、watchdog、Harness 重启和最终结果。
- 同一 Channel 的 Agent 可读取 Channel shared memory。
- 跨 Channel 查询默认只允许 Leader，范围仍限制在同一用户/同一组织可见的 Channel。
- 记忆写入采用幂等 key、节流和失败重试；向量失败不影响 FTS 和任务主流程。

---

## 1. 目标与不变量

### 1.1 必须成立的不变量

1. 同一来源消息永远不会产生两个 canonical root。
2. 不同来源消息即使标题相同，也可以形成不同 root。
3. activeRoot 之外的 root 不得被 Lead 提前 dispatch。
4. activeRoot 完成后，队列自动推进到下一个 root。
5. 同一 Lead Runtime 同时最多只有一个 supervise attempt。
6. watchdog 不等价于 abort；Lead 必须拥有 wait/guide/reassign/cancel/complete 决策权。
7. task cancel 只中断对应 task 的执行，不误杀同一 Agent 的其他任务。
8. 旧 worker 的迟到结果不能覆盖重新分配后的新执行结果。
9. 活跃任务未完成前不得因为 runtime 短暂 idle 而卸载 Harness。
10. 正常 watchdog、队列推进和任务完成不启动新的 OMP 进程。
11. 任务终态之后产生一条 canonical summary；关键过程产生有限的过程摘要。
12. 前端显示的 root、监督状态、Harness session 和 memory 均来自后端事实源。

### 1.2 非目标

本阶段不做：

- 不把所有 Harness 都重写为持久进程；一次性 Harness 保持 `per_turn` 能力声明。
- 不改变工业控制、DAQ、AML、插件等无关业务。
- 不把 watchdog 自动升级为自动取消。
- 不允许 Lead 通过改标题、换 assignee、创建新 root 绕过根任务预算。
- 不记录大段原始模型流作为长期记忆。

---

## 2. 目标数据模型

### 2.1 Task 扩展

为 root 增加确定性的队列序号：

```text
root_queue_seq INTEGER NULL
```

只对 root 赋值，子任务为 NULL。约束：

```text
UNIQUE(channel_id, root_queue_seq)
```

保留已有字段：

```text
source_chat_message_id
source_chat_delivery_id
close_reason
deadline_at
```

为执行交接增加：

```text
assignment_generation INTEGER NOT NULL DEFAULT 0
execution_lease_id TEXT NULL
execution_lease_agent_id TEXT NULL
execution_lease_started_at TEXT NULL
execution_lease_revoked_at TEXT NULL
```

这些字段用于拒绝旧 worker 的迟到事件，不改变现有任务状态枚举。

### 2.2 Root Queue View

后端统一派生：

```ts
interface RootQueueView {
  activeRootId: string | null
  activeRoot: WorkspaceTask | null
  queuedRoots: Array<{
    task: WorkspaceTask
    position: number
  }>
  completedRoots: number
}
```

activeRoot 的选择规则：

1. `parentId IS NULL`；
2. 状态不是 `COMPLETED / FAILED / CANCELED`；
3. `root_queue_seq ASC`；
4. `id ASC` 作为稳定 tie-breaker。

### 2.3 Supervision Attempt

运行时状态和必要的审计字段：

```text
attempt_id
channel_id
lead_agent_id
active_root_id
snapshot_revision
state
started_at
watchdog_at
completed_at
watchdog_count
last_signal_at
last_decision_kind
```

第一阶段可以先使用 Runtime 内存状态 + task history/control event；如果验证需要跨重启恢复，再落独立表。根任务 deadline、任务历史和 memory outbox 必须持久化。

### 2.4 Harness Continuity Lease

Runtime 层维护：

```text
lease_id
agent_id
channel_id
harness
continuity_mode: persistent | per_turn
pid
session_id / thread_id
active_task_ids
active_supervision_attempt
last_used_at
idle_grace_until
last_restart_reason
reuse_count
```

对前端以只读 DTO 暴露，不暴露凭据和完整内部 prompt。

---

## 3. 根任务创建与队列设计

### 3.1 原子 create-or-get

新增 TaskRepo/TaskEngine 统一入口：

```text
createOrGetRoot(input) -> { task, created }
```

有 `sourceChatMessageId` 时：

1. 先以数据库唯一索引尝试插入；
2. 唯一冲突时按 `(channelId, sourceChatMessageId)` 查询 canonical root；
3. 返回原 root，不比较标题、不覆盖原内容、不改变队列顺序；
4. 返回 `created=false`。

没有 source ID 的旧入口：

- Chat-originated 请求拒绝创建并返回明确错误；
- 非 Chat 系统请求必须提供显式 `clientRequestId`/`idempotencyKey`；
- 标题只能作为展示字段，不能作为强身份。

### 3.2 所有入口统一

以下入口必须最终调用同一个 create-or-get 语义：

- Lead `submit_task` host tool；
- AgentWorkspace `submitTask`；
- 管理端/HITL 创建 root；
- 未来的 schedule/automation root 创建。

Host tool 不再使用“先 list 再 create”作为正确性保障。

### 3.3 Dispatch 闸门

`TaskEngine.dispatch()` 最终校验：

- parent 属于 activeRoot；
- parent 未终态；
- 根任务深度、子任务累计数、active 数、取消数仍满足预算；
- 同父同标题在途任务仍然判重；
- 创建 child、创建 assign message、父任务转 WAITING 要么在同一事务中完成，要么失败时执行补偿清理。

### 3.4 Root 晋升

根任务进入终态后：

1. 更新任务和 memory outbox；
2. 重新计算 activeRoot；
3. 广播 root queue 变化；
4. 唤醒 Leader Scheduler；
5. Leader 只接收新 activeRoot 的规划上下文；
6. 仍复用现有 Leader Runtime/Harness。

---

## 4. Supervise Watchdog 与 Lead 决策

### 4.1 单飞与非破坏 watchdog

同一 Lead Runtime 只能存在一个 supervision attempt：

```text
IDLE -> RUNNING -> WATCHDOG_SIGNALED -> WAITING_FOR_RESULT -> DECISION_APPLIED -> IDLE
```

显式 stop/cancel 才允许：

```text
RUNNING -> ABORT_REQUESTED -> ABORTED
```

watchdog 不调用：

```text
AbortController.abort()
client.send({ type: 'abort' })
killProcess()
new_session()
```

### 4.2 scheduler 解耦

将 scheduler 分为：

```text
observe phase
  - 采集 worker/task/mail 状态
  - 更新停滞基线
  - 记录 watchdog
  - 检查 root deadline

supervision phase
  - 确保同一 Lead 只有一个 attempt
  - 启动或继续当前 Lead 回合
  - 只在结果返回后应用决策

apply phase
  - 短锁执行 dispatch/reassign/cancel/complete/guide
  - 校验 snapshot revision 和 task generation
```

不得因为 watchdog 另起第二个 Lead prompt。

### 4.3 Lead 决策类型

增加：

```text
wait(rootId?, reason)
guide(taskId, toAgentId, message)
reassign(taskId, toAgentId, reason)
cancel(taskId, reason)
```

保留：

```text
dispatch
complete
notify
spawn_agent
update_agent
remove_agent
```

Lead prompt 必须明确：

- 当前只处理 activeRoot；
- queued root 不得提前 dispatch；
- watchdog 只需要判断是否 wait/guide/reassign/cancel；
- 冻结任务契约后不应通过改标题重派；
- `wait` 是合法完成的监督决策，不是空输出错误。

### 4.4 Root deadline

继续保留 root absolute deadline 作为最终安全边界：

- 90 秒：只提醒；
- 15 分钟：任务树硬收口；
- explicit cancel：立即 task-local abort；
- Harness failure：按 Harness 恢复策略处理。

---

## 5. Task Execution Lease 与 Reassign

### 5.1 任务执行代次

每次新分配/重分配生成新的：

```text
assignmentGeneration
executionLeaseId
```

worker 消息、artifact、progress、complete、failed 事件都携带 generation/lease。

### 5.2 运行中 reassign

Lead 显式执行时：

1. 原子撤销旧 lease；
2. generation + 1；
3. 将旧 worker 的任务回合 task-local abort；
4. 旧 worker 的晚到事件全部被丢弃；
5. 新 worker 收到新的 assign；
6. 新 worker 以新 generation 开始执行。

不允许 watchdog 自己触发 reassign。

---

## 6. Harness 连续性与 OMP 复用

### 6.1 Runtime 卸载闸门

任何角色都必须满足以下条件后才能卸载：

```text
runtime idle
无 pending mailbox
无 active supervise attempt
无非终态 task
超过 idle grace
```

即使 Runtime 短暂 idle，只要 task 仍为 `SUBMITTED/ASSIGNED/WORKING/WAITING`，仍保持 Harness lease。

### 6.2 持久型 Harness

OMP 具体规则：

- supervise watchdog 不 abort、不 kill、不清 client；
- worker 任务和 Lead supervise 继续使用同一 `OmpRpcClient`；
- 记录 pid/session identity；
- prompt fail、RPC 断裂、进程退出时才创建新 client；
- 任何重启都记录 `lastRestartReason`；
- 同一个 Channel/Agent 在队列未空闲前不反复启动新进程。

### 6.3 一次性 Harness

registry 必须明确：

```text
continuityMode = per_turn
```

该模式不被误报为 persistent；任务控制、队列和内存语义仍一致，但进程级复用不做虚假承诺。

### 6.4 服务重启

服务重启后：

- 恢复数据库任务、消息和 memory outbox；
- 尝试恢复可恢复 session；
- 不保证旧子进程仍可用；
- 若必须创建新 Harness，记录 `SERVER_RESTART`；
- 不创建新 root，不改变 root queue 顺序。

---

## 7. Channel 过程记忆

### 7.1 事件来源

接入以下事件：

```text
root.created
root.activated
root.queued
child.dispatched
child.assigned
child.started
child.progress milestone
child.artifact
child.completed
child.failed
lead.wait
lead.guide
lead.reassign
lead.cancel
supervise.watchdog
harness.restarted
root.completed
root.failed
root.canceled
```

### 7.2 摘要策略

采用确定性短摘要为主，避免额外 LLM 成本：

```text
任务 / root / 事件 / 执行者 / 状态 / 结论 / artifact / 下一步 / 时间
```

每个 task：

- 同一事件类型默认 30 秒内最多写一次；
- 单条摘要限制 800~1200 字；
- progress 只记录关键里程碑；
- root 终态写一条 canonical summary。

### 7.3 Outbox 与可靠写入

任务状态变化时同步写 memory outbox：

```text
memory_outbox(
  event_id,
  channel_id,
  task_id,
  root_id,
  kind,
  payload,
  status,
  retry_count,
  last_error,
  created_at,
  updated_at
)
```

后台消费：

1. upsert shared memory；
2. FTS 成功即可认为可用；
3. 向量化失败降级为 FTS；
4. 失败重试并保留 last_error；
5. 定期清理已完成且过期的 outbox。

### 7.4 访问策略

- 当前 Channel：Lead 与 worker 可查 shared memory；
- 其他 Channel：只允许 Leader 查询；
- 仍受同一 owner/组织范围限制；
- memory DTO 必须带来源 Channel、root/task、时间、可见性。

---

## 8. 前端与 WS

增加：

- root queue：active/queued/completed；
- root position、activeRootId、queue sequence；
- supervision attempt/watchdog 状态；
- Lead 最后决策；
- Harness continuity mode、pid/session、reuse count、last restart reason；
- Channel memory timeline 和跨 Channel 来源标识。

前端操作规则：

- queued root 可查看、取消、调整优先级（如果后续开放）；
- 不允许前端绕过来源幂等直接创建重复 root；
- cancel/retry/reassign 后重新拉取 authoritative task/channel snapshot；
- task detail 必须携带 channelId + taskId，避免跨 Channel 串详情。

---

## 9. 实施顺序

### Phase 1：文档与契约

- 固化本方案；
- 更新 task/runtime/protocol 类型；
- 增加迁移设计和兼容策略。

### Phase 2：根任务原子创建与 FIFO

- schema/migration/repo；
- createOrGetRoot；
- activeRoot/queuedRoots；
- scheduler 只规划 activeRoot；
- dispatch activeRoot 闸门；
- source/delivery 语义统一；
- 增加确定性测试。

### Phase 3：supervise watchdog

- watchdog signal；
- supervision attempt 状态；
- 不 abort OMP；
- wait/guide/reassign/cancel；
- scheduler observe/supervise/apply 分离；
- deadline 和 explicit cancel 继续硬收口。

### Phase 4：execution lease 与 Harness continuity

- assignment generation；
- running reassign fencing；
- runtime unload 修复；
- OMP PID/session continuity；
- registry capability；
- 其他 Harness 适配。

### Phase 5：Channel memory

- event bridge；
- memory outbox；
- shared summaries；
- cross-channel Leader-only 访问；
- 记忆维护与失败重试。

### Phase 6：前端与真实 E2E

- queue/watchdog/session/memory UI；
- mock deterministic tests；
- real OMP two-worker tests；
- same Channel 多根任务 FIFO 测试；
- watchdog no-abort / same pid-session 测试；
- cancel/reassign/session reuse 测试。

---

## 10. 验收测试矩阵

### Root identity

1. 同 source、不同标题 -> 同 root。
2. 同 source、root 已完成 -> 同 root。
3. 不同 source、相同标题 -> 两个 root。
4. 同 source 并发提交 -> 一个 root，另一请求返回 canonical root。
5. source delivery 不同 -> 不创建第二 root。
6. 无 source 的 chat root -> 明确拒绝或要求 request key。

### Root queue

1. M1 创建 R1，M2 创建 R2。
2. R1 active，R2 queued。
3. R1 内 worker 可并行。
4. R2 不提前 dispatch。
5. R1 完成后 R2 自动 active。
6. Leader Harness 不重启。

### Watchdog

1. 90 秒不发 OMP abort。
2. 不改变 task state。
3. 不创建第二 supervise attempt。
4. Lead 可以 wait。
5. Lead 可以 guide。
6. Lead 可以显式 reassign。
7. Lead 可以显式 cancel。
8. root deadline 可以最终硬收口。

### Session continuity

1. 同一 OMP Agent 多任务使用相同 pid/session。
2. worker runtime 短暂 idle 但有 WORKING task 时不卸载。
3. task cancel 只 abort 对应 task。
4. queue 非空时不卸载。
5. prompt fail 后才创建新 client，并记录原因。
6. per_turn Harness 不被错误标记为 persistent。

### Memory

1. dispatch 有共享摘要。
2. worker 完成有共享摘要。
3. watchdog 有共享摘要。
4. root 完成有 canonical summary。
5. 同 Channel Agent 能查询。
6. 其他 Leader 能查询。
7. 普通 worker 不能越权查询其他 Channel。
8. 向量失败时 FTS 仍可查询。
9. outbox 失败可重试且不重复写。

### Real OMP

1. 简单任务 Lead 直接完成。
2. 复杂任务 Lead 派两个 worker。
3. 同一 Channel 后续消息进入队列。
4. 90 秒 watchdog 不启动新 OMP。
5. R1 完成后复用原 Lead/worker session 处理 R2。
6. 任务取消后不误杀其他任务。
7. 全部空闲后才关闭 Harness。

---

## 11. 风险、回滚与观测

### 主要风险

- 取消 watchdog abort 后，Lead 可能长时间不返回；由 root deadline 和 active supervision attempt 上限兜底。
- 严格 FIFO 会降低多个独立 root 的吞吐；后续可增加显式 `maxActiveRoots`，不能隐式并发。
- running reassign 需要 generation fencing，否则旧 worker 结果污染新任务。
- memory outbox 增加写入量，需要 TTL 和容量限制。
- 一次性 Harness 无法实现真正进程复用，只能明确暴露能力差异。

### 观测指标

```text
root_queue_depth
root_wait_ms
supervision_watchdog_count
supervision_attempt_age_ms
supervision_decision_latency_ms
harness_reuse_count
harness_restart_count_by_reason
active_execution_leases
memory_outbox_pending
memory_outbox_failed
```

### 回滚

所有新策略由配置开关保护：

```yaml
root_queue_enabled: true
supervise_watchdog_only: true
harness_continuity_enabled: true
channel_memory_digest_enabled: true
```

出现异常时可逐项关闭新行为，但不能关闭数据库 source unique index 和任务 terminal fencing。

---

## 12. 本阶段执行边界

本方案在当前工作树已有第一阶段改动上增量实施，不撤销论文、bench、AML、工业插件及其他无关修改。每个阶段完成后运行：

```powershell
pnpm exec tsc -p .nuxt/tsconfig.server.json --noEmit --pretty false
pnpm typecheck
pnpm exec eslint <changed-files>
pnpm build
```

并运行 AgentTeam 定向测试和真实 OMP E2E。最终以：

- 源码审查；
- 类型检查；
- ESLint；
- Build；
- deterministic tests；
- real OMP E2E；

共同作为完成证据。

---

## 13. 实施状态（第二轮补齐，2026-09-24）

第一轮已落地 §0–§4（根任务幂等、FIFO 队列、非破坏 watchdog、Lead wait/guide/reassign/cancel 决策、root deadline）。
第二轮按本文档逐条复核后补齐以下缺口：

### 13.1 数据模型与执行租约（§2.1 / §5）

| 项 | 落点 |
| --- | --- |
| `assignment_generation` / `execution_lease_id` / `execution_lease_agent_id` / `execution_lease_started_at` / `execution_lease_revoked_at` | `db/database/schema.ts`、`db/schema.sql`、`db/database/migrations.ts`（`migrateAgentTeamExecutionLeaseColumns`，含两次 tasks 重建的列清单对齐） |
| 新分配/重分配换发 generation + lease | `runtime/task-engine/lease.ts`（`issueLeaseFields` / `fenceMatches` / `fenceFromMetadata`） |
| 事件携带栅栏 | `deliverTaskMessage` 写 `x-aw-assignment-generation` / `x-aw-execution-lease-id` |
| 迟到事件丢弃 | `TaskEngine.applyEvent(taskId, event, fence)` + `AgentRuntime.processMessage` 的投递准入 |
| 运行中 reassign（§5.2 六步） | `TaskEngine.reassignRunning`；调度器 `case 'reassign'` 与 `manager.reassignTask` 对 WORKING/WAITING 走该路径并对旧 worker 执行 task-local abort |
| 终态撤销租约 | `TaskEngine.transition` 写 `execution_lease_revoked_at` |

兼容性：历史任务无 lease 时栅栏一律放行（`fenceMatches` 的 `!task.executionLeaseId` 分支），升级瞬间不会丢弃在途 worker 事件。

### 13.2 完整性修复（审计发现的真实缺陷）

1. **root 漏号**：`manager/tasks.ts` 在「人类直发 worker」时显式传 `rootQueueSeq: null`，被 `listRoots` 的 `root_queue_seq IS NOT NULL` 过滤 → `activeRootId` 变 null、FIFO 准入与调度器 activeRoot 守卫同时失效，而前端仍显示为 active。现在所有 root 一律发号（`task.repo.ts` 对 `null` 也补号）。
2. **lead runtime 永不卸载**：`supervisionAttempt.state` 落定后停在 `DECISION_APPLIED`，而 `unloadAgent` 判据是 `state !== 'IDLE'` → §6.1 闸门永久为假。现在按 §4.1 状态机落定后回到 `IDLE`，审计信息保留在 `completedAt` / `lastDecisionKind` / `watchdogCount`，卸载判据改用 `hasActiveSupervisionAttempt()`。
3. **artifact 不可见**：`applyEvent` 只在 progress 变化时广播，非 append 且未声明 `totalChunks` 的交付物既不更新进度也不广播 → 过程记忆永远看不到 artifact。现在 artifact 无条件广播（`progress` 仅在真变化时进入载荷，保持既有「变化才发进度帧」口径）。
4. **canonical root summary 是死代码**：`recordTeamTaskTerminal` 全仓无调用者。现在在 root 终态分支接回，并把「结论」改为 `交付物摘要 → closeReason → routeReason` 优先级。
5. **§7.1 事件契约缺失**：19 个事件被压成 8 个中文状态标签，且子任务的 `SUBMITTED` 被错标成「根任务进入队列」。现在 `canonicalEventType` 按 `nodeRole` + 事件语义派生出文档逐字事件名（含 `root.queued` 判定与 `child.artifact`），payload 增加 `rootId/nodeRole/eventType/artifact/nextStep/at`。
6. **§7.2 节流口径**：milestone 编入节流键导致「同一事件类型 30s 内最多一次」失效（10%→90% 会写 8 行）。现在节流键只含事件类型，milestone 只进 dedupKey；节流表加了容量裁剪。
7. **§7.2 长度口径**：`CONTENT_STORE_LIMIT=800` 截断施加在 CJK 切分**之后**（≈267 汉字）。现在先按原文截到 1200 字再切分。
8. **§7.3 outbox 失败不可见**：`markFailed` / `reschedule` 全仓无调用者，失败只打日志且重试节奏跟着 6h 的 `memory.maintenance_ms`。现在失败写 `last_error` + `attempts`，超阈值转 `failed` 死信；新增 30s 独立补偿 worker（`runOutboxCompensation`）、`sweepFailed` 死信保留期清理，并把 `outbox.counts()` 接进监控快照。
9. **§7.4 NULL owner 越权**：`otherSameOwnerChannels` 原判据「任一 NULL owner 即放行」使遗留无主 channel 可被任意 Lead 读取。现在要求双方 owner 非空且相等。
10. **§7.4 DTO 缺字段**：同 channel 与跨 Channel 记忆 DTO 补齐 `channelId/taskId/rootId/visibility/createdAt`，工具输出同步渲染来源。

### 13.3 Harness 连续性与观测（§6 / §11）

| 项 | 落点 |
| --- | --- |
| `continuityMode: persistent / per_turn` | `agents/registry.ts`；6 个一次性 CLI（gemini/copilot/cursor/crush/goose/pi）标 `per_turn`，omp/opencode/codex/dsh/claude/qwen/hermes/mock 标 `persistent`，`harnessMetas()` 一并导出 |
| 连续性租约（§2.4 只读 DTO） | `AgentRuntime.getContinuity()`：leaseId / continuityMode / pid / sessionId / reuseCount / activeTaskIds / lastUsedAt / idleGraceUntil / lastRestartReason / restartCount / harnessRestartCounts |
| `lastRestartReason` | OMP 四处 client 重建点写 `PROCESS_EXIT` / `PROMPT_FAIL` / `TURN_STALLED`（`takeHarnessRestartReason()` 消费一次）；RPC 断裂由运行时失败归因 |
| `SERVER_RESTART`（§6.4） | `restore()` 对仍在恢复的 channel 调 `markServerRestart()`，并先跑一次 outbox 补偿（不再等 6h 周期） |
| §11 观测指标 | `manager.collectAgentTeamMetrics()`：root_queue_depth / root_wait_ms / supervision_watchdog_count / supervision_attempt_age_ms / harness_reuse_count / harness_restart_count_by_reason / active_execution_leases / memory_outbox_pending / memory_outbox_failed，全部挂在 `GET /api/system/monitor` 的 `agentTeam` 上 |

### 13.4 前端与 WS（§8）

- `channel.snapshot.rootQueue` 与新增 `root.queue` 帧（§3.4-3，root 状态变化即广播）落 store；`activeRootId` / 排队位次 / completed 计数全部来自后端权威投影，前端不再自行推导。
- `agent.status` 的 `supervision` / `continuity` 以前端 reducer 丢失的缺陷修复；泳道列头新增 watchdog、Lead 最后决策、continuity/pid/reuse/last-restart 徽标。
- `MemoryPanel` 增加时间轴元信息（时间 / 可见性 / root / task 来源标识）。
- `GET /api/workshop/tasks/:id` 支持 `channelId` 强校验，抽屉请求携带 channelId，切频道后残留 taskId 返回 404 而不是串详情。

### 13.5 回滚开关（§11）

`workshop.root_queue_enabled` / `workshop.supervise_watchdog_only` / `workshop.harness_continuity_enabled` / `workshop.channel_memory_digest_enabled`
（`shared/config/schema.json` + `app/config/schema.ts` + `server/services/workshop/settings.ts` 三处一致）。
三项只关闭**新行为**，不关闭 `(channel_id, source_chat_message_id)` 唯一索引与任务终态设防——那两条是正确性底线。
另新增 `workshop.supervise_watchdog_ms`（默认 90s）与 `workshop.supervise_hard_timeout_ms`（默认 900s，仅作监督回合硬安全边界）。

### 13.6 验证证据

```powershell
pnpm exec tsc -p .nuxt/tsconfig.server.json --noEmit --pretty false   # 通过
pnpm typecheck                                                        # 通过
pnpm exec eslint <changed-files>                                      # 通过
pnpm build                                                            # 通过
tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-task-lease-fencing.ts   # ALL PASS
tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-supervision-watchdog.ts # ALL PASS
tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-agentteam-guardrails.ts # ALL PASS
tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-task-engine.ts          # ALL PASS
tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-agent-runtime.ts        # ALL PASS
tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-scheduler-loop.ts       # ALL PASS
tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-workshop-db.ts          # ALL PASS
```

新增确定性测试 `scripts/test-task-lease-fencing.ts` 覆盖 §2.1 root 发号、§5.1 创建/终态租约、
§5.2 运行中重分配与旧 worker 迟到事件丢弃、assign 投递栅栏、同目标幂等、非运行中拒绝。

未完成（明确保留）：真实 OMP 双 worker E2E（§10 Real OMP 一节）需要真实引擎与模型凭证，
不在本轮 deterministic 验证范围内；`session resume` 仍未持久化（§6.4 只做到如实记录 `SERVER_RESTART`）。


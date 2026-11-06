# Project Router v3 最佳设计计划（2026-11-05）

> 状态：**待用户批准**。本文是设计/实施计划，不是代码变更。
> 基准：`D:/codes/ABO/AgentWorkShop-project` @ `3da5771a`（PR20 Route 闭环 + PR23 多 Channel 协同已合）。
> 输入：4 路独立 Agent 评审（调度/协作契约/前端可观测性/反方治理）+ 当前代码与 Track A–D 证据。
> 结论：**用户方向 70% 采纳、30% 改造**。最佳形态不是“Leader 直接派发 + Leader 自验收”，而是：
> **Leader 做计划/路由评估/技术验收；确定性执行器做派发；Owner/独立 acceptor 做业务签核。**

---

## 0. 一句话结论

把 Project 做成 **“契约图 + 执行图 + 三级验收 + 事件驱动确定性执行器”**：

- **Project/Leader**：评估任务、拆交付物/工作项、在已批准计划内做路由决策、做技术验收/完整性复核。
- **确定性执行器**：按依赖/容量/预算/模式真正派发，保证幂等、可审计、可恢复。
- **Channel**：接 root task，Lead 自主拆 worker，产出真实 artifact/result；跨频道按 handoff 契约接力。
- **Owner/独立 acceptor**：业务签核与项目完成；Leader 不能自批、不能自动完成项目（V1.5）。
- **前端**：五 tab 保留，第二 tab 升级为“执行工作台”；真实展示 计划→工作项→attempt→Channel/root→worker→artifact→result→review→acceptance。

**“Leader 只要看有没有交付内容就标记验收通过”这句话必须改写为“Leader 按 owner 锁定的 acceptanceCriteria 做技术验收；业务签核仍由独立主体完成”。** 否则会制度化“占位交付通过验收”。

---

## 1. 现状判断（代码证据）

### 1.1 已经对的、必须保留

| 资产 | 证据 | 保留理由 |
|---|---|---|
| ProjectService 单一写者 | `service.ts` API/tool 统一入口 | 避免多写者竞态，审计可收口 |
| Leader proposal-only + 工具白名单 | `tool-surface.ts:22-32,97-99`；`execution-gate.ts` | 防止 Leader 越权执行/写库；治理资产 |
| 计划批准 + owner gate | `service.ts:1526-1581`；`service.ts:1049-1111` | 范围/验收标准必须人类锁定 |
| 确定性 route-dispatcher | `route-dispatcher.ts:26-38` | 无第二调度器；可单测、可复现 |
| attempt/result 唯一约束 | `schema.ts:1349-1354,1391-1397` | 并发第一道闸门 |
| write_intent 一次性消费 | `service.ts:1636-1682,1851-1899` | 工业写安全核心 |
| kernel tick + 30s Reconciler + effects/watchdog | `kernel.ts:103-127`；`reconciler.ts`；`effects.ts`；`watchdog.ts` | 兜底/恢复/审计基础 |
| 五 tab UI + 审批/事件读面 | `app/pages/projects/[id].vue` | 治理分层正确，保留骨架 |
| Channel root FIFO + Lead 自治 | `runtime/manager/tasks.ts:143-186`；`task-engine/create.ts:159-164` | Project 不直接调度 worker |

### 1.2 关键缺口（本轮必须解决）

| 缺口 | 现状 | 后果 |
|---|---|---|
| 下游门只看工作项终态 | `route-dispatcher.ts:18,29-34`；`service.ts:550-556` | 上游 result 仍 draft/submitted 时下游就启动；Track D 的 W2/W3 正是如此 |
| 无 handoff 契约 | `submitProjectRoot` 只收 title/brief；`contract_json` 未写入 | 下游拿不到上游 artifact/result；Track D 只是状态接力 |
| 验收门太弱 | `assertAcceptanceGates` 只查 `reviewed + evidence 非空`（`service.ts:1992-2001`） | 占位文本/空 artifact 可通过（Track D/E 实证） |
| 验收不可委派给 Channel/agent | `requireDecider` 只允许 owner/admin/approver **用户**（`service.ts:2220-2225`） | 无法“交给其他 Channel 验收” |
| Leader 无直接通信 | `filterLeaderToolSurface` 只留项目工具；无 `send_message`/`send_cross_channel_message` | Leader 只能间接路由；Channel→Leader 单向 mailbox |
| 完成回调是 tick/30s | `kernel.ts:112`；`reconciler.ts`；`onTaskChange` 即时回调 V1.1（route plan §1.2） | 延迟分钟级；D1 失活时 5–23 分钟 |
| 派发非原子/无容量 | 手 auto 不共用互斥；先读后 await；全量 ready 一次派发 | 重复 root/BLOCKED/孤儿 attempt；Channel 被打满 |
| mode 是装饰字段 | `service.ts:285,1156,1233,1390` 无行为分支 | observe/supervised/auto 无差异 |
| 交付物依赖/版本/supersede 弱 | deliverable `dependsOnJson` 未用；supersedes_id 恒 null；单 result 直接置 deliverable approved | 多 producer/返工/拒后复活等一致性风险 |
| 前端看不到执行链 | 工作项表只有 title/channel/state/budget；事件只有 type/key；仅 mount 加载 | 无法证明“派到哪个 Channel、实际做了什么、成果如何验收” |

---

## 2. 用户设计的采纳/改造

| 用户要求 | 判定 | 最佳落地 |
|---|---|---|
| Project 上层 route，按任务分发到多个 Channel | **采纳** | 保留 ProjectService/RouteDispatcher；Leader 提案 + 确定性执行 |
| Leader 先评估任务、再分发 | **采纳（提案式）** | `project_propose_plan/dispatch/replan/channel` + 新增 `project_propose_route`；不直接写库 |
| 每个任务 Complete 回调 Project | **采纳** | `TaskEngine.onTaskChange` → durable outbox → 定向 reconcile + route loop；tick 兜底 |
| Project 确保交付物验收 | **采纳** | 交付物级 content/technical/business 三态投影 |
| 交给其他 Channel 验收 | **采纳（技术验收）** | 独立 reviewer Channel/agent 做 technical verdict；最终业务签核仍人类 |
| Leader 只管有没有交付内容 | **改造** | 不是“存在即通过”，而是“内容 + owner 锁定的 acceptanceCriteria + 真实证据” |
| Leader 交付没问题就标记项目验收通过 | **改造/分档** | Leader 可自动 technical accept；项目完成需 owner/独立 acceptor；V2 才可 mandate 自动完成 |
| 复杂任务调度 | **采纳** | DAG 校验、容量/预算、重试/返工、死锁/环检测、Channel 熔断 |
| 真正多 Channel 协同 | **采纳（需契约）** | handoff bundle + result lineage + worker artifact 聚合；不是自由聊天 |
| 前端真实展示派发/执行 | **完全采纳** | 执行工作台 + 项目级 snapshot/activity + SSE/轮询 |

**结论：用户设计在响应性/自动化/协同上更好；若字面实现“Leader 自验收 + 存在即通过”则治理倒退。最佳是 Hybrid。**

---

## 3. 目标架构

### 3.1 双图模型

**契约图（Deliverable DAG）**：`project_deliverables` 节点 + `depends_on_json` 边；回答“要交什么、下游何时可启动”。

**执行图（Work Item DAG）**：`project_work_items.depends_on_json`；回答“同一交付物内部先做哪一步”。

规则：
- 工作项属于唯一交付物；跨交付物工作项依赖必须与交付物依赖一致；两图任一有环 → 拒绝计划。
- `W.state=COMPLETED` 只表示“执行完成”，**不等于可被下游消费**；下游消费的是 Result 的技术/业务验收状态。
- 默认 `dependsOn` 满足 = 上游 `ContentOK + TechOK`；strict 项目 = `BizOK`；`CANCELED/SUPERSEDED` 需 owner waiver，不默认放行。

**就绪谓词：**

```
Ready(W) =
  W.state = DRAFT
  ∧ 无 live attempt
  ∧ 所有 W.dependsOn 的上游 TechOK（strict: BizOK）
  ∧ W 所属交付物的所有契约依赖 GateOK
  ∧ 目标 Channel enabled/lead 健康/容量允许
  ∧ 项目容量/预算/模式允许
```

### 3.2 三级验收（核心创新）

| 级别 | 谁 | 判什么 | 写什么 | 放行下游 | 放行项目完成 |
|---|---|---|---|---|---|
| L0 内容检查 | 系统确定性 | task COMPLETED、真实 artifact、evidence provenance、summary/关键字段 | `content_ready`、evidence 行 | 否 | 否 |
| L1 技术验收 | Leader 或独立 reviewer Channel/agent | 是否满足 owner 锁定的 acceptanceCriteria；证据是否支撑 | `reviewed` / `technical_verdict`；deliverable `technical_accepted_at` | 默认是 | 否 |
| L2 业务签核 | Owner/admin/approver（独立于生产者） | 业务/风险/责任 | `deliverable.approved` / `approval` | strict 时是 | 是 |

**对用户要求的落地：**
- Leader 可以“交付内容没问题就标记通过”——但标记的是 **L1 技术验收**，不是 L2 项目完成。
- 项目完成仍需 owner/独立 acceptor 签署；若用户坚持 Leader 自动完成项目，作为 V2 的 `acceptance_policy='leader_autoclose'`，必须：owner mandate + 独立 acceptor + holdback 窗口 + 抽检 + 可撤销。
- `acceptanceCriteria` 必须结构化：`artifact.present`、`json_schema`、`field_equals`、`evidence_provenance`、`text.regex`、`manual.attestation`。Blocking 失败 → 拒绝；unknown → 升级人工，不能当 pass。
- Leader 不能 review 自己作者的结果；不能 approve business；不能 complete project。

### 3.3 Leader Route Gate（可选，默认关闭）

- Leader 工具新增 `project_propose_route`（只对已批准计划内 ready 工作项）：
  - 动作：`dispatch / defer / retry / rework / escalate`
  - 目标 Channel：仅已绑定且容量允许
  - 优先级调整：不改契约
- 执行器校验：工作项存在、依赖满足、Channel 绑定/启用/有 lead、容量/预算、无环；通过后 supervised=owner apply，auto=执行器直接应用，observe=只记录。
- 超时 fallback：Leader 不可用 → 确定性顺序派发，落 `route.fallback`，项目不永久卡住。
- `routeGate` 默认 `none`；复杂/auto 项目显式开启 `leader`。
- **禁止**在 route gate 创建新工作项/改 acceptanceCriteria；那属于 replan + owner 批准。

### 3.4 完成回调（事件推 + 轮询兜底）

- `TaskEngine.onTaskChange` fan-out 注册 Project sink（plugin 注入，避免 runtime 反向依赖 service）。
- 只过滤 `task.source='project'` + 终态/WORKING；写 `project_effects(kind='task_callback', dedupe_key='task-callback:<taskId>:<state>:<attemptNo>')`；handler 重新读 task/attempt，定向 reconcile + route loop。
- 保留 10s kernel tick + 30s Reconciler 作兜底。
- 承诺 **at-least-once + 幂等 = 等效一次**；不承诺严格 exactly-once。
- 修事件类型：`result.submit` → `result.submitted`；补 `work.started`；dispatch payload 加 trigger/deps/planVersion/channel/priority；gate reason 持久化。

### 3.5 中间交付物 / Handoff

- `contract_json`（工作项）落地：
  - `inputs[]`：`fromWorkItemId/resultKey/requireStatus/required/maxBytes`
  - `output.resultKey/kind/jsonSchema/requiredSections/maxBytes`
  - `acceptance[]`：结构化 checks
- `dispatchWorkItemAs` → `submitProjectRoot` 传 `parts`：
  - header：项目目标/交付物/验收标准/attempt/trace/输出契约
  - 上游 `TechOK` result：id/version/channel/summary/evidence refs/digest
  - 全文放 `input` artifact（`ensureDraftFromTask` 已排除 input，不会污染下游成果）
  - 单输入 16KB、总 handoff 64KB；数据与指令分离（防 prompt injection）
- 新增 `project_result_inputs` 血缘；result draft 自动写 consumedInputs；supersede 做影响分析，下游置 REWORK/BLOCKED。
- 版本改为 `(project, deliverable, resultKey)` 单调递增；一个 slot 一个生产者；批准新版本时原子 supersede 旧 approved。
- worker 交付：root 完成时聚合直接子任务 artifact 到 result payload/evidence（只存 ref/id/hash/摘要，不存全文）；failed/superseded 子任务排除。

### 3.6 通信矩阵

| 链路 | 载体 | 说明 |
|---|---|---|
| Leader → 成员 Channel | 新增 `project_messages` + `project_message_channel` | 仅项目 Leader；目标必须本项目绑定 Channel；服务端生成 from；先落库再投 mailbox |
| Channel → Leader | `project_escalate` + `project_messages` | 仅该 Channel Lead；带 workItemId/resultId；超时升级 owner |
| Channel ↔ Channel（同项目） | `project_message_channel` | 双方 Lead；同项目；DB 回查；幂等键；状态变更必须落 project record |
| Channel ↔ Channel（非项目） | 现有 `send_cross_channel_message` | lead-only、同 owner、目标 lead 信箱；保留；修 owner NULL 洞 |
| Leader → 通用 send | **不开放** | 防止刷屏/越权；只用项目作用域工具 |
| worker ↔ worker | `send_message_to_agent` | 仅同 Channel；禁止跨频道 |
| worker → 其他 Channel | **禁止** | 保持隔离 |

原则：**会改变“能否派发/能否验收/谁负责”的信息必须落 `project_*` 表；A2A 只负责唤醒/通知/自由文本。A2A 内容不能作为验收证据。**

### 3.7 调度与可靠性

- 派发：`DRAFT → DISPATCHING`（CAS + attempt 创建）→ `DISPATCHED`；手动/自动共用项目级互斥；失败分类（TRANSIENT/CONTRACT/CONTENT/POLICY/BUDGET）；stale attempt 回收。
- 容量：`maxInFlightPerChannel=1`（匹配 root FIFO）、`maxInFlightPerProject=4`、`maxDispatchPerTick=2`；priority DESC + createdAt ASC + aging；Channel 熔断。
- 重试/返工：`maxAttempts=3`、`maxRework=2`、退避 30s→2m→10m；超限 FAILED + `rework.exhausted`。
- 死锁：计划/工作项 DAG 环/自依赖/缺失依赖拒绝；运行期 `ready 集死锁`/`dependency_stuck`/`waiting_on`（DEPENDENCY/RESULT_SUBMISSION/TECHNICAL_REVIEW/OWNER_SIGNOFF/CHANNEL_BUSY/RETRY_BACKOFF/DEADLOCK）。
- 预算：项目 token/时长/并发/每日派发信封；单项 token 上限；80%/100% 告警；kill switch。
- mode 真实化：observe 只记录；supervised 自动派发但验收/完成由人；auto 在已批准计划内自动 route + 技术验收，业务签核仍人。

### 3.8 前端/可观测性

**保留五 tab，第二 tab 升级为“执行工作台”（执行/计划/路由分段）：**

- 概览：目标/成功标准、执行进度 + 验收进度、风险条、跨频道 relay strip、交付物迷你图。
- 计划与工作：
  - 执行：交付物容器图 + 工作项看板（待派发/执行中/阻塞/待验收/已验收）+ Channel 泳道 + 选中执行链 drawer。
  - 计划：版本/diff/批准人/hash/物化结果。
  - 路由：autoDispatch/plan gate、dispatch log（manual/auto、trigger、deps、attempt、root、latency）、ready/waiting/blocked/retry、Leader 提案/复核/验收请求、ledger/health。
- 交付物：图/列表、成果版本、证据、复核/验收链、相关审批。
- 审批：inbox + 历史、完整 subject/diff、角色化 payload。
- 决策与事件：统一 activity 时间线 + trace inspector + raw audit 抽屉。

**后端读模型：**
- `GET /projects/:id/observability`（snapshot + cursor + access + summary + channels/deliverables/workItems + recentActivity）
- `GET /projects/:id/observability/activity?after=&limit=`（统一时间线，keyset cursor）
- `GET /projects/:id/observability/work-items/:wid`（attempts + taskTree metadata + artifacts + result chain）
- `GET /projects/:id/observability/route`（gate/planVersions/dispatchLog/ready/waiting/blocked/leader ledger）
- `GET /projects/:id/observability/stream`（P3 SSE；polling fallback 永久保留）
- 项目页**禁止**调用 `/channels/:id/tasks` 和全量 `/events`/`/decisions`；首屏 1 个 snapshot + 1 个 activity。
- 后端派生 `stage`（planned/ready/dispatched/running/blocked/completed_pending_result/result_pending_submit/result_pending_review/result_pending_acceptance/accepted），前端不自行拼状态。
- 真实性规则：work item 与 task 状态可能短暂不一致，显示“任务已完成，等待内核对账（≤10s）”；自动派发延迟显示“就绪，等待路由评估（≤10s）”，不显示“未派发/失败”。
- 角色：owner/approver/viewer/leader lens；后端返回 permissions，前端不靠 role 猜；approver/viewer 列表可见 member 项目。
- 实时：P1 游标轮询（2s），P3 项目级 SSE + `Last-Event-ID`/cursor resync；现有 channel WS 不扩展（ACL 不匹配）；SSE 断线/410 重新 snapshot；移动端/light-dark/a11y/状态色 token。

---

## 4. 数据模型/API 变更（摘要）

| 表/对象 | 变更 | 阶段 |
|---|---|---|
| `projects` | `routing_policy_json`（gatePolicy/caps/retry/routeGate/acceptance defaults）；mode 正式生效 | P0/P1 |
| `project_deliverables` | 启用 `depends_on_json`；新增 revision/gatePolicy/productionPolicy/technicalPolicy/businessPolicy/criteria_sha256/content_ready_at/technical_accepted_at/by/business_approved_at/by/current_result_id | P0/P1 |
| `project_work_items` | 正式使用 DISPATCHING/REWORK；contract_json（inputs/output/acceptance）；maxAttempts/attemptCount/acceptedResultId/lastResultStatus/deferredReason/deadlineAt | P0/P1 |
| `project_work_item_attempts` | failureClass/retryable/nextRetryAt/state=RUNNING 投影/lease | P0 |
| `project_results` | planVersion/criteriaCheckJson/technicalVerdictJson/contentSha256/evidenceVerifiedAt/reworkRequired；supersedes_id 正式写入 | P0/P1 |
| 新 `project_result_evidence` | result_id/source_task_id/artifact_id/name/kind/sha256/verified_at | P1 |
| 新 `project_result_inputs` | result_id/input_result_id/input_version/relation | P1 |
| 新 `project_messages` | project_id/from/to/kind/workItemId/resultId/correlation/dedupe/status/reply_due_at/payload | P2 |
| 新 `project_technical_reviews` | result_id/version/reviewer/channel/verdict/checks/evidence refs | P2 |
| `project_effects` | task_callback/dispatch_retry/acceptance_sla；lease/reclaim | P0 |
| `project_approvals` | `deliverable_signoff` kind；kind 分权；strict reviewer != approver | P1/P2 |
| 事件/决策 | `work.started/queued/retry_scheduled/retried/rework/technical_accepted`；`route.proposed/applied/blocked/deadlock/fallback`；`deliverable.content_ready/technical_accepted/approved/reopened`；`message.*`；`acceptance.unknown/override` | P0-P3 |

**API：** 现有写接口基本够；新增 observability snapshot/activity/work-item/task/artifact/route/stream、plan-versions/diff、approval detail、result detail、deliverable signoff、work-item rework/retry；`decideApproval` 决策时重跑门禁；`requestCompletion` 与 decide 都重跑完成门；`supersede` 取消 pending acceptance；result 状态 CAS。

**UI：** 保留五 tab/testid；第二 tab 分段；旧 `/snapshot`、`/events`、`/decisions` 保留一个 release 兼容，UI 不再首屏使用；Track D D9 从文本断言升级为 API↔DOM parity（data-channel-id/task-id/attempt-no/auto/result-id/approval-id）。

---

## 5. 分阶段实施计划

### P0 — 真相与安全（1–2 周）

- 依赖门改为上游 `ContentOK+TechOK`；CANCELED/SUPERSEDED 需 waiver；共享 readiness（手动/auto 同函数）。
- evidence provenance：artifact 必须存在于同项目/同工作项 task；sha256/bytes；拒绝空壳。
- 派发原子性：DISPATCHING claim + CAS + 项目级互斥；失败分类；stale attempt 回收；cancel/dispatch 互斥。
- Task callback sink + durable outbox；tick 兜底；修 `result.submitted`/`work.started`/dispatch payload/gate reason。
- DAG 环/自依赖/缺失依赖；ready 集死锁；waiting_on；Channel/项目容量；mode observe 生效。
- result 状态 CAS；supersede 取消 pending；approved result 禁止重试；完成门 decide 复检。
- 审计 actor kind 修正（owner/approver/leader/channel_lead/worker/system）；关键写+审计同事务。

**Exit gates：** G1 兼容、G2 图正确、G3 门控、G4 回调幂等、G5 并发/取消。旧 Track A–D 在 legacy 模式全绿。

### P1 — 契约图 + Handoff + 血缘（2–3 周）

- contract_json（inputs/output/acceptance）落地；计划/提案/createWorkItem 全支持；legacy 从 dependsOn 派生。
- handoff bundle 注入 downstream root `input` artifact；单输入/总大小限制；数据/指令分离。
- `project_result_inputs` 血缘；result draft 自动 consumedInputs；supersede 影响分析。
- 版本 per `(project, deliverable, resultKey)`；一个 slot 一个生产者；新 approved 原子 supersede 旧 approved。
- 下游可见性按 handoff pin，而不是全项目 approved；reviewer 读取用显式 grant。

**Exit gates：** G3 上游未技术验收 → 下游不派发；G6 handoff 内容真实；G8 跨频道隔离/接力。Track D v2：W2 root 的 `input` 必须含 W1 resultId/version/summary；W1 draft/rejected 时 W2 不派发；W1 supersede 后 W2 REWORK/BLOCKED。

### P2 — Leader Route Gate + 三级验收 + 项目消息 + Worker 聚合（2–3 周）

- `project_propose_route`（dispatch/defer/retry/rework/escalate）；执行器校验；supervised/auto/observe；超时 fallback。
- Leader/独立 reviewer Channel 做 technical verdict；`project_submit_technical_review`；criteria 结构化；blocking/advisory；owner override 留痕。
- `project_messages` + leader↔channel / channel↔channel（同项目）/ channel→leader escalate；DB-backed、服务端 from、幂等、超时。
- worker：项目内 dispatch_task 必须挂 active root；intent_key 防重；root 完成聚合 child artifacts 到 result payload/evidence；failed/superseded 排除。
- approver 按 kind 分权：plan/acceptance 可授权，write_intent/project_complete 仅 owner/admin。

**Exit gates：** G5 验收 provenance/criteria/自批；G7 返工/重试/死锁/容量；G8 多 Channel handoff；G9 Leader/route/mode 治理。

### P3 — 执行工作台 + 实时可观测（2 周）

- observability snapshot/activity/route/work-item/task/artifact API；后端派生 stage/readiness/waitingOn/nextActions。
- 五 tab 第二 tab 执行工作台：交付物图、看板、Channel 泳道、执行链 drawer、路由/leader 视图。
- 游标轮询（2s）→ 项目级 SSE + 重连/resync；保留 polling fallback；角色视图；移动/light-dark/a11y。
- Track D D9 改为 API↔DOM parity；新增 projects-execution.mjs；旧 smoke/interactions 同 PR 迁移。

**Exit gates：** G10 UI/审计；G11 性能/请求预算；G12 回归。

### P4 — V2（后续，4–6 周）

- 多进程 lease/leader election；per-channel 并发 >1；动态 reroute/reassign；Channel 熔断/负载感知；低风险 auto business；program-of-projects。
- 只有 V1.5 运行数据达标（≥30 派发/重规划决策、2 项目、计划接受率 ≥70%、重复派发 0、安全违规 0、人工干预 ≤纯人工 120%）才进入。

---

## 6. 验收 Gate（建议直接作为发布门）

| Gate | 证明 | 通过条件 |
|---|---|---|
| G1 Legacy parity | 旧项目不突变 | `routing_policy=legacy` 下 Track A–D 全绿 |
| G2 Graph correctness | 双图正确 | 环/自依赖/缺失依赖/跨项目依赖拒绝；交付物依赖生效；多 producer resultKey 唯一 |
| G3 Acceptance gating | 下游不看空壳 | 上游 COMPLETED 但 result draft/submitted → 不派发；TechOK → 派发；rejected → 不派发；CANCELED 需 waiver |
| G4 Callback effectively-once | 回调可靠 | 重复 callback 只 1 attempt/result；丢事件由 tick 收敛；p99 < 2s |
| G5 Dispatch atomicity | 不重复/不孤儿 | 手动+auto 并发只 1 live attempt；取消不被覆盖；唯一冲突不清指针；无孤儿 root |
| G6 Handoff content | 真协同 | 下游 root `input` 含上游 resultId/version/evidence；下游无需宽读权限；fan-out/fan-in 正确 |
| G7 Retry/rework/deadlock | 可恢复 | 瞬时失败重试；内容失败 REWORK；超限升级；旧 approved 正确 supersede；死锁/环有可读原因 |
| G8 Multi-channel | 多 Channel | 3 Channel E2E：A→B→A 内容接力、隔离、审计链；无跨频道串台 |
| G9 Route/Governance | Leader 边界 | observe 不自动；supervised owner apply；auto 仅在已批准计划内 route；Leader 不能 approve/complete；approver 分权 |
| G10 UI/Observability | 真实可见 | 五 tab 执行工作台；API↔DOM parity；attempt/root/worker/artifact/result/approval 链；角色/失败原因/等待原因；无 pageerror |
| G11 Performance/Budget | 不失控 | 首屏 1 snapshot + 1 activity；无 `/channels/:id/tasks`；cursor 分页；项目/单项/并发/每日派发预算；kill switch |
| G12 Regression | 不破坏 | Track A/B/C/D、projects-smoke/interactions、line acceptance 更新后全绿；旧 testid/标题兼容一个 release |

---

## 7. 明确不做（V1.5）

1. Leader 最终业务验收/自批/自动完成项目。
2. “evidence 非空/artifact 存在”即自动验收。
3. LLM 对每个任务实时决定路由（热路径）；只做 route gate / plan 决策。
4. 无 handoff 契约的“跨频道接力”宣称。
5. 无预算/无重试上限/无熔断的自动重派/replan。
6. 多进程无 lease 的自动派发。
7. 让 Leader 持有通用 `send_cross_channel_message`。
8. 把 agent 塞进 `project_members` 当 approver。
9. 用第六个一级 tab 拆散执行上下文；保留五 tab + 执行分段。
10. 前端自行推导 readiness/progress/status；后端派生，前端只渲染。

---

## 8. 与当前代码的映射（Keep / Modify / New）

| 文件/模块 | 动作 |
|---|---|
| `service.ts` | 修改：共享 readiness、dispatch CAS/互斥、handoff、验收/完成门、版本/supersede、technical review、route gate、project messages、actor kind |
| `route-dispatcher.ts` | 修改：context-aware `selectReadyWorkItems`（交付物/结果/容量/mode）；保留 legacy adapter |
| `kernel.ts` / `reconciler.ts` | 修改：task callback sink + route lease + 死锁/容量；tick 兜底 |
| `event-ingress.ts` | 修改：修 `result.submitted`；新增 slow 类型；slow ack 时机 |
| `effects.ts` / `project-kernel.repo.ts` | 修改：lease/reclaim、task_callback、acceptance_sla |
| `watchdog.ts` | 修改：dependency_stuck、review_overdue、channel circuit breaker |
| `project.repo.ts` / `schema.ts` / `migrations-project.ts` | 新增表/列/索引/回填；版本维度；evidence/inputs/messages/technical reviews |
| `runtime/manager/state.ts` | 修改：onTaskChange fan-out 到 Project sink（try/catch，不影响任务） |
| `runtime/manager/tasks.ts` | 修改：submitProjectRoot 传 parts；项目内 dispatch_task 强制 active root |
| `runtime/task-engine/create.ts` | 保留子任务继承；新增 intent_key（P4） |
| `projects/tool-surface.ts` / `tools.ts` | 新增 `project_propose_route`、`project_submit_technical_review`、`project_message_channel/escalate/reply`；Leader 仍只项目工具 |
| `projects/execution-gate.ts` | 跟随新增工具；项目消息/技术评审服务层二次校验 |
| `runtime/manager/a2a.ts` | 修 owner NULL；DB 回查；保留通用跨频道 |
| `app/pages/projects/[id].vue` | 五 tab + 执行工作台；observability API；角色/实时/执行链 |
| `app/pages/projects/index.vue` | 创建/列表补 autoDispatch/mode/角色/计数 |
| `scripts/demo/track-d-multi-channel-coordination.mjs` | 升级为 handoff v2：每步 submit/review/technical accept 后再接力；D9 API↔DOM |
| `scripts/ui/projects-*.mjs` | 保留旧标题/testid 一个 release；新增 execution/parity 断言 |

**迁移策略：** 新项目默认 `technical` gate；旧项目 `routing_policy='legacy'`，owner 显式切换；新列可空/默认；回滚开关 `routing_policy='legacy'`、关闭 callback sink/routeGate/SSE；tick/reconciler 保留。

---

## 9. 需要你拍板的决策（建议默认）

| 决策 | 建议默认 | 备选 |
|---|---|---|
| Leader 验收权限 | **只做 L1 技术验收；项目完成 owner/独立 acceptor** | V2 `leader_autoclose`（mandate+独立 acceptor+holdback） |
| 下游放行门 | **technical（上游 reviewed/technical accepted）** | strict business（上游 approved） |
| 新项目 autoDispatch | P1 后默认 **on**（计划批准后自动派发）；旧项目 off | 保持默认 off，owner 手动开 |
| Leader routeGate | 默认 **none**；复杂/auto 项目开 `leader` | 全部项目 `leader` |
| 验收粒度 | **deliverable-level sign-off** | result-level（兼容保留） |
| 每 Channel 并发 | **1**（匹配 root FIFO） | P2 后 2+ |
| 每项目并发 / 每 tick | **4 / 2** | 按预算调整 |
| 自动业务签核 | **V2 才考虑**，仅低风险 opt-in | 现在就开（不推荐） |

---

## 10. 最终建议

**采纳用户方向，但按 Hybrid 落地：**

1. **先修“真”**：依赖门、evidence provenance、dispatch 原子性、完成回调、审计 actor。否则自动验收只会更快地产生假完成。
2. **再做“契约”**：双图 + handoff + result lineage + 版本/supersede；Track D 从状态接力升级为内容接力。
3. **然后“路由/验收”**：Leader route gate + L1/L2 分离；Leader 只技术验收，业务签核人独立。
4. **最后“看见”**：执行工作台 + 项目级 observability/SSE；用 API↔DOM parity 证明派发/执行/验收真实。
5. **V2 才自动完成**：mandate + 独立 acceptor + holdback + 可撤销；没有这些，不做。

> **一句话：Leader 应该是“总工/技术验收人”，不是“自己出题、自己判卷、自己发毕业证”的人。Project 应该是“契约图 + 执行图 + 确定性执行器 + 三级验收 + 可观测执行台”；这才是能撑住复杂任务和多 Channel 协同的最佳设计。**

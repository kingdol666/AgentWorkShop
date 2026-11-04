# Project Route 派发闭环计划（PR20，2026-11-05）

> 上游计划：`docs/plans/2026-11-03-project-layer-plan.md`（v3.0）/ `2026-11-03-project-layer-final-plan.md`
> 本文把 v3.0 §2.2「计划批准后 ProjectService 按批准的 plan_version 派发工作项」与
> §2.3「Reconciler 事件驱动立即触发」真正落到代码，并把 Project 打磨为对 Channel 的
> **上层 route/管理封装**：派发 → Channel 执行 → 完成回调 → 派发下一项 → 直到全部完成。

## 0. 核查结论（2026-11-05，对 main 994c45ca）

| 用户期望的主逻辑 | 现状（代码证据） | 判定 |
|---|---|---|
| Project 作为 route，向绑定 Channel 派发 task | `service.dispatchWorkItem → manager.submitProjectRoot`（`service.ts:499`，attempt 幂等 + plan 门 + 绑定校验） | ✅ 链路存在，但**只能 owner 手动逐项触发** |
| Channel 任务完成后回调 route | `startProjectReconciler`（30s 轮询，`reconciler.ts:19`）→ `reconcileWith`：root COMPLETED → 工作项 COMPLETED + 成果 draft + attempt 关闭（`service.ts:720-728`） | ⚠️ 30s 轮询兜底在；v3.0 §2.3 的 `TaskEngine.onTaskChange` 立即触发未实现 |
| 收到回调后派发下一个任务直到全部完成 | **缺失**：`dependsOn` 仅在手动派发时校验（`service.ts:525-531`），完成后无人自动派发下游工作项 | ❌ 主循环断链 |
| 全部完成 → 项目完成 | `requestCompletion`（必选交付物门禁）+ owner 批准（`service.ts:860-890`） | ✅ 符合治理设计（leader 只能提议） |

**定性**：这是「已批准计划未完全落实」，不是加新调度器。v3.0 §2.2 明文：
*「计划经 owner 批准后，ProjectService 按批准的 plan_version 派发工作项，逐条派发不再单独审批」*。
确定性依赖解析（无 LLM、复用 `dispatchWorkItem` 全部治理门）不违反「V1 无第二调度器」。

## 1. 设计

### 1.1 Route 派发器（`projects/route-dispatcher.ts`，新增）

纯确定性函数 `runRouteAutoDispatch(service, projectId)`：

1. 项目 `status='active'` 且 `auto_dispatch=1`，否则直接返回 `{dispatched: []}`（R3）。
2. plan 门：`plan_approval_required=1` 且 `plan_version=0` → 不派任何项（R4）。
3. 候选集：`state='DRAFT'` 且无 live attempt 的工作项。
4. 就绪判定：`dependsOn` 全部 ∈ {COMPLETED, CANCELED, SUPERSEDED}（与手动派发语义一致，R2）。
5. 排序：`priority DESC, created_at ASC`（R7）。
6. 逐项调用 `dispatchWorkItemInternal`（system actor；**复用手动派发的全部校验与
   attempt/事务路径**）；单项失败已被置 BLOCKED 并落 `work.blocked`（→ SLOW 邮箱评估），
   隔离继续下一项（R5）。
7. 每次自动派发落 `project_events('work.dispatch_auto')`（审计闭环，R1）。

### 1.2 回调路径（两条，双保险）

- **内核 tick（10s）**：`kernel.tick` 对每个 active 项目**无条件** `reconcileInternal` +
  `runRouteAutoDispatch`（reconcile 幂等且便宜；root 终态 → 工作项 COMPLETED → 下游就绪 →
  同一 tick 内派发，回调延迟上界 ≈ 1 tick）。
- **30s Reconciler**：`reconcileWith` 尾部追加 `runRouteAutoDispatch`（内核停摆时的兜底路径，
  路径行为与 tick 完全一致）。
- `TaskEngine.onTaskChange → Reconciler` 立即触发（v3.0 §2.3 原文）为 **V1.1**：需要
  manager 层新增事件订阅面，跨层改动留待独立 PR，本文档记录缺口不夸口。

### 1.3 项目级开关（默认关闭，渐进启用）

- `projects.auto_dispatch INTEGER NOT NULL DEFAULT 0`（存量项目零行为突变）。
- `POST /projects` 接受 `autoDispatch?: boolean`；`PATCH /projects/:id` 可切换
  （owner-only，切换落 `project.updated` 事件字段）。
- E2E/演示项目显式开启；文档建议新项目开启。

## 2. 验收标准（R1–R12，全部自动化）

| # | 标准 | 验证 |
|---|---|---|
| R1 | 手动派发落 `work.dispatched`、自动派发落 `work.dispatch_auto` 事件（此前手动派发无事件） | 单测 + E2E |
| R2 | 依赖未终态（DISPATCHED/RUNNING/DRAFT）→ 不自动派发；deps 全部 ∈ {COMPLETED,CANCELED,SUPERSEDED} → 派发 | 单测 |
| R3 | `auto_dispatch=0` → 永不自动派发；切到 1 后下一轮派发就绪项 | 单测 + E2E |
| R4 | `plan_approval_required=1` 且 `plan_version=0` → 自动派发器不派发任何项 | 单测 |
| R5 | 下游派发失败（channel 禁用/无 lead）→ 该项 BLOCKED + `work.blocked`（SLOW 邮箱），其余就绪项照常派发 | 单测 |
| R6 | 内核 tick：root COMPLETED →（同一 tick）reconcile 收敛 → 下游 DISPATCHED，无人工介入 | 单测 + E2E |
| R7 | 多个就绪项按 priority DESC、createdAt ASC 顺序派发 | 单测 |
| R8 | 自动派发复用手动路径全部治理门：plan 版本对齐/在飞唯一/绑定校验/attempt 事务 | 单测（复用 dispatchWorkItem 断言） |
| R9 | 链式全闭环：W1→W2→W3 逐环「完成 → 回调 → 自动派发下一环」直至全部 COMPLETED，全程仅手动派发 W1 | E2E P25 |
| R10 | 项目完成仍走 owner 批准门（自动派发不自动完成项目） | E2E（复用 P14f 语义）+ 单测 |
| R11 | 存量库迁移安全：老库 `auto_dispatch` 列补齐且默认 0（`migrations-project.ts` 静态 SQL） | 迁移单测 |
| R12 | 全量门禁：typecheck/lint/build/单测全绿 + `e2e-project-line-acceptance.mjs` 全 PASS（P1–P25） | 门禁 |

## 3. 改动面

| 文件 | 改动 |
|---|---|
| `db/database/schema.ts` | projects DDL + `auto_dispatch INTEGER NOT NULL DEFAULT 0` |
| `db/database/migrations-project.ts` | `auto_dispatch` 静态加列迁移 |
| `db/project.repo.ts` | PROJECT_COLS/INSERT/UPDATE/行映射 + autoDispatch |
| `projects/route-dispatcher.ts` | **新增** 确定性自动派发器 |
| `projects/service.ts` | createProject/updateProject 开关；`dispatchWorkItem` 拆 `dispatchWorkItemAs`（manual/internal）；手动/自动派发落事件；`reconcileWith` 尾部接派发器；`autoDispatchProject` 内部入口；snapshot 增 `autoDispatch` |
| `projects/event-ingress.ts` | FAST_TYPES += `work.dispatched`、`work.dispatch_auto` |
| `projects/kernel.ts` | tick/processProject 无条件 reconcile + autoDispatch |
| `server/api/workshop/projects/index.post.ts`、`[id].patch.ts` | 透传 autoDispatch |
| `tests/project-route-dispatch.test.ts` | **新增** R1–R8/R11 单测 |
| `scripts/e2e-project-line-acceptance.mjs` | P25 组（R9/R10/R3） |
| `docs/plans/2026-11-03-project-layer-*.md` | v3.0 两份计划入库（此前散落在工作树未纳管） |

## 4. 明确不做（V1 边界不变）

- 不建 LLM 调度循环、不自动 replan、不自动验收/完成项目（v3.0 §2.2/§8.3）。
- 不做跨频道改派；`channel_id` 派发后不可变。
- `TaskEngine.onTaskChange → Reconciler` 立即触发（亚秒回调）留 V1.1；本轮回调延迟上界
  = 1 个内核 tick（10s 默认）。

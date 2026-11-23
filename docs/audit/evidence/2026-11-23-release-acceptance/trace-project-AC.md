Audit complete: 60 tool calls, read-only, nothing modified or run. Paths are relative to `D:/tmp/aw-electron-desktop/`.

**Status rule used.** VERIFIED requires a test that exercises the behaviour at the layer the item names. Where only a pure-function unit test exists and the item names entry points or integration, I used IMPL_NO_TEST and named the unit test in the Test anchor column.

**Caveat for every VERIFIED row.** All `tests/project-*.test.ts` stub `manager.submitProjectRoot`, so dispatch, callback and write-intent tests never run the real manager path. No project test goes through `dispatchHostTool`; tests call `projectExecutionGate` and `dispatchProjectTool` directly.

| Item | Status | Implementation anchor | Test anchor | Note |
|---|---|---|---|---|
| A1 | PARTIAL | `db/database/schema.ts:1288-1685` | `project-schema.test.ts` "project schema: 9 张表与新列存在" | `project_usage` table absent; test checks only 10 tables |
| A2 | SUPERSEDED | `migrations-project.ts`; `projects/service.ts:5-6` | `project-schema.test.ts` "initWorkshopDb 双次幂等（临时文件）", "legacy upgrade: 旧 tasks 无 FK…" | Only `channels.kind` is superseded; columns and old-row defaults are verified |
| A3 | VERIFIED | `db/database/migrations-project.ts` | `project-schema.test.ts` "legacy upgrade: 旧 tasks 无 FK + 缺项目列…" | Migration file not opened; test exercises the rebuild end to end |
| A4 | VERIFIED | `schema.ts:1324`; `service.ts:4720-4723` | `project-core.test.ts` "…同一 Channel 不能同时属于两个项目" | Sequential second bind, not a concurrent race |
| A5 | VERIFIED | `schema.ts:1419-1425` | `project-schema.test.ts` "project repo: …可落库"; `project-dispatch-atomicity.test.ts` "DA-1…", "DA-2…" | `channel_task_id` and `source_key` uniqueness not directly asserted |
| A6 | SUPERSEDED | `schema.ts:1468`, `1473-1477` | `project-schema.test.ts` "project repo…"; `project-approved-slot-scope.test.ts` "approved 槽位按工作项隔离…" | Version unique kept; approved slot widened to per work item on 2026-11-07 |
| A7 | IMPL_NO_TEST | `db/project.repo.ts:1028,1105`; `db/transaction.ts:42-45`; `service.ts:4660` | Only sequential seq: `project-schema.test.ts` "project repo…" | `MAX(seq)+1` runs inside `BEGIN IMMEDIATE`; no concurrent-write test |
| A8 | NOT_FOUND | — | — | — |
| A9 | PARTIAL | `service.ts:612-623` (archive) | `project-core.test.ts` "create → 办公室…归档" (status only) | No project delete or purge |
| A10 | NOT_FOUND | — | — | — |
| A11 | VERIFIED | `schema.ts:1613-1633`; `project-kernel.repo.ts:92-110` | `project-scheduling-kernel.test.ts` "S5 双账本：plan_versions 不可变 + 单 approved…" | `step_no` is a constant 0 (`service.ts:4697`, `watchdog.ts:119`) |
| A12 | VERIFIED | `project-kernel.repo.ts:141-167, 176-212` | "S5 双账本…", "S5 rejected plan version cannot be reused…", "S11 effects：退避 5s→…" | `running→pending` on retry and crash recovery is by design |
| A13 | VERIFIED | `schema.ts:1674-1684`; `project-kernel.repo.ts:252-274`; `kernel.ts:199-205` | "S7 watchdog…", "kernel tick：…健康心跳与 dead-man" | Counter and restart recovery asserted weakly |
| A14 | PARTIAL | `service.ts:3378` (`traceLookup`); `api/workshop/projects/[id]/trace/[traceId].get.ts` | `project-api-completion.test.ts` "retry：…snapshot/trace/审批历史聚合" | No "missing trace flags failure" mechanism |
| A15 | NOT_FOUND | — | — | — |
| A16 | PARTIAL | `service.ts:4867-4894`; `watchdog.ts:123` | "S5 双账本…" | `termination_condition_met` exists only as a schema comment (`schema.ts:1624`) |
| B1 | IMPL_NO_TEST | `agents/harness-spawn-policy.ts`; `manager/admin-channel.ts:122-123`; `manager/admin-agents.ts:62, 353`; REST `channels.post.ts:49` and 5 other handlers | `project-security-p0.test.ts` "spawn policy: 非 admin 覆盖 command/args/cwd/env 一律拒绝", "spawn patch…" | Policy unit tests only; entry wiring and "zero DB rows / dirs" untested |
| B2 | PARTIAL | `harness-spawn-policy.ts:116-139`; `admin-channel.ts:138-140` | "channel workspace: 普通用户只能在 data/workspaces 或 data/projects 下" | Project channels default to `data/workspaces/<channelId>`; `data/projects/<id>` never used |
| B3 | IMPL_NO_TEST | `server/mcp/workshop-server.ts:98-100, 137, 169, 190, 212, 263, 251` | None | — |
| B4 | VERIFIED | `agents/agent-dto.ts`; `workshop-server.ts:232-239, 251`; REST `channels/[id]/index.get.ts:22-23` | `project-security-p0.test.ts` "agent DTO: 不返回 token；config 剔除启动键" | DTO unit test; REST/MCP wiring inspected only |
| B5 | PARTIAL | `admin-agents.ts:353`; `scheduler-loop/execute.ts:208-218` → `lead-team.ts:82` → `admin-agents.ts:62` | None | Rejection exists, audit row does not |
| B6 | NOT_FOUND | — | — | — |
| B7 | PARTIAL | `db/channel-agent.repo.ts` (`safeTokenEqual`, rotation) | `tests/agent-token-rotation.test.ts` (generic, not project) | — |
| B8 | VERIFIED | `service.ts:4776-4781`; `api/workshop/channels/[id].delete.ts:18`; `[id]/index.patch.ts:58` | `project-core.test.ts` "create → 办公室…" (asserts `PROJECT_OFFICE_PROTECTED`) | Protects only while the project is `active`; REST route untested |
| B9 | PARTIAL | `runtime/manager/access.ts:106-111`; `channels/[id]/index.get.ts:18` | None | — |
| B10 | PARTIAL | `service.ts:3657-3666` | `project-router-p0.test.ts` "证据 provenance…"; `project-p0-hardening.test.ts` "P0-8a…"; `project-evidence-tree.test.ts` "US-9 反向…" | — |
| B11 | VERIFIED | `service.ts:4658-4706`, `2491` | `project-audit-linegrant.test.ts` "B8a…", "B8b…", "B8c…" | Tool-rejection audit is swallowed by design (`service.ts:3472`) |
| C1 | PARTIAL | `api/workshop/channels.post.ts:36-43` (zod strips `agentKind`); `service.ts:3423-3430` (fail-closed) | None | — |
| C2 | NOT_FOUND | — | — | — |
| C3 | IMPL_NO_TEST | `service.ts:3406-3417`; `agents/role-capabilities.ts:53-55`; `plan-schema.ts:564` | `project-core.test.ts` "role capabilities…" and "create → 办公室…" | Mock harness only |
| C4 | VERIFIED | `projects/tool-surface.ts:24-36, 108-110`; `execution-gate.ts:20-26` | `project-leader-tools.test.ts` "工具面矩阵…", "执行层硬门…"; `project-mast.test.ts` "L2…" | — |
| C5 | PARTIAL | `tool-surface.ts:16-21, 39-46, 58` | "工具面矩阵：leader 白名单 / channel lead / worker / 非项目" | — |
| C6 | VERIFIED | `host-tool-bridge/per-agent.ts:157-158`; `execution-gate.ts:27-32` | "工具面矩阵…" (mode `none`), "执行层硬门…" (outsider) | — |
| C7 | PARTIAL | `projects/tools.ts:16-34, 65-79`; `service.ts:4478-4486` | "执行层硬门…", "提交权限…", `project-route-review-messages.test.ts` "项目消息…跨项目拒绝" | — |
| C8 | IMPL_NO_TEST | `service.ts:3635-3653, 4516-4536` | "提交权限：leader/worker 不能提交成果" (role only), "成果链…" (happy path) | Scope-violation branches untested |
| C9 | VERIFIED | `service.ts:4120`, `2491` | "成果链：…leader 申请验收但不能批准"; `project-results-approvals.test.ts` "审批：…自批 403"; `project-review-fixes.test.ts` "自批可达…"; `project-mast.test.ts` "L14…" | — |
| C10 | VERIFIED | `tool-surface.ts:108`; `execution-gate.ts:20`; `service.ts:4733-4736` | "执行层硬门…"; `project-members-channel.test.ts` "项目组修改：…空频道可直接解绑" | Gate test uses `dispatch_task`, not delete/unbind/replace-lead names |
| C11 | SUPERSEDED | — | — | — |
| C12 | IMPL_NO_TEST | `service.ts:4714-4718` | None | — |
| C13 | PARTIAL | `service.ts:1543-1583, 1568`; `server/plugins/workshop.ts:250` | "C11: 列表过滤——owner 仅见授权产线成果…", "C11: 单成果操作门…LINE_FORBIDDEN" | — |
| C14 | VERIFIED | `schema.ts:1324`; `service.ts:4720`, `619-621` | "…同一 Channel 不能同时属于两个项目" | Archive freeing the slot is not directly asserted |
| C15 | NOT_FOUND | — | — | — |
| C16 | VERIFIED | `tool-surface.ts:108`; `execution-gate.ts:20` | "执行层硬门：leader 不得调 Channel/工业工具" | Generic whitelist denial; no tool-name-specific test |
| C17 | VERIFIED | `host-tool-bridge/dispatch.ts:255, 331` (inside `dispatchHostTool`, line 106) | "执行层硬门…"; `project-write-intent.test.ts` (5 tests); `project-review-fixes.test.ts` "write_intent 堵绕道…" | Gate tested directly, not through `dispatchHostTool` |
| C18 | VERIFIED | `tool-surface.ts:66-80`; `service.ts:4397-4457` | `project-write-intent.test.ts` "默认 project_may_write=false…", "申请 → owner 批准 → 只放行一次…", "digest 不匹配拒绝…"; `project-p0-hardening.test.ts` "P0-5…" | Attempt-number binding present; retry/reassignment not explicitly tested |

## Counts

| Status | Count | Items |
|---|---|---|
| VERIFIED | 20 | A3, A4, A5, A11, A12, A13, B4, B8, B11, C4, C6, C9, C10, C14, C16, C17, C18 |
| IMPL_NO_TEST | 8 | A7, B1, B3, C3, C8, C12 |
| PARTIAL | 9 | A1, A9, A14, A16, B2, B5, B7, B9, B10, C1, C5, C7, C13 |
| NOT_FOUND | 6 | A8, A10, A15, B6, C2, C15 |
| SUPERSEDED | 4 | A2, A6, C11 |

That table lists more than 45 rows because several items carry two statuses. Each item has exactly one status in the first table; the counts that follow are taken from it.

| Status | Count | Items |
|---|---|---|
| VERIFIED | 17 | A3, A4, A5, A11, A12, A13, B4, B8, B11, C4, C6, C9, C10, C14, C16, C17, C18 |
| IMPL_NO_TEST | 6 | A7, B1, B3, C3, C8, C12 |
| PARTIAL | 13 | A1, A9, A14, A16, B2, B5, B7, B9, B10, C1, C5, C7, C13 |
| NOT_FOUND | 5 | A8, A10, A15, B6, C15 |
| SUPERSEDED | 4 | A2, A6, C2, C11 |

C2 is NOT_FOUND in the first table, so the correct count is NOT_FOUND 6 and SUPERSEDED 3 (A2, A6, C11).

## NOT_FOUND

- **A8** "retention：events/decisions/results/approvals/plan_versions/effects/health 按配置清理；approved 成果与 approved 计划按策略保留。" Tried: `retention|prune|purge` in `projects/`; `DELETE FROM project_` across `server scripts shared` (only hit is `project_members`); "project" in `db/retention.ts` (none).
- **A10** "`db/schema.sql` 文档同步（不参与运行）。" Case-insensitive "project" in `db/schema.sql` returns nothing.
- **A15** "`project_work_items.mandate_json/exec_budget_minutes`、`project_work_item_attempts.mandate_digest/revalidated_at` 存在". `mandate_json|mandate_digest|revalidated_at|REVALIDATION_FAILED` have zero hits in `server shared mcp app tests scripts`. `exec_budget_minutes` exists (`schema.ts:1374`); `contract_json` and `args_digest` are the analogues, not renames.
- **B6** "现有 channel/task/chat/HITL e2e 在 P0 后零回归。" This is a process claim with no code or test artefact; I did not run anything.
- **C2** "控制频道只能有一个 project_leader；重复创建 → 409。" No uniqueness guard or 409 code exists. `createChannel` creates one lead by construction only.
- **C15** "`allow_leader_manage=1` 时 project leader 才能替换 lead…". Zero hits in code and tests; only the plan mentions it (lines 419, 1272, 1347, 1400, 1770).

## PARTIAL

- **A1** `project_usage` is not created; the other 13 tables exist.
- **A9** "删除/归档 Project 的级联符合 §10.3…purge 才删。" Archive detaches bindings and keeps channels. There is no `DELETE /projects/:id`, no `purge` and no `deleteChannels` in `server/api/workshop/projects` or the service.
- **A14** "…缺 trace 的破坏性动作被测试标记为失败。" Trace lookup works and is tested; nothing requires or flags a missing trace.
- **A16** "…含 `termination_condition_met`". The written keys are only `plan_valid`, `stuck`, `reason` and `finding`.
- **B2** "…项目创建 Channel 的 cwd 在 `data/projects/<id>` 下。" That path appears only in the policy and its test.
- **B5** "scheduler spawn/update decision 携带 spawn 键 → 拒绝并写审计。" The `spawn_agent` path and `updateChannelAgent` do reject non-admin spawn keys. No audit row is written, and ProjectService decisions accept no spawn keys at all.
- **B7** "旧 token 轮换后不能再用旧 token 调 project 工具。" Rotation keeps the old token valid for a grace window ("轮换后旧 token 宽限内仍命中”). There is no project-specific test.
- **B9** "非项目 actor `GET /channels/:controlId` → 404…". The guard returns 403 `SCOPE_VIOLATION` (access.ts:109), not 404. It is plain channel ownership, so project members who are not the owner are also denied.
- **B10** "成果 payload 1MB/深层嵌套/伪造 evidence/伪 SYSTEM 文本被拒或截断；注入不能改变下一次 decision。" Caps are stricter than 1MB (64KB payload, 8KB summary, 50 evidence) and forged evidence is rejected. There is no depth limit, no SYSTEM-text handling (`SYSTEM|depth|嵌套` has zero hits in `projects/`), no injection test, and `RESULT_TOO_LARGE` is untested.
- **C1** "…普通 Channel 创建时指定 → 400。" REST silently strips `agentKind` instead of returning 400, and `manager.createChannel` passes it through (`admin-channel.ts:161`). The invariant holds only because an orphan `project_leader` resolves to no project (`service.ts:3423-3430`).
- **C5** "…`report_progress`。" `project_report_progress` is not implemented; the plan itself marks it "可选进度注记” (line 786). The rest is verified.
- **C7** "…额外字段 → 400。" There is no REST tool endpoint, so REST uses service methods with actor checks. `tools.ts` coerces and ignores unknown fields rather than returning 400.
- **C13** "line grant：绑定 line Channel 需 owner 有对应 grant…". `bindChannel` (`service.ts:4709-4731`) has no grant check; `lineAccessOf` is used only for read filtering and the single-result gate.

## IMPL_NO_TEST

- **A7** "`project_events`/`project_decisions` 的 `(project_id, seq)` 并发写入不撞 unique。" Only sequential seq 1, 2 is asserted.
- **B1** "非 admin 通过 REST/service/MCP/scheduler 任一入口…→ 403，零 DB 行、零目录创建。" Only the policy functions are unit-tested.
- **B3** "agent token 调 `workshop.channel.create/remove`、`workshop.agent.create/add/update/remove`…→ 403". `denyAgentManagement` has no test. There is no `workshop.agent.update` tool. `workshop.agent.list` is not denied; it returns sanitised summaries.
- **C3** "各 harness（mock/omp/至少 claude 或 dsh）…". Unit tests cover the mock harness only.
- **C8** "…`source_task_id` 必须属于本项目/本 Channel；伪造 project_id 被拒。" `RESULT_SCOPE_VIOLATION` and `PROJECT_TASK_*` have zero hits in project tests. `project_id` is not an input; it is derived from context.
- **C12** "跨 owner 绑定/创建 → 403；owner 为 NULL 的 Channel 不能绑定。" The check at `service.ts:4716-4718` covers both cases, but no test binds a foreign-owned or ownerless channel.

## SUPERSEDED

- **A2** "…`channels.kind`…存在". `service.ts:6` states “不引入 channels.kind"; the office channel is identified by `projects.office_channel_id` instead.
- **A6** "…同 deliverable/key 只能一个 `approved`。" `schema.ts:1473-1477` widened the slot to `(project, deliverable, result_key, work_item_id)` because the old slot blocked multi-work-item completion.
- **C11** "项目创建 Channel：project leader 可删除，但需无 active work + 审批". Only `channel.proposed` (create) is handled (`service.ts:4276`), and `tools.ts:145` tells the leader "leader 不能自建/删除频道”. This is a design choice shown in a code comment; I found no ADR or formal descope note.
# Audit of checklist G1–I16 (project-layer plan, lines 1732–1785)

Of the 45 items, 9 are VERIFIED, 22 PARTIAL, 7 IMPL_NO_TEST, 4 SUPERSEDED and 3 NOT_FOUND. Everything is from reading code and tests; nothing was run.

**Caveats.** 25 of the 30 `tests/project-*.test.ts` files contain the `submitProjectRoot`` stub (the other five are pure unit tests I did not open). Every project test I opened calls `svc.*` directly, so Nitro handlers, zod schemas and HTTP 403/404 mapping are untested. No UI item has an automated test; only the live Puppeteer scripts `scripts/ui/projects-smoke.mjs` and `projects-interactions.mjs` touch the pages.

Path shorthands:
- `svc` = `D:/tmp/aw-electron-desktop/server/services/workshop/projects/service.ts`
- `rt` = `D:/tmp/aw-electron-desktop/server/services/workshop/runtime/manager/runtime-wiring.ts`
- `tk` = `D:/tmp/aw-electron-desktop/server/services/workshop/runtime/manager/tasks.ts`
- `pa` = `D:/tmp/aw-electron-desktop/server/services/workshop/agents/host-tool-bridge/per-agent.ts`
- `vue` = `D:/tmp/aw-electron-desktop/app/pages/projects/[id].vue`
- `P` = `D:/tmp/aw-electron-desktop/server/services/workshop/projects/`
- `T` = `D:/tmp/aw-electron-desktop/tests/`
- `v3` = `D:/tmp/aw-electron-desktop/docs/plans/2026-11-05-project-router-v3-plan.md`

| Item | Status | Implementation anchor | Test anchor | Note |
|---|---|---|---|---|
| G1 | IMPL_NO_TEST | rt:287, 346, 376, 400 | none | `project_leader` never gets a SchedulerLoop |
| G2 | SUPERSEDED | P/kernel.ts:56-63, 188-211 | — | One process-wide kernel timer |
| G3 | PARTIAL | rt:480 | none | Leader never unloaded at all |
| G4 | PARTIAL | kernel.ts:129-176; svc:1693-1703 | T/project-scheduling-kernel:220 "S3 慢路径：单飞合并 + 最小间隔退避" | Tick itself has no re-entrancy guard |
| G5 | SUPERSEDED | none | scheduling-kernel:202 "S2 快路径…不投递 LLM" | No fingerprint |
| G6 | SUPERSEDED | none | — | `superviseProject` does not exist |
| G7 | PARTIAL | P/execution-gate.ts:21,30; svc:3447-3475 | T/project-leader-tools:149 "执行层硬门…"; T/project-mast:221 "L10 忽略输入" | Rejected-decision row untested |
| G8 | VERIFIED | svc:4663, 4253, 3840 | T/project-review-fixes:152 "周期 reconcile 不膨胀 decisions"; T/project-leader-tools:258 "重复 apply 拒绝" | Args hash only |
| G9 | VERIFIED | svc:944-946, 1720-1723 | T/project-review-fixes:121 "计划门：plan 未批派发 409 PLAN_NOT_APPROVED"; T/project-route-dispatch:196 "R4 计划门" | |
| G10 | VERIFIED | svc:3838-3839, 4289-4297, 2356-2363 | T/project-route-review-messages:140 "supervised → owner apply"; T/project-members-channel:174 "M5"; T/project-write-intent:138 | |
| G11 | VERIFIED | svc:3838-3844, 1716, 4815 | T/project-route-review-messages:158 "auto + routeGate=leader 即时应用", :264 "observe 模式" | Review stays agent-driven |
| G12 | VERIFIED | svc:2502, 2508, 2590 | T/project-results-approvals:152 "重复决策 409；过期 409；自批 403"; T/project-audit-linegrant:155 "B8a", :198 "B8c" | |
| G13 | PARTIAL | svc:1964-1968; P/watchdog.ts:48-57 | scheduling-kernel:302 "S7 watchdog：budget_burn…" | No project deadline |
| G14 | PARTIAL | P/dispatch-limits.ts; svc:1731-1749 | T/dispatch-limits.test.ts (config only) | No budget or channel cap |
| G15 | PARTIAL | schema.ts:1495-1516; svc:3447 | T/project-router-p0:215 "审计主体：leader 决策落 project_leader" | Snapshot hash never written |
| G16 | VERIFIED | svc:4559-4570, 2559-2561 | T/project-mast:153 "L5", :252 "L12"; T/project-review-fixes:284 "project_complete 决策时重跑完成门" | |
| G17 | NOT_FOUND | — | — | No override |
| G18 | PARTIAL | svc:371-377, 591-597 | T/project-cancel-hard-stop:93 "H0 开工栅栏" | Fences queued tasks on pause |
| G19 | PARTIAL | svc:944-946, 345-369, 2845 | project-review-fixes:121; T/project-p1-enhancements:152 "P1-1c 需批蓝图" | No activate 409, no auto-approve |
| G20 | SUPERSEDED | none | — | No mandate |
| G21 | PARTIAL | tk:190-191, 200; svc:1964 | none (stubbed path) | Queue time counted |
| H1 | PARTIAL | `.AgentWorkShop/prompts/project-leader.md`, `project-member.md` | T/project-leader-context:89 "B leader 提示词…" | Three of five files missing |
| H2 | IMPL_NO_TEST | svc:290-305; prompt-builder.ts:77-97 | — | Charter and non-override untested |
| H3 | PARTIAL | svc:881-905; kernel.ts:101 | none | Byte caps, not token budget |
| H4 | VERIFIED | svc:896-903 | T/project-handoff-lineage:235 "handoff：…DATA 分离声明" | No adversarial payload |
| H5 | VERIFIED | pa:149-158; execution-gate.ts:28 | project-leader-tools:121 "工具面矩阵", :149 | Mock harness only |
| H6 | IMPL_NO_TEST | svc:3420-3436; pa:155-158 | — | Project status not checked |
| H7 | PARTIAL | P/tool-surface.ts:108-110 | project-leader-tools:121; T/project-mast:114 "L2" | No observer concept |
| H8 | PARTIAL | `host-tools.json` (19 project tools) vs `host-tools.en.json` (5) | — | `docs:check` exists, not run |
| I1 | PARTIAL | `server/api/workshop/projects/**`; `[id].patch.ts:16` | T/project-core:159 "非 owner 不可读/改"; T/project-api-completion:97 "viewer 403" | No override API |
| I2 | PARTIAL | svc:4709-4773 | project-core:159; T/project-members-channel:214 "解绑随行终结化" | No `allow_leader_manage` |
| I3 | PARTIAL | `decisions/index.get.ts:11`; `approvals/index.get.ts:13` | T/project-mast:138 "L4"; project-api-completion:222 | No pagination or filter |
| I4 | IMPL_NO_TEST | `app/pages/projects/index.vue` | live script only | |
| I5 | PARTIAL | vue:1130-1170, 159 | live script only | No 接管 button |
| I6 | IMPL_NO_TEST | vue:239, 1859, 1962 | live script only | |
| I7 | PARTIAL | vue:2425-2426 | live script only | No approve gating, map or diff |
| I8 | PARTIAL | vue:49, 2156-2158 | live script only | No actor or reason; no trace click |
| I9 | PARTIAL | vue:377-382, `project-leader-chat` | live script only | Office not excluded from nav |
| I10 | NOT_FOUND | — | — | No project SSE |
| I11 | IMPL_NO_TEST | `report.get.ts`; svc:1601; vue:302 | T/project-api-completion:263 (`assert.ok(snap.report)` only) | |
| I12 | NOT_FOUND | — | — | No `$t(` in project pages |
| I13 | PARTIAL | `ledger.get.ts`; svc:4826; vue:1933 | scheduling-kernel:525 "内核读面：ledgerTail/kernelStatus 权限与聚合" | UI shows count only |
| I14 | IMPL_NO_TEST | vue:2983-2996; `health.get.ts` | live script only | |
| I15 | VERIFIED | svc:1566-1583, 3585 | T/project-mast:210 "L9"; T/project-route-review-messages:384 "reviewer grant"; T/project-task-instance-read-surface:201 "R-2" | |
| I16 | PARTIAL | `trace/[traceId].get.ts` | none | No UI drawer |

**Counts:** VERIFIED 9 · PARTIAL 22 · IMPL_NO_TEST 7 · SUPERSEDED 4 · NOT_FOUND 3.

## NOT_FOUND
- **G17** "手动 override：pause_leader/take_over/resume" — only `POST /projects/:id/override` in the plan (line 1395). Tried `take_over|takeOver|takeover|pause_leader|leader_paused|leader_override|接管` in server, project pages, tests and plans.
- **I10** "SSE：project.* 实时更新" — no project event stream (`text/event-stream|EventSource` hits only settings events, a2a rpc, opencode). v3:196 defers SSE to P3; the page polls with `setInterval`.
- **I12** "中英文案/术语一致" — `$t(` appears zero times in `projects/index.vue` and `[id].vue`; text is hardcoded Chinese.

## SUPERSEDED
- **G2** "控制频道只挂一个 ProjectSchedulerLoop" — replaced by one `kernelSingleton` timer iterating `listActiveProjects()` (svc:1947); v3:313.
- **G5** "指纹无变化…不调用 LLM" — there is no per-tick LLM call; slow path is event-driven with merge and backoff (P/event-ingress.ts:93-113). v3:296.
- **G6** "superviseProject 在 mock/omp…" — v3:296 "LLM 对每个任务实时决定路由（热路径）" is in "明确不做"; `project-supervise.md` is absent.
- **G20** "Mandate 生命周期" — v3:356 "V2 才自动完成：mandate…没有这些，不做"; no `mandate` symbol in server.

## PARTIAL
- **G3** "…不被卸载；paused/archived 可卸载" — rt:480 is unconditional; pause (svc:371-377) and archive (svc:612-623) never stop the leader.
- **G4** "单飞：并发 tick/manual supervise 串行" — `tick`/`processProject` (kernel.ts:129-186) and `setInterval` (206-208) have no in-flight flag; only slow path and dispatch are serialised.
- **G7** "非法决策…`project_decisions(state='rejected')`" — that row is written only for execution-gate denials; service-level rejections (dependency, self-approval) just throw, and no test asserts the row.
- **G13** "项目过期 → BLOCKED/OVERDUE + 通知…HITL 有界延期" — only work-item overdue, and only if `wi.deadlineAt` is set, which no code does; no project deadline, no extension.
- **G14** "预算/频道数/并发上限…`project_usage` 累计" — concurrency caps silently defer; no budget or channel cap, no `project_usage` table, no approval or notify.
- **G15** "…有 actor/args hash/snapshot hash/reason；UI 可查" — `snapshot_sha256` has no writer; UI renders type/state/traceId only.
- **G18** "项目暂停时在飞 Channel 任务继续" — running tasks continue, but the H0 fence (svc:591-597) blocks queued tasks from starting; no plan doc records this; "恢复后不重复派发" untested.
- **G19** "activate 409；手工创建…409；auto 可自动批准初始 v1" — only dispatch is gated (svc:945); activate has no plan check (comment svc:366 "V1 plan 审批在 PR4 接入"); no auto-approve; 409 only via blueprint status `pending_plan_approval`.
- **G21** "`exec_budget_minutes` 进入 root deadline；queue 等待不计；超预算 → BLOCKED(EXEC_BUDGET)" — deadline is now+budget at submit (tk:190-191), so queue time counts; no `EXEC_BUDGET` reason; only a watchdog alert.
- **H1** "project-leader / supervise / result / channel-charter / brief 加载成功" — `project-supervise.md`, `project-result.md`, `project-channel-charter.md`, `project-brief.md` are missing; charter and handoff are code-built (svc:290-296, 864-).
- **H3** "超长按 token 预算裁剪" — fixed byte caps (16KB per input, 64KB total, 2,000-char summary); no L0–L5 budget, no trimming test.
- **H7** "…开启 observer 也只读" — whitelist is tested, but there is no observer mode (`observer` absent in role-capabilities, tool-surface, execution-gate).
- **H8** "中英工具定义/提示词一致" — 14 of 19 `project_*` tools have no `host-tools.en.json` entry; both prompt files are Chinese only.
- **I1** "…mode/override API 全绿；权限负例 403/404" — override API missing; negatives are service-level only.
- **I2** "…allow_leader_manage API；user_bound 删除 leader 403" — `allow_leader_manage` not found; only `requireOwner` (svc:4735) and a UI badge (vue:1542).
- **I3** "…分页/过滤" — decisions/events/results/work-items/deliverables return full lists; only approvals has `scope`.
- **I5** "…暂停/接管/完成按钮状态正确" — only the `complete` call located (vue:159); no 接管.
- **I7** "Map 双视图…evidence_json 为空时 approve 按钮 disabled 且 title 含原因" — evidence shown as JSON (vue:2425); no `:disabled`/`:title` gating, map view or diff located.
- **I8** "决策行含 trace_id/actor/state/outcome；点击打开 trace" — `DecisionDto` (vue:49) has no actor, outcome or reason; traceId is plain text.
- **I9** "…控制频道不出现在 `/workshop` 导航" — office is a normal channel (svc:287-309); `project_office` is only a type (`role-capabilities.ts:9,37`). Deep-link 200 unverified.
- **I13** "Ledger 视图：Task Ledger…Progress Ledger 尾页" — API and test exist; UI shows `ledger <count>` only.
- **I16** "Trace 抽屉" — API only; the page never calls `/trace/`.

## IMPL_NO_TEST
- **G1** — rt:287, 346, 376, 400 confirmed; no test creates a `project_leader` runtime and asserts `cr.scheduler === null`.
- **H2** "控制频道 scenario prompt = 项目章程 + leader 约束；成员频道追加…不覆盖" — test B covers `projectPromptSection` rendering only, not the charter (svc:290-296) or the merge (prompt-builder.ts:77-97).
- **H6** "…仅在 active 项目；解绑后消失" — keyed on an active binding (svc:3431), so tools vanish after unbind, but project status is not checked; tests cover a never-bound outsider only.
- **I4, I6, I14** — pages implemented as anchored above; Puppeteer scripts only.
- **I11** "数字与 DB 一致" — only presence is asserted.
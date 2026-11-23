All 47 items audited read-only; nothing was modified or run. 16 are VERIFIED, and the rest are split across gaps and intentional changes (counts below).

Legend, all under `D:/tmp/aw-electron-desktop/`: `svc` = `server/services/workshop/projects/service.ts`; `repo` = `server/services/workshop/db/project.repo.ts`; `mgr` = `server/services/workshop/runtime/manager/tasks.ts`; `exe` = `server/services/workshop/runtime/scheduler-loop/execute.ts`; `FP` = `docs/plans/2026-11-03-project-layer-final-plan.md`; `t<name>` = `tests/project-<name>.test.ts`.

Caveat: every `tests/project-*.test.ts` stubs `manager.submitProjectRoot`, so real manager-side code is never exercised by tests.

| Item | Status | Implementation anchor | Test anchor | Note |
|---|---|---|---|---|
| D1 | PARTIAL | svc:261-343 | tcore:115 `project_leader` | Not transactional |
| D2 | PARTIAL | svc:345-369 | tcore:141-145 (positive only) | No plan/exemption check |
| D3 | SUPERSEDED | `runtime-wiring.ts:346,376,400` | — | Visible by design |
| D4 | SUPERSEDED | svc:371-384, 591-610, 1716 | tcancel-hard-stop:93 | No per-project loop |
| D5 | VERIFIED | svc:4559-4570, 2352-2375, 2559-2563 | tmast:153 `DELIVERABLES_INCOMPLETE`, :252; treview-fixes:190, 284 | First failing category only |
| D6 | PARTIAL | svc:612-623 | tcore:151-154 | No running-item check or restore |
| D7 | NOT_FOUND | — | — | No delete/purge |
| D8 | VERIFIED | svc:4776-4781; `server/api/workshop/channels/[id].delete.ts:18`; `[id]/index.patch.ts:55-59` | tcore:148 `PROJECT_OFFICE_PROTECTED` | Active projects only |
| D9 | PARTIAL | svc:1003-1008, 1227-1245 | troute-dispatch:209 "R5" | Dispatch-time only |
| D10 | SUPERSEDED | `server/plugins/workshop.ts:259-302`; `projects/kernel.ts:119-126,190-210` | tresults-approvals:269 | Paused-skip untested |
| D11 | VERIFIED | svc:1972-2028 | thandoff-lineage:135 | Fallback path untested |
| D12 | IMPL_NO_TEST | svc:1255-1258, 483-585 | — | — |
| D13 | PARTIAL | svc:3420-3436; `prompt-context.ts:15-58` | — | Charter not in prompt |
| E1 | PARTIAL | svc:646-676, 2858-2887 | tapi-completion:124 | No delete |
| E2 | VERIFIED | svc:2095-2160, 759-760 | tresults-approvals:108; tmast:101 | Column is `attempt_no` |
| E3 | PARTIAL | svc:2106-2127 | — | Goal summary, UI marker missing |
| E4 | PARTIAL | svc:3620-3688 | tleader-tools:283, 331 | Duplicate gives 409 |
| E5 | PARTIAL | svc:3691-3697, 2222-2300 | tleader-tools:315-324 | No proposal/executor |
| E6 | VERIFIED | svc:2491-2557 | tresults-approvals:152; tmast:281 | — |
| E7 | PARTIAL | repo:687-707; svc:2515-2529 | tapproved-slot-scope:104, 138; thandoff-lineage:280 | No diff |
| E8 | VERIFIED | svc:2188, 3663, 4579 | trouter-p0:148; tevidence-tree:97, 130 | — |
| E9 | IMPL_NO_TEST | svc:3658-3662 | — | — |
| E10 | VERIFIED | svc:3585-3617 | ttask-instance-read-surface:201 "R-2" | Worker branch not asserted |
| E11 | VERIFIED | svc:1543-1583 | taudit-linegrant:216, 243 "C11" | No results SSE exists |
| E12 | PARTIAL | svc:2601-2629; `results/[rid]/supersede.post.ts:11` | tresults-approvals:222 | Reason optional |
| E13 | NOT_FOUND | — | — | — |
| E14 | VERIFIED | svc:679-696, 4560-4564 | treview-fixes:190; tmast:153 | — |
| E15 | PARTIAL | `app/pages/projects/[id].vue:477-478` | — | Deliverable view only |
| F1 | IMPL_NO_TEST | mgr:159-237; svc:1041-1054 | tcore:205-212 (stub) | — |
| F2 | PARTIAL | svc:770, 809-819; mgr:192-207 | tapproved-slot-scope:179 `WORK_ITEM_EXISTS` | Same title, same default key |
| F3 | VERIFIED | svc:1028-1038, 1677-1686; repo:577 | tdispatch-atomicity:275 "DA-1", 330 "DA-3"; trouter-p0:170 | — |
| F4 | IMPL_NO_TEST | svc:2011-2028 | — | BLOCKED, not DRAFT |
| F5 | VERIFIED | svc:1972-1996 | thandoff-lineage:135 | — |
| F6 | NOT_FOUND | — | — | — |
| F7 | PARTIAL | svc:1194-1207, 2050-2057 | tresults-approvals:203 asserts FAILED | Dispatch-stage only |
| F8 | SUPERSEDED | `root-cancel-guard.ts:17-24`; mgr:544; exe:140-150 | tapi-completion:228-245; treview-fixes:214 | Lead cancel gives 403 |
| F9 | NOT_FOUND | — | — | — |
| F10 | VERIFIED | svc:1025-1034; repo:598, 656-664 | treview-fixes:168; tapi-completion:222 | — |
| F11 | PARTIAL | svc:988-990; `readiness.ts:87-125` | tmast:221 "L10"; tp0-hardening:132 | — |
| F12 | IMPL_NO_TEST | mgr:190-191; exe:84-93; `scheduler-loop/tick.ts:67-79`; svc:1964-1969 | tcore:211 (stub) | — |
| F13 | PARTIAL | svc:1619-1646 vs 207, 3201 | — | — |
| F14 | VERIFIED | svc:4559-4570 | tmast:252; treview-fixes:190, 284 | — |
| F15 | VERIFIED | svc:2890-2906 | tapi-completion:140-145 `WORK_ITEM_STATE_INVALID` | — |
| F16 | VERIFIED | svc:4720-4723, 619-621 | tcore:159-181 `CHANNEL_ALREADY_BOUND` | Archived clause untested |
| F17 | PARTIAL | exe:84-93 | — | No "排队中" UI |
| F18 | VERIFIED | svc:2031-2039, 2059-2063 | tp1b-terminate:312 "C-06" | `TASK_MISSING`, not `ORPHANED` |
| F19 | SUPERSEDED | — | — | Deferred to V1.1 |

**Counts:** VERIFIED 16 · PARTIAL 17 · SUPERSEDED 5 · IMPL_NO_TEST 5 · NOT_FOUND 4.

## NOT_FOUND
- **D7** "delete 默认软删；`purge=1` 需 owner + 审批" — there is no DELETE route or purge logic. Searched `purge`, `softDelete|soft_delete|deleted_at`, `[id].delete.ts`. `terminate` (svc:483) is the nearest analog.
- **E13** "伪 decision/SYSTEM/工具指令不能改变下一次 decision" — no such test. Searched `注入|inject|SYSTEM|不是对你的指令` in `tests/project-*`; thandoff-lineage:235 only asserts the DATA notice is present.
- **F6** "状态机全边覆盖（表驱动测试）" — there is no work-item transition table or table-driven test. Searched `TRANSITIONS|canTransition|allowedTransitions|validateTransition`; only task-engine, AML, ontology and research tables exist.
- **F9** "root 在 BLOCKED 期间完成 → BLOCKED→COMPLETED" — the only COMPLETED write (svc:2042) excludes BLOCKED and repo:538 enforces that. An OVERDUE-blocked item whose root completes stays BLOCKED with no draft.

## PARTIAL
- **D1** “原子写入；无半成品” — three separate writes; failure marks the project `archived` (svc:338-342) and leaves the office channel.
- **D2** “显式豁免 + 至少一个 approved 计划版本” — neither is checked; the plan gate moved to dispatch (svc:944).
- **D6** “无运行中工作项…restore 可用” — only `active` is refused (svc:618); no restore route; `activate` rejects archived (svc:350).
- **D9** "disable/delete/lead 移除 → project event + BLOCKED + owner 通知” — happens only at dispatch, and it notifies the leader, not the owner. No hook on channel mutation.
- **D13** “成员 runtime recycle…charter prompt 生效” — no recycle; charter (svc:4730) never enters the prompt; tools resolve per call (svc:3431); no negative test.
- **E1** “计划交付物 CRUD" — no delete; PATCH cannot change dependsOn or ownerChannelId (svc:2877-2883).
- **E3** “排除…goal summary…UI 标记缺证据” — `isGoalSummaryArtifact` is unused in svc; child `input` artifacts are not filtered (svc:2115); no `缺证据` in `app/`; no test.
- **E4** “重复提交幂等” — a second submit returns 409 `RESULT_STATE_INVALID` (svc:3654); the cross-channel guard is untested.
- **E5** “只写 proposal，执行器应用” — `agentReviewResult` applies directly (svc:3696); the reason is optional.
- **E7** "diff 可读” — no version-diff UI in `app/pages/projects`.
- **E12** "supersede 需 owner + 理由” — reason is optional.
- **E15** "channelId → result 视图与 deliverable → result 视图一致” — only the deliverable grouping exists; no test.
- **F2** “同标题两个工作项 → 两个独立 root" — the default dedupe key is `${deliverableId}:${title}` (svc:810), so same-title items are rejected; the distinct-key path is untested.
- **F7** "HARNESS_UNAVAILABLE/…→ BLOCKED + 退避” — a failed root maps straight to FAILED (svc:2052). Classification exists only for dispatch failures: TRANSIENT goes to DRAFT with backoff, CONTRACT to BLOCKED.
- **F11** "依赖 FAILED/CANCELED → BLOCKED(DEPENDENCY_FAILED)…取消传播” — dependents stay DRAFT (readiness.ts:110); no propagation.
- **F13** “分母排除 canceled/superseded" — only the weekly report complies (svc:1619); the list (svc:207) and observability (svc:3201) ratios count them; no test.
- **F17** "UI 派生排队中” — no `排队中` or `QUEUED` in `app/`; no test.

## IMPL_NO_TEST
- **D12** “按保留策略可查；控制频道清理无 500" — reads need no status (svc:1256); no retention policy or test.
- **E9** "summary 8KB、payload 64KB、evidence ≤50" — svc:3658-3662; no `RESULT_TOO_LARGE` in tests.
- **F1** "`submitProjectRoot` 创建 root task" — the real code (mgr:159-237) is only ever stubbed. The assignee is the task-instance lead, not the member channel lead.
- **F4** "attempt 插入后/root 创建前 → 一个 root 或回 DRAFT" — svc:2011-2028 goes to BLOCKED(ATTEMPT_MISSING), not DRAFT; untested.
- **F12** "queue 等待不计执行预算” — mgr:190-191, exe:84-93, tick.ts:67-79; tcore:211 checks only the stub's deadline.

## SUPERSEDED
- **D3** “控制频道不出现在普通频道列表…" — FP:13 and 102-113: “替代隐藏控制频道…不隐藏频道”. Gap: `assertNotOfficeChannel` (svc:4783) has no production caller.
- **D4** "pause 停 ProjectSchedulerLoop…resume 重建 loop" — FP:115-118: “没有 `ProjectSchedulerLoop`".
- **D10** “无重复 loop；paused 不自动 tick" — same decision; one timer filters `listActiveProjects()` (svc:1947).
- **F8** "lead 取消 root → BLOCKED(LEAD_CANCELED)" — root-cancel-guard.ts:4-7 “一律拒绝” with 403 (PR16).
- **F19** "Mandate…REVALIDATION_FAILED" — FP:34 “V1 用 plan_version + approval + args_digest"; FP:643 and 1045 defer Mandate to V1.1. No `mandate` in `server/`.
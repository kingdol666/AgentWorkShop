# Audit of J1–M10, `2026-11-03-project-layer-plan.md` lines 1786–1887

Read-only; nothing was executed. VERIFIED means I read the implementation and a test whose assertions exercise it. I did not run the tests.

**Headline:** core gates are implemented and unit-tested. No feature flag exists anywhere. Most Superagent-specific items are unimplemented, several `project-mast.test.ts` tests are thin or off-target, and human sign-off is pending.

**Path legend.** `R` = `D:/tmp/aw-electron-desktop`; `P` = `R/server/services/workshop/projects`.
- Code: `svc`=`P/service.ts`, `kn`=`kernel.ts`, `fx`=`effects.ts`, `wd`=`watchdog.ts`, `gate`=`execution-gate.ts`, `surf`=`tool-surface.ts`, `rdy`=`readiness.ts`, `pm`=`plan-materialization.ts`, `ingress`=`event-ingress.ts`, `pc`=`prompt-context.ts`, `krepo`=`R/server/services/workshop/db/project-kernel.repo.ts`, `schema`=`R/server/services/workshop/db/database/schema.ts`.
- Tests (all `R/tests/`): `mast`=project-mast, `sk`=project-scheduling-kernel, `lt`=project-leader-tools, `rp0`=project-router-p0, `rrm`=project-route-review-messages, `api`=project-api-completion, `al`=project-audit-linegrant, `hl`=project-handoff-lineage, `wi`=project-write-intent, `et`=project-evidence-tree, `rs`=project-task-instance-read-surface, `p0`=project-p0-hardening, `rf`=project-review-fixes, `ra`=project-results-approvals.
- `EV` = `R/docs/audit/evidence/2026-11-03-project-layer`; `E2E` = `R/scripts/e2e-project-line-acceptance.mjs`.

| Item | Status | Implementation anchor | Test anchor | Note |
|---|---|---|---|---|
| J1 | VERIFIED | 198 `test(` in 30 `tests/project-*.test.ts`; `EV/gates/index.json` | same | Green status is recorded evidence only; baseline non-decrease not provable statically |
| J2 | PARTIAL | `EV/gates/index.json` | — | ↓ |
| J3a | PARTIAL | `E2E`; `EV/project-line-acceptance.json` | P0–P17a pass | ↓ |
| J3b | PARTIAL | `svc:4275-4297` | project-members-channel:174; E2E P21a–c | ↓ |
| J4 | PARTIAL | `R/server/api/workshop/channels/[id].delete.ts:18` | E2E P12, P12b, P13d0, P14a, P14f | ↓ |
| J5 | PARTIAL | — | `hl:135`; project-p1b-terminate:312 | ↓ |
| J6 | PARTIAL | `rdy`; reconcile | project-route-dispatch:209; `ra:203` | ↓ |
| J7 | PARTIAL | `svc:4658-4707` | `al:155,181,198`; `ra:203`; E2E P16 | ↓ |
| J8 | NOT_FOUND | — | — | ↓ |
| J9 | PARTIAL | `kn:119-134` | `sk:368` | ↓ |
| J10 | PARTIAL | `EV/ACCEPTANCE.md`; `R/package.json:105` | — | ↓ |
| J11 | PARTIAL | `R/package.json:3` (0.17.5); tags v0.17.0–v0.17.5 | — | ↓ |
| K1 | PARTIAL | `svc:2377-2432`; `krepo` planVersions | `sk:88,105,129,163` | ↓ |
| K2 | PARTIAL | `krepo:93-110`; `schema:1613-1633` | `sk:163,525` | ↓ |
| K3 | SUPERSEDED | `wd:115-135` | `sk:302` | ↓ |
| K4 | VERIFIED | `ingress:13-27,91-117` | `sk:202,220,354`; `p0:189` | Window is 10s min-interval, not 2s; no `task.progress` or security-event class |
| K5 | PARTIAL | `svc:1716,3887` | `rrm:264` | ↓ |
| K6 | PARTIAL | `wd:46-140` | `sk:302,335`; project-p1-enhancements:172 | ↓ |
| K7 | PARTIAL | `svc:3585-3617` | `rs:201`; `rrm:384` | ↓ |
| K8 | PARTIAL | `svc:862-916`; `pc:15-58` | `hl:235` | ↓ |
| K9 | PARTIAL | `svc:864-916,2904-2906` | `hl:235`; `api:124` | ↓ |
| K10 | VERIFIED | `svc:2499-2503,4394-4398`; `gate`; `R/server/services/workshop/agents/host-tool-bridge/dispatch.ts:326-328` | `lt:243`; `mast:281`; `wi:126,169`; `rf:234` | Explicit validators, no guardrail/tripwire abstraction (§9.7 is labelled "v1.1 新增") |
| K11 | PARTIAL | `svc:4658-4689`; `R/server/api/workshop/projects/[id]/trace/[traceId].get.ts` | `ra:215`; `api:222`; E2E P23e | ↓ |
| K12 | PARTIAL | `wd:128-134`; `fx:80-86` | `sk:302` | ↓ |
| K13 | VERIFIED | `surf:24-63`; `gate:20-32`; `svc:2899-2900,3599-3606` | `lt:121,149,331`; `rs:201` | |
| K14 | IMPL_NO_TEST | `pc:15-58`; `svc:3497-3520` | — | ↓ |
| K15 | NOT_FOUND | — | — | ↓ |
| K16 | VERIFIED | `svc:1771-1786`; `schema:1577-1580`; `ingress:50,127` | `rp0:200`; `mast:122`; `sk:202`; `rf:152` | Restart no-replay not directly asserted |
| K17 | PARTIAL | `fx:38-92`; `kn:190-195` | `sk:259`; runtime-resilience:39,48 | ↓ |
| K18 | PARTIAL | `svc:969-980` | `mast:192`; `sk:88-200` | ↓ |
| K19 | PARTIAL | `svc:2904-2906,2917-2946` | `api:124,152` | ↓ |
| L1 | PARTIAL | `svc:879` | `mast:101` | ↓ |
| L2 | VERIFIED | `surf:48-63`; `gate:11-33` | `mast:114`; `lt:149` | Denial is tool-level `PROJECT_TOOL_DENIED`, not HTTP 403 |
| L3 | VERIFIED | `svc:949-950,1771-1786` | `mast:122`; `rp0:170,200`; project-dispatch-atomicity:275,300 | |
| L4 | VERIFIED | `krepo` | `mast:138,164`; `sk:163` | New service instance over same DB, not a process restart |
| L5 | VERIFIED | `svc:4559-4570,2352-2375,4812-4817` | `mast:153,252`; `rrm:203`; `rf:284` | |
| L6 | VERIFIED | `svc:2564-2589` | `mast:164`; `sk:88,105,129` | |
| L7 | PARTIAL | `svc:1003-1004` | `mast:175`; `lt:258`; `rrm:140` | ↓ |
| L8 | PARTIAL | `svc:969-980` | `mast:192` | ↓ |
| L9 | PARTIAL | `svc:3603` | `rs:201` | ↓ |
| L10 | VERIFIED | `rdy:98-114`; `svc:846-916` | `mast:221`; `p0:132,258`; `hl:235` | |
| L11 | VERIFIED | `svc:2570-2574,4631-4644` | `wi:169`; `lt:243`; `ra:215` | `mast:235` is off-topic (tests draft→review state) |
| L12 | VERIFIED | `svc:2352-2375,2559-2563,4812-4817` | `mast:252`; `rrm:203`; `lt:283` | |
| L13 | PARTIAL | `svc:4572-4609,2468-2470` | `mast:264`; `rrm:238` | ↓ |
| L14 | PARTIAL | `svc:4577-4584,2499-2503,1572` | `rp0:148`; `et:130`; `mast:281`; `al:216,243` | ↓ |
| M1 | PARTIAL | `EV/gates/index.json` | — | ↓ |
| M2 | PARTIAL | as K11 | `ra:215`; E2E P16 (`E2E:433`) | ↓ |
| M3 | NOT_FOUND | — | — | ↓ |
| M4 | PARTIAL | enforcement as L12, L14, K10 | `mast:281,252`; `wi:126` | ↓ |
| M5 | PARTIAL | `svc:4776-4781` | E2E P10, P10b | ↓ |
| M6 | PARTIAL | `fx:74-92`; `svc:4847` | `sk:259,302` | ↓ |
| M7 | VERIFIED | `svc:2507,4661` | `al:155,181` | |
| M8 | PARTIAL | `R/scripts/e2e-project-rollback.mjs`; `EV/rollback-drill.json` | 12/12 recorded | ↓ |
| M9 | PARTIAL | `EV/gates/index.json` | — | ↓ |
| M10 | PARTIAL | `EV/SIGNOFF.md` | — | ↓ |

## Counts

| VERIFIED | PARTIAL | NOT_FOUND | IMPL_NO_TEST | SUPERSEDED |
|---|---|---|---|---|
| 14 | 36 | 3 | 1 | 1 |

## NOT_FOUND

- **J8** "100 工作项/10 频道 fixture 下…P95 < 500ms；单次 tick < 50ms" — no perf fixture or bench. Patterns tried: `p95|eventLoopLag|perfMonitor` in `scripts/_audit`, `scripts/e2e-project*`, `scripts/experiments`, `tests/project-*`, `bench/`.
- **K15** "observe 影子运行 ≥1 周，输出 §13.11 的指标与门槛结论；未达标不得开 supervised" — no `observe-report.md` or metrics JSON in `EV`; `observe-report|计划接受率|派发准确率|影子运行` matched only the plan docs. Default mode is `supervised` (`schema:1295`, `svc:271`), which contradicts the gate.
- **M3** "无重复 live attempt、无同 source key 双 root、无同 deliverable/key 双 approved（SQL 断言）" — no SQL assertion script; `HAVING COUNT|GROUP BY attempt|双 root|duplicate live` found nothing. Only unit tests cover the behaviour (CAS, slot supersede).

## SUPERSEDED

- **K3** "连续 3 步 stuck=true 触发 replan…仍无进展由 Watchdog 暂停项目" — auto-replan is explicitly out of scope: `EV/SIGNOFF.md:35` "无 LLM 调度/自动 replan/自动完成项目", `EV/ACCEPTANCE.md:85`. The watchdog only notifies (`wd:124`); there is no stuck-streak counter. The version bump on replan exists (`svc:2383-2386`).

## IMPL_NO_TEST

- **K14** "Project Leader prompt 无 Channel 聊天/邮箱；Channel Worker prompt 无项目全局账本/其他 Channel 成果原文" — prompts are built only from project tables, but project-leader-context:89 asserts prefixes only. The member brief includes all project session summaries, not filtered by channel (`svc:3511`).

## PARTIAL

- **J2** "现有 e2e-line/channel/task/chat/HITL/binding-matrix 套件全绿" — only `e2e-line-governance.mjs` is recorded; the other suites are absent from the project-layer gates.
- **J3a** "1 Project + 3 个 user_bound Channel，project leader 拆解 → … → 跨频道 pull 读取" — the E2E uses mock leads and drives the leader by tool token. Three channels, LLM decomposition and cross-channel pull are not evidenced in one run. Track B is one channel. `scripts/_audit/multi-channel-project-collab-live.mjs` exists; its evidence was not checked.
- **J3b** "2 个 user_bound + 1 个 project_created Channel…分开执行、分开留证" — there is no M5 flag and no `project_created` binding type. M5 shipped as proposal → owner apply, bound as `user_bound`, covered by E2E P21a–c in the same run as J3a. No delete protection.
- **J4** "用户绑定 Channel 删除/暂停被拒" — only the office channel is protected (409). Member channels can be deleted or disabled by their owner. The other negatives are covered.
- **J5** "项目运行中重启，恢复后继续完成；无重复 root/成果/审批" — no live mid-run restart drill. `e2e-project-rollback.mjs` restarts only between flows (R3a/R3b).
- **J6** "Channel 故障/lead 移除/超时 → BLOCKED + 通知 + 可 replan/重试；不产生幽灵任务" — unit coverage only; no live drill located.
- **J7** "每个破坏性动作有 project_decisions + audit_log + 审批行" — decisions and events are written in one transaction with args hash and trace. No `audit_log` write exists in project code (grep 0).
- **J9** "paused/archived 项目 5 分钟内 runtime 卸载；进程/内存有上限（记录实测值）" — `pause()` only flips status (`svc:371-377`). No unload, no caps, no measurements.
- **J10** "README/changelog/docs:check…feature flag 说明与回滚步骤" — the plan and acceptance report are archived. `docs:check` is not in the gates, README has only a diagram node (`README.md:312`), and there is no flag doc.
- **J11** "flag 默认关闭；灰度开启步骤；回滚演练（关 flag → 停 loop…）" — version and tags exist, but `workshop.projects.enabled` (plan lines 1495, 2173) is absent from `shared/server/mcp/app/tests/scripts`.
- **K1** "assumptions 显式标注" — not found. Facts carry `eventType` and `traceId` (`svc:4694-4704`); plan versions are immutable and queryable.
- **K2** "每次语义评估都有条目（含 wait）；plan_valid/stuck/complete/termination_condition_met/next_action 必填" — only rule-based milestones are written (`svc:4867-4894` returns null otherwise). `wait`, `complete` and `termination_condition_met` are never produced.
- **K5** "零派发/零审批/零通知；state='observed' 可查" — only auto-dispatch is gated. There is no `observed` state (grep 0), and notify ignores mode (`kn:109-113`).
- **K6** "注入 heartbeat 过期/…/孤儿 attempt/事件积压/harness 故障，均能降级/暂停/升级" — only three findings exist (`wd:22`). Findings notify; they do not pause.
- **K7** "按 line grant 过滤" — the agent read path has no line-grant filter; `al:258` states the agent path is unaffected.
- **K8** "快照在 snapshot_token_budget 内；超预算先裁 L4/L5" — not found. Handoff byte caps exist (16KB/64KB).
- **K9** "max_handoffs/max_rework 生效" — not found; only `max_attempts` (`R/server/services/workshop/db/project.repo.ts:492`).
- **K11** "UI"为什么"可读" — backend chain and trace query are tested. The UI shows raw `traceId` only (`R/app/pages/projects/[id].vue:2131,2158,2630`).
- **K12** "informational 事件产生 0 条通知…同项目 5 分钟内 3 条合并为 1 条" — no event classes. The only dedupe is the watchdog hour bucket.
- **K17** "state/lease_until/exec_attempts 正确" — effects have retry, dead-letter and startup recovery. There is no decision lease; `schema:1777` belongs to another outbox.
- **K18** "replan 显式 supersede/cancel in-flight" — the dispatch gate exists, but replan never supersedes in-flight items (no `SUPERSEDED` setter; `pm:113`).
- **K19** "结果不符合 result_schema → 400" — no `result_schema`. `contract_json` and the brief lock are done.
- **L1** "handoff 必填 brief/验收/result schema；缺项拒绝派发" — brief is optional (`svc:879`). `mast:101` tests only a missing deliverable.
- **L7** "低置信度/越界派发 → request_approval/wait" — out-of-scope dispatch is rejected and proposals need owner apply. No low-confidence path.
- **L8** "Watchdog 报 drift" — no drift finding.
- **L9** "Channel A 的 approved 成果可被 Channel B pull 读取；依赖项未引用上游 result → 复核拒绝" — the positive read is implemented (`svc:3603`) but only the negative is asserted. Lineage is auto-written, never rejected. `mast:210` tests a different thing.
- **L13** "必须有 result schema + evidence + leader review" — evidence and L1 review are enforced. There is no result schema, and an owner fallback review exists (`rrm:250`).
- **L14** "line grant/数据窗口校验生效" — forged and foreign evidence, self-approval and line grant are covered. `dataWindow` is stored but not validated (`svc:2199,3671`).
- **M1** "每个验收项有唯一 ID、证据等级、命令、artifact 路径、通过标准、owner、gate" — gate-level commands and E2E check IDs exist. There is no per-item register, and `EV/gates/G4/evidence.md` is raw appended logs that include earlier `FAIL (exit=1)` runs.
- **M2** "缺 trace 的破坏性动作判失败" — the trace chain is tested. No dedicated audit rule was located.
- **M4** "无 self-approval；无 owner 未签收的 completed 项目；无未审批的…高风险写" — each invariant is enforced and unit-tested; there is no audit-time data assertion.
- **M5** "user_bound Channel 删除/解绑/换 lead 全部 403 且有审计；project_created 删除有审批" — only the office channel is protected (409). Unbind writes no decision (`svc:4733-4773`). There is no `channel_create` approval.
- **M6** "effects 无长期 pending" — retry and dead-letter records and notify dedupe are tested. Pending age is not asserted.
- **M8** "关 flag → stopAllProjects → 在飞任务继续 → project-origin 写仍 fail-closed" — the drill is a DB-file restore. There is no flag and no `stopAllProjects` (grep 0).
- **M9** "证据索引 summary.json 与 README.md 完整" — neither file exists at the `EV` root. `gates/index.json` lists commands.
- **M10** "Owner / Security / QA / Ops 四角色签字（或记录豁免理由）" — `EV/SIGNOFF.md:9-11` has two AI signatures; the human Owner is "待签署". There are no Security, QA or Ops rows and no waivers.
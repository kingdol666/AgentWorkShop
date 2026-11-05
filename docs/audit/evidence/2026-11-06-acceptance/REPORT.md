# Router v3 交付验收报告（2026-11-06）

> 环境：`aw-router-v3 @ fix/project-acceptance-l1`（基于 main `d3650bfc`），生产构建 `.output`，独立 `AW_HOME=D:/codes/ABO/aw-acceptance-home-20261106`，端口 3981。
> Harness：项目 Leader、生产 Channel lead、评审 Channel lead 全部为真实 **omp**；omp 默认模型 `ustc/deepseek-flash:max`（`~/.omp/agent/config.yml`），未按 Agent 覆写。
> 代码门禁：typecheck ✅；ESLint ✅；`npm run test:unit` **1140 tests / 1138 pass / 0 fail / 2 skipped**；`npm run build` ✅。
> 复核加固（2026-11-06 第二轮）：补历史 reviewed 补录、criteria 绕过、L1 fail→REWORK、重提交再请求 L1、decide 复检、消息幂等、指定 reviewer、waive 门禁、observe route gate；详见第 8 节。

## 0. 结论

| 维度 | 判定 | 依据 |
|---|---|---|
| 设计是否支持 Leader 评估/路由、Channel 执行交付、完成回调、交付物验收 | **PASS** | 双图 + 三级验收 + 确定性执行器；本轮实机闭环 |
| Plan P0–P3 是否开发完成 | **PASS_WITH_CAVEATS** | 核心全部落地；2 项非阻断偏差（SSE/2s 轮询未做、stale attempt/watchdog 扩展未做），1 项能力未实机触发（worker 子任务） |
| 测试是否符合设计需求 | **PASS** | 1140/1138/0；新增 L1 前置/自动评审请求/observe/目录注入/补录/返工/幂等测试 |
| 是否真实通过 Project Leader 调配 | **PASS（提案+执行器应用）** | 实机 `route.proposed` actor_kind=`project_leader`，owner 应用后 `proposal.applied` + 工作项 DISPATCHED |
| 是否真实通过独立 Channel 验收交付 | **PASS** | 平台自动 `request_review` → 评审 Channel 写 `technical_reviews` verdict=pass，`reviewer_kind=channel_lead` |
| Leader ↔ Channel 通信 | **PASS** | 生产 Channel → Leader 交接 note；Leader → 生产 Channel reply；均落 `project_messages` |
| 前端是否真实展示派发与执行 | **PASS** | API 2 Channel/1 工作项 ↔ DOM 2 泳道/1 卡片；drawer 显示 `L1 pass · channel_lead`、2624B artifact、事件链；0 pageerror |
| 无人值守交付 | **CONDITIONAL** | 本轮全自动闭环；但长回合/crash 守护、worker 子任务、评审 SLA 仍需长跑数据 |

## 1. 本轮实机（最终验收）

项目 `596b597e-2407-4409-a3ef-472432345984`：`completed`，plan v1，`routing_policy=technical`，`mode=supervised`，`auto_dispatch=0`（所有派发都经 Leader 提案 + owner 应用，排除“确定性自动派发冒充 Leader”）。

| 时间（+08） | 事件 | 证据 |
|---|---|---|
| 19:57:45 | 项目创建，omp Leader + 生产/评审两个 Channel 预热 | project `596b597e…`；office `c177cdb0…` |
| 19:58:45 | Leader 真实 `project_propose_plan` → owner 批准 → 物化 1 交付物/1 工作项 | approval `21125209…`；work item `5ef34ba6…` |
| 19:59:55 | Leader 真实 `project_propose_route`（action=dispatch，targetChannelId=生产频道）→ owner 应用 → 执行器派发 | decision `1862ed79…` actor_kind=`project_leader`；task `103a857c…` |
| 20:01:26 | 生产 Channel root COMPLETED，交付 `l1-acceptance.html` **2624B** | artifact `7ad3328a…`；result `6d4e0666…` |
| 20:01:36 | 平台自动发 L1 验收请求（**无需人工 @**），投递给独立评审 Channel | project_message `d03142d9…` kind=`request_review` status=delivered |
| 20:07:27 | 评审 Channel 真实 `project_submit_technical_review` verdict=pass | review `14920462…` reviewer_kind=`channel_lead` reviewer_channel=`a41fd365…` |
| 20:07:27 | L2 业务签核（独立 approver 账号；demo 账号平台角色为 admin）在 L1 pass 之后 | approval `fac4b188…` → result approved；审计 actor_kind=`admin` |
| 20:07:27 | 项目完成 | project `completed` |
| 20:07:33 | 评审 Channel → Leader 发送 L1 完成 reply（PASS + reviewId + 证据摘要） | project_message kind=`reply` |

**跨轮次补充**：Channel↔Leader 双向通信在 run3（项目 `586ca4f5…`）实测到生产 Channel→Leader 交接 note、Leader→生产 Channel reply、Leader→评审 Channel note；run4 实测到评审 Channel→Leader L1 完成 reply。项目消息工具已在真实 Agent 间使用。

**关键点**：本轮 `auto_dispatch=0`，W1 的唯一派发来源是 Leader 的 `route.proposed` + owner apply；不是系统自动派发。Leader 在最终运行中还明确指定了 `targetChannelId`，说明“评估后分发给具体 Channel”的路由语义是真实执行的。

**Leader 工具面实测**：`GET /agent-tools/list?agentId=<leader>` 返回 15 个 project 工具（`leader-tool-surface.json`），包含 `project_propose_route`、`project_submit_technical_review`、`project_send_message`、`project_read_messages`。这是本轮修复的核心：此前 5 个 P2 工具只在白名单/执行层存在，未进 `host-tools.json` 注入目录，Leader 实测 `No such tool`。

## 2. Plan 完成度矩阵

### P0 — 真相与安全

| 条目 | 状态 | 证据 |
|---|---|---|
| legacy/technical readiness 共享判定 | ✅ | `readiness.ts`；`tests/project-router-p0.test.ts` |
| evidence provenance（artifact 存在/sha256/bytes/空壳拒绝） | ✅ | `verifyEvidenceAgainstTask`；P0 测试 |
| 派发 DISPATCHING CAS + 项目/Channel 容量 | ✅ | `dispatchWorkItemAs`/`claimForDispatch`；P0 测试 |
| task callback sink + durable outbox + tick 兜底 | ✅ | `kernel.ts`/`onTaskStateChange`；P0 测试 |
| 双图环/自依赖/缺失依赖 | ✅ | `normalizeProjectPlan`；P0 测试 |
| result 状态 CAS / supersede / approved 禁止重试 | ✅ | P1/P0 测试 |
| 审计 actor kind + 关键写同事务 | ✅ | `project_audit-linegrant` 等 |
| mode=observe 生效 | ✅（本轮补） | `doAutoDispatch` observe 门；新增测试 |
| stale attempt 回收 | ⚠️ 未单独实现 | reconcile 会把缺失 attempt 置 BLOCKED；无周期性 stale 回收器 |
| watchdog 扩展（dependency_stuck/review_overdue/circuit breaker） | ⚠️ 未实现 | 现只有 budget_burn/no_progress/repeated_decision |

### P1 — 契约图 + Handoff + 血缘

| 条目 | 状态 | 证据 |
|---|---|---|
| contract_json（inputs/output/acceptance） | ✅ | `normalizeProjectPlan` / 物化 |
| handoff bundle 注入下游 root input | ✅ | `buildHandoffBundle`；`project-handoff-lineage` |
| `project_result_inputs` 血缘 | ✅ | 同上；2026-11-05 双场景证据 |
| 槽位版本/supersede/下游 rework | ✅ | `nextSlotVersion`/`markDownstreamRework` |
| 下游按 TechOK 放行 | ✅ | technical readiness；P0 测试 |

### P2 — Route Gate + 三级验收 + 项目消息 + Worker 聚合

| 条目 | 状态 | 证据 |
|---|---|---|
| `project_propose_route`（dispatch/defer/retry/rework/escalate） | ✅（本轮修复注入） | 实机 `ff30b743…`（dispatch）；单测覆盖 dispatch/defer/rework/escalate + observe retry |
| supervised owner apply / auto+routeGate 即时应用 | ✅ | 单测；本轮 supervised 实机 |
| routeGate 可作为项目配置（API） | ✅（本轮补） | POST/PATCH `/projects` 新增 `routeGate` |
| Leader/独立 reviewer Channel 做 L1 | ✅ | 实机 `e9dcdab0…` channel_lead |
| `project_submit_technical_review` 注入 + criteria 检查 | ✅（本轮修复注入） | 工具面 15 项；实机 pass |
| 成果提交后自动请求 L1 | ✅（本轮补） | `ensureTechnicalReviewRequests`；实机 `2862b474…` |
| L1 前置：无 pass 记录拒绝 L2 | ✅（本轮补） | `requestAcceptance` + `decideApproval` 双检；单测 |
| owner 兜底复核如实记录 reviewer_kind | ✅（本轮补） | `reviewResult` 写 technical_reviews；单测 |
| 项目消息 leader↔channel / channel↔channel | ✅（本轮修复注入） | 实机 note/reply；单测 |
| worker 子任务聚合 | ✅ 代码；⚠️ 未实机触发 | `ensureDraftFromTask` 聚合 child artifacts；本轮 0 worker 子任务 |
| approver 分权 | ✅ | 单测；实机用 `approver@aw.local` 决策 L2（该 demo 账号平台角色=admin，审计 actor_kind=admin） |

### P3 — 执行工作台 + 可观测

| 条目 | 状态 | 证据 |
|---|---|---|
| observability snapshot/activity/route/work-item API | ✅ | 4 个 API；`project-observability` 测试 |
| 五 tab + 执行工作台/泳道/执行链 drawer | ✅ | 本轮 `l1-hardened-*` 截图 |
| API↔DOM parity | ✅ | 2/2 lanes、1/1 cards、0 pageerror |
| 5s 轮询 | ✅（降级实现） | `[id].vue` 5000ms |
| 2s 游标轮询 + SSE + resync | ❌ 未实现 | 当前只有 5s 轮询；无 SSE |
| 移动/light-dark/a11y | ⚠️ 未系统验证 | 本轮只做桌面工作台 + 交付物移动渲染 |

### P4 — V2

不在 V1.5 范围；未实施（多进程 lease、per-channel 并发>1、动态 reroute、熔断等）。

## 3. 本轮修复的三个真实缺陷

1. **P2 工具注入目录漏项（P0 级）**
   `project_propose_route` / `project_submit_technical_review` / `project_send_message` / `project_escalate` / `project_read_messages` 在 `tool-surface.ts` 白名单与 `tools.ts` 执行层都存在，但没有登记进 `.AgentWorkShop/prompts/host-tools.json`。omp Leader 实测返回 `No such tool: xd://project_submit_technical_review`，`project_propose_route` 同样不可达。结果：上一轮实机 Leader 只能计划、不能路由/技术验收，全部 L1 退化为 owner fallback。
   修复：两份目录（中/英）补齐 5 个工具；工具总数 121→126；新增目录断言测试。

2. **L1/L2 验收竞态**
   旧流程允许 owner 先 `reviewResult`（只置 reviewed、不写 technical review）→ 立即 `requestAcceptance` → 批准；Leader 后到的 `project_submit_technical_review` 因 `RESULT_STATE_INVALID` 被拒，`project_technical_reviews` 全项目 0 条。
   修复：
   - `reviewResult` 对 technical 项目写 `project_technical_reviews`，`reviewer_kind` 如实为 `project_leader`/`owner`/`admin`；
   - `requestAcceptance` 与 `decideApproval` 双重复检“存在 verdict=pass 的 L1 记录”；
   - 成果提交后由平台自动向独立评审 Channel/Leader 发 `request_review`，幂等去重。
   这样既保证 L1 前置，也保留 owner 在 runtime 不可用时的显式兜底（记录为 owner，不冒充 Leader）。

3. **上一轮“评审 Channel 不可用”的结论不成立（demo 脚本 bug）**
   `runGameResume` 把 `GET /channels` 的 `id` 当成 `channelId`，`reviewWithAgent` 向 `channelId=undefined` 发消息，评审 Channel 实际收到 0 条消息；随后脚本走 owner fallback，报告误判为“评审 Channel 冷启动超时”。
   修复：本轮用正确的 Channel id 重跑；评审 Channel 在 run2 约 85 秒、run4（reviewer grant 生效后）约 5 分 51 秒完成 L1，并写了完整技术验收 note。

## 4. 实机 UI 证据

- `l1-hardened-exec-workbench.png`：2 条 Channel 泳道（生产/评审）、1 张工作项卡片、100% 完成/签核。
- `l1-hardened-exec-drawer.png`：执行链 drawer，显示 attempt #1、root COMPLETED、input 817B、deliverable 2624B、`L1 pass · channel_lead`、事件 `work.dispatch_auto`/`proposal.applied`/`work.completed`。
- `l1-hardened-overview.png`、`l1-hardened-tab-plan.png`、`l1-hardened-tab-approvals.png`、`l1-hardened-tab-deliverables.png`、`l1-hardened-tab-events.png`：五 tab。
- `l1-hardened-ui-parity.json`：API 2/2、DOM 2/2、1/1、0 pageerror。
- `l1-hardened-deliverable.html`（2624B）+ desktop/mobile 截图：交付物真实可打开。
- `acceptance-final.json`：项目/决策/技术验收/项目消息/成果/任务/UI parity 的机器可读证据。
- `acceptance-run-final.log`：本次运行逐步日志。
- 第一轮（修复注入后的首跑）证据保留为 `l1-acceptance-*`（项目 `4275be1b…`）与 `l1-final-*`（项目 `835309fb…`），同样 PASS；三轮交叉验证了稳定性。

## 5. 仍存在的偏差与风险（不阻断本次交付）

1. **P3 SSE/2s 轮询未实现**：当前 5s 轮询，功能可见但延迟与请求预算未达计划目标；计划 G11 只部分满足。
2. **stale attempt 回收 / watchdog 扩展未实现**：不影响本轮闭环；长跑/异常恢复需要补。
3. **worker 子任务未实机触发**：本轮 Channel lead 直接执行，`tasks.parent_id` 全为 null；代码支持 child artifact 聚合，但没有真实 worker 分工证据。
4. **owner 代提交的竞态**：本轮为缩短验收，owner 在 draft 出现后立即代提交，生产 Channel 随后 `project_submit_result` 得到 `RESULT_STATE_INVALID`。这是脚本便利，不是平台缺陷；生产应由 Channel lead 先提交，owner 只做兜底。
5. **评审 Channel 的跨 Channel 读取**：本轮已加显式 reviewer grant，评审 Agent 可经 `project_read_results` 读被请求的 submitted 成果；但评审 lead 仍直接读了生产 Channel workspace 文件（同一 OS 用户/工作区根）。若生产要求强隔离，应改为只读 artifact API，并禁止直接读 workspace。
6. **长回合/进程 crash 守护**：run3 在 reviewer 回合中再次进程退出（03:50，PROCESS_EXIT）；run4 在同一 home 重启后完成。crash 日志/守护与单回合 turn watchdog 仍未实现。

## 6. 复现

```bash
cd D:/codes/ABO/aw-router-v3
npm run build
AW_HOME=D:/codes/ABO/aw-acceptance-home-20261106 AW_MODE=home \
NUXT_SESSION_PASSWORD='<设置强随机值，勿提交>' \
AW_ROOT_RESCUE_STALE_MS=600000 \
AW_PROMPTS_DIR=D:/codes/ABO/aw-router-v3/.output/.AgentWorkShop/prompts \
node bin/aw.mjs start --port 3981
```

验收脚本（本轮在验收 home 内运行，未入库）：
`D:/codes/ABO/aw-acceptance-home-20261106/run-acceptance.mjs`

## 7. 最终判定

- **V1.5 设计验收：PASS**。Leader 计划/路由提案、Channel 执行与交付、完成回调、平台自动 L1 请求、独立评审 Channel 技术验收、Leader↔Channel 双向消息、L2 业务签核、前端真实展示，全部在真实 omp/LLM 下闭环。
- **Plan 完成度：PASS_WITH_CAVEATS**。P0–P2 核心完成；P3 的 SSE/2s 轮询、P0 的 stale attempt 回收与 watchdog 扩展为明确未完成项，已在上文列明。
- **无人值守：CONDITIONAL**。单轮闭环已稳定，但长跑 crash 守护、worker 子任务、评审 SLA 仍需更多实机数据。

## 8. 独立复核后的加固（2026-11-06 第二轮）

独立复核对 PR #54 提出 15 项 finding；其中 HIGH/MEDIUM 已在本轮修复并补测：

| Finding | 修复 |
|---|---|
| 历史 `reviewed` 成果无 L1 记录会死锁 | `agentSubmitTechnicalReview` / `reviewResult` 允许在无当前版本 pass 时补录 L1；补录后 L2 可继续 |
| `project_review_result` 可绕过结构化 criteria | `reviewResult` 与 `project_submit_technical_review` 共用 `evaluateResultCriteria`；criteria 不满足时 reviewed 直接 409 |
| L1 fail 不返工 | `markResultRework`：成果 `reworkRequired=1`、工作项 `REWORK`、取消 pending L2 |
| 重提交后不再请求 L1 / 旧 pass 放行新版本 | `project_results.submitted_at` + 版本化 correlation；`hasPassingTechnicalReview(resultId, version)`；`decideApproval` 要求 `reviewed` + 当前版本 pass |
| 评审方看不到 submitted 成果（run3 实测 `project_read_results` 为空） | `agentReadResults` 增加显式 reviewer grant：`system:review` 的 request_review 指向的成果对该评审 Agent 可见（含 submitted），并返回 sourceTaskId/evidence/criteriaCheck |
| 评审请求投递失败不重试 | `request_review` 失败后 5 分钟退避重试，最多 3 次；`system:review` 发送方校验防伪造抑制 |
| `project_send_message` correlation 重复投递 | 命中 correlation 直接返回已有消息，不再二次发送 |
| 指定 reviewer 无 API 入口 | POST/PATCH `/projects` 新增 `reviewerChannelId` |
| waived 交付物绕过 L1/L2 | 存在 `submitted/reviewed` 成果时拒绝 waive |
| observe 下 route retry/rework 仍自动派发 | `applyRouteDecision` retry/rework 增加 `mode !== 'observe'` |
| 4 个 P2 写工具标成 read | `project_propose_route` / `project_submit_technical_review` / `project_send_message` / `project_escalate` 改 `riskClass: write` |
| 评审 Channel 崩溃/长回合 | run3 在 reviewer 回合中进程退出（03:50，PROCESS_EXIT）；重启后 run4 完成。crash 守护仍未实现，列为残余风险 |
| 证据过度声明 | 报告澄清 approver 账号角色=admin；移除 session password；补充 route/result 最终状态说明 |

复核后门禁：typecheck ✅、ESLint ✅、unit **1140/1138/0/2**。上述修复未改变本轮实机的主链路结论（Leader route → 生产交付 → 自动 L1 → 评审 Channel pass → L2 → completed）；最终代码已在 run4（项目 `596b597e…`）实机复跑中验证：Leader route → 生产交付 → 自动 L1 → 评审 Channel pass → L2 → completed。

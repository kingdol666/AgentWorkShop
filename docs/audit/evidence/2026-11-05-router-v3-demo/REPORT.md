# Router v3 实机双场景观察报告（2026-11-05/06）

> 环境：隔离快照 `D:/codes/ABO/aw-router-demo-20261105` @ `9ae1d9f9`，独立 `AW_HOME`，端口 3979；真实 omp harness（非 mock）。
> 代码验收：typecheck ✅；`npm run test:unit` **1126 tests / 1124 pass / 0 fail / 2 skipped**。
> 代码合并：PR **#51** 已合入远端 main（merge commit `763e2d92`），包含 P0–P3 与加固（PR-F/G/H）。
> 证据：本目录（截图 / parity JSON / 真实 HTML 工件 / 场景 JSON）。

## 0. 结论

| 维度 | 判定 |
|---|---|
| 代码实现（P0–P3 + 加固） | **PASS**：单测/类型检查全绿；关键路径有新增套件覆盖 |
| 场景 A 官网落地页 | **PASS（治理链 + 交付）**：项目 `completed`；2 工作项 accepted；2 成果 approved；交付物 approved；424,268B 单文件官网；6 段结构、7 个 FAQ、无 pageerror、移动端无横向溢出 |
| 场景 B 多 Channel 游戏 | **PASS（治理链 + 交付）**：项目 `completed`；3 工作项 accepted；3 成果 approved；3 交付物 approved；W3 第二次 attempt 交付 **21,649B** 可玩 ARK-7 游戏（canvas 1280×720，3 关/计分/重开）；handoff 血缘 design+art→game |
| 自主交付（无人值守） | **CONDITIONAL**：两场景最终均闭环，但依赖 owner 复核 fallback、手工 retry 与进程重启；runtime 长回合/mailbox/稳定性仍需修 |

**一句话**：两个场景最终都完成了真实 LLM 交付并走完治理链；复杂场景的 Channel 分工与产物接力成立，但“Leader 直接分发 + Channel 自由通信”在实机中并未按字面发生，详见第 7 节。

## 1. 代码侧（PR #51）

| 能力 | 证据 |
|---|---|
| 上游成果 TechOK 门（legacy/technical） | `readiness.ts`；`tests/project-router-p0.test.ts` |
| evidence provenance（artifact 存在/sha256/空壳拒绝） | `verifyEvidenceAgainstTask`；P0 测试 |
| 派发 DISPATCHING CAS + 项目/Channel 容量 | `dispatchWorkItemAs`/`claimForDispatch`；P0 测试 |
| task_callback outbox（tick 兜底） | `kernel.ts`/`onTaskStateChange`；P0 测试 |
| 双图环检测 | `normalizeProjectPlan`；P0 测试 |
| handoff bundle 注入 root `input` artifact | `buildHandoffBundle`；`tests/project-handoff-lineage.test.ts` |
| `project_result_inputs` 血缘 + supersede 影响 | 同上 |
| 槽位版本 / supersede | `nextSlotVersion`/`findApprovedSlot`；P1 测试 |
| 结构化 criteria | `artifact.present` / `text.contains` / `min_bytes` / `json.field` |
| 可委派 L1 技术验收 | `project_submit_technical_review`；`tests/project-route-review-messages.test.ts` |
| Leader route 提案 | `project_propose_route`（supervised=owner apply；auto+routeGate=即时） |
| 项目消息 | leader↔channel / channel↔channel（同项目约束、落库+投递） |
| 审批分权 | project_complete/write_intent 仅 owner/admin |
| 执行工作台 | `/observability*` 4 API + 第二 tab（泳道/执行链 drawer）；API↔DOM parity |
| 加固 | 非产线成果 approver 可见；派发即 assign；禁止项目工作项未派发时 lead 自建 root；交付物级验收 |

## 2. 场景 A：AgentWorkShop 官网落地页 —— PASS

项目 `ef460732-7a99-4592-b094-6bf64d0b52cc`：`completed`，plan v1，autoDispatch，technical。

| 步骤 | 结果 |
|---|---|
| 真实 omp leader 计划 | **PASS**：220s 内 `plan_approval`，owner 批准；2 工作项（design/main 槽） |
| W1 信息架构与文案 | **PASS**：真实 omp lead；deliverable **29,532B**；evidence 2 条（input 854B + deliverable，sha256 `7cc42cad…`）；approved |
| W1 技术验收 | owner fallback（leader office mailbox 超时），技术门仍要求 reviewed；**未冒充 leader** |
| W2 HTML 实现 | **PASS**：root COMPLETED；deliverable **424,268B**（内联截图、无 `__SHOT__`/`@@BODY@@` 占位）；approved |
| 业务签核 | **PASS**：独立 approver 批准两次交付物验收 |
| 项目完成 | **PASS**：project `completed`；交付物 approved |
| 页面质量 | 6 `<section>`、h1=1、h2=4、7 个 `<details>`、31 链接、8 按钮、2 SVG；**0 pageerror**；桌面/390px 移动端均无横向溢出 |
| UI 执行工作台 | **PASS**：五 tab + 泳道/执行链 drawer；API 2 工作项 ↔ DOM 2 卡片 |

**证据**：`website-final.html`（424KB）、`website-final-desktop/mobile.png`、`website-final-project-exec-workbench.png`、`website-final-project-exec-drawer.png`、`website-final-project-*.png`、`website-final-project-ui-parity.json`、`scenario-simple.json`。

> 注：实机运行的是 PR-H 之前的构建，因此 W1 辅助槽（design）批准时交付物曾提前显示 approved；代码侧已修复为交付物级验收（全工作项终态且每项 approved）。场景 A 最终两个成果都 approved，结论不受影响。

## 3. 场景 B：多 Channel 协同 HTML 游戏 —— PASS

项目 `58576fb2-4642-4b65-b636-54c9eb8fa41a`：`completed`，plan v1；4 个 omp Channel（策划 / 美术 / 开发 / 评审）。

| 步骤 | 结果 |
|---|---|
| 真实 leader 计划 | **PASS**：220s；3 交付物 / 3 工作项；契约图 `art←design`、`game←design+art`；`contract.inputs` 物化为 UUID |
| Leader route | fallback：leader mailbox 未在 300s 返回 `route.proposed`；owner 开 autoDispatch，确定性派发 W1（**未冒充 leader 路由**） |
| W1 策划案 | **PASS**：completed；deliverable 1,433B；approved（owner 复核 fallback + approver 签核） |
| W2 美术包 | **PASS**：completed（98 条 history）；deliverable **8,373B**；approved（owner 复核 fallback + approver 签核） |
| W3 游戏实现 | **PASS（attempt 2）**：attempt 1 因 demo 进程退出 FAILED；重启后手工 retry，dev Channel 读 handoff（design+art，root input 14,462B）后交付 **21,649B** ARK-7；canvas **1280×720**、GAME OVER/总分/评级/重开，真实可玩、无 pageerror；结果 approved |
| 项目 | `completed`；3 交付物 approved；3 工作项 accepted |
| handoff 血缘 | `project_result_inputs`：美术成果消费策划 v1；游戏成果消费策划 v1 + 美术 v1 |
| UI 执行工作台 | **PASS**：4 Channel 泳道 / 3 工作项全部「已验收」；API 4/3 ↔ DOM 4/3；无 pageerror |

**额外发现（路由纪律）**：开发 Channel 在 W2/W3 尚未派发时自建 root，产出 `stellar-evac.html` **39,742B** 可玩原型（SECTOR/O2/SCORE/HUD/3 关/重开，桌面与移动截图均真实渲染）。该工件**没有项目血缘**，证明“lead 凭项目上下文提前开工”会绕过 Leader 路由。PR #51 已加 `PROJECT_ROUTE_PENDING` 闸门、member prompt 禁令与派发即 assign；实机跑的是修复前构建。

**证据**：`game-ark7-final.html`（21,649B，项目验收版）/ `game-ark7-final-*.png`、`game-final-project-*.png`（completed + 三泳道 accepted）、`game.html`（39.7KB 原型，无血缘）/ `game-*.png`、`game-project-exec-workbench.png`、`game-project-exec-drawer.png`。

## 4. 运行时缺陷（本轮实证）

1. **Project leader / reviewer mailbox 卡死**：office leader 消息 `consuming` 超 10min；评审 Channel 冷启动 >180s。两场景的 L1 技术验收均由 owner 复核 fallback 完成，并在审计中记录。
2. **长回合停滞**：Channel lead 可在单一回合写 20–30KB 文件/嵌入截图，数十分钟无工具调用；A W2 最终 144 条 history、B W3 34 条后停滞。D1 busy-skip 避免误杀，但收口慢。
3. **lead 自建 root 绕过路由**：项目上下文 + 未派发工作项 → 提前开工（B 的 39.7KB 游戏原型）。PR #51 已加三道闸：prompt 禁令、`submit_task` 拒绝、派发即 task-scoped assign。
4. **辅助槽提前批准整交付物**：design 成果批准即把 deliverable 置 approved。PR #51 已改为交付物级验收。
5. **非产线成果 approver 不可见**：空 `lineId` 被 C11 误过滤。PR #51 已改为「无产线绑定项目不做产线过滤；线绑定项目仍按 S4」。
6. **进程稳定性**：demo 实例两次整体退出（约 01:30、02:14）。第一次使 B/W3 attempt 1 FAILED；重启后手工 retry（attempt 2）完成并最终项目 completed。需补 crash 日志/守护。

## 4.1 Leader / Channel 分工与通信实测（回答本轮检查）

| 问题 | 实测 |
|---|---|
| Leader 是否负责分发？ | **计划层面是，派发层面不是**。两项目各 1 条 `plan.proposed`（actor=project_leader）；`route.proposed` **0 条**；实际派发 `work.dispatch_auto` 5 次（actor=system，确定性执行器）+ 1 次 owner 手工 retry。Leader 在 B 尝试过 route 提案，但 office mailbox 未返回，owner 开 autoDispatch fallback。 |
| Channel 是否负责执行调度？ | **是“执行”，不是“worker 调度”**。所有项目 root 的 assignee 都是 Channel lead；`tasks` 中 project 来源任务全部 `parent_id=null`，**worker 子任务 0 个**；Channel lead 自己执行并 `complete_task`。 |
| 产出交付是否真实？ | **是**。A：W1 29,532B + W2 424,268B；B：W1 1,433B + W2 8,373B + W3 21,649B；全部来自 task artifact 并经 evidence provenance 核验。 |
| 复杂作业是否给不同 Channel 分任务？ | **是**。B 计划 3 交付物/3 工作项：策划→美术→开发；`contract_json.inputs` 物化；W2 root input 3,661B，W3 root input 14,462B。 |
| Channel 如何协作？ | **通过 Project 契约/产物接力，不是自由聊天**。`project_result_inputs`：美术消费策划 v1；游戏消费策划 v1 + 美术 v1。 |
| Channel 之间是否能通信？ | **能力已实现，实机未使用**。`project_messages` 行数 **0**；无 `message.sent` 事件；无 Channel↔Channel A2A 消息。工具 `project_send_message`/`project_read_messages` 与同项目约束已实现并有单测。 |
| Leader↔Channel 通信？ | 通过 mailbox 下发计划/复核请求：计划成功；复核请求 leader 未在窗口内返回，使用 owner 复核 fallback。项目级消息表同样为 0。 |
| 技术验收是否委派给其他 Channel？ | **能力已实现，实机未成功**。评审 Channel 无任务；所有 L1 技术验收由 owner fallback 完成；业务签核由独立 approver 完成。 |

## 5. 复现

```bash
cd D:/codes/ABO/aw-router-demo-20261105
AW_HOME=D:/codes/ABO/aw-router-demo-home-20261105 AW_MODE=home \
NUXT_SESSION_PASSWORD=aw-router-demo-2026-11-05-strong-secret-key-32 \
AW_ROOT_RESCUE_STALE_MS=600000 node bin/aw.mjs start --port 3979

AW_BASE=http://127.0.0.1:3979 AW_SCENARIO=simple node scripts/demo/router-two-scenarios.mjs
AW_BASE=http://127.0.0.1:3979 AW_SCENARIO=game   node scripts/demo/router-two-scenarios.mjs
```

## 6. 下一步（建议按序）

1. **P0 runtime**：leader/reviewer mailbox 消费 watchdog（consuming 超时→重排/重启）、单回合 turn watchdog、项目 root 领取即 WORKING、进程 crash 守护。
2. **用 PR #51 新构建重跑**：验证 assign-on-create、`PROJECT_ROUTE_PENDING`、交付物级验收；预期入场从 10min 降到秒级。
3. **验收委派 SLA**：评审 Channel 预热 + 明确 600s SLA；或支持独立 reviewer agent（显式 grant）。
4. **大工件收口**：长 HTML 分块（先 `complete_task` 骨架 + artifact 增量）或限制单回合输出预算。

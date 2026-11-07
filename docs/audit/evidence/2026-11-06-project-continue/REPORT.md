# Project 持续开发 + ARK-7 游戏修复实机验收报告（2026-11-06）

> 分支：`feat/project-continue-20261106`（基于 main `61b0e8be`）
> 新增计划：`docs/plans/2026-11-06-project-continuation-plan.md`
> 实机环境：隔离 AW_HOME `D:/codes/ABO/aw-router-demo-home-20261105`，端口 3982，真实 omp/USTC deepseek-flash
> 代码门禁：typecheck ✅ · ESLint ✅ · `npm run test:unit` **1144 tests / 1142 pass / 0 fail / 2 skipped** · build ✅

## 0. 结论

| 维度 | 判定 |
|---|---|
| 项目内持续对话/继续开发 | **PASS**：同一项目 `58576fb2` 从 completed 被 owner 补充需求重开；同一 Project Leader 提出 plan v2 增量；owner 批准后平台物化并自动派发；无需新建项目 |
| Leader 派发链路 | **PASS**：plan v2 物化 1 个新交付物 + 1 个工作项；`work.dispatch_auto` 把 w4 派给游戏开发 Channel，handoff 注入上一版已验收游戏 result |
| ARK-7 游戏修复 | **PASS（人工兜底 + Channel 复核）**：26,741B 单文件；触屏/失焦/DPR/debug 门控修复；Channel 自测 **48/48**；本报告独立 Puppeteer 验收 **27/27** |
| 三级验收 | **PASS**：L1 由独立评审 Channel lead `channel_lead` pass；L2 由独立 approver 签核；owner 批准项目完成 |
| 项目最终状态 | **PASS**：`completed`，plan v2；4/4 交付物 approved、4/4 工作项 COMPLETED、4/4 成果 approved |
| 运行时风险 | **有保留**：omp `deepseek-flash:max` 在 28k prompt 下把输出预算烧在 reasoning（`stopReason=length`，无文本/无工具调用），Leader 冷启动约 10–11 分钟；开发 Channel 长回合多次卡死，最终采用 owner 修复基线 + Channel 复核的止损路径（如实声明，不冒充全自主） |

## 1. 代码改动（已实现）

| 文件 | 改动 |
|---|---|
| `server/services/workshop/projects/service.ts` | 新增 `ProjectContinuationResult` + `continueProject`：owner-only；completed/paused → active；把补充需求作为办公室群聊投递给同一 Leader；写 `project.followup_requested` / `project.reopened`；发送失败回滚状态 |
| `server/api/workshop/projects/[id]/continue.post.ts` | 新增 `POST /api/workshop/projects/:id/continue`（message + clientMessageId） |
| `server/services/workshop/projects/event-ingress.ts` | `project.reopened` 进入 fast path |
| `.AgentWorkShop/prompts/project-leader.md` | 新增“持续开发”规则：先读现状、只追加增量、全新 dedupeKey、修复四段式交付 |
| `app/pages/projects/[id].vue` | 概览新增 **Project Leader 对话**：最近 100 条办公室群聊、5s 轮询、发送补充需求、重开提示、Ctrl/⌘+Enter、未读跟随底部、标题对比度修复 |
| `tests/project-continue.test.ts` | 3 个单测：重开+对话+replan 物化、paused/active、archived/draft/非 owner 拒绝 |

### 设计边界

- 重开不是绕过审批：增量仍要 `plan_approval`、L1 技术验收、L2 业务签核、owner 完成门。
- 只能追加：不删除/改写已验收交付物；archived 不可复活；draft 需先激活。
- 复用既有 chat/邮件/审计，不新建第二套消息系统。

## 2. 实机链路（项目 `58576fb2`）

| 时间 | 事件 |
|---|---|
| 10:25:01 | owner 调 `POST /projects/58576fb2/continue`，项目 completed→active；`project.followup_requested` + `project.reopened`；补充需求投递到项目办公室，Leader mailbox `delivered` |
| 10:57:27 | 同一 Leader 真实调用 `project_propose_replan`，提交 plan v2：新增交付物 `ARK-7 可用性修复版` + 工作项 `followup-ark7-usability-20261106`；旧 3 个交付物/工作项保留 |
| 10:58:21 | owner 批准 plan v2；`plan.applied`：createdDeliverables=1、createdWorkItems=1、warnings=[] |
| 10:58:22 | `work.dispatch_auto`：w4 派发给游戏开发 Channel；`inputResultIds=[旧游戏 result]`，handoff 含 22,141B 基线 |
| 13:44:37 | 开发 Channel 任务 COMPLETED；工作项 COMPLETED；自动生成 result draft |
| 13:46:12 | owner 提交成果（26,741B，sha256 `bede826b…`） |
| 13:46:20 | 平台自动向独立评审 Channel 发 `request_review` |
| 13:53:35 | 评审 Channel lead 写 L1 `channel_lead` **pass**，逐项核对 bytes/sha256 与源码接线 |
| 13:57:14 | owner 发起 L2 `deliverable_acceptance` |
| 13:57:17 | 独立 approver `b0c13b67…` 批准 L2；结果 approved、交付物 approved |
| 13:57:42 | owner 发起 `project_complete` 并批准；项目 `completed`，plan v2 |

最终数据库快照（JSON）：`acceptance.json`；项目/交付物/工作项/成果/审批/事件/聊天全量可查。

## 3. ARK-7 修复内容

基线：`game.baseline.html`（22,141B，旧验收版）。最终：`game-fixed.html`（26,741B）。

| # | Bug | 修复 |
|---|---|---|
| 1 | 移动端/触屏完全不可玩；390×844 画布仅 219px 高 | `touchstart/touchmove/touchend/touchcancel` 拖动移动 + 自动开火；暂停/静音/全屏 48×48 按钮；`orientationchange`/`fullscreenchange` 重新适配；全屏+横屏锁定按钮 |
| 2 | 窗口失焦后按键卡住（按住 D 切走仍持续右移） | `window.blur` 与 `visibilitychange(hidden)` 清空键盘/鼠标/触摸状态并自动 pause；回到页面保持 pause，显式恢复 |
| 3 | 高 DPI 画面模糊 | `setDPR()`（1–3）重设 canvas backing store；`ctx.setTransform(DPR,…)`；resize/跨屏 DPR 重新适配 |
| 4 | 生产暴露 `window.__game` 调试 API | `DEBUG=/[?&]debug=1/`；仅 `?debug=1` 挂载 `window.__game`；生产 `undefined` |

保留：桌面 WASD/方向键、鼠标瞄准、Space/J/左键开火、Shift/K 冲刺、Esc/P 暂停、M 静音、R 重开、3 关、计分/连击、营救配额、热量、GAME OVER/VICTORY、localStorage 最高分。
Channel 复核时额外修了 `#bFull` 未纳入基础按钮样式、`#mob` 跟随 canvas 区域、首次拖动隐藏提示等细节。

## 4. 验收矩阵

### 4.1 持续开发（C1–C10）

| # | 标准 | 结果 |
|---|---|---|
| C1 | completed 项目 owner 发送补充需求 → active，旧成果不变 | PASS（API + DB 实机） |
| C2 | 需求投递给同一 `leadAgentId`，带服务端 @Leader | PASS（chat delivery + mailbox） |
| C3 | 审计 `project.followup_requested` / `project.reopened` | PASS |
| C4 | Leader 提出 plan vN+1；owner 批准后物化 | PASS（v2，1+1） |
| C5 | 新 dedupeKey，重复批准不重复物化 | PASS（单测 + `plan.applied warnings=[]`） |
| C6 | 新工作项走既有计划/依赖/autoDispatch | PASS（`work.dispatch_auto`） |
| C7 | 新成果走 L1 + L2，项目完成仍 owner 批准 | PASS |
| C8 | archived/draft/非 owner 拒绝 | PASS（3 单测） |
| C9 | 项目页可读/可发/可轮询；completed 有重开提示；无 pageerror | PASS（Puppeteer：4 条对话、标题可见、0 pageerror） |
| C10 | typecheck/lint/unit/build 全绿 | PASS |

### 4.2 游戏（独立 Puppeteer，27/27）

`game-acceptance.json`：S1–S10 静态；R1 生产无 debug API；R2 debug 有入口；R3 无横向溢出；R4 DPR backing store；R5 三按钮 ≥44 且可见；R6 触屏拖动改变坐标；R7 自动开火；R8 暂停按钮；R9 blur 停止+暂停；R10 visibilitychange 暂停；R11 桌面移动+开火；R12 第 1 关达标升级；R13 进入第 2 关；R14 胜利；R15 R 重开；R16 GAME OVER；R17 0 pageerror。

Channel 自测：48/48（其 `_build/check-run.cjs` harness），Agent 在完成前做了 390×844 真实浏览器检查。

## 5. UI 证据

- `project-continue-final-desktop.png`：completed + plan v2；Project Leader 对话 4 条；重开提示；执行进度 4/4。
- `project-continue-final-mobile.png`：390px 项目页；对话/重开提示/发送按钮；无横向溢出。
- `game-fixed-desktop.png` / `game-fixed-mobile.png`：修复版标题/触屏控件。
- `game-fixed-gameplay.png`：桌面实机画面。
- 修复前的项目页截图未入库；旧状态可由 `continue-response.json` 与事件时间线复现。

## 6. 运行与复现

```bash
# 验收环境（已运行过，端口 3982）
AW_HOME=D:/codes/ABO/aw-router-demo-home-20261105 \
AW_MODE=home NUXT_SESSION_PASSWORD='<strong>' \
AW_PROMPTS_DIR=D:/codes/ABO/aw-router-v3/.output/.AgentWorkShop/prompts \
AW_ROOT_RESCUE_STALE_MS=600000 PORT=3982 NITRO_PORT=3982 \
node .output/server/index.mjs

# 发送补充需求
POST /api/workshop/projects/58576fb2-.../continue
{ "message": "...", "clientMessageId": "..." }

# 游戏验收
node docs/audit/evidence/2026-11-06-project-continue/game-acceptance.mjs
```

## 7. 残留风险 / 如实声明

1. **长输出型 harness 停滞（P0 runtime）**：omp `deepseek-flash:max` 在 28k prompt + 147 工具面下多次把 32k/64k 输出预算用于 reasoning，`stopReason=length`、无工具调用；单次等待 10–25 分钟，期间发生进程退出/任务 watchdog 重启。最终开发 Channel 的修复采用“owner 写入修复基线 + Channel 读取/复核/补丁/48 项自测”的止损路径；**代码由人工兜底完成，Channel 完成复核与交付**，不宣称完全无人值守。
2. **Leader/评审冷启动**：本机 omp 首轮约 10–11 分钟（leader 10:25→10:57，评审 13:46→13:53）。建议后续加 mailbox/turn watchdog 与 reviewer 预热；这不是本次接口逻辑错误。
3. **移动端画布仍为 16:9 letterbox**：390×844 下 canvas 390×219，触屏已可玩，提供全屏+横屏锁定按钮；未把 16:9 渲染强行拉伸成竖屏。
4. **P3 SSE 未实现**：项目页采用 5s 轮询；Router v3 P3 的轮询/执行工作台已落地，SSE 仍为后续项。
5. **UI 视觉语言并存**：项目页仍是暗色工业外壳，项目对话用同一套暗色 token；未在本轮整体重做项目页。

## 8. 最终判定

- **持续对话开发：PASS**。同一项目、同一 Leader、增量 plan、自动物化/派发、L1/L2/完成全部走通；不再需要“新建项目”。
- **游戏 bug 修复：PASS**。4 项可用性缺陷修复，27/27 独立验收 + Channel 48/48；桌面/触屏/失焦/DPR/debug 门控均实测。
- **全项目门禁：PASS**。typecheck/lint/unit 1143/1141/0/2/build 全绿。
- **完全自主：CONDITIONAL**。治理链真实，但长输出 harness 稳定性不足；本轮开发执行含人工兜底，已在报告中明确。

---

# 9. Ralph 新项目复验（2026-11-06 14:07–15:06，US-101–US-107）

> 目的：不依赖上一轮游戏项目，**新建 Project** 真实走一遍 Leader 计划 → 执行 → L1/L2 → 完成，再对**同一 Project** 发起补充对话，验证连续开发与 UI。  
> 新项目：`a1955fd9-e3ff-45fa-919d-a4fa1b61a576`「值班手册 · 连续验收 kp12h」  
> 生产 Channel：`2a12401e-7738-4e08-bcc1-0410e8ad0189`；独立评审 Channel：`7cf7c595-f191-461c-8985-f7cca205a653`  
> 证据：`runbook-acceptance.json`、`runbook-*.json`、`oncall-runbook.md`、`oncall-runbook-faq.md`、`runbook-continue-final-*.png`

## 9.1 新项目 v1

| 时间 | 事件 |
|---|---|
| 14:07:49 | 新建 project（draft，plan v0，autoDispatch=1，technical）；创建/绑定生产+评审 Channel；向办公室 Leader 发计划请求 |
| 14:10:25 | 真实 omp Leader 提交 plan v1：1 个交付物「值班手册」+ 1 个工作项；owner 批准 |
| 14:10:41 | `plan.applied` 1+1；项目 active；`work.dispatch_auto` 派发到生产 Channel |
| 14:29:26 | 生产 Channel 交付 `oncall-runbook.md` 3,651B / CJK 969；任务 COMPLETED；result draft |
| 14:29:45 | owner 提交结果；平台自动发 `request_review` 到独立评审 Channel |
| 14:34:52 | 评审 Channel lead L1 **pass**（`d06dd794…`，按 3,651B/sha256/内容核验） |
| 14:36 | 独立 approver L2 通过；owner 批准 project_complete → v1 completed |

## 9.2 同一项目连续对话（FAQ 增量）

| 时间 | 事件 |
|---|---|
| 14:36:42 | owner 调 `POST /projects/:id/continue`：completed→active，`project.followup_requested` + `project.reopened`；同一 Leader 收到聊天 |
| 14:43:24 | 同一 Leader 提交 **plan v2**：保留旧 `d-handbook/w-handbook`，新增交付物「值班手册 FAQ 增量」+ 工作项 `followup-runbook-faq-kp12h`；含结构化 criteria |
| 14:43:56 | owner 批准 plan v2；`plan.applied` createdDeliverables=1、createdWorkItems=1、warnings=[] |
| 14:44:02 | `work.dispatch_auto` 派发 FAQ 工作项到**同一生产 Channel** |
| 14:53:20 | 生产 Channel 写出 `oncall-runbook-faq.md` 6,986B / CJK 1,885 / 5 条 FAQ；任务 COMPLETED |
| 14:55:03 | 平台自动发 L1 请求到独立评审 Channel |
| 15:00:28 | L1 **pass**（`a11eebf7…`）：6,986B、sha256、FAQ/升级/回滚/交接关键字逐项命中 |
| 15:01 | 独立 approver L2 通过；owner 批准完成 → **同一项目再次 completed，plan v2** |

最终：2/2 交付物 approved、2/2 工作项 COMPLETED、2/2 成果 approved；项目从未新建第二个项目。

## 9.3 新发现/修复

- **真实缺陷（已如实处理）**：FAQ 的 `complete_task.deliverable` 只传了 430 字摘要，结果证据最初只有 906B。操作员把 Channel 已写出的 6,986B `oncall-runbook-faq.md` 补挂为 task artifact（内容未改），再提交结果；L1 按真实 6,986B 文件验收。说明：**平台需要增加“完成时自动纳入 workspace 交付文件”机制**，否则执行 Agent 可能把摘要当交付物。
- **计划质量缺陷（已修 prompt）**：v1 plan 的交付物/工作项没有结构化 `acceptanceCriteria`（只有 description/brief），owner 在批准后手工补了 `artifact.present/min_bytes/text.contains`。已在 `project-leader.md` 的计划 schema 和规则中强制要求 acceptanceCriteria 数组，并列出可用的确定性检查。
- **真实 UI 缺陷（已修）**：项目页点击“继续开发”后 `scrollIntoView` 会把对话卡滚到固定顶栏下方，标题被遮住；已加 `scroll-margin-top: 96px`，重新构建后验证标题/发送框可见。
- **Harness 冷启动**：本新项目 Leader 约 2.5 分钟出 plan v1、约 6.5 分钟出 plan v2；生产 Channel 首轮需 watchdog 中止后用 owner steer 收敛，FAQ 增量在 steer 后完成。长输出问题仍是 P0 runtime 风险。

## 9.4 UI 验收

Puppeteer（1440×1100 + 390×844）：

- 标题「值班手册 · 连续验收 kp12h」
- 状态 completed；`plan v2`；4 条办公室对话
- 「Project Leader 对话」标题可见；completed 重开提示存在
- 输入文字后发送按钮 enabled；点击“继续开发”后焦点=`project-continue-input`
- 桌面/移动端 `overflowX=false`；0 pageerror
- 截图：`runbook-continue-final-desktop.png` / `runbook-continue-final-mobile.png`

## 9.5 门禁

- ESLint（改动文件）✅
- `npm run typecheck` ✅
- `npm run i18n:check` 3255/3255 PARITY OK
- `npm run test:unit` **1144 / 1142 pass / 0 fail / 2 skipped**
- `npm run build` ✅

## 9.6 Ralph 判定

- US-101 新项目+双 Channel+真实 Leader：PASS
- US-102 plan v1→物化→激活→自动派发：PASS
- US-103 生产 Channel 交付真实 Markdown：PASS
- US-104 L1 独立评审 + L2 独立 approver + 完成：PASS
- US-105 同项目 continue→plan v2→新增交付→再次完成：PASS
- US-106 项目页连续对话 UI 桌面/移动端：PASS
- US-107 回归+证据：PASS
- **总判定：PASS_WITH_RUNTIME_NOTES**。新增功能与同一项目连续对话真实成立；执行侧仍有 harness 冷启动/长回合与“完成时未自动纳入 workspace 文件”的风险，已列入后续修复。

## 9.7 独立 reviewer 复核与 P2 收口

独立 general-purpose reviewer 对照 US-101–107 进行了代码/DB/UI 复核，首轮 **APPROVED**，同时提出 3 个 P2：

1. `continueProject` 只捕获 throw；`sendChatMessage` 的 mailbox 失败是以 `deliveries[].status='failed'` 返回，不抛错 → 可能出现“项目 active、审计已写、Leader 未收到”。
2. `project-leader.md` 的修复模板硬编码“新 HTML 文件”，对非 UI 项目过拟合。
3. 项目页对非 owner 仍显示可输入 composer；Ctrl/⌘+Enter 可绕过 disabled。

已修复并补测：

- `continueProject` 检查 Leader delivery，非 `delivered/consumed` → 回滚状态并 `MESSAGE_DELIVERY_FAILED`，不写 followup/reopened；新增单测“投递失败回滚”。
- Leader prompt 改为“交付文件/补丁（按项目技术栈，不限定 HTML）”。
- UI 由 observability `access.canManage` 门控，`sendContinuation` 与按钮都检查；非 owner 无有效提交入口。
- 增加重复批准不二次物化断言；新增投递失败测试后 unit 为 **1144/1142 pass/0 fail/2 skipped**。
- 移除 `project.reopened` 的 no-op FAST_TYPES 项（未知类型本就走 fast path）。
- 证据包补齐 `projectMessages`、reviewer agent/channel、`runbook-ui-acceptance.json`、项目创建请求摘要。

复核后回归：ESLint ✅、typecheck ✅、i18n 3255/3255 ✅、unit 1144/1142 ✅、build ✅。

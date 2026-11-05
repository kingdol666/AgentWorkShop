# AgentWorkShop 对话工作台 UI 重构 + 实机演示报告（2026-11-06）

> 范围：`feat/chat-ui-redesign`（基于 main `5e1d8eb6`）
> 目标：把 Agent 工作台的群聊视图升级为 ChatGPT / DeepSeek Harness 风格的 AI 对话界面；不改变后端 API 契约与治理链路。
> 门禁：typecheck ✅ · ESLint ✅ · i18n parity 3201/3201 ✅ · `npm run test:unit` **1140/1138/0/2** · build ✅

## 0. 结论

| 维度 | 判定 |
|---|---|
| 对话 UI 观感与交互 | **PASS**：暖纸阅读画布、AI 身份头部、用户右侧气泡、全宽 Agent 阅读块、建议卡、思考中脉搏、圆形发送钮、移动端适配 |
| 前后端契约 | **PASS**：仅消费既有 chat/WS/observability API；无 endpoint/schema 变更 |
| 代码质量/架构 | **PASS_WITH_NOTES**：数据/状态/渲染分层保持；新增 chat tokens 与 composer draft bus；`ChatTimeline` 仍偏大，建议后续拆 `ChatMessageRow`/`ChatEmptyState` |
| Project 实机演示 | **PASS**：Leader 计划+route 提案、生产 Channel 交付 7128B、平台自动 L1、独立评审 Channel pass、L2 后项目 completed |
| 遗留风险 | 预存量 hydration 警告仍在（timeline/chat 均有）；评审 Channel 冷启动/卸载后首轮可达 10 分钟；Project 页仍是暗色工业风，与 chat 暖纸风并存 |

## 1. 设计方向

**Warm Paper × Operator Console**：保留 AgentWorkShop 的工业控制台外壳（左侧导航、顶栏、审批/审计），把中部对话区做成一张“可阅读的暖纸工作台”：

- 暖纸画布 `#f7f6f3` + 纯白输入卡 + 石墨油墨 `#1a1a18`；
- 深青信号色 `#0f766e`（暗阶用 `#3fe4ab`）只用于 AI 状态、选中态、发送钮；
- Geist 正文 + EB Garamond 空态标题（保留一处衬线品牌时刻）；
- Agent 消息不做“聊天气泡”，而是全宽阅读块；用户消息是右侧暖灰气泡 —— 接近 ChatGPT 的信息层级；
- 所有 chat 视觉令牌集中在 `--chat-*`，不污染其他工业页面；暗色模式成对定义。

## 2. 改动清单

| 文件 | 改动 |
|---|---|
| `app/assets/css/main.css` | 新增 24 个 `--chat-*` 令牌（亮/暗两阶），仅 chat 声部消费 |
| `app/components/workshop/ChatTimeline.vue` | 重写模板/样式：AI 头部、空态建议卡、用户/Agent 两种消息形态、悬浮回复/复制、投递状态、思考中脉搏、回底 FAB；新增 `hydrated` SSR 边界与 `visibleMessages` |
| `app/components/workshop/Composer.vue` | 浮动 prompt 卡（24px 圆角/聚焦光环）、15px 正文、快捷键提示、AI 边界声明；消费 `draftText` |
| `app/components/workshop/composer/ComposerToolbar.vue` | 模式段控 pill 化；圆形青绿发送钮；移动端 44px 圆钮右对齐 |
| `app/components/workshop/ChannelSessionList.vue` | Channels 侧栏：mono eyebrow、卡片式 active、AI 状态点、暖纸背景 |
| `app/components/workshop/console/Topbar.vue` | chat 表面、channel chip、segmented 选中态、移动端可横扫切换条 |
| `app/components/workshop/console/LeftPane.vue` / `RightPane.vue` / `CenterPane.vue` | chat 画布贯通；chat 视图隐藏“产线作业”面板，右栏专注成员/上下文 |
| `app/pages/workshop/composables/useWorkspaceShell.ts` | 默认视图改为 `chat`；右栏默认收起（一键展开）；`wsView.chat` i18n |
| `app/composables/workshop/useComposerBus.ts` | 新增 `draft` 指令：空态建议卡 → Composer（不自动发送） |
| `i18n/locales/zh-CN.ts` / `en.ts` | 新增 25 个 chat 文案；保持 3201/3201 parity |

## 3. 视觉效果

- `chat-empty-final-v3-desktop.png`：空态 —— “把目标交给你的 AI 团队” + 三张可点击建议卡 + 底部输入卡。
- `chat-empty-final-v3-mobile.png`：390px 空态与圆形发送钮。
- `chat-final-v3-desktop.png`：有消息时的对话（用户气泡 / Agent 全宽阅读块 / 回复锚点 / 投递状态）。
- `chat-final-v3-mobile.png`：移动端对话与输入区。
- `project-chat-desktop.png`：**真实 Project Leader** 在项目办公室频道中的两条 LLM 消息（计划提案、route 提案复核），用新 chat 样式渲染。
- `project-final-*`：Project 页 completed 状态、执行工作台、审批/交付物/事件 tab、执行链 drawer（L1 pass · channel_lead、7128B artifact）。

## 4. 交互验证

- Puppeteer 实测：空态 3 张建议卡；点击第一张后 Composer 获得完整 prompt 且自动聚焦：
  `cards=3`，`draft.value=请把这个目标拆成可交付的计划…`，`activeElement=composer-input`。
- 发送路径未改：群聊仍走 `POST /channels/:id/chat/messages`，`@` 语义、delivery 台账、replyToId、clientMessageId 幂等全部保留。
- 默认进入 `?view=chat`；`时间线` 仍可通过切换条/数字键 1 进入，Agent 内部事件流不受影响。
- 右栏默认收起，顶栏右侧面板按钮可展开；chat 视图下右栏不再显示“产线作业”，只保留成员/任务/记忆/统计 + 群聊设置。

## 5. 前后端契约与测试

- **无后端改动**：本分支只改 `app/`、`i18n/`、`assets/css`；未新增/修改 API route、schema、service。
- 使用面：`GET /channels/:id/chat/messages`、`POST /channels/:id/chat/messages`、`GET /channels/:id/chat/permissions`、`GET /channels/:id/chat/members`、WS `chat.message` / `chat.delivery.status`、Project observability API。
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm run i18n:check`：zh/en 3201 keys，used 2799，unresolved 0，PARITY OK
- `npm run test:unit`：1140 tests / 1138 pass / 0 fail / 2 skipped
- `npm run build` ✅

## 6. 代码质量 / 架构评估

### 做得好的

1. **分层清晰**：页面只做编排（`w/[wsId].vue`），状态在 composable/store，视图在 `console/*`、`chat/composer/*` 子组件；本分支沿用该结构。
2. **API 单一入口**：chat send/permissions/history 都收敛在 `useChatStore`/`useWorkshopApi`，UI 重构没有绕过服务端校验。
3. **治理链路未动**：Project leader/route/三级验收、审批分权、审计事件、observability 全部保持；UI 只是渲染既有事实。
4. **i18n 与设计令牌**：新增文案同批进入 zh/en；chat 视觉全部走 `--chat-*`，不污染工业仪表台其他页面。
5. **可测试性**：typecheck/lint/unit/i18n/build 全绿；UI 交互有 Puppeteer 实测，不是只看截图。

### 需要改进的

1. **`ChatTimeline.vue` 仍偏大**（约 1000 行）：建议后续拆 `ChatEmptyState.vue`（建议卡）与 `ChatMessageRow.vue`（单条消息），把 scroll/reply/copy 留在编排层。
2. **`server/services/workshop/projects/service.ts` 仍是 3000+ 行的大服务**：建议按 plan/handoff/acceptance/observability 拆 service 模块；本轮未动以控制风险。
3. **Workspace 页存在预存量 hydration mismatch**：timeline 与 chat 都有，来源是 SSR 壳层与客户端 WS store 的差异；本分支已对 chat header 加 `hydrated` 边界，但全局壳层仍会报一条 warning。建议后续把 workspace 首帧改为 `ClientOnly` 壳或统一 snapshot 水合。
4. **评审 Channel 冷启动/空闲卸载**：本轮 Project 演示中评审 Channel 在空闲时被卸载，L1 请求后首轮耗时约 10 分钟；建议对“项目成员 Channel / 有待评审请求的 Channel”加 unload guard 或预热心跳。
5. **视觉回归没有自动化**：目前是截图 + Puppeteer 交互；建议加 `chat-ui-smoke`（空态/消息/移动端/建议卡点击）到 CI 或 nightly。

## 7. Project 实机演示（本轮 UI 版本）

项目 `305b8945-bdda-46b2-8180-bd48d84baa48`：`completed`，`auto_dispatch=0`，`mode=supervised`，`routing_policy=technical`。

| 时间 | 事件 |
|---|---|
| 21:05:42 | 项目创建（omp leader）+ 生产/评审 Channel 预热 |
| 21:06:52 | Leader 真实 `project_propose_plan` → owner 批准 → 物化 1 工作项 |
| 21:07:32 | Leader 真实 `project_propose_route`（dispatch，targetChannelId=生产频道）→ owner 应用 → 执行器派发 |
| 21:11:03 | 生产 Channel 交付 7128B HTML，result submitted |
| 21:11:08 | 平台自动 `request_review` 投递评审 Channel |
| 21:21:04 | 评审 Channel 写 L1 technical review `0db6f6ba…`，channel_lead，pass |
| 21:21:04 | L2 `cf7c3538…` 在 L1 之后通过；项目 completed |

UI 验证：Project 页 `100% 工作项完成 / 100% 交付物签核`；drawer 显示 `L1 pass · channel_lead`、artifact 7128B、`work.dispatch_auto`/`proposal.applied`/`work.completed` 事件链；0 pageerror。

**真实 Leader 对话**：把项目办公室频道挂载到 workspace 后，新 chat 界面渲染了 Leader 的两条真实消息（“计划提案已真实提交…”与“route 提案已真实创建…”），包含工具调用结果、work item 状态与下一步 L1/L2 说明 —— 这是本轮“AI 对话界面 + Project 实机”的联合证据。

## 8. 复现

```bash
cd D:/codes/ABO/aw-router-v3
npm run build
AW_HOME=D:/codes/ABO/aw-acceptance-home-20261106 AW_MODE=home \
NUXT_SESSION_PASSWORD='<设置强随机值，勿提交>' \
AW_ROOT_RESCUE_STALE_MS=600000 \
AW_PROMPTS_DIR=D:/codes/ABO/aw-router-v3/.output/.AgentWorkShop/prompts \
node bin/aw.mjs start --port 3981
```

- 对话截图 workspace：`9c52406a-20d3-4618-a692-256d110e78a2`（有消息）/ `0799164c-c37f-4bf5-8b7d-e2682f3beb50`（空态）/ `2ef98b88-6584-46b6-aa7a-4ad909d27cc6`（项目办公室）。
- Project 演示：`305b8945-bdda-46b2-8180-bd48d84baa48`；结果 `project-demo-result.json`。

## 9. 最终判定

- **UI 重构：PASS**。视觉方向明确、桌面/移动端可用、建议卡/回复/复制/回底/思考中/投递状态均可交互；无 API 契约变更。
- **代码质量：PASS_WITH_NOTES**。分层与治理链路保持，测试全绿；`ChatTimeline` 与 Project service 的体量是后续重构点。
- **实机使用效果：PASS**。真实 omp Leader/Channel 完成了计划、route、交付、L1、L2、项目完成；新 chat 界面能渲染真实 Leader 消息与项目状态。
- **遗留**：预存量 hydration warning、评审 Channel 冷启动、Project 页与 chat 的视觉语言并存（有意保留工业外壳）。

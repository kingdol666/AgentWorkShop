# 验证记录（2026-11-08）

环境：本机隔离实例 `:4001`（`AW_MODE=home` + `AW_HOME=.deep-home-20261108` + `BACKUP_DISABLED=1`），
生产构建 `node .output/server/index.mjs`，真实 Chrome（puppeteer-core）截图。

## 1. 静态与单测

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck`（vue-tsc -b） | ✔ 通过 |
| `npm run test:unit` | 1255 tests / **1253 pass / 0 fail / 2 skip** |
| `npm run check:cssvars` | ✔ 159 个变量引用全部有定义（257 文件） |
| `npm run i18n:check` | ✔ zh 3291 = en 3291；used 2873；unresolved **0**；PARITY OK |
| `npm run build` | ✔ nitro 产物生成（`.output`） |

> 说明：全量套件与构建并行跑时曾出现 `tests/http-drivers.test.ts` 超时 1 次
> （网络驱动用例，单独重跑 10/10 通过；串行复跑全量 0 fail）。属并行资源竞争，非产品回归。

## 2. 实机截图（真实数据）

| # | 页面 | Before | After |
| --- | --- | --- | --- |
| 1 | Channel 控制台 | `before/04-console-chat.png` | `after/01-channel.png` |
| 2 | Project 详情 | `before/03-project-detail.png` | `after/02-project.png` |
| 3 | 项目列表 | `before/02-projects-list.png` | `after/03-projects-list.png` |
| 4 | Workspace 列表 | `before/01-workshop-list.png` | `after/04-workshop-list.png` |
| 5 | Channel · 390px 手机 | —（与 4 同源布局） | `after/05-channel-mobile.png` |

截图驱动：`scripts/_audit/_design-capture.mjs`（登录 → `data-vp-tier` 就绪 → 等待 WS 首帧 → 截图）。

## 3. 交互不变量（人工核对 + DOM）

- 视图切换（时间线/对话/泳道/任务板/同屏/孪生/多会话）仍在：桌面在图标轨，窄屏在顶栏切换条；
  390px 截图可见切换条完整、Composer 常驻。
- 消息能力未变：回复 chip、复制、投递台账（pending/delivered/consumed/failed/cancelled）、
  @Agent 提及 pill、回答来源行。
- 写动作红线未变：Composer 仍显示「AI 产出需人工验收 · 关键操作走审批」；
  HITL 卡、审批按钮逻辑零改动（本轮只改样式与版式）。
- Project 页全部 `data-testid` 原位保留（`tab-*`、`project-leader-chat`、`project-chat-*`、
  `bind-channel-id`、`protected-badge` 等）。
- 未登录守卫、强制改密门、401 自愈链路未改（无 server 文件变更）。

## 4. 变更面

- 11 个前端文件（5 个会话组件 / 2 个项目页 / 2 个入口页 / 2 个 i18n 文件）+ 文档与截图。
- **零** server / API / 数据层改动；零依赖新增；零构建配置改动。

## 5. 已知限制

- 截图里的频道名乱码来自历史测试数据的编码问题（数据库内容），不是本轮 UI 变更；
  新建频道名称正常。
- mock Agent 的回复文本含原始 UUID（mock 固定文案），属测试数据形态。
- 未做视觉回归基线（像素 diff）：项目暂无该设施，本轮用同尺寸前后截图人工比对。

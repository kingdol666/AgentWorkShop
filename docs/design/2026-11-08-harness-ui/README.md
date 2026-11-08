# Harness UI 重构（2026-11-08）

> 目标：把 AgentWorkShop 的前端从「能用」推进到「可展示、可长期使用」——
> Channel 控制台与 Project 详情按 ChatGPT 式 harness 会话布局重排，
> 其余入口页按各自功能优化展示，并给出 **原型 → 实施 → 前后对比** 的完整凭据。

## 1. 设计原型（三方向，可挑选）

设计画布：`docs/design/2026-11-08-harness-ui/canvas/`
打开方式（本机）：

```bash
node "$HOME/.zcode/skills/claude-design/scripts/artifact.mjs" open \
  "docs/design/2026-11-08-harness-ui/canvas"
```

| 方向 | 气质 | 适用判断 |
| --- | --- | --- |
| **A · Quiet Harness**（已实施） | 白画布 + 单暖橙 + 发丝线；最贴 ChatGPT 桌面端 | 用户明确的「按 ChatGPT 布置」；长期阅读不累 |
| **B · Ops Cockpit** | 深色图标轨 + 钴蓝指令色 + 常驻运行栏 + 等宽读数 | 值班/盯盘场景：对话与运行态同屏 |
| **C · Paper Session** | 暖纸底 + 衬线排版 + 横线分隔 + 页边注 | 报告/评审场景：更像工程笔记 |

六个画板截图见 [`canvas-shots/`](canvas-shots/)：
`A-Channel` / `A-Project` / `B-Channel` / `B-Project` / `C-Channel` / `C-Project`。

> 画布是原型，不参与生产构建；`canvas/project/*.dc.html` 是设计源文件。
> 若最终选择 B/C，改动集中在 5 个会话组件与 `--chat-*` 令牌，不需要重写业务逻辑。

## 2. 实施范围（方向 A）

### PR-1 · Channel 控制台（`feat/harness-ui-channel`）

- **对话流**：Agent 通栏阅读块（无气泡）、用户右侧浅泡、去掉用户头像列；
  阅读列宽 800px、行距 1.74、消息间距 18px；Agent 署名旁新增 **harness 标识**
  （omp/dsh/mock…，与 AgentBlock 同源），角色章降为中性灰。
- **Composer**：26px 圆角输入卡、内边距收紧（高度 145 → 118px）、
  黑白发送钮（不再用橙色大面积强调）、模式段控选中态改中性填充；
  状态行从「色块 chip」改为一行 10.5px 弱读数。
- **侧栏**：频道计数进入分组标签；行副标题只显示有信息量的计数（忙/任务为 0 时省略）；
  设置/卸载操作降为 hover 显影；模板挂载区压缩。
- **文案**：placeholder 改为「继续追问，或 @ 成员指派任务…」（中英同步）。
- **不动**：全部 data-testid、快捷键、投递台账、@ 提及解析、HITL 语义、API。

### PR-2 · Project 详情（`feat/harness-ui-project`）

- 中列顶部改 **面包屑**（项目名 / 当前分区），去掉与侧栏重复的大标题；
  中列阅读宽上限 880px，右栏 312px。
- Leader 对话：用户消息去头像、改右侧浅泡；Agent 改通栏阅读块；
  输入框 3 行 → 2 行。
- 「频道」绑定列表：**UUID 墙改为频道名 + 短 id**；任务实例行显示 charter 可读标签。
- 不动：项目状态机、全部 `data-testid`、观测轮询与审批逻辑。

### PR-3 · 入口页（`feat/harness-ui-entry-pages`）

- `/projects`：容器 920 → 1080px；新建表单三列（名称/目标/引擎）+ 描述通栏，
  卡片网格 340px 起、hover 抬升；completed 徽标改绿。
- `/workshop`：容器限宽 1240px 居中；卡片网格 336px；新建占位砖留白加大。
- 不动：数据加载、创建/删除、登录门与强制改密流程。

## 3. 前后对比

| 页面 | Before | After |
| --- | --- | --- |
| Channel 控制台 | [`before/04-console-chat.png`](before/04-console-chat.png) | [`after/01-channel.png`](after/01-channel.png) |
| Project 详情 | [`before/03-project-detail.png`](before/03-project-detail.png) | [`after/02-project.png`](after/02-project.png) |
| 项目列表 | [`before/02-projects-list.png`](before/02-projects-list.png) | [`after/03-projects-list.png`](after/03-projects-list.png) |
| Workspace 列表 | [`before/01-workshop-list.png`](before/01-workshop-list.png) | [`after/04-workshop-list.png`](after/04-workshop-list.png) |

对比要点：

1. **Channel 输入区**：从「三层信息 + 大色块」压到「单行弱读数 + 26px 输入卡」，
   视觉重心回到对话本身；发送钮改黑白，橙色只保留给 live/待批。
2. **Agent 消息**：从「头像 + 橙色角色章」改为「头像 + 名字 + harness + 中性角色」，
   不同 harness 一眼可辨；用户消息去头像后，人与 Agent 的阅读节奏分开。
3. **Project 页**：UUID 绑定列表变成频道名清单，中列不再被长标题和裸 id 打断。
4. **入口页**：表单从「占满首屏」变成一行三列，项目卡片成为首屏主体。

## 4. 验证

见 [`VERIFICATION.md`](VERIFICATION.md)：typecheck、unit、CSS 变量、i18n 对偶、
实机截图脚本、响应式与交互不变量清单。

## 5. 如何裁决

- **保留全部**：按 PR-1 → PR-2 → PR-3 顺序合并。
- **只保留部分**：三个 PR 互不依赖（PR-2/3 只用到 PR-1 已存在的 `--chat-*` 令牌），
  可单独合并任意一个。
- **全部不要**：关闭 PR 即可，`main` 未改动。
- **换方向**：画布 B/C 的结构已落在原型里；实施侧只需替换令牌与 5 个会话组件的
  样式段（见 `docs/plans/2026-11-08-harness-ui-redesign-plan.md`）。

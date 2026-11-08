# Harness 控制台与 Project 详情

> 2026-11 起，Channel 控制台、Project 详情与入口页按 **ChatGPT 式 harness** 布局重排。
> 目标不是“换皮”，而是把阅读、身份与操作三件事分开：**内容占主列，身份在元信息，操作退到 hover/边缘**。

## 三条设计原则

1. **阅读优先**：对话主列宽 `min(800px, 100% - 64px)`，行距 1.74，消息间距 18px；Agent 回复是通栏阅读块，不是气泡。
2. **身份可见**：每条 Agent 消息在名字旁显示 **harness 标识**（omp / dsh / codex / mock …），与 AgentBlock 同源；角色章降为中性灰，不再用大色块抢注意力。
3. **操作收敛**：输入区从“三层信息 + 大色块”压到“单行弱读数 + 26px 输入卡”；发送钮改黑白，橙色只保留给 live / 待批等真正需要打断的信号。

## Channel 控制台

页面分三区：

| 区域 | 内容 | 设计要点 |
|---|---|---|
| 图标轨 | 总览、对话、任务板、多会话、时间线等视图 | 56px 窄轨，当前视图用左侧 2px 暖橙标记 |
| 频道侧栏 | 频道会话列表、成员计数、模板挂载 | 计数进入分组标签；忙/任务为 0 时省略副标题；设置与卸载 hover 显影 |
| 对话主列 | 消息流 + Composer | 800px 阅读列，Agent 通栏块，用户右侧浅泡 |

**消息元信息**：

- Agent：头像 + 名字 + **harness chip** + 角色 + 时间；用户：右侧浅泡 + 时间，不再占头像列。
- 空态标题使用 `clamp(26px, 4vw, 34px)`，不抢首屏。
- 状态行是 10.5px 弱读数（如“群聊 · 仅群聊 · 0 次 Agent 执行”），不是彩色 chip。

**Composer**：

- 26px 圆角、内边距 `10px 12px 7px 16px`、最小高度 40px；
- 模式段控（群聊 / 任务 / 消息）选中态为中性填充；
- 发送钮 34px，黑白配色，不再使用橙色大面积强调；
- `Enter` 发送、`Shift + Enter` 换行，行为与旧版一致。

**视图切换**：对话 / 任务板 / 多会话 / 时间线全部保留；切换不丢失当前频道与草稿。

![Channel 控制台 —— 800px 阅读列、Agent 通栏块、用户右侧浅泡、harness 标识](/harness-ui/01-channel.png)

## Project 详情

Project 页同样按“阅读优先”重排，但保留交付语义：

- **左导航**：概览 / 计划与工作 / 交付物 / 审批 / 决策与事件；
- **中列**：顶部面包屑（项目名 / 当前分区），阅读宽上限 880px；不再重复侧栏的大标题；
- **右栏**：312px 项目快照（就绪 / 执行中 / 等待 / 阻塞、工作项完成率、交付物签核率）；
- **Leader 对话**：用户消息去头像、右侧浅泡；Agent 通栏块；输入框 3 行 → 2 行；
- **频道绑定**：UUID 墙改为「频道名 + 短 id」；任务实例行显示 charter 可读标签；
- **生命周期**：继续开发 / 对账 / 归档固定在左栏底部。

![Project 详情 —— 面包屑、Leader 对话、频道名绑定、项目快照](/harness-ui/02-project.png)

## 入口页

| 页面 | 调整 |
|---|---|
| `/projects` | 容器 920 → 1080px；新建表单三列（名称 / 目标 / 引擎）+ 描述通栏；卡片网格 `minmax(318px, 1fr)`，hover 抬升；completed 徽标改绿 |
| `/workshop` | 容器限宽 1240px 居中；卡片网格 336px；新建占位砖留白加大 |

## 不变量（改版没有动的东西）

- 全部 `data-testid` 保留（`project-tabs`、`project-leader-chat`、`tab-*` 等）；
- 快捷键、@ 提及解析、投递台账、HITL 语义、REST API 不变；
- 项目状态机、观测轮询与审批逻辑不变；
- 390px 手机宽度下侧栏折叠、Composer 不溢出。

## 验收

- UI 交互套件 **12/12**（真实 Chrome：频道加载、四个视图切换、发言后刷新仍存在、Project 五个 tab、testid 齐备、无 pageerror）；
- typecheck ✔、lint 0 error、unit **1253 pass / 0 fail / 2 skip**；
- 改版前后对比与设计画布见 [`docs/design/2026-11-08-harness-ui/`](https://github.com/kingdol666/AgentWorkShop/tree/main/docs/design/2026-11-08-harness-ui)。

> 相关阅读：[Channel 多会话与 Agent 生命周期](/guide/channels-sessions) · [Project 模式](/guide/projects) · [多 Harness Agent 团队](/guide/multi-harness)

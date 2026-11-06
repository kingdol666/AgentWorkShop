# 控制台 ChatGPT 化设计规格（design.md，2026-11-07）

> 源：用户提供的 ChatGPT 桌面端截图（2551×1339 @2x）+ anydesign 取色实证。
> 范围：workspace 多会话控制台（/workshop/w/:wsId）+ Project 两页（/projects、/projects/:id）。
> 不范围：工业仪表台其余页面（保持 Warm Paper / 暗色仪表声部）。

## 1. 身份（Identity）

ChatGPT 桌面端是「三区应用框」：窄图标轨 + 会话侧栏 + 白色主列（+可折叠右侧上下文卡）。
气质：**纸面白、发丝线、圆角 2xl、黑色正文、唯一暖橙强调**。没有仪表盘式网格、没有
彩色徽章墙；层级靠字重与 4 档灰阶表达，状态靠点与细胶囊。

## 2. 实测 tokens（截图取样）

| 层 | 取样 | 采用值（light） |
|---|---|---|
| 主画布 | `#FFFFFF`（69.7% 面积） | `--chat-canvas: #ffffff` |
| 侧栏/轨 | `#FDFAFA`~`#F8F0EF` | `--chat-surface-raised: #f9f7f4` |
| 正文 | `#1A1C1F` | `--chat-ink: #0d0d0d` |
| 次级/弱化 | — | `--chat-ink-soft: #5d5b55` / `--chat-ink-faint: #8f8c84` |
| 发丝线 | ≈`#ECECEA` | `--chat-line: #ececea` / strong `#dbd9d4` |
| 强调（发送钮/徽标） | `#EE7C37` / `#F19156` | `--chat-accent: #e06a35`（文字级再深：strong `#b9541f`） |
| 强调软底 | 用户气泡 `#FBE8DB` | `--chat-accent-soft: #fbeee4` |
| 用户气泡 | — | `--chat-user-bubble: #f3f1ec`（含 @ 提及时浮出蜜桃软底） |

Dark（ChatGPT dark 同构）：canvas `#212121` · sider `#171717` · surface `#2f2f2f` ·
ink `#ececec`/`#b4b4b4`/`#8f8f8f` · line `#2f2f2f`/`#3d3d3d` · accent `#f19156`。

## 3. 布局（Layout）

```
┌──┬────────────┬──────────────────────────────┬───────────────┐
│轨 │ 侧栏 260px │        主列（白，居中 ≤820）  │ 右上下文 300  │
│56│ 新建频道    │  顶栏：频道名 · 状态 · 操作    │ 卡片式分区     │
│  │ 搜索⌘K     │  ───────────────────────────  │ 成员/任务/记忆 │
│  │ 频道 ─────  │  对话流（Agent 通栏/用户右泡） │               │
│  │ 会话 ─────  │  悬浮 Composer（圆角 24）      │               │
│  │ 底：身份卡  │                               │               │
└──┴────────────┴──────────────────────────────┴───────────────┘
```

- **图标轨（56px）**：logo→/workshop、侧栏开合、⌘K、七个视图位（对话/时间线/泳道/任务板/同屏/小镇/多会话，
  tooltip+active 态）、A2A、底部头像→/workshop。桌面常驻；窄屏不渲染（顶栏承载切换）。
- **侧栏**：workspace 名（可点回总览）+「新建频道」主按钮 + 「搜索」幽灵钮（⌘K）+
  「频道」分组（行=圆角 hover/active 填充，无边框卡）+「会话」分组（聚焦频道的会话清单，
  ChatGPT 历史语义）+ 底部工作区路径/身份。
- **主列**：白，居中 ≤820px；顶栏只留频道名+连接态+图标钮（视图切换桌面期移入轨）。
  ChatTimeline 去内嵌大头部（orb+标题），消息区直接开始；空态保留建议卡。
- **右上下文**：默认收起；展开时白底卡式分区（检查器/成员名册既有能力，换皮不换骨）。

## 4. 组件规则（Components）

| 件 | 规则 |
|---|---|
| 行（列表项） | radius 10 · hover 填充 `#f4f2ee`(dark `#2f2f2f`) · active 填充加深 · 无边框 |
| 主按钮 | 黑底白字（dark 白底黑字）radius 10 · 次级=白底发丝线幽灵 |
| 强调 | 橙仅用于：发送钮、live/working 点、「任务会话」徽标、focus ring |
| 输入 | radius 10 发丝线 · focus 发丝线加深（不用橙描边） |
| Composer | 白卡 radius 24 · 内含工具行（模式/目标/loop）· 底部快捷键提示移入卡外浅行 |
| 徽标 | tinted pill（tone 系统沿用），饱和度降一档 |
| 对话 | Agent=通栏阅读块（无泡）；用户=右侧 `--chat-user-bubble` 泡 radius 18 |

## 5. 交互契约（必须保持）

- 视图切换：数字键 1-7、⌘K、?view= 深链、窄屏顶栏切换条 —— 全部不动语义。
- Project 页全部 `data-testid`（tab-*/exec-*/input-work-*/select-work-*/bind-channel-id/
  btn-report-*/toggle-auto-dispatch/open-office/protected-badge/channel-lane-*/open-task-session-*…）
  原位保留；tab 语义=侧栏导航项。
- 会话管理视图（多会话）内部结构不动，仅表面换皮。
- 认证：workspace 守卫（未登录→/workshop）语义复制到 project 两页；两页改用裸 `console` 布局
  （脱离全局头部/侧栏，轨内 logo 为逃生口）。

## 6. 落地映射（文件）

| 层 | 文件 |
|---|---|
| tokens | `app/assets/css/main.css`（--chat-* 浅/深两档重定值） |
| 裸布局 | `app/layouts/console.vue`（新） |
| 图标轨 | `app/components/workshop/console/Rail.vue`（新） |
| 侧栏 | `ChannelSessionList.vue`（重建声部）+ `LeftPane.vue` + 新增会话分组（`SessionMiniList`） |
| 顶栏 | `console/Topbar.vue`（瘦身为频道标题条） |
| 对话 | `ChatTimeline.vue`（去头部、列宽 820、气泡/建议卡微调） |
| 右栏 | `RightPane.vue`/`InspectorPanel.vue`（卡式分区） |
| Project | `app/pages/projects/[id].vue`（三区重建）+ `index.vue`（换皮） |

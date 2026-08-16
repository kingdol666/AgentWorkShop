# AgentWorkShop Agent Harness 前端总体规划

> 日期:2026-08-16
> 定位:把 Workshop 全部后端能力(46 REST 端点 + WS hub + A2A/MCP)集成为一个**专业的多 Agent Harness 控制台**——以 Workspace 为会话隔离层、Channel 为编排单元、Agent Event Protocol(AEP)为标准事件协议,实现端到端的实时渲染消费 + API 控制。
> 风格基准:**Zcode 式开发者控制台**(深色主题、左侧会话栏、中部流式 Transcript、可折叠工具调用块、底部 Composer、状态条),叠加业界 Agent Harness 范式(AG-UI 事件流、AgentGUI 并发观察与 steering、相邻面板/统一时间线混合)。

---

## 0. 现状盘点(探索结论)

### 已有(可直接复用)
- **应用壳**:Nuxt 4 + Ant Design Vue 4 + UnoCSS + Pinia(持久化)+ i18n(zh/en)+ 深色模式(`app.vue` darkAlgorithm + `.dark` class + CSS vars)。
- **HTTP 层**:`app/plugins/http.ts` axios 实例,自动注入 `Authorization: Bearer <cookie:token>`,响应拦截解包 `{code,message,data}`、401/5xx 统一提示。
- **WS 先例**:`app/game/client.ts` GameClient(自动重连 + 协议解析)可作 Workshop WS 客户端的参考模板;服务端 `server/api/workshop/ws.ts` hub 已存在。
- **后端 API 面(全部就绪)**:channels CRUD+activate、agents 模板 CRUD+subscribe、channel agents 实例管理、teams CRUD+deploy+members、tasks(提交/列表/详情/dispatch/report/complete/cancel,goal/loop/pipeline 三模式)、memories(agent 私有+team 公共+search+maintenance)、a2a(send+card+JSON-RPC/SSE)、mailbox、messages(历史+注入)、queue、runtime。

### 缺失(本规划要建的)
- Workshop 任何管理/监控 UI(设计文档 §709 明确此前不做前端)。
- Workshop WS 客户端与事件渲染器(聊天流、工具块、artifact 卡片)。
- 标准事件协议(当前 WS 是 500ms 快照 diff,无 seq、无 agent 粒度、无断线续传)。
- Token 获取/管理入口(cookie `token` 无人写入);Workspace 会话隔离概念。

---

## 1. 设计原则

1. **Workspace = 会话隔离层(纯前端)**:Workspace 是用户定义的工作区容器,持有若干 Channel 引用;不同 Workspace 互不干扰(各自的 WS 连接、事件缓冲、UI 状态)。**不新增后端表**——`workspace → channelIds[]` 映射存 localStorage(Pinia 持久化),降低侵入。
2. **AEP 单一事实源**:所有前端渲染消费统一走 AEP 事件流(WS 推送 + REST 快照对齐),组件不直接轮询 REST。
3. **REST 管命令,WS 管状态**:写操作(创建/提交/取消/写记忆)走 REST;状态与过程(agent 状态、任务进度、消息、artifact)走 WS 事件。
4. **渲染可降级**:WS 断连时 Transcript 冻结并显示重连进度条,恢复后按 seq 补发;REST 快照可整体对齐(幂等重建)。
5. **开发者级视觉(Zcode 风格)**:深色优先、等宽字体事件时间线、紧凑信息密度、可折叠执行块、键盘可达(`⌘K` 命令面板、`⌘B` 侧栏)。
6. **多 Agent 分别渲染**:统一时间线为默认视图;任一 Agent 可"聚焦"成独立 lane(单人 transcript);并发输出按 agentId 聚合不串流。

---

## 2. Agent Event Protocol(AEP)——项目标准事件协议

### 2.1 统一信封

```jsonc
// 下行帧(服务端 → 前端),单 JSON 对象
{
  "v": 1,                       // 协议版本
  "type": "agent.delta",        // 事件类型(见目录)
  "seq": 1042,                  // channel 内单调递增;断线续传游标
  "at": "2026-08-16T09:00:00.000Z",
  "channelId": "ch-uuid",
  "agentId": "agent-uuid",      // 可选:产出者(lead/worker/system)
  "taskId": "task-uuid",        // 可选:关联任务
  "payload": { }                // 类型相关
}
```

### 2.2 事件目录(v1)

| type | payload | 源 | 渲染 |
|---|---|---|---|
| `channel.snapshot` | `{ channel, agents, tasks, queue, messages[50] }` | WS 连接建立时 | 整体重建 store(幂等) |
| `agent.status` | `{ state: idle\|busy\|stopped, currentTaskId?, queued?, completed? }` | ChannelBus.notifyAgent | 成员栏状态徽标 + 时间线状态行 |
| `agent.message` | `A2AMessage`(role/parts/metadata) | ChannelBus.emit(message) | 消息气泡(markdown;按 agentId 归属) |
| `agent.delta` | `{ delta: string }` | omp text_delta 流 | 流式打字机追加到该 agent 当前气泡 |
| `agent.status.message` | `{ text }` | omp message_end/status | 时间线轻量状态行(🔧 工具名等) |
| `task.status` | `{ state, assigneeId, by? }` | notifyTask | 任务卡状态迁移 + 时间线 |
| `task.progress` | `{ progress: 0-100 }` | notifyTask | 进度条 |
| `task.artifact` | `A2AArtifact` | ChannelBus.emit(artifact) | artifact 卡片(见 §5.4) |
| `a2a.message` | `A2AMessage` + 路由元数据 | message repo 增量 | peer 通信行(问/答/触发器标记) |
| `memory.saved` | `{ agentId, scope, title, dedupKey }` | 记忆写入点 | 记忆面板增量 + 时间线轻行 |
| `error` | `{ code, message, agentId? }` | 各处 | 红色错误卡 |
| `pong` | `{ t }` | 心跳 | 连接健康 |

> 既有 WS 8 种事件是其子集;`agent.delta`/`agent.status.message` 需要 omp harness 把 `AgentSessionEvent` 透出(§7.1)。

### 2.3 服务端 WS hub 改造(推送化)

当前实现是 **500ms 快照 diff**,必须改为**事件驱动直推**:
- `ws.ts` 重写:连接时 `manager.ensureChannelRuntime` + 订阅 `subscribeChannelEvents/onTaskEvent/onAgentStatus`(§已修复的订阅时序保证),ChannelBus 事件 → AEP 信封 → `peer.send`。
- **seq 与重放**:hub 内 per-channel 环形缓冲(容量 5000,含 seq);客户端重连带 `?lastSeq=` → 服务端回放缺失段再续推(超出缓冲则回 `channel.snapshot` 全量对齐)。
- **多 channel 复用**:同一连接可 `sub`(上行新增 `{type:'sub', channelId, lastSeq?}` / `unsub`)订阅多个 channel——Workspace 内多 Channel 并行观察只开一条 WS。
- **鉴权(可选开关)**:`?token=<agentToken>`;缺省维持公开只读(与现状一致),但写操作仍全走 REST Bearer。
- 心跳:复用 `ping/pong`,30s 空闲判定断线。

### 2.4 前端消费契约

- `eventStore` per-channel 维护 `{ lastSeq, ring(2000) }`;所有组件从 store 派生(selectors),不直接持有事件。
- 断线策略:指数退避重连(1s→2s→…→10s 封顶),重连成功带 `lastSeq` 续传;UI 顶部黄条"实时连接中断,重连中…(已缓冲 N 条待补)"。

---

## 3. 信息架构与路由

```
/workshop                        → Workspace 总览(会话列表 + 新建;Zcode session 栏入口)
/workshop/w/:wsId                → Workspace 主控台(Harness 核心页,§4)
/workshop/agents                 → Agent 模板库(CRUD + 实例去向 + token 查看)
/workshop/teams                  → AgentTeam 编组库(CRUD + 成员 + 一键 deploy 到 Channel)
/workshop/channels/:id/inspect   → Channel 独立检查页(不属 workspace 也能看:任务/成员/消息/记忆)
/workworkshop/settings           → Harness 设置(token 管理、WS 重连参数、主题、事件密度)
```

侧栏菜单(AppSidebar 追加分组「Workshop」):总览、模板库、编组库、设置。

### Workspace 模型(前端)

```ts
interface WorkspaceMeta {
  id: string
  name: string                  // 如「支付网关重构」「日报机器人」
  createdAt: number
  channelIds: string[]          // 挂载的 Channel(可拖入/移出)
  activeChannelId?: string      // 当前聚焦的 Channel(transcript 上下文)
}
// pinia-plugin-persistedstate → localStorage:key 'workshop.workspaces'
```

- Workspace 新建向导:① 建/选 Channel(内联创建含 lead 定义);② 从模板库/编组库拉成员(deploy team 或逐个 add);③ 进入主控台。
- Channel 卡片可跨 Workspace 挂载(同一 Channel 可出现在多个 Workspace,事件流按连接去重)。

---

## 4. Workspace 主控台布局(Zcode 风格)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 顶栏: Workspace 名 ▾ │ 主题/语言 │ ●WS 已连(seq 1042) │ ⌘K 命令面板     │
├────────────┬──────────────────────────────────────────┬──────────────────┤
│ 左栏 260px  │  中部 Transcript(聚焦 Channel 的时间线)  │ 右侧 Inspector   │
│            │ ┌──────────────────────────────────────┐ │ 320px(可折叠)   │
│ ▼ CHANNELS │ │ [lead] ⚙ dispatch 实现支付网关 → w1    │ │ ┌────────────┐ │
│  ● ch-支付  │ │ [w1] ▶ WORKING 支付网关对接            │ │ │ 成员 (3)    │ │
│   (3 agent │ │ [w1] 💬 <markdown 流式输出…>           │ │ │ lead ●idle │ │
│    2 task) │ │ [w1] 🔧 bash ▸(折叠:命令+结果)        │ │ │ w1  ●busy  │ │
│  ○ ch-报表  │ │ [w1] 📦 artifact: patch.diff ▸预览    │ │ │   └队列 2   │ │
│  ＋ 挂载…   │ │ [w1] ✅ COMPLETED 进度100              │ │ │ w2  ○idle  │ │
│            │ │ [lead] 📋 汇总:…                        │ │ ├────────────┤ │
│ ▼ 过滤      │ └──────────────────────────────────────┘ │ │ 任务 (12)   │ │
│  ◉ 全部事件 │  视图切换: [时间线] [Agent lanes] [任务板] │ │  父子树+状态 │ │
│  ○ 仅消息   │                                          │ ├────────────┤ │
│  ○ 仅工具   │                                          │ │ 记忆        │ │
│  ○ 仅错误   │                                          │ │ private/   │ │
│            │                                          │ │ shared +🔍 │ │
├────────────┴──────────────────────────────────────────┴──────────────────┤
│ Composer: [textarea 新任务/消息…] [发送任务▾][即时消息▾(priority/requireReply)] │
│           模式: goal|loop|pipeline ▾   目标/阶段参数…        ⏎ 发送  ⌘⏎ 新任务│
└──────────────────────────────────────────────────────────────────────────┘
```

- **左栏**:Workspace 内 Channel 会话列表(实时状态徽标来自 `agent.status` 聚合);挂载/移出;事件类型过滤器(时间线虚拟滚动下的高效过滤)。
- **中部 Transcript**(默认统一时间线):
  - 虚拟滚动(vue-virtual-scroller 或自研;5000+ 事件不卡)。
  - 事件卡片体系见 §5。
  - 三视图切换:**时间线**(全事件)、**Agent lanes**(每个 agent 一列并排流,2-4 agent 相邻面板范式)、**任务板**(父子任务树 + 看板列 SUBMITTED/WORKING/WAITING/COMPLETED/FAILED/CANCELED)。
- **右栏 Inspector** 三个 Tab:成员(状态/队列/点击→Agent 抽屉)、任务(树+状态+点击→Task 抽屉)、记忆(分域列表+搜索+写入)。
- **Composer**(底部):
  - 「发送任务」→ `POST /channels/:id/tasks`(mode+modeConfig 表单展开);
  - 「即时消息」→ `POST /channels/:id/messages`(priority=immediate/task、requireReply、目标 agent 选择);
  - 历史输入上翻(↑)。
- **状态条**:WS 连接态 + seq、活跃任务数、忙碌成员数。

---

## 5. 核心渲染组件(事件 → UI 映射)

### 5.1 事件卡片基座 `EventCard.vue`
统一外壳:时间、agent 头像徽标(lead=紫/w1..=蓝绿循环色)、折叠态持久化(按 eventId 记忆)。

### 5.2 消息气泡 `AgentMessageBubble.vue`
- markdown 渲染(marked + DOMPurify);`agent.delta` 追加时打字机光标;`part.data/url/raw` 分别渲染为 JSON 折叠块/链接/代码块。
- 触发器消息(`x-aw-require-reply`)加「⏳待回执」徽标,回执到达(`x-aw-in-reply-to`)时在原气泡挂引用线双向跳转。

### 5.3 工具/状态块 `ToolCallBlock.vue`(Zcode 可折叠执行块)
- 标题行:🔧 图标 + 工具名 + 耗时 + ▸;
- 展开:输入参数(pretty JSON)与输出(文本/JSON);host tool(`complete_task` 等)与 omp 原生工具(bash/read/write…)同构渲染。
- 数据源:`agent.status.message`(omp `tool_execution_start`)→ 块开启;配对结果到达即闭合(未配对超时 30s 标灰)。

### 5.4 Artifact 卡片 `ArtifactCard.vue`
按 `part` 类型分发:`text`→语言侦测代码块(diff/md/json 高亮,可展开全屏);`url`→链接预览;`data`→JSON 树。命名 `deliverable/summary` 加金色边(交付物);提供「下载」「复制」。

### 5.5 任务事件行 `TaskEventRow.vue`
状态迁移箭头图(SUBMITTED→WORKING→…)+ 内联进度条(`task.progress`);父任务 WAITING 显示子任务计数徽标。

### 5.6 Agent 抽屉 `AgentInspectorDrawer.vue`(选择查看某个 worker)
- 头部:身份(name/role/harness/state)+ token 查看/复制(写操作用)+ AgentCard 链接(`/a2a/:id/card`)。
- **独立 transcript**:该 agent 的全部事件流(与主时间线同组件、agentId 过滤)——"多个 Agent 输出分别渲染"的落点。
- 任务队列(`myQueue` 视图:执行中/待执行 FIFO/已完成)。
- 记忆页签:私有记忆列表 + search(scope=private/shared)+ 手动写入/删除。
- 操作:发消息(触发器)、查看 mailbox(`GET /mailbox`)。

### 5.7 任务抽屉 `TaskInspectorDrawer.vue`(执行详情)
- 状态机时间线(全部 `task.status` 重放)、子任务树、artifacts 列表(5.4)、history 消息、重试数;
- 操作:cancel(`POST /tasks/:id/cancel`);lead 视角:dispatch 子任务表单、reassign/update(经 dispatch 端点或后续补 REST)。

### 5.8 记忆面板 `MemoryPanel.vue`
- 分域 Tab:`shared`(channel 公共,GET/POST/DELETE,写仅 lead)/`private`(按 agent 实例切换);
- 搜索框 → `POST .../memories/search`(scope=auto/private/shared,结果含 score 与 source 徽标);
- 写入表单(title/content/importance/dedupKey/scope);
- 维护按钮(lead)→ `POST /memories/maintenance` 结果 toast。

---

## 6. 状态层与数据流

### 6.1 Pinia stores(`app/stores/workshop/`)
- `workspaces.ts`:WorkspaceMeta CRUD(持久化)+ activeChannel 路由。
- `entities.ts`:channel/agent/task/memory 实体归一化(`Map<id, entity>`),来源:REST 拉取 + `channel.snapshot` + WS 增量 upsert。
- `events.ts`:per-channel `{ lastSeq, ring: AEPEvent[](2000) }` + selectors(按 agent/task/type 过滤;时间线/lanes/任务板三视图派生数据)。
- `connection.ts`:WS 生命周期(sub/unsub 多 channel、重连退避、seq 续传、连接态)。

### 6.2 组合式(`app/composables/workshop/`)
- `useWorkshopWs()`:封装 WS(参照 GameClient 重连骨架 + AEP 解析);暴露 `status/subscribe/send`。
- `useWorkshopApi()`:46 端点的类型化封装(按 §8 映射表生成;统一 Bearer 注入与错误 toast)。
- `useAgentColors()/useEventFilters()`:渲染辅助。

### 6.3 数据流
```
REST(命令) ──→ 后端 ──→ ChannelBus ──→ WS hub(AEP,seq) ──→ events.ts ──→ selectors ──→ 组件
REST(快照对齐) ───────────────────────────────────────────→ entities.ts(幂等 upsert)
```

---

## 7. 服务端配套改造(最小侵入)

| # | 改造 | 文件 | 说明 |
|---|---|---|---|
| 7.1 | AgentSessionEvent 透出(delta/工具名) | `omp-agent.ts` mapOmpEvent → ChannelBus 已 emit `status.message`;补 `delta` 聚合事件(ChannelBus 新增轻量 `emitDelta(agentId, text)` 或经 `AgentEvent.status` 扩展 `streaming` 字段) | 驱动打字机与工具块;mock/claude harness 可不产 delta(协议容忍缺省) |
| 7.2 | WS hub 推送化 + AEP + seq 重放 + sub/unsub | `server/api/workshop/ws.ts` 重写 | §2.3;保留旧事件名兼容期(v 字段区分) |
| 7.3 | memory 事件挂点 | manager `save/addAgentMemory/addTeamMemory/record*` → `bus.notifyCustom('memory.saved')`(ChannelBus 增一个透传口) | 记忆面板实时增量 |
| 7.4 | queue 视图入 snapshot | ws.ts snapshot 组装时并 `queueOverview` | 成员栏初始化即有队列上下文 |
| 7.5 | (可选)实例 PATCH 端点 | `channels/[id]/agents/[agentId].patch.ts`(manager.updateChannelAgent 已有) | 前端改名/启停实例 |
| 7.6 | (可选)channel agents GET 附 token | 现已返回;UI 侧做显式"显示密钥"交互 | token 管理入口 |

> 不做:Workspace 落库、用户体系、WS 写操作(命令面全走 REST,保持职责清晰)。

---

## 8. REST API → UI 功能全量映射(46 端点)

| UI 区域 | 端点 |
|---|---|
| Workspace 总览 | `GET/POST /channels`、`GET /channels/:id`、`POST /channels/:id/activate` |
| Channel 管理(左栏/设置) | `PATCH/DELETE /channels/:id`、`GET/POST/DELETE /channels/:id/agents` |
| 模板库页 | `GET/POST /agents`、`GET/PATCH/DELETE /agents/:id`、`POST /agents/subscribe` |
| 编组库页 | `GET/POST /teams`、`GET/PATCH/DELETE /teams/:id`、`GET/POST /teams/:id/members`、`DELETE /teams/:id/members/:agentId`、`POST /teams/:id/deploy` |
| Composer 任务 | `POST /channels/:id/tasks`(mode 表单)、`GET /channels/:id/tasks` |
| 任务抽屉 | `GET /tasks/:id`、`POST /tasks/:id/cancel`、(lead)`POST /tasks/:id/dispatch`、(agent 面)`report/complete` |
| 消息/通讯 | `POST /a2a/send`、`GET /mailbox`、`GET/POST /channels/:id/messages`(注入即时消息) |
| 队列视图 | `GET /channels/:id/queue`、`GET /runtime` |
| 记忆面板 | `GET/POST/DELETE …agents/:agentId/memories`、`POST …/memories/search`、`GET/POST/DELETE /channels/:id/memories`、`POST /memories/maintenance` |
| A2A 调试(P2) | `GET /a2a/:id/card`、`POST /a2a/:id/rpc`(tasks/sendSubscribe SSE 在浏览器直接消费) |

---

## 9. 里程碑与验收

### P0 —— 协议 + 主链路(可演示)
1. AEP v1 定稿 + WS hub 推送化重写(§7.2)+ seq 续传;e2e:断连重连补发不丢事件。
2. 前端:`/workshop` 总览(Workspace CRUD、Channel 挂载)、主控台骨架(左栏+Transcript+Composer)。
3. Transcript 渲染:快照对齐 + status/message/artifact/task 五类卡片;任务提交→闭环全流程实时可见。
4. **验收**:mock harness 三 agent channel,提交 3 任务,时间线完整呈现 dispatch→working→artifact→completed;杀 WS 重连,事件续传无缺口。

### P1 —— Harness 完全体 ✅(2026-08-16 完成,浏览器实测通过)
1. Agent lanes / 任务板视图;Agent 抽屉(独立 transcript + 队列 + 记忆);Task 抽屉(时间线/树/artifacts/cancel)。✅
2. 记忆面板全功能(分域/搜索/写入/维护);模板库 + 编组库页(deploy 到 channel)。✅
3. `agent.delta` 流式打字机 + 工具折叠块(omp 真实链路);触发器消息回执连线。(留 P2:依赖 omp delta 透出;协议已容忍缺省)
4. **验收**:真实 omp channel,聚焦任一 worker 看到独立流式输出与工具块;shared 记忆写入即时出现在其他成员检索。(mock 链路浏览器实测通过;omp 流式部分随 3 留 P2)

**P1 实施增补**:
- 三视图切换(时间线/Agent lanes/任务板看板五列);任务卡/成员行点击 → Task/Agent 双抽屉;
- 实体归一化 store 增加节流 REST 任务对齐(refreshTasks:订阅后新建任务从事件构建时补全标题/父子关系);
- WS hub 死连接加固(sendEnvelope/sendControl 逐 peer try-catch + 即时移除,防 TCP 硬断残连接中断广播);
- WS 会话重连携带 per-channel lastSeq 游标(updateCursor 持续推进,重连走重放而非全量快照);
- WorkshopWsSession/ChannelSessionList SSR 守卫(location/window/axios 相对 URL);
- 模板库页(CRUD/启用开关/实例去向展开行);编组库页(编组 CRUD/成员管理/一键 deploy)。

### P2 —— 专业打磨
1. 多 channel 同屏(sub/unsub 单连接多路);A2A RPC/SSE 调试器;⌘K 命令面板;虚拟滚动与万级事件压测。
2. steering 增强:忙时注入(immediate)实时送达 omp 会话的可视确认;人工审批门(human-in-the-loop,后续 hook)。
3. 可观测:事件密度/吞吐小图表(ECharts 复用 AppChart)。
4. **验收**:双 channel 并行任务互不串扰;断电恢复(重启服务)后 workspace 重进,历史与续传一致。

---

## 10. 测试策略

- **协议级**:`scripts/test-ws-aep.ts`——真连 hub,断言信封字段/seq 单调/重放窗口;模拟慢消费者背压。
- **e2e(浏览器)**:沿用 `scripts/e2e-*.mjs` 模式新增 `e2e-harness-ui.mjs`(fetch REST + WS 客户端 + Playwright 可选):建 workspace→挂 channel→发任务→断言事件到达计数与顺序。
- **视觉回归**:每类事件卡片快照(vitest + vue-test-utils 挂载态)。
- **鲁棒**:伪 token 401、跨 channel 403、WS 非法帧 error、断连续传。

---

## 11. 风险与决策点

| 风险 | 缓解 |
|---|---|
| omp delta 事件量大(高频 text_delta) | hub 侧 50ms 合并批推(delta 聚合);前端 ring 上限 + 虚拟滚动 |
| ChannelBus 单进程内存事件,重启丢缓冲 | seq 重置 + `channel.snapshot` 全量对齐兜底(协议已定义) |
| 公开 WS 只读无鉴权 | P0 保持只读;写全在 REST+token;P2 加 `?token` 校验开关 |
| Workspace 纯前端,跨设备不同步 | 明示为"会话隔离层"而非持久实体;后续如需可升级落库(预留接口) |
| AntD 组件密度不够"开发者感" | 事件卡片/时间线全部 UnoCSS 自绘,AntD 只用于表单/抽屉/表格类 |

---

## 12. 参考范式

- **AG-UI Protocol**——事件驱动 agent→UI 流式标准(tool call/state/generative UI 事件分类思想)。
- **AgentGUI(arXiv 2607.26300)**——并发长任务会话的观察与 steering 交互模型。
- **Zcode/Claude Code 控制台**——左侧会话树、流式 transcript、可折叠工具块、底部 composer、状态条。
- **多 agent 编排四形态**(adjacent panes / dashboard / meta-harness)——本设计取「统一时间线 + Agent lane 切换」混合形态。

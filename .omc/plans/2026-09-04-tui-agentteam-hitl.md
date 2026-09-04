# 计划：TUI 终端工作台 + HITL 全链路集成（2026-09-04）

> **状态：已实施（2026-09-04，用户批准后执行）** —— Phase 0-7 全部落地；
> 验证：hitl-registry 22 断言 / reducers 15 / commands 21 / 无头 e2e 12 全绿，build+lint 通过。
> 需求来源：用户 2026-09-04 会话（TUI 与 AgentTeam 交互作业 / ` `/ 命令管理 Channel / 实时监控 / HITL 提醒与作答 / WebUI+TUI 双端集成）。

---

## 1. 需求摘要

| # | 需求 | 来源原话要点 |
|---|------|-------------|
| R1 | 新建 `tui/` 目录实现终端渲染逻辑 | "创建一个tui文件夹，在这个tui目录下做tui的渲染逻辑" |
| R2 | 参考 openclaw / omp 的 TUI 设计 | "可以查看openclaw或者omp项目的tui如何设计的" |
| R3 | `/` 命令创建 Channel、给 Channel 添加 Agent | "通过tui下的/命令 创建Channel以及给Channel添加Agent" |
| R4 | 选择 Channel、发送任务 | "选取希望对话的Channel，发送任务" |
| R5 | 实时查看执行过程与实时输出 | "实时的查看当前对话的执行过程和实时输出" |
| R6 | 选择希望监控/下发任务的 Agent 查看 | "能够让用户选择希望监控或下发任务的Agent" |
| R7 | 核查系统 HITL 现状；处理 omp rpc 需要人类确认/ask 的场景 | "查看一下当前的系统是否支持HITL…处理omp rpc如果需要Human做一些确认或者ask问题" |
| R8 | WebUI 中 HITL 可处理 + 事件式提醒 | "确保当前webui中可以实现HITL处理…以事件的方式在前端渲染出来，能够提示用户需要处理任务" |
| R9 | TUI 同样集成 HITL：提醒 → 进入对应 Agent 下作答 | "在tui中也集成…给对应的提醒，用户可以点击进入到对应的Agent下处理回答" |

## 2. 前置验证（本日已完成 ✅）

- `pnpm build` 退出码 0（.output 产物完整，15.6 MB）。
- 服务已在 dev 模式运行（端口 3000）：`GET /` → 200；未带 token 访问 `/api/workshop/runtime` → 正确返回 `USER_UNAUTHORIZED`；`POST /api/users/login`（种子 admin）→ 签发 token；带 token `GET /api/workshop/channels`、`GET /api/workshop/agent-tools/approvals` → 200 业务数据正常。
- **结论：当前项目运行没有问题**，可直接在其上叠加 TUI 客户端与 HITL 增强层。

## 3. 现状勘察结论（事实基础）

### 3.1 AgentTeam / Channel 架构（TUI 直接复用，不改核心）

- 持久化：node:sqlite，`server/services/workshop/db/database.ts:16`，建表 `db/schema.sql`（channels L6-15 / channel_agents L27-41 / messages L43-56 / tasks L66-83 / teams L88-103）。
- Manager 单例：`server/services/workshop/runtime/manager.ts`（`createChannel` L1134、`addAgentToChannel` L1327、`createTeam` L1714、`deployTeamToChannel` L1789）。
- 关键 REST（用户 token 面）：
  - `POST /api/workshop/channels`（`server/api/workshop/channels.post.ts:13-27`，body 含 `leadAgent` 内联定义）
  - `POST /api/workshop/channels/:id/agents`（`...[id]/agents/index.post.ts:16-22`，模板克隆或内联建实例）
  - `POST /api/workshop/channels/:id/messages`（`...[id]/messages/index.post.ts:17-31`，`priority: immediate|task`，immediate=忙碌时 steer 注入 omp 会话）
  - `POST /api/workshop/channels/:id/tasks`（`...[id]/tasks/index.post.ts:41-60`，缺省自动路由 lead）
  - `GET /api/workshop/channels/:id/{messages,tasks,agents,events,queue}`
- WebSocket 事件流：`/api/workshop/ws`（`server/api/workshop/ws.ts:626`），信封 `AepEnvelope`（`shared/workshop-protocol.ts:169-178`）；上行 `sub/unsub/ping`（带 token + lastSeq 断点续传）；下行事件全集在 protocol L121-150（`agent.status/agent.message/agent.delta/task.status/task.progress/a2a.*/ops.log…`）。服务端内部经 `publish(manager, stream, type, payload, …)`（ws.ts:226）挂 manager 总线，跨模块广播有 `broadcastSceneEvent` 先例（ws.ts:602-616 → `server/services/workshop/scene-events.ts`）。
- 鉴权双域（`server/api/workshop/caller.ts:66-69`）：用户 token（`ut-*`，users.sqlite）与 Agent 实例 token（channel_agents.token UUIDv4）互不通用。**TUI 全程用用户 token**，与 WebUI 同权。
- 响应信封 `{ code, message, data }`（`server/utils/response.ts:23-43`）。

### 3.2 HITL 现状（R7 核查结论）

**已有两条可用链路：**

1. **omp ask 对话框链**（rpc-ui 模式，默认开启：`server/services/workshop/agents/omp-agent.ts:508-511`）：
   - omp 子进程发 `extension_ui_request` → 终端 Hub 登记 pending（`harness-terminal.ts:237-258`）→ 镜像为 term.frames 透传；
   - WebUI 已可处理：`app/components/workshop/terminal/OmpTerminalPanel.vue:259-296`（select/confirm/input/editor 弹卡）→ `:447-457` WS 上行 `{type:'ui_response'}` → 服务端 `respondTerminalUi` 直写 omp stdin（`harness-terminal.ts:509-545`，协议 `shared/terminal-protocol.ts:60`）。
   - 终端 WS：`/api/system/monitor/terminal/ws?agentId=&channelId=&token=`（`server/api/system/monitor/terminal/ws.ts:54-95`），`term.init` 携带当前 `hitl` 对话框，支持断线重连。
2. **dcw 工具审批链**（宿主 host tool 内挂起）：`tool-approvals.ts:44-73`（pending 内存 Map + 挂起 Promise，180s 超时）→ WebUI 轮询批复：`TownView.vue:1702-1751`（1s 轮询）+ 审批卡 `:4540-4570`；REST `GET /api/workshop/agent-tools/approvals`、`POST .../approvals/:id/decide`（`decide.post.ts:14-20`，audit 留痕）。

**HITL 缺口（本计划要补的）：**

| 缺口 | 事实依据 |
|------|---------|
| G-A 无全局"待人工处理"发现机制：AEP 主 WS 无任何 approval/hitl 帧；无跨 channel 待答列表 REST | `shared/workshop-protocol.ts:121-150` 帧全集无 hitl；approvals REST 只覆盖 dcw |
| G-B omp 对话框"无订阅者即自动取消"，没有"后台挂起等待人类"语义；等待又无超时上限 | `harness-terminal.ts:249-257`（登记时）、`:448-457`（订阅归零时） |
| G-C pending 纯内存、主运行时不感知"等待人类"状态 | `harness-terminal.ts:45` pendingHitl；`agent-interface.ts:163-170` AgentEvent 无 ask kind |
| G-D WebUI 无主动提醒（必须打开对应 agent 终端才看见对话框） | OmpTerminalPanel 仅在终端面板渲染 |
| G-E 无 TUI 客户端 | `cli/commands/` 只有管理命令（build/config/dev/doctor/start/status…） |

> 说明：全库 `control_request/control_response/permission/canUseTool` 零命中 —— omp v4.14.1 的人类请求在本项目以 `extension_ui_request` 帧形态消费，registry 预留 `kind` 扩展位即可，不需要为 permission 帧另开链路。

### 3.3 TUI 参考设计（R2）

- **openclaw（本机完整源码 `D:\codes\clawdbot`）**：技术栈 `@mariozechner/pi-tui`（组件化 TUI 框架，非 React/非 blessed）+ 瘦客户端 WebSocket。核心结构：`src/tui/tui.ts`（组件树组合：header/chatLog/statusContainer/footer/editor）、`src/tui/commands.ts`（`SlashCommand[]` 集中注册 + `parseCommand` + 别名表）、`tui-command-handlers.ts`（handler 工厂闭包注入 context）、`tui-event-handlers.ts` + `tui-stream-assembler.ts`（流式增量渲染、run 去重）、`components/`（chat-log/custom-editor/filterable-select-list/fuzzy-filter）、`gateway-chat.ts`（唯一后端通道，JSON-RPC over WS + 重连）。输入路由：`/` 命令、`!` 本地 shell、其余发消息。
- **omp（全局包 `C:\Users\87287\AppData\Roaming\npm\node_modules\oh-my-claude-sisyphus` v4.14.1）**：不自绘 TUI，走 commander + hooks + MCP stdio。其权限确认依赖 Claude Code 宿主，不作为 TUI 参考，仅确认 rpc 链路事实（见 3.2）。
- 本机 `@mariozechner/pi-tui@0.73.1` 在 npm 可用，engines `node>=20`，无平台限制；AgentWorkShop 目前无 ink/blessed/yoga 依赖。

## 4. 设计决策（ADR）

### D1：TUI 框架 = pi-tui（openclaw 同款）
- **Decision**：`@mariozechner/pi-tui` 作为唯一新增运行时依赖；TUI 代码全部为 `.mjs`（与 `cli/` 同风格，零构建步骤，兼容全局安装形态）。
- **Drivers**：本机有全套可抄的成熟实现（3.3）；组件模型正好覆盖 chat-log + editor + picker 需求；不引入 React/yoga 重依赖。
- **Alternatives**：Ink（需 react+ink+yoga 三件套，无本地参考，体积大）❌；blessed（年久失修、Windows 兼容差）❌；纯手写 ANSI（编辑器/补全成本失控）❌ 作为整体方案，但作为 **D1 的降级fallback** 保留（见 Phase 0）。
- **Consequences**：pi-tui 在 Windows 终端（Git Bash / Windows Terminal）的实际表现需 Phase 0 spike 先行验证。

### D2：TUI = 独立终端客户端进程，与 WebUI 平级
- **Decision**：`tui/` 目录是一个连接已有 server（HTTP + 双 WS）的瘦客户端；入口 `aw tui`（新增 `cli/commands/tui.mjs`）与 `pnpm tui`；**不改 Nitro 服务端的核心运行时**（HITL 增强层除外，见 D3）。
- **Why**：服务端已是中心 hub（WebUI 即此架构的客户端，openclaw 同构）；TUI 作为第二个客户端天然获得全部既有 REST/WS 能力，风险最小。
- **认证**：用户 token。`aw tui [--url] [--token]`；无 token 时交互式登录（`POST /api/users/login`）；落盘配置根 `<configRoot>/tui-auth.json`（0600 + 显式 gitignore）。

### D3：HITL 统一发现层 = 服务端 HITL Registry + AEP 帧（WebUI/TUI 共用）
- **Decision**：
  1. 新增 `server/services/workshop/agents/hitl-registry.ts`：进程内全局 pending 登记处（globalThis 单例，沿用 `tool-approvals.ts:170-175` 惯例），两条链路（omp 对话框、dcw 审批）统一登记为 `HitlItem`，并提供 per-channel 订阅广播。
  2. **G-B 语义修正**：omp 对话框从"无订阅者立即取消"改为"**park 至 registry，TTL 计时仅在零订阅者期间进行**；任一客户端订阅该 pid 终端即暂停计时"。TTL 复用现有 `security.hitl_timeout_ms`（180s，`app/config/schema.ts:46-47`）；设 0 恢复旧的立即取消行为（逃生门）。人在看（WebUI/TUI 终端打开）→ 行为与现状完全一致；人不在 → 180s 后自动 cancelled 收场（与 dcw 审批超时语义对齐）。
  3. AEP 协议新增两帧（`shared/workshop-protocol.ts` L121-150 处扩充）：`hitl.request`（payload=HitlItem）、`hitl.resolved`（payload=`{kind,id,channelId,agentId,outcome:'answered'|'cancelled'|'expired',by?}`）；`ws.ts ensureStream` 订阅 registry 按 channel publish（仿 `subscribeAgentStatus` 接线 L375 与 scene-events 先例 L602-616）。
  4. 统一 REST：`GET /api/workshop/hitl/pending?channelId=`（registry 快照，用户 token + channel 所有权校验，仿 `messages/index.post.ts:38-39` 的 `getChannelForUser+requireOwned` 惯例）；`POST /api/workshop/hitl/respond`（body `{kind,id,value?,confirmed?,cancelled?,comment?}`，路由：omp-dialog → `respondTerminalUi`；dcw-approval → `toolApprovals.decide`；幂等——已 resolved 的重复应答返回 409 `ALREADY_RESOLVED`；audit 留痕）。
- **Alternatives**：仅让 TUI 靠订阅终端 WS 保活对话框（零服务端改动）❌ —— 无法满足 R8"WebUI 也要主动提醒"，且多客户端竞争时最后一个离开者仍会触发取消。
- **Consequences**：`harness-terminal.ts` 三处取消路径（登记 L237-258 / 订阅归零 L448-457）行为变化需回归验证（Phase 1 验收项）；pending 仍为进程内存（不劣于现状——宿主重启时 omp 子进程本身也随之消失，持久化意义有限，列 follow-up）。

### D4：流式渲染模型 = run 聚合 reducer（openclaw TuiStreamAssembler 模式）
- AEP `agent.delta` 按 `(agentId,taskId)` 聚合为流式块，`agent.message`/状态迁移时定稿；reducer 写成纯函数放 `tui/lib/`，可被 tsx 单测直接驱动。WebUI 端不新增此层（其 stores 已有事件分发）。

### D5：TUI 视觉对齐控制室宪法
- 配色复用 TownView 令牌母题：主绿 `#35e0a0`、数据青 `#41c8f4`、深海军蓝底；极简工业风，无装饰框线堆砌（用户审美约束，见 ui-design-preferences）。

## 5. 架构总览

```
┌────────────────────────── 终端（用户） ──────────────────────────┐
│ tui/ (pi-tui 组件树, .mjs)                                       │
│  header(channel/连接态) · chat-log(AEP流) · monitor-pane(终端WS) │
│  status-bar(agent状态+HITL徽标) · editor(/补全·历史)             │
└──────────┬──────────────────────────────────┬────────────────────┘
           │ REST(用户token)                   │ WS /api/workshop/ws (AEP sub/lastSeq)
           │  channels/messages/tasks/hitl     │ WS /api/system/monitor/terminal/ws?agentId=
┌──────────▼──────────────────────────────────▼────────────────────┐
│ Nitro server（现有，仅 Phase1 增量）                              │
│  hitl-registry(新) ◄─ harness-terminal(omp对话框)                │
│                    ◄─ tool-approvals(dcw审批)                    │
│  ws.ts publish: hitl.request / hitl.resolved → 全部订阅端        │
└──────────┬───────────────────────────────────────────────────────┘
           │ AEP hitl.* 帧
┌──────────▼───────────────────────────────────────────────────────┐
│ WebUI：events store 消费 → AppHeader 全局徽标 → /monitor 定位作答 │
└───────────────────────────────────────────────────────────────────┘
```

## 6. 实施步骤

### Phase 0：pi-tui Windows 可行性 spike（GO/NO-GO，≤0.5 天）
1. `pnpm add @mariozechner/pi-tui`（唯一新依赖）。
2. 写临时脚本 `scripts/_spike-pitui.mjs`：在 Git Bash 与 Windows Terminal 各验证 raw-mode 输入、ANSI 渲染、编辑器光标、Ctrl+C 退出。
3. **NO-GO fallback**：若 raw-mode/渲染不可用，则 `tui/render/ansi.mjs` 自实现最小渲染子集（全量重绘 chat-log + 单行 editor + 差量状态栏，约 2 个文件），后续 Phase 的组件接口保持不变（组件层薄封装隔离框架差异）。

### Phase 1：服务端 HITL Registry + AEP 帧 + 统一 REST（独立可交付）
1. **新增** `server/services/workshop/agents/hitl-registry.ts`：
   - `HitlItem { kind:'omp-dialog'|'dcw-approval', id, channelId, agentId, agentName, pid?, method?, title, message?, options?, createdAt, expiresAt? }`；
   - `register/resolve/snapshot/subscribe(channelId, fn)`；globalThis 单例。
2. **改** `harness-terminal.ts`：
   - `handleUiRequest`（L237-258）：登记 pending 的同时 `registry.register`；零订阅者不再立即取消，改为 park + TTL（`security.hitl_timeout_ms`，仅零订阅期间计时，订阅即暂停）；
   - 订阅归零路径（L448-457）：由"立即取消"改为"恢复 TTL 计时"；
   - 应答（L509-545）/ TTL 到期 / 进程退出（L340）三条收敛路径统一 `registry.resolve` 并广播 `hitl.resolved`；
   - TTL 到期走既有 cancelled 应答路径写 omp stdin。
3. **改** `tool-approvals.ts`：`request`（L44-73）→ `registry.register(kind:'dcw-approval')`；`decide`（L75-88）与超时路径 → `registry.resolve`。
4. **改** `shared/workshop-protocol.ts`：新增 `hitl.request`/`hitl.resolved` 帧类型与 payload 接口；`AEP_GROUPS`（L187-199）加 `HITL` 分组。
5. **改** `server/api/workshop/ws.ts`：`ensureStream` 内订阅 registry（仿 L375 `subscribeAgentStatus` 接线），`publish` 两帧。
6. **新增** `server/api/workshop/hitl/pending.get.ts`、`server/api/workshop/hitl/respond.post.ts`（鉴权/所有权/幂等/audit，见 D3.4；respond 对 dcw 分支复用 `decide.post.ts:14-20` 的 audit 语义，dcw 分支自动过 `gateDangerous` 无关——该审批已在其自身链路内）。
7. **测试**：`scripts/test-hitl-registry.ts`（tsx，参照现有 scripts/test-*.ts 模式）：登记/快照/订阅广播/TTL 零订阅计时/订阅暂停/幂等 resolve/`hitl_timeout_ms=0` 立即取消，≥10 断言。
8. **回归**：现有 `scripts/_dbg-final-t6-hitl.mjs`（dcw 全链路）应仍绿。

### Phase 2：WebUI HITL 主动提醒（R8）
1. `app/stores/workshop/events.ts`：消费 `hitl.request/hitl.resolved` 帧 → 新增 pinia state `pendingHitl: HitlItem[]`（复用既有帧分发与 seq 去重，`app/stores/workshop/connection.ts`）。
2. `app/components/AppHeader.vue`（`app/layouts/default.vue` 引用）：渲染"待人工处理 N"徽标（青色 `#41c8f4`，N>0 高亮），点击下拉列出待答项（agent 名/标题/所属 channel），点击项 → `navigateTo('/monitor?agentId=…&channelId=…')`；`app/pages/monitor.vue` 已支持 agent 定位打开终端面板（OmpTerminalPanel 的 hitl-card 即作答界面，`OmpTerminalPanel.vue:713-770`，不改）。
3. dcw 审批：TownView 既有审批卡保留；另在 events store 中将 `GET agent-tools/approvals` 的 pending 合并入口保留原状（1s 轮询页内逻辑不动），header 徽标数据以 AEP 帧 + registry 快照为准（dcw 审批现已发帧，轮询成为冗余兜底）。
4. i18n：`i18n/` dicts 补 key（zh-CN/en，遵循 i18n 管线惯例）。

### Phase 3：TUI 骨架 —— 能连上、能看到、能发任务（R1/R4/R5 最小闭环）
新增 `tui/` 目录：
```
tui/
  README.md              # 按键/命令/认证说明
  aw-tui.mjs             # main(): 参数解析 → 认证 → 连接 → 启动组件树
  lib/config.mjs         # baseUrl/token 读取与保存(<configRoot>/tui-auth.json,0600)
  lib/api.mjs            # fetch 封装(信封解包/Bearer/超时,对齐 sdk/api.mjs:12 语义)
  lib/ws-aep.mjs         # AEP WS: sub/unsub/lastSeq 重连/seq 去重(对齐 useWorkshopWs.ts:25-33 语义)
  lib/ws-term.mjs        # 终端 WS: 按 agentId 连接,NO_SESSION(4404) 自动等待重试
  lib/state.mjs          # TuiState: channels/agents/messages/runs/tasks/hitl/activeChannel/monitorTarget
  lib/reducers.mjs       # AEP帧→state 纯函数(delta聚合/状态迁移/hitl增删,可单测)
  commands/index.mjs     # SlashCommand[] + parseCommand + 别名(仿 clawdbot src/tui/commands.ts)
  components/root.mjs    # 组件树组装(仿 tui.ts 的 Container 组合)
  components/chat-log.mjs
  components/editor.mjs  # / 补全 + 上下键历史(仿 custom-editor)
  components/status-bar.mjs
  components/hitl-card.mjs
  components/monitor-pane.mjs
  theme.mjs              # 控制室配色令牌(D5)
cli/commands/tui.mjs     # aw tui [--url|--token|--channel] → 转调 tui/aw-tui.mjs
package.json             # scripts: "tui": "node tui/aw-tui.mjs"
```
本 Phase 交付：登录态建立 → 默认订阅首个 channel → chat-log 渲染 `agent.message/agent.delta/task.status` 流 → 输入框普通文本 `POST messages`（缺省投递 lead，`priority:'task'`）→ 断线 lastSeq 续传。
`lib/reducers.mjs` 单测：`scripts/test-tui-reducers.ts`（delta 聚合定稿、seq 去重、hitl 增删，≥8 断言）。

### Phase 4：TUI Channel/Agent/Task 命令面（R3/R4/R6 下发侧）
命令注册表（`tui/commands/`，handler 经 context 闭包注入 api/ws/state，仿 tui-command-handlers.ts）：
| 命令 | 行为 | 后端 |
|------|------|------|
| `/help` | 命令列表 | — |
| `/channels` | 列出我的 channel（序号可选） | `GET /api/workshop/channels` |
| `/channel new <name> [--desc …] [--lead <name>]` | 创建（lead 可选内联定义） | `POST …/channels` |
| `/channel use <name\|序号>` | 切换订阅（unsub 旧→sub 新带 lastSeq） | WS sub |
| `/channel add <模板\|name> [--role lead\|worker] [--config <json>]` | 放置 agent 实例 | `POST …/channels/:id/agents` |
| `/agents` | 当前 channel 成员+实时状态（agent.status 缓存） | `GET …/channels/:id/agents` |
| `/send <agent> <text…>` | immediate 直发（steer/requireReply） | `POST …/messages priority=immediate` |
| `/task <title…> [--mode goal\|loop\|pipeline] [--assignee <agent>]` | 提交正式任务 | `POST …/tasks` |
| `/tasks` | 任务与七态/进度列表 | `GET …/tasks` + task.* 帧 |
| `/monitor <agent\|序号\|off>` | 开/关右侧监控面板 | 终端 WS |
| `/hitl`、`/hitl <序号>` | 待答列表/进入作答（Phase 6） | hitl REST |
| `/quit` | 退出 | — |
错误内联渲染（409 LEAD_EXISTS、SCOPE_VIOLATION、TEAM_EMPTY 等服务端 code 直接显示在 chat-log 错误行）。

### Phase 5：TUI 监控面板（R5/R6 查看侧）
1. `/monitor <agent>` → `ws-term.mjs` 以 `?agentId=&channelId=&token=` 连接（复用 `findLiveTerminalPidByAgent` 的 agent 寻址，`terminal/ws.ts:70-78`）；lazy-spawn 未启动时显示"等待首个任务触发 omp 进程"，收到该 agent `agent.status:busy` 帧自动重试。
2. monitor-pane 渲染 term.frames 净化帧流（extension_ui_request/host_tool_call/message delta 摘要行），`term.init.hitl` 非空时立即在面板顶部挂 hitl-card；`term.state` 驱动 streaming 指示。
3. `/monitor` 面板同时承担 HITL 计时暂停语义（D3.2：订阅即暂停 TTL）。

### Phase 6：TUI HITL 闭环（R9）
1. AEP `hitl.request` → status-bar 徽标 +1，chat-log 插入醒目提醒行（含 agent 名与标题）。
2. `/hitl` → filterable picker 列出 `GET /api/workshop/hitl/pending`；选择后自动 `/monitor` 该 agent（即"点击进入到对应的Agent下处理回答"）并在 hitl-card 按 method 渲染：confirm→`y/n`；select→序号选择；input/editor→多行编辑（prefill 预填），Esc=cancelled。
3. 提交 → `POST /api/workshop/hitl/respond` → `hitl.resolved` 帧 → 徽标清零、面板流中出现 omp 收到应答后的后续帧（人可目视确认闭环）。
4. 409 `ALREADY_RESOLVED`（如 WebUI 已抢先作答）→ 提示并刷新列表。

### Phase 7：文档 + 全量验证 + 收尾
1. `docs/tui.md`（命令/按键/认证/HITL 流程说明）+ 根 README 补入口；`docs/` 文档站如需收录另行小改。
2. `.gitignore` 显式加 `**/tui-auth.json`。
3. 全量验证（见 §8）+ 按 pathspec 限定提交（本仓库有并行会话共享 git index 的交互卷风险）。

## 7. 验收标准（全部可测）

| # | 标准 | 验证方式 |
|---|------|---------|
| A1 | `pnpm build` 退出码 0；`aw tui --help` 输出用法 | 命令行 |
| A2 | `aw tui` 首屏 <2s 列出当前用户全部 channels | 手动+日志时间戳 |
| A3 | `/channel new tui-e2e` 创建成功；`/channels` 可见；DB channels 表新增行 | sqlite 查询 |
| A4 | `/channel add` 后实例出现在成员列表；重复放 lead 内联报 409 LEAD_EXISTS 错误行 | TUI 内操作 |
| A5 | 普通文本发送 → chat-log 出现用户消息 + lead 的 `agent.delta` 聚合流式块，任务结束后块定稿且无重复（reducer 单测断言） | `scripts/test-tui-reducers.ts` + 手动 |
| A6 | `/monitor <agent>` 面板出现净化帧流；`/monitor off` 关闭；agent 未 spawn 时显示等待提示 | 手动 |
| A7 | HITL 全链路：ask 到达 → AEP `hitl.request` 帧广播；TUI 徽标+1 且 WebUI header 徽标+1；`GET hitl/pending` 含该项；任一端作答 → omp stdin 收到 `extension_ui_response`、`hitl.resolved` 帧广播、双端徽标清零 | 单测注入 + dcw 链路 e2e + 手动 omp 任务 |
| A8 | 零订阅 park TTL（默认 180s）到期自动 cancelled；有订阅者期间计时暂停；`hitl_timeout_ms=0` 恢复立即取消旧行为 | `scripts/test-hitl-registry.ts` 断言 |
| A9 | 重复应答幂等：第二端收到 409 ALREADY_RESOLVED | REST 调用 |
| A10 | `scripts/test-hitl-registry.ts`、`scripts/test-tui-reducers.ts` 全绿；`scripts/_dbg-final-t6-hitl.mjs` 回归绿 | tsx/node 执行 |
| A11 | TUI 断网重连后 lastSeq 续传，无重复渲染 | 杀 WS 重连手动 + seq 去重单测 |
| A12 | WebUI OmpTerminalPanel 既有作答流不受影响（term.init.hitl/term.frames/ui_response 路径不变） | 手动回归 monitor 页 |

## 8. 验证步骤（按 Phase 顺序）

1. Phase 0 后：spike 脚本在两个终端各跑通，出 GO/NO-GO 结论（NO-GO 则启用 fallback 渲染器并同步修订 Phase 3 组件层实现说明）。
2. Phase 1 后：`npx tsx scripts/test-hitl-registry.ts`；`node scripts/_dbg-final-t6-hitl.mjs`；重启 dev server 无启动报错。
3. Phase 2 后：起 dev → 真实 agent 任务触发 ask（或单测注入）→ header 徽标亮起 → 点击跳 monitor → 作答 → 徽标清零。
4. Phase 3-6 后：`scripts/tui-smoke.mjs`（新增，headless：login→建 channel→add agent→提交任务→断言收到 AEP 帧，参照 `scripts/api-live-e2e.mjs` 模式）+ §7 A2-A12 逐项手动核验。
5. 收尾：`pnpm build` + `pnpm lint` 绿；按 pathspec 提交（勿 `add -A`）。

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| pi-tui 在 Windows（Git Bash/WT）raw-mode 或渲染异常 | Phase 0 spike 前置 GO/NO-GO；fallback 最小自渲染器（组件接口隔离，上层 Phase 不受影响） |
| G-B 语义修改影响现有任务时序（原本秒级取消，现在等 180s） | TTL 复用既有 `security.hitl_timeout_ms` 且可设 0 回退旧行为；订阅即暂停保住"人在看"场景与现状完全一致；A8 单测锁定 |
| 多端竞态作答同一对话框 | registry.resolve 幂等闸 + 409 ALREADY_RESOLVED（A9） |
| pending 纯内存，宿主重启丢失 | 与现状等价（omp 子进程随宿主消亡，持久化意义有限）；follow-up 记录（§10） |
| tui-auth.json token 泄露 | 0600 权限 + gitignore 显式条目 + 说明文档警示 |
| 并行会话共享 git index 卷走提交 | 全部提交按 pathspec 限定，提交后核对（既有纪律） |
| hitl 帧放大 AEP 流量 | hitl 事件低频（人工交互级别），走既有 400ms 批量落库与环形缓冲机制，无额外风险 |

## 10. Non-goals / Follow-ups（本次不做，记录在案）

- 任务态 `WAITING(等待人类)` 贯通调度层（`agent-interface.ts` AgentEvent 增 kind、scheduler 感知阻塞原因）——Phase 1 的帧已足够支撑提醒，调度语义深化留待后续。
- pendingHitl 落 sqlite 持久化与多实例共享。
- R3 maker-checker（`server/api/workshop/approvals/*`，管理面双人复核）接入 TUI —— 与 agent HITL 不同链路，REST 已齐备，可作 TUI 后续命令 `/approvals`。
- TUI `!` 本地 shell 直通（openclaw 有，本期无需求）。
- 文档站（docs site）收录 TUI 页面。

## 11. 改进记录

- 直接模式产出，无 consensus 审阅轮次；勘察事实与行号引用由三路 explore 代理交叉核实（2026-09-04）。

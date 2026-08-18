<div align="center">

# AgentWorkShop

**配置驱动的多 Agent 软件开发工坊**

> 在 **Channel(频道)** 中编排一支编码 Agent 团队 —— 任务是一等公民,主理人(lead)自动调度,Agent 拥有持久记忆,平台经四个互操作入口(WebSocket / MCP / A2A / REST)接入。

**[English documentation → README.md](./README.md)**

</div>

<div align="center">

| | |
|---|---|
| 版本 | `0.1.0` |
| 运行环境 | Node.js `≥ 23.4.0`(内置 `node:sqlite`) |
| 技术栈 | Nuxt 4 · Vue 3 · Nitro · Pinia · Ant Design Vue · MCP SDK |
| 许可证 | 待定 |

</div>

---

## <div align="center">特性总览</div>

<div align="center">

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   ● Channel 强隔离      ● 主理人自动编排        ● 三种执行模式            │
│   ● 任务状态机          ● Agent 持久记忆        ● harness 无关           │
│   ● 四入口             ● Token 认证 + 监控      ● WS 实时事件时间线        │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

</div>

| | 特性 | 说明 |
|---|---|---|
| 🔒 | **Channel 强隔离** | 每个 Channel 是硬性隔离边界:独立工作目录、mailbox、任务池与事件流。Agent 只能感知**自己所在 Channel** 的同事、任务与消息,跨 Channel 零通路。 |
| 🧑‍💼 | **主理人编排** | 每个 Channel 恰有一个主理人(lead)。用户向 Channel 发任务 → 主理人统筹分解 → `dispatch` 分发给空闲下属 → 下属自动接取、执行、上报 → 主理人汇总交付。 |
| 🎯 | **三种执行模式** | `goal`(主理人判断目标是否达成)、`loop`(固定间隔循环重放)、`pipeline`(有序阶段、顺序依赖流)。 |
| 📦 | **任务一等公民** | 7 态状态机(`SUBMITTED → ASSIGNED → WORKING → WAITING → COMPLETED / FAILED / CANCELED`)、归属/指派、0–100 进度、工件(artifacts)、完整执行历史、父子任务分解。 |
| 🧠 | **持久记忆** | 每 Agent 私有域 + Channel 公共域。FTS5 全文检索(CJK 切分,中文开箱即用)、可选向量混合召回(`sqlite-vec`)、token 预算注入、`search_memory` / `save_memory` 工具、任务完成时零 LLM 成本自动沉淀。 |
| 🔌 | **harness 无关** | `mock`(进程内)、`omp`(真实编码 Agent 子进程,经 RPC)、`claude`(SDK 适配器)—— 全部实现同一 `AgentInterface` 契约,平台零感知。 |
| 🚪 | **四入口** | WS Hub(AEP 事件流)、进程内 MCP(18 个工具)、A2A JSON-RPC 2.0(含 `AgentCard`)、完整 REST —— 背后是同一个 Manager。 |
| 🔑 | **Token 认证** | 用户账号(密码哈希)+ API token 管理界面(创建/改名/吊销)。所有 workshop 调用归属用户,所有 agent 调用归属实例级 token。 |
| 📟 | **运行时监控** | `/monitor` 页面:全部存活 runtime、每个已启动 harness 子进程(含孤儿)的 PID/运行时长,一键强杀进程树(Windows `taskkill /T /F`,POSIX 进程组 SIGKILL)。 |

---

## <div align="center">快速开始</div>

### 前置条件

```bash
node -v   # ≥ 23.4.0(需要 node:sqlite)
pnpm -v   # 11.x
```

> 使用 `omp` harness(真实作业推荐)需安装 [`omp`](https://github.com/) CLI 并保证 `omp` 在 `PATH` 中(或在 agent 配置里指定 `command`)。`mock` harness 开箱即用,适合演示与联调。

### 安装与运行(开发)

```bash
git clone <仓库地址> AgentWorkShop && cd AgentWorkShop

pnpm install          # postinstall 自动执行 nuxt prepare

pnpm dev              # 开发服务,端口取自 config.yml → server.dev.port(默认 :3000)
```

打开 **http://localhost:3000** 即可。

### 生产部署

```bash
pnpm build            # nuxt build → .output/
pnpm start            # node scripts/start.mjs → 端口取自 config.yml → server.prod.port(默认 :3001)
```

`scripts/start.mjs` 从 `config.yml` 读取配置并注入 `HOST` / `PORT` 后启动 Nitro 产物;环境变量 `HOST` / `PORT` 优先级最高。

### 60 秒上手

1. **注册/登录** —— 侧边栏用户菜单中注册(或 `POST /api/users/register`),登录后 UI 保存你的 API token。
2. **创建 Agent 模板** —— `Workshop → Agents → New`(名称、harness 选 `mock` 或 `omp`、可选 JSON 配置)。
3. **创建 Channel** —— `Workshop → Channels → New`;命名并指定一个 agent 为 **lead**。
4. **添加 worker** —— 把更多 agent 模板放入 Channel(每次放置都克隆出带独立身份 token 的实例);或先建 **Team** 再一键 *deploy* 整队部署。
5. **提交任务** —— 打开 Channel,在 composer 输入目标。主理人接取、分解、分发;实时时间线里可以看到每个事件(agent 状态、流式增量、进度、工件)。

---

## <div align="center">使用说明</div>

### 认证与 token

用户使用 `email + password` 登录;凭证为 **bearer token**(API 调用无需 cookie)。

| 接口 | 用途 |
|---|---|
| `POST /api/users/register` | 创建账号 `{ email, password, name? }` → 返回 token |
| `POST /api/users/login` | 登录 → 返回 token |
| `GET  /api/users/me` | 当前用户资料 |
| `POST /api/users/logout` | 吊销当前 token |
| `GET/POST /api/users/tokens`,`PATCH/DELETE /api/users/tokens/:id` | token 管理(`/tokens` 页面同样提供) |

所有 `/api/workshop/**` 路由要求 `Authorization: Bearer <token>`。

### 作业工作流

```
创建 agent 模板 → 创建 channel(指定 lead)→ 添加 worker / 部署 team
        → 向 channel 提交任务 → lead 分解并 dispatch → worker 执行
        → 在 /workshop 观察(时间线 / 泳道 / 任务板)→ 交付工件
```

### 执行模式

在任务描述中使用模式前缀:`[mode:goal] …`、`[mode:loop] …`、`[mode:pipeline] …`。

| 模式 | 语义 | 配置(描述或 UI) |
|---|---|---|
| `goal` | lead 分解 → worker 完成 → **lead 判断目标是否满足**;不满足继续下发新任务,满足则完成主任务。 | `goalCriteria` —— 注入 lead 监督 prompt 的满意度标准 |
| `loop` | 固定间隔循环重放相同任务。 | `intervalMs`(默认 60000)、`maxIterations`(默认 ∞) |
| `pipeline` | 有序阶段;阶段 N+1 接收阶段 N 的产出。 | `stages: [{ name, description, assigneeId? }]` |

### REST API 一览

所有路由返回统一信封,请求体经 `zod` 校验。

| 领域 | 路由 |
|---|---|
| **用户 / token** | `/api/users`(CRUD)、`/api/users/login`、`/api/users/me`、`/api/users/tokens`(CRUD) |
| **Channel** | `/api/workshop/channels`(list/create)、`/api/workshop/channels/:id`(get/patch/delete/activate)、`.../messages`、`.../tasks`、`.../agents`(add/remove/patch/stop)、`.../events`、`.../queue`、`.../memories` |
| **Agent 模板** | `/api/workshop/agents`(list/create/get/patch/delete/subscribe) |
| **Team** | `/api/workshop/teams`(CRUD)、`.../members`(add/remove)、`POST .../deploy`(整队克隆部署到 channel) |
| **任务** | `/api/workshop/tasks`、`/api/workshop/tasks/:id`(get/report/complete/cancel/retry/dispatch) |
| **记忆** | 每 agent + channel 记忆:list / create / delete / `search`,以及 `POST /api/workshop/memories/maintenance`(维护/衰减) |
| **A2A** | `GET /api/workshop/a2a/:agentId/card`(AgentCard)、`POST /api/workshop/a2a/:agentId/rpc`(JSON-RPC 2.0)、`POST /api/workshop/a2a/send`(点对点消息) |
| **系统** | `GET /api/system/config`、`GET /api/system/monitor`、`POST /api/system/monitor/terminate` |
| **游戏 demo** | `/api/game/ws`(WS)、`/api/game/brain`、`/api/game/cmd` |

**A2A JSON-RPC 方法**:`tasks/send`(阻塞,30s 超时)、`tasks/sendSubscribe`(SSE 流式)、`tasks/get`、`tasks/list`、`tasks/cancel`、`message/send`、`agent/getCard`。

---

## <div align="center">设计架构</div>

### 总体架构

```mermaid
flowchart TB
    subgraph FE["前端 (Nuxt 4 / Vue 3)"]
        UI["Workshop UI — 时间线 · 泳道 · 任务板 · 记忆面板"]
        STORES["Pinia stores"]
        WS["useWorkshopWs (AEP 客户端, seq 重放)"]
    end

    subgraph SRV["服务端 (Nitro / h3)"]
        REST["REST API  /api/workshop/**"]
        WSHUB["WS Hub  /api/workshop/ws (AEP v1)"]
        A2A["A2A JSON-RPC  /api/workshop/a2a/:agentId/rpc"]
        MCP["MCP Server  18 个工具,进程内 (L3)"]
        USR["用户与 Token  /api/users/**"]
        MON["系统监控  /api/system/monitor"]

        subgraph RT["运行时 — server/services/workshop"]
            MGR["AgentChannelManager(对象模型 + 权限校验)"]
            SCH["SchedulerLoop — lead 监督 tick + 事件唤醒"]
            MODE["ExecutionMode 编排器 goal / loop / pipeline"]
            TE["TaskEngine — 7 态状态机"]
            AR["AgentRuntime × N(每个 channel 成员:mailbox、队列、harness 子进程)"]
            MEM["AgentMemory — FTS5 + 向量,预算召回,自动沉淀"]
            BUS["ChannelBus — 事件扇出(per-channel seq + 环形缓冲)"]
        end

        subgraph HB["Harness 适配器 (AgentInterface)"]
            MOCK["mock-agent(进程内)"]
            OMP["omp-agent(omp --mode rpc 子进程, host tools)"]
            CLD["claude-agent(SDK 适配器)"]
        end

        DB[("SQLite — node:sqlite\nchannels · agents · channel_agents\nteams · tasks · messages\nmemories (FTS5) · channel_events")]
    end

    UI --> STORES --> WS
    STORES --> REST
    WS --> BUS
    REST --> MGR
    A2A --> MGR
    MCP --> MGR
    USR -.token 认证.-> REST
    MON --> MGR
    MGR --> SCH
    SCH --> MODE
    MGR --> TE
    MGR --> AR
    AR --> MEM
    AR --> MOCK & OMP & CLD
    MGR --> DB
    TE --> DB
    MEM --> DB
    BUS --> DB
```

### 四个入口

同一个 `AgentChannelManager` 背后,四扇门,按需选用。

| 入口 | 端点 / 传输 | 面向 | 说明 |
|---|---|---|---|
| **WS(观察)** | `/api/workshop/ws?channelId=…` | 前端 / 仪表盘 | AEP v1 信封,per-channel 单调 `seq`;5000 事件环形缓冲;`sub` 带 `lastSeq` 重放缺失段,否则下发 `channel.snapshot` 全量对齐。`agent.delta` 流式事件驱动打字机 UI。 |
| **MCP(作业)** | 进程内服务,18 个工具 | Agent(omp 的 host tools) | 身份 = 每实例 bearer token。管理面工具(`channel.create`、`task.submit` 等)开放;作业面工具(`task.dispatch`、`a2a.send` 等)严格限定在 caller 所在 channel 作用域内。 |
| **A2A(互操作)** | `POST /api/workshop/a2a/:agentId/rpc` | 外部 A2A 客户端 | 标准 JSON-RPC 2.0 + A2A 错误码;`AgentCard` 在 `/a2a/:agentId/card`;`tasks/sendSubscribe` 提供 SSE 流。 |
| **REST(管理)** | `/api/workshop/**` | 人 / 脚本 / 上位机 | 完整管理面:channel、agent、team、任务、记忆、workspace。 |

**MCP 工具目录**

| 分组 | 工具 |
|---|---|
| Channel | `workshop.channel.create` · `workshop.channel.list` · `workshop.channel.remove` |
| Agent | `workshop.agent.create` · `workshop.agent.add` · `workshop.agent.definitions` · `workshop.agent.list` · `workshop.agent.remove` |
| 任务 | `workshop.task.submit` · `workshop.task.dispatch` · `workshop.task.list` · `workshop.task.get` · `workshop.task.report` · `workshop.task.complete` · `workshop.task.cancel` |
| A2A | `workshop.a2a.send` · `workshop.a2a.poll` · `workshop.a2a.subscribe` |

### 任务状态机

```mermaid
stateDiagram-v2
    [*] --> SUBMITTED: 用户向 channel 提交任务(自动路由到 lead)
    SUBMITTED --> ASSIGNED: lead dispatch 给 worker
    SUBMITTED --> WORKING: lead 亲自执行
    ASSIGNED --> WORKING: worker 从 mailbox 接取
    WORKING --> WAITING: 等待子任务 / 输入
    WAITING --> WORKING: 依赖解除
    WORKING --> COMPLETED: worker 上报完成(附工件)
    WORKING --> FAILED: 可重试错误(重试 ≤ 3 次,scheduler 重新指派)
    WORKING --> CANCELED: lead / 用户取消
    FAILED --> ASSIGNED: scheduler 重新指派(retry_count + 1)
    COMPLETED --> [*]
    FAILED --> [*]
    CANCELED --> [*]
```

### A2A 消息与工件模型

内部通信统一使用 A2A 语义 —— WS、MCP、REST、A2A 四种入口共用同一形状:

```ts
Part      = { text, mediaType? } | { data, mediaType? } | { url, … } | { raw, … }
Message   = { messageId, channelId, taskId?, fromAgentId, toAgentId?, role, parts: Part[], metadata }
Artifact  = { artifactId, name?, description?, parts: Part[], metadata? }   // 任务交付物
```

### Agent 持久记忆

- **域** —— 每 Agent 私有域 + Channel 公共域(`__team__` 哨兵行),按 channel 隔离。
- **种类** —— `episodic-task` / `episodic-peer`(任务完成时自动沉淀,零 LLM 成本)与 `semantic`(人工策展,衰减豁免)。
- **检索** —— FTS5 + CJK 字符切分(中文开箱即用);可选 `sqlite-vec` 向量嵌入升级为混合检索;综合分排序 = `0.5×相关性 + 0.3×时近性 + 0.2×重要性`,贪心 token 预算装配。
- **动态感知模式** —— 运行时只注入小预算"引子"(`AW_MEMORY_PRIMER_TOKENS`,默认 300 token);Agent 作业时经 `search_memory` 工具按需抓取完整内容,经 `save_memory` 主动沉淀(自动分流私有/公共域,`dedup_key` 去重)。
- **维护** —— `POST /api/workshop/memories/maintenance` 执行衰减周期与整理。

### Harness 适配器

```
AgentInterface(契约:info · run · supervise · workspace 工具面 · dispose)
 ├── MockAgentImpl      进程内、脚本化 —— 演示与测试
 ├── OmpRpcAgentImpl    拉起 `omp --mode rpc` 子进程(lazy spawn,跨消息复用);
 │                      AgentWorkspace 方法注册为 omp 的 *host tools*,
 │                      agent 原生调用 report_progress / complete_task /
 │                      dispatch_task —— 无需文本解析
 └── ClaudeSdkAgentImpl Claude Agent SDK 适配器(骨架)
```

每个 harness 子进程都会在进程注册表(`harness-process.ts`)中登记 —— 这是 `/monitor` 页面的事实源,支持孤儿进程检测与进程树强杀。

### 项目结构

```
AgentWorkShop/
├── app/                        # Nuxt 4 前端(srcDir)
│   ├── pages/                  # / · /workshop(+ agents · teams · /w/[wsId])· /game · /tokens · /users · /monitor · /settings
│   ├── components/workshop/    # TranscriptTimeline · AgentLanesView · TaskBoardView · MemoryPanel …
│   ├── composables/workshop/   # useWorkshopWs(AEP 客户端)…
│   ├── stores/workshop/        # Pinia:channels · agents · tasks · user …
│   └── game/                   # Phaser RPG demo(client、scene、protocol)
├── server/
│   ├── api/                    # REST + WS 路由(users · workshop · system · game · mcp)
│   ├── services/workshop/
│   │   ├── runtime/            # manager · agent-runtime · scheduler-loop · execution-mode
│   │   │                       # task-engine · memory · mailbox · monitor · channel-runtime
│   │   ├── agents/             # agent-interface · factory · mock-agent · omp-agent · claude-agent
│   │   │   └── adapters/       # omp-rpc-client(RPC 传输层)
│   │   ├── db/                 # schema.sql + 仓储层(node:sqlite)
│   │   └── types/              # a2a · task
│   ├── mcp/workshop-server.ts  # MCP 服务(18 个工具)
│   ├── repositories/           # 用户仓储
│   ├── schemas/ utils/ types/  # zod 校验 · 认证 · 响应信封
│   └── plugins/workshop.ts     # manager 装配(单例)
├── shared/
│   ├── workshop-protocol.ts    # AEP v1 —— 前后端统一事件协议(权威定义)
│   └── game-protocol.json/.ts  # 游戏指令注册表(JSON → zod,"改 JSON 即生效")
├── config.yml                  # ⚙ 单一事实来源(端口 · i18n · 主题 · 安全)
├── data/                       # 运行时 SQLite(git 忽略)
└── scripts/                    # e2e / 压测 / 验证套件(tsx)
```

---

## <div align="center">技术栈</div>

| 层 | 技术 |
|---|---|
| 框架 | [Nuxt 4](https://nuxt.com)(compatibility v4)+ Nitro(支持 WebSocket) |
| UI | Vue 3.5 · Pinia(持久化)· Ant Design Vue 4 · UnoCSS(attributify + icons) |
| 可视化 | ECharts / vue-echarts · Phaser 4(游戏 demo) |
| 语言 / 类型 | TypeScript 5.7 全栈;`shared/` 模块前后端共用 |
| 持久化 | `node:sqlite`(零原生依赖)+ FTS5 + 可选 `sqlite-vec` |
| 校验 | `zod` —— 每个端点一份 schema,消息边界统一编译校验 |
| Agent 互操作 | `@modelcontextprotocol/sdk` · A2A(JSON-RPC 2.0)· 自研 AEP v1 WS 协议 |
| 国际化 | `zh-CN`(默认)/ `en`,由 `config.yml` 驱动 |
| 质量 | ESLint 9(flat)· husky + lint-staged · commitlint(conventional) |

## <div align="center">开发指南</div>

```bash
pnpm dev              # 开发服务(端口取自 config.yml)
pnpm build && pnpm start   # 生产构建 + 启动
pnpm typecheck        # nuxt typecheck
pnpm lint             # eslint .
pnpm lint:fix

# 验证套件(scripts/)
node scripts/api-live-e2e.mjs     # 活体 API e2e
node scripts/verify-game.mjs      # 游戏渲染验证
pnpm game:test                    # agent brain + 游戏会话测试
```

> husky pre-commit 会对暂存文件运行 ESLint(带 `--fix`),commitlint 强制 conventional 提交信息。

## <div align="center">配置说明</div>

**`config.yml` 是单一事实来源** —— 构建/开发期由 `nuxt.config.ts` 一次性读取,生产启动期由 `scripts/start.mjs` 读取。环境变量(`.env`)可覆盖经 `runtimeConfig.public` 暴露的同名字段。

| 键 | 含义 |
|---|---|
| `server.host` / `server.dev.port` / `server.prod.port` | 绑定地址;开发端口(`pnpm dev`);生产端口(`pnpm start`) |
| `api.baseURL` / `api.timeout` / `api.pageSize` / `api.maxPageSize` | API 基址、超时、分页默认值 |
| `i18n.*` | 默认语言 + 语言列表 |
| `theme.primaryColor` / `theme.mode` | UI 色板(钴蓝墨水"制图台"主题)与明暗模式 |
| `security.sessionPassword` | session cookie 加密密钥 —— **生产环境务必修改**(或设置 `NUXT_SESSION_PASSWORD`) |

运行时环境变量(可选):`AW_MEMORY_PRIMER_TOKENS`(记忆引子预算)、嵌入提供方相关变量(见 `server/services/workshop/runtime/embedding-provider.ts`)。

## <div align="center">设计文档</div>

- `docs/superpowers/specs/2026-08-13-agent-workshop-multi-agent-design.md` —— 系统设计(角色、任务模型、四入口、错误处理)
- `docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md` —— 实施计划 + 核心契约(T3/T5)
- `docs/superpowers/plans/2026-08-15-agent-memory.md` —— 持久记忆设计
- `docs/superpowers/plans/2026-08-16-agent-harness-frontend.md` —— harness 与前端计划

---

<div align="center">

## 免责声明

AgentWorkShop 是独立项目,**并非 Anthropic 或任何 LLM 厂商的官方产品**。它通过公开接口集成 agent harness(如 `omp`)。

**待定** —— 许可证文件待补充。

</div>

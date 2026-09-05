# 多 Harness 引擎集成计划 — codex / dsh / opencode(2026-09-05)

> 状态:pending approval。
> 目标:在现有 omp 之外,新增 **codex(OpenAI Codex CLI)**、**dsh(DeepSeek Harness)**、**opencode** 三个 Agent Harness 执行引擎。用户在 Agent 模板/实例上选择 harness 即完成切换;上层(运行时/调度器/前端)只依赖 `AgentInterface`,各引擎的协议差异全部由 impl 内部适配。
> 依据:对本仓库 `agent-interface.ts` / `omp-agent.ts` / runtime 消费面的代码梳理,以及三个引擎官方文档调研(2026-09,版本:codex 0.153.x、opencode 1.18.28、dsh 0.1.2-rc.1)。

---

## 1. 现状盘点:契约层与可复用资产

### 1.1 契约层(agent-interface.ts,保持不变)

`AgentInterface` 是唯一契约,可选方法即"能力面"——新引擎按自身能力实现,上层全部走可选调用:

| 方法 | 必选? | 语义 | 上层消费方 |
|---|---|---|---|
| `run(request, ctx)` | 必选 | 一次消息输入 → 统一事件流(status/message/artifact/error/done/delta) | AgentRuntime 消费循环 |
| `supervise(snapshot, ctx)` | 可选 | lead 调度回合,返回决策数组;未实现回退内置规则引擎 | SchedulerLoop |
| `steer(text)` | 可选 | 返回 `'steer'`(同轮注入,可标消费)/ `'deferred'`(保持 pending) | AgentRuntime.injectSteer |
| `init/dispose` | 可选 | 生命周期 | runtime |
| `getProcessInfo/killProcess/reconcileProcess` | 可选 | 进程监控/强杀/OS 存活校准 | manager sweeper、/monitor |
| `getContextStats` | 可选 | 上下文用量快照(usedTokens/window/percent/compacting) | 状态视图 |
| `onTurnSettled` | 可选 | 回合落定后台钩子(压缩检查) | AgentRuntime |

关键既有语义(必须原样保真,不得因新引擎弱化):
- **消息分流**:run() 内按 `metadata['x-aw-task-kind']` 分 assign/peer/no-op;人类直发消息(`x-aw-from-label`)进入应答流。
- **steer 可靠注入协议**:'steer' 仅在确已注入流式会话时返回;其余一律 'deferred' 让消息保持 pending(轮询查空丢失 bug 的教训)。
- **错误即事件**:spawn 失败/prompt 失败/回合失败必须产出 `{kind:'error'}`,否则消息被静默 consumed(错误反馈架构审计的结论)。
- **AgentWorkspace**:约 25 个进程内能力(任务/通信/记忆/团队管理/跨 Channel),经 host tools 暴露给 LLM 原生调用,不做文本解析。

### 1.2 omp 实现的资产分解(哪些能直接复用)

omp-agent.ts(~2000 行)里混着三类代码,新引擎集成前须先拆:

**A. harness 无关资产(直接复用,不用改)**
- prompt 组装:`contextPrefix`(场景 × 身份 × 工业简报 × 名册)+ `systemManual()` + `worker-workflow`/`peer-message`/`lead-supervise`/`mode-*` —— 全部外置 `.AgentWorkShop/prompts/`,渲染器 `prompts/loader` 引擎无关。
- host tool 定义:`.AgentWorkShop/prompts/host-tools.json`(report_progress/complete_task/dispatch_task/send_message_to_agent/poll_messages/search_memory/dcw_*/daq_* 等)+ 角色过滤 `LEAD_ONLY_TOOL_NAMES`。
- 插件工具注册表:`plugin-tools.ts`(`registerPluginTool`/`listPluginTools`/热更新通知)。
- 工业工具执行体:`industrial-tools.ts`。
- 进程登记:`harness-process.ts`(register/bind/markExit/kill 进程树/存活探针)——已参数化 harness 名。
- HITL 登记处:`hitl-registry.ts`(kind 为字符串联合,需扩枚举,机制通用)。
- 上下文治理算法:contextGate 三重防线(仅回合间隙 → get_state 复查 → 互斥位+最小间隔)与 harvest 去重逻辑——可抽共享。
- 停滞看门狗 / supervise 超时 / abort 传导 / delta 50ms 批量合并 —— 纯算法,可抽共享。

**B. 需要平台化的(Phase 0 重构目标)**
- `handleHostTool` 的 workspace 桥 switch(omp-agent.ts:1483-1956):与 omp 无关,纯属 workspace 方法 → 工具结果适配。
- harness 白名单三处硬编码:`factory.ts` switch、`manager.ts:209 KNOWN_HARNESSES`、`app/pages/workshop/agents.vue:316` select options。
- HITL kind 联合:`shared/workshop-protocol.ts:123` + `hitl/respond.post.ts` 路由。
- settings 组:schema.json 仅有 `omp.*`。

**C. omp 专属(保留在 omp impl 内)**
- OmpRpcClient(stdio JSONL、ready 握手、v2 chunk 重组、host_tool_call 帧)、`extension_ui_request` 对话框、`harness-terminal` 的 omp 帧净化。

---

## 2. 三个引擎的调研结论与集成面选型

### 2.1 opencode(v1.18.28,anomalyco/opencode)

**选型:`opencode serve` 每 agent 一个子进程 + HTTP API + SSE 事件流**(官方 TS SDK `@opencode-ai/sdk` 可直接用客户端部分)。

- 启停:`opencode serve --port <alloc> --hostname 127.0.0.1`;健康 `GET /global/health`。
- prompt:`POST /session/{id}/prompt_async`(204)+ 全局 `GET /event`(SSE);首轮可在 body 直接传 `system`(系统指令覆盖)与 `tools` 开关。
- steer/abort:`POST /session/{id}/abort` 官方端点;运行中再发 prompt 会被 admit 为 `steer|queue`(v2 事件可观测)。**v1 策略:busy → 'deferred'**(保守正确,与 mailbox 语义一致),idle → 直接 prompt;后续可升级为 queue admission。
- HITL:权限事件 `permission.asked`(v1)/`permission.v2.asked`,应答 `POST /session/{id}/permissions/{pid}` body `{"response":"once"|"always"|"reject"}`;另有 question.asked/reply(agent 提问)。API 应答权限是官方支持的路径。
- host tools:运行时 `POST /mcp {name, config}` 动态注册 MCP server(每实例独立进程 → 每实例注册自己的桥)。
- usage/compaction:`message.part.updated` 携带 tokens/cost;`POST /session/{id}/summarize` 手动压缩 + 原生 auto-compaction;`ContextOverflowError` 类型化错误。
- 会话:SQLite 持久化,session id 可跨进程 resume。
- Windows:原生可跑(官方推荐 WSL)。

### 2.2 codex(OpenAI Codex CLI 0.153.x)

**选型:`codex app-server` 每 agent 一个子进程,stdio NDJSON JSON-RPC v2**。(`codex exec --json` 为一次性进程、无 steer/中断/delta,只作冒烟与降级通道,不作常驻引擎。)

- 握手:`initialize`(clientInfo;声明 capabilities)→ `initialized`;未握手前一切被拒。
- 会话:`thread/start {model, cwd, approvalPolicy, sandbox}` → `thr_xxx`;`thread/resume` 支持跨进程续会话。
- prompt/steer/abort:`turn/start` / `turn/steer`(在途回合追加输入,无 active turn 即失败)/ `turn/interrupt`(回合以 interrupted 终态结束)。
- 事件:`turn/started`、`item/started|item/completed`(agentMessage/commandExecution/mcpToolCall/...)、**`item/agentMessage/delta`**(流式增量)、`turn/completed`(status=completed|interrupted|failed,含 usage 与 codexErrorInfo)、`thread/tokenUsage/updated`。
- HITL:server→client 请求 `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`(可答 accept/acceptForSession/decline/cancel)、`tool/requestUserInput`(1-3 问)。**程序化应答是一等公民**(app-server 本来就是给宿主 app 用的)。
- host tools 两条路:
  - **`dynamicTools`**(experimental,需 capabilities.experimentalApi):`item/tool/call` 请求直达宿主,最接近 omp host tools 模型;
  - **MCP loopback**(stable):config.toml `[mcp_servers.*]` 指回本平台。
  - **v1 策略:MCP loopback 为主**(稳定面),dynamicTools 作为实验开关。
- 上下文:`model_auto_compact_token_limit` 自动压缩 + `thread/compact/start` 手动;`ContextWindowExceeded` 错误信息。
- auth:`CODEX_API_KEY` 环境变量(官方 headless 路径);`CODEX_HOME` 环境变量可按 agent 隔离配置目录。
- Windows:原生支持(自有 sandbox)。

### 2.3 dsh(DeepSeek Harness,@deepseek-ai/dsh,0.1.2-rc.1,developer preview)

**选型:`dsh --profile acp` 子进程,ACP(Agent Client Protocol v1)JSON-RPC over stdio**。理由:SDK profile 的线上协议**没有 mid-turn cancel、没有程序化 approval**(官方明确 defer),而 ACP 有 `session/cancel` 与 `session/request_permission`(allow/reject 一次性应答)。headless profile 无机器流,不用。

- 会话:`session/new` / `session/list` / `session/resume`(跨进程)/ `session/close`;每连接多 session 复用,一 session 一 in-flight prompt。
- prompt:`session/prompt`(单飞;运行中再投 = 排队语义)→ **v1 策略:busy → 'deferred',恒不 steer**。
- 事件:`session/update` 通知(assistant 消息/思考/tool 生命周期/**context usage**)。
- HITL:`session/request_permission` 请求,客户端应答 allow/reject;ApprovalPolicy=`ask|never` + sandbox 预设(read-only/workspace-write/danger-full-access),fail-closed(无应答者 → deny)。
- host tools:MCP 配置(stdio/streamable-http),工具名 `mcp__<server>__<tool>`;或 Cordis TS 插件(重,不用)。
- 上下文:原生 auto-compaction 默认开启(compaction-basic + tool-result pruner);usage 随事件;窗口默认 1M tokens。
- auth:`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`;`DSH_HOME` 按 agent 隔离。
- **风险:pre-1.0,官方明示 breaking changes**——版本必须 pin,协议探测 + 契约测试兜底。
- Windows:一等公民(PowerShell 栈)。

### 2.4 能力矩阵(impl 必须如实声明,不得虚报)

| 能力 | omp | opencode | codex | dsh |
|---|---|---|---|---|
| steer(同轮) | ✅ 原生 | ⚠️ admission(steer/queue),v1 用 deferred | ✅ turn/steer | ❌ 仅排队 → 恒 deferred |
| abort | ✅ abort | ✅ POST abort | ✅ turn/interrupt | ✅ session/cancel(ACP) |
| HITL 程序化应答 | ✅ extension_ui_request | ✅ permission/question API | ✅ requestApproval | ✅ session/request_permission(ACP) |
| host tools | ✅ set_host_tools | ✅ MCP 运行时注册 | ✅ MCP loopback(dynamicTools 实验位) | ✅ MCP 配置 |
| 流式 delta | ✅ text_delta | ✅ message.part.delta | ✅ item/agentMessage/delta | ⚠️ 消息级(ACP update) |
| usage 透出 | ✅ 帧 usage + get_session_stats | ✅ message.tokens | ✅ tokenUsage/updated | ✅ session/update context usage |
| 主动 compact | ✅ compact 命令 | ✅ summarize | ✅ thread/compact/start | ❌ 仅原生 auto |
| 进程模型 | 每 agent 一进程 | 每 agent 一 server 进程 | 每 agent 一进程 | 每 agent 一进程 |
| Windows | ✅ | ✅(WSL 更佳) | ✅ 原生 sandbox | ✅ 一等 |

---

## 3. 总体架构

```
                        ┌────────────────────────────────────────────┐
                        │  HARNESS_REGISTRY(单一事实源, Phase 0)     │
                        │  id/label/implFactory/capabilities/config  │
                        └──────┬──────────────┬─────────────┬────────┘
                               │              │             │
                 factory.ts ───┘   manager 校验 ─┘   前端 options ─┘(GET /api/workshop/harnesses)
                               │
   AgentInterface(不动)        │
   ┌──────────┬──────────┬─────┴─────┬──────────┐
   │ mock     │ omp      │ opencode  │ codex    │ dsh        (+claude 后续同构接入)
   │(进程内) │(不动)    │ impl      │ impl     │ impl
   └──────────┴──────────┴─────┬─────┴─────┬────┴─────┬
                               │ 共享底座(Phase 0 抽出)│
                               ▼                        ▼
                    host-tool-bridge.ts          turn-supervisor.ts
                    (workspace→工具分发/角色过滤)  (看门狗/超时/abort/delta 合批)
                               │                        │
                               ▼                        ▼
                    prompts/loader(不变)        context-gate.ts(压缩环通用化)
```

**host tools 统一通道(新三引擎)**:一个通用 **stdio MCP 桥脚本**(`server/harness/aw-mcp-bridge.mjs`,零依赖或仅 @modelcontextprotocol/sdk):
- 启动参数/env 注入 `AW_BASE_URL`、`AW_AGENT_TOKEN`(channel_agents.token 已有)、`AW_AGENT_ID`;
- `tools/list` 动态拉取 = `hostToolsForRole(role)` + 插件工具(插件热更新自然传导);
- `tools/call` 转发到平台既有 HTTP 桥 `POST /api/workshop/agent-tools/invoke`(需从"工业+协作工具族"扩展为**全量 host tool 分发**,复用 omp 的 handleHostTool switch 抽出的 bridge)。
- 接线:codex → per-agent `CODEX_HOME` 的 config.toml `[mcp_servers.aw]`;dsh → per-agent `DSH_HOME` 的 MCP 配置;opencode → serve 启动后 `POST /mcp` 运行时注册。
- omp 不迁移,保持原生 host tools(双通道并存,MPCP 桥同时是外部集成者的公开接法)。

**HITL 统一通道**:`AepHitlItem.kind` 扩为 `'omp-dialog' | 'dcw-approval' | 'codex-approval' | 'opencode-permission' | 'dsh-permission'`。各 impl 把引擎的 approval/permission 请求翻译成 `hitl.request` 登记(park 语义复用 `security.hitl_timeout_ms` 零订阅倒计时),`hitl/respond.post.ts` 按 kind 路由回对应 impl 的 `respondHitl(id, outcome)`(impl 经 manager 注册表可达)。前端 HITL 待办面板天然多引擎可见(读的是全局 registry)。

**会话持久化(v1 从简)**:与 omp 同口径——客户端进程内持有,respawn 即新会话;Phase 5 之后的增强项:把 `threadId/sessionId` 落库,respawn 时 `thread/resume`(codex)/`--session`(opencode)/`session/resume`(dsh)。

---

## 4. Phase 0 — 平台重构(前置,约 2~3 天)

1. **HARNESS_REGISTRY**(`server/services/workshop/agents/registry.ts`):
   ```ts
   interface HarnessDef {
     id: string
     label: string
     create(config): AgentInterface
     capabilities: { steer: boolean, supervise: boolean, hitl: boolean,
                     terminal: boolean, contextStats: boolean, compact: boolean }
     configSchema: Record<string, unknown>  // 供前端渲染 config 表单(可选)
   }
   export const HARNESS_REGISTRY: Record<string, HarnessDef>
   ```
   改造四个消费点:factory.ts、manager.ts KNOWN_HARNESSES(两处校验)、agents.vue(改为 `GET /api/workshop/harnesses` 拉取 options,兜底硬编码)。
2. **host-tool-bridge 抽离**:omp-agent 的 `handleHostTool` switch + `hostToolsForRole` + 插件分发移入 `agents/host-tool-bridge.ts`,omp 引用之;`POST /api/workshop/agent-tools/invoke` 改走同一 bridge(全量工具),为 MCP 桥铺路。
3. **turn-supervisor 抽离**:看门狗(无事件超时→abort+杀进程)、supervise 超时、abort 传导、delta 50ms 合批——从 omp-agent 抽为共享工具类,omp 重构引用,行为零变化(以现有 e2e 全绿为验收)。
4. **context-gate 通用化**:三条 prompt 路径的压缩门控 + harvest 去重抽为 `agents/context-gate.ts`(探测函数由各 impl 注入)。
5. **协议扩位**:`shared/workshop-protocol.ts` HITL kind 扩枚举;`terminal-protocol` 增加 harness 字段(TermSessionMeta 已有,确认渲染端兼容)。
6. **settings 组**:schema.json 增 `opencode.* / codex.* / dsh.*` 组(enabled、默认 command、hitl 超时覆盖等),settings.ts 增类型化读取。
7. **契约测试骨架**:`scripts/e2e-harness-conformance.ts`——参数化 harness 的行为断言套件(见 §8),先对 mock+omp 跑绿,锁定现状基线。

验收:现有全部 e2e(mock/omp 两引擎)不回归;registry 驱动的前端下拉正确;新增设置组出现在运行时设置页。

## 5. Phase 1 — opencode impl(约 3~4 天,先做:功能面最全、协议最简单)

**文件**:`agents/opencode-agent.ts` + `agents/adapters/opencode-client.ts`(薄封装 SDK 的 fetch/SSE;SDK 包 `@opencode-ai/sdk` 可选依赖,缺失时用内置 fetch 实现,避免强加依赖)。

进程模型:`opencode serve --port <free-port> --hostname 127.0.0.1` 每 agent 一进程(lazy spawn 跨消息复用,ensureClient 语义同 omp);端口由平台分配器取空闲端口(沿用 0.7.6 端口顺延经验);`OPENCODE_SERVER_PASSWORD` 随机生成注入。

映射表:
| AgentInterface/平台语义 | opencode |
|---|---|
| ensureClient | spawn serve → /global/health → POST /session(建会话,携带 model/permission ruleset)→ POST /mcp 注册桥 |
| run.prompt | `prompt_async`(parts=[{type:'text',text:组合 prompt}],system=systemManual+contextPrefix 视情况) |
| delta | SSE `message.part.delta`(field=text)→ 50ms 合批 → `{kind:'delta'}` |
| 工具可见性 | `message.part.updated` part.type=tool → `🔧 status` 事件 |
| artifact/done | 最终 assistant parts 拼文本 → artifact;`session.idle`/status=idle → done |
| 错误 | `session.error`(ProviderAuthError→OPENCODE_LLM_AUTH、ContextOverflow→OPENCODE_CONTEXT_OVERFLOW、Unknown→OPENCODE_ERROR);spawn 失败→OPENCODE_SPAWN_FAILED |
| steer | busy(GET /session/status)→ 'deferred';idle → 直接 prompt 返回 'steer'(立即投递) |
| abort(signal) | POST /session/{id}/abort;随后 done 收口 |
| HITL | SSE permission.asked / question.asked → hitl-registry 登记(kind=opencode-permission)→ respond 路由 POST permissions `{response: once|always|reject}`(cancelled→reject) |
| getContextStats | 被动缓存 message.tokens + model limit(contextWindow 可从 config provider 元数据取) |
| compact(onTurnSettled 门控) | 越阈值 → POST /session/{id}/summarize;摘要经 harvest 落记忆 |
| 权限策略 | 默认 permission:`{ edit:'ask', bash:{'*':'ask'}, webfetch:'ask' }`(HITL 打开);config 可覆盖 |
| 进程管理 | registerHarnessProcess('opencode')/reconcile(health 探测替代 PID 探针)/kill(进程树) |

- 前置校验:`opencode --version` 探测,未安装 → 创建实例时 warning(不阻塞)+ run 时 HARNESS_NOT_CONFIGURED 错误事件。
- 验收:契约套件(opencode 分支)全绿 + `e2e-opencode-realtime.ts`(仿 omp-realtime:双 agent 通信/steer/abort/HITL 应答)。

## 6. Phase 2 — codex impl(约 4~5 天)

**文件**:`agents/codex-agent.ts` + `agents/adapters/codex-app-server.ts`(NDJSON JSON-RPC 客户端:initialize 握手/id 关联/notification 分流/server→client 请求回调)。

进程模型:每 agent 一进程 `codex app-server`;**`CODEX_HOME` 指向 per-agent 目录**(`<configRoot>/harness/codex/<agentId>/`,内含 config.toml:mcp_servers.aw 桥、model、approval_policy、sandbox_mode、auto_compact 阈值)——用文件配置而非 RPC 逐项写,避免 config/value/write 的版本漂移。

映射表:
| 语义 | app-server |
|---|---|
| ensureClient | spawn → initialize(clientInfo=agentworkshop;capabilities 不开 experimentalApi)→ initialized → thread/start{model,cwd,approvalPolicy,sandbox} |
| run.prompt | turn/start{threadId, input:[{type:'text',text}]} |
| delta | item/agentMessage/delta → 合批 delta |
| 工具可见性 | item/started/completed(commandExecution/mcpToolCall/fileChange)→ 🔧 status |
| artifact/done | turn/completed(status=completed):最后 agentMessage 文本 → artifact + done;interrupted → done(带 aborted 语义);failed → error(CODEX_LLM_*) |
| steer | turn 活跃(turn/started 未终)→ turn/steer,成功='steer';失败(无 active)→ 'deferred' |
| abort | turn/interrupt |
| HITL | item/commandExecution/requestApproval、item/fileChange/requestApproval → 登记 kind=codex-approval(options=[accept/decline])→ respond 路由回 RPC 应答(cancelled→decline);tool/requestUserInput → kind=codex-approval,method=input |
| host tools | MCP loopback(桥脚本);config.toml `required = true`(桥挂了宁可失败不可静默) |
| getContextStats | thread/tokenUsage/updated 被动缓存;窗口取 config 或探测 |
| compact | onTurnSettled 门控越阈值 → thread/compact/start(contextCompaction item 生命周期→compacting 位) |
| usage 限制错误 | codexErrorInfo=ContextWindowExceeded/UsageLimitExceeded → 结构化错误码 |
| auth | CODEX_API_KEY 经 .env/start.mjs 注入(与现有密钥纪律一致:gitignored .env) |
| 进程管理 | PID 探针 + 进程树 kill(完全复用) |

- dynamicTools 留实验开关(`config.experimentalDynamicTools=true` 时启用 capabilities.experimentalApi + thread/start dynamicTools),默认关。
- 验收:契约套件(codex 分支)+ HITL 应答往返 + abort/steer 实测。

## 7. Phase 3 — dsh impl(约 3~4 天 + 风险缓冲)

**文件**:`agents/dsh-agent.ts` + `agents/adapters/dsh-acp-client.ts`(ACP v1 JSON-RPC over stdio;协议面小,自写客户端,不引三方)。

进程模型:每 agent 一进程 `dsh --profile acp`;`DSH_HOME` 指向 per-agent 目录(profile/MCP 配置隔离);版本 pin(schema.json `dsh.version` 提示 + 启动探测 `dsh --version` 记录)。

映射表:
| 语义 | ACP |
|---|---|
| ensureClient | spawn → initialize → session/new(记录 sessionId) |
| run.prompt | session/prompt(text=组合 prompt) |
| delta | session/update(assistant 消息 committed 粒度;无流式 delta → 不发 delta 事件,如实声明能力) |
| 工具可见性 | session/update tool 生命周期 → 🔧 status |
| artifact/done | 会话回到 idle + 最后 assistant 消息 → artifact + done |
| steer | **恒 'deferred'**(协议无同轮注入;busy 时 prompt 入队语义不可依赖) |
| abort | session/cancel |
| HITL | session/request_permission → kind=dsh-permission(allow/reject);ApprovalPolicy='ask';cancelled/超时→reject(fail-closed 与引擎语义一致) |
| host tools | MCP 配置指向桥脚本(工具名 `mcp__aw__*`,prompt 中向 agent 说明前缀语义) |
| getContextStats | session/update 的 context usage 被动缓存(窗口默认 1M) |
| compact | 仅原生 auto(如实声明 capabilities.compact=false);harvest:监听 compaction 事件(若 ACP 不透出则 v1 放弃 harvest,记录 TODO) |
| 进程管理 | PID 探针 + 进程树 kill |

- **pre-1.0 缓冲**:所有协议方法名集中在一个常量模块(`dsh-acp-methods.ts`),变更时改一处;契约套件失败信息直接指认方法名。
- 验收:契约套件(dsh 分支)+ Windows 真机 pwsh 栈冒烟。

## 8. Phase 4 — 终端镜像与前端统一(约 2~3 天)

1. **终端镜像通用化**:`harness-terminal.ts` 的帧净化按 harness 拆 adapter(`term-frame-sanitizer.ts`:omp 现状不动;opencode/codex/dsh 各自把事件映到通用 TermFrame 子集:text/tool/status/hitl)。OmpTerminalPanel → HarnessTerminalPanel(按 meta.harness 选择渲染分支;/monitor 终端按钮依据 hasTerminalSession 已通用)。此项可降级:Phase 1-3 期间各引擎无终端镜像(hitl-registry 面板仍可用),Phase 4 统一补齐。
2. **前端**:
   - agents.vue harness 下拉改读 `/api/workshop/harnesses`(label + capabilities 徽标:steer/hitl/compact 支持度);
   - HITL 待办面板支持新 kind 的展示文案(method/dialog 形态字段复用);
   - AgentInspectorDrawer/EventBlock 对新引擎 delta/artifact 天然兼容(统一 AgentEvent)。
3. **TUI/CLI**:`aw` 命令体系无 harness 硬编码(已核),tui 交互选择器如出现 harness 列表则同读 registry 常量(shared 导出)。

## 9. 测试策略

- **契约套件**(`scripts/e2e-harness-conformance.ts <harness>`),同一组断言跑所有引擎,断言面:
  1. assign 消息 → 产出 status/delta(能力允许时)/artifact/done 序列;
  2. host tools:report_progress/complete_task 经引擎真实工具调用落到 workspace(进度可见、任务 COMPLETED);
  3. peer 消息 + require_reply → in_reply_to 关联回执;
  4. steer 语义:busy 注入按能力返回 steer/deferred,消息不丢(最终被消费);
  5. abort:signal 传导 → 回合收口,消息按已处理落账;
  6. HITL:权限请求 → registry 登记 → respond 应答 → 引擎继续;
  7. spawn 失败(注入坏 command)→ error 事件(HARNESS_SPAWN_FAILED)且消息 requeue;
  8. 进程 kill → reconcile 收敛 → 下一回合自动重生。
- 真实引擎 e2e 需对应 CLI + key,脚本头注明前置;CI 只跑 mock 分支(与现有 e2e-omp-realtime 的本地跑法一致)。
- 单元:各 adapter 客户端(帧解析/请求关联/超时)用 mock 子进程(echo 脚本)测试,不依赖真实 CLI。

## 10. 风险与决策点

| 风险 | 影响 | 缓解 |
|---|---|---|
| dsh pre-1.0 破坏性变更 | 协议漂移 | 版本 pin + 方法名集中 + 契约测试指认;发布说明标注实验性 |
| codex dynamicTools experimental | 工具面失效 | 默认 MCP loopback 稳定路径;实验开关隔离 |
| opencode permission v1/v2 迁移中 | 应答 API 变动 | 优先 v1 端点(已在 1.18 稳定面),v2 事件兼容监听;SSE 断线重连 + 幂等应答(409 视为已答) |
| 每 agent 一进程的资源占用(3 新引擎 × N 成员) | 内存/端口 | 沿用 lazy spawn + 空闲回收策略(与 omp 同);端口分配器统一 |
| HITL 超时语义差异(dsh fail-closed) | 误批准风险 | dsh 超时恒 reject;UI 文案按 kind 区分 |
| Windows 差异(opencode WSL 建议/codex sandbox setup) | 首跑失败 | 文档化前置检查(aw doctor 扩展项);HARNESS_NOT_CONFIGURED 明确指引 |
| steer 语义不齐(dsh 无) | 行为差异困惑 | registry capabilities 如实透出;名册/系统手册注明各成员 harness 能力 |

决策点(需拍板,不阻塞 Phase 0):
1. opencode/进程模型:per-agent 进程(推荐,隔离好)vs 共享 server 多 session(省资源但生命周期耦合、cwd 绑定);
2. codex CODEX_HOME per-agent 目录 vs 全局 + RPC 写配置(推荐前者,文件即事实);
3. 会话跨重启 resume 是否进入本期(推荐不进,作为 0.9 增强);
4. claude 骨架是否同批接 registry(推荐:Phase 0 顺手迁入,实现仍后置)。

## 11. 里程碑

| 里程碑 | 内容 | 预估 | 发布 |
|---|---|---|---|
| M0 | Phase 0 平台重构 + 契约套件基线 | 2~3 天 | 0.7.7 |
| M1 | opencode impl 全绿 | 3~4 天 | 0.8.0-beta |
| M2 | codex impl 全绿 | 4~5 天 | 0.8.0-beta |
| M3 | dsh impl 全绿 | 3~4 天 | 0.8.0-rc |
| M4 | 终端镜像 + 前端/文档(`docs/harness.md`、README 引擎矩阵) | 2~3 天 | **0.8.0** |

总计约 2.5~3 周(单人口径;不含 dsh 上游 breaking 变更的应急缓冲)。

## 附:调研来源(关键)

- codex:learn.chatgpt.com/docs/app-server(权威协议 spec 在 github.com/openai/codex `codex-rs/app-server/README.md`)、non-interactive-mode、config-reference、auth、windows-sandbox。
- opencode:opencode.ai/docs/server / sdk / permissions / custom-tools / mcp-servers / providers;权威 OpenAPI:repo `packages/sdk/openapi.json`。
- dsh:github.com/deepseek-ai/deepseek-harness(packages/acp/acp/README.md、packages/sdk/protocol|client/README.md、docs/subsystems/{approval,session,sandbox}.md、docs/tool-catalog.md)、npm @deepseek-ai/dsh。

---

# 附:真实场景实测报告与优化记录(2026-09-05,真实 dev server + 真实引擎)

## 一、实测环境与方法

- 真实 `pnpm dev` 服务(3000 端口,DAQ 真实链路 MQTT:1883/Timescale:5432/MinIO:9000 全部就绪)
- 真实引擎子进程:lead=omp(glm-5.2)、worker-codex(app-server,用户本地网关 deepseek-v4-pro)、worker-dsh(acp,deepseek-v4-flash)
- 场景脚本:`scripts/e2e-real-scenario.mjs`(REST 全程驱动 + WS 实时帧 + events 持久化历史双路监控)
- 场景:建产线 → 建 DCW/DAQ 节点 → 建多引擎班组 → manual 绑定 → 三通道兼容对话 → goal 团队作业(数采→数控写入→HITL 批准→复读)→ HITL 超时路径(不批准等满 180s)

## 二、实测结论(首轮:PASS=25 FAIL=5;修复后复测见第四节)

**完整走通的核心链路(全部真实引擎、真实事件帧佐证):**
1. 多引擎班组:omp lead + codex/dsh worker 同 channel 装配、通信、调度 ✓
2. 数采→数控 HITL 确认闭环:dsh 经 MCP 桥调 dcw_control → dcw-approval 登记(节点名/175℃/安全量程齐全)→ 测试员批准 → 写入物理生效(dcw_read 读回 175℃,PLC ACT=SET)→ 任务 COMPLETED ✓
3. HITL 超时路径:审批恰好 180s 自动 expired → 待办移除 → 值未被写入(保持 175)→ worker 如实汇报超时结果 ✓;等待期间 lead 还自发验收了"等待中未落地"的中间状态,worker 用 dcw_journal 留痕
4. 事件监控:AEP 全程 500+ 帧(delta 349/message 18/task.status 10/hitl.request+resolved),WS 实时与 REST 历史双路一致 ✓
5. dsh worker 全程表现优秀:工具调用、如实报错(report_progress 无任务上下文按指示忽略)、超时等待期间不重复发起

## 三、发现的问题(按严重度)与处置

### P1 平台 bug:工业工具族被 workspace 门控误拒(已修复)
- 现象:`my_industrial_nodes` 在 worker 首回合前经 REST/MCP 直调返回「workspace 未就绪」
- 根因:共享桥分发顺序为"插件 → workspace 门控 → …",而工业工具族只按 agentId 查绑定,不依赖 workspace
- 修复:host-tool-bridge 将工业工具族(my_industrial_nodes/dcw_*/daq_*)提前到 workspace 门控之前分发

### P2 设计缺口:人类 requireReply 无可靠回执通路(已修复)
- 现象:人类经 REST 发 requireReply 消息,引擎回合只产 artifact 文本、不调 send_message_to_agent(fromId 是人类显示名,非 agent id,工具语义上也不可寻址),请求方收不到任何 in_reply_to 应答
- 根因:回执协议只覆盖 agent→agent;对人类消息 omp 时代靠"时间线可见"兜底,无确定应答保证
- 修复:AgentRuntime 在回合结束后,若消息带 requireReply+fromLabel 且回合有聚合文本 → 平台代投回执(a2a.message,in_reply_to 关联 + x-aw-relayed 标记);模型自行回执时时间线出现两条属可接受冗余(宁多勿丢)

### P3 模型遵从性:codex 引擎(经本地网关的 deepseek-v4-pro)不遵从 send_message_to_agent(未修,已缓解+建议)
- 现象:codex worker 三次被要求工具发信/回执,均只产 artifact 不调工具;lead 催办后仍未回
- 缓解:P2 落地后,人类消息回执不再依赖模型工具遵从(平台代投);agent→agent 发信仍依赖工具遵从
- 建议:①codex 引擎优先搭配指令遵从强的模型(GPT/Claude 系);②后续可探索在 codex thread/start 注入更强的协作协议说明(experimental dynamicTools 面);③将"发信成功率"纳入班组可观测指标

### P4 环境问题(非平台缺陷,已文档化)
- 本机 opencode 两把 provider key 均 401 失效 → 场景自动 SKIP,重新 `opencode auth login` 后重跑
- dsh 全局 `permission.defaultPreset: danger-full-access` 抑制引擎侧审批(用户偏好,平台不越权改写);平台级 HITL(dcw-approval)不受影响
- dev server nitro HMR 热重启后事件录制流会失效(录制流在插件启动时为存量 channel 建立;**新 channel 的录制流由首个 WS 订阅触发**)——无订阅者时 REST events 为空是设计使然;生产 start 模式无此困扰
- `.AgentWorkShop/data/runtime-settings.json` 与 `data/runtime-settings.json` 遗留双文件警告(system-config 初始化失败降级,`this.map.get is not a function`)——建议清理遗留文件并排查该降级路径

### P5 测试脚本教训(已修)
- REST 信封统一多一层 `data`(line/node/binding/result 取值需 `data.*`)
- `POST /channels/:id/agents` 一步创建直接返回克隆实例 id;两步法(POST /agents → 克隆)返回的是模板 id,拿它做绑定/调用会对不上运行时实例
- 事件持久化流由首个 WS 订阅触发;纯 REST 轮询在无订阅者时看不到事件

## 四、修复后复测结果

### 复测 run1(修 P1/P2 后):PASS=27 FAIL=3

- P1 修复生效:`my_industrial_nodes` 首回合前直调返回完整节点信息(含工艺语义注入)✓
- P2 修复生效:人类消息的平台代投回执帧被正确匹配(dsh 回执 10 秒内到达)✓
- codex 跨引擎发信的回执本轮 PASS(平台代投);剩余 FAIL 全部指向 P3 模型遵从性

### 复测 run2(发现新维度:lead 自主治理的协调风暴)

run2 出现了比 run1 更复杂的真实行为,逐项取证后确认**全部为 lead(omp/glm-5.2)自主决策所致**:

1. **重复派发**:lead 对同一目标产生两个重叠任务实例(83928c51 + f42bac3b),lead 自己发现并广播「协调消歧-勿重复执行」
2. **移除卡死成员**:codex 长时间无回执 → lead 判定卡死并 remove_team_agent(合理治理)
3. **移除了表现正常的 dsh**:重复任务改派 dsh → dsh 完成关闭 → lead 在其"队列已空待命"后仍将其移除(过激),直接导致场景后续对 dsh 的 REST 调用 404
4. **自主补员**:lead 自建 `worker-relay`(omp)接力收口,父任务最终 COMPLETED
5. HITL 超时路径在混乱中依然真实演练了一次:dsh 重做改派任务时再发 175℃ 写审批 → 无人批准 → 180s 自动 expired → 指令未落地(值保持 175)

**判定**:平台机制(消歧消息/改派/移除/补员/HITL 超时)全部按设计运转;风险在 **lead 模型的治理粒度**——"移除表现正常成员"是误判,cost 高(绑定/实例一并删除,场景脚本不得不自愈重建)。

**优化方案(P6):重复派发去重防护已落地(host-tool-bridge.dispatch_task);以下为待实施增强**:
- lead-supervise 模板增加治理纪律:「移除成员须有明确证据(连续 N 次拒绝任务/持续停滞且 notify 无效),优先 update_team_agent 停用而非移除(保留绑定与实例)」
- 平台侧可给 remove_team_agent 增加软门槛:成员仍有成功交付记录且非连续失败时,返回警告要求二次确认(工具返回提示而非硬拦截)

### 复测 run3(P6 防护落地前的最后一轮基线):PASS=28 FAIL=2

- 全部核心机制 PASS:多引擎班组/三通道对话(dsh 10s 级回执,codex 本轮也完成)/数采+数控 HITL 确认闭环(PLC 读回 ACT=SET=175℃)/HITL 超时(恰好 180s expired、值保持 175、待办移除)
- 剩余 2 个 FAIL 均为 P3 模型遵从性范畴:①codex 声称已发信但 dsh 未收到(120s);②160 审批超时后 worker 的收尾汇报 300s 未达(其回合仍在途)
- 再次观察到 lead 重复派发(b1b6ba41 重复实例),与 run2 同根因 → 确认为高频真实风险,已在 host-tool-bridge 的 dispatch_task 落地「同父同标题进行中子任务去重」防护(创建前拦截并指路既有任务)

### 场景脚本自愈能力(随 run2 同步加固)

- phase 4/5 前自动重解析成员;worker-dsh 被 lead 移除时自动重建+重绑(manual/auto)
- 消息投递 404 自动自愈重发;dcw_read 空结果自动自愈重读
- 审批匹配放宽为按 kind(实例 id 可能因自愈变化)


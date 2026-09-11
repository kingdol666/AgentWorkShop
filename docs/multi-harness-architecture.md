# 多 Harness 适配架构指南（可移植版）

> 生成日期：2026-09-10 · 基准版本：AgentWorkShop 0.7.27（14 引擎全绿）
> 用途：供其他项目参照本文档实现「多 Agent Harness（执行引擎）适配」。只讲**架构思想**与**每个引擎的库依赖/集成方式**，不绑定本仓库业务。

---

## 0. 问题域与总原则

**问题域**：平台要把 N 个异构 AI Agent 执行引擎（CLI 工具 / SDK）当作可互换的「Agent 大脑」：同一套上层编排（任务分发、消息、调度、审批、记忆）驱动任意引擎，新增引擎时上层与前端零改动。

**七条核心原则**（全部是本系统实战沉淀，移植时建议原样保留）：

1. **单一契约**：所有引擎实现同一个接口 `AgentInterface`（run/supervise/steer/HITL/进程治理等）。上层（runtime/scheduler/API/前端）只依赖契约，永远不出现 `if (harness === 'codex')`。
2. **单一事实源注册表**：一个 `HARNESS_REGISTRY` 常量表声明每个引擎的 id/label/描述/主页/**能力面**/工厂函数/**可用性探测声明**。前端下拉、可用性面板、执行前校验、模型目录全部从此派生，禁止第七处硬编码白名单。新增引擎 = 注册表加一项 + 实现一个类。
3. **两种进程模型，两个基座**：
   - **常驻会话型**（omp/codex/dsh/opencode/qwen/hermes/claude）：每 Agent 一个长活子进程（或进程内 SDK 会话），lazy 启动、跨消息复用、dispose 时销毁；
   - **一次性回合型**（gemini/copilot/cursor/crush/goose/pi）：每回合 spawn 一个子进程，进程退出即回合结束，会话延续靠引擎自身的 session id + resume 参数。
   两个模型各有共享基类（`BaseAgentImpl` → 协议无关平台语义；`OneShotCliAgentImpl` → 一次性 CLI 家族），引擎差异全部收敛为子类/引擎 spec 的一张「映射表」。
4. **能力如实声明，降级策略显式化**：注册表 `capabilities` 六元组（steer 同轮注入 / supervise lead 调度 / hitl 程序化审批 / terminal 终端镜像 / contextStats 上下文统计 / compact 主动压缩）必须反映引擎真实能力，**不虚报**。引擎不支持的，必须有明确的降级语义（如 steer 恒 `'deferred'` 走信箱；无 HITL 的走预授权白名单），不允许静默缺失。
5. **工具注入统一化 + 环境变量携带身份**：平台侧的全部协作工具（任务/消息/记忆）与业务工具，通过统一的 host-tool 分发桥暴露给引擎。CLI 引擎的注入主路径是 **stdio MCP server 桥**：桥脚本被引擎当作本地 MCP server 拉起，工具调用经 HTTP 回程落到平台 API（agent token 鉴权）。关键设计：`AW_BASE_URL / AW_AGENT_ID / AW_AGENT_TOKEN` 注入**引擎进程的环境变量**，引擎拉起的 MCP 子进程自动继承 → **配置文件可全局共享，无需每 Agent 一份 HOME**。
6. **错误即事件 / steer 诚实语义**：spawn 失败、非 0 退出、超时、协议错误都必须产出 `{kind:'error'}` 事件（错误码形如 `CODEX_EXIT_1` + stderr 尾部），绝不静默吞掉。`steer()` 只有真的注入了流式会话才返回 `'steer'`，否则返回 `'deferred'`（消息保持 pending，下一回合携带），保证消息不丢。
7. **探测与拉起同源**：「引擎是否可用」的 PATH 探测和「真实 spawn」走同一个命令解析函数；执行前在所有入口（模板增改/克隆/实例换引擎/任务直发/lead 派发等，本系统共七处）统一强校验，未知引擎 400、未安装 409，任务不进「起跑后失败」路径。

---

## 1. 分层架构与模块地图

```
                        上层（harness 无关）
   runtime(每 Agent 生命周期) · scheduler(lead 调度循环) · HITL API · 前端下拉/徽标
                                   │ 只依赖
                            AgentInterface（统一契约）
                                   │ 由
                HARNESS_REGISTRY（单一事实源：capabilities/probe/create）
                                   │ 装配
   ┌──────────────────────────────┴───────────────────────────────┐
   │ BaseAgentImpl（平台语义基类）                                  │
   │  · run() 消息分流：metadata['x-aw-task-kind']='assign'→workerTurn│
   │    否则有来源→peerTurn                                          │
   │  · supervise() 模板方法：快照→prompt→collectTurnEvents→JSON 解析 │
   │  · contextPrefix（场景×身份×手册×名册）/ dispatchHostTool 直调面 │
   └──────────────┬───────────────────────────────┬───────────────┘
                  │                               │
     常驻会话型子类                     OneShotCliAgentImpl（一次性 CLI 基座）
   omp(RPC) codex(JSON-RPC)          引擎差异=一份 OneShotEngineSpec：
   dsh/hermes(ACP) opencode(HTTP/SSE)  resolveCommand/buildArgs/promptDelivery
   qwen(旧版ACP) claude(SDK进程内)      /engineEnv/mapLine/prepare/plainTextStdout…

   ── 共享基础设施（全部引擎复用）──
   line-spawn        受控子进程拉起：拒绝 shell 元字符；Windows .cmd shim 走
                     字面量 'cmd.exe /d /s /c' 包装+逐参数校验；PATH+PATHEXT 解析
   stdio-jsonrpc     NDJSON JSON-RPC 2.0 客户端（响应/通知/服务端请求三分）
   harness-process   子进程登记/强杀（win32 taskkill /T /F）/OS 存活校准
   harness-env       MCP 桥环境计算：AW_BASE_URL/AW_AGENT_ID/AW_AGENT_TOKEN
   aw-mcp-bridge.mjs 零依赖 stdio MCP server → HTTP 回程（agent token 鉴权）
   host-tool-bridge  全引擎唯一工具分发入口（协作工具族按角色过滤+插件工具）
   prompt-builder    共享 prompt 组装（worker/peer/supervise/系统手册/JSON 提取）
   hitl-registry     HITL 中枢（globalThis 单例；kind 枚举=各引擎审批请求类型）
   harness-availability  可用性探测（与拉起同源；30s 缓存；assertHarnessUsable）
   harness-models    各引擎 provider/model 目录发现（5min 缓存）
```

**host tools 工具面**（MCP 桥暴露给引擎的内容）：AgentWorkspace 协作方法族（任务分发/上报/完成、信箱收发、记忆检索/沉淀、名册/队列观察、成员管理等 ~25 个）+ 业务/工业工具族 + 插件注册工具，按角色（lead/worker）过滤。引擎用原生工具调用方式消费，**平台不做任何文本解析**。

**HITL 链路**（引擎审批请求 → 人 → 回答）：引擎侧审批请求（如 codex `requestApproval`、dsh/hermes `session/request_permission`、claude `canUseTool`、qwen `requestToolCallConfirmation`）→ 登记 hitl-registry（kind 枚举：`codex-approval / opencode-permission / dsh-permission / claude-permission / qwen-permission / hermes-permission / omp-dialog / dcw-approval`）→ 前端铃标 → 人经 API 应答 → respondHitl 传导回引擎 → 回合继续。**超时/取消一律 fail-closed（拒绝）**。

---

## 2. 十四个引擎一览

| id | 引擎 | 官方文档 | 集成面 | 进程模型 | 库依赖 |
|---|---|---|---|---|---|
| mock | 进程内模拟引擎 | —（内部） | 剧本驱动，无 LLM，联调/CI 用 | 进程内 | 无 |
| omp | oh-my-pi | https://github.com/acidsugarx/oh-my-pi | `omp --mode rpc` 自定义 RPC 协议 | 常驻子进程 | 全局 CLI `omp` |
| opencode | OpenCode | https://opencode.ai （server：https://opencode.ai/docs/server ） | `opencode serve --port` + HTTP API + 全局 SSE `/event` | 常驻子进程 | 全局 CLI `opencode` |
| codex | OpenAI Codex CLI | https://github.com/openai/codex （app-server 协议：`codex-rs/app-server/README.md`） | `codex app-server` NDJSON JSON-RPC v2（thread/start + turn/start） | 常驻子进程 | 全局 CLI `codex` |
| dsh | DeepSeek Harness | https://github.com/deepseek-ai/DeepSeek-Harness （ACP：`packages/acp/acp/README.md`） | `dsh --profile acp` 标准 ACP v1（session/new + session/prompt 单飞） | 常驻子进程 | 全局 CLI `dsh` |
| claude | Claude Agent SDK | https://code.claude.com/docs/en/agent-sdk/typescript | 进程内 SDK：`query()` + AsyncIterable 流式输入 | **进程内 SDK**（SDK 自管 claude 二进制） | **npm：`@anthropic-ai/claude-agent-sdk`**（动态 import，缺失时报 HARNESS_NOT_CONFIGURED 而非崩溃） |
| gemini | Gemini CLI | https://github.com/google-gemini/gemini-cli （headless：`docs/cli/headless.md`） | `gemini -p --output-format stream-json`（JSONL 帧 init/message/tool_use/result） | 一次性回合 | 全局 CLI `gemini` |
| copilot | GitHub Copilot CLI | https://docs.github.com/en/copilot/how-tos/copilot-cli （编程式：`automate-copilot-cli/run-cli-programmatically`） | `copilot -p --output-format json`（JSONL） | 一次性回合 | 全局 CLI `copilot` |
| cursor | Cursor CLI | https://cursor.com/docs/cli/headless | `cursor-agent -p --output-format stream-json --stream-partial-output`（帧与 Claude Code 同构） | 一次性回合 | 原生 CLI `cursor-agent` |
| crush | Charm Crush | https://github.com/charmbracelet/crush | `crush run -q`（v0.92 起无 JSON 格式 → 纯文本 stdout 一次性） | 一次性回合 | CLI `crush`（npm shim 可能损坏，可指包内 bin 直启） |
| goose | Block Goose | https://blockgoose.io （源码：https://github.com/aaif-goose/goose ，headless 教程在仓库 docs） | `goose run -t --output-format stream-json --name aw-<agentId> [--resume]` | 一次性回合 | 原生 CLI `goose` |
| qwen | Qwen Code | https://github.com/QwenLM/qwen-code （docs：https://qwenlm-qwen-code.mintlify.app/cli/overview ） | `qwen --experimental-acp`（**旧版 Zed ACP**：camelCase 方法、无 sessionId、单隐式会话） | 常驻子进程 | 全局 CLI `qwen` |
| pi | pi coding agent | https://github.com/badlogic/pi-mono | `pi -p --mode json`（JSONL：session/message_end/message_update/turn_end）；prompt 经 **@临时文件** 投递（绕 Windows ~8K 命令行上限） | 一次性回合 | CLI `pi`（@mariozechner/pi-coding-agent） |
| hermes | Hermes Agent | https://github.com/NousResearch/hermes-agent | `hermes acp` 标准 ACP v1（与 dsh 同型，方法名集中一处便于版本漂移修改） | 常驻子进程 | CLI `hermes` |

通用协议参考：**MCP** https://modelcontextprotocol.io · **ACP（Agent Client Protocol）** https://agentclientprotocol.com

> 选型口径（可复用）：候选引擎必须满足「无头模式 + 结构化输出（JSON 事件流）+ MCP 客户端」三要素；能力覆盖密度（七能力面占几项）≥ 5/7 才值得接入。无结构化输出的引擎（如 Amazon Q CLI）宁可进观察名单也不做纯文本抓取——违背「错误即事件/usage 透出」底线。

---

## 3. 每引擎集成卡片（鉴权 · 工具注入 · 审批 · steer）

### omp（默认推荐引擎）
- 协议：omp 自有 RPC（`--mode rpc`），每 Agent 一个子进程 lazy 启动；事件 `AgentSessionEvent → AgentEvent` 映射。
- 工具：平台工具经 `set_host_tools` **进程内直调**（不回程），是最早的直连模型。
- 审批：extension_ui 对话框 → HITL；steer：✅ 原生同轮注入；上下文：被动跟踪 + 平台 70% 阈值主动压缩（引擎原生 auto-compaction 摘要经 harvest 桥落库）。
- 鉴权：`omp models` 提供 provider 分组目录；自定义网关可用。

### codex
- 协议：`codex app-server`（stdio NDJSON JSON-RPC v2）。`thread/start` 建会话、`turn/start` 驱动回合、`turn/steer` 同轮注入、`thread/compact/start` 主动压缩、`model/list` 拉模型目录。
- 工具：impl 装配 `config.toml` 的 `[mcp_servers.aw]` 指向 stdio 桥。
- 审批：`item/commandExecution|fileChange` 的 `requestApproval`（服务端→客户端请求）→ HITL（decision: accept/decline/cancel）；审批策略 `approvalPolicy: untrusted|on-request|never`，默认 on-request。
- 鉴权/provider：config.toml 网关配置；`CODEX_HOME` 环境变量可隔离配置目录。

### dsh
- 协议：标准 ACP v1（JSON-RPC over stdio）：`initialize / session/new / session/prompt / session/cancel`；`session/prompt` 单飞（响应在回合终点返回 stopReason）。方法名集中在一个常量表，pre-1.0 协议漂移时只改一处。
- 工具：`session/new` 的 `mcpServers` 参数挂 stdio 桥（引擎给工具加 `mcp__aw__` 前缀）。
- 审批：`session/request_permission` → HITL（allow/reject/cancel，fail-closed）；steer：❌ 恒 deferred。
- 鉴权/provider：`DEEPSEEK_BASE_URL` 等网关 env；模型目录=内置官方表 + 用户 settings.yaml 自定义网关轻解析。

### opencode
- 协议：`opencode serve --port <空闲>` 子进程 + 官方 HTTP API（`prompt_async / abort / permissions / summarize`）+ 全局 SSE `/event`。port 用本地 net 探测空闲。
- 工具：运行时 `POST /mcp` 注册 stdio 桥。
- 审批：`permission.asked / question.asked` 事件 → HITL（once|always|reject）；steer：✅ 回合运行中再投 prompt（引擎 queue admission），内容不丢。
- 上下文：`message.tokens` 被动跟踪，越阈值 `POST /session/{id}/summarize`；provider 目录走 `opencode models`（models.dev 生态，任意 OpenAI 兼容网关）。

### claude（SDK 特例）
- 集成：npm 依赖 `@anthropic-ai/claude-agent-sdk`，**动态 import**（依赖缺失→回合报 HARNESS_NOT_CONFIGURED，注册表仍可列出）。每 Agent 一个常驻 SDK 会话，`query({ prompt: AsyncIterable, options })` 流式输入。
- steer：✅ 向流式生成器再 `yield` 一条 user 消息（七引擎中与 omp 并列的原生 steer）。
- 审批：`canUseTool(tool, input) => PermissionResult` → HITL（allow→`{behavior:'allow',updatedInput}`；deny→`{behavior:'deny',message}`）；AW 桥工具经 `allowedTools: ['mcp__aw']` 预授权不走审批。
- 工具：`mcpServers.aw` = stdio 桥（工具清单动态 tools/list，插件热更自动传导）；SDK 也支持进程内 SDK MCP server（`createSdkMcpServer`，零回程直调）作替代通道。
- 上下文：SDK 原生 auto-compact（观测 `compact_boundary`）；usage 从 result（`total_cost_usd/usage/num_turns`）透出。
- 鉴权/provider：`config.apiKey → ANTHROPIC_AUTH_TOKEN`、`config.providerBaseUrl → ANTHROPIC_BASE_URL`（任意 Anthropic 兼容网关实测可用）。

### gemini
- 进程：每回合 `gemini -p --output-format stream-json`；init 帧捕获 session_id → 下回合 `--resume <sid>`。
- 工具：**merge-only** 写 `<workspace>/.gemini/settings.json` 的 `mcpServers.aw`（trust=true，不动用户已有配置）+ `--allowed-mcp-server-names aw` 白名单；native 工具保持 `--approval-mode default`（无头下需确认的操作被引擎拒绝，fail-safe）。
- 坑：headless 需 `GEMINI_CLI_TRUST_WORKSPACE=true`；鉴权锁定 Google 面（GEMINI_API_KEY/OAuth），**无自定义网关 provider 面**。

### copilot
- 进程：每回合 `copilot -p --output-format json`（prompt 经 stdin 管道）。
- 配置隔离：官方 `COPILOT_HOME` 指向 `.AgentWorkShop/harness-config/copilot/<agentId>/`（内种子 mcp-config.json 挂桥）——**唯一用官方 per-agent 目录隔离的引擎**。
- 授权：`--allow-tool aw` 白名单制（仅授权 AW 桥），native shell/write 默认不授权；`--no-ask-user` 默认开。
- 鉴权：token 链 `COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN`（服务端可直接用 PAT）；GitHub 账号锁定，无自定义网关。

### cursor
- 进程：每回合 `cursor-agent -p --output-format stream-json --stream-partial-output`；帧与 Claude Code 同构（system/init、assistant、tool_call、result）。
- 安全档：**默认不带 `--force`** → 文件变更只提案不落地（与平台写控制哲学一致）；per-agent 显式配置才放开。
- 工具：`--mcp-config` 指向共享 aw-mcp.json（无 agent 段：身份走 env 继承）。已知边界：print 模式 MCP 偶发不触发（版本相关）。鉴权 `CURSOR_API_KEY`，账号锁定。

### crush
- 进程：每回合 `crush run`；**v0.92 移除了 `--format json`**（相对文档回归）→ 走基座 `plainTextStdout` 模式（stdout 纯文本按增量聚合）。
- 配置：`./.crushrc`（bash 方言）。文件缺失时整份生成（`mcp add aw` 桥 + `provider add zhipu --type openai-compat` + `model add`），**api_key 引用 `${AW_CRUSH_API_KEY}` 环境变量，凭据不落盘**；已有用户配置则不动。
- 鉴权：config.apiKey → 进程 env `AW_CRUSH_API_KEY`。run 模式无程序化审批。

### goose
- 进程：每回合 `goose run --output-format stream-json -t <prompt> --name aw-<agentId> [--resume]`（prompt 必须 `-t`，位置参数被拒 exit 2）。
- 无头姿势 env：`GOOSE_MODE=auto`、`GOOSE_CONTEXT_STRATEGY=summarize`（引擎原生上下文自动摘要）、`GOOSE_MAX_TURNS`、`GOOSE_DISABLE_SESSION_NAMING=true`。
- 工具：aw 桥经 `--with-extension "<node> <bridge>"` 临时挂载（身份 env 随进程继承）。
- 鉴权/provider：`OPENAI_API_KEY` + `GOOSE_PROVIDER` + `OPENAI_HOST`（带 scheme）/`OPENAI_BASE_PATH` 拼接（OpenAI 兼容网关实测可用）。

### qwen
- 协议：`qwen --experimental-acp`——内嵌**最老版 Zed ACP**（camelCase 方法名、无 sessionId、单隐式会话）：`initialize / sendUserMessage{content[]} / cancelSendMessage`；`streamAssistantMessageChunk` 增量、`requestToolCallConfirmation` → HITL（`qwen-permission`）。`sendUserMessage` 的 JSON-RPC 响应在回合终点返回（与 dsh 单飞同型）。
- 工具：`~/.qwen/settings.json` merge-only 写 `mcpServers.aw`（trust=true）。
- 鉴权/provider：`selectedAuthType=openai` + `OPENAI_API_KEY / OPENAI_BASE_URL` 网关；**模型经 `OPENAI_MODEL` env**（acp 路径 `-m` 不生效）。教训：同族引擎（gemini fork）也要逐项探针，不能假设协议一致。

### pi
- 进程：每回合 `pi -p --mode json`；**promptDelivery='argFile'**——prompt 写临时文件后以 `@<path>` 位置参数投递，规避 Windows cmd ~8K 命令行上限。
- 工具：pi 无内建 MCP → 零依赖扩展 `pi-aw-tools.mjs` 经 `-e` 加载；工具清单由回合前置钩子从 hostToolsForRole 写临时文件（`AW_PI_TOOLS_FILE` env 指路）；工具 execute 走平台 HTTP 回程（身份 env 由 pi 进程继承到扩展）。**MCP 之外的第三种工具注入形态：引擎原生扩展机制。**
- 鉴权/provider：`--provider/--model` + `~/.pi/agent/models.json` 自定义 provider（anthropic-messages 网关实测可用）；`config.apiKey → --api-key` 透传。

### hermes
- 协议：`hermes acp` 标准 ACP v1，与 dsh 同型实现（session/new + session/prompt 单飞）。
- 审批：`session/request_permission` → HITL（`hermes-permission`，fail-closed）。
- 工具：hermes 自身 MCP 体系（`hermes mcp add aw ...` 用户级配置一次）。
- 鉴权/provider：模型面来自 hermes 自身 config.yaml（`hermes model` 交互配置）；`config.apiKey → GLM_API_KEY` env（zai provider 接 GLM）、`config.provider/model → HERMES_PROVIDER/HERMES_MODEL` env。

### mock
- 进程内剧本引擎：无 LLM、恒可用（`probe: {inprocess:true}`）、steer=true 其余能力按需。用途：联调/CI/e2e 在无任何外部 CLI 与凭据的机器上全链路跑通平台语义。**移植时强烈建议先做 mock 再接真引擎。**

---

## 4. 能力矩阵（注册表 capabilities 实际声明值）

| 引擎 | steer 同轮 | supervise 调度 | hitl 审批 | terminal | contextStats | compact |
|---|---|---|---|---|---|---|
| mock | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| omp | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| opencode | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| codex | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| dsh | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ |
| claude | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| gemini | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ |
| copilot | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| cursor | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| crush | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ |
| goose | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ |
| qwen | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| pi | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ |
| hermes | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ |

- `supervise`（lead 调度回合）是平台侧 prompt 驱动的，所有引擎都能做——所以全 ✅；它不属于引擎原生能力。
- **无 HITL 引擎的安全姿态**（重要设计）：AW 桥工具是平台可信面、显式白名单放行；引擎 native 写/执行工具保持各引擎**最保守档**（gemini `--approval-mode default`、copilot 仅 `--allow-tool aw`、cursor 默认无 `--force`、goose headless fail-safe）。高危操作在这些引擎上**默认不发生**，而不是静默放行。

---

## 5. 新增一个引擎的接入清单（Step-by-step）

1. **调研探针先行**：写一次性探针脚本（spawn → 首个结构化事件 → 退出码语义），确认：无头参数、JSONL 帧形、会话延续标志、MCP 配置定位、鉴权 env 面、provider 网关面、审批事件存在性。**产出差异表后再写 impl**（勿信文档，文档会回归——crush 删 JSON 格式是实例）。
2. **注册表条目**：`HARNESS_REGISTRY` 加一项——id/label/description/homepage/**capabilities（如实初稿，探针后修正）**/`create`（工厂：new Impl({...config, agentId, name, role, channelId, token})）/**probe**（进程内引擎 `{inprocess:true}`；进程型 `{command: c => 覆盖链}`，与真实 spawn 同源）。
3. **选择基座**：常驻会话型 → 继承 `BaseAgentImpl`，实现 `workerTurn/peerTurn/collectTurnEvents`（+ steer/getContextStats/respondHitl 按能力覆盖）；一次性 CLI 型 → 在 `OneShotCliAgentImpl` 上写一份 `OneShotEngineSpec`（resolveCommand/buildArgs/promptDelivery/engineEnv/mapLine/prepare/…），通常 80~250 行。
   ⚠️ 基类构造参数必须显式 `super(config, spec)` 透传（空子类隐式构造器会丢 spec → 静默失败）。
4. **工具注入**：优先 stdio MCP 桥（merge-only 写引擎配置 or `--mcp-config` 旗标 or 运行时注册 API）；引擎无 MCP → 仿 pi 用引擎原生扩展机制；SDK 型 → SDK MCP server。**身份 env（AW_AGENT_ID/AW_AGENT_TOKEN/AW_BASE_URL）必须注入引擎进程**，让桥子进程继承。
5. **审批接入**（若有）：引擎审批请求 → hitl-registry 注册（新增 kind 进枚举）→ 实现 `respondHitl`（outcome 映射回引擎协议；超时/取消 fail-closed）。
6. **平台面派生项**：运行时设置加 `harness.<id>_command`（命令覆盖链最后一环）；模型目录（静态表 or 引擎子进程发现）；i18n 词条（引擎名/未安装态，双语）；文档页（安装/鉴权/能力矩阵/已知限制四节）。
7. **测试验收**：
   - 单测：假 CLI（node -e 输出预制 JSONL）断言事件映射/退出码→错误事件/abort 杀树/会话 id 捕获/resume 参数/HITL 超时 deny；
   - 引擎 e2e 双场景：A=工具闭环（引擎经桥调 report_progress→complete_task→落库）；B=HITL（注册→铃标→respond→回合继续至 done）；真实子进程+真实 LLM，**凭据缺失自动 SKIP（有因跳过≠失败）**；
   - 可用性三态断言（未知 400 / 未装 409 / 装了 resolvedPath）；
   - 前端：下拉出现新引擎、未安装灰化、设置页命令项探测联动；
   - 回归门：既有引擎 e2e + runtime/liveness 单测全绿。

---

## 6. 工程纪律与已知坑（移植时省命）

- **Windows**：npm 全局 CLI 是 `.cmd` shim，CreateProcess 不能直启 → 固定 `cmd.exe /d /s /c` 包装 + 逐参数严格校验（拒绝引号/控制字符），参数面保持结构化。包装器必须是字面量，绝不由环境变量决定。npm shim 本身可能损坏（crush 实例）→ 命令设置可指向包内真实 bin。
- **命令行长度**：Windows cmd ~8K 上限 → 长 prompt 用 stdin 投递（默认）或 argFile（`@file`，pi 模式）。
- **stdin EOF**：`promptDelivery=arg` 时基座仍须关闭 stdin，否则等 stdin 的引擎挂起（crush 实例）。
- **同族≠同协议**：gemini/qwen 同 fork 但事件协议完全不同（stream-json vs 旧版 zed ACP）；每个引擎独立探针。
- **配置文件写入一律 merge-only**：只增不改，用户已有配置解析失败时**保留原文件不动**并告警；凭据永远走 env 引用不落盘。
- **多 Agent 并发**：环境变量携带身份使引擎配置可全局共享；per-agent 会话隔离各用引擎机制（goose `--name`、copilot `COPILOT_HOME`、codex `CODEX_HOME`、dsh/omp 进程独占）；同一 Agent 同时只允许一个回合（回合互斥位）。
- **进程治理**：所有子进程登记注册表；abort = 杀进程树（win32 `taskkill /T /F`）；OS 存活周期校准（休眠/强杀后 exit 事件可能不达父进程）。
- **schema 漂移防护**：解析器对未知事件/未知 type **忽略并计数上报**（不崩）；错误消息附 stderr 尾部；引擎版本 pin 建议。
- **不许静默**：能力缺失有显式降级语义；执行前强校验给「人话」报错；错误即事件。

---

## 7. 本仓库对应文件索引（供交叉查阅）

| 职责 | 文件 |
|---|---|
| 注册表 + capabilities | `server/services/workshop/agents/registry.ts` |
| 统一契约 | `server/services/workshop/agents/agent-interface.ts` |
| 平台语义基类 | `server/services/workshop/agents/base-agent.ts` |
| 一次性 CLI 基座 | `server/services/workshop/agents/adapters/one-shot-cli-agent.ts` |
| 受控 spawn | `server/services/workshop/agents/adapters/line-spawn.ts` |
| JSON-RPC 基座 | `server/services/workshop/agents/adapters/stdio-jsonrpc.ts` |
| 各引擎 impl | 同目录 `{omp,codex,dsh,opencode,claude,gemini,qwen,copilot,cursor,crush,goose,pi,hermes,mock}-agent.ts` |
| MCP 回程桥 | `server/harness/aw-mcp-bridge.mjs`（零依赖）· pi 扩展 `server/harness/pi-aw-tools.mjs` |
| 工具分发/权限/审批 | `host-tool-bridge.ts` · `tool-approvals.ts` · `hitl-registry.ts` |
| 环境注入/进程治理/探测/模型目录 | `harness-env.ts` · `harness-process.ts` · `harness-availability.ts` · `harness-models.ts` |
| prompt 组装 | `prompt-builder.ts` |
| e2e | `scripts/e2e-multi-harness.ts [engine]`（双场景，401 自动 SKIP） |

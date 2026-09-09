# Harness 生态扩展计划 — claude / gemini / qwen / copilot / cursor / crush / goose（2026-09-09）

> 状态：**pending approval**。
> 目标：把 AgentWorkShop 的执行引擎从现有 6 个（mock/omp/opencode/codex/dsh/claude 骨架）扩展到覆盖市面主流 Agent Harness，共新增 **7 个完整实现**（其中 claude 是把现有骨架做成真实现）+ 1 个观察名单（Amazon Q CLI）。用户在 Agent 模板/实例上选择 harness 即切换；上层继续只依赖 `AgentInterface`，全部协议差异收敛在 impl 内部。
> 依据：本仓库现有实现盘点（registry/共享桥/MCP 回程/HITL/可用性，见 §2），以及 8 个引擎官方文档与开源源码调研（2026-09，证据 URL 全部列于 §14 附录）。

---

## 1. 需求摘要

- **功能兼容的定义（本计划的验收口径）**：新引擎接入后，平台七类能力面 —— ①任务回合（run/事件流/delta）②steer（同轮注入）③中止（abort）④HITL 程序化审批 ⑤host tools（workspace 协作 + 工业工具族经 MCP 回程）⑥上下文治理（usage 透出/压缩）⑦会话延续（resume）—— 每个引擎要么原生支持，要么有**明确声明的降级策略**（deferred 邮箱 / 白名单预授权），不允许出现静默缺失。能力声明写入 `HARNESS_REGISTRY` 的 `capabilities`，如实反映引擎真实能力，不得虚报（沿用 2026-09-05 计划的既有纪律）。
- 平台侧机制（可用性探测、七入口强校验、HITL 铃标、模型目录、前端下拉）必须**自动覆盖**新引擎，不允许出现第七处硬编码白名单。
- 全部在 Windows 宿主（当前生产环境）可跑：npm 安装的 CLI 走既有 `line-spawn` 的 `.cmd` shim 链路；原生二进制（crush/goose/cursor）走 `resolveExecutable` 直启。

## 2. 现状盘点：可复用资产与契约（全部已存在，不改语义）

| 资产 | 位置 | 新引擎复用方式 |
|---|---|---|
| 单一事实源注册表 | `server/services/workshop/agents/registry.ts:75-124`（`HARNESS_REGISTRY`，`HarnessDef` L34-42：id/label/description/capabilities/create/probe） | 每引擎新增一个条目；`harnessMetas()`/前端下拉/七入口校验自动派生 |
| 统一契约 | `server/services/workshop/agents/agent-interface.ts`（`AgentInterface` L224-281，run/supervise/steer/init/dispose/getProcessInfo/killProcess/reconcileProcess/getContextStats/onTurnSettled/dispatchHostTool/respondHitl） | 不动；新 impl 按能力实现可选方法 |
| host tool 共享桥 | `server/services/workshop/agents/host-tool-bridge.ts`（`dispatchHostTool` L133-659 全引擎唯一分发入口；`hostToolsForRole` L69-86 角色过滤+插件工具） | 新 impl 的 `dispatchHostTool` 一行转发 |
| MCP 回程桥 | `server/harness/aw-mcp-bridge.mjs`（零依赖 stdio MCP server；`fetchTools`/`callTool` → HTTP `/api/workshop/agent-tools/*`，`x-aw-agent-token` 鉴权）+ `harness-env.ts`（`generateMcpBridgeEnv` L41 注入 AW_BASE_URL/AW_AGENT_ID/AW_AGENT_TOKEN） | 所有 CLI 型新引擎的 host tools 注入主路径 |
| Windows spawn 基座 | `server/services/workshop/agents/adapters/line-spawn.ts`（`resolveOnPath` L29 PATHEXT 解析、`spawnLineProcess` L84 cmd.exe /d /s /c 包装、`assertCmdSafeArg` L76）；NDJSON JSON-RPC 基座 `adapters/stdio-jsonrpc.ts` | gemini/qwen/copilot 为 npm `.cmd` shim → 必走此路；crush/goose/cursor 原生二进制 → `resolveExecutable` 标记直启 |
| 进程登记/强杀 | `server/services/workshop/agents/harness-process.ts`（register/bind/markExit/`killHarnessProcess` L125-158 win32 `taskkill /T /F`） | 一次性回合进程同样登记（abort = 杀进程树） |
| HITL 中枢 | `server/services/workshop/agents/hitl-registry.ts`（`HitlRegistryService` L48 globalThis 单例；kind 联合在 `shared/workshop-protocol.ts:126`，现有 5 值）+ 应答链 `hitl/respond.post.ts` → `manager.respondHarnessHitl` → `runtime.respondHitl` → `impl.respondHitl` | 新增 kind：`claude-permission`（canUseTool）；视探针结果可能新增 `crush-permission` |
| 可用性探测 | `server/services/workshop/agents/harness-availability.ts`（`probeExecutable` L55-67 与 line-spawn 同源；30s 缓存；`assertHarnessUsable` L119-127 → 400/409） | registry 新条目自带 `probe`，七入口强校验（manager.ts 7 个调用点）零改动生效 |
| 模型目录 | `server/services/workshop/agents/harness-models.ts`（`harnessModelCatalog` L249，5min 缓存；现有 omp/codex/opencode/dsh 四目录） | 新增 7 个目录条目 |
| 引擎配置 | `server/services/workshop/settings.ts:87-92`（`harness.*_command`）+ `schema.json:70-73` | 新增 `claude/gemini/qwen/copilot/cursor/crush/goose_command` |
| prompt 桥 | `server/services/workshop/agents/prompt-builder.ts`（contextPrefix/systemManual/workerPrompt/peerPrompt/supervisePrompt，四引擎共用） | 直接复用 |
| e2e 骨架 | `scripts/e2e-multi-harness.ts`（内存 SQLite + `startBridgeHttp` L70 模拟回程 HTTP + `PLANS` L175-195 各引擎触发剧本 + 401 自动 SKIP） | 扩 PLANS + 新引擎场景 |

**既有语义必须原样保真**（2026-09-05 计划 §1.1）：消息分流按 `metadata['x-aw-task-kind']`；steer 只在确已注入时返回 `'steer'` 否则 `'deferred'`；错误必须产出 `{kind:'error'}` 事件；`AgentWorkspace` 25 个协作方法经 host tools 暴露、不做文本解析。

## 3. 调研结论（8 个候选）

### 3.1 一览：无头 + 结构化输出 + MCP 客户端三要素

| 引擎 | 无头模式 | 结构化输出 | MCP 客户端 | 会话延续 | 程序化审批 | 许可证/开源 | 选型 |
|---|---|---|---|---|---|---|---|
| Claude Agent SDK | 进程内 SDK（npx 二进制） | ✅ SDKMessage 全类型 | ✅ 含**进程内 SDK MCP server** | ✅ resume/forkSession | ✅ canUseTool 回调 | 闭源 SDK，但接口公开 | **P0** |
| Gemini CLI | `-p` 强制非交互 | ✅ `--output-format stream-json`（JSONL） | ✅ settings.json mcpServers | ✅ `--resume latest\|index` | ❌（`--approval-mode` 策略制） | Apache-2.0，开源 | **P0** |
| GitHub Copilot CLI | `-p` 运行即退出 | ✅ `--output-format json`（JSONL） | ✅ `~/.copilot/mcp-config.json` | ⚠️ 待探针 | ❌（`--allow-tool` 白名单制） | MIT，开源（github/copilot-cli） | **P0** |
| Crush | `crush run --format json` | ✅ JSONL（step_start/text/step_finish） | ✅ stdio/http/sse + OAuth | ✅ session 体系 | ⚠️ run 模式待探针（serve 通道有） | FSL-1.1，源码可得 | **P0** |
| Cursor CLI | `-p --print` | ✅ `stream-json`（Claude Code 同构帧） | ✅ `--mcp-config` | ⚠️ 待探针 | ❌（`--force` 二档） | 闭源 | **P1** |
| Goose | `goose run -t` | ✅ `--output-format json\|stream-json` | ✅ extensions（--with-extension/config.yaml） | ✅ `--resume --name` | ❌（配置默认 + fail-safe） | MIT，开源（Rust） | **P1** |
| Qwen Code | `-p` + stream-json 即无头 | ✅ `json`（末尾单数组）/`stream-json`（增量） | ✅ 同 gemini fork | ✅ 同 gemini | ❌ | Apache-2.0，开源 | **P1**（与 gemini 共族） |
| Amazon Q CLI | `--no-interactive`（stdin 管道） | ❌ 源码级确认无 output_format（chat/mod.rs grep 零命中） | ✅ cli-config.json | ✅ `--resume` bool | ❌（仅 `--trust-all-tools`） | Apache-2.0，开源 | **观察名单** |

### 3.2 关键细节（写入 impl 的依据）

**Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）** — 参考文档 code.claude.com/docs/en/agent-sdk/typescript：
- `query({ prompt, options })`；prompt 可为 string 或 **AsyncIterable\<SDKUserMessage\>（流式输入 = steer 通道）**；`startup()` 预热。
- 选项面：`systemPrompt`、`allowedTools/disallowedTools`、`permissionMode`、`model`、`maxTurns`、`cwd`、`env`、`abortController`、`settingSources('user'|'project'|'local')`、`resume`、`forkSession`、`includePartialMessages`（开启 `stream_event` 增量）、`mcpServers`（支持 `McpStdioServerConfig`/`McpHttpServerConfig`/**`McpSdkServerConfigWithInstance` 进程内 SDK MCP server**）、`canUseTool(toolName, input, {signal, requestId}) => PermissionResult`（`{behavior:'allow', updatedInput, updatedPermissions?}` | `{behavior:'deny', message, interrupt?}`）、`hooks`（PreToolUse/PostToolUse/SessionStart/…）。
- Query 控制面对象：`interrupt()`（带 receipt 确认）、`setModel()`、`setPermissionMode()`、`setMcpServers()`（运行中动态换桥）、`mcpServerStatus()`、`supportedModels()`、`getContextUsage()`（上下文统计直取）、`rewindFiles()`。
- 消息类型：`SDKSystemMessage`(init：model/permissionMode/tools/slash_commands)、`SDKAssistantMessage`、`SDKUserMessage`、`SDKResultMessage`（subtype success/error_max_turns/error_during_execution、`total_cost_usd`、`usage`、`num_turns`、`is_error`、`result`、`modelUsage`）、`SDKPartialAssistantMessage`(stream_event)、`SDKCompactBoundaryMessage`。
- Windows：原生支持（内置 claude.exe 路径解析）。鉴权：`apiKey` 选项或 `ANTHROPIC_API_KEY`；`settingSources:'user'` 可复用本机 Claude Code OAuth 登录。

**Gemini CLI（google-gemini/gemini-cli）** — docs/cli/headless.md + docs/cli/cli-reference.md：
- `-p/--prompt` "Forces non-interactive mode"；非 TTY 自动进入无头。
- `--output-format text|json|stream-json`（默认 text）：json = 单对象 `{response, stats, error}`；stream-json = JSONL 事件 `init`（session id/model）/`message`/`tool_use`/`tool_result`/`error`/`result`（聚合统计）。
- 退出码：0 成功 / 1 一般错误 / 42 输入错误 / 53 回合超限。
- `--approval-mode default|auto_edit|yolo|plan`（`-y` 已弃用）；`--model`（默认 auto）；`--allowed-mcp-server-names`；`--resume latest|<index>` + `--list-sessions`；`--sandbox`；`--skip-trust`；另有 `--experimental-acp`（ACP 模式，作为 stream-json 不稳时的**备选通道**，dsh 的 StdioJsonRpcClient 可复用）。
- MCP：`~/.gemini/settings.json` 的 `mcpServers`（trust/includeTools/excludeTools 字段 —— schema 细节 impl 时探针确认）；鉴权 `GEMINI_API_KEY` 环境变量或 OAuth（服务端无浏览器场景 impl 时确认 API key 路径）。

**GitHub Copilot CLI（github/copilot-cli，MIT 开源）** — docs.github.com 编程式运行/编程参考/命令参考：
- `copilot -p "prompt"` 运行即退出；stdin 管道亦可（与 -p 互斥）；`-s` 静默输出干净文本。
- `--output-format json`（JSONL，每行一个 JSON 对象，含 tool use/assistant message 等交互；行级 schema impl 时探针）。
- 工具授权：`--allow-tool='shell(npm:*), write'`（shell 命令通配/路径后缀）、`--allow-url`、`--allow-all-tools`、`--allow-all`（慎用）、**MCP server 按名授权**（`--allow-tool 'aw'` = 授权 aw 桥全部工具）、`--deny-tool`。
- `--no-ask-user`（防挂起）；`--model`（优先级：custom agent > `--model` > `COPILOT_MODEL` > settings.json > 默认）。
- 鉴权链：`COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`（服务端可直接用 PAT，无需浏览器）；**`COPILOT_HOME` 可按 agent 隔离配置目录**（默认 `~/.copilot`）；MCP 配置 `~/.copilot/mcp-config.json`。

**Crush（charmbracelet/crush，Go，FSL-1.1）** — README + issue #2412：
- 无头：`crush run --format json`（JSONL 事件：`step_start`/`text`/`step_finish`（含 cost/tokens）；即原 `opencode run --format json` 血统；事件缺 model 字段为已知 issue #2412）。
- **客户端/服务端架构**：`crush serve` + 多客户端（POST /v1/workspaces、SSE 事件流、IsBusy 状态）——若 run 模式无法满足 steer/审批，这是升级通道（impl 时探针后定，v1 先 run 模式）。
- MCP：stdio/http/sse 三传输 + 内置 OAuth 流 + sessionless 标记；配置解析序 `./.crushrc` → `./crushrc` → `~/.config/crush/crushrc`（crushrc 是带内建命令的 Bash 方言，跨平台一致；Windows 为 `%USERPROFILE%\.config\crush\crushrc`）。
- Provider：环境变量 ANTHROPIC/OPENAI/GEMINI/OPENROUTER/… + `provider add --type openai-compat --base-url --api-key` 自定义；安装：winget/scoop/npm `@charmland/crush`（Windows 原生 ✅）。

**Cursor CLI** — cursor.com/docs/cli/headless：
- `-p/--print` 非交互；**无 `--force`/`--yolo` 时只提出变更不落地**（天然安全档）。
- `--output-format text|json|stream-json`：stream-json 帧已确认（Claude Code 同构）：`{"type":"system","subtype":"init","model"}`、`{"type":"assistant","timestamp_ms","message":{"content":[{"text"}]}}`、`{"type":"tool_call","subtype":"started"|"completed","tool_call":{...}}`、`{"type":"result","duration_ms"}`；`--stream-partial-output` 追加增量 delta。
- 鉴权：`CURSOR_API_KEY` 环境变量（服务端友好）；Windows 安装器官方支持。
- MCP：`--mcp-config <file>` 标志；**已知风险**：社区报告 print 模式下 MCP 工具偶发不触发（版本相关，impl 时以探针验证，不行则 stderr tap 降级）。

**Goose（aaif-goose/goose，原 block/goose，Rust，MIT）** — 仓库 documentation/docs/tutorials/headless-goose.md + guides/running-tasks.md：
- `goose run -t "text"` / `--prompt-file` / `-i <file>` / `--recipe`；`--no-session`（一次性）或 `--name <n>` + `--resume`（会话延续）；`--with-builtin developer`。
- `--output-format text|json|stream-json`（json = 完成后完整 JSON；stream-json = 实时事件；行级 schema 从 Rust 源码 `crates/goose-cli/src/session` 探针）。
- 无头姿势：`GOOSE_MODE=auto`、`GOOSE_CONTEXT_STRATEGY=summarize`（上下文自动摘要 ✅）、`GOOSE_MAX_TURNS`、`GOOSE_DISABLE_SESSION_NAMING=true`；工具权限走"配置默认或安全失败"。
- MCP：`--with-extension`（临时加载，本轮用）或 config.yaml extensions（用户级）；Provider 走环境变量（如 ANTHROPIC_API_KEY + GOOSE_PROVIDER/GOOSE_MODEL）；Windows 原生 ✅。

**Qwen Code（QwenLM/qwen-code，Apache-2.0）** — 官方 CLI 文档 + 仓库 docs：
- 与 gemini-cli 同族但有关键差异：`--output-format json` 是**末尾一次性输出完整数组**（非流式）；`stream-json` 才是增量事件且与 `-p` 组合即无头；`--approval-mode yolo` 官方 e2e 自用。
- 配置 `~/.qwen/`（settings.json mcpServers 同 gemini 结构，impl 时确认）；另有实验性 `@qwen-code/sdk`（本轮不用，CLI 优先，理由同 codex 弃 exec --json）。

**Amazon Q CLI（aws/amazon-q-developer-cli，Rust，Apache-2.0）** — 源码级核实：
- `crates/chat-cli/src/cli/chat/mod.rs`：仅 `--no-interactive`（stdin 管道喂 prompt）+ `--trust-all-tools` + `--resume` bool；**全文件无 output_format/input_mode**（grep 零命中）→ 无结构化输出、无运行中审批。
- 结论：只能做"文本一次性 + MCP 工具"弱集成，达不到平台四要素（结构化事件/审批/增量），**列入观察名单**（官方 Kiro CLI 迁移指引 kiro.dev/docs/upgrade-guides/migrating-from-q 表明该产品线在重组，待稳定后重评）。计划附弱适配设计（§6.8）但不进实施队列。

## 4. 选型记录（ADR）

**Decision**：新增 7 引擎分两批（P0：claude/gemini/copilot/crush；P1：cursor/goose/qwen），共享"一次性 CLI 流式 JSON"基类 + claude 走 SDK 进程内特例；Amazon Q CLI 进观察名单。

**Drivers**（前三）：①用户要求"常用热门 + 功能全兼容"——三要素（无头/结构化/MCP）齐备的 7 个已覆盖 2026 年主流生态的绝大多数装机量；②平台契约七能力面的覆盖密度——claude(7/7)、gemini(6/7)、copilot(5/7)、crush(5/7+)、cursor(5/7)、goose(6/7)、qwen(6/7)，全部 ≥5；③维护成本——gemini/qwen 同族、cursor 帧格式与 Claude Code 同构、crush 与已集成的 opencode 同血统，族间复用率高。

**Alternatives considered**：
- **全量 8 个含 Amazon Q CLI**：否决——源码级确认无结构化输出，强行接入只能 stderr 抓文本，违背"错误即事件/usage 透出"两条平台底线；等官方 JSON 支持或 Kiro CLI 重组后重评。
- **gemini/qwen 走 `--experimental-acp`（复用 dsh 的 StdioJsonRpcClient）**：备选保留——ACP 有同轮 cancel/permission，理论能力面更全，但标注 experimental、协议面未承诺稳定；v1 用官方 stream-json 主路径（文档化 + 有退出码语义），探针失败时切换 ACP 通道（两通道共用同一个 impl 的传输层抽象）。
- **aider / OpenHands / Amp**：否决——aider 无 JSON 事件流（纯文本 + --yes）；OpenHands 主打容器化服务端非 CLI 嵌入；Amp 闭源且无公开无头协议。列 watchlist，不占实施预算。
- **claude 走 `claude -p --input-format stream-json` CLI 双流协议**：否决为主实现——SDK 是官方一等嵌入面（canUseTool/进程内 MCP/interrupt 回执都是 CLI 协议没有的），CLI 双流仅作 SDK 不可用时的降级开关（settings 可切 `claude_transport: 'sdk'|'cli'`）。

**Why chosen**：每引擎都落在"官方文档明示的稳定嵌入面"上；两批划分让第一批跑通基类与平台改造后，第二批（cursor/goose/qwen）成为近零边际成本的填表工作。

**Consequences**：HITL 仅 claude（canUseTool）与潜在 crush 有运行中审批，其余引擎走"预授权白名单"姿态（§6.0 策略映射）——这是引擎能力边界，不是平台缺陷，需在 UI 能力徽标与文档如实呈现（沿用 `capabilities` 机制）。

**Follow-ups**：Amazon Q/Kiro 重评；gemini ACP 通道切换开关；crush serve 通道（多客户端 SSE）若 run 模式探针不达标则升级为 P2。

## 5. 总体架构

```
                          HARNESS_REGISTRY（+7 条目）
                                   │ create()
        ┌──────────────────────────┼─────────────────────────────┐
        │                          │                             │
  ClaudeSdkAgentImpl        OneShotCliAgent（新共享基类）      （既有 6 impl 不动）
  （SDK 进程内，常驻）        spawn CLI → 逐行 JSON 事件 → 映射 AgentEvent
        │                          │
        │            ┌─────────────┼──────────────┬─────────────┐
        │         gemini/qwen   copilot        cursor/goose      crush
        │         （家族分叉）  （JSONL+allow-tool）（帧变体）   （crushrc+run --format json）
        │
        ├── canUseTool ──→ hitl-registry(kind:'claude-permission') ──→ respond.post ──→ respondHitl
        ├── createSdkMcpServer(AW 工具) 或 mcpServers:{aw:stdio 桥}  ──→ host-tool-bridge.dispatchHostTool
        └── getContextUsage() ──→ getContextStats

  OneShotCliAgent 每回合：
    spawn(引擎 CLI, args, env{AW_AGENT_ID/AW_AGENT_TOKEN/引擎鉴权 env}, cwd=工作区)
      → stdout 逐行 parse JSON → mapEvent() 模板方法（子类实现）→ AgentEvent 流
      → init 事件捕获 sessionId 存 impl 状态（resume 用）
      → exit 0 = done / 非 0 = error 事件（错误即事件）
    steer = 恒 'deferred'（邮箱语义，与 dsh 一致）
    abort = killHarnessProcess（进程树强杀，既有工具）
```

**关键设计点：环境变量携带 agent 身份，配置文件全局共享。**
所有被调研引擎的 stdio MCP 子进程默认继承父进程环境 → 在 CLI 进程上注入 `AW_AGENT_ID/AW_AGENT_TOKEN/AW_BASE_URL`（复用 `generateMcpBridgeEnv`），则**每个引擎自己的 MCP 子进程（aw 桥）自动带上正确的 agent 身份**，共享配置文件（gemini settings.json / copilot mcp-config.json / crushrc / goose config）无需按 agent 复制，彻底回避"每 agent 一份 HOME"的隔离难题。per-agent 的模型/provider 差异同样走 env 注入。

## 6. 详细设计

### 6.0 共享基类 `OneShotCliAgent`（新文件 `server/services/workshop/agents/adapters/one-shot-cli-agent.ts`）

从 omp/codex/dsh/opencode 四个 impl 中下沉共性后的第一个"事件流一次性 CLI"基类：

```
构造参数：{ harnessId, command, baseArgs, buildTurnArgs(request,state), authEnv(config), engineEnv(config),
           mapLine(line,state): AgentEvent[]|null, extractSessionId?(initObj), resultTimeoutMs }
```

- **run()**：`createAgentImplByHarness` 同款校验 → 组装 env（`generateMcpBridgeEnv` + `authEnv` + `engineEnv`）→ `spawnLineProcess`（复用 Windows shim）→ `registerHarnessProcess` 登记 → stdout readline 逐行 `JSON.parse`（容错：非 JSON 行进 `__stderr__` 缓冲用于错误报告）→ `mapLine` 映射为 AgentEvent（delta 50ms 合批沿用 omp 的批量算法）→ 进程退出：0→done、非 0→`{kind:'error', code:<ENGINE>_EXIT_<n>, message 含 stderr 尾部}`、spawn 失败→`HARNESS_NOT_CONFIGURED`。
- **steer()**：恒 `'deferred'`（一次性进程模型下同轮注入不存在；与 dsh 一致，消息保持 pending 下一轮携带）。
- **abort()**：`killHarnessProcess`（taskkill /T /F）+ 立即补发 done(interrupted)。
- **getProcessInfo/killProcess/reconcileProcess**：复用 `harness-process.ts`，`isProcessAlive` 校准。
- **getContextStats()**：从最近一次 `result`/usage 事件聚合 `{usedTokens, window, percent}`；窗口大小 per 引擎常量表（如 gemini 1M、copilot 未知→不报 percent 只报 used）。
- **onTurnSettled()**：对支持 GOOSE_CONTEXT_STRATEGY 类自动摘要的引擎透传 usage，不做主动 compact（claude 除外）。
- **resume**：`extractSessionId` 从 init/会话事件捕获 id，存内存状态（随 impl 生命周期）；`buildTurnArgs` 在有 sessionId 时追加 resume 参数。
- **会话级并发**：同一 agent 同时只允许一个回合进程（复用 omp 的回合互斥位模式）；排队由上层 mailbox 已有语义处理。

### 6.1 claude — `ClaudeSdkAgentImpl` 重写（现有 `claude-agent.ts:17` 48 行骨架替换，目标 ~500 行）

- 依赖：新增 npm 依赖 `@anthropic-ai/claude-agent-sdk`（package.json dependencies；SDK 自带 claude 二进制解析，无需 PATH 探测 → `probe: {inprocess: true}` + `harness.claude_sdk_installed` 探针（模块可 import 即可用））。
- **进程模型**：每 agent 一个常驻 SDK 会话（lazy `startup()` 预热，跨消息复用；`abortController` 挂 impl 状态），与 omp 的 lazy spawn 模式对齐。
- **run()**：
  - 首回合 `query({ prompt: stream, options })`，其中 prompt 为 **AsyncGenerator**：首次 yield `SDKUserMessage`（prompt-builder 渲染的 worker/peer/supervise 消息 + `x-aw-task-kind` 元数据放 message 内），生成器随后挂起等待 steer()。
  - `options`：`systemPrompt`（prompt-builder `contextPrefix()+systemManual()`）、`cwd`（工作区）、`env`（`generateMcpBridgeEnv`）、`permissionMode: config.permissionMode ?? 'default'`、`maxTurns`、`model`（config.provider/model，`setModel()` 热切）、`settingSources`（默认 `[]` 纯 SDK 态；`claude_inherit_user_settings: true` 时 `['user']` 复用本机 OAuth）、`includePartialMessages: true`（delta）、`mcpServers`（§工具注入）、`canUseTool`（§HITL）、`hooks.SessionStart`（记录 session id）。
  - 事件映射：`stream_event`→delta（50ms 合批）；`SDKAssistantMessage`→message/status；tool_use 块→🔧 status；`SDKResultMessage`→`subtype==='success'`→artifact+done（透出 `total_cost_usd/usage/num_turns`），`error_max_turns`/`error_during_execution`→error(CLAUDE_*)；`SDKCompactBoundaryMessage`→内部 compacting 状态清除；`is_error`→CLAUDE_RESULT_ERROR。
  - 中止：`abortController.abort()` + `query.interrupt()`（等 receipt），随后 Generator return。
- **steer()**：回合活跃时向流式生成器 `yield {type:'user', message:{role:'user',content:steerText}, parent_tool_use_id:null, session_id}`（同轮注入 → 返回 `'steer'` 并标消费）；非活跃 `'deferred'`。这是七引擎里第二个原生 steer（与 omp 并列）。
- **HITL**：`canUseTool(toolName, input)` → `registerApprovalHitl`（模式照抄 codex-agent.ts L598：kind 扩为 `'claude-permission'`，id=`claude-<requestId>`，payload 含 toolName/input 预览）→ `hitl-registry` → 前端铃标 → `respondHitl(decision)` → resolve `PermissionResult`：approve→`{behavior:'allow', updatedInput: input}`，reject→`{behavior:'deny', message:'<拒绝原因>', interrupt: false}`。超时策略沿用 `harnessSettings().hitl_timeout_ms`（默认 300s，超时 deny，fail-closed 与 codex/dsh 一致）。另用 `hooks.PreToolUse` 做工业工具族日志（对应 opslog 归属）。
- **工具注入（双通道，默认 A）**：
  - A（默认）：**进程内 SDK MCP server** —— `tool()`+`createSdkMcpServer()` 包装 `hostToolsForRole()` 的工具清单，tool handler 直接 `dispatchHostTool(ctx, {tool, args})`（同进程零回程，等价 omp `set_host_tools` 的直连模型）；`setMcpServers()` 支持角色变更后热换工具面。
  - B（`claude_bridge_transport: 'stdio'` 时）：`mcpServers: { aw: { type:'stdio', command: process.execPath, args:[resolveBridgePath()], env: generateMcpBridgeEnv(...) } }` —— 与 codex/dsh/opencode 完全同构，作为 A 的对拍/降级通道。
- **上下文**：`query.getContextUsage()` → `getContextStats()`；超过 0.7 阈值走 SDK 原生 auto-compact（`SDKCompactBoundaryMessage` 观测），不再自建 contextGate。
- **配置**（`OmpAgentConfig` 同构新接口 `ClaudeAgentConfig`）：`model/provider/permissionMode/maxTurns/apiKey(env ANTHROPIC_API_KEY 优先)/inheritUserSettings/bridgeTransport/effort(映射 thinking)`。

### 6.2 gemini — `GeminiAgentImpl`（新文件，继承 OneShotCliAgent，~250 行）

- spawn：`gemini -p <prompt> --output-format stream-json --approval-mode <config.approvalMode ?? 'default'> [--model m] [--resume <sid>]`；env：`GEMINI_API_KEY`（config.apiKey）+ `generateMcpBridgeEnv`。
- `mapLine`：`init`→记 sessionId + status(WORKING)；`message`（assistant 分块）→delta；`tool_use`→🔧 status；`tool_result`→status(完成)；`error`→内部累积；`result`→artifact+done（stats.tokens→usage）；退出码 42→GEMINI_INPUT_ERROR、53→GEMINI_TURN_LIMIT、其余非 0→GEMINI_EXIT。
- **MCP 注入**：首次初始化时确保 `<workspace>/.gemini/settings.json` 存在并合并写入：
  ```json
  { "mcpServers": { "aw": { "command": "<node>", "args": ["<aw-mcp-bridge.mjs>"], "trust": true } } }
  ```
  （trust=true 免确认——AW 工具是平台自有的可信面；写入采用"只增不改"合并策略保留用户已有 server；文件落 `.AgentWorkShop/harness-config/gemini/` 并通过 wrapper 或 settings 定位机制指过去 —— 定位机制见 §12 开放问题 Q1，兜底方案为 repo 根 `.gemini/settings.json` + `.gitignore`。）
- **工具授权姿态**：native shell/write 工具保持 `--approval-mode default`（无头下需要确认的操作由引擎拒绝，fail-safe）；AW 桥经 `--allowed-mcp-server-names aw` 显式白名单。yolo 模式仅作为 per-agent 显式配置项（默认关）。
- resume：init 事件 sessionId → 下一回合 `--resume <sid>`；`--list-sessions` 不用。
- probe：`command: 'gemini'` 走 `harnessSettings().gemini_command ?? 'gemini'`。

### 6.3 qwen — `QwenAgentImpl`（新文件，继承 GeminiAgentImpl 族 ~80 行）

- 继承 gemini 基类差异点覆写：command=`qwen`（`harnessSettings().qwen_command`）、env 鉴权（QWEN_API_KEY / OAuth —— impl 探针定）、MCP 配置目录 `~/.qwen/settings.json`、`--output-format` 恒 `stream-json`（**不用** json 单数组模式，事件增量必需）、模型目录 qwen3-coder 系。
- 其余（事件名/resume/审批语义）按 fork 假设复用 gemini 映射，探针阶段以 `_dbg-qwen-probe.mjs` 校验差异并落差异表。

### 6.4 copilot — `CopilotAgentImpl`（新文件，继承 OneShotCliAgent，~220 行）

- spawn：`copilot -p <prompt> --output-format json [--model m] --allow-tool aw [--allow-tool 'shell(...)'][--no-ask-user]`；env：`COPILOT_GITHUB_TOKEN`（config.token）+ `COPILOT_HOME=<.AgentWorkShop/harness-config/copilot/<agentId>>`（**官方 per-agent 目录**，内种子 `mcp-config.json`：aw 桥 stdio 条目）+ `generateMcpBridgeEnv`。
- `mapLine`：JSONL 行按 `type` 字段映射（行级 schema 探针确认后定稿：assistant→delta/tool_use→🔧/result→done；未知 type 忽略并计数上报）。
- **工具授权姿态**：默认 `--allow-tool aw`（仅授权 AW 桥）+ 可配置追加 `copilot_allow_tools`（如 `'shell(git:*), write'`）；`--no-ask-user` 默认开（服务端无人工）。
- usage/stats：探针确认 JSONL 是否含 token 字段；没有则 getContextStats 只报可用性为 false（不虚报）。
- probe：`copilot_command ?? 'copilot'`。

### 6.5 cursor — `CursorAgentImpl`（新文件，继承 OneShotCliAgent，~200 行）

- spawn：`cursor-agent -p <prompt> --output-format stream-json --stream-partial-output [--model m] [--mcp-config <aw.json>] [--force]`；env：`CURSOR_API_KEY` + `generateMcpBridgeEnv`。
- 帧映射（已确认形状）：`system/init`→sessionId+WORKING（.model→usage 元数据）；`assistant`+`--stream-partial-output`→delta；`tool_call started/completed`→🔧 status；`result`→done（duration_ms 透出）。
- **安全档**：`--force` 默认**关**（cursor 无 force 时只提出变更不落地——与平台"写控制/HITL 门控"哲学一致，写文件类任务在 cursor 上默认产出提案型工件）；per-agent 显式开。
- MCP：`--mcp-config` 指向 `.AgentWorkShop/harness-config/cursor/aw-mcp.json`（aw 桥 stdio 条目）；**探针必测 print 模式 MCP 触发**（已知社区报告偶发不触发，记录版本号；不达标则在文档标注降级 + stderr tap 观测工具调用）。
- probe：`cursor_command ?? 'cursor-agent'`。

### 6.6 crush — `CrushAgentImpl`（新文件，继承 OneShotCliAgent，~230 行）

- spawn：`crush run --format json "<prompt>"`（参数面探针：`run` 子命令确切标志）；env：provider key（config.provider 映射 ANTHROPIC/OPENAI/GEMINI/OPENROUTER… 环境变量表）+ `generateMcpBridgeEnv`。
- `mapLine`：`step_start`→status(WORKING)；`text`→delta；`step_finish`→artifact+done（cost/tokens→usage）。
- MCP：`.AgentWorkShop/harness-config/crush/crushrc`（含 aw 桥 stdio `mcp add` 等价条目）；crush 配置解析序 `./.crushrc` 优先 → spawn 时 cwd 即工作区，若工作区已有用户 crushrc 则采用 wrapper 注入 `HOME` 指向 per-agent 配置目录（唯一需要 HOME 隔离的引擎，探针确认是否有 `--config` 标志可免除）。
- 模型/provider：`config.model` → crushrc agent 段或 env；自定义 openai-compat provider 支持走 crushrc `provider add` 等价物（落配置文件）。
- **HITL 探针**：run 模式若输出权限请求类事件（opencode 血统，可能存在）→ 增补 `crush-permission` kind + respond 通道；探针阴性则 HITL=false，能力徽标如实显示。
- probe：`crush_command ?? 'crush'`（winget/scoop/npm 安装均覆盖）。

### 6.7 goose — `GooseAgentImpl`（新文件，继承 OneShotCliAgent，~230 行）

- spawn：`goose run -t <prompt> --output-format stream-json [--name aw-<agentId>] [--resume] --with-extension "<aw 桥 stdio 扩展配置>"`；env：`GOOSE_MODE=auto`、`GOOSE_CONTEXT_STRATEGY=summarize`、`GOOSE_MAX_TURNS=config.maxTurns ?? 50`、`GOOSE_DISABLE_SESSION_NAMING=true`、provider key env + `generateMcpBridgeEnv`。
- `mapLine`：stream-json 事件（schema 自 Rust 源码 `crates/goose-cli/src/session` 探针）→ delta/🔧/done；`--output-format json` 不用（非流式）。
- 会话：`--name` 固定 per-agent 会话名 → `--resume` 续接（跨回合上下文）。
- 工具授权姿态：headless 官方语义即"配置默认或安全失败"；AW 扩展经 `--with-extension` 显式注入，native 工具按 goose 默认。
- probe：`goose_command ?? 'goose'`。

### 6.8 （观察名单）Amazon Q CLI 弱适配设计（不实施，留档）

`q chat --no-interactive --trust-all-tools -p <prompt>`（stdin 管道）→ stdout 纯文本聚合为单个 artifact，无 delta/usage/HITL/resume 参数化；仅当未来官方提供 JSON 输出或 Kiro CLI 继承该面时升级。

### 6.9 平台面改造清单

| 文件 | 改动 |
|---|---|
| `server/services/workshop/agents/registry.ts` | +7 `HarnessDef` 条目（capabilities 按下表如实填写；probe 按 §6.x） |
| `server/services/workshop/agents/adapters/one-shot-cli-agent.ts` | **新增**共享基类 |
| `server/services/workshop/agents/claude-agent.ts` | 骨架 → 全量实现 |
| `server/services/workshop/agents/{gemini,qwen,copilot,cursor,crush,goose}-agent.ts` | **新增** 6 个 impl |
| `server/services/workshop/agents/harness-models.ts` | +7 目录条目：gemini/qwen=静态表（gemini: gemini-2.x/3 系 auto；qwen: qwen3-coder-plus 等官方目录）；copilot/cursor/crush/goose=静态表 + config 覆盖；claude=`supportedModels()` 动态 + 静态兜底 |
| `server/services/workshop/settings.ts` + `schema.json` | +`harness.{claude,gemini,qwen,copilot,cursor,crush,goose}_command`；+`harness.hitl_timeout_ms` 复用；claude 专组 `harness.claude_*`（bridgeTransport/permissionMode/inheritUserSettings） |
| `shared/workshop-protocol.ts:126` + `hitl/respond.post.ts` | kind 联合 +`claude-permission`（+探针后可能 +`crush-permission`）；RESPONDABLE_KINDS 路由 → `manager.respondHarnessHitl`（机制零改动，纯扩枚举） |
| `server/harness/aw-mcp-bridge.mjs` | 不动（env 身份设计使其天然支持全部新引擎） |
| 前端 `app/pages/settings.vue` / `agents.vue` / `teams.vue` / `channel-templates.vue` | 引擎命令配置项 +7（settings 页）；下拉/徽标由 `harnessMetas()` 自动派生（须验证无残留硬编码列表——2026-09-05 计划 P0 已收编，本轮核对） |
| i18n `i18n/dicts/*.json` | 引擎 label/notInstalled 等词条中英双语 |
| `docs/site/{,en/}guide/` | 新增/更新 harness 集成指南（每引擎：安装、鉴权 env、能力矩阵、已知限制） |
| `.gitignore` | +`.gemini/settings.json`(工作区运行时)/`.crushrc` 等 harness 运行时配置产物（若落 repo 根兜底方案） |
| `package.json` | +`@anthropic-ai/claude-agent-sdk` |

### 6.10 能力矩阵（写入 registry `capabilities` 的口径，如实申报）

| 能力 | claude | gemini | qwen | copilot | cursor | crush | goose |
|---|---|---|---|---|---|---|---|
| steer 同轮 | ✅ 流式输入 | ❌ deferred | ❌ | ❌ | ❌ | ⚠️探针 | ❌ |
| supervise | ✅（run 层复用共享 supervisePrompt 轮次）同左 | 同左 | 同左 | 同左 | 同左 | 同左 | 同左 |
| hitl | ✅ canUseTool | ❌ | ❌ | ❌ | ❌ | ⚠️探针 | ❌ |
| terminal | ❌（无 UI 终端） | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| contextStats | ✅ getContextUsage | ✅ stats | ✅ | ⚠️探针 | ⚠️result | ✅ step_finish | ✅ |
| compact | ✅ auto+boundary | ⚠️ 原生 | ⚠️ | ❌ | ❌ | ⚠️ | ✅ GOOSE_CONTEXT_STRATEGY |

（"无 HITL"引擎的安全姿态：AW 桥工具为平台可信面显式白名单；引擎 native 写/执行工具保持各引擎最保守档——gemini `--approval-mode default`、copilot 仅 `--allow-tool aw`、cursor 无 `--force`、goose headless fail-safe。写文件/执行类高危操作在这些引擎上**默认不发生**，而非静默放行。）

## 7. 实施步骤

**Phase 0 — 基座与探针（先行，1 个提交单元）**
1. 新增 `adapters/one-shot-cli-agent.ts` 共享基类（从 omp-agent.ts 抽 delta 合批/回合互斥位，从 dsh-agent.ts 对齐 deferred steer 语义）。
2. 新增 7 个探针脚本 `scripts/_dbg-{claude,gemini,qwen,copilot,cursor,crush,goose}-probe.mjs`：裸协议冒烟（spawn→首事件→done），逐一确认 §12 开放问题，输出差异表回填 impl。
3. registry +7 条目（capability 先按本表初稿，探针后修正）、settings/schema 扩展、harness-models 静态目录 —— 前端下拉/可用性面板即刻可见（装了 CLI 的引擎亮绿灯）。
4. 单测：`scripts/test-one-shot-cli-agent.ts`（假 CLI：node -e 输出预制 JSONL，断言事件映射/退出码/abort/HITL 超时 fail-closed）。

**Phase 1 — P0 四引擎（每引擎一个提交单元，顺序：gemini → copilot → crush → claude）**
5. gemini（最小族代表，验证基类）→ 6. copilot（COPILOT_HOME 隔离样本）→ 7. crush（provider 矩阵/HITL 探针收口）→ 8. claude（SDK 特例，无基类依赖，最后做因其体量最大）。
9. 每引擎完成即跑 `scripts/e2e-multi-harness.ts <engine>`（§10）。

**Phase 2 — P1 三引擎（家族复用，快速跟进）**
10. qwen（gemini 子类差异表）→ 11. goose（--with-extension/会话名）→ 12. cursor（帧映射 + MCP print 探针结论落文档）。

**Phase 3 — 平台收尾**
13. HITL kind 扩枚举接线（claude-permission 必做；crush 视探针）+ 前端铃标验证。
14. harness-availability：`scripts/_dbg-harness-e2e.mjs` 扩新 id 断言（unknown/unavailable/available 三态）。
15. harness-models：`scripts/e2e-harness-provider-task.mjs` 扩 7 引擎 provider 校验。
16. 文档 + i18n + CHANGELOG + 版本号（沿用 0.7.x，目标 0.8.0——引擎数翻倍属 minor 级特性）。

**Phase 4 — 真实场景验收**
17. `scripts/e2e-real-scenario.mjs` 扩展：真实 dev server + gemini/copilot 成员班组 + 产线数采数控全链路（对齐 2e23fc8 的验收标准：HITL 批准后 PLC 读回、超时自动拒绝值不污染）。
18. UI e2e：`scripts/_dbg-harness-ui-e2e.py` 参数化 EXPECT 新引擎（下拉可见/未安装灰化/设置页命令项）。

## 8. 测试计划

| 层 | 载体 | 断言要点 |
|---|---|---|
| 单测 | `scripts/test-one-shot-cli-agent.ts`（假 CLI 子进程，无外部依赖） | 事件映射表/退出码→错误事件/abort 杀树/delta 合批/会话 id 捕获/双回合 resume 参数/HITL 超时 deny |
| 协议探针 | `scripts/_dbg-{engine}-probe.mjs` | 每引擎 spawn→结构化事件≥1→退出码语义；**一次性脚本，产出差异表回填 impl 后归档** |
| 引擎 e2e | `scripts/e2e-multi-harness.ts [engine]` 扩 PLANS | 场景 A 工具闭环：engine 调 AW host tool（report_progress→complete_task）经 MCP 桥→HTTP 回程→共享桥落库；场景 B HITL（仅 claude/crush 视探针）：注册→铃标快照→respond→回合继续；凭据 401 自动 SKIP（沿用既有机制） |
| 可用性 | `scripts/_dbg-harness-e2e.mjs` 扩断言 | 7 新 id：未装→409 文案/装了→resolvedPath；`?refresh=1` 跳缓存；settings 热改 command 联动 |
| 模型目录 | `scripts/e2e-harness-provider-task.mjs` | `/harnesses/{id}/providers` 200 + 非空 + channel 成员 llm_json PATCH 生效 |
| UI | `scripts/_dbg-harness-ui-e2e.py` | 下拉含新引擎/未安装灰化+「未安装」后缀/设置页命令字段/i18n 双语 |
| 真实场景 | `scripts/e2e-real-scenario.mjs` 扩 | gemini 或 copilot 成员完成 lead→worker 派发→数采→完成汇报全链路（有凭据时；无则 SKIP 并报告） |
| 回归 | 既有 e2e 全量 | omp/codex/dsh/opencode 四引擎 e2e 全绿（证明平台面改动无回归）；`test-agent-runtime.ts`/`test-harness-liveness.ts` 不变绿 |

## 9. 验收标准（全部可测）

1. `GET /api/workshop/harnesses` 返回 13 个 id（6 既有 + 7 新），每个新引擎含 available/inprocess/command/resolvedPath 字段且 30s 缓存 + `?refresh=1` 生效。
2. 7 个新引擎在本机（Windows）`scripts/e2e-multi-harness.ts <id>` 场景 A 全绿或因**凭据缺失**显式 SKIP；不允许其它失败形态。
3. claude 引擎：场景 B HITL 全绿 —— canUseTool 触发 → `/api/workshop/hitl/pending` 可见 → respond allow → 回合继续至 done；超时 300s 自动 deny（测试中以 1s 超时配置验证 fail-closed）。
4. 七能力面声明与实测一致：抽查 claude(steer=同轮生效)、gemini(steer 恒 deferred 且消息不丢——pending 轮询查空回归不出现)、cursor(默认无 --force 时工作区文件 mtime 不变)。
5. 七入口强校验对未安装新引擎返回 409 HARNESS_UNAVAILABLE（manager.ts 7 调用点抽样 ≥3 实测）。
6. 无回归：既有 4 引擎 e2e + `test-agent-runtime` + `test-harness-liveness` 全绿。
7. 前端：agents/teams/channel-templates 下拉展示 13 引擎（i18n 双语），未装引擎灰化；设置页可配置 7 个新命令项且探测联动（4s 传播窗口实测）。
8. 文档站：新增引擎指南页（中英）包含安装/鉴权/能力矩阵/已知限制四节。
9. Amazon Q CLI 不在 harnesses 列表中（观察名单不占注册表），决策记录在本文档 §4。

## 10. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 引擎事件 schema 漂移（gemini/cursor/goose 均在快速迭代期，行级 schema 文档化程度不一） | 高 | 探针脚本一次性锁版本行为 + impl 内解析器对未知事件**忽略并计数上报**（不崩）；差异表落在文档；版本 pin 建议（package engines 字段提示最低版本） |
| Cursor print 模式 MCP 偶发不触发（社区已知） | 中 | 探针先行；不达标则该引擎 host tools 降级标注 + stderr tap 只读观测；不阻塞引擎本身 |
| 无 HITL 引擎的误操作面（yolo 类模式滥用） | 中 | 默认档全部最保守（§6.10）；yolo/force 仅 per-agent 显式配置 + UI 警示徽标；工业工具族不受影响（走 AW 桥白名单，写控制门控在平台侧不依赖引擎） |
| claude SDK 闭源面 API 变更 | 中 | 接口面全走官方类型；CLI 双流协议作 `claude_transport` 降级开关；SDK 版本 pin + CHANGELOG 关注 |
| crush FSL 许可证（非 OSI） | 低 | 平台仅以子进程方式调用用户自行安装的 CLI，不分发不链接其代码，无衍生作品问题；文档注明 |
| 并发同引擎多 agent 会话串扰 | 中 | §5 环境身份设计使配置可共享；会话 id 按 impl 状态隔离；goose 用 per-agent `--name`；copilot 用 per-agent COPILOT_HOME |
| 凭据不可得导致 e2e 不可复现 | 低 | 既有 401-SKIP 机制沿用；探针/单测层无凭据可全绿 |
| Windows `.cmd` shim（gemini/qwen/copilot npm 安装） | 低 | 既有 `line-spawn` 全覆盖（本仓库已实战） |
| git 并行会话卷走提交 | 低 | 每提交单元 pathspec 限定 + 提交后核对（仓库既有纪律） |

## 11. 开放问题（Phase 0 探针清单，结论回填本节）

- Q1 gemini/qwen：settings.json 定位能否脱离 `~/.gemini`（GEMINI_CLI_HOME 类 env 是否存在）；`mcpServers.trust` 字段确切名；headless+default 档下需确认操作的行为（拒绝 or 挂起）。
- Q2 gemini：服务端（无浏览器）鉴权路径 GEMINI_API_KEY 直连 vs OAuth；`stream-json` 每事件完整字段。
- Q3 qwen：QWEN_API_KEY / OAuth 设备码 / 配置目录 env；与 gemini 事件名差异表。
- Q4 copilot：`--output-format json` 行级 schema；会话延续标志（--continue/--resume?）；token 用量是否出现在 JSONL。
- Q5 cursor：resume/session 标志；-p 模式 MCP 触发率；`--model` 取值表。
- Q6 crush：run 子命令确切参数；权限请求事件存在性；`--config` 标志存在性（决定 HOME 隔离是否必要）；provider 环境变量全表。
- Q7 goose：stream-json 事件 schema（Rust 源码）；config 目录 override env；`--with-extension` 内嵌 MCP 的 env 继承验证。
- Q8 claude：SDK 当前 permissionMode 取值全集；`CLAUDE_CONFIG_DIR` 隔离；supportedModels() 返回形状。

## 12. 验证步骤（实施完成后的整机走查）

1. `npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-one-shot-cli-agent.ts` → 全绿。
2. 7×`scripts/e2e-multi-harness.ts <engine>` → 绿或凭据 SKIP。
3. 既有 4 引擎 e2e + runtime/liveness 单测 → 全绿（回归门）。
4. `node scripts/_dbg-harness-e2e.mjs` → 26+新断言全绿。
5. `python scripts/_dbg-harness-ui-e2e.py`（AW_BASE 指向 dev server）→ 下拉/灰化/设置项全过。
6. `scripts/e2e-real-scenario.mjs --harness gemini`（或 copilot，视本机凭据）→ 产线闭环报告。
7. 生产包冒烟：`npm pack` 产物在干净目录 `aw start` → setup → 建班组（新引擎成员）→ 派发 → 完成（对齐 0.7.8 首启纪律；避开 3000/3001 探针端口）。

## 13. 证据附录（2026-09 调研 URL）

- Claude Agent SDK TS 参考：https://code.claude.com/docs/en/agent-sdk/typescript
- Gemini CLI headless / CLI 参考：https://github.com/google-gemini/gemini-cli （docs/cli/headless.md、docs/cli/cli-reference.md）
- GitHub Copilot CLI：https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically ；…/cli-programmatic-reference ；…/copilot-cli-reference/cli-command-reference
- Crush：https://github.com/charmbracelet/crush （README；issue #2412 headless JSON 事件）
- Cursor CLI：https://cursor.com/docs/cli/headless
- Goose：https://github.com/aaif-goose/goose （documentation/docs/tutorials/headless-goose.md、guides/running-tasks.md）
- Qwen Code：https://qwenlm-qwen-code.mintlify.app/cli/overview ；https://github.com/QwenLM/qwen-code （docs/users/configuration/settings.md）
- Amazon Q CLI（源码核实）：https://github.com/aws/amazon-q-developer-cli （crates/chat-cli/src/cli/chat/mod.rs）；Kiro 迁移 https://kiro.dev/docs/upgrade-guides/migrating-from-q/

---

### 计划变更日志

- 2026-09-09 初稿：选型 7+1、两阶段批次、OneShotCliAgent 基类 + claude SDK 特例架构、env 携带身份方案、能力矩阵与验收标准定稿。
- 2026-09-09 实施回填（Phase 0-2 完成，e2e 实测）：
  - **开放问题全部关闭**（§11→实测结论）：
    - Q2 gemini：本机 0.51.0 实测 stream-json 帧形 `{type:init|message|tool_use|result}`；headless 需 `GEMINI_CLI_TRUST_WORKSPACE=true`；鉴权仅 Google 面（GEMINI_API_KEY 打到 Google API），**无自定义网关面 → LLM 实测按预期 SKIP**。
    - Q3 qwen：0.0.6 无 `--output-format`，改走 `--experimental-acp`（旧版 zed ACP：`sendUserMessage{chunks:[{text}]}`/`streamAssistantMessageChunk`/`requestToolCallConfirmation`）；模型经 **`OPENAI_MODEL` env**（-m 在 acp 路径不生效）；鉴权 selectedAuthType=openai + OPENAI_API_KEY/OPENAI_BASE_URL；HITL=toolConfirmation ✓。
    - Q4 copilot：`--output-format text|json(JSONL)` 实测帧 `session.*` 类型；MCP 经 `--additional-mcp-config`/`~/.copilot/mcp-config.json`；鉴权 GitHub 锁定 → LLM 实测 SKIP 有因。
    - Q5 cursor：本机 2026.09.08，命令名 `agent`/`cursor-agent.cmd`（装于 %LOCALAPPDATA%\cursor-agent）；无效 key 报 "API key is invalid"；MCP 经 `--mcp-config`。
    - Q6 crush：v0.92 **移除了 run --format json**（相对 2026-03 回归）→ 改为 `run -q` 纯文本一次性（基座 plainTextStdout 模式）；crushrc 的 model 子命令是 `add/large/small`；npm 包 .cmd shim 可能损坏 → `crush_command` 指包内 `bin/crush.exe`；智谱 openai-compat provider + `${AW_CRUSH_API_KEY}` env 引用实测可用；MCP 在 run 模式自动放行 ✓。
    - Q7 goose：1.50.0 stream-json 帧 `{type:message,message.content[]}`+`{type:complete,total_tokens}`；prompt 必须 `-t`（位置参数被拒 exit 2）；OPENAI_HOST(带 scheme)+OPENAI_BASE_PATH 拼接；MCP 走 `--with-extension` 实测工具注册 ✓。
    - Q8 claude：SDK 0.3.266（query/startup/createSdkMcpServer/interrupt/getContextUsage）；智谱 Anthropic 兼容端点 `https://open.bigmodel.cn/api/anthropic` + ANTHROPIC_AUTH_TOKEN + glm-5.3-flash 实测全绿。
  - **实施修正**：子类必须显式 `super(config, spec)`（空子类隐式构造器丢 spec → 全部静默失败，已修四个）；promptDelivery=arg 时基座仍需关闭 stdin（crush 等 stdin EOF 否则挂起，已修）；基座新增 `plainTextStdout`/`promptArgFlag` 两个 spec 面。
  - **e2e 实测**（scripts/e2e-multi-harness.ts，真实子进程+真实 LLM=智谱 glm-5.3-flash）：**claude ✓ 全绿**（MCP 工具闭环 progress=100 + canUseTool→HITL Write 批准）、**qwen ✓ 全绿**（工具闭环 progress=100 + HITL 任务 COMPLETED；偶发 glm 推理 wander 超时,重跑即绿）、**goose ✓ 全绿**（工具闭环 progress=100）、**crush ✓ 全绿**（工具闭环 progress=100）、**copilot ✓ 全绿**（本机缓存 GitHub 登录,LLM 走 GitHub 侧模型,工具闭环 progress=100）、cursor 装配 ✓+有因 SKIP、gemini 有因 SKIP（协议/鉴权锁定,管线验证通过）。回归:codex ✓ opencode ✓ 全绿;dsh 管线验证通（用户 DeepSeek 账户 Insufficient Balance 属既有计费问题,ustc 网关无 key）;单测 runtime/liveness ALL PASS;可用性 12/12 available。Amazon Q CLI 维持观察名单。

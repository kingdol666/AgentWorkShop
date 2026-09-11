# 多 Harness Agent 团队

一个 `AgentInterface` 契约之下,**十四个执行引擎**可互换 —— 平台不关心 Agent 由谁驱动,
只按接入形态分三类:

| 接入形态 | 引擎 | 形态说明 |
|---|---|---|
| 进程内 | `mock` / `claude` | 无外部 CLI:`mock` 是进程内剧本引擎,`claude` 是 Agent SDK 常驻会话(SDK 依赖动态 import,缺失时报 `HARNESS_NOT_CONFIGURED`) |
| 常驻会话(协议) | `omp` / `codex` / `dsh` / `qwen` / `hermes` / `opencode` | 每 Agent 一个长活子进程:`omp` = stdio RPC、`codex` = app-server JSON-RPC、`dsh` / `qwen` / `hermes` = ACP、`opencode` = serve + HTTP/SSE |
| 无头 CLI(结构化事件流) | `gemini` / `copilot` / `cursor` / `crush` / `goose` / `pi` | 每回合 spawn 一个一次性进程,靠引擎自身 session id 续接:`gemini` / `cursor` = stream-json、`copilot` = JSONL、`crush` = `run -q`、`goose` = stream-json、`pi` = `-p --mode json` |

`qwen`(`qwen --experimental-acp`,旧版 Zed ACP)与 `hermes`(`hermes acp`,标准 ACP v1)
都是**常驻 ACP 会话**,不是无头 CLI 家族 —— 它们与 `dsh` 同型,审批走
`session/request_permission` / `requestToolCallConfirmation`。

## 每频道选择引擎与模型

- 频道级设定 **harness → provider → model(+effort)** 三元组,从引擎官方目录实时选择
  (如 omp 上 `zhipu-coding-plan/glm-5.3-flash`、dsh 上 `ustc/glm-5.3-flash`);
- 成员默认继承,也可逐成员覆盖 —— **一个团队混用多种引擎是一等公民配置**;
- 每个 harness 有独立能力面(steer / lead 调度 / HITL / 终端镜像 / 上下文统计 / 压缩),
  前端徽标如实展示。

## 引擎接入面一览(2026-09 实测)

### 进程内

| 引擎 | 集成面 | 自定义 provider | 同轮 steer | HITL 程序化审批 | 实测(e2e-multi-harness) |
|---|---|---|---|---|---|
| mock | 进程内剧本(无 LLM) | — | ✅ | — | 联调用(无外部依赖全链路) |
| claude | Agent SDK 进程内常驻会话(`query()` + AsyncIterable 流式输入) | ✅(ANTHROPIC_BASE_URL 网关,智谱 Anthropic 兼容实测) | ✅ 流式输入 | ✅ canUseTool | ✅ 全绿 |

### 常驻会话(协议)

| 引擎 | 集成面 | 自定义 provider | 同轮 steer | HITL 程序化审批 | 实测(e2e-multi-harness) |
|---|---|---|---|---|---|
| omp | `omp --mode rpc` 常驻子进程(自有 RPC 协议) | ✅ | ✅ 原生同轮注入 | ✅ extension_ui | ✅ 全绿 |
| codex | `codex app-server` NDJSON JSON-RPC v2 | ✅(config.toml 网关) | ✅ turn/steer | ✅ requestApproval | ✅ 全绿 |
| dsh | `dsh --profile acp` 标准 ACP v1 | ✅(DEEPSEEK_BASE_URL) | ❌ deferred | ✅ session/request_permission | ✅ 全绿 |
| qwen | `qwen --experimental-acp`(旧版 Zed ACP) | ✅(OPENAI_BASE_URL / OPENAI_MODEL,智谱 OpenAI 兼容实测) | ❌ deferred | ✅ requestToolCallConfirmation | ✅ 全绿 |
| hermes | `hermes acp` 标准 ACP v1(与 dsh 同型) | ✅(zai provider 接 GLM;HERMES_PROVIDER / HERMES_MODEL) | ❌ deferred | ✅ session/request_permission | 场景已就位(真实子进程 + 真实 LLM;凭据缺失自动 SKIP 有因) |
| opencode | `opencode serve` + HTTP API + 全局 SSE | ✅(models.dev) | ✅ admission | ✅ permission API | ✅ 全绿 |

### 无头 CLI(结构化事件流)

| 引擎 | 集成面 | 自定义 provider | 同轮 steer | HITL 程序化审批 | 实测(e2e-multi-harness) |
|---|---|---|---|---|---|
| gemini | `-p --output-format stream-json` | ❌ Google 鉴权锁定 | ❌ | ❌(--approval-mode 策略制) | 管线 ✅ / LLM 需原生凭据(SKIP 有因) |
| copilot | `-p --output-format json`(JSONL) | ❌ GitHub 鉴权锁定 | ❌ | ❌(--allow-tool 白名单制) | 管线 ✅ / LLM 需原生凭据(SKIP 有因) |
| cursor | `-p --output-format stream-json` | ❌ Cursor 账号锁定 | ❌ | ❌(默认无 --force,变更只提案) | 管线 ✅ / LLM 需原生凭据(SKIP 有因) |
| crush | `run -q`(文本一次性) | ✅(crushrc openai-compat,api_key 引 env,智谱实测) | ❌ deferred | ❌ | ✅ 全绿(工具闭环 progress=100) |
| goose | `run --output-format stream-json` | ✅(OPENAI_HOST / OPENAI_BASE_PATH,智谱实测) | ❌ deferred | ❌ 预授权姿态 | ✅ 全绿(工具闭环 progress=100) |
| pi | `pi -p --mode json`(JSONL;prompt 经 `@临时文件` 投递) | ✅(`--provider/--model` + `~/.pi/agent/models.json`) | ❌ | ❌ | 场景已就位(真实子进程 + 真实 LLM;凭据缺失自动 SKIP 有因) |

无 HITL 引擎的安全姿态:AW 桥工具为平台可信面显式白名单;引擎 native 写/执行工具
保持各引擎最保守档(gemini `--approval-mode default`、copilot 仅 `--allow-tool aw`、
cursor 默认不 `--force`、goose headless fail-safe)—— 高危操作默认不发生,而非静默放行。

## 引擎安装与凭据(运行时配置,不落源码)

- 全部引擎可用性由 `GET /api/workshop/harnesses` 探测;**其中 11 个引擎**的命令可用
  `harness.<engine>_command` 设置覆盖(设置页运行时组):`opencode` / `codex` / `dsh` /
  `gemini` / `qwen` / `copilot` / `cursor` / `crush` / `goose` / `pi` / `hermes`;
- 三个例外:**`omp` 没有同名设置**(其探测命令是字面量 `omp`),**`mock` 与 `claude`**
  声明 `probe: { inprocess: true }` 的进程内引擎,根本没有外部命令可覆盖;
- **Windows npm shim 已知坑**:crush 的 npm 包 `.cmd` shim 可能损坏(指向缺失的
  run-crush.js),设置 `crush_command` 指向包内 `bin/crush.exe` 直启即可;
- 各引擎凭据走引擎原生机制:claude=`ANTHROPIC_AUTH_TOKEN`、qwen=`OPENAI_API_KEY`、
  goose=`OPENAI_API_KEY`、crush=`AW_CRUSH_API_KEY`(crushrc 引用)、
  pi=`--provider/--model` + `~/.pi/agent/models.json`(apiKey 透传)、
  hermes=`GLM_API_KEY`(zai provider)与 `HERMES_PROVIDER` / `HERMES_MODEL`、
  codex/dsh/opencode=各自登录或网关配置。

## 环境可用性检查

- `GET /api/workshop/harnesses` 返回每引擎 `available`(PATH 探测外部 CLI,
  进程内引擎恒可用)、`command`、`resolvedPath`、`error`;
- 前端下拉**禁用未安装引擎**并标注「未安装」;仪表盘「执行引擎」面板显示就绪度;
- 执行前强校验:模板/实例/任务七处入口统一 `assertHarnessUsable` ——
  未知引擎 400 `UNKNOWN_HARNESS`,未安装 409 `HARNESS_UNAVAILABLE`(人话报错)。

## 已验证的多引擎并行

`scripts/_dbg-multiharness-live-e2e.mjs`(对生产实例)多引擎并行,各自独立 Channel
在真实 Modbus 产线上完成专属场景;`scripts/e2e-multi-harness.ts [engine]` 覆盖上表
12 个外部引擎的工具闭环场景(有程序化审批面的引擎再跑 HITL 场景),真实子进程 + 真实 LLM,
凭据缺失自动 SKIP。

## LLM 供应商配置

频道级 `llm`(provider/model/effort)在频道设置页选择;各引擎的供应商目录
`GET /api/workshop/harnesses/:harness/providers`。成员未显式指定时继承频道默认。

# 运行引擎与原生模型（Harness / Native Model）

**状态**：已实现（2026-11-26）。适用于 Agent 模板、频道成员、manual session 的 runtime 实例。

## 一句话

平台不替 harness 编造模型清单：每个引擎的原生目录由 `harnessModelCatalog()`
现取现用；用户可以在**模板创建期**或**单个 runtime 实例**上选择该引擎支持的
provider / model / effort，模板不被改写，实例可随时改。

## 各引擎的原生来源与可设字段

| harness | 模型目录来源 | provider | model | effort（原生键） |
| --- | --- | --- | --- | --- |
| `omp` | `omp models list`（provider 分组 + thinking 列） | ✅ | ✅ | ✅ `thinkingLevel` |
| `codex` | `codex app-server` → `model/list`（provider 由用户 `config.toml` 决定） | ❌ | ✅ | ✅ `model_reasoning_effort` |
| `opencode` | `opencode models`（`provider/model`） | ✅ | ✅（自动归一为 `provider/model`） | ✅ `variant`（自由串） |
| `dsh` | 内置 `deepseek-official` + `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers` | ✅ | ✅ | ❌ |
| `claude` | 静态 glm 目录（走 `ANTHROPIC_BASE_URL` 网关） | ❌ | ✅ | ❌ |
| `gemini` / `qwen` / `copilot` / `cursor` / `crush` / `goose` | 静态 glm 目录 | ❌ | ✅ | ❌ |
| `pi` | 静态 glm 目录（实际 provider 由 `~/.pi/agent/models.json` 决定） | ✅ | ✅ | ✅ `thinking` |
| `hermes` | 静态 glm 目录（`config.yaml` 的 zai provider） | ✅ | ✅ | ❌ |
| `mock` | 无（进程内测试引擎） | ❌ | ❌ | ❌ |

`GET /api/workshop/harnesses` 的每一项都带 `profile: { provider, model, effort }`，
前端据此显示/隐藏控件；`GET /api/workshop/harnesses/:id/providers` 返回该引擎的
实时目录（5 分钟缓存）。没有目录面的引擎（`providers.length === 0`）允许自由串
model，但仍受 harness 支持矩阵约束。

## 创建期（模板 / 成员）

- Agent 模板：`POST/PATCH /api/workshop/agents` 接受 `harness` + `config`。
  前端 `AgentTemplateEditModal` 的「运行模型」区把 provider/model/effort 写回
  `configJson`；保存时 `applyProfileToConfig()` 做结构校验并把 effort 归一为
  目标引擎的原生别名。
- 添加成员：`POST /api/workshop/channels/:id/agents` 的 `harness` + `config`
  走同一套校验（`insertChannelAgent → applyProfileToConfig`）。
- 编辑成员：`PATCH /api/workshop/channels/:id/agents/:agentId` 现在接受 `harness`；
  变更前用 `validateMemberHarnessChange()` 对既有 config + AgentPrefab profile
  做 dry-run，失败不落库。
- 频道模板的 `lead.harness` / `members[].inline.harness` 仍按原路径生效；
  内联成员创建走 `createAgent`，因此同样受结构校验。

## 运行期（单个 session 实例）

见 `docs/design/session-runtime-overrides.md`。要点：`harness` 与
`provider/model/effort` 都是会话覆盖字段，`''` 表示“不指定（清除继承）”，
保存后在下一回合消息入口热切换；目标引擎的目录与已绑定 Prefab profile 都会
在写库前预检。

## LM Studio / LM Link 远程模型

- `omp models list` 只反映**已下载/已配置**的模型；LM Link 的实例别名（如
  `qwen3.5-9b-...:2`）不会出现在目录里。直接让 runtime 使用一个 omp 不认识的
  `provider/model` 会在 `set_model` 被拒绝并回落到 omp 默认模型。
- 使用远程模型的正确做法：在 `~/.omp/agent/models.yml` 的 LM Studio provider
  （通常 id 为 `local`，`baseUrl: http://127.0.0.1:1234/v1`）下显式列出远程
  `id` 与 `contextWindow`；或者让远程实例以**基础 id** 加载。平台目录取
  `omp models list`，配置完成后模型会出现在对应 provider 下。
- provider 必须与 omp 配置一致：本次实测 qwen 基础 id 在 `lm-studio`（omp 自动发现），
  远程 gemma 在 `local`（models.yml 显式列出）。切换模型时 provider/model 要成对改。
- 远程模型的上下文由**远端加载配置**决定；平台提示词可能超过其 context（如 8192），
  此时应在远端以更大 context 重载模型，而不是把错误归因于平台。

## 边界

- 目录探测命令是全局的（`omp` / `codex` / `opencode` / `~/.dsh`），不读取实例级
  `config.command`、`codexHome`、`dshHome`。
- `config.env` 平台范围内仍未消费；不要把它当作模型配置入口。
- 修改 harness 会重建 harness 进程，引擎侧会话连续性重置（UI 明确提示）。
- 所有校验 fail-closed；不支持的值不会被静默丢弃。

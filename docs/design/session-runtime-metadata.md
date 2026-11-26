# Runtime 实例元数据可改性矩阵

**状态**：2026-11-26。回答“模板里的哪些元数据能在实例化后的单个 runtime 上改，并能热重载”。

## 结论

模板负责**初始装配**；实例化后，业务/运行元数据可以在单个 runtime 上覆盖并热切换。
启动面与密钥面（command/args/cwd/env/rpcMode/settings/token）**故意不开放**给会话级
修改——它们决定进程如何被拉起、能访问哪些目录/凭据，属于平台/管理员信任边界，
不是“业务情景”元数据。

## 支持单实例修改（下一回合热重载）

| 元数据 | 入口 | 生效 |
| --- | --- | --- |
| harness（omp/dsh/codex/opencode/…） | 会话「运行实例」PATCH `harness` | 下一回合消息入口热切换；重建 harness 进程 |
| provider / model / effort | 同上（目标引擎原生目录 + 自定义 id） | 同上 |
| `runtimePrompt`（附加业务提示，低信任） | 同上 | 同上 |
| AgentPrefab（prefabId + revision + slots） | 同上 `prefabBinding` | 同上；能力/提示/工具面随 revision |
| 节点/配方绑定（daq/dcw/recipe/line-recipe + mode） | 运行实例绑定区 → `agent-tools/bindings` | 执行授权每次工具调用实时读取；omp 每回合重发工具面 → 下一回合生效 |
| 会话 product / line / recipes | 运行实例「会话产线范围」→ `PATCH /sessions/:sid/binding` | 覆盖行 + 范围指纹；下一回合热切换。recipe 版本按当前定义解析，新增/删除/改版都会改变指纹 |
| 成员名 / 启停 | 成员 PATCH（name/enabled） | 立即写库；运行实例按需重装配 |
| 角色模型 `config.modelRef` | 成员 model PATCH | 成员级（角色资产绑定，不影响 harness 模型选择） |

## 不支持单实例修改（以及理由）

| 元数据 | 理由 |
| --- | --- |
| `command` / `args` / `cwd` / `env` / `rpcMode` / `settings` | 启动面/沙箱面：决定可执行文件、参数、工作目录、环境与 RPC 模式。允许会话级修改等于把“任意命令/路径/凭据注入”下放给频道操作者；平台只在 admin/模板层收口（`harness-spawn-policy`）。 |
| `token` / `apiKey` / 凭据 | 密钥面；运行 API 永不回显/写入。实例身份 token 走 rotate-token 专用端点。 |
| 基础 `systemPromptPrefix` | 系统提示是平台/安全/工业约束的信任边界。会话级只开放**附加** `runtimePrompt`（低信任、不可覆盖约束）；替换基础提示会移除安全/工业规则。 |
| `role`（lead/worker） | 结构不变量：lead 绑定 SchedulerLoop/派发语义，运行期改角色会破坏调度器引用。 |
| workspace / scenarioPrompt / executionMode / 频道默认 LLM | 频道级共享配置，不是单个 runtime 的元数据；改频道会回收/重装配成员。 |
| `memoryPolicy` | 会话创建时的记忆作用域属性，影响历史归类，不适合运行中切换。 |
| 创建快照 `binding_snapshot_*` / `prefab_snapshot_*` | 保留为初始/审计基线；有效范围由覆盖行决定，不回写快照。 |

## 会话范围（product/line/recipes）为什么不再冻结

原实现把创建时的 product/line/recipe 版本写进 `channel_sessions.binding_snapshot_*`，
执行面严格比对版本/hash，导致新增节点/配方或换产品必须新建会话。现在：

- 新增 `session_binding_overrides`（session 主键、revision CAS、canonical JSON + hash）。
- `resolveTrustedSessionBinding()` 有覆盖行时以覆盖为准，并按**当前** recipe 定义解析
  版本/hash；无覆盖时回落到创建快照。
- manager 记录已装配的**范围指纹**（product/line + 当前 recipes 的 id/version/hash）；
  下一回合入口比较指纹，变化即热切换。因此：
  - 换产品/增删配方 → 覆盖行 revision 变化 → 热切换；
  - 配方改版（同 id 新 version/params）→ 指纹变化 → 热切换；
  - 节点新增/移除 → 执行面与工具面本就实时读取，下一回合生效。
- 创建快照不删除：它是初始范围和审计基线；“重置为创建快照”可一键回退。

## API

- `GET/PATCH /api/workshop/channels/:id/sessions/:sid/binding`
- `GET/PATCH /api/workshop/channels/:id/sessions/:sid/runtime[/:agentId]`
- `GET/POST/PATCH/DELETE /api/workshop/agent-tools/bindings`
- `POST /api/workshop/channels/:id/sessions/:sid/runtime/:agentId/rebuild`

# 会话级 runtime 元数据覆盖（Session Runtime Overrides）

**状态**：已实现（2026-11-26）；适用于 `instanceKind='manual'` 的 Channel session。

## 目标

每个 manual session 从频道基础成员克隆出独立 `channel_agents` 行。clone 的
`agentId` 就是 **runtime object id**。在不修改模板、基础成员、其他 session、也不修改
会话创建快照的前提下，owner/admin 可以给单个 runtime 覆盖：

- `harness`（执行引擎：omp / dsh / codex / opencode / claude / …）
- `provider` / `model` / `effort`（取目标 harness 的原生模型目录）
- `runtimePrompt`（低信任附加段；不覆盖系统/AML/工业/Project 约束）
- `prefabBinding`（prefabId + 已发布 revision + slotValues）

并在**下一条消息回合开始前**对这一个 runtime 热切换；当前正在执行的回合不打断。
`task` / `project` session 的 runtime 为只读，避免破坏项目 work item 的
`prefab_snapshot_json/hash` 复现合同。

### 选择器三态

`provider/model/effort` 的持久化语义：

| 值 | 含义 |
| --- | --- |
| 字符串 | 覆盖为该值 |
| `null` / 无键 | 继承 clone（或频道默认 LLM） |
| `''`（空串） | **不指定**：显式删除继承值（含 omp `thinkingLevel` / opencode `variant` / pi `thinking` 别名） |

第三态是切换 harness 的必要能力：omp 的 provider 不能被 codex 消费，PATCH 必须能
用 `provider: ''` 清掉它，而不是把旧引擎的值带进新引擎。

## 持久化

```sql
session_runtime_overrides (
  session_id   TEXT NOT NULL REFERENCES channel_sessions(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES channel_agents(id) ON DELETE CASCADE,
  revision     INTEGER NOT NULL DEFAULT 0,
  overrides_json TEXT NOT NULL DEFAULT '{}',
  created_at/updated_at/updated_by TEXT NOT NULL,
  PRIMARY KEY(session_id, agent_id)
)
```

- migration：`server/services/workshop/db/database/migrations-session-runtime.ts`，由
  `open.ts` 在 session/prefab 列之后调用；不修改 `SCHEMA_SQL`，不 bump
  `SCHEMA_CONTRACT_VERSION`（与既有增量 migration 一致）。
- 无行 = 完全继承 clone 的成员配置/prefab；`reset` 写入 `'{}'` 并 +1 revision。
- **不改** `channel_agents.config_json` / `prefab_binding_json`；**不改**
  `channel_sessions.prefab_snapshot_json/hash`。

## 装配优先级

`wireMember`：clone 基础 config → Channel scenario/workspace/默认 LLM → Prefab profile →
**session overrides（最后）**。

- **harness**：在构造 `AgentInfo` 之前读取覆盖，`implFactory`、Prefab 能力交集
  （`resolveAgentCapabilitySet` 的 `harness`）、`SESSION_BRIEF_PROFILE_ENGINES`
  与工业 `channelMode` 全部使用同一个有效 harness。
- `provider/model/effort`：复用 AgentPrefab 的 harness 支持矩阵（`agent-prefabs/profile.ts`）；
  会话覆盖最后写入，所以可压过 Prefab profile。切换 harness 时继承值也参与校验：
  目标引擎读不了旧值 → 409，除非同一 PATCH 用 `''` 清掉。
- `runtimePrompt`：低信任段，写入 `config.runtimePrompt`，由
  `BaseAgentImpl.contextPrefix()` 追加到 prefabPrompt 之后。
- `prefabBinding`：`resolveRuntimeForAgent` / `resolveRuntimeForMember` 读取 override；
  Prefab prompt、能力交集与工具面随之使用覆盖 revision；clone 原始 binding 不变。

## CAS / API

- `GET /api/workshop/channels/:id/sessions/:sid/runtime`（列表）
- `GET .../runtime/:agentId`
- `PATCH .../runtime/:agentId` body `{ expectedRevision, overrides? , reset? }`
  - `revision` CAS：`RUNTIME_REVISION_CONFLICT`（409）
  - 严格字段白名单：`RUNTIME_FIELD_FORBIDDEN`（400，service 层）
  - manual/active/member/worker 校验：`SESSION_MANAGED` / `SESSION_NOT_ACTIVE` /
    `NOT_FOUND` / `SESSION_RUNTIME_FORBIDDEN`
  - 模型目录：`RUNTIME_PROFILE_UNSUPPORTED` / `HARNESS_CATALOG_UNAVAILABLE`
- 返回 `effectiveAt: 'next_turn'`；响应只含白名单 effective 字段。

## 热切换

`AgentRuntime.consumeLoop` 在取出并 claim 消息后、执行前调用
`runtimeReloadRequested()`；manager 比较 DB revision 与已装配 revision。

若变化：

1. 把当前消息放回信箱（claim 释放/requeue）。
2. manager 单飞 `hotReloadRuntime`：先用 current DB 行 `wireMember` 新 runtime（接管
   `agentIndex`/`cr.agents`），再异步 `old.stopForHotSwap()`（不收敛共享 agentId 的
   挂起审批，不广播 stopped），最终 `new.wakeMailbox()`。
3. 旧 consumeLoop 退出；新 runtime 恰好消费 requeued 消息一次。

因此没有 stop 窗口缺口、不重放当前消息、不影响其他 session；revision +2 时直接装配
最新状态。每次 wire 会重建 harness 进程，引擎侧会话连续性会重置（UI 明确提示）。

## 写前校验（fail-closed）

`validateProfileSelection` + `validateCandidate` 在 CAS 写库前执行：

1. `harness` 变更 → `assertHarnessUsable(target)`（未安装 409 `HARNESS_UNAVAILABLE`，
   未知 400 `UNKNOWN_HARNESS`）。
2. 有效 provider/model/effort（覆盖值或继承值）走 harness 支持矩阵：目标引擎读不了
   → 409 `RUNTIME_PROFILE_UNSUPPORTED`（如 codex 不接受 provider、mock 不接受 model）。
3. 读目标 harness 目录（5 分钟缓存；失败 503 `HARNESS_CATALOG_UNAVAILABLE`）：
   目录非空时校验成员关系；目录为空（自由串引擎）只做结构校验。
4. AgentPrefab profile 用目标 harness 重新应用；不兼容 → 409 `PREFAB_PROFILE_UNSUPPORTED`。
5. 必填能力缺失 → 409 `PREFAB_REQUIRED_CAPABILITY_MISSING`。

响应额外返回 `baseHarness`、`overrides`（三态值）、`profileSupport`、`channelMode`
与 `warnings`（例如集成产线会话切到非 bridge 工具面引擎）。

## 节点 / 配方绑定（运行期）

绑定不在 `session_runtime_overrides` 里复制，仍以 `agent_node_bindings`（按
runtimeObjectId）为唯一事实源；执行面每次工具调用实时读取，omp 每回合重发
`set_host_tools`，因此**下一次工具调用/下一回合即生效**。

- `GET .../runtime/:agentId/bindings`：只读摘要（effective 绑定、按频道产线与调用者
  权限过滤的可选资源、**有效会话范围**（覆盖行优先）、`toolRefresh` 策略）。
- 增删/模式切换继续走 `POST/PATCH/DELETE /api/workshop/agent-tools/bindings`
  （同一条产线隔离与 HITL 规则：写向/管理向首绑恒 manual，manual→auto 需
  `confirm: true`）。
- `POST .../runtime/:agentId/rebuild`：只入队；下一回合入口重建实例，用于刷新
  装配期注入的产线/工具上下文。未装配实例返回 `queued:false`（下条消息自然装配）。

## 会话范围（product/line/recipes）运行期可改

创建快照 `channel_sessions.binding_snapshot_*` 只作为初始/审计基线；
`session_binding_overrides`（session 主键 + revision CAS + canonical JSON/hash）让
manual 集成会话在运行期修改 product/line/recipes，`GET/PATCH
/channels/:id/sessions/:sid/binding` 读写，`reset` 回到创建快照。

`resolveTrustedSessionBinding()` 有覆盖行时按**当前** recipe 定义解析版本/hash，
无覆盖时回落到快照。manager 记录已装配的**范围指纹**（product/line + 当前
recipes 的 id/version/hash），下一回合入口比较：

- 换产品/增删配方 → 覆盖 revision 变化 → 热切换；
- 同 id 配方改版（version/params）→ 指纹变化 → 热切换；
- 新增/移除节点 → 执行面与工具面实时读取，下一回合生效。

因此“新增节点/节点不用了/换配方”不需要新建会话。

## 边界

- 只支持单实例覆盖；运行 API 不接受 command / args / cwd / env / rpcMode / settings /
  token（harness 本身可改，但启动参数仍由平台与模板管理）。
- 仅 manual session；task/project 只读。
- 不在当前执行中的回合中途生效；保证下一次消息开始前完成重装配。
- 节点/配方绑定的执行授权实时生效，但装配期写入 `systemPromptPrefix` 的工业上下文
  要等实例重建（显式 rebuild 或自然重装配）才会刷新。
- 会话范围覆盖只影响该会话；创建快照不被回写，可随时 reset 回退。

# Session 注入 v2 —— 分层上下文装配 + 提取式压缩 + 记忆运行时贯通

> 日期：2026-11-07 ｜ 基线：`origin/main` `52f902f9`（含 PR #75 Session Context M1）
> 分支：`feat/session-inject-v2-20261107`（PR-A）、`feat/session-memory-runtime-20261107`（PR-B）
> 目标：**把 harness 最需要的上下文放进 prompt —— 关键的（pinned）+ 附近的（recent），
> 旧的压缩掉；记忆改为运行时工具按需取；装配与注入保持引擎无关。**

## 0. 对需求方理解的校验

| 需求方理解 | 校验结论 |
| --- | --- |
| 记忆是运行时调用获取（工具） | ✅ 正确，且现状已如此：`search_memory`/`save_memory` 是 host 工具（harness 运行中按需 RPC/MCP 调用）。缺口是 **session 维度**：记忆不区分 session、工具执行上下文里没有 sessionId、召回没有 session 优先级。→ PR-B 补齐 |
| session 历史在「开始时」通过 prompt 注入 | ✅ 方向正确，需精确化：对无原生会话持久化的引擎（omp/dsh/hermes/one-shot/goose/mock），**每次回合都是全新 harness 会话**，所以注入发生在每个回合开始（run/supervise 前缀），而非 session 生命周期只注入一次；对有原生会话的引擎（claude resume 试点）才应降为 brief-only。→ capability profile（PR-A） |
| 不要一股脑全注入，注入关键的+附近的 | ✅ 正确，正是 M1 缺口：`formatBriefText` 单层 brief（recent 仅 4 条×120 字），无分层预算、无压缩世代，长会话要么漏要么爆。→ PR-A 三层装配 + 压缩 |
| 上层管理/下层 harness 执行分离、与 harness 无关 | ✅ 架构已成立并保持：装配在平台（`sessions/context.ts`），注入在 `BaseAgent.contextPrefix`（所有引擎 adapter 统一消费 `ctxPrefix`），引擎 adapter 不感知装配逻辑。v2 只换装配器，不动注入点 |

## 1. 现状（M1）与缺口

- M1：`SessionContextService.briefOf`（5s 缓存）→ `formatBriefText` 单层文本 → `runtime-wiring.sessionContext` → `AgentRuntime.getSessionContext`（Map 缓存+turn 计数）→ `BaseAgent.contextPrefix` 末尾整块注入。
- 缺口：
  1. 近期对话只有 4 条×120 字截断，且与任务事实混排；无「近期原文/早期压缩」分层；
  2. 会话越长注入越多（12 条全量 brief），无预算上限、无压缩；
  3. 关键事实（决策/未决/交付）没有 pinned 语义，可能被截断丢失；
  4. `agent_memories.session_id` 列已迁移但从未写入；召回无 session 作用域；工具上下文无 sessionId；
  5. mock agent 不消费 `request.session`，端到端「是否真注入」只能靠 brief API 间接推断。

## 2. PR-A —— Session 注入 v2（分层装配 + 提取式压缩）

### 2.1 三层装配（`SessionContextService.assembleBlock`）

```
## Session Context (authoritative)
session_id=… | kind=… | status=… | profile=full
title/objective/current_task/next_step（≤240 字符级）

### 关键事实 (pinned)
- 决策 | …（项目决策 + 消息中 决策/结论/未决/风险/交付 前缀行，去重，≤14 行）

### 早期上下文 (compressed, generation N)
…（窗口外的旧轮次，提取式压缩文本；generation=0 时省略此层）

### 近期对话 (recent, last ≤8 turns, ≤2400 chars)
[hh:mm] 人类: …（逐条原文，每条 ≤300 字符，超预算从最旧开始丢）

## Session Boundary
…（三条边界规则，保持 M1 语义）
```

**压缩（确定性提取式，不调 LLM）**：
- 窗口 = 最近 8 条 session 消息；窗口外且 `id > compressed.uptoId` 的消息折叠进压缩层；
- 命中 `^(决策|结论|决定|问题|未决|风险|交付)[:：]` 的行**原文保留**（pinned，≤14 行，永不丢）；
- 其余压成话题行 `· <sender>: <前36字符>…`（≤10 行，超限先丢最旧话题）；
- 与既有压缩行合并去重；预算 ≤1200 字符；新增行时 `generation+1`；
- 压缩状态持久化在 `channel_sessions.brief_json.compressed`（复用 M1 列，零迁移）。

**Harness capability profile**（引擎无关性的唯一开关点，装配器消费 profile，注入点不变）：
- `full`（omp/dsh/hermes/one-shot/goose/mock/pi：无原生持久化，平台全量装配）；
- `brief`（claude 预留：有原生会话，仅身份+pinned+next step，历史归引擎会话）；
- 选择在 `runtime-wiring`（引擎名 → profile 表），engine adapter 不感知。

### 2.2 改动面
- `sessions/context.ts`：分层装配 + 压缩 + `assembleBlock(sessionId, profile?)`；`SessionBrief` 增加 `recentTurns/compressed/profile`。
- `runtime-wiring.ts`：sessionContext 回调改用 assembleBlock；按引擎选 profile。
- `agent-interface.ts`：`AgentRunRequest.session.profile`。
- `mock-agent.ts`：chat/peer 回执附加 `ctx[brief=… recent=… earlier=… gen=…]` 标签（从 block 解析），workerScript 注入 `[Session 上下文已注入]` status——让「真注入」可被端到端断言。
- `GET …/sessions/:sid/brief?format=block`：返回装配后的注入文本（UI 预览/验收共用）。
- UI `SessionManageView`：Session Context 卡新增「注入预览」（等宽文本块 + 刷新），i18n zh/en。
- 单测 `tests/session-injection-v2.test.ts`：分层/预算/压缩世代/pinned 保真/幂等/profile=brief/关闭会话仍可装配。
- 验收 `scripts/session-inject-v2-acceptance.mjs`：真实 server + mock 引擎端到端——前期 gen=0 无压缩层 → 压缩触发后 pinned 原文保留、填充长句被压缩、recent 只含最近轮 → mock 回执 ctx 标签 `earlier=1`（证明块真的进了 harness 请求）→ project task session 块含 work_item/objective。

### 2.3 验收门
单测全绿 ｜ API 验收断言全过 ｜ UI 预览截图（桌面+移动）｜ typecheck/eslint/i18n/build ｜ CI → merge main。

## 3. PR-B —— 记忆运行时贯通（session 作用域 + 工具上下文）

### 3.1 写路径（记忆诞生时带上 session）
- `memory.repo.ts`：`MemoryUpsertInput.sessionId?`、INSERT/COLS/`MemoryRow.sessionId`（rows.ts）；
- 所有写路径透传：`save_memory` 工具（当前运行 session）、`recordPeerExchange`（消息 session）、`recordTaskOutcome`（任务 session）、`recordSessionCompaction`（omp 压缩摘要）。

### 3.2 读路径（召回分作用域）
- `MemoryScope` 增加 `'session'`；`recallRows(query, { sessionId? })`：
  - `scope=session`：FTS + 向量 kNN 后按 `session_id` 过滤（vec0 分区键只有 agent_id，kNN 池 ×2 后 post-filter）；
  - `auto`（默认）：session 命中加分（+0.15），session 空则自然回落 private/shared；
- 排序沿用 RRF+recency+importance，不重造。

### 3.3 工具与运行时上下文
- `HostToolSessionState` 增加 `sessionId?`；run 路径（message.ts/omp handleHostTool）把当前 session 注入 dispatch 上下文；
- `search_memory` 增加 `session` 档（scope 枚举 + 描述），`save_memory` 自动落当前 session；
- `host-tools.json` / `host-tools.en.json` 同步（**漏 JSON = omp "No such tool"，PR-A/B 各自成对提交**）；
- 权限模型不变：私域记忆只读本人实例，`__team__` 共享域全员可读；lead 经既有 admin API 策展他人记忆。
- API/UI：`search.post.ts` 支持 `sessionId` 过滤；`MemoryPanel` 行上 session 徽标（轻量）。

### 3.4 验收门
单测（写入透传/作用域隔离/回落/vec post-filter）｜ API 验收：session 对话后 `save_memory` → `search_memory scope=session` 命中、另一 session 不命中、auto 命中且排序优先 ｜ UI 徽标 ｜ 全量门禁 → merge main。

## 4. 明确不做（本轮边界）
- LLM 摘要式压缩（保持确定性提取式；LLM 压缩留作后续开关）；
- per-session harness resume（claude `options.resume` 试点，依赖 profile=brief 先落地）；
- manual session 并行 root、session_turns 物化投影、跨 session 搜索工具 `list_sessions/search_sessions`（沿用 M1 计划的 M3 排期）。

## 5. 风险与回滚
- 压缩状态存 brief_json：坏 JSON → parse 失败回退空压缩状态（不阻断）；
- brief 变长（三层）→ 每层都有硬预算（240/1200/2400 字符级），总块 ≈ ≤4k chars；
- `formatBriefText` 是既有单测断言面（Session Boundary/session_id=），v2 保持这两个锚点不变；
- 注入点（contextPrefix）不动，profile=full 时行为向后兼容，任何异常走既有 catch → legacy 回合。

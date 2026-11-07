# Session 注入 v2 + 记忆运行时贯通 —— 实施与验收报告

> 日期:2026-11-07 | 范围:PR #76 / #77 / #78(已全部合并 main)
> 计划文档:docs/plans/2026-11-07-session-injection-v2-plan.md
> main 末端:3096eaa1(合并后 CI success)

## 1. 对需求方理解的校验(先答问题,再动代码)

| 题设 | 校验结论 |
| --- | --- |
| 记忆是运行时调用获取(工具) | 正确,且现状已如此:search_memory/save_memory 是 host 工具(harness 运行中按需调用);本轮补齐 session 维度 |
| session 历史开始时 prompt 注入 | 方向正确,精确化:无原生持久化的引擎(omp/dsh/hermes/one-shot/goose/mock)每回合都是全新 harness 会话,注入发生在每个回合开始,不是 session 生命周期一次;有原生会话的引擎(claude resume)降为 brief-only |
| 不要一股脑全注入,注入关键的+附近的 | 正确,正是 M1 缺口(单层 brief 无预算无压缩);PR-A 三层装配+压缩落地 |
| 上层管理/下层执行分离、与 harness 无关 | formatBriefText(brief, profile) 在平台装配;BaseAgent.contextPrefix 统一注入;引擎 adapter 只消费 ctxPrefix —— v2 未改任何引擎 adapter,装配器可整体替换而不触引擎代码 |

## 2. PR-0 (#76):遗留工作提交(Project 持续开发对话 + UI 打磨)

- 遗留分支基于 pre-redesign 页面;main 已被 67bb944f ChatGPT 化重设计超越 → 两个 vue 页面取 main 版,Leader 对话移植到新页面(--chat-* 令牌族);冲突区保留双方功能(continueProject + terminate + P0-3 解绑语义)。
- 修正合并回归:unbindChannel 残留旧 409 检查 → 恢复 main 的 P0-3 语义;对应测试重写;清理被杀测试进程的陈旧 ablation artifact。
- 门禁:unit 1177 tests / 1175 pass / 0 fail / 2 skipped;typecheck/lint/i18n 3291/3291;build OK;CI SUCCESS;合并 6640a6ed。

## 3. PR-A (#77):Session 注入 v2 —— 分层装配 + 提取式压缩

### 3.1 装配结构(sessions/context.ts)

- 头部:session_id / kind / status / profile=full|brief / title / objective / current_task / tasks / deliverables / decisions / open_questions / next_step(每项 ≤240 字符级)。
- 关键事实(pinned):消息正文以 决策/结论/决定/问题/未决/风险/交付/验收 前缀的行**原文保留**(≤14 行,永不丢)。
- 早期上下文(compressed):窗口外旧轮提取式压缩为 ≤36 字符话题行(≤10 行,总预算 1200 字符,超限先丢最旧话题)。
- 近期对话(recent):≤8 条 × ≤300 字符,总预算 硬预算 2400 字符;超预算从最旧一侧丢,保留最新连续窗口。
- Session Boundary:三条规则不变(M1 锚点保持)。

### 3.2 压缩指针与幂等
- 指针 = 消息 rowid(uptoSeq)——message id 是 randomUUID 不可比,避免字典序陷阱;
- 压缩状态持久于 channel_sessions.brief_json.compressed(复用 M1 列,零迁移);
- 跨代 carry-forward + 行去重 → 幂等(单测断言 generation 不涨、行不重复、pinned 不重复)。

### 3.3 Harness capability profile
- formatBriefText(brief, profile):full = 三层全量;brief = 只注身份+pinned(历史归引擎原生会话,claude resume 试点预留);
- 选择点在 runtime-wiring(SESSION_BRIEF_PROFILE_ENGINES = {claude});注入点 BaseAgent.contextPrefix 不变,引擎 adapter 零改动。

### 3.4 注入可证明
- mock 回执带 ctx[brief recent earlier gen] 标签;worker 剧本透出 [Session 上下文已注入] 状态消息;
- 端到端断言「块真的进入 harness 请求」不再依赖间接推断。

### 3.5 API/UI
- GET sessions/:sid/brief?format=block 返回注入文本;SessionManageView 注入预览分层块(桌面+移动截图)。

### 3.6 验收
- 单测 tests/session-injection-v2.test.ts 5 用例:分层/压缩幂等/预算方向/profile=brief/跨代累积去重;
- 端到端 scripts/session-inject-v2-acceptance.mjs 24/24(V1 分层头/profile=full/近期原文;V2a-e 压缩演进/pinned 保真/填充句压缩/generation;V3 ctx 标签证明块进入 harness;V4 project task session 块含 work_item/近期对话/profile=full);
- UI 验收 8/8(含 U7 注入预览渲染);unit 全量 1176 tests/1174 pass/0 fail;typecheck/eslint/i18n/build 全绿;CI SUCCESS;合并 50c5609a。

## 4. PR-B (#78):记忆运行时贯通 —— session 作用域 + 工具上下文

### 4.1 写入落 session 戳
- save_memory:默认标注当前会话(session_scope=false 显式声明频道级);
- recordPeerExchange:按消息 metadata x-aw-session-id;
- recordTaskOutcome:按 task.sessionId;
- recordSessionCompaction:按当前会话;
- 记忆列表/检索返回 sessionId 字段。

### 4.2 检索分作用域
- MemoryScope += 'session':scope=session 只检当前会话行(FTS 会话过滤语句;vec kNN 后过滤);
- auto 档:当前会话行 +0.15 排序加分(偏好,非过滤);
- private/shared 语义不变;共享域(team)行带 session 戳时 session 档也可命中本会话的 team 行。

### 4.3 运行时上下文贯通
- HostToolSessionState.sessionId:BaseAgent.run/supervise 回合设置/finally 清空 → dispatch → handleSearchMemory/handleSaveMemory → workspace → AgentMemory;
- message.ts 先解析 sessionId 再自动召回(引子注入同样享受 session 加分);
- REST invoke(无活动回合)→ session 态为空:save=频道级,scope=session 明确拒绝("没有 session 上下文")。

### 4.4 注入面同步
- host-tools.json:scope 枚举 + session 档描述 + save_memory session_scope 参数(注入面与执行面同 PR 成对修改,吸取 66d277e9 "No such tool" 教训)。

### 4.5 验收
- 单测 tests/session-memory-scope.test.ts 5 用例:写入透传/会话隔离/auto 加分/工具桥透传/共享域不串会话;
- 端到端 scripts/session-memory-runtime-acceptance.mjs 22/22(P1-P9 project 流程;M1 运行时任务终态记忆带 task session 戳(实例频道 clone);M2a-c scope=session 隔离/auto 命中;M3a-c REST 无会话态=频道级/session 档明确拒绝;M4 列表含 sessionId 徽标字段);
- unit 全量 1187 tests/1185 pass/0 fail;typecheck/eslint(20 文件)/i18n/build 全绿;CI SUCCESS;合并 3096eaa1。

## 5. 边界与后续(M3 排期,本轮未做)
- LLM 摘要式压缩(本轮为确定性提取式;LLM 压缩留作开关);
- per-session harness resume(claude options.resume 试点,profile=brief 已预留);
- manual session 并行 root / session_turns 物化投影 / 跨 session 搜索工具(list_sessions/search_sessions);
- 会话结束的记忆降级策略(现为列+检索就绪,降级钩子待排期)。

## 6. 证据文件
- docs/audit/evidence/2026-11-07-session-inject-v2/acceptance.json(API 24/24)
- docs/audit/evidence/2026-11-07-session-context/ui-acceptance.json(UI 8/8,含 U7 注入预览)
- docs/audit/evidence/2026-11-07-session-memory-runtime/acceptance.json(22/22)
- 各 server.log 随证据目录提交

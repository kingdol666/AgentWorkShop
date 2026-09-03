# Memory × Context 双层优化计划 v2(2026-09-02 复核修订版)

> 目标:团队 Agent 真正"知道自己做过的历史";omp 执行永不被压缩中断;每次 omp 回合前检查上下文用量,
> ≥70% 自动压缩并把会话摘要持久化进平台 memory;按任务需求注入最相关的记忆;每成员独立记忆体系;资源消耗最小化。
>
> 架构一句话:**omp harness 内部压缩(受控阈值)+ 平台 memory 持久化(harvest)+ 三层注入(L0 简报 / L1 引子 / L2 工具)+ 任务关联加权 + 空闲反思 + 团队编年史**。
>
> **v2 修订**(逐条对照代码复核后):R1 supervise 路径补 gate(v1 遗漏)/ R2 compact 完成语义与超时 / R3
> CJK 查询构造增强 + 任务关联加权 / R4 brief·chronicle·reflection 免向量化与 L1 排除(资源)/ R5
> post-settle 判定归属 runtime / R6 团队沉淀改挂 task 事件总线(防双写)/ R7 legacy 降级与总开关 / R8
> 资源消耗预算表。

---

## 0. 需求 → 方案映射

| 需求 | 方案 | 落点 |
|---|---|---|
| 团队知道自己做过的历史 | 团队编年史 + 任务成果自动入共享域 + 空闲反思蒸馏 | P1-5/6 |
| omp 执行时不中断 | 压缩只在回合间隙(三重防线:`!turnActive && !isStreaming` + `get_state` 复查 + `isCompacting` 互斥);steer/poll/abort 路径零改动 | P0-2 |
| 每次运行检查上下文用量 | pre-prompt/supervise gate 探测 `get_session_stats` + `message_update.usage` 被动跟踪;`AgentStatusView.context` 广播 | P0-1/2 |
| >70% 自动压缩 | 平台驱动 `compact`(阈值 `AW_OMP_COMPACT_THRESHOLD=0.70`);omp 原生 auto-compaction 保留为兜底 | P0-2 |
| 会话信息存入 memory | `compaction_end.result.summary` → `episodic-session` 行(手动/自动/原生压缩三路统一 harvest) | P0-3 |
| 按任务需求取最佳记忆 | 查询构造增强(title 优先 + CJK 词项扩容)+ **任务关联加权**(兄弟/父任务记忆 boost)| P0-3 |
| 每成员有自己的记忆系统 | 现有 per-agent 私有域 + per-channel 共享域不变;新增 brief/reflection=成员私有,chronicle/team-task=频道共享 | 全局 |
| 资源消耗低 | 免向量化清单 + L0/L1 排除 + 事件驱动零轮询 + 预算表 | §5 |

---

## 1. 现状审计(已逐文件核实)

### 1.1 保持不动的既有能力

- **存储**(`db/memory.repo.ts` + `db/database.ts`):SQLite `agent_memories` + FTS5(CJK 单字切分,AI/AD/AU 触发器同步)+ vec0 分区表(agent_id 分区);`(agent_id, dedup_key, channel_id)` 幂等 upsert;`idx_memories_agent(agent_id, created_at DESC)`;`kind` 为自由 TEXT(无 CHECK → 新 kind 零迁移)。
- **每成员隔离**(`manager.ts wireMember:515`):每个实例一个 `AgentMemory(repo, {channelId, agentId})`;`inScope` 双守卫(私有=本人行,共享=`__team__` 行且限本 channel)。
- **算法**(`runtime/memory.ts`):`score = 0.5×相关性 + 0.3×时近(7d 指数) + 0.2×重要性(+5%×access)`;零 LLM harvest;FTS+向量 max 融合;维护(180d 过期/500 容量/孤儿 vec 清理)。
- **注入**(`agent-runtime.ts:528` recall → `AgentRunRequest.memory`;`omp-agent.ts buildWorkerPrompt/buildSupervisePrompt` 拼入 prompt);`search_memory`/`save_memory` host tools。
- **omp 集成**(`omp-agent.ts` + `adapters/omp-rpc-client.ts`):常驻子进程跨消息复用;worker/peer 走 `promptAndStream()`,**supervise 直接 `client.send({type:'prompt'})`(v1 漏判的第三条 prompt 路径)**;steer/follow_up/abort 完备。

### 1.2 缺口清单(G1-G8,v2 复核后修订)

- **G1 上下文盲区**:平台不知 omp 子进程 context 占用;溢出全靠 omp 原生 auto-compaction(阈值不受控)。
- **G2 压缩产物不持久**:`compaction_start/end`、`agent_settled` 事件被 `mapOmpEvent` default 分支静默丢弃;摘要只活在 session 内。
- **G3 团队历史无自动沉淀**:任务成果仅进执行者私有域(且 lead 经 `scheduler-loop.ts:627 recordTaskMemory` 与 worker 各记一份——团队域无人记)。
- **G4 检索融合脆弱**:FTS+向量 max 归一化弱首命中失真;引子无多样性控制;semantic 行被 7d 半衰期错误惩罚。
- **G5 注入层级单一**:无 L0 层,每回合靠检索临时重建身份/团队状态。
- **G6 无反思机制**:episodic 只增不减,无阶段性蒸馏。
- **G7 查询构造弱**:`buildMatchQuery` 取**文本前 12 个词项**——CJK 即前 12 个单字,长描述主题漂移;且未利用任务结构(兄弟任务上下文)。
- **G8(v2 新识别)supervise 是上下文膨胀大户**:每 tick 注入场景×名册×工业工况×全量任务×邮件+记忆,但 prompt 不经 `promptAndStream` → v1 的 gate 覆盖不到它。

### 1.3 omp RPC 协议能力(实测:omp v18.0.4 = pi-mono 协议;session JSONL 实证 usage 字段)

- `get_state` → `{ isStreaming, isCompacting, autoCompactionEnabled, messageCount, sessionId?, model:{contextWindow} }`
- `get_session_stats` → `{ contextUsage:{ tokens, contextWindow, percent } }`(权威;v18 存在性须探测)
- `compact(customInstructions?)` → **响应仅表示受理/完成以 `compaction_end` 事件为准**(`result:{summary, tokensBefore, estimatedTokensAfter}`);`isCompacting` 期间再发会报错
- 事件:`message_update` 帧携带**累计 provider usage**(input=当前上下文 tokens);`compaction_start/end`(含 willRetry,reason=manual/threshold/overflow);`agent_settled`(回合完全落定)
- `set_auto_compaction{enabled}` 保留开启作兜底;`new_session` 可用但 v2 不用(压缩即可延续会话)。

---

## 2. 业界方案选型(定稿)

| 系统 | 核心机制 | 取舍 |
|---|---|---|
| MemGPT/Letta | 分层记忆 + sleep-time compute(空闲整固) | ✅ 分层已有;空闲反思采纳 |
| Mem0 (arXiv:2504.19413) | 写时合并、~1.8k tok/查询 | ✅ dedup 幂等已有;不引入 LLM 抽取(成本) |
| Generative Agents | recency×importance×relevance + reflection | ✅ 公式已有;反思采纳(零 LLM 阈值版) |
| A-Mem / Zep-KG | 笔记链接 / 时序知识图谱 | ⏸ 暂缓(V2 backlog,成本>收益) |
| Letta Filesystem 基准 | 原始历史胜过度加工 | ✅ 摘要原文入库,不过度结构化 |
| pi/omp compaction 协议 | compact + compaction_end + agent_settled | ✅ 全盘采纳 |

不引入外部记忆服务/向量库;全部在 node:sqlite 栈内,零 DB migration。

---

## 3. 目标架构

```
              ┌─────────────────────────────────────────────────┐
              │ omp 子进程(常驻/Agent)                            │
 prompt ─────▶│ [gate: 三条 prompt 路径统一]                      │
              │  worker/peer(promptAndStream)· supervise          │
              │  ≥70%? → get_state 复查 → compact → 等 compaction_end│
              │         (120s 超时放行,isCompacting 互斥)          │
              │  原生 auto-compaction 保留(overflow 兜底)          │
              └───────────────┬─────────────────────────────────┘
                              │ compaction_end.result.summary(三路统一)
                              ▼
              ┌─────────────────────────────────────────────────┐
              │ 平台 memory(SQLite+FTS5+vec0,每成员独立域)        │
              │ 私有:episodic-task · episodic-peer · episodic-session│
              │      · semantic · brief(L0)· reflection(蒸馏)     │
              │ 共享:episodic-team-task · chronicle(编年史)· 策展  │
              │ 免向量化:brief/chronicle/reflection(确定性层)      │
              └───────────────┬─────────────────────────────────┘
                              │ 注入硬顶 500 tok
                              ▼
  L0 brief(≤120tok 恒注入)→ L1 引子(RRF+MMR+任务关联加权,≤300tok)
  → L2 search_memory(按需,可命中 chronicle/session)→ L3 get_task_details 等
```

**"按任务需求取最佳记忆"的两级机制**:
1. **查询构造**:recall 查询 = 消息 parts 文本(第一条即任务 title,天然显著);`buildMatchQuery` 对 CJK 单字词项上限 12→24 并去重,ascii 词项不变;向量分支 embed 全文不受词项切片影响。
2. **任务关联加权(related-task boost)**:runtime 侧由 `taskEngine.get(taskId)` 解析 `{父任务, 兄弟任务}` id 集(≤20 个;`idx_tasks_parent` 已建,零成本),传入 `recall({relatedTaskIds})`;候选行 `row.taskId ∈ relatedSet` → 终分 `+0.3`(常量 `RELATED_TASK_BOOST`)。同父兄弟任务的 episodic-task 记忆(前几个子任务做了什么)必然浮到引子最前——这是"任务需求驱动"的最直接实现,纯内存 id 判断,零检索开销。

---

## 4. 实施拆解

### P0-1 RPC 客户端扩展 — `adapters/omp-rpc-client.ts`

- `RpcCommand` 增:`get_session_stats`、`compact`(带 `customInstructions?`)、`set_auto_compaction`。
- 客户端维护 `lastUsage`(从 `message_update` 帧提取 usage)+ `contextWindow`(外部经 `setContextWindow()` 注入或 get_state 探测);暴露 `getContextUsage(): {tokens, contextWindow, percent} | null`(双源:优先 get_session_stats 结果,被动 usage 兜底)。

验收:类型检查过;终端镜像与现有帧处理零回归。

### P0-2 上下文治理环 — `agents/omp-agent.ts` + `agent-interface.ts` + `agent-runtime.ts`

**契约扩展**(全部可选方法,旧 harness 不受影响):
- `AgentInterface.getContextStats?()` / `onTurnSettled?()`
- `AgentWorkspace.recordSessionMemory?(input: { summary: string, tokensBefore?: number, tokensAfter?: number, reason?: string }): Promise<void>`(harvest 桥,manager 用成员自己的 AgentMemory 实现)

**OmpRpcAgentImpl**:
- `ensureClient()`:spawn 后探测 `get_session_stats` + `get_state`(一次;取 contextWindow/sessionId;失败置被动跟踪模式)并显式 `set_auto_compaction{enabled:true}`。
- `contextGate(reason)`:三条 prompt 路径(workerRun/peerMessageRun 经 `promptAndStream`,supervise 在其 `client.send` 前)统一调用:
  1. 开关关/无 client/被动模式且无 usage → 直接放行;
  2. `percent < AW_OMP_COMPACT_THRESHOLD(0.70)` 或距上次压缩 < `AW_OMP_COMPACT_MIN_INTERVAL_MS(5min)` → 放行;
  3. `this.compacting` 互斥位已置 → 放行(另一路正在压);
  4. `await client.send({type:'get_state'})` 复查 `isStreaming===false && isCompacting===false`,否则放行(**不中断执行的第一保证**);
  5. 发 `compact(customInstructions: renderPrompt('compaction-hints'))`,**等待 `compaction_end` 事件**(一次性事件订阅;120s 超时兜底放行——压缩继续后台进行,isCompacting 防双发);响应内含 result 则直接用;
  6. 收到 result → `void this.harvestCompaction(result)`(fire-and-forget + try/catch);未知命令错误 → 标记 legacy,永久停用平台压缩(omp 原生兜底 + compaction_end harvest 照常)。
- 事件消费(`mapOmpEvent` 增分支,均返回 `[]` 不污染事件流):`compaction_start` → 置 compacting;`compaction_end` → 清 compacting + harvest(**三路统一**:平台手动/omp 阈值自动/overflow,包括回合中途到达的原生压缩——harvest fire-and-forget 不阻塞事件流);`agent_settled` → settled 标志。
- harvest 幂等:dedupKey=`session:<sessionId|agentId>:<seq>`,seq 每次 compaction_end 自增。

**AgentRuntime**:
- `processMessage` finally(记忆沉淀后):`await this.maybePostSettle()` → `(await deps.mailbox.peek(1)).length === 0` 时调 `impl.onTurnSettled?.()`(内部即 `void contextGate('post-settle')`——排队空闲时后台压缩,下一回合免付延迟);有排队消息则跳过(pre-prompt gate 兜底)。
- `supervise` finally 同样调 `maybePostSettle()`(lead 高频路径)。
- `getStatus()` 透出 `impl.getContextStats?.()` → `AgentStatusView.context?`(`types/task.ts` 加可选字段;WS `agent.status` 广播自动携带)。
- **related-task 解析**(`processMessage` 内):`task=taskEngine.get(taskId)` → parent → siblings(同 parent 的任务 id 集,≤20)→ `recall(query, { relatedTaskIds })`。

### P0-3 记忆层核心 — `runtime/memory.ts`

1. **`recordSessionCompaction(summary, meta)`**:kind=`episodic-session`,importance=0.75,截断同现有规则,向量化(一次 embed/压缩,值得)。
2. **RRF 融合**(`collectHits`):FTS 榜与向量榜各按名次 `1/(60+rank)` 求和;无 embedder 时退化为纯 FTS 榜 rank 分(顺带修复弱命中失真);时近兜底行保持 0.15。
3. **MMR 装配**(`recall`):λ=0.7,候选间相似度=词集 Jaccard(title+前 200 字;有 embedder 用向量余弦);避免近重复行挤占预算。
4. **kind 感知半衰期**(`score`):peer 3d / task 14d / session 14d / semantic·brief·chronicle·reflection ∞。
5. **L0 简报**:新 kind=`brief`(agentId=本人私有,dedupKey=`brief:<agentId>` 幂等单行)。零 LLM 模板:当前任务/队列深度/最近 3 完成(标题+20 字结果)/最近 2 条 shared 约定。`recordTaskOutcome` 与 `save(scope='shared')` 收口刷新。**免向量化**。`recall()` 置顶注入并计预算。
6. **L1 排除规则**(`rank`):kind∈{brief, chronicle, reflection} 不进排名候选(它们是确定性层,防双份注入烧预算);`recallRows`(search_memory)不过滤——L2 检索 chronicle/reflection 是特性。
7. **查询构造**:`buildMatchQuery` CJK 单字词项上限 12→24(`MAX_CJK_TERMS`),词项去重;ascii 词项仍 12。
8. **`RecallOptions.relatedTaskIds?`**:排序终分 + `RELATED_TASK_BOOST(0.3)`(上限 1)。
9. 新方法签名预留:`appendTeamTaskRecord(task)` / `refreshChronicle(channelName, entries)` / `reflect(agentId)`(P1 用)。

### P0-4 Runtime 接线 — `agent-runtime.ts` + `types/task.ts`

见 P0-2。改动量:`AgentStatusView` 加 `context?` 字段;`processMessage`/`supervise` finally 各一行 `maybePostSettle()`;recall 调用处传 `relatedTaskIds`。

### P1-5 团队历史沉淀 — `runtime/manager.ts`(挂 task 事件总线,单点不双写)

- **订阅点**:manager 创建 ChannelBus 处(channel 级一次)注册 `bus.onTaskEvent`;仅处理 `state ∈ {COMPLETED, FAILED, CANCELED}`:
  - **team-task 共享行**:kind=`episodic-team-task`、agentId=`__team__`、dedupKey=`team-task:<taskId>`(天然幂等)、importance=COMPLETED 0.8 / FAILED 0.55、内容=deliverable/失败原因摘要,**向量化**(全员可语义检索"谁做完了什么/为什么失败")。
  - **团队编年史**:kind=`chronicle`、agentId=`__team__`、dedupKey=`chronicle:<channelId>`、importance=0.9;滚动重写最近 12 条 `[MM-DD HH:mm 状态] 标题 — 执行者 (交付≤60字)`,调用侧切片 1500 字,**免向量化**。
- 事件总线保证每次状态迁移恰好一次通知(TaskEngine hooks)→ 双写问题不存在(v1 挂 harvest 路径会双写,已修正)。
- `AgentWorkspace.recordSessionMemory` 实现:manager 用该成员的 AgentMemory 转调 `recordSessionCompaction`。

### P1-6 反思 + 维护细化 — `runtime/memory.ts` + `memory.repo.ts` + `manager.ts`

- **维护升级**(`runMemoryMaintenance`):
  - kind 过期:`episodic-session` 14d(`AW_MEMORY_EXPIRE_SESSION_DAYS`)/其余 episodic 180d;
  - kind 豁免:brief/chronicle/reflection/semantic 全豁免(单行幂等自限,无膨胀风险);
  - **team 行豁免细化**:team 的 `episodic-team-task` 纳入过期+容量淘汰(防共享域膨胀);team 的 chronicle/semantic 策展行豁免。repo 增 `listChannelIds()` 支撑 team 行按 channel 迭代。
- **空闲反思**(sleep-time compute):manager 现有 `memoryTimer`(小时级)附加 `reflectIdleMemories()`:有 busy runtime 的 channel 跳过;每 agent 未蒸馏 `episodic-task` 增量 ≥ `AW_MEMORY_REFLECT_TRIGGER(8)` → 零 LLM 聚合(标题+结论按词面粗分组,≤800 字)成 kind=`reflection`、dedupKey=`reflection:<agentId>:<yyyy-mm>`(月度幂等)、**免向量化**(FTS 可检索)。smol LLM 蒸馏留 V2。
- 复杂度:每 agent 扫 ≤500+cap 行内存计算,每小时一次,可忽略。

### P1-7 prompts / host tools 文案

- 新增 `.AgentWorkShop/prompts/compaction-hints.md`(loader 播种机制自动补缺):结构化摘要指令——保留任务 id/关键决策/文件路径/团队通信承诺/未竟事项/下一步,丢弃过程性输出。
- `host-tools.json`:`search_memory` 描述补"可命中团队编年史/历史会话结论";`save_memory` 补"会话压缩摘要由平台自动入库,无需手动保存整段会话"。
- `system-manual.md` 记忆章节补三层注入说明与 related-task 语义。

### P2-8 测试与验证(仓库惯例 `tsx scripts/test-*.ts`)

| 脚本 | 覆盖 |
|---|---|
| `scripts/test-memory-rrf-mmr.ts` | RRF 融合/弱命中修复、MMR 去重、kind 半衰期、related-task boost(hash embedder 零网络) |
| `scripts/test-memory-brief-chronicle.ts` | brief 幂等刷新与置顶、chronicle 滚动、team-task 共享行、L1 排除、免向量化断言 |
| `scripts/test-context-governor.ts` | fake client 脚本化帧:usage 被动跟踪、**三条路径 gate(worker/peer/supervise)**、compact→compaction_end 时序(prompt 在压缩完成后才发)、120s 超时放行、legacy 降级、compaction_end harvest 落库、post-settle 邮箱空判定 |
| `scripts/test-memory-maintenance.ts` 扩展 | session 14d、team episodic 淘汰、chronicle/reflection 豁免 |
| `scripts/e2e-memory-system.ts` 扩展 | 真实 omp:`AW_OMP_COMPACT_THRESHOLD=0.01` → 观察 compact → `agent_memories` 出现 episodic-session → 下一回合 primer 含 brief + 兄弟任务行置顶 |

---

## 5. 资源消耗预算表(资源低耗的量化保证)

| 时机 | 增量成本 | 说明 |
|---|---|---|
| 每回合(prompt/supervise) | +1 次 stdio RPC 探测(ms 级)+ 注入 ≤500 tok(现状 ~300) | gate 探测失败即退化被动模式,零重试 |
| 每回合流式 | 0 | usage 从既有 `message_update` 帧顺带提取,无额外请求 |
| 每任务终态 | +3 upsert(brief/chronicle/team-task)+ **1 次 embed**(team-task;brief/chronicle 免) | 相比现状(1 upsert+1 embed)仅 +2 次本地写 |
| 每次压缩 | 1 次 omp 内 LLM 调用 + 1 次 embed(session 行) | 受 ≥70% + 5min 间隔双约束;压缩后回落 ~30% |
| 每小时反思 | O(≤500 行/agent) 内存扫描 + 至多 1 upsert/agent | busy channel 跳过 |
| 存储 | session 行 14d 自清;team-task 纳入 500 容量淘汰;chronicle/brief/reflection 恒单行 | 无膨胀路径 |
| 向量层 | 不变(vec0 分区表复用;新可检索行天然无向量,FTS 兜底) | — |

## 6. 配置项(全部 env,AW_* 风格)

| 变量 | 默认 | 说明 |
|---|---|---|
| `AW_OMP_COMPACT_ENABLED` | `1` | 总开关(v2 新增;置 0 即逻辑性回滚全部压缩行为) |
| `AW_OMP_COMPACT_THRESHOLD` | `0.70` | 触发压缩的上下文占比 |
| `AW_OMP_COMPACT_MIN_INTERVAL_MS` | `300000` | 两次压缩最小间隔(防振荡) |
| `AW_OMP_COMPACT_WAIT_MS` | `120000` | 等 compaction_end 的超时放行 |
| `AW_MEMORY_EXPIRE_SESSION_DAYS` | `14` | episodic-session 过期 |
| `AW_MEMORY_REFLECT_TRIGGER` | `8` | 反思蒸馏触发阈值 |
| `AW_MEMORY_INJECT_TOTAL` | `500` | 回合注入总预算硬顶(brief+引子) |
| 现有 `AW_MEMORY_PRIMER_TOKENS/BUDGET_TOKENS/EXPIRE_DAYS/CAP/EMBED_*` | 不变 | — |

## 7. 风险与对策(v2 修订)

| 风险 | 对策 |
|---|---|
| omp v18 缺 `get_session_stats` | ensureClient 探测降级为 `message_update.usage` 被动跟踪 + `get_state().model.contextWindow`(usage 字段已在 session JSONL 实证) |
| omp 缺 `compact`(旧版) | 首次触发时报"未知命令"→ 标记 legacy 永久停用平台压缩;omp 原生 auto-compaction 兜底,compaction_end harvest 照常 |
| 压缩与 steer/prompt 竞争 | 三重防线:gate 仅回合间隙发起 + `get_state` 复查 isStreaming/isCompacting + `compacting` 互斥位;失败静默放行下回合重试 |
| `compaction_end` 在回合中途到达(原生阈值压缩) | mapOmpEvent 返回 `[]` + harvest fire-and-forget,不阻塞事件流 |
| pre-prompt 同步等待可感知 | 仅 ≥70% 且超间隔发生;post-settle 后台路径吸收空闲场景;`AW_OMP_COMPACT_ENABLED=0` 一键关闭 |
| contextWindow 拿不到(个别 provider) | percent 无法计算 → 该 agent 退化纯被动记录(仅透出 tokens,不触发压缩);omp 原生兜底仍在 |
| harvest 摘要过大/重复 | 截断 800 字 + dedupKey 含 seq 双路幂等 |
| 共享域膨胀 | team episodic 纳入淘汰;chronicle/brief/reflection 恒单行 |
| 任务双记(worker+lead 各 harvest 一份) | 既有行为不变(各自私有域合理);团队域由 task 事件总线单点写,无双写 |
| node:sqlite BigInt 坑 | 沿用既有约定(vec* 全 BigInt) |
| 并行会话共享 git index | 提交按 pathspec 限定(仓库纪律) |

## 8. V2 Backlog(本计划不做)

A-Mem 式记忆链接/HippoRAG-lite 实体索引;smol LLM 反思与 Mem0 式写时合并;respawn 后 session JSONL 扫描补 harvest;BEAM/LongMemEval 式记忆质量自评;前端记忆浏览器新 kind 徽标;session 摘要按协作标记选择性发共享域。

## 9. 落地顺序(每批独立可交付、可回滚)

1. **P0 批(~1 会话)**:P0-1 → P0-2 → P0-3 → P0-4 → `test-context-governor.ts` + `test-memory-rrf-mmr.ts` 绿。产出:70% 无中断压缩 + 摘要持久化 + 上下文透出 + 检索质量升级 + 任务关联加权。
2. **P1 批(~1 会话)**:P1-5 → P1-6 → P1-7 → brief/chronicle/maintenance 测试绿。产出:团队历史感知 + 空闲反思 + 维护细化。
3. **P2 批(随发版)**:真实 omp e2e + docs/README。

回滚:`AW_OMP_COMPACT_ENABLED=0` + 阈值 0.99 → 全部新行为逻辑性关闭;新事件分支默认 `[]`;新 kind 对既有查询/维护向后兼容。

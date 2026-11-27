# 记忆知识网络（Memory Graph）

记忆中心把"散落的记忆行"整理成可追溯、可编辑、可检索的知识网络：每条记忆是一个 episode 节点，实体/事实边构成网状，社区摘要提供主题视角。

## 能力

- **自动整理 Agent**：后台定时（默认 30 分钟）把频道语义记忆、已验证经验、结构化 claim 与已发布本体整理为实体/关系/社区；也可在记忆中心手动「立即整理 / 全量重建」。
- **证据绑定**：每条自动关系至少有一条 `memory_edge_evidence`（记忆 / claim / intervention）；LLM 抽取的每条关系必须给出来源 memory id，否则拒收。
- **时序**：`valid_from/valid_to/recorded_at/superseded_by` 双时间轴；新事实使旧事实失效但不删除，支持 `asOf` 回看。
- **人工权威**：节点/边可编辑、锁定、合并/取消合并、否证/恢复、软删/恢复；自动整理不覆盖人工锁定/人工行。
- **混合检索**：实体种子 + Personalized PageRank 多跳扩展 + 既有 FTS/向量 RRF；图阶段超过 75ms 自动跳过，不影响原检索。
- **注入透明**：L0.5 注入"知识手册 + 知识网络"摘要（合计 ≤200 tok），`memory_injection_log` 记录 graph refs，可在「注入追踪」查看。

## 存储

只使用现有 SQLite（不引入外部图数据库）：

- `memory_entities` / `memory_entity_aliases` / `memory_entity_mentions`
- `memory_edges` / `memory_edge_evidence`
- `memory_communities` / `memory_community_members`
- `memory_graph_runs` / `memory_graph_state`
- `memory_graph_revisions` / `memory_merge_candidates`
- `memory_entities_fts`（FTS5）+ 惰性 `memory_entities_vec`（sqlite-vec，可选）

图谱是**派生索引**，可重建；记忆/经验/claim 是事实源。迁移为 additive，不改 `SCHEMA_SQL` 契约。

## 作用域与分区（分开整理、分开管理）

图谱按 `(channel, scope_kind, scope_key)` 分区，**不同 Channel / Session / 共享区 / 产线 / 产品不混图**：

| 分区 | 来源 | 检索使用 |
|---|---|---|
| `channel` | 本频道 `scope_kind='channel'` 的 semantic/episodic-task/episodic-peer/experience（共享 team 行归此档） | 频道/私有/共享/auto |
| `session` | 本会话 `scope_kind='session'` 的私有记忆 | 仅当前会话（auto/private/session）；其他会话不可见 |
| `global` | 本 owner 的 `scope_kind='global'` 已验证经验（共享区） | 共享区管理面 / `memory_graph_query(scope=shared)`；运行时 L2 共享区仍按 owner 注入 |
| `line` | 频道绑定产线的**产线级**已发布本体（`product_id=''`）+ 无产品归属的 line claim | 工业模式 auto / 显式 `scope=line` |
| `product` | 指定产品的已发布本体 + 该产品的 validated/deployed claim | 工业模式 auto / 显式 `scope=product` |

- 频道图只含 `scope_kind='channel'`，不含 session/global/line/product；session 图只含本会话；共享图只含同 owner 的 global。
- 跨分区边在写入层直接拒收（`src/dst` 必须同 channel + 同 scope + 同 owner）。
- `isolated` 只整理 session+channel，不导入 line/product/global；`disabled/readonly` 不整理。
- 运行时 `auto` 只组合当前 session + channel（工业模式再加 line/product）；不会把 s2 的 session 图注入 s1。

## 检索口径

1. 实体种子：alias/canonical 精确、实体 FTS、可选实体向量、子串补召回（最多 8 个）。
2. PPR：`r=(1-α)s+αAᵀr`，α=0.85，20 轮/1e-6，≤300 节点/1200 边；`contradicts` 不传播。
3. 投影：实体分数经 mentions/证据投影到记忆；episode 直接映射 `memory_id`。
4. 融合：在 `recall.collectHits` 的 RRF 汇聚点加 graph 榜，权重 0.8；图阶段超 75ms 跳过。
5. 摘要：L0.5 最多 2 条事实 + 1 个社区标题；refs `source='graph'`。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `AW_MEMORY_GRAPH_DISABLED` | 未设置 | `1` 关闭自动整理 |
| `AW_MEMORY_GRAPH_INTERVAL_MS` | 1800000 | 整理间隔（最小 60s） |
| `AW_MEMORY_GRAPH_INITIAL_DELAY_MS` | 60000 | 启动首轮延迟 |
| `AW_MEMORY_GRAPH_FULL_REBUILD_HOURS` | 24 | 全量社区重建周期 |
| `AW_MEMORY_GRAPH_LLM_URL/KEY/MODEL/TIMEOUT_MS` | 回退 Curator env | OpenAI 兼容抽取/摘要端点；未配置走规则 |
| `AW_MEMORY_GRAPH_RETRIEVAL` | 开 | `0` 关闭图检索（FTS/向量照常） |
| `AW_MEMORY_GRAPH_SWEEP_LIMIT` | 2 | 每轮整理频道数 |

## API

频道级：`GET /api/workshop/channels/:id/memory-graph?scope=channel|session|shared|line|product&sessionId=&productId=`（子图/搜索/asOf），以及 `entities`、`edges`、`merge-candidates`、`communities`、`runs`、`settings` 的 CRUD/动作。`runs` 的 POST body 也支持同样的 `scope/sessionId/productId`，只整理该分区。读需频道可见成员，写需 owner/admin；所有写走 zod strict + `expectedRevision` CAS + `memory_graph_revisions` 快照 + `recordOps`。

全局：`GET /api/workshop/memory/injections`（注入留痕）、`GET /api/workshop/memory/health`（含 graph 段）、`POST /api/workshop/memory/repair`（admin）。

## 前端

记忆中心四个视图：记忆列表 / 知识图谱 / 注入追踪 / 健康与修复。知识图谱顶部有「频道 / 会话 / 共享区 / 产线 / 产品」分区选择：切到会话需选具体 session，切到共享区按 owner 读 global，切到产品需选产品；每个分区独立整理、独立子图、独立社区。画布使用已安装的 ECharts GraphChart（力导向，可拖拽/缩放；节点按类型着色，provisional 虚线，标签按作用域去重），点击节点/边打开抽屉编辑；社区、待合并候选、整理运行在同一页签，运行行显示分区。

## 边界

- 不引入 Neo4j/Kuzu；不做 3D/自由画布连线；低置信相似度只进合并候选，不自动合并。
- 没有 LLM 端点时，语义关系质量受规则抽取限制；结构化 claim/本体仍可形成高置信事实。
- 对话消息级"本轮引用"面板尚未做（当前为记忆中心注入追踪）；需要 chat message→task 关联后再补。
- 图检索对单跳不应回退、对多跳有固定夹具增益；真实产线收益需两周试点验证。

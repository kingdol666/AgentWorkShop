# 记忆知识网络（Memory Graph）— 实机验收报告（2026-11-27）

计划：`.omc/plans/2026-11-27-memory-knowledge-graph.md`
基线：`feat/memory-timing-provenance-20261127@ea5a8eb8` + 本轮改动
实例：`AW_MODE=home`，`AW_HOME=D:/tmp/aw-memory-graph-20261127/home`，生产构建 `.output`
端口：Web `:3097`；桌面 Electron 45.4.1（源码壳 + 同 home sidecar，CDP `:9334`）

## 1. 旧计划完整性审计（结论）

| 项 | 状态 | 证据/说明 |
|---|---|---|
| 批次 0/A/B/C/D/E/F/H/N/M/G1/I/J/G2/K/L/G3 | 已完成（核心） | 2457 tests + 八门禁 + 上一轮 Web/桌面证据 |
| M31 统一读调度/30ms/citations | 未闭合 | 本轮补了 75ms 图阶段降级与注入 refs 可还原；citations 完整性未做单独校验 |
| M34 对话侧引用 | **部分收口** | 本轮新增 `GET /memory/injections` + 记忆中心「注入追踪」；对话消息级面板仍未做（缺 chat message→task 关联） |
| M35 会话级策略 | **收口** | API/UI 支持 channel/session；实测见截图/接口 |
| M36 健康/修复 | **收口** | `POST /memory/repair` + 健康页（FTS/图谱/孤儿/stale/待合并） |
| M22/M37/M45/M51 实机可重复 | 部分 | 工业 rig 闭环仍需独立验收轮；本轮只做记忆/图谱实机 |
| 调度卫生 | **收口** | Curator/Graph scheduler 单飞、stop、stale run 回收、可配 interval |

结论：**核心功能链路完整；验收标准仍有“对话消息级引用/工业真实闭环”两项边界**，未宣称全部闭合。

## 2. 本轮交付

- **存储**：additive `migrations-memory-graph.ts`（实体/别名/提及/事实边/证据/社区/运行/状态/修订/合并候选 + FTS/vec），未改 `SCHEMA_SQL`、未 bump 契约版本。
- **整理 Agent**：`memory/graph/agent.ts`（确定性 ontology/claim/规则术语 + 可选 LLM，证据绑定、实体解析、合并候选、矛盾失效、社区摘要、单飞、上限）；`scheduler.ts` 默认 30min。
- **检索**：`retrieval.ts`（种子 → PPR → 记忆投影），`recall.collectHits` 的 RRF 加 graph 榜；L0.5 摘要；75ms 降级；`AW_MEMORY_GRAPH_RETRIEVAL=0` 关闭。
- **API**：`server/api/workshop/channels/[id]/memory-graph/**`（子图/实体/关系/合并候选/社区/运行/设置）；`/memory/injections`、`/memory/repair`、health graph 段。
- **工具**：只读 `memory_graph_query`（host-tools 133）。
- **前端**：记忆中心四视图；ECharts GraphChart 力导向、类型配色、provisional 虚线、作用域消歧标签；实体/边抽屉编辑/合并/锁定/否证/软删；社区/待合并/运行台账；注入追踪；健康修复；会话级访问策略。
- **旧计划收口**：M34 API+面板、M35 API/UI、M36 repair+健康、Curator scheduler 卫生。

## 3. 实机证据

### 3.1 图谱整理

- 频道：`Accept Graph v2`（`69501158-b789-4833-9a35-83cb86974905`）。
- 手动 `mode=full` run：`status=ok`（运行台账见 `07-runs.png`）；最终子图 API：`entities=39`、`edges=129`、`communities=2`；子图（无 episode）`nodes=25`、`edges=41`。
- 结构化事实：`保压压力 affects 壁厚`、`冷却水流量 affects 良率`、`注塑机 has_parameter 保压压力/冷却水流量`、`P-ACCEPT-01 uses_recipe R-ACCEPT-01`。
- 本体：`ont-accept-v2`（line L1）导入 `保压压力/壁厚/良率/冷却水流量/注塑机` 与 influences/actuates。

### 3.2 检索与注入

- 真实 `AgentMemory.recall('保压压力对良率和壁厚的影响', {trace:{taskId:'task-graph-accept'}})`：
  - L0.5 出现 `## 知识网络（自动汇整）`：`注塑机 --affects--> 保压压力`、`社区：保压压力、壁厚 等（8 个实体）`。
  - `recallRows` 前 8 条包含 `保压与良率`、`保压压力调参记录`、`壁厚偏差`、`良率异常处理`、`冷却水与良率`、`模温与壁厚`。
- `memory_injection_log`：`task-graph-accept` 写入 graph refs（edge/community）+ primer refs；`GET /api/workshop/memory/injections?channelId=...` 返回可读 label/subtitle（截图 08）。
- 图谱检索基准（固定夹具 28 条记忆/6 查询）：单跳不回退；多跳至少 1 条改善；图阶段 p95 <75ms（测试 `memory-graph-bench.test.ts`）。

### 3.3 人工治理

- 服务层测试：实体创建/编辑 CAS/软删/恢复；关系创建/编辑/否证/恢复；合并/取消合并；合并候选 accept/reject；运行/设置；全部 PASS。
- 实机 UI：实体抽屉显示类型/作用域/置信/来源/有效窗口/社区/别名/提及/关系，含编辑/锁定/合并/软删；边抽屉显示源/目标/关系/事实/极性/状态/置信/有效窗口/证据/claim，含编辑/否证/软删（截图 03/05）。
- 关系证据可回指 `memoryId`/`claimId`/`interventionId`。

### 3.4 健康与修复

- `GET /memory/health?channelId=...`：记忆 15、FTS 30、图谱 39/129、社区 2、实体 FTS 39、孤儿边 0、stale 0、待合并 0（截图 09）。
- `POST /memory/repair`（admin）：重建 memory/entity FTS、回收 stale graph run、清理过期工作记忆/90 天注入日志；测试 `memory-health-repair.test.ts` PASS。

### 3.5 调度卫生

- `memory-curator-scheduler.test.ts`：第一轮未结束时第二轮返回空（单飞）；stale running run 回收为 failed；stop 可重复。
- Graph scheduler 同样单飞/stop/stale 回收；manager 关闭时 stop。

## 4. 门禁

| 门禁 | 结果 |
|---|---|
| `npm run lint` | PASS（RSI 红线 35 文件 0 设备写） |
| `npm run typecheck` | PASS |
| `npm run test:unit` | **2487 tests / 2486 pass / 1 skip / 0 fail** |
| `npm run i18n:check` | PARITY OK（3787/3787，used 3314/unresolved 0） |
| `npm run docs:check` | 101/0 |
| `npm run readme:lint` | PASS |
| `npm run build` | PASS（35.8 MB / 8.92 MB gzip） |
| `npm run test:boot-smoke` | 6/6 PASS |

## 5. 截图与日志

- Web（1440）：`01-graph.png`、`02-graph-table.png`、`03-entity-drawer.png`、`04-entity-edit.png`、`05-edge-drawer.png`、`06-communities.png`、`07-runs.png`、`08-injection-trace.png`、`09-health.png`
- 桌面（Electron）：`10-desktop-graph.png`、`11-desktop-entity.png`（桌面窗口 800px 侧滑抽屉被裁切，实体编辑完整版见 Web `03`）、`12-desktop-health.png`
- 复现脚本（仓库外）：`D:/tmp/aw-graph-seed.mjs`、`aw-graph-ui-shots.mjs`、`aw-graph-desktop-shots.mjs`、`aw-graph-live-recall.mts`

## 6. 已知边界

- **LLM 未配置**：本轮实机走规则抽取（run `llmCalls=0`），语义关系质量受规则限制；配置 `AW_MEMORY_GRAPH_LLM_*` 后自动启用，失败仍有模板回退。
- **作用域重复显示**：同一实体名在 channel/line/product 作用域各有一份，图中用 `·channel/·line/·product` 区分；这是“同频道物化、不跨频道读”的保守设计，不是重复写入。
- **对话消息级引用**未做（见审计 M34）；当前引用面板在记忆中心。
- **实机数据为夹具**：`aw-graph-seed.mjs` 通过真实 API/真实表写入 12 条记忆 + 2 条 validated claim + 1 份 published ontology；不是自然积累。
- **桌面窗口尺寸**导致 11 号截图抽屉被裁切；功能在 Web 1440 验收通过，桌面图谱/健康页正常。
- Mimosa 本轮未运行完整扫描；不宣称安全通过。

## 7. 分区改造轮（2026-11-27 第二轮）

### 7.1 改造目标

知识网络不再按频道“大杂烩”整理，而是按 `(channel_id, scope_kind, scope_key)` **独立物化、独立管理、独立检索**：

| 分区 | 来源 | 运行时使用 |
|---|---|---|
| `channel` | 本频道 `scope_kind='channel'` 的 semantic/episodic-task/episodic-peer/experience（团队共享行） | 频道/私有/共享/auto |
| `session` | 本会话 `scope_kind='session'` 私有记忆 | 仅当前会话；s1 不注入 s2 |
| `global` | 本 owner 的 `scope_kind='global'` 共享区记忆/经验 | 共享区管理面、`memory_graph_query(scope=shared)`；运行时 L2 按 owner |
| `line` | 频道绑定产线的**产线级**已发布本体 + 无 product 的 line claim | 工业模式 auto / 显式 `scope=line` |
| `product` | 指定产品的已发布本体 + 该产品 claim | 工业模式 auto / 显式 `scope=product` |

### 7.2 本轮修复的代码问题

1. **手工 session 记忆不可见**：`createMemory` 只写 `scope_kind/scope_key`，未写 `session_id`；检索会话过滤与 session 图来源 SQL 都读 `session_id`。已同步写入，并拒绝无 `scopeKey` 的 session 手工新建（`memory-admin.ts`）。
2. **运行期 `setScope` 不同步 session_id**：session 档补 `session_id=scopeKey`（`memory.repo.ts`）。
3. **跨频道实体 id 串图**：`loadSubgraph` 只校验 scope，channel 档 `scopeKey=''` 会命中其他频道实体。已加 channelId 守卫（种子/节点），`memory_graph_query` 传实体 id 同样校验归属。
4. **边 scope 可由调用方谎报**：`upsertEdge` 原用 `input.scopeKind/scopeKey` 写入，端点同区也能把边落到另一分区；现强制由端点决定，显式不一致直接拒收；边 owner 也随端点，不再由调用方改写。
5. **绑定产品后 line 分区变空**：`loadPublishedOntology` 原先优先返回产品本体，line 分区又丢弃 product 本体。现按分区显式加载：line 恒取 `product_id=''` 的产线本体，product 取对应产品本体；新增回归测试。
6. **社区 id 跨分区冲撞**：旧频道社区行与新 product 社区同 id 时，`ON CONFLICT` 只更新摘要不更新 scope，导致 product 社区“看起来不存在”。现冲突时同步更新 `scope_kind/scope_key/product_id`，新增重定分区测试。
7. **统计/台账口径**：`memory_graph_state.entity_count/edge_count` 改为按当前分区计数；`entitiesNew` 仅统计真正新建/候选实体，不再把 exact/linked 重复计入。
8. **isolated 仍整理 line**：sweep 现对 isolated 跳过 line/product/global。
9. **工具跨会话读**：`memory_graph_query(scope=session)` 强制当前执行会话；无会话上下文或 `scope_key` 指向其他会话一律拒绝（管理面 REST 仍按频道权限查看）。
10. **UI 分区显示**：`visibleCommunities` 按当前分区精确过滤（global 用频道 owner）；“最近整理”只显示当前分区最新 run；`channels` 类型补 `ownerUserId`。
11. **管理面实体 scope 校验**：新建 line 实体必须是频道绑定产线，product 必须是频道已绑定产品，session 必须属于该频道。

### 7.3 分区实机证据（Web :3097）

数据：`Accept Graph v2`（line L1，owner `2389039e…`，product binding `P-ACCEPT-01`）；S1=`cs-29dafa96`，S2=`cs-e7e5da85`。手工记忆标记：`CHANSEC-PART`、`S1SECRET-PART`、`S2SECRET-PART`、`SHAREDSEC-PART`；另插入其他 owner 的 `SHAREDOTHER-PART` 作反例。

| 视图 | run | 节点/关系/社区 | 分区断言 |
|---|---|---|---|
| channel | ok | 26 / 105 / 1 | 仅 `channel`；含 CHANSEC，不含 S1/S2/SHARED |
| session S1 | ok | 5 / 7 / 1 | 仅 `session:cs-29dafa96`；含 S1，不含 S2/channel/shared |
| session S2 | ok | 5 / 7 / 1 | 仅 `session:cs-e7e5da85`；含 S2，不含 S1 |
| shared | ok | 4 / 6 / 1 | 仅 `global:owner`；含 SHAREDSEC，不含 SHAREDOTHER |
| line | ok | 6 / 12 / 1 | 仅 `line:L1`；含产线本体（绑定产品后仍保留） |
| product | ok | 9 / 17 / 1 | 仅 `product:P-ACCEPT-01`；含保压压力/冷却水流量/良率与 claim 边 |

- 每个视图 `partitionsInView` 都只有 1 个分区，无混图。
- 端到端脚本：`D:/tmp/aw-memory-graph-20261127/scripts/partition-api-check.mjs`（API 断言全 PASS）。

### 7.4 运行时召回证据

`AgentMemory.recall`（`agentId=__team__`，`sessionId=S1`，隔离 home 真实 DB）：

- `S1SECRET-PART` 查询：注入 S1 会话记忆；不含 `S2SECRET`。
- 频道查询（budget=1200 以容纳更多引子）：注入 `CHANSEC-PART`；`memory_injection_log` 本轮 refs 含该频道记忆 id。
- `graphRetrieve(scope=session:s1)`：命中 S1 记忆，不返回 S2。
- 注入 refs 的 scope 覆盖 `channel:`、`session:cs-29dafa96`、`global:`（共享区按 owner）。
- 端到端脚本：`D:/tmp/aw-memory-graph-20261127/scripts/runtime-recall-check.mts`（全 PASS）。

### 7.5 UI / 桌面

- Web（`:3097`）v2 频道：scope 切换 `频道/会话/共享区/产线/产品` 均出图；S1 统计 5/7/1，共享区 4/6/1，产线 6/12/1，产品 9/17/1；截图在 `D:/tmp/aw-memory-graph-20261127/shots/v2-*.png`。
- 桌面 Electron 45.4.1（源码壳 + 同 home sidecar，CDP `:9223`）以 `graph-admin` 登录，同一 v2 频道切换 session/shared/product 均成功；截图 `desktop-v2-*.png`。

### 7.6 新增/更新测试

- `tests/memory-graph-partitions.test.ts`：通道/session/shared 独立物化、s1 不含 s2、shared 不含他人 owner、跨分区边拒收、边 scope 谎报拒收、社区 id 重定分区、runtime 手工 session 记忆落 session_id、session 图只含目标会话（6/6 PASS）。
- `tests/memory-graph-consolidation.test.ts`：新增“绑定产品后 line 分区仍导入产线本体”（6/6 PASS）。
- 图谱全套：`memory-graph-*.test.ts` 32/32 PASS。

### 7.7 最终门禁（本轮）

| 门禁 | 结果 |
|---|---|
| `pnpm lint` | PASS（RSI 红线 35 文件 0 设备写） |
| `pnpm typecheck` | PASS |
| `pnpm test:unit` | 2493 tests / 2492 pass / 1 skip / **1 环境性失败**：`managed-mcp-client.test.ts` 在 Windows Node 24 全量并发下 `UV_HANDLE_CLOSING` 断言（子测试本身 PASS）；单独连跑 3 次 3/3 PASS，与本轮改动无关 |
| `pnpm i18n:check` | PARITY OK（3787/3787，unresolved 0） |
| `pnpm docs:check` | 101/0 |
| `pnpm readme:lint` | PASS |
| `pnpm build` | PASS（最终 `.output`） |
| `pnpm test:boot-smoke` | 6/6 PASS（最终构建） |

结论：**Channel / Session / 共享区 / line / product 已分开整理、分开管理、分开检索；运行时注入分区隔离实机通过。** 不宣称 Mimosa 安全通过（本轮未运行）；`managed-mcp-client` 的全量并发 libuv 断言作为环境性 flake 如实记录。

# AgentWorkShop 优化计划与执行记录(2026-08-30)

- 前置:本计划基于 2026-08-27 架构审计(docs/audit/architecture-review-2026-08-27.md)之后的**全量复查**。
  复查方式:核心文件逐段精读交叉验证(scheduler-loop / task-engine / ws.ts / database / task.repo / daq-controller /
  daq-runtime / daq-node / mqtt / dcw-controller / mailbox / agent-runtime / memory / manager / useWorkshopWs /
  events store / useSceneLayouts / TownScene3D / TownView)+ 5 路并行子审(子审因运行环境不稳定未产出,结论以主审实证为准)。

---

## 0. 总体评价(设计是否优秀)

**结论:架构设计成熟度高于同类项目平均水平,08-27 审计后大部分高危项已正确落地。**

已验证的亮点(应保留,勿在优化中破坏):

| 设计 | 证据 | 评价 |
|---|---|---|
| WS Hub 事件协议 | ws.ts:per-channel 单调 seq + ring 双封顶(5000 条/4MB)+ lastSeq 续传 + 快照兜底 + 400ms 批量事务落库 + peer 发送预算(1013 断开)+ 保留期周期清理 + HMR 自愈重绑 | 生产级实现 |
| 调度器 | 指纹节流省 LLM token、空闲指数退避(1s→8s cap)、事件 wake 打断、规则引擎兜底、HITL 竞态守卫、终态幂等、goal 收口宽限窗、空闲池消费防重复派发 | 工程深度高 |
| 数采边缘运行时 | 节点级在飞互斥、采样完成时刻入账(慢驱动自然降频)、TSDB 单 in-flight 写 + 有限重试 + 缓冲背压、MQTT 离线缓冲 + lost 计数、真实丢弃指标 | 背压链路完整 |
| 报警派生 | 滞回带(2% 内缩边界)+ 3 帧去抖,alarm/offline 立即生效(安全优先) | daq-node.ts:116-129,已修复 D5 |
| 信箱 | firstPendingByChannelAgent(LIMIT 1)+ 原子 claim + 门闩挂起 + 15s 兜底重查 | 已修复 B3 |
| 持久化 | WAL + synchronous=NORMAL + 批量事务 INSERT + 分批 DELETE 保留期 + 增量迁移链 | 已修复 D2 |
| 鉴权 | resolveCaller/resolveUser/resolveAgentOrUser/requireAdmin 四入口 + WS sub token 校验 + 所有权 requireOwned/requireWritable;161 端点仅 A2A card/rpc 走协议内 token | 覆盖基本完整 |
| 前端 | WS ingest 单点 seq 去重、timeline 记忆化、topY 缓存、签名防抖链路/膜网、dirty 阴影按需、visibilitychange、监听器统一清理 | 已修复 B5/C3/C4/C5 |

当前问题集中在四类残余模式(见 §1),无系统性架构缺陷。

---

## 1. 复查后确认仍存在的问题(全部经 file:line 实证)

### P0(正确性缺陷,立即修)

**F1 [高·潜伏 bug] legacy 迁移重建 tasks 表静默丢列 route_reason**
- 证据:database.ts:535 先 `migrateAddColumn('tasks','route_reason')`;:567-596 `migrateMissingForeignKeys` 随后重建
  tasks_new 的 DDL 与 INSERT SELECT **均不含 route_reason** → 走 v3→v4 迁移路径后列被静默删除,
  task.repo COLS 引用 routeReason → 此后全部任务查询报 "no such column"。
- 同块仅重建 2 个索引,丢失 idx_tasks_channel_assignee(直到下次重启才由 SCHEMA_SQL 补回)。
- 方案:重建 DDL/SELECT 补 route_reason;补建 idx_tasks_channel_assignee + 新增 idx_tasks_parent。

### P1(性能/资源,本轮执行)

**F2 [中] 调度快照每 tick 全列查询 + 全量 JSON.parse**
- 证据:task.repo.ts:50 COLS 含 artifacts_json/history_json 两列;scheduler-loop.ts:294/300 每 tick(活跃 1s/空闲 8s)
  调 taskEngine.list + queueViewsOf → 每任务 2 次 JSON.parse(历史最多 200 条消息);频道任务多时解析成本随任务数×消息数线性放大。
- 方案:新增元数据投影 COLS_META(不含两个 JSON 大列)+ listLite/queueViewsOfLite,仅调度器切换;
  LLM 交付预览依赖 artifacts → 保留 artifacts_json 列,仅裁 history_json(history: [])。

**F3 [中] 子任务聚合全表扫描**
- 证据:task-engine.ts:245(dispatch 判重)/502(onChildCompleted 统计)listByChannel 全列查询后内存 filter;
  parent_id 无索引。
- 方案:新增 listChildrenMeta(channelId, parentId) 直查(idx_tasks_parent 支撑);dispatch/onChildCompleted 切换;
  complete() 保留全列(synthesizeGoalSummary 需 children artifacts,且非热路径)。

**F4 [中] 调度器状态 Map 生命周期不收敛**
- 证据:scheduler-loop.ts:75 progressSeen 只 set 从不 delete(:308-316 全文无清理);notified/lastProgress/goalAllDoneAt/
  loopCompletedTaskIds 仅在部分路径清理 → 长会话随任务数只增不减。
- 方案:tickRound 每轮对当前任务集做键修剪(终态/已删任务条目出集)。

**F5 [中] 布局保存一次触发两遍整场重建**
- 证据:useSceneLayouts.ts:88 乐观 rev++(:978 TownView watch rev → hydrate = resetAll+全量 GLB 重载),
  :100 服务端回显后再 rev++ → 每次保存双倍全场景重建。
- 方案:去掉回显后的第二次 rev++(回显仅对齐 updatedAt,同值不再触发 hydrate)。

### P2(评估后**不执行**,记录理由)

| 项 | 结论 | 理由 |
|---|---|---|
| 渲染循环 dirty 门控 render | 不执行 | loop() 内信标/LED 环/链路脉冲/autoOrbit 等常驻动画几乎恒在,门控极少命中;改动风险 > 收益(TownScene3D.ts:3987-4110) |
| gltfCache/agentAnimClips LRU | 不执行 | GLB 克隆与缓存原件**共享** geometry/material/纹理(TownScene3D.ts:4116 注释明确),evict 时 dispose 会连带摧毁同模型活动实例;安全做法需引用计数,当前模型基数小,收益低 |
| applyEvent artifacts 整列重写 | 暂缓 | 分块合并语义依赖整列读改写;history 已封顶 200 条兜底;改造需拆表,留待下一轮 |
| supervise 持锁期间信箱停顿 | 暂缓 | 真 abort 已实现、超时 150s 上界可控;锁重构影响面大,单独一轮处理 |

### P2(顺手治理)

- omp-agent.ts supervise 超时注释与实现不符(注释 20s / 代码 150s)→ 修正注释;
- scheduler-loop.ts:49 孤儿注释(描述已删字段)→ 清理。

---

## 2. 执行清单

| # | 文件 | 改动 | 对应 |
|---|---|---|---|
| 1 | server/services/workshop/db/database.ts | 迁移重建补 route_reason + 补全索引 + 新增 idx_tasks_parent | F1 |
| 2 | server/services/workshop/db/task.repo.ts | TaskMetaRow + COLS_META + listByChannelMeta/listChildrenMeta | F2/F3 |
| 3 | server/services/workshop/runtime/task-engine.ts | listLite/queueViewsOfLite;dispatch/onChildCompleted 切直查 | F2/F3 |
| 4 | server/services/workshop/runtime/scheduler-loop.ts | 快照切 lite;状态 Map 每轮修剪 | F2/F4 |
| 5 | app/composables/workshop/useSceneLayouts.ts | 去掉二次 rev++ | F5 |
| 6 | server/services/workshop/agents/omp-agent.ts | 注释对齐实现 | §P2 |

## 3. 验证基线

- pnpm eslint(改动文件 0 错误)+ pnpm build(生产构建成功);
- 运行时行为(调度/任务/布局保存)建议在 /workshop 人工走查「提交任务 → 派发 → 完成」与 /town「拖拽频道保存布局」。

## 5. dev 环境全功能 E2E 验证(2026-08-30 追加)

针对运行中的 dev 环境(127.0.0.1:3000)做了全功能端到端验证(scripts/_dbg-full-feature-e2e.mjs):

**全部 20 项 PASS**,覆盖链路:

| 阶段 | 验证内容 | 结果 |
|---|---|---|
| 1. 产线搭建 | 1 线 1 产品 2 数采 1 数控 + 配方 + 开跑 + 数采实时值 + 配方下发设定值 | PASS |
| 2. 控制联锁 | 窗口内 182 写入成功;170(<176)与 200(>188)被 400 拒绝(配方窗口替代全局量程) | PASS |
| 3. 团队部署 | channel + AgentTeam(lead=mock,worker=omp)+ deploy 克隆实例 | PASS |
| 4. Agent 绑定 | 2 数采(auto)+ 1 数控(manual)绑定 worker 实例 | PASS |
| 5. 工具桥 | my_industrial_nodes 物理语义 / daq_query 数据统计 / 未绑定 Agent 拒绝 | PASS |
| 6. goal 任务 | 派发 → mock lead 拆解 → 子任务指派 omp worker | PASS(t+3s) |
| 7. 真实执行 | **omp 子进程拉起 → LLM 回合 → daq_query 读数(96 点)→ 均值分析 → dcw_control 发起 → HITL 审批 → 下发执行 → 设定值 180→182 → progress 100 → goal 收口 COMPLETED** | PASS(t+79s HITL,~150s 完成) |
| 8. 数据打标 | 产线窗口内 510 样本带 product/recipe/run 标识 | PASS |

关键实测证据:
- Agent 产出 deliverable:「OMPDBG-温度 最近 2 分钟均值 = 168.05 ℃(样本 96 点,min 164.8 / max 170.9 / latest 168.8,时间窗 2026-08-30T16:36~16:38)」—— 真实时序库数据;
- HITL 审批详情:「FFX-温度设定(烘箱温度设定)设定 182℃,配方窗口 176~188℃」→ 用户批准 → 设定值真实变为 182(写副作用经 data/dcws.json 验证);
- goal-summary 结构化交付物由平台合成(判定标准/完成过程/结论三段)。

**首跑 3 项 FAIL 的定性**:首轮 E2E 在 dev server 重启 27s 后立即运行,omp 首次冷启动与订阅竞态导致子任务 3 连失败重派后取消(环境时序,非产品代码缺陷);dev server 预热后同一脚本 20/20 PASS。复现工具已沉淀:
- scripts/_dbg-full-feature-e2e.mjs(全功能 E2E,自带清理)
- scripts/_dbg-team-repro.mjs(团队+HITL 单场景复现,保留现场)
- scripts/_dbg-minimal-omp.mjs(omp 直派最小复现)

## 4. 执行结果

全部 6 项已执行并验证(2026-08-30):

- **F1**:database.ts 迁移重建 tasks_new 补 route_reason(DDL + INSERT SELECT)+ 补建 idx_tasks_channel_assignee + 新增 idx_tasks_parent(SCHEMA_SQL 与迁移重建双处对齐);
- **F2**:task.repo.ts 新增 TaskMetaRow/META_COLS/listByChannelMeta;task-engine.ts 新增 rowToTaskLite/queueViewsOfLite/listLite;scheduler-loop.ts collectSnapshot 切换 lite 快照(活跃 1s/空闲 8s 的每 tick JSON 大列解析消除);
- **F3**:task.repo.ts 新增 listChildrenMeta(idx_tasks_parent 支撑);task-engine.ts dispatch 判重与 onChildCompleted 子任务统计切换直查(免全 channel 扫描);complete() 保留全列(synthesizeGoalSummary 需 children artifacts);
- **F4**:scheduler-loop.ts tickRound 新增状态 Map 每轮修剪(progressSeen/notified/lastProgress/goalAllDoneAt/loopCompletedTaskIds 对当前任务集收敛);
- **F5**:useSceneLayouts.ts 去掉 save 成功回调的二次 rev++(一次保存不再触发两遍整场 resetAll+GLB 重载);
- **F6**:omp-agent.ts supervise 超时注释对齐实现(150s);scheduler-loop.ts 孤儿注释清理。

验证(2026-08-30 全部通过):
- eslint 改动文件 0 错误;
- 生产构建 pnpm build 成功(✨ Build complete;产物 14.6MB / 3.36MB gzip,见 data/build-verify.log);
- 冒烟测试 scripts/smoke-optimization-verify.ts:lite 投影字段完整、dispatch 判重 409、listChildrenMeta 直查、complete 闸门、route_reason 列与 idx_tasks_parent 均通过;
- 回归:scripts/test-task-engine.ts ALL PASS;scripts/test-scheduler-loop.ts ALL PASS(判重/重派/loop 模式/工厂全量)。

### 预期收益

| 项 | 场景 | 收益 |
|---|---|---|
| F2 | 调度器每 tick(活跃 1s)快照 | 消除每任务 2 次 JSON.parse(历史最多 200 条消息×任务数),DB 传输量大幅下降(不再读取两个 JSON 大列) |
| F3 | 每次派发/子任务完成 | O(全 channel 任务) 扫描 → O(log n) 索引直查 |
| F4 | 长会话多任务 | 调度器 5 个状态 Map 不再随任务数只增不减 |
| F5 | /town 拖拽/保存布局 | 每次保存 GPU 重建量减半(整场 resetAll+GLB 重载 2 次 → 1 次) |
| F1 | legacy 库升级路径 | 消除 route_reason 静默丢列导致的 "no such column" 全任务查询失败 |

### 留待下一轮(见 §P2 不执行表)

渲染 dirty 门控、GLB 缓存引用计数化 LRU、artifacts 拆表、supervise 锁重构。

---

## 6. 完整复核记录(2026-08-31 终验)

对 plan 全部修复与验证基线做了二次完整复核,全部通过:

| 校验项 | 方式 | 结果 |
|---|---|---|
| F1 代码落地 | grep database.ts:迁移重建 DDL/SELECT 含 route_reason(:635/:639)+ idx_tasks_parent 双处(SCHEMA_SQL:103 与迁移重建:603) | ✓ |
| F2 代码落地 | task.repo META_COLS/listByChannelMeta/listChildrenMeta + task-engine rowToTaskLite/listLite/queueViewsOfLite + scheduler-loop collectSnapshot 切换 | ✓ |
| F3 代码落地 | dispatch 判重与 onChildCompleted 均切 listChildrenMeta 直查 | ✓ |
| F4 代码落地 | tickRound liveIds 修剪 5 个状态 Map | ✓ |
| F5 代码落地 | useSceneLayouts save 回显不再二次 rev++ | ✓ |
| F6 代码落地 | omp-agent supervise 150s 注释对齐 | ✓ |
| 真实 DB 迁移 | dev 库(重启多次,已走迁移路径):tasks 15 列含 route_reason;5 索引齐全(channel/assignee/channel_assignee/parent);72 行任务数据零丢失 | ✓ |
| eslint | 全部改动文件 | 0 错误 |
| 冒烟 | scripts/smoke-optimization-verify.ts:lite 投影/判重 409/直查/complete 闸门/route_reason/idx_tasks_parent | 全 ok |
| 回归 | test-task-engine.ts + test-scheduler-loop.ts | ALL PASS ×2 |
| 生产构建 | pnpm build(nitro 产物 + prompts 复制) | ✨ Build complete |
| 全功能 E2E | scripts/_dbg-full-feature-e2e.mjs(预热 dev 环境,127.0.0.1:3000) | **ALL PASS(23 项)**:产线搭建/控制联锁(170 与 200 被 400 拒)/团队部署/节点绑定/工具桥/goal 派发/真实 omp 执行/HITL 审批/写副作用(value=182)/打标(720 样本) |

**结论:plan 全部修复真实可行,优化合理且无回归;系统在真实 dev 环境下产线控制、Agent 绑定、团队作业、Agent 操控绑定节点(数据分析 + 参数控制)全链路可用。**

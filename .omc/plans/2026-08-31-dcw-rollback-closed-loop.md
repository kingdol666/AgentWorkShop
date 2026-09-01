# DCW 调控闭环与回退验证机制 · 实施计划 v2.1

- **状态**:pending approval(待用户批准后实施)
- **日期**:2026-08-31(v2.1 可行性终审版;v2 基础上按真实代码逐一核对挂接点后修正,差异见 §2.1)
- **设计依据**:`docs/design/dcw-rollback-closed-loop.md`(归档)
- **v2 核心变更**:按用户需求引入具名的 **RecipeRollBackManager + RecipeRollBackRepo**;
  设定历史全量在册;**两次优化之间的数采数据按窗口归属记录**;Agent 的 judge 成为记录的一等字段;
  优化记录进入**数采中心 /daq** 按 Recipe 查看;前后端联动 + 持久化 + Agent 驱动全链。

---

## 1. Requirements Summary

### 1.1 用户硬需求(验收一等公民)

| # | 需求 | 落点 |
|---|---|---|
| R1 | 创建 **RecipeRollBackManager** 并创建**对应 repo**,实现对 Recipe 设定的管理 | §4.1:manager 编排 + repo 持久化,两个具名文件 |
| R2 | Agent 设定参数后**记录设定的历史** | 每次 Agent 写 → JournalAnchor + OptimizationRecord(params from→to 全量在册) |
| R3 | **距离下次优化之间的数采数据**被记录 | 窗口归属语义:下次优化/判定发生时,上一条记录关闭并冻结 `[setAt → closedAt]` 全窗数采聚合 `windowAgg`(§4.3) |
| R4 | 记录 **Agent 对这次 step 的 judge** | `record.judge = { by: 'agent'\|'system'\|'user', verdict, reason, at }`;新工具 `dcw_judge`(§4.4) |
| R5 | **在数采中心 /daq 看到**对应 Recipe 的 Agent 优化记录 | /daq 页「Agent 优化记录」面板,按产线/Recipe/节点过滤,展开看窗口序列(§4.5) |
| R6 | **参数都记录在册** | journal 锚 append-only 无淘汰 + param-ledger 三值台账 + Recipe version/paramsHistory |
| R7 | **前后端联动、数据库持久化、Agent 驱动控制** | WS `dcw.optimization.changed`;/daq 与 /dcw/[id] 双端展示;repo 落盘 + restore();四个 Agent 工具全流程驱动 |

### 1.2 闭环定义(验收裁判标准)

```
Agent 设定(dcw_control) → 历史入册(anchor+record) → 窗口数采归属(record 开窗)
→ 判定(Agent dcw_judge / 系统 policy / 用户) → 优劣分流(keep / rollback)
→ 回退(Manager 经 write() 单点执行,同样入册) → 复盘(/daq、/dcw 台账、序列回看)
```
七环每环有结构化记录;**数据窗口跨到下一次优化**是 v2 的新语义(不是固定观察窗)。

---

## 2. v1 → v2 差异(为什么改)

| v1(Trial 模型) | v2(OptimizationRecord 模型) | 原因 |
|---|---|---|
| Trial 分散在 dcw-trial.ts,无 repo | **RecipeRollBackRepo** 统一持久化 anchors+records | 用户要求具名 manager+repo;repo/manager 分层对齐既有 dcw-*.repo 模式 |
| 固定 observeMs 观察窗 | **窗口归属制**:记录开于设定、闭于下次优化或判定,`windowAgg` 冻结全窗聚合 | R3"距离下次优化这之间的数采数据"是时段所有权,不是固定窗 |
| 判定=系统 policy 为主,Agent 无表达 | `judge.by='agent'` 一等字段 + **dcw_judge 工具**;系统判定降级为兜底 | R4:Agent 的 judge 是要被记录的主体 |
| 记录只在 /dcw/[id] 看 | **/daq 数采中心新增「Agent 优化记录」面板**(按 Recipe 过滤,序列展开) | R5:数采的人就在 /daq 工作 |
| 无 Recipe 维度 | record 必记 `recipeId`(取自该线活动 run,未开跑为 null) | R5"对应 Recipe 的优化记录"需要分组键 |

保留 v1 正确的部分:journal 锚(5s 去重/append-only)、三级回退、防乒乓护栏(cooldown/≤2 次自动回退)、
手动写 supersede、Recipe 版本链(paramsSnapshot/version/paramsHistory/lastGood)、
param-ledger 三值台账、restore() 崩溃恢复、作业环升级(七步)。

### 2.1 v2.1 可行性终审修正(挂接点逐一对码核实后的 9 处钉死)

| # | 修正 | 依据(对码) |
|---|---|---|
| F1 | **系统兜底判定的触发点 = 既有 `sweep()` 节拍**(不建新定时器);每条 open 记录到 `minWindowMs` 时评估一次,记 `evaluatedAt` 防重复 tsdb 查询 | dcw-controller.ts:85-97 `ensureLoop/setInterval(() => this.sweep(), SWEEP_MS)` 已存在 |
| F2 | **windowAgg 异步补齐**:关闭记录同步置 `closedAt/closedBy/judge`(发生在下一次写的 beforeWrite 路径),tsdb 聚合**异步**捕获后回填,期间 `aggPending:true` —— 聚合查询不得阻塞 PLC 下发 | 关闭动作在 write() 热路径上(dcw-controller.ts:360) |
| F3 | **omp 工具注册三处同步**:industrial-tools.ts 工具本体 + omp-agent.ts:115 `hostToolsForRole`(注入清单)+ invoke.post.ts:21(HTTP 桥 if/else)——漏一处工具即不存在 | 对码 omp-agent.ts:52/115、invoke.post.ts:21 |
| F4 | **record 来源矩阵**:record 仅两路创建——Agent `dcw_control`(source=agent)与回退执行(source=rollback);manual/recipe 路径只记锚不建记录;任何后续写(含 manual/recipe)都会关闭同节点既有 open 记录(closedBy=superseded/superseded-manual) | 与 R5"Agent 优化记录"口径一致,防记录爆炸 |
| F5 | **judge 只对 open 记录**;对已关闭记录 judge → 409(消息含 closedBy);`judge(uncertain)` 落判定字段但记录保持 open(直到下次设定/停线才关) | 语义钉死,防争议 |
| F6 | **回退目标越窗如实失败**:prevValue 可能已被新配方判为越窗 → 回退 write() 直接 400,失败如实上报并提示"先调整配方窗口",不静默绕过 | write() 单点门控是安全边界 |
| F7 | **write() 签名演进**:`write(id, eng, recipeRunId = null, meta?: { source, actor, taskId? })`;现状 dcw_control 是 `write(nodeId, value)` 两参(industrial-tools.ts:39)——Agent 写 runId=null 正是"变更无身份"根源,meta 补齐 | 对码 industrial-tools.ts:39 |
| F8 | **closeRecord 幂等**:仅 `status==='open'` 可关;并发写/判定竞态下后到者得 409 | 并发安全 |
| F9 | **taskId 尽力而为**:omp host_tool_call 上下文未必携带 taskId,`record.taskId` 允许空(agentId 必填已可归属) | 工具层事实 |

---

## 3. Acceptance Criteria(全部可测)

### M1 RecipeRollBackManager + Repo + 设定历史在册

- **AC1.1** 新文件 `server/services/workshop/dcw/recipe-rollback-manager.ts`(编排)与
  `recipe-rollback.repo.ts`(持久化)存在;repo 为单例(`getRecipeRollBackRepo()`),
  模式对齐 dcw-line.repo.ts:83(loadJson/saveJson + restore)。
- **AC1.2** repo 管理两个集合:`anchors[]`(append-only **无 cap**)与 `records[]`(cap 2000,超出丢最旧),
  落盘 `server/data/dcw-rollback.json`,flushDebounced ≤1.5s,启动 `restore()` 重放。
- **AC1.3** 任意成功 `write()`(dcw-controller.ts:360)且值变化 → 1 条 anchor
  `{nodeId, prevValue, newValue, source: manual|recipe|agent|rollback, actor, recipeRunId?, recordId?, at}`;
  同值 5s 内不重复(心跳防噪);四条写路径(手动/applyRecipe/lineStart/agent)全覆盖。
- **AC1.4** Agent 路径(`dcw_control`)写成功 → 自动创建 OptimizationRecord:
  `{id: opt-xxx, lineId, nodeId, recipeId(该线活动 run 的 recipeId,无则 null), agentId, taskId?(尽力而为,见 F9),
  params: [{nodeId, templateRef, from, to}], setAt, status: 'open', judge: null}`;
  **record 来源矩阵(F4)**:仅 agent 与 rollback 两路建记录,manual/recipe 只记锚。
- **AC1.5** **窗口归属**:同节点再次设定(任何来源)时,上一条 `open` 记录自动关闭(幂等,F8):
  同步置 `closedAt = 新设定时刻 / closedBy='superseded'`;
  `windowAgg` **异步**冻结 `[setAt, closedAt]` 全窗数采聚合(口径=runData:
  latest/avg/min/max/cnt/每通道 breaches),捕获期间 `aggPending:true`(F2),完成后回填落盘;
  窗口内数采序列可随时经 series API 取自 TSDB(记录存聚合,序列按需查)。
- **AC1.6** `windowAgg` 的通道选择:该节点 `deviceBindingId` 同挂的全部数采节点
  (dcw-node.ts:31 与 daq-node.ts:31 同域);无设备绑定 → 回退该线 `lineId` 全部数采节点;
  两者皆无 → `windowAgg.channels=[]`(记录仍成立, breaches=-1 标示不可判)。
- **AC1.7** Recipe 版本化:`createRun`(dcw-recipe.repo.ts:247)补 `paramsSnapshot`;
  活动批次外修改 params → `version+1` + 旧版入 `paramsHistory`(cap 20);`markGood(runId)` 可标 lastGood。
- **AC1.8** `GET /api/workshop/dcw/nodes/:id/param-ledger` 一次返回
  `{current, recipeTarget, lastGood, journal[], records[]}`(R6 参数在册的统一读口)。

### M2 判定/回退/数采中心联动

- **AC2.1** 新工具 `dcw_judge(record_id, verdict: keep|rollback|uncertain, reason)`:
  仅对 **open** 记录有效(F5,已关闭 → 409 带 closedBy);Agent 判定自己记录 →
  `judge={by:'agent',...}`;verdict=uncertain 落判定但记录保持 open;
  判 rollback 时**不直接执行**,返回回退预检(目标锚值/护栏状态),执行仍走 `dcw_rollback`(显式二段)。
- **AC2.2** 系统 policy 兜底判定挂**既有 `sweep()` 节拍**(F1,dcw-controller.ts:88,不建新定时器):
  open 记录到达 `minWindowMs`(缺省 120s)时评估一次并记 `evaluatedAt`(防重复查询):
  越配方 daqWindows(daq-controller.ts:191 同口径)累计 ≥3 采样 → judge={by:'system',verdict:'rollback'}
  且**自动执行回退**;无越限 → 不自动 keep(留给 Agent/用户,系统只兜底安全,记录保持 open);
  manual 绑定 → 系统只提议 HITL。
- **AC2.3** 回退执行(manager.rollbackRecord / rollbackNode / rollbackRun / rollbackRecipeGood):
  全部经 `write()`(source='rollback'),产生**新的** OptimizationRecord(`rollbackOf: 原recordId`),
  参数 from→to 反向入册(回退本身在册,AC1.3/1.4 同样适用);
  **回退目标越当前配方窗 → write() 如实 400,回退失败上报并提示先调配方窗口(F6),不静默绕过**。
- **AC2.4** 防乒乓:同节点回退后 cooldown 300s 内 Agent 同向写 409(消息含剩余秒数);
  每节点链自动回退 ≤2 次,第 3 次异常只提议 HITL;手动写永不阻塞但 supersede 当前 open 记录
  (closedBy='superseded-manual')。
- **AC2.5** **数采中心面板**:/daq 页新增「Agent 优化记录」区(复用页面既有 useDcwStream,daq/index.vue:19),
  按 产线/Recipe/节点 过滤,每条显示 参数 from→to(带单位)、judge(by+verdict+reason)、
  windowAgg 摘要(min/max/avg/breaches)、状态;点击展开调用 series API 画窗口内时序
  (复用 /daq 既有趋势画布组件),并提供「在 /daq 表格中定位时间窗」跳转。
- **AC2.6** `GET /api/workshop/dcw/optimizations?lineId&recipeId&nodeId&status&limit` 列表 +
  `/:id` 详情(含 windowAgg 与 judge 全文)+ `/:id/series?windowMs`(tsdb query,参数绑定)。
- **AC2.7** WS `dcw.optimization.changed`(opened/judged/closed/rolled-back)进 AepEvent 联合 +
  AEP_GROUPS.dcw(shared/workshop-protocol.ts);/daq 面板与 /dcw/[id] 台账实时收敛,免刷新。
- **AC2.8** /dcw/[id] 详情页:节点行展开「参数台账」(AC1.8 三值对照 + journal 时间线 + records 列表),
  当前 open 记录显示「进行中」条(设定值/开启时刻/实时 breaches)。
- **AC2.9** 持久化:kill dev → 重启 → repo.restore() 后 anchors/records 全量可查,
  open 记录保持 open 并在新设定/判定时正常关闭。
- **AC2.10** 降级判定路径:breaches=-1(无监控通道)的记录,系统不自动判定,
  judge 只能来自 Agent/用户(诚实缺省)。

### M3 Agent 驱动全链

- **AC3.1** 工具面四件套(industrial-tools.ts):
  `dcw_control` 追加 `{recordId, lastStable(上一稳定锚 prevValue), policyHint}`;
  `dcw_judge`(AC2.1);`dcw_rollback(record_id|node_id, to?)`(自己的记录直接执行,他人的走 HITL);
  `dcw_journal(node_id?|recipe_id?, limit)` 读在册历史。全部经 `/agent-tools/invoke` 桥可测。
- **AC3.2** `my_industrial_nodes` 语义卡追加:当前 open 记录 + lastGood + 最近 3 条 judge 结论。
- **AC3.3** `industrialLoopGuide`(industrial-context.ts:170)升级**七步作业环**:
  观察→理解→假设→设定(dcw_control,自动开窗)→**判定**(dcw_judge,窗口数据佐证;未判定前再设定,
  旧记录将被 superseded 并在台账可见——纪律条款)→回退/保持(dcw_rollback)→复盘(引用 record id)。
- **AC3.4** 经验注入:omp contextPrefix 追加该节点/配方近 5 条 OptimizationRecord 结论
  (参数/judge/原因),团队经验跨任务积累。
- **AC3.5** e2e(`_dbg-opt-team-e2e.mjs`):omp worker 真实设定 → record 开窗 → 注入越限 →
  worker dcw_judge=rollback → dcw_rollback 执行回退 ACK 回读一致 → /daq 面板(REST 断言)按 recipe
  查到全链记录(set→judge→rollback 三条 record,参数与 judge 字段完整)。
- **AC3.6** 零回归:重跑 `_dbg-dcw-audit` / `_dbg-final-acceptance` / `_dbg-final-full-e2e` 全绿
  (写路径被改动的强制证明)。

---

## 4. Implementation Steps(文件锚点)

### 4.1 R1 · RecipeRollBackManager + Repo(新组件,本计划的骨架)

**`server/services/workshop/dcw/recipe-rollback.repo.ts`**(持久化,哑层)
- 单例 `getRecipeRollBackRepo()`,对齐 dcw-line.repo.ts:83 模式;
- 数据:`server/data/dcw-rollback.json` = `{ anchors: JournalAnchor[], records: OptimizationRecord[] }`;
- API:`appendAnchor` / `insertRecord` / `closeRecord(id, patch)` / `listAnchors(filter)` /
  `listRecords({lineId, recipeId, nodeId, status, limit})` / `byId` / `openRecordOf(nodeId)` /
  `lastStableAnchor(nodeId)` / `chainRollbackCount(nodeId)` / `restore()` / `flushDebounced`;
- caps:anchors 无上限(append-only,AC1.2),records 2000 环形。

**`server/services/workshop/dcw/recipe-rollback-manager.ts`**(编排,唯一被外部调用的门面)
- `onWrite(meta)`——由 `DcwController.write()`(dcw-controller.ts:360)在 encode 前调用:
  记 anchor + 开新 record + 关闭同节点旧 open 记录(同步置 closedAt/closedBy,**windowAgg 异步回填** F2);
- `evaluateOpenRecords(now)`——**由既有 `sweep()` 节拍调用**(F1,dcw-controller.ts:91-97 的
  `setInterval(() => this.sweep(), SWEEP_MS)` 内追加一行;不建新定时器):到 minWindowMs 的
  open 记录做一次越限评估,记 evaluatedAt;
- `captureAgg(node, fromMs, toMs)`——通道选择(AC1.6)+ 聚合口径**上移复用** runData 的
  tsdb 查询段(dcw-controller.ts:717-737 抽为 `aggregateDaqChannels(nodeIds, from, to)` 公共函数);
- `judge(recordId, verdict, reason, by)`——Agent/系统/用户三路判定入口(AC2.1/2.2);
- `rollback{Record,Node,Run,RecipeGood}`——三级回退,全部经 `DcwController.write()` 反向下发(AC2.3);
- `ledger(nodeId)`——param-ledger 聚合读口(AC1.8);
- policy 解析:绑定 mode(auto→auto_rollback/manual→approve_rollback)← 产线覆盖 ← 缺省。
- **约束**:manager 不直接读写 JSON(repo 职责)、不绕过 write()(回退同门控)、
  tsdb 查询全部走既有 `getTsdb().query/queryTagged` 参数化接口(安全约束:严禁拼接 SQL)。

### 4.2 R2/R3 · 写路径挂接与窗口归属

1. `DcwController.write()` 签名加可选 `meta?: { source, actor, taskId?, recipeId? }`
   (缺省 manual/当前用户;writeRecipeParams 传 recipe+run;industrial-tools 传 agent+task);
   encode 前一行 `getRecipeRollBackManager().beforeWrite(node, eng, meta)`,
   ACK 后 `afterWrite(node, ok)`——锚的 prevValue 取写前 `node.value`,零额外 PLC 读。
2. 窗口关闭时机:同节点 beforeWrite 时;`dcw_judge`(rollback 判定即关)时;`lineStop` 时
   (封窗,防跨批次污染);closeRecord 幂等(仅 status==='open',F8);
   **windowAgg 异步补齐**(F2):closeRecord 同步返回,聚合由 manager 延后捕获回填,
   写热路径零 tsdb 等待;聚合失败 → `windowAgg={channels:[],degraded:true}`,不阻塞写。
3. Recipe 版本化:dcw-recipe.repo.ts 的 `createRun`(:247)/`update`/新 `markGood`,见 AC1.7。

### 4.3 R4 · 判定(Agent judge 一等公民)

1. `manager.judge()`:by='agent' 直接落 judge 字段;by='system' 仅 auto_rollback 的越限兜底(AC2.2);
   by='user' 走 REST `POST /dcw/optimizations/:id/judge` 与 HITL 复用同一入口。
2. 判 rollback ≠ 执行:返回预检(目标=lastStableAnchor.prevValue,护栏=cooldown/链计数),
   执行必须显式 `dcw_rollback` 或 HITL 批准——**判定与执行分离**,Agent 不能一步隐式改 PLC。

### 4.4 R5/R7 · 数采中心联动 + WS

1. REST(`server/api/workshop/dcw/`):`optimizations/index.get.ts`、
   `optimizations/[id].get.ts`、`optimizations/[id]/series.get.ts`、
   `optimizations/[id]/judge.post.ts`、`journal/index.get.ts`、
   `journal/node/[nodeId]/rollback.post.ts`、`runs/[id]/rollback.post.ts`、
   `recipes/[id]/rollback-good.post.ts`、`nodes/[id]/param-ledger.get.ts`;
   另 `recipes/[id]/mark-good.post.ts`。
2. WS:`shared/workshop-protocol.ts` 注册 `dcw.optimization.changed` 信封
   `{record 摘要 + 事件类型}`;manager 四个状态迁移点广播。
3. 前端:
   - `useDcwStream` 增 optimizations 状态与 ensureWsFeed 收敛(app/composables/workshop/useDcwStream.ts);
   - **/daq 面板**(app/pages/daq/index.vue,页面已挂 useDcwStream:19):「Agent 优化记录」卡片列
     (过滤器:产线/Recipe/节点;行:参数 from→to + judge 徽标 + windowAgg 摘要 + 状态;
     展开:series 序列图复用既有趋势画布 + 跳转定位);
   - /dcw/[id] 台账(app/pages/dcw/[id].vue):AC2.8。

### 4.5 R7 · Agent 驱动(M3)

1. 工具(industrial-tools.ts):`toolDcwControl`(:48,现调 `write(nodeId, value)` 两参,F7)
   改传 meta 并返回 record 信息;新 `toolDcwJudge` / `toolDcwRollback` / `toolDcwJournal`
   (鉴权对齐既有:绑定校验;他人记录的 rollback 走 ToolApprovals,kind='optimization_rollback');
   `my_industrial_nodes` 补 open 记录/lastGood/最近 judge(AC3.2)。
   **注册三处同步(F3)**:industrial-tools.ts 本体 + `omp-agent.ts:115 hostToolsForRole`
   (漏注册 = omp worker 看不见该工具)+ `invoke.post.ts:21`(HTTP 桥 if/else)。
2. 作业环七步重写 + 经验注入(industrial-context.ts:170 与 contextPrefix 组装处,AC3.3/3.4)。
3. `/agent-tools/invoke` 工具注册表补三新工具(server 端 invoke 桥)。

### 4.6 验证脚本(scripts/,对齐既有命名与风格)

| 脚本 | 覆盖 |
|---|---|
| `_dbg-rollback-mgr-audit.mjs`(M1) | AC1.1-1.8:锚/历史在册/窗口归属冻结/心跳防噪/四路径来源/ledger 三值 |
| `_dbg-optimization-e2e.mjs`(M2) | AC2.1-2.10:judge 三路/自动回退越限路径/防乒乓/supersede/series/WS/持久化重启/降级路径 |
| `_dbg-opt-team-e2e.mjs` + `-monitor.mjs`(M3) | AC3.1-3.5(omp 活体;worker judge→rollback 全链;/daq REST 断言;monitor 对齐 scenario-phase3 模式) |

---

## 5. Risks and Mitigations

| 风险 | 对策 | 残余 |
|---|---|---|
| 窗口过长(两次优化间隔数小时)聚合失真 | 关闭时聚合沿用 runData 降采样口径(>60s 自动分桶);序列按需查,不在记录里囤点 | 超长窗聚合仅概览级 |
| Agent 滥用 judge(乱判 keep 洗掉问题) | 系统越限兜底判定不受 Agent judge 覆盖(sweep 评估只看数据);judge 全量在册可审计 | — |
| 回退目标已被新配方判为越窗 → 回退写 400 | 如实失败并提示先调配方窗口(F6),不静默绕过;台账可见失败原因 | 用户需先改配方(正确的安全语义) |
| windowAgg 异步补齐期间面板读到空聚合 | `aggPending` 标志显式暴露,UI 显示「聚合计算中」;series 按需查询不受影响 | — |
| 判定与执行分离增加回合数(omp 回合贵) | dcw_judge 返回预检+dcw_rollback 可同回合连续调用(工具串行);auto_rollback 场景系统直执 | 慢 provider 下多一回合 |
| 同节点高频设定(实验抖动) | 5s 锚去重 + superseded 关闭;窗口极短(<minWindowMs)的系统兜底判定不触发 | 记录数量多(cap 2000 可调) |
| 手动写与记录互踩 | 手动写不阻塞但 supersede(closedBy=superseded-manual),台账可查 | — |
| 持久化写放大 | flushDebounced ≤1.5s;records cap 2000;anchors 小记录追加 | 崩溃丢最后 ≤1.5s 锚(保守方向,可从 PLC 回读) |
| SQL 注入面(tsdb 序列查询新增参数) | 全部走既有 getTsdb 参数化接口,**严禁字符串拼接 SQL**(实现验收条件) | — |
| 既有写语义回归 | write() 只加两行钩子调用 + meta 可选参;AC3.6 强制重跑三个既有终验 | — |
| purge 级联与记录的关系 | 节点/产线 purge **不删** journal/records(审计留痕),records 里 nodeId 失效显示为「已删除节点」 | — |

---

## 6. Verification Steps

1. **M1**:`_dbg-rollback-mgr-audit.mjs` —— mock 驱动 + HTTP 真链路,逐条断言 AC1.1-1.8
   (含真写用例:mock PLC 175→raw1000 回读一致后 anchor/record 字段核对)。
2. **M2**:`_dbg-optimization-e2e.mjs` —— AC2.1-2.10;越限构造=写超配方窗上界后观察数采回值或临时缩窗;
   持久化用例=杀 dev 重启断言 restore;WS 用例=原生 WebSocket 收帧(对齐 _dbg-dcw-pause-tpl-audit 风格)。
3. **M3**:`_dbg-opt-team-e2e.mjs`(REST 工具面 + omp 活体)+ `-monitor.mjs`(慢回合重挂观察);
   UI 目视:/daq 优化记录面板 + /dcw 台账截图存档 docs/audit/screenshots/。
4. **回归**:AC3.6 三脚本全绿后才允许提交。
5. **安全自查**:tsdb 相关新增查询逐条核对参数绑定(Mimosa 约束)。

## 7. Execution Order & Scope Guards

- 顺序:M1(manager/repo/锚/历史/ledger)→ M2(判定/回退//daq 联动)→ M3(Agent 工具/作业环/omp e2e);
  每里程碑独立提交,验收不过不进下一里程碑。
- **明确不做**:参数 git 分支/merge;全量节点快照;自动寻优算法;多参数配方聚合记录
  (本期 record 粒度=单节点设定;配方 apply 仍只记锚,配方级聚合评估留下期);
  daq 采样节拍与 TSDB schema 改动(series 全走既有查询面)。
- 数据文件入库约定:dcw-rollback.json 随现有 server/data/*.json 约定处理。

---

*计划结束。批准后按 M1 起实施;每里程碑交付可运行的验证脚本与截图证据。*

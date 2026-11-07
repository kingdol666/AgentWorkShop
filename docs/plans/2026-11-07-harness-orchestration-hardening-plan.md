# Harness 编排稳定性加固计划（ralplan · 待批准）

> 状态：**待批准（pending approval）** —— 本文件为计划产物，未实施任何代码改动。
> 约束：**整体作业思想与架构大框架不变**（Project=路由枢纽 / Channel=协调执行 / mailbox+HITL+记忆域 / 根 FIFO 按 Channel），只修 bug、补鲁棒性，确保执行过程稳定。
> 依据：2026-11-07 两轮三域代码审查（含 文件:行号 锚点）+ 当日四套件实机 PASS 记录（unit 1164/0、session-ui-live、project-task-instance-live、line-integration-live 20 步）。

---

## 0. RALPLAN-DR 摘要

**Principles（原则）**
1. 架构不动：所有修复落在既有边界内（claim/回收/读面/容量/记忆戳），不引入新层。
2. 先修「可用性级」再修「正确性级」：能导致任务永久卡死/状态不收敛的优先。
3. 每项修复必须带可执行验收（新增 live 断言或单测），不允许"改完即信"。
4. 默认行为保守：容量等参数默认值不变，可配面先加开关后调参。
5. 安全侧 fail-closed：审批/绑定/回收在异常分支一律拒绝而非放行。

**Decision Drivers（决策驱动）**
1. 并发窗口造成的状态损坏（双建实例/attemptNo 撞唯一索引→永久 BLOCKED）是当前唯一能"杀死任务"的缺陷族。
2. 生命周期卫生（会话 close 不 abortTask、回收 403 被吞、僵尸 clone 可被重新寻址）会造成资源泄漏与状态不收敛，随项目规模线性放大。
3. 实例成员读面空集与容量硬编码直接限制「跨任务协作 + 并行吞吐」——即用户关注的三项改进。

**Viable Options（≥2 方案与取舍）**
- 方案 1（推荐）：**就地加固 + 可配开关**——派发 claim 事务化、生命周卫、读面对称、容量走既有 settings 注册表。改动面 ~8 文件，全部在既有模块内。
- 方案 2：引入持久化 dispatch 锁表（新表+迁移）获得更强并发保证——否决：新表与迁移扩大变更面，且既有 CAS+唯一索引已够用；仅在方案 1 验证不足时回退考虑。
- 方案 3：只做参数调优（放宽并发）不动代码——否决：并发窗口缺陷会在更高频率下更容易触发（放大 P0 族），顺序必须是"先修竞态、后放容量"。

---

## 1. 三项改进的可行性结论（逐项，代码级）

### 1.1 容量闸可配 ✔ 可实现（低风险）
- 现状：`server/services/workshop/projects/service.ts:1534` `const limits = { perChannel:1, perProject:4, perTick:2 }` 写死。
- 可行性事实：项目已有 settings 注册表先例（`agents` 侧 `workshopSettings().supervise_watchdog_ms` 等，`runtime/agent-runtime/supervise.ts:33-34`），新增键零架构成本；limits 只在 `doAutoDispatch` 内使用（:1536-1537），读上下文即可取到配置。
- 最小改动：settings 增加 `dispatch_per_project / dispatch_per_tick`（缺省 4/2，`perChannel` 保持 1 不动——每实例 Channel 单根是硬约束）；`projectObservability` 透出 effective limits。
- 风险：无（默认值不变，纯增量开关）。

### 1.2 实例成员读面对称修复 ✔ 可实现（低风险）
- 现状：读面按 `w.channelId === ctx.channelId` 过滤（`service.ts:2846 / 2910 / 2929`），实例成员（ctx=实例 Channel）恒空集；提交侧已双通道（`:2969`）。
- 可行性事实：工作项行同时持有 `channelId` 与 `instanceChannelId`，等价条件 `w.instanceChannelId === ctx.channelId` 即可；实例 Channel 是项目专属（`binding_type='task_instance'`），读自己项目行无越权面扩大。
- 最小改动：三处过滤表达式补第二通道；排查 brief/read_deliverables 等其余读面（若有同模式一并处理）。
- 风险：越权面——需在验收中加"跨项目读取仍被拒"的阴性断言。

### 1.3 契约图并行度放宽 ✔ 可实现（中低风险）
- 机制事实：`technical` 门下上游成果验收后才放行下游（`service.ts:487-488`）；**同层无依赖任务本就并行**——`autoDispatchProject` 是同项目 promise 串行链（`:1487-1504`），链内每轮 `doAutoDispatch` 重选就绪项并按 `perTick` 派发（串行的是"派发决策"，不是"执行"；执行并行度由实例 Channel 数决定）。
- 结论：**放宽并行度的唯一闸门就是 1.1 的 perProject/perTick**（`perChannel=1` 不得动）。改配后吞吐近线性直到资源面（agent 运行时进程数/CPU/内存）成为瓶颈。
- 量化：现状单项目 ≤4 并发任务、每 tick 新增 ≤2；调至 8/4 即单项目 8 并发、每 tick 4 新增。
- 风险：资源耗尽（运行时进程膨胀）——默认值不变 + 验收加资源观测（wiredAgents/进程数）。

---

## 2. 漏洞清单（按严重度，全部带锚点）

### P0 族：并发窗口导致状态损坏（优先修）
| # | 问题 | 锚点 | 触发 | 影响 |
|---|---|---|---|---|
| P0-1 | 实例 Channel/会话创建在 CAS claim **之前**且手动路径不走 `autoDispatchChains` → 手动+自动并发派发同一工作项双建实例，败者留启用态**孤儿实例 Channel**（终态回收只停用最终指向的那个） | `service.ts:1033 vs 1045-1052`；`:874-877`、`:3212/3223` | 同一工作项被手动派发与内核 tick 同时选中 | 资源泄漏、观测污染、回收不收敛 |
| P0-2 | 并发下 attemptNo 双双 `max+1` → `UNIQUE(work_item_id, attempt_no)` 冲突异常被归入"无 attempt"分支 → 工作项置 **BLOCKED（永久）**，不可重试 | `service.ts:1045-1052 + 1108-1118`；schema 唯一索引 | 两个派发入口并发 | 任务永久卡死（唯一"杀死任务"缺陷） |

### P1 族：生命周期/正确性（高价值）
| # | 问题 | 锚点 | 影响 |
|---|---|---|---|
| P1-1 | 会话 close 只 `cancelTree` 不 `abortTask/wake`；忙 clone 运行时 + pending 信箱使空闲清扫永不回收 → **僵尸克隆运行时**（任务实例路径有 enabled=0 兜底，**手动会话无**） | `session-clone.ts:117-124`；`runtime-wiring.ts:281-313`；对照 `tasks.ts:516-520` | 进程泄漏、被取消任务继续跑 |
| P1-2 | 实例成员读面空集（=1.2） | `service.ts:2846/2910/2929` | 跨任务协作失明 |
| P1-3 | omp 压缩摘要未打平台 sessionId（injection-v2 验收清单内、同类三项已完成，唯此漏传） | `context-governance.ts:187`（不传）→ `workspace.ts:58-61` → `governance.ts:20-42`（入参已声明） | 会话记忆域不闭环，`scope=session` 恒不命中 |
| P1-4 | `recipe_apply` 未传 `agentTrialMeta` → Agent 互斥/回退冷却方向性被跳过 + 审计归因弱化（trial 有、apply 无） | `dcw-controller/recipes.ts:273-275` | 治理护栏不对称 |

### P2 族：收敛/安全/体验（可并入同轮）
| # | 问题 | 锚点 |
|---|---|---|
| P2-1 | 回收时实例 Channel 行缺失或 owner=null → 403/404 被静默吞掉，会话永久 active、每轮空转不收敛 | `service.ts:1188-1214`、`admin-channel.ts` |
| P2-2 | HITL 裁决资格在 `!manager || !channelId` 时**静默放行**（应 fail-closed） | `hitl-decision/visibility.ts:39` |
| P2-3 | 未挂线节点可绑进已绑线频道（一致性检查仅在 targetLine 非空时生效） | `agent-tools/bindings/index.post.ts:62-67` |
| P2-4 | memoryPolicy 为未消费预留字段但已透出 DTO/前端类型（配置欺骗） | `sessions/index.get.ts:32`、`[sid]/index.get.ts:36`、`useWorkshopApi.ts:97` |
| P2-5 | 已关闭会话的 clone 成员行仍 enabled=1，可被按 id 重新装配（需会话状态守卫） | `session-clone.ts:84`、`runtime-wiring.ts:139-148` |
| P2-6 | 人类频道任务 `submitChannelTask` 不带 sessionId → 会话上下文注入不生效（仅项目根/手工会话带） | `tasks.ts:31-42` |
| P2-7 | 无 `GET /sessions/:sid/messages` 端点，前端拉全频道 500 条再本地过滤；history 上限 200 口径不一致 | `SessionManageView.vue:110-113` |
| P2-8 | 会话消息/任务之外的审计行无 session 维度字段（close 动作除外） | `admin-agents.ts:367` |

### P3 族（观察项，不在本轮主修）
- 保写心跳 fire-and-forget 持锁悬挂风险（`dcw-runtime.ts:140-146`）；审批历史 expiresAt 展示失真（`tool-approvals.ts:396`）；omp-dialog 人工附言不回注（`dispatcher.ts:51-58`）；scenarioPrompt 频道级/无会话个性化（S3 范畴）；`dcw-recipe.repo.ts:83` 未挂线节点静默收编。
- 稳定性专项确认（非缺陷）：启动恢复链完整（`restore()` + `projectReconciler` 30s + `reconcileHitlOnStartup`，`server/plugins/workshop.ts:39/47/99/275`）；监督看门狗 90s/硬超时 900s 且默认**只记录不 abort**（`supervise.ts:33-34,52-54`）——属设计，但需在验收中确认"硬超时能收口卡死回合"。
- 待复核项：omp `promptTimeoutMs 600s` + 重启后 session 不重绑（历史缺陷，需确认现状；若仍在，纳入 P1 修复）。

---

## 3. 修复方案（Work Packages，架构不变）

### WP1 派发原子化（修 P0-1/P0-2）——最高优先
- **设计**：把"实例 Channel/会话创建"移入 CAS claim 成功之后；手动派发路径接入同一 claim 守卫（`assertClaimable`）；`attempts.create` 的唯一冲突显式映射为 `WORK_ITEM_IN_FLIGHT`（可重试语义），不再落入无 attempt → BLOCKED 分支；对"已创建但 claim 失败"的窗口加回收（复用 `releaseTaskInstance`）。
- **不动**：根 FIFO、实例 Channel 模型、容量闸逻辑。
- **验收**：①并发双派发同一工作项 → 恰 1 个 attempt、另一侧收到 `WORK_ITEM_IN_FLIGHT`（不 BLOCKED）；②观测面无 enabled 态孤儿实例（新加 sweep 断言）；③`project-task-instance-live` 扩展 2 步并发用例全 PASS。

### WP2 生命周卫（修 P1-1/P2-1/P2-5）
- **设计**：`closeChannelSession` 对每个 clone 补 `abortTask + wake`（对齐 `tasks.ts:516-520` 口径）；回收侧 403/404 分支改为「行缺失→跳过并记 warn；owner=null→用 admin actor 强制收敛」；`ensureAgentRuntime` 增加「所属会话已 closed 则拒绝装配」守卫。
- **验收**：①手动会话关闭 → 60s 内 `wiredAgents` 不含该 clone、无 pending 信箱；②删除实例行后回收不空转（观测日志一次 warn 后收敛）；③关闭会话的 clone 按 id 寻址装配被拒。

### WP3 实例成员读面对称（=1.2，修 P1-2）
- **设计**：三处过滤补 `|| w.instanceChannelId === ctx.channelId`；排查其余读面同模式。
- **验收**：①实例 lead 调 `project_read_work_items/read_results` 返回本项目非空行；②跨项目读取仍拒（阴性断言）。

### WP4 容量可配 + 并行度（=1.1+1.3）
- **设计**：settings 新增 `dispatch_per_project / dispatch_per_tick`（缺省 4/2）；`perChannel` 保持 1；`projectObservability` 透出 effective limits；默认值不变。
- **验收**：①配置改为 8/4 后，6 个无依赖任务在 ≤2 tick 内全部派发、6 实例 Channel 同时在飞（时间窗重叠证据）；②默认配置下行为与今日完全一致（回归）；③wiredAgents/进程数在观测中可见。

### WP5 记忆与审计戳（修 P1-3/P1-4）
- **设计**：压缩摘要补 sessionId——在 `workspace.ts:58-61` 桥内按 `channelId + status='active' + instance_kind='manual'` 反查 memberMap 含当前 agent 的会话 id；查不到（base 成员）保持 `''`（语义本正确）。**守卫**：必须过滤 `instance_kind='manual'`，避免办公室 lead 恒等映射（`service.ts:655`）被误盖。`recipe_apply` 补 `agentTrialMeta`（与 trial 同构）。
- **验收**（对齐 injection-v2 PR-B §3.4）：①本会话 `scope=session` 检索命中压缩摘要；②另一会话不命中；③auto 档同会话 +0.15 加权生效；④base 成员摘要仍为 channel 级（阴性）；⑤`recipe_apply` 审计行 actor=agent。

### WP6 收敛与安全小项（P2-2/P2-3/P2-4，各 ≤10 行）
- HITL 可见性异常分支改 fail-closed（503/403）；绑定一致性对 targetLine 为空也生效；memoryPolicy 从 DTO/前端移除（列保留，S3 恢复透出），plan 文档记一行。

### WP7 验证总闸（Gate）
- 全量：unit（1166 基线不减）+ 四套件（session/project/line/projects-smoke）+ console-interactions；新增单测覆盖 WP1/WP2/WP5 的不变量；一次重启演练（运行中重启 → 无重复 root 执行、无 BLOCKED 遗留）。

---

## 4. 预演（Pre-mortem，3 场景）

1. **WP1 事务化引入死锁/串行度下降**：claim 扩大事务范围后与回收/观测查询互锁。缓解：事务只包 claim+attempt 插入（毫秒级），实例创建移出事务并失败回收；压测双派发 50 轮。
2. **WP4 容量放开导致资源耗尽**：高并发实例 Channel 带来运行时进程爆炸/OOM。缓解：默认值不变；先加观测与上限钳制（如 perProject≤16）；演示先 8 并发观察 wiredAgents 与内存。
3. **WP5 补戳改变召回排序引发行为漂移**：新行带 session_id 后 auto 加权生效。缓解：严格按 injection-v2 §3.4 验收门；保留"旧行 `''` 仍可见"的兼容断言；必要时开关回退。

---

## 5. 扩展测试计划（deliberate 模式）

- **Unit**：claim 并发（WP1）、close×abortTask（WP2）、sessionId 反查与守卫（WP5）、effective limits（WP4）。
- **Integration**：既有四套件全量 + 新增并发/读面对称断言。
- **E2E**：6 任务并行演示（时间窗重叠 + 双实例 + 读面可见）；手动会话关闭无僵尸；重启演练。
- **Observability**：effective limits、孤儿实例 sweep 计数、wiredAgents 前后差、delivery 状态分布。

---

## 6. ADR

- **Decision**：按 WP1→WP2→WP3→WP4→WP5→WP6 顺序就地加固，全部落在既有模块边界内；容量参数先加开关后调优。
- **Drivers**：P0 状态损坏族优先；生命周卫防线性泄漏；三项改进依赖既有 settings/读面/容量锚点。
- **Alternatives**：dispatch 锁表（否决：迁移面大、CAS+唯一索引已够）；纯调参（否决：先放容量会放大竞态）。
- **Why chosen**：最小改动面（~8 文件）覆盖全部 P0/P1；架构零变化；每项带可执行验收。
- **Consequences**：默认行为不变；新增一次性配置键；WP5 会改变召回排序（受验收门约束）。
- **Follow-ups**：S3 会话记忆域（memoryPolicy 两档 + 项目级记忆域绑一个验收单元）；P3 观察项按需清理。

---

## 7. 验收总规范（Definition of Done）

1. 全部 P0/P1 项的验收断言实机 PASS（归档 bench/results）。
2. 回归零新增失败：unit 1164/0、四套件 PASS、console-interactions 9/9。
3. 默认配置下行为与加固前逐项一致（对比截图/行为差异清单为空）。
4. 并发测试无孤儿实例、无 BLOCKED 遗留；重启演练无重复执行。
5. 每项修复的 commit 带 `Constraint/Rejected/Confidence/Scope-risk/Not-tested` trailers（OMC 提交协议）。

---

## 8. 二次评审核验（外部 harness 评审六项断言）与计划补充（2026-11-07 晚）

### 8.1 逐项核验结论（逐条读码，不采信转述）

| 外部评审断言 | 核验结论 | 代码证据 | 处理 |
|---|---|---|---|
| omp 进程重建后 sessionId 永不重绑（P0，修好可消 90% 僵滞） | **部分确认，严重度降级**：重建后 sessionId 只在「建连时一次 + 压缩时刻」刷新（`client.ts:94,103-112`；`context-governance.ts:98-105` 的 get_state 仅在 usage≥70% 阈值时执行；`probeUsage` 不提取 sessionId）。但 **prompt RPC 完全不携带 sessionId**（`core.ts:84`、`tools-steer.ts:274/527` 均为 `{type:'prompt',message}`）→ 该字段仅用于 continuity 观测记账，**不构成任务路由/执行阻塞** | 同上 | 降级为观测项 **WP10（P2）**；「90% 僵滞消失」不成立——僵滞主因在停滞看门狗语义与 busy-skip（见下两行） |
| promptTimeoutMs 默认 600s 杀长生成，应入设置面 | **部分确认**：主回合路径是**静默看门狗**（事件刷新，`tools-steer.ts:470-478` 注释“整轮无任何 omp 事件时中止…只拦真僵死”）；supervise 兜底路径 `core.ts:66-73` 的定时器是**不刷新的硬超时**；阈值只在 per-agent config（`types.ts:24`），未入 `workshopSettings()`（settings.ts 仅有 supervise_watchdog_ms/root_timeout_ms） | 同上 | 新增 **WP8（P1）**：入设置面 + 语义文档化 + 按 harness 默认
| D1 救援在长驻实例上未触发 / idle sweeper 疑似未跑 | **部分确认**：sweeper 已启动（`server/plugins/workshop.ts:348`，interval/grace 可配）；救援实现完整（`runtime-wiring.ts:412-500`：5min 滞留阈值（env 可调）/忙碌跳过/10min 冷却/复读防双投/预算刷新）。**真实盲区是 busy-skip**——lead 状态卡 busy 时救援永跳过（`runtime-wiring.ts:437-441`），而 hard timeout（900s）若 abort 未生效则状态永 busy | 同上 | 新增 **WP9（P1）**：busy-stuck 检测（受控 rewire，健康长回合不误杀）
| rescue terminate→rewire→steer 靠外部脚本拼，应固化 ensureChannelActive(force) | **不成立（已过时）**：救援已内化 unload→ensureChannelActive→refreshDeadline→assign，并带 2026-10-30 复读防双投（`runtime-wiring.ts:455-500`） | 同上 | 仅补 ops/API 触发入口 → **WP11（P2）**
| 会话戳（压缩摘要/memoryPolicy） | 已确认 | 本计划 WP5 | 不变
| 容量闸硬编码 | 已确认 | `service.ts:1534`；本计划 WP4 | 不变

### 8.2 新增 Work Packages

- **WP8 停滞看门狗参数化（P1）**：`workshopSettings()` 增 `harness_stall_timeout_ms`（缺省沿用 600s，仅 omp 生效）；per-agent `promptTimeoutMs` 保留为覆盖；supervise 兜底硬超时与主路径静默看门狗分开命名（`harness_supervise_hard_timeout_ms` 既有键复用）；设置文档写明语义。**验收**：①配置 120s → 静默挂死回合 120s 内 abort；②持续有事件的 15min 长回合不被杀（不误杀）；③默认配置行为与今日一致。
- **WP9 busy-stuck 救援（P1）**：`rescueStaleRoots` 增分支——lead busy 且 `lastUsedAt`/活动信号超过 `hard_timeout×2` 无推进 → warn + 走既有 unload→ensure→复读→assign 受控 rewire；以活动信号（非 busy 本身）判惰性，健康长回合不触发。**验收**：①模拟“事件停摆且 abort 无效”的卡死 busy → N 分钟内恢复；②健康长回合不误杀（演练断言）；③救援动作入审计。
- **WP10 连续性观测补全（P2）**：`ensureClient` 建连后 + 每次回合起点轻量 get_state 刷新 sessionId（失败静默不影响回合）；`continuity.sessionId` 与 harness 内 id 正确绑定。**验收**：重启演练后 continuity sessionId 非空且与 get_state 一致；观测面（运行时监控）可见。
- **WP11 rescue ops 入口（P2）**：暴露受权 ops/REST 触发同一救援路径（含审计）。**验收**：REST 触发后滞留根入场，审计留痕，无重复投递。

### 8.3 排序调整（覆盖 §3 顺序）

**WP1（claim 原子化）→ WP2（生命周卫）→ WP3（读面对称）→ WP4（容量）→ WP5（记忆戳）→ WP8（看门狗）→ WP9（busy-stuck）→ WP10（观测）→ WP11（ops 入口）→ WP6（安全小项）→ WP7（验证总闸）**。
理由：外部评审主张的「omp 重绑 P0」经核验降为观测项（不阻塞主链）；P0 仍是 WP1；WP8/WP9 才是「长任务能否完成」的两个真闸门。

### 8.4 实施前复核演练（Gate 前置，量化基线）

先做一次**重启 × 长任务演练**：构造 15min 长回合 + 中途 kill omp 进程 → 记录：①回合是否被静默看门狗误杀；②任务是否按治理重派而非丢失；③continuity 归因（sessionId/restartReason）；④最终是否 COMPLETED 或合法终态。作为 WP8/WP9/WP10 的 before/after 对照；修复后演练 3 次全绿方可通过 WP7 总闸。

*本计划为 ralplan 产物，待批准。批准后建议按 §8.3 顺序以 ralph/team 下发执行；未批准前不做任何代码变更。*

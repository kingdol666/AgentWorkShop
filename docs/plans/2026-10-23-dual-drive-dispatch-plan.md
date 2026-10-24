# AML×Optimizer 双驱动双校验与最佳候选下发 —— 实施计划 v2

日期：2026-10-23。前置：`docs/plans/2026-10-22-optimizer-process-model-plan.md`（v3.1，已交付 67/67 + Live 90/90 + 重启 7/7）。
状态：**已被总计划取代**——三席第二轮终修 8 条与 GPT F1–F6 整合后，执行账本为 `docs/plans/2026-10-23-optimizer-master-plan.md`（§3 含本计划 D1–D15 终修版）。本文件保留两轮评审历史与论证。

## 0. 目标与非目标

**目标**：把"两条并行且各自自洽的推荐链"收敛为互证后的合流链：

```
Optimizer 求解 → 候选
  ① 证据接通:工件级 UQ(val 校准/test 实证) → unverified→verified
  ② 候选互校:同一工件双实现一致性(逐 CV 无量纲) → 互校一致(计算态,不改不可变 status)
  ③ 治理下发:互校一致 + 批准时刻六项重验 → 结构化审批卡 → 既有 DCW/HITL 写链
```

**非目标**：不新增设备授权通道；模拟产线验证；人始终在环；第三方求解器插件化另立计划（只出附录 A 设计稿）。

## 1. 设计决策（评审后定稿）

| # | 决策 | 取代 v1 的什么 |
|---|---|---|
| D1 | **互校通过门 = 逐 CV 无量纲数值一致性**：`dev_j = max_t\|Δy_j(t)\| / max(norm.y.std[j],1e-9) ≤ tol`（tol 默认 1e-6，可配）。**禁止**用 `z·residual.std` 作通过带（那是模型对真值的拟合噪声，比双实现偏差宽 3-6 个数量级 = fail-open）。顺带修 `problem-builder.ts:320-327` 既有 `dynamics.rollout` 绝对 1e-6 的量纲依赖 | v1 W2.2 的 uqBand 一级门 |
| D2 | **UQ 带降级为证据展示**：工件 `uq = { qhatPerCv[], coverageTest, nTest, nRuns, calibratedAt, horizon }`；`qhatPerCv` 取 **val 段**逐 CV 经验分位数 `⌈(n_val+1)(1−α)⌉/n`（α=0.1，工程单位）；`coverageTest` 在**独立 test 段**实测；**emit 条件**：`nTest≥120`（一步样本）且 `nRuns≥2`，否则不写 uq 字段 → 维持 unverified（fail-closed） | v1 W1.1 的单段自证写法 |
| D3 | **verified 门限分块修正**：`coverageTest ≥ 0.9 − 3·√(0.09/nBlocks)`（nBlocks=test 段 run 数；替换固定 0.8 硬门），写入 `classifyRecommendation` | v1 W1 的固定阈值 |
| D4 | **inputDistance 最低充分集 = MV + CV 双偏移**：`max( max_m\|(u_m−μ_u)/σ_u\|, max_j\|(y_j−μ_y)/σ_y\| )`（σ 取 artifact.norm.u / norm.y；context 与工件同经 v2 单位换算）。守卫：任一 `σ≈0` → 距离 ∞；`norm.*.length` 与 mvOrder/cvOrder 不符 → 返回 null（降级 unverified，不伪造） | v1 W1.2 只看 MV |
| D5 | **证据单源**：移除 `manager.uqEvidenceOf()`（读 metrics_json 的旧路径），唯一来源 = 模型工件 `uq` 字段 + artifactHash 快照进建议行，杜绝双证据路径 | v1 未写明的现状 |
| D6 | **互校态是计算字段，不改不可变 status**：`RecommendationStatus` 枚举不变（verified/unverified/expired）；`dual` 态由 crosscheck 表**最新 pass 行**派生（latest_crosscheck 联查），展示 label =「互校一致(同一工件双实现)」。失效规则：建议过期 → dual 随之失效；模型 artifactHash 变化 / binding revision 变化 → 既有 crosscheck 行保留但标注 `stale`，需重新互校 | v1 W2.3 改 status 枚举的方案 |
| D7 | **互校输入锚定 = run 冻结快照**：一律用 `optimizer_runs.context_snapshot_json` 的 history/controls 重建 predictor 输入（模型单位），按 **nodeId 重排列序**（predictor 要 allNodes 序，context.history 是 spec.variables 序）；`history` 前段 NaN → verdict=fail（不抛异常）；predictor steps 被 clamp 到 io.horizonSteps → 与 candidate.predicted 长度不等 → 422；行内记录 context hash + inputDistance 快照。工况已变时**允许**互校但结果标注 `conditionChanged=true`（与 dispatch 门解耦） | v1 未定义 |
| D8 | **互校防污染**：互校前强制 `aml_models.artifact_hash == rec.model_artifact_hash`（模型被替换不得给旧建议盖章）；互校服务**禁止**写任何 `twin_*` 表（Twin Gate G6 按 twin_trials 计数，防污染门禁） | v1 未写明 |
| D9 | **dispatch 身份与闸序**：审批卡一律以建议所属 binding 的 agent 实例名义挂单（复用 hitl 触达身份域）；REST 用户经 `assertAgentAccess` 取得"代发"资格，不把自己塞进 agentId 参数。服务 actor 抽象 `{kind:'agent'|'user', id, label}` | v1 未写明 |
| D10 | **完整闸序复用**：dispatch 门 = 提取后的 recipe-propose 服务完整闸序（运行门/二级认证、可读线、配方参数面、`boundInRecipe`、AML 活动互斥、op-interval、在飞去重）+ 新增：`controlNodeId ∈ 目标配方 recipe.params`、工况未变谓词（§D12）、preflight(skipRecipe:false)。步限/60s/保持窗豁免与 recipe_propose 等价（整包语义既有设计；首步幅度受 spec MV effectiveDomain + 配方窗 preflight 约束）——写明等价声明 | v1 的 6 项简表 |
| D11 | **证据防伪**：dispatch REST body 只接受 `recommendation_id`(+备注)，出现任何证据字段 → 422；payload 全部由服务端按 id 落库回查构造（recommendation 行 + crosscheck 最新 pass 行 + `crosscheck.model_artifact_hash == rec.model_artifact_hash` 强制）；卡面展示 id/hash 截断值供人回查，渲染文本不作事实源 | v1 W3.4 |
| D12 | **"工况未变"机器可判定谓词**：活动 LineRun 的 `recipeId/recipeVersion` 未变 ∧ `rec.problem_ir_hash == 当前 spec 发布版本 content_hash`（建卡与批准两时刻都用它） | v1 A5 无定义 |
| D13 | **批准时刻六项重验（fail-closed）**：approve 回调强制依次重验 ①互校一致且建议未过期（显式 `assertRecommendationUsable`，不接受惰性状态）②`resolveBinding(run.binding_id)` active ③D12 谓词 ④`controlNodeId` 复检（存在/启用/同线/∈配方参数面）⑤AML 活动互斥复检 ⑥preflight 复跑；任一失败 → 该批准**按拒绝收敛**（沿用 normalizeRecipeProposeDecision 口径），卡置 denied + comment=具体原因 + 不落 dispatchedAt + notifyLineOperators + recordOps。grant 复核传 `toolName='recipe_propose'`（防 revalidateApprovedAction 对未知 toolName 静默放行） | v1 W3.5 只写"批准→DCW 写" |
| D14 | **原子幂等与撤权收敛**：`dispatched_at` 用单条 `UPDATE ... WHERE id=? AND dispatched_at IS NULL` 原子抢占（changes=0→409，一次性不回滚）；在飞去重按 nodeId 等值（`optimizer-recipe:<recipeId>` 天然覆盖跨建议同配方）；`revokeBindingForUser` 追加 `cancelPendingFor('optimizer-recipe:<recipeId>')`；`tool-approvals.lineIdOf()` 正则扩展 `optimizer-recipe:` 前缀（否则产线操作员定向通知静默丢失） | v1 W3.5 |
| D15 | **迁移与 retention**：`optimizer_recommendations` 新列 `dispatched_at/approval_id` 走 `migrations.ts` addColumn（CREATE IF NOT EXISTS 不升级既有表）；crosscheck 表 FK `ON DELETE CASCADE` 自 recommendations；`db/retention.ts` 补 crosscheck 条目 | v1 只改 schema.ts |

## 2. 工作流与文件级任务

### W1 证据接通（unverified → verified）

| # | 任务 | 文件 |
|---|---|---|
| W1.1 | 训练器 UQ：**q̂ 取 val 段**逐 CV 分位数、coverage 在 test 段实测；linear-arx 复用 test 段 rollout 残差（`linear-arx.ts:230-244` 已有 rolloutPred/Actual）算逐 CV rollout 分位 `qhatRolloutPerCv`（供互校证据展示）；static-response **开始消费其闲置 val 段**（`static-response.ts:95-97`）；emit 条件见 D2；写 `uq{qhatPerCv,qhatRolloutPerCv,coverageTest,nTest,nRuns,calibratedAt,horizon}` | `process-model/trainers/{linear-arx,static-response}.ts`、`index.ts`（停写 metrics.uq） |
| W1.2 | `uq-evidence.ts`：D4 的 MV+CV 双偏移 inputDistance + D2 的 freshness（新设置 `aml.uqFreshDays` 默认 7）+ D3 分块修正门 | 新 `optimization/uq-evidence.ts`、`shared/config/schema.json`+settings+i18n |
| W1.3 | manager：**删除 `uqEvidenceOf()`**，改调 uq-evidence（D5）；证据快照（含 artifactHash）进建议 `uqEvidence` JSON | `optimization/manager.ts` |
| W1.4 | OOD 硬门：inputDistance>3 → unverified(reason=OOD)；逐变量数值进快照可审计 | `recommendation.service.ts` |
| W1.5 | 旧 ONNX / 无 uq 字段工件 → 维持 unverified；阈值单点定义并注明与 twin 口径差异是有意的（领域席 [6]） | 同上 |

### W2 候选互校（verified → 互校一致，计算态）

| # | 任务 | 文件 |
|---|---|---|
| W2.1 | 新表 `optimizer_candidate_crosschecks(id, recommendation_id FK CASCADE, run_id, model_id, model_artifact_hash, context_hash, input_distance_snapshot_json, predicted_json, replayed_json, dev_per_cv_json, tol, max_dev_dimensionless, qhat_rollout_per_cv_json, verdict, condition_changed, stale, reason, created_at)` + 索引 + retention 条目 | `db/database/schema.ts`、`db/retention.ts` |
| W2.2 | 互校服务：D7 快照锚定+列序重排+steps 断言+NaN→fail；D1 逐 CV 无量纲一致性门（tol 可配 `optimizer.crosscheckTol` 默认 1e-6）；D8 防污染；同 recommendation 追加新行（不可变） | 新 `optimization/crosscheck.service.ts` |
| W2.3 | **不改 status**：`getRunStatus`/`optimizer_plan_get`/REST runs 联查最新 crosscheck 行派生 `crosscheck:{verdict,stale,conditionChanged,maxDev,tol}`；label「互校一致(同一工件双实现)」仅展示层 | `run.repo.ts`、`contracts.ts`、`optimizer-tools.ts` |
| W2.4 | REST `POST /api/workshop/optimization/recommendations/:id/crosscheck`（editor/admin + 建议归属 binding 的 agent 可见性）；先决校验失败 422/409 可定位 | 新 REST、`rest-auth` 口径复用 |
| W2.5 | spike 单测先行：predictor 与 simulateLinear 在 fixture 上 `dev_per_cv < 1e-9`（锁同源不同实现），通过后才接运行时 | `tests/optimizer-uq-crosscheck.test.ts` |

### W3 治理下发（互校一致 → 审批卡 → 既有写链）

| # | 任务 | 文件 |
|---|---|---|
| W3.1 | Spec 扩展 MV `controlNodeId`：parse 与 publish 双处校验（DCW 节点存在/同 spec.lineId/与该 MV 数据节点同线/发布后不可变） | `process-model/{spec,contracts}.ts` |
| W3.2 | 提取 `recipe-propose-service.ts`：actor 抽象 D9；完整闸序 D10；6 处 agentId 耦合点（assertRecipeOperation/agentOpsScope/节点绑定/recordOps/approvals.request/revalidate）参数化；工具改薄壳，行为逐字节不变（既有 e2e 回归护栏） | `agents/industrial/recipe-propose-tools.ts`、新 service |
| W3.3 | `dispatch.service.ts`：门 = D10 完整闸序 + `controlNodeId∈recipe.params` + D12 谓词 + `lineIdOf()` 正则扩展（`optimizer-recipe:`，修通知丢失）+ 在飞去重；body 防伪 D11；包 = 首步 MV→`{node_id:controlNodeId,to,basis:'optimizer-recommendation:<id>',exp_ref:runId}`；审批卡 payload 双侧证据 = 服务端落库回查（rec 行 + crosscheck pass 行 + hash 强制相等）；审批超时语义沿配置（默认 30min） | 新 `optimization/dispatch.service.ts`、`tool-approvals.ts`（lineIdOf/cancelPendingForBinding 扩展） |
| W3.4 | 批准时刻：D13 六项重验组挂入 approve 回调（dispatcher 归一化按 payload 形状已自动生效，无需新注册）；grant 复核 toolName='recipe_propose'；拒绝收敛 + 双通知 + recordOps | `hitl-decision/dispatcher.ts` 挂点、`dispatch.service.ts` |
| W3.5 | 数据与审计：`migrations.ts` 加 `dispatched_at/approval_id`（D15）；原子抢占 D14；recordOps `optimizer.dispatch.request/approve/reject/execute`（detail: recId/crosscheckId/approvalId/runId）；UI 建议行「互校」「申请下发」按钮（仅互校一致可点）+ zh/en | `db/database/migrations.ts`、`run.repo.ts`、`app/pages/optimizer/index.vue` |

### W4 收尾与遗留

| # | 任务 | 文件 |
|---|---|---|
| W4.1 | horizon 清理（**三份** profile home 的 `prompts/host-tools.json`：`.AgentWorkShop/`、`.aw0746-home/`、`.demo-home/`）+ `SolveOptions.horizon`（contracts）+ optimizer-tools/manager 参数 + 相关测试 | 上列文件 |
| W4.2 | Timescale `queryTaggedPage`（游标分页+state+ingested_at，与 SQLite 对齐） | `daq/storage/timescale.adapter.ts` |
| W4.3 | A18 刷新时序实测（omp≤5s/bridge≤15s 各 1 次入证据）；A9 试验计划浏览器点击 | `e2e-optimizer-live.mjs` |
| W4.4 | 附录 A：SolverAdapter↔optimizer 打通设计稿（不实现） | 本文件附录 |

### W5 验收（机器可判定，新增 `scripts/e2e-dual-drive.mjs` + `tests/optimizer-uq-crosscheck.test.ts`）

| ID | 断言 |
|---|---|
| A1 | W1 单测：coverage 达 D3 门+fresh+distance≤3 → verified；q̂ 与 coverage 分段证明（val 校准/test 实证，两段不相交）；样本不足(nTest<120 或 nRuns<2) → 不发 uq → unverified；σ≈0 → ∞；旧 ONNX → unverified |
| A2 | 真实链：solve → uqEvidence 非空含 artifactHash → verified；建议行无 metrics_json 依赖（W1.3 生效） |
| A3 | spike：predictor vs simulateLinear `dev_per_cv<1e-9`；crosscheck pass → 最新行 pass + 派生互校一致；构造偏差超 tol → verdict=fail、建议仍 verified、plan_get 标注 fail；steps 不等 → 422；NaN → fail |
| A4 | 不可变/重放：同 rec 二次 crosscheck=新行；同 rec 二次 dispatch=409（原子）；**不同 rec 同配方在飞 → 409**；模型 artifactHash 变化后 crosscheck → stale 标注 |
| A5 | 过期/工况变/撤权：互校允许但标注 conditionChanged；dispatch 门 409/422 可定位；撤权 → 建议过期 **且** `optimizer-recipe:*` 在飞卡被收敛（cancelPendingForBinding 扩展生效） |
| A6 | dispatch 门与防伪：unverified→403；verified 未互校→403；互校一致→200+卡出现（nodeId=optimizer-recipe:*）+ payload 双侧证据；**body 携带任何证据字段→422**；构造 dev 超带行后 dispatch 卡展示 fail/被 422 |
| A7 | 审批闭环与批准重验：批准→DCW 写+回读复核语义不变；**批准时建议已过期/工况已变/AML 活动已开启/绑定已撤 → 零写 + 卡收敛为拒 + comment 可定位 + 双通知**；hold 模式下过期路径文案指引"重 solve→互校→再 dispatch" |
| A8 | spec.controlNodeId：DAQ 节点冒充/跨线/缺失 → 发布或 dispatch 422 可定位；∈配方参数面校验生效 |
| A9 | 授权：非成员 crosscheck/dispatch 403；admin 放行；模板 id 422；`lineIdOf('optimizer-recipe:x')` 返回正确产线（通知可达） |
| A10 | UI：互校一致徽章 + 按钮态 + zh/en parity；无 pageerror |
| A11 | 回归：67/67 验收、344+ 单测、live 90/90（horizon 移除后同步更新）全绿；gates 全 0；recipe_propose 既有 e2e 逐字节不回退 |
| A12 | 证据：`docs/audit/evidence/2026-10-23-dual-drive/*.json` + 截图；两份既有 audit 报告更新 |

## 3. 里程碑

- M1 = W2.5 spike + W1 + W2（证据+互校）→ 可演示 verified / 互校一致
- M2 = W3（下发接线 + 批准重验 + UI）→ 可演示审批卡全链与六项重验
- M3 = W4 + W5 全量回归 + 二席复核 APPROVED 收口

## 4. 风险与对策（评审后更新）

| 风险 | 对策 |
|---|---|
| predictor 与 simulateLinear 语义漂移使互校恒 fail | W2.5 spike 先行（<1e-9 才继续）；D1 的 tol 可配但默认数值精度级，杜绝 fail-open |
| 小样本 conformal 无效（留出段单批自相关） | D2 emit 条件（nTest≥120 且 nRuns≥2）+ D3 分块修正门；不足即不发，fail-closed |
| 双写者（optimizer 下发 vs AML 活动） | D13 批准时刻复检 AML 互斥（同时修复既有 recipe_propose 的同窗口缺口） |
| controlNodeId 越权 | W3.1 双处校验 + `∈recipe.params` + D13 ④ + grant 复核 toolName 钉死 |
| 15min TTL < 30min 审批窗 | D13 批准时刻重验为唯一权威（过期即拒收敛，fail-safe）；A7 断言体验路径 |
| horizon 移除破坏调用方 | 三份 home 清单 + SolveOptions + 测试同步；`additionalProperties:false` 使残留字段显式报错 |
| 新列破坏既有实例 | D15 migrations.ts 加列（新表无此问题） |

## 5. 明确不做

第三方求解器插件执行（只出附录 A）；真实产线/无人自动下发；混合整数/离散切换；旧 ONNX 工件的互校一致（证据不可得，维持 unverified）。

## 6. 修订账本（v1 → v2）

三席评审 26 条意见全部吸收：架构席 12 条（[2]分段校准→D2；[5]逐 CV rollout 分位→W1.1/W2.1；[6]冻结快照回放→D7；[7]lineIdOf/cancelPendingForBinding/actor 抽象→W3.2/W3.3/D14；[8]migrations→D15；[9]计算态派生→D6；[10]TTL 体验→A7；[11]horizon 三份清单→W4.1）；领域席 7 条（[1]BLOCKER 逐 CV 无量纲门→D1；[2]样本量下限→D2/D3；[3]CV 偏移→D4；[4]防污染与 label→D8/W2.3；[5]输入锚定→D7；[6]阈值单点→W1.5；[7]stale 生命周期→D6/A4）；治理席 7 条（[3]BLOCKER 批准时刻六项重验→D13；[1]完整闸序→D10；[2]证据防伪→D11；[4]原子幂等/撤权收敛→D14；[5]AML 互斥批准复检→D13；[6]controlNodeId 四层防越权→W3.1/W3.3/D13；[7]审计链/谓词定义→W3.5/D12）。

## 附录 A：SolverAdapter↔optimizer 打通设计稿（不实现）

`registerSolverAdapter`（TS async solve）与 Python worker 的打通需要：worker 协议增加 `solve_adapter` 帧（插件适配器以子进程注册表形式提供）或 TS 侧适配器直连（绕过 worker 池，租约沿用 env-lease）。推荐后者起步：`SOLVER_REFS` 扩为注册表驱动，`problem-builder` 输出 ProblemIR 后按 solverRef 解析 adapter，worker 仅保留内置两个。验收沿用 A21 门控矩阵。另立计划评审后实施。

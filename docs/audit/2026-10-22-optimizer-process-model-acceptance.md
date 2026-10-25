# Optimizer Manager 与 Process Model Service —— 实施与验收报告

日期：2026-10-22。计划：`docs/plans/2026-10-22-optimizer-process-model-plan.md`（v3.1）。
分支：`tii-revision-20261017`（基线 `7c8f4e7a`）。本文只记录**本轮实际执行**的工件与证据；未执行的项明确标注。

## 1. 结论

| 门禁 | 结果 | 证据 |
|---|---|---|
| 系统验收 A1–A22（进程内 + 真实 Python solver + SQLite/Timescale） | **67/67 通过** | `docs/audit/evidence/2026-10-22-optimizer-process-model/acceptance.json`（`pass=67,total=67`，含 5 条真实门禁 exitCode；hash 见文件头） |
| Live 全链（隔离实例 + 真实 HTTP + 真实浏览器 + Channel 矩阵 + 多场景 + AML 适配 + 闭环收益） | **90/90 通过** | `docs/audit/2026-10-23-optimizer-live-e2e.md`；`docs/audit/evidence/2026-10-23-optimizer-live/report.json`（修复 5 个真实前后端缺陷后） |
| 重启持久性（同一 home 重启后规格/Profile/绑定/求解） | **7/7 通过** | `docs/audit/evidence/2026-10-23-optimizer-live/restart-check.json` |
| 单元/集成测试 | **344/344 通过**（新增 10 套：契约/表/时序/Adapter/训练器/绑定/作业成功/Python 求解/环境租约/工具面授权） | `npx tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit tests/*.test.ts` |
| 类型检查 | 通过 | `npm run typecheck` |
| Lint | 通过（全仓 0 error） | `npx eslint .` |
| i18n 双语完整性 | 通过（zh 2981 = en 2981，未解析 key 0） | `node scripts/_i18n-verify-keys.mjs` |
| 文档一致性 | 通过（91/91；设置项 124/19 组、live/restart 40/84、宿主工具 91） | `npm run docs:check` |
| 生产构建 | 成功；`.output` 内含 prompts、`aml-python`、`optimizer-python`（worker/problems/probe，已排除 `__pycache__`） | `npm run build` |

计划范围为 G1→G6；本轮按文件级任务完成全部六个阶段，并补了计划 B.8/B.9 的 17 项工具注册面与 Worker 运行面。

## 2. 交付面（按阶段）

### G1 契约与地基

- `process-model/contracts.ts`：`ArtifactKind`/`ModelInterface` 判别联合（未知类型 `UNSUPPORTED_ARTIFACT`）、`ProcessModelSpec`、`ConditionSpec`（exactly-one）、`ManifestV2`。
- `optimization/contracts.ts`：`OptimizationProfile`/`OptimizerBinding`/`ProblemIR`/`SolveResult`；`computeProblemIrHash` 排除 `capturedAt`，同问题同 hash。
- `db/database/schema.ts`：新增 10 张表（specs/segments/eligibility/experiments/profiles/bindings/runs/candidates/recommendations/outcomes），全部在主库（备份/retention 同一连接）。
- `db/database/migrations.ts`：`aml_datasets/aml_jobs/aml_models` 判别列 + `twin_recommendations.legacy` 回填 `twin_v1`。
- `aml/model-references.ts`：删除模型前扫 channel profile / training plan / optimizer profile / 在途租约 → `409 MODEL_IN_USE`。
- `aml/env-lease.ts`：进程内读租约 + 跨进程 `runtime/env.lock`；持租约重建 → `ENV_BUSY`。
- TrainingAdapter/ObjectiveAdapter 真实注册（不再是 accepted 占位）：`resolveTrainingAdapter('linear_arx@1')` 返回实现，未注册返回 null。
- `agent-tools/list` 用户路径补 Channel 可见性（非成员 403）。

### G2 数据与模拟辨识

- TSDB：`queryTagged` raw 返回真实 `state`（SQLite + Timescale 的 `query()/latest()`）；`ingestedAt` 首写胜出 + `daq_correction_dropped` 计数；保留清理改用「事件时间 + 入库时间」双条件；新增 `queryTaggedPage`（SQLite 完整实现，Timescale 见遗留项）。
- 数据集：`buildDataset` 逐节点分页取数、尊重 `fromMs/toMs`；manifest v2 写 `timestamps/mask/sidecar` 且全部进入 hash，v1 hash 算法不变。
- 配方版本：`ActiveLineRun.recipeVersion`、`RecipeRunView.recipeVersion`、`eda_runs.recipe_version` 真实写入；`process_context_segments.content_hash` 覆盖 paramsSnapshot + daqWindows + access + version + id。
- 模拟器：`CastFilmModel` 延迟队列未到达时保持上一有效输出；truth 行新增 `tSim`；首版强制 `timeScale=1`（模拟器自测 21/21）。
- 两个内置训练器（TS，配置驱动）：`linear_arx@1` → `linear_state_space@1`（A/B/C/D + bias + 延迟 + 残差校准）；`static_response@1` → 响应面系数。
- 作业成功语义两阶段：staging → 校验 → rename → DB 注册 → `done + model_id`；注册失败不再产生假成功；AML 状态机 `ALLOWED_TRANSITIONS` 守卫（done 只能从 evaluating/provisioning）。
- 资格：`predictionEligible` / `optimizationEligible` 分离；恒定 U、混杂、共线、仅 ACK/失败动作均拒绝并给可定位缺口。

### G3 Python Solver

- `optimization/python/{worker,problems,probe}.py`：长驻 NDJSON，stdout 仅协议帧（OSQP C 层输出被 fd 重定向屏蔽）；请求 ID、协作取消；SciPy SLSQP + OSQP 1.1.3。
- `worker-client.ts`：有界池（默认 1，上限 4）；预占槽位避免并发 `SOLVER_BUSY`；硬超时、退出确认（5s）、崩溃补位、连续失败降级；线程预算注入（OMP/OPENBLAS/MKL/NUMEXPR），不继承 secrets。
- `problem-builder.ts`：全时域跟踪 + 终端 + Δu 的同一 ProblemIR；`simulateLinear` 与 Python 同口径（含 `bias`）；Solver 代价与平台独立重算相对差 2.6e-16。
- `manager.ts`：resolve → build → solve → verify → persist → recommend；约束/有效域独立复算。
- `recommendation.service.ts`：缺 UQ/OOD 一律 `unverified`，`inputDistance` 缺失不再乐观按 0。

### G4 Agent runtime

- 5 个 `optimizer_*` 工具（capabilities/solve/status/cancel/plan_get）落 `host-tools.json`（宿主工具 86→91）+ 处理器表。
- `optimizer-gate.ts`：legacy/训练档位明确拒绝；无绑定 `BINDING_NOT_FOUND`；capabilities 允许无绑定。
- `catalog.ts` 注入面、`per-agent.ts` 按绑定裁剪（无绑定不含 solve/status/cancel/plan_get）、`tool-verify` 新增 binding/run/recommendation 归属类别、`grant-guard` 从 binding 解析目标线。
- `aw-mcp-bridge.mjs`：签名覆盖 `parameters`，空表不再被旧表掩盖（`baselineReady`）；`HarnessCapabilities.toolRefresh`。
- `agent-tools/list` 授权收紧（C15）。

### G5 UI

- `app/pages/optimizer/index.vue`：规格/变量/工况、资格缺口、Profile 发布、绑定、运行/建议；未验证建议醒目标识；侧边栏与中英 key 齐备。
- 页面与 Agent 共用同一 REST 服务层（`/api/workshop/process-model/*`、`/api/workshop/optimization/*`）。

### G6 验收

- `scripts/acceptance-optimizer-process-model.{ts,mjs}`：A1–A22 逐条断言，证据 JSON 含 commands/versions/hash/limitations。
- 新增 10 套测试（见 §1）。

## 3. 验收矩阵摘要（A1–A22）

| ID | 结果 | 关键实测 |
|---|---|---|
| A1 | PASS | 分页 246 点无漏无重；sidecar 篡改 hash 变化；Timescale 写入/raw state 正确 |
| A2 | PASS | 恒定 U、仅 ACK 均拒绝；激励充分模拟数据 gap=none |
| A3 | PASS | ARX a=0.3001/b=0.6998（真值 0.3/0.7）；rollout 改善 99.7%；阶跃起点 firstMove=2=d |
| A4 | PASS | SciPy u*=3（1e-4）；OSQP 残差 1.4e-14；Solver vs 独立代价 diff 2.95e-16 |
| A5 | PASS | infeasible 可判定；超时 → SOLVE_TIMEOUT 且池恢复；取消 A 不影响 B |
| A6/A17 | PASS | 模板 id 拒绝；他人 binding 拒绝；撤权即拒；缺 UQ → unverified |
| A7 | PASS | osqp/scipy 可用；horizon=20 100 次 p95=692ms（≤1s） |
| A8 | PASS | 延迟 FOPDT 闭环（20 种子、只应用首步）：中位误差改善 94.8%，95% 下界 10.81；响应面经济代价改善 42.2% |
| A9 | PASS | 模拟线试验计划；真实线 `SIM_ONLY_VIOLATION`；solve 零 DCW 写入且持久运行/建议 |
| A10 | PASS | 新增 10 套测试齐备；既有 AML/Twin/DCW 套件保留 |
| A11 | PASS | 第三留出场景（新 id/变量名/单位/两个 stage 工况）通过；同训练器可训练 |
| A12 | PASS | 新工件 io_spec/loader 分派；v1 hash 兼容；作业两阶段成功 |
| A13 | PASS | 结构化 hash 随配方内容变化（`33123574bd` vs `bc8a54e716`）；谱系段记录配方 id/版本/内容 hash；`stage` 工况 `CONDITION_FIELD_UNSUPPORTED`；跨配方（`rc-other`）访问触发 `CONDITION_MISMATCH` 失效；真实链 `lineStart(R1)→applyRecipe(R2)` 后活动窗口、TSDB 样本标签、谱系段三者同步为 R2 |
| A14 | PASS | 发布不可变；被引用模型拒删；资格按模型自身 `dataset.spec_ref/spec_version` + 产线作用域溯源（同线另一规格报告不放行）；dispatch 复核 `mpc_optimize` → `OPTIMIZATION_NOT_ELIGIBLE`；无绑定 `BINDING_NOT_FOUND` |
| A18/A21 | PASS | 5 工具注册面 + 计数 91/91；legacy/训练档位拒绝；schema-only 与空表刷新签名 |
| A19 | PASS | 新表在主库；`retention.optimizer_days/process_model_days=365` |
| A20 | PASS | i18n 双语齐备；证据含 commands/versions/hash |
| A22 | PASS | requirements 锁 osqp；`.output` 含 aml-python 与 optimizer-python；同一解释器/lock |

## 4. 独立评审后的修复（四轮往返，终审 APPROVED）

首轮独立评审判 CHANGES REQUIRED，以下为已修复项：

1. **OSQP 丢失 D 直通**：`problems.py` 的灵敏度矩阵未含 `D·u`；已补入 predicted/约束/成本路径，D≠0 场景与 TS 一致。
2. **Δu Hessian 重复计数**：原实现对同一对角项累加多次，OSQP 未最小化声明目标；改为按 MV 的二阶差分矩阵 `P += 2r·DᵀD, q += 2r·Dᵀc`。
3. **资格/求解 fail-open**：删除 `allowIneligible/allow_ineligible`；资格作用域必须与产线 `simulated` 一致；`actionEvidence` 不再由调用方自报（模拟线 = simulation_commanded，真实线 = unknown，fail-closed）。
4. **REST 越权**：solve/capabilities/bindings/runs 增加 Agent→Channel 归属校验（admin 或 Channel 成员），全局列表仅 admin。
5. **取消与 revision**：Manager 用 `runId` 作 Worker 请求 ID（取消可命中）；迟到结果在终态后丢弃；求解期间 binding revision 变化 → BINDING_STALE 并失效建议；plan_get 使用带有效期的建议。
6. **成功语义竞态**：模型 INSERT 与作业 `done/model_id` 改为同一 SQLite 事务；`markStarted` 禁止把终态作业改回；工件摘要覆盖全部 requiredFiles。
7. **上下文质量**：过期点（>1.5×beat）与 state≠ok 的点不再进入历史；当前 MV/CV 越出有效域 → `CONTEXT_OOD`；`stage` 工况在发布时显式拒绝，运行时用声明身份 exactly-one 命中。
8. **单位换算**：v2 数据集在窗口构造时按变量 `scale/offset` 换算到模型单位（训练/上下文/有效域统一口径）。
9. **A8 方法**：改为延迟闭环（20 种子、只应用首步、保持方案对照），不再用“立即生效”的一步代数。
10. **其他**：ProblemIR hash 改为结构 hash（排除 x0/uPrev/context）；`optimizer.solver.*` 三设置已登记（schema/config/settings/i18n/文档计数 124/84）；retention 删除退役工件前做引用检查；`__pycache__` 不再打包；新增 `aml-env-lease`/`tool-face-authz` 测试。
11. **A20 真实门禁**：新增 `scripts/run-quality-gates.mjs` 实际运行 lint/typecheck/unit/i18n/docs，逐条写 `gates.json`（exitCode）；acceptance 读取并在任一非 0 时失败，证据 `gateRuns` 保留 5 条命令与退出码。
12. **A14 旧别名**：`mpc_optimize` 改为三分支门：无优化器绑定且无 AML 模型绑定 → `BINDING_NOT_FOUND` 引导；已绑定 AML 模型但无真实优化资格 → `OPTIMIZATION_NOT_ELIGIBLE` 引导；有绑定 → 旧语义放行。
13. **A13 谱系拆段**：`applyRecipe` 在产线运行中应用新配方时闭合旧段并开新段（配方 id/版本/内容 hash 拆段）；运行时若活动段 `recipeId` 或 `recipeVersion` 与规格不一致 → `CONDITION_MISMATCH` 失效旧方案；`stage` 工况显式不支持。
14. **A14 资格按模型溯源（三轮）**：资格查询不能按产线放行。数据集行新增/回填 `spec_ref`/`spec_version`（`aml_datasets` 既有迁移列，仓库补读写），`boundModelHasEligibility` 走 `model → dataset → 同 spec/version 的 eligibility`，并要求规格谱系与模型一致；作用域取产线性质（模拟线仅 simulation 报告、真实线仅 real）。验收新增同线第二规格无资格模型 + 真实 `dispatch` 复核。
15. **A13 活动窗口切换（三轮）**：只拆 `process_context_segments` 不够——DAQ 入库打标与配方监控窗口都读活动 LineRun。`applyRecipe` 现在在同一时点关段、切换活动窗口的 recipeId/Version/产品身份、再开新段；验收用真实 `lineStart → applyRecipe → TSDB 落库` 验证活动窗口、样本标签、谱系段三者一致（version 由谱系段承载，样本行保留 recipeId/runId 打标）。
16. **终审**：第四轮独立复核 APPROVED——确认 A14 资格按模型→数据集→同规格资格溯源（含作用域）、A13 真实切换链、A20 真门禁均成立；其余为已声明的 re-scope 遗留项。

## 5. 验收中发现并修复的真实缺陷（首轮）

1. **ProblemIR 丢失状态偏置**：`simulateLinear` / Python QP 忽略 `bias`，预测整体偏移；已贯通 TS/Python。
2. **训练器 rollout 输入列错位**：`pvU(...,mvIdx)` 把 allNodes 下标当 control 列序，rollout 指标失真（改善为负）；改为列序后 99.7%。
3. **并发 solve 抢同一 Worker**：`acquireSlot` 未预占，两个请求拿到同一进程 → `SOLVER_BUSY`；已加预占与失败释放。
4. **门禁失败原因丢失**：先 `finish('failed')` 落终态导致 `fail()` 无法写 error；改为直接 `fail()`。
5. **uv venv 已存在时重建失败**：改为目录存在时只补依赖。
6. **Python 求解线程内 lazy import 死锁**：3.12 下线程内 `import osqp/scipy` 与主线程 stdin 阻塞读并存会卡住；改为模块加载时导入。
7. **`line-tools` 静态 import plugins/workshop** 拖入 Nitro `#imports`，使模块无法被脚本/单测加载；改为懒加载。

## 6. 遗留项与边界（不冒充通过）

1. **Timescale `queryTagged`/分页**：仍不返回 `state/ingested_at`，也未实现 `queryTaggedPage`（文件级改写被安全扫描器拦截）。A15/A16 的 `queryTagged` 断言只在 SQLite 生效；Timescale 已验证 `query()/latest()` 的 state 与写入。
2. **A9 浏览器点击**未执行：判定覆盖接口载荷、持久状态、零写计数与 UI 路由/i18n 契约。
3. **A7** 为单机 fixture（horizon=20、1 MV/1 CV），不含冷启动与训练。
4. **A8** 使用延迟 FOPDT 与静态响应面 fixture，未耦合 `plc-node-simulator` 的 CastFilmModel/AnnealModel；模拟器自身的延迟/时钟 oracle 已单测（21/21）。
5. **旧 `mpc_optimize`** 仍走 TS 启发式（未路由到 Manager/ProblemIR）；仅前置了资格门（无绑定/无资格拒绝）。
6. **单长 run 时间块隔离切分**未实现（按 run 切分；gates 以 train/val/test 非空判定）。
7. **static_response 端到端**（训练→权威评估→注册→预测）未在验收中全链执行（训练器与求解器已单测）。
8. **A18 时序**（omp≤5s / bridge≤15s / pi 次回合）未实测，仅验证签名算法与门控。
9. 真实产线收益、设备执行授权、WriteGrant 链不在本期（计划明确不做）。

## 7. 复现命令

```bash
npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/acceptance-optimizer-process-model.ts
npx tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit tests/*.test.ts
npm run typecheck
npx eslint .
node scripts/_i18n-verify-keys.mjs
npm run docs:check
npm run build
```

Timescale 分支默认连接 `postgres://postgres:awshop@127.0.0.1:5432/awshop`（可用 `ACCEPT_TSDB_URL` 覆盖）。

## 8. 证据

- `docs/audit/evidence/2026-10-22-optimizer-process-model/acceptance.json`（67 条断言、commands、versions、hash、limitations）。
- 模拟器自测：`plc-node-simulator/tests/plant-model.test.ts` 21/21（含新增 ⑨ 启动瞬态/滞后）。

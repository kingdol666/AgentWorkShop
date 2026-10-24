# Optimizer 收敛总计划 v4.1（定稿） —— 信任地基 · 证据 · 双重校验 · 治理下发 · 扩展 · 全量验收

日期：2026-10-23。状态：**待用户批准后实施**。
前置：`docs/plans/2026-10-22-optimizer-process-model-plan.md` v3.1（M0 已交付 67/67 + Live 90/90 + 重启 7/7）。

本文件是唯一执行账本。来源：①双驱动计划 v2（三席两轮）；②GPT-6.1-sol 实现复核（10 项局部修复 → M0）；③GPT 后续补齐计划 F1–F6；④五席四轮评审：34 条阻塞 + 46 条回归 + 22 条终审 + 6 组落点修正（跨席重复已合并），全部落为决策/任务/验收。

## 0. 版本要点（v4.1 定稿）

v3 经五席终审后仍暴露 22 条（去重后约 17 组）实施级缺陷，v4 的关键修正：

1. **typed predictor 单位方向纠正**：typed 路径模型单位进/出，crosscheck 直喂快照；三个 public caller 均经 `shared/units.ts` 转换；仅 legacy ONNX 用工程单位（D7）。
2. **审批状态机闭环**：`dispatch_state` 单列（idle→dispatched→committed→executed/failed/cancelled/denied/expired），取消与批准同条件原子转移；三前缀在飞去重并排除自身（D14）。
3. **UQ fixture 可达**：live 改 6 run（2/2/2），走 `empirical_max`；conformal 由单测用 10 个独立 run×1 块覆盖（D2）。
4. **多工况冻结 hash**：按 condition 冻结 `problem_ir_hashes_json`，求解按实际 conditionId 选取（D21）。
5. **谱系与 live 兼容**：live/验收 fixture 补 confirmed segment，避免模型全变 legacy（D18）。
6. **MD 系数与回滚/租约细节**：工件补 `mdB/mdD`；回滚两阶段演练；`ensureVenv` ownership 单一；PID 复用防护；迟到隔离表（D26/D28/D22/D29）。

下述 v3 修正仍然有效（保留）：

1. **UQ 统计量可实施**：split conformal 要求 ≥9 个校准块（否则 qhat 退化为 ∞）；不足时降级 `empirical_max` 并显式标注，不再冒称 conformal（D2）。
2. **单位边界闭合**：工程/模型单位唯一换算函数；`maxStep` 在模型单位比较；profile CV 目标带 `targetsUnit`；`firstMove` 保持旧形状 + 新增 `firstMoveEngineering`（D23/D24）。
3. **IR hash 兼容**：`mdFuture` 运行值显式排除，`mdFuturePolicy` 仅在 MD 存在时进 hash；旧 Profile hash 不变（D26）。
4. **审批提交点竞态闭合**：取消改为条件转移；提交后不发"未执行"；崩溃启动对账；同配方跨前缀共享在飞去重（D14）。
5. **租约落位修正**：租约库放 `<amlRoot>/runtime/`（不是 workshop.sqlite）；回收以 pid 确认死亡为必要条件；单点获取；close hook 接线（D22）。
6. **发布可编译 IR**：新增 `compileProblemIRStructure`（无运行时 context）；solver×template 分派矩阵；registry 能力契约（D21）。

## 1. M0 基线（已完成，不重做）

| 已完成 | 内容 | 证据 |
|---|---|---|
| v3.1 交付 | 规格/数据集 v2/训练/两 Python 后端/Profile+绑定/5 个 optimizer_* 工具/管理页 | 67/67 进程内验收 |
| Live 验收 | REST + UI + 频道矩阵 + 静态/单位/AML 孪生 + 12 拍闭环（中位误差 6.42→0.02） | 90/90 + 重启 7/7，`docs/audit/2026-10-23-optimizer-live-e2e.md` |
| GPT 局部修复 | 零延迟 ARX 反馈进 B、OSQP 状态常量、静态 maxStep 交集、训练评价假通过、维护锁/Worker 竞争、plan_get 串 ID 越权、撤销他人绑定、horizon 显式 422、非法 UQ/过期状态、旧 ARX 工件 MODEL_RETRAIN_REQUIRED | 372/372 单测 + Python 6/6 + 五门禁 0，`docs/audit/evidence/2026-10-23-optimizer-review/summary.json` |

**M0 诚实边界**：Live 的"单位"断言只验证 `scale=0.06` 随规格持久化与求解 optimal，**未验证下发值单位与步限**（D23/D24 新增）；单 run 数据集不能发 UQ/下发（D2/MP-A3）。

## 2. 路线图

```
S0 验收基础设施(改 ID/载体/DoD/回滚 runbook)
 └→ M1a 授权(SW1)          ┐ 分别放行
 └→ M1b 数据真实性(SW2.1-2.4)┘
     └→ M2 证据与资格(SW3) + UQ
         └→ M3 互校(SW4)
             └→ M4 下发(SW5)
 M5a 环境与依赖(SW6.1-6.2)  ← 自 S0 起可并行
     └→ M5b Adapter/模板/MD/UI(SW6.3-6.6)  ← 排在 M4 之后
         └→ M6 收尾(SW2.5-2.6 + SW7) + 全量回归 + 回滚演练
```

排序理由：UQ 建立在切分口径上（SW2.3 先冻结 IO 契约）；下发依赖精确资格（SW3.3）；SW6.3–6.6 与 M2–M4 同文件，**不是**可并行车道；只有 SW6.1–6.2 真正独立。

## 3. 设计决策

### 3.1 证据与互校

| # | 决策 |
|---|---|
| D1 | **互校门 = 逐 CV 无量纲一致性**：`dev_j = max_t\|Δy_j(t)\| / max(σ_j,1e-9) ≤ tol`（tol 默认 1e-6，键 `optimizer.crosscheck.tol`）。σ_j 取工件 `norm.y.std[j]`（模型单位）；禁用 `variable.scale`；norm 缺失/σ≈0 → `not_applicable`（禁止下发）。**不向 IR plumb norm**（会改结构 hash，旧 Profile 全 `PROBLEM_IR_CHANGED`）。IR 侧 `dynamics.rollout` 的无量纲化把工件 `norm.y` 作为**非 hash 参数**传入（`constraintReport(ir, candidate, {normY})`），不得用 1e-9 兜底；norm 缺失时该检查降级为 not-run 并记录，不误杀候选 |
| D2 | **UQ 统计量（block 级 + 双模式）**：统计量 = h 步 rollout 残差在块内最大值，逐 CV、模型单位；h = 训练时 `ds.P`（static 固定 1），写入 `uq.horizon`，加载时断言 `static ? uq.horizon===1 : io_spec_json.horizonSteps === uq.horizon`（spec 校验强制 static `timing.horizonSteps=1`）。**必须补算 val 段 rollout 残差**（现有 `linear-arx.ts:230-244` 只跑 test）。两种模式：①`split_conformal`：要求 `nValBlocks≥9 ∧ nValRuns≥2`，`qhat_j=分位数_{⌈(nValBlocks+1)(1−α)⌉/nValBlocks}`（α=0.1），门用 test 实测 `coverage_j`；②`empirical_max`（2≤nValBlocks≤8）：`qhat_j=max(val block score)×1.25`（预注册安全系数），**要求 `coverageTest=1.0`**，标注"经验界，非 conformal"。块按 manifest 声明；**块数 >8 时按 run 聚合为 1 块/run 重算并记录 aggregation**（live fixture 固定每 run 1 块）。emit 条件：`nUniqueTestSteps≥120 ∧ nTestRuns≥2`；否则不写 uq → unverified。uq 写入 model.json 必须在注册算 artifactHash **之前**。字段 `uq={method,qhatPerCv,coverageTest,alpha,horizon,nValBlocks,nValRuns,nValUniqueSteps,nTestBlocks,nTestRuns,nUniqueTestSteps,safetyFactor?,calibratedAt}`；互校表 `qhat_per_cv_json` 直接复制，不另算。**live 6-run fixture（2 train/2 val/2 test）走 `empirical_max`**（2 个 val 块），split_conformal 由单测用 **10 个独立 run×1 块**覆盖（聚合口径不适用于该单测） |
| D3 | **verified 门限**：`split_conformal` → `coverageTest ≥ max(0.8, 0.9−3√(0.09/nTestRuns))`（0.8 硬底；nTestRuns 为独立 run 聚类）；`empirical_max` → `coverageTest = 1.0`。单 run 数据集永不发证 |
| D4 | **inputDistance = MV + CV（+ MD）**：`max(max_m|(u_m−μ_u)/σ_u|, max_j|(y_j−μ_y)/σ_y|)`；`mdOrder.length>0` 时追加当前 MD 与预测轨迹上的 `max|(md−μ_md)/σ_md|`。守卫：任一 σ≈0 → ∞；norm 长度不符 → null（降级 unverified） |
| D5 | **证据单源**：删除 `manager.uqEvidenceOf()`（`manager.ts:226,251-263`）；唯一来源 = 工件 uq + artifactHash 快照 |
| D6 | **互校态 = 计算字段 + 最新一行语义**：status 枚举不变；dual 仅当 crosscheck **最新一行**（`created_at DESC,id DESC`）`verdict='pass'` 且读时 stale=false；**最新行 fail 即无 dual，禁止回溯更早 pass**。stale = 读时谓词：`crosscheck.model_artifact_hash ≠ rec.model_artifact_hash ∨ rec.model_artifact_hash ≠ aml_models.artifact_hash(现值) ∨ run.binding_revision ≠ 当前`；行内 stale 仅写时快照 |
| D7 | **互校输入锚定（模型单位）**：用 `optimizer_runs.context_snapshot_json`（模型单位）重建输入，按 nodeId 重排；**typed predictor（`predictWithTypedArtifact`）模型单位进/出**，crosscheck 直接喂快照，不做工程换算（`predictor.ts:150-153` 的"原始物理量"是旧 ONNX 接口契约，不适用于 typed 路径）；仅 legacy ONNX 路径保留工程单位契约。**所有 typed public caller（`agents/industrial/aml-job-tools.ts`、`server/api/workshop/eda/vm/predict.post.ts`、`server/api/workshop/aml/models/[id]/predict.post.ts`）必须在调用前用 `shared/units.ts` 做工程→模型、返回后模型→工程**。history 前段 NaN → verdict=fail（不抛）；steps 与 candidate.predicted 长度不等 → 422；行内记 context hash + inputDistance。工况变允许互校但标 conditionChanged |
| D8 | **互校防污染**：互校前强制 `aml_models.artifact_hash == rec.model_artifact_hash`，不等 → 409；互校服务禁写 `twin_*`（保护 `twin-tools.ts:774` 的 G6 计数） |
| D25 | **互校独立性不变量**：运行期比较对钉死 = **worker/solver 的 `candidate.predicted` vs `aml/predictor.ts` typed replay**；`simulateLinear` 仅用于求解期独立代价/约束复算（`manager.ts:175-183`）与 SW4.5 spike 参考，不作运行期 replay。`predictor` 不得 import `problem-builder/simulateLinear`；adapter 不得用 predictor 生成 `candidate.predicted`；加 import-graph 断言。新模板/MD 无独立 replay → `not_applicable` → 禁止下发。M5b 出口与 M6 复跑 DD-A5 + 扰动负例 |
| D26 | **MD/特征语义**：IR 增 `mdOrder/mdFuturePolicy('hold'起步)/mdLayout/mdFuture`。**`mdFuture` 运行值与 x0/uPrev 同级从结构 hash 排除**；`mdOrder/mdFuturePolicy/mdLayout` **仅当 `mdOrder.length>0` 时**进入 hash（旧 Profile canonical JSON 字节不变）。工件增 `mdOrder?（默认[]）/mdDelaysSteps?/norm.md?/mdB:number[][]（stateDim×nMd）/mdD:number[][]（C×nMd）`；static 用 `mdCoefficients`+`mdFeatureOrder`；`mdOrder=[]` 时为零矩阵且布局与旧版一致（旧工件可直接加载），维度校验失败 → 422。static 只支持线性 MD，`md²`/`mv*md` → 422 `UNSUPPORTED_MD_INTERACTION`。金标：无约束 1MV/1CV 内点闭式 `≤1e-9` + 有界/Δu 的 KKT active-set 用例；MD 阶跃后最优 u 按 −b/a 反向。未支持输入在 train/publish/solve 三处 422；有 MD 无未来策略 → 422。MD 严禁混入 mv/cv |

### 3.2 单位契约

| # | 决策 |
|---|---|
| D23 | **唯一换算边界**：新增共享 `shared/units.ts`（aml 与 optimization 共用，避免反向依赖）：`toModel(v,{scale,offset})=v*scale+offset`，`toEngineering(m,{scale,offset})=(m−offset)/scale`；scale 缺失/0/非有限 → 422（删除 `context.ts:45` 与 `aml/dataset-builder.ts:344` 的 `?? 1`/`?? 0` 兜底）。字段单位：`variable.unit`=工程；`modelUnit?`=模型；`variable.min/max/maxStep` 与 `effectiveDomain`=**模型单位**（spec 增 `effectiveDomainUnit?:'model'` 默认 model，发布时展示换算后工程值）；`profile.problemConfig.*.targets` 增 `targetsUnit:'model'\|'engineering'`，**默认 `model`（向后兼容）**，新 UI 默认 engineering，建 IR 时按声明换算。IR/工件/求解器全程模型单位。输出：`firstMove` 保持 `Record<mv, modelValue>`（旧形状不变，旧消费者不破坏），新增 `firstMoveEngineering: Record<mv, engineeringValue>`；`optimizer_solve` 工具返回两者；**UI 展示与单位标注在 M6（DD-A10）验收**；`predicted` 模型 + 可选 `predictedEngineering`。下发只写 `firstMoveEngineering`，回读 ≈ 写入值（DCW 量化容差）。`SolveCandidate.controls` 的"已还原工程单位"注释改正；IR `scaling` 标记 deprecated/不消费，并测试锁定 worker 输出=模型单位 |

### 3.3 治理与下发

| # | 决策 |
|---|---|
| D9 | **身份与 actor**：卡以建议所属 binding 的 agent 实例名义挂单；REST 用户经外层授权取得代发资格；actor `{kind:'agent'\|'user',id,label}`。发起人 `initiator_user_id` 落库（D15），四类 recordOps 从行回读 |
| D10 | **两层授权边界**：外层 `assertOptimizationAccess(actor,op,resource)` 解析并返回资源上下文（绑定/Profile/规格/产线/Channel 实例）；内层 D13 闸序**消费**该上下文。拒绝映射：外层 403 `AUTHZ_*`，内层 403 `DISPATCH_GATE_*`/`DISPATCH_STEP_EXCEEDED`，禁 500。dispatch 独立操作枚举，要求 editor/admin 或 Channel `manage`；Channel 档位/工具策略只作用于 worker 操作（solve/capabilities），不作用于 dispatch。**每个授权拒绝写 1 条 `tool.call.denied`（resource/op/actor/lineId/reason），REST 与 Agent 面统一** |
| D11 | **证据防伪**：dispatch body 只收 `recommendation_id`(+备注)，证据字段 → 422；payload 服务端按 id 落库回查：**最新一行 crosscheck（必须 pass，否则不构造 payload）** + `model_artifact_hash == rec.model_artifact_hash` + `row_hash`；卡面展示 rec id/artifactHash/row_hash 截断值；渲染文本不作事实源。`row_hash=sha256(证据列)` |
| D12 | **漂移谓词（"结构/工件未漂移"）**：入参取 run 冻结值——`optimizer_runs.profile_id/profile_version` → `loadSpec(profile.processSpecRef)` → `loadArtifact(profile.modelRef.modelId, profile.modelRef.artifactHash)`；context 取 `run.context_snapshot_json`；重编译 hash == `rec.problem_ir_hash`；**工件完整性用 `readArtifactDescriptor(...).artifactHash`（`model-registry.ts:222-237`，sha256Files 含 model+metrics）与 DB 比对**，禁止单文件 sha256。任一不等 → 409。无活动 LineRun → 409 `CONDITION_UNVERIFIABLE`。只检测结构与工件漂移；操作点由 D24 覆盖 |
| D13 | **批准时刻八项重验（fail-closed）**：⓪ 发起人仍是 Channel 成员且持有该产线 grant；① 最新 crosscheck 行 pass 且 stale=0，建议未过期；② binding active/revision 未变；③ D12；④ `controlNodeId` 存在/启用/同线/∈配方参数面；⑤ AML 活动互斥；⑥ 当前操作点：当前 MV（DCW 回读，本次读取成功）+ CV（DAQ 最近点，`at ≥ now−max(2×beat,60s)`，否则 409 `CONDITION_UNVERIFIABLE`），重算 D4（>3 拒），**步限在模型单位比较**：`|firstMove[m] − (readback_m*scale+offset)| ≤ maxStep+ε`，复核 conditionId/segment；⑦ preflight 复跑。任一失败 → 业务拒绝 `{approved:false,code,comment}`（不落 approval_id、不落 execute 事件）+ 卡 denied + notifyLineOperators + recordOps。grant 复核 `toolName='recipe_propose'` |
| D14 | **幂等、提交点与崩溃对账**：新增 `dispatch_state TEXT NOT NULL DEFAULT 'idle'`（idle/dispatched/committed/executed/failed/cancelled/denied/expired）。**建卡** = `UPDATE ... SET dispatch_state='dispatched', dispatched_at=? WHERE id=? AND dispatch_state='idle'`（changes=0→409，幂等锚不回滚）。**批准与取消都以 `dispatch_state='dispatched' AND dispatched_at IS NOT NULL` 为条件做原子转移**：批准 `UPDATE ... SET dispatch_state='committed', approval_id=? WHERE id=? AND dispatch_state='dispatched' AND dispatched_at IS NOT NULL`；取消 `UPDATE ... SET dispatch_state='cancelled' WHERE id=? AND dispatch_state='dispatched' AND dispatched_at IS NOT NULL`。取消先赢 → 批准 changes=0；批准先赢 → 取消方返回"已提交，执行中，结果以回执为准"，**不得发"未执行"通知**，并记 post-commit 撤销。提交点后撤权不回滚已提交写；写完成置 executed、失败置 failed；D13 业务拒绝置 denied、D17 过期置 expired；**未建卡（idle）批准/取消 → 409 且零写**。**同配方在飞去重共享 `recipeWriteInFlight(recipeId,{excludeApprovalId?})`，检查三前缀 `recipe:`/`recipe-propose:`/`optimizer-recipe:`**；建卡不排除、批准排除当前 approvalId；recipe_propose 侧同检查。**启动对账**：扫描 `optimizer-recipe:*` 且 `approval_id` 非空、无 execute 审计的卡，回读 DCW：等于写入值 → executed；否则 unknown/denied + 通知，禁止自动重放。`revokeBindingForUser` 追加 `cancelPendingFor`；权限变更追加 `cancelPendingForUser`；`lineIdOf()`（`agents/tool-approvals.ts:204`）正则扩展 `optimizer-recipe:` |
| D24 | **下发首步安全边界**：optimizer dispatch **不豁免步限**（recipe_propose 的豁免只适用于配方参数步进）；建卡与批准两时刻读当前 MV 实测值，按 D13⑥ 的模型单位比较；不满足 → 409 `DISPATCH_STEP_EXCEEDED` + 指引重 solve |

### 3.4 授权、数据与资格

| # | 决策 |
|---|---|
| D15 | **迁移**：`migrations.ts` addColumn：`optimizer_recommendations.{dispatched_at,approval_id,initiator_user_id,dispatch_state DEFAULT 'idle'}`（旧行回填 idle，按 `dispatched_at` 派生历史态）；`optimizer_profiles.problem_ir_hashes_json`（多工况冻结 hash）；`process_model_eligibility.{dataset_id,dataset_hash}`；`aml_datasets.lineage_verified DEFAULT 0`。**`daq_late_samples` 属于 TSDB，不在 workshop 迁移**（DDL 在 `daq/storage/{sqlite,timescale}.adapter.ts`，SW2.6）。crosscheck FK CASCADE。**retention 不新增条目**（CASCADE 已覆盖，`db/retention.ts:35`），只补 CASCADE 测试与头注释。迁移全部可空/带默认，旧代码可插入 |
| D16 | **统一操作授权**：`assertOptimizationAccess` 六要素（用户角色/Agent 实例、Channel 档位+工具策略、绑定归属、产线 grant、变量可读范围、操作 capability）；四入口读数据前同一规则；唯一绑定默认调用也先解析实际目标 |
| D17 | **三时刻复核 + 持久失效**：solve 提交/结果发布/建议读取分别复核绑定/Profile/模型/规格/配方/工况。条件变化持久标 expired 并**收敛该建议在飞卡**（SW3.3 接手资格谱系复核）；迟到结果不得恢复有效 |
| D18 | **数据版本归属 + 存量隔离**：样本按已确认 context segment + `RecipeRun.paramsSnapshot` 归属，冻结版本/hash；run 内切换拆段；窗口不跨段；未知旧记录不倒填。**只用一个标志 `lineage_verified`**：默认 0 并回填 0；新 builder 仅在"每个 run 都有 confirmed segment 且 recipeId/version/contentHash 匹配"时置 1。`lineage_verified=0` 数据集训练的模型：publish 与 solve 均 422 `LEGACY_MODEL_REQUIRES_RETRAIN`（改 `manager.ts`，不只 profile.repo），Twin/shadow 不受限；有 segment 的可重建，无 segment 的永久 unknown。**live 与验收 fixture 都必须在建数据集前为每个 seeded run 创建并 `confirmed:true` 的 context segment**：`scripts/e2e-optimizer-live.mjs` 与 `scripts/acceptance-optimizer-process-model.ts`（后者 `ds-acc` 目前手插且无 segment，SW2.4 补齐），否则模型全变 legacy、M6 的 67/67 与 DD-A11 必断 |
| D19 | **动作证据双轨**：模拟线 = 持久试验状态机（计划→调度→治理链动作→回读→保持/观察→归档；可取消；重启不重放）；真实线 = 仅历史动作/设备回读证据（来源+时间，未知保持未知）。废除 `line.simulated → simulation_commanded` 自动证明与真实线恒 unknown |
| D20 | **精确资格谱系**：资格行关联 `dataset_id+dataset_hash/specId+version/conditionId/scope/证据版本`；`latest()` 按谱系查询（`manager.ts:103`、`eligibility.ts:266-268`）；Profile 发布核验模型→数据集→Spec 且 `lineage_verified=1`；旧资格行（无 dataset_id）撤销/忽略；撤销传播 |

### 3.5 扩展与平台

| # | 决策 |
|---|---|
| D21 | **Adapter 路由（承认改 Manager/Worker）**：定义 `solverRef × problemTemplate` 分派矩阵；**`scipy_slsqp@1 × linear_mpc_quadratic@1` 本阶段 publish 直接 422**（现有运行时会走错分支，必须显式拒绝）；已发布的此类 Profile 在启动/求解时标 `SOLVER_TEMPLATE_UNSUPPORTED` 并给出重发布（改 osqp）指引。`SolverRequestFrame` 增 `solverRef` + `protocolVersion:1|2`；`SolverResponseFrame/SolverEventFrame` 同步 `1|2`；**worker 同时接受 v1/v2**，flag 关闭时 Manager 发 v1；升级时 drain 旧 Worker；`worker.py` 按 ref 分派。Manager 增 adapter seam（错误映射/超时/诊断/取消）。solverRef 校验改 Registry 驱动（替换静态 `SOLVER_REFS`），`SolverAdapterManifest` 增 typed `artifactKinds/problemTemplates`（改 `aml/twin/provider-contracts.ts`），publish 与 IR 构建时校验。内置 OSQP/SciPy 注册为两个 SolverAdapter（`trainers/index.ts`）；typed 契约 `solve(ir,{requestId,timeoutMs})→{status,controls,predicted,cost,diagnostics}` + `cancel`；新增 health/retire。**发布期新增 `compileProblemIRStructure(profile,spec,artifact)`**（合成结构性 context，只保留参与 hash 的字段）编译并冻结 hash，拒绝客户端传 `problemIrHash`；**多工况 Profile 按每个允许 condition 冻结 hash（`optimization/profile.repo.ts` 写入 `problem_ir_hashes_json`），`manager.ts` 按实际 conditionId 选取**；**旧多工况 Profile 无该列且（`conditionIds.length>1` ∨（`conditionIds.length===0` ∧ `spec.conditions.length>1`））→ 422 `PROFILE_REPUBLISH_REQUIRED`**（单工况沿用单一 hash）。ProblemTemplate 编译器注册表 + 独立 IR 验证器（`optimization/problem-ir-validator.ts`），非法 IR 负例。加"发布 hash == 求解 hash"测试 |
| D22 | **跨进程环境租约**：租约库放 **`<amlRoot>/runtime/env-leases.sqlite`**（独立 DB，不用 workshop.sqlite；`resolveAmlRoot` 见 `shared/config/home.mjs:210-217`），表 `leases(root,holder,kind,pid,pid_started_at,host,token,child_pid,acquired_at,heartbeat_at)`；读租约与维护锁在 `BEGIN IMMEDIATE` 内检查对方。**单一获取点**：`ensureVenv({lease?})` —— 无 token 时自己获取独占；有 token 时只校验归属、不重复获取；删除 env-manager 外层独占（避免嵌套 BEGIN IMMEDIATE）；首次运行（venv 未就绪）也必须可获取。**回收必要条件 = 同 host 且 pid 确认不存活（pid + start_time/boot_id 匹配，防 PID 复用）**；heartbeat 超阈值只标 suspect（不自动回收），除非 pid 不可探测且人工/强制。记录训练子进程 pid/进程组，回收前检查/杀孤儿树（Windows `taskkill /T /F`）。租约 API 按 root 作用域；`envLeaseStatus(root)` 挂 `/api/workshop/aml/env`。`SQLITE_BUSY` → `ENV_BUSY`。退出确认：`shutdownSolverWorkers`/`shutdownOrchestrator` 改 async 并在 `server/plugins/workshop.ts` close hook 中 `await` 后再 `db.close()`。`requirements.lock` + marker 含 OS/Python/lock 摘要，纳入打包与 `verify-release-pack` |
| D29 | **存储范围收敛**：SW2.5 只做读侧对等（`queryTaggedPage` 必选；`queryTagged` 补 state/ingested_at；`latest` 补 ingestedAt；`stats()`；`ingested_at` 数值化；`time_bucket(...origin=>'epoch')`）；`computeWatermark` 改用分页（`watermark.ts` 当前只取首页 5000 点）。SW2.6 保留语义定死为：`drop_chunks` 仅用于 `ts < cutoff − grace`；边界窗口行级 DELETE 且 `(ingested_at IS NULL OR ingested_at < cutoff)`；**迟到行（`ingested_at − ts > grace`）写入时路由到 `daq_late_samples` 隔离表**（查询 union、保留按表独立，避免旧 chunk 误删晚到点）；公开 `sweepRetentionForTest`/注入时钟。**"水位读截止""一致性快照/导出"移出本阶段**（SQLite 无参照实现） |

### 3.6 验收与交付

| # | 决策 |
|---|---|
| D27 | **验收命名空间**：`DD-A1..DD-A12`（双驱动链）、`MP-A1..MP-A12`（平台/治理）、`PM-A1..PM-A22`（原 v3.1）。全文禁裸 `A<n>` |
| D28 | **回滚单位与演练**：每个 SW = 可独立 revert 的 commit；SW5/SW6.1/SW6.3 加 **env/code-only** flag（`AW_OPTIMIZER_DISPATCH`、`AW_AML_ENV_LEASE_V2`、`AW_OPTIMIZER_ADAPTER_ROUTING`，不进 settings schema，避免文档计数漂移）。SW2/SW3/SW4 的 DDL 采用 expand/contract（只加可空列，不删不改），明确**只前滚、不可回滚**。**演练两阶段**：①新代码在 DB 副本上跑迁移建列/表 → 关闭三个 flag → runbook（取消 `optimizer-recipe:*` 卡 → running 试验标 interrupted → 强制过期租约）；②同一 DB 副本 + `pre-v3-baseline` 第二 worktree 启动旧代码 → 向新列插入一行验证不崩 → 无孤儿卡/租约。五门禁跑新版树；旧树只做启动/插入。通过判据 = 五门禁 exit 0、旧代码可启动、新列可写、无孤儿。命令/期望写入 DD-A11 |
| D30 | **DoD（每 SW）**：可独立 revert 的 commit + 新增/更新单测（文件+用例数）+ e2e 脚本名 + `docs:check`/`i18n:check`/`lint`/`typecheck` 全 0 + settings/config.yml/文档计数同步 + evidence JSON（commands/exitCode/hash）+ migration/rollback note + 独立 review |
| D31 | **并发/顺序**：M5a（SW6.1–6.2）自 S0 起并行；M5b（SW6.3–6.6）排在 M4 之后。SW2.3 结束**冻结训练器 IO 契约**（时间语义/变量序/单位/split-purge 元数据），SW3.4 只能其后启动 |

## 4. 工作流与文件级任务

**路径约定**：服务端省略 `server/services/workshop/`；API 写全 `server/api/...`；前端相对仓库根。已核正：`agents/tool-approvals.ts`、`agents/hitl-decision/dispatcher.ts`、`db/database/schema.ts`、`db/database/migrations.ts`、`db/retention.ts`、`process-model/eligibility.ts`（无 `eligibility.repo.ts`）。

### SW0 验收基础设施（S0）

| # | 任务 | 文件 |
|---|---|---|
| SW0.1 | 验收 ID 改名 + 全文引用替换；每条断言绑定唯一载体 | 本文件 |
| SW0.2 | 五类载体骨架 + 聚合门禁：`scripts/e2e-dual-drive.mjs`、`e2e-optimizer-auth.mjs`、`e2e-data-versioning.mjs`、`e2e-eligibility-evidence.mjs`、`e2e-solver-adapter.mjs`、`e2e-env-lease.mjs`、`e2e-tsdb-parity.mjs`、`ui-optimizer.mjs`、`bench/optimizer-profit.mjs` | `tests/**`、`scripts/**` |
| SW0.3 | 设置/文档同步清单（2 新键，`applies=live`；10 文档 + config.yml + hero）；新增 `schema labelKey 双语存在性` 检查 | `scripts/check-docs-sync.mjs`、§5.3 |
| SW0.4 | DoD 模板 + 回滚 runbook（D28 定死命令/判据）+ evidence 目录模板 | `docs/audit/evidence/<date>-<sw>/` |

### SW1 授权与失效（M1a）

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| SW1.1 | `assertOptimizationAccess` 六要素 + 返回资源上下文 + **每个拒绝写 1 条 `tool.call.denied`（含 REST/decide 路径）** | 新 `optimization/access.ts`、`rest-auth.ts` | MP-A1 |
| SW1.2 | 17 handler 全覆盖矩阵（optimization 7 文件 + process-model 6 文件；多方法文件逐条）；修现存越权：profiles 全局、profile/spec publish 无归属、experiments 无 lineId、eligibility 无产线、train 仅 readonly、capabilities 泄露 | `server/api/workshop/{optimization,process-model}/**` | MP-A1 |
| SW1.3 | Agent/MCP 面同规则；缓存滞后不得放行 | `agents/host-tool-bridge`、`agents/industrial/grant-guard.ts` | MP-A1 |
| SW1.4 | M1 范围三时刻复核：绑定有效期/revision、Profile/模型状态、规格/配方/工况、TTL 持久失效 + 收敛在飞卡；**资格谱系复核由 SW3.3 承接** | `manager.ts`、`recommendation.service.ts`、`run.repo.ts` | MP-A1 |
| SW1.5 | 绑定变更通知工具面；实测 OMP/MCP/Pi 刷新 | `binding.service.ts`、`scripts/e2e-optimizer-live.mjs` | MP-A1 |
| SW1.6 | 配置动作审计：Profile 创建/发布、规格发布、绑定创建、资格评估、试验创建、训练提交 → recordOps | 上述路由 + ops-log | MP-A1 |

### SW2 数据与配方版本真实性（M1b + M6）

| # | 任务 | 文件 |
|---|---|---|
| SW2.1 | 样本按 context segment + paramsSnapshot 归属、冻结版本/hash、窗口不跨段、unknown 隔离 | `process-model/{dataset,context,context-segments.repo,watermark}.ts` |
| SW2.2 | aml builder 按 `process_context_segments` 裁切 | `aml/dataset-builder.ts` |
| SW2.3 | 切分/IO 契约：真实落点 `aml/dataset-builder.ts:353-356,413-442` + `trainers/dataset-reader.ts:70-73`；manifest 输出 `split.blocks[{blockId,runId,fromTo,purgeBefore/After,uniqueSteps}]`（写入 `aml/dataset-builder.ts`，v2 读取 `process-model/dataset.ts`）；单长 run 含 purge gap；静态稳定段阈值 `max(0.02×|target|, 0.01×max(cvRange,norm.y.std),1e-9)`（预注册）；**出口=IO 契约冻结** | `aml/dataset-builder.ts`、`trainers/dataset-reader.ts`、`process-model/dataset.ts` |
| SW2.4 | 存量迁移与遗留隔离：`lineage_verified` 回填 0；新 builder 置 1；**`aml/aml.repo.ts` 的 `AmlDatasetRow/DS_COLS/insert/get/list` 必须透传 `lineage_verified`**（否则 builder 置 1 会被丢弃）；**改 `manager.ts`** 使 legacy 模型 publish/solve 422；重建策略；**live/验收 fixture 补 confirmed context segment**（两个脚本都补；`ds-acc` 显式 `lineage_verified=1` 或改走 builder） | `db/database/{schema,migrations}.ts`、`aml/{dataset-builder,aml.repo}.ts`、`optimization/{profile.repo,manager}.ts`、`scripts/e2e-optimizer-live.mjs`、`scripts/acceptance-optimizer-process-model.ts` |
| SW2.5 | Timescale 读侧对等（M6）：`queryTaggedPage` 必选、`queryTagged` 补 state/ingested_at、`latest` 补 ingestedAt、`stats()`、`ingested_at` 数值化、`time_bucket origin=>'epoch'`；`computeWatermark` 改分页 | `daq/storage/{tsdb-port,timescale.adapter,sqlite.adapter}.ts`、`process-model/watermark.ts` |
| SW2.6 | Timescale 保留语义（M6）：`drop_chunks` 仅 `ts<cutoff−grace`；边界行级 DELETE 且 `(ingested_at IS NULL OR ingested_at<cutoff)`；**迟到行（`ingested_at−ts>grace`）写入 `daq_late_samples` 隔离表**（DDL 在 `sqlite.adapter.ts`/`timescale.adapter.ts`，`tsdb-port.ts` 定义 query/queryTagged/queryTaggedPage/latest 的 union 语义）；公开 `sweepRetentionForTest`/注入时钟 | `daq/storage/{timescale.adapter,sqlite.adapter,tsdb-port}.ts` |

### SW3 证据与精确资格（M2）

| # | 任务 | 文件 |
|---|---|---|
| SW3.1 | 模拟试验持久状态机（D19） | `process-model/experiment.ts`、`process-model/eligibility-service.ts`、`dcw/{dcw-runtime,param-limits,param-conversion,line-run}.ts` |
| SW3.2 | 真实线动作证据 = 历史账本读取 | `process-model/eligibility-service.ts` |
| SW3.3 | 精确资格谱系 + 迁移：资格表加 `dataset_id/dataset_hash` 与索引；`save/latest` 按谱系；Profile 发布核验；旧资格撤销；撤销传播 | `process-model/eligibility.ts:255-284`、`db/database/{schema,migrations}.ts`、`optimization/manager.ts` |
| SW3.4 | UQ（D2/D3/D4/D5）：双模式；补算 **val** rollout 残差；`uq.horizon=ds.P` 并与 `io_spec_json` 断言（**static 强制 `timing.horizonSteps=1`，断言 `uq.horizon===1`**）；static 启用闲置 val 段（`static-response.ts:95-97`）；`index.ts` 停写 metrics.uq；OOD 硬门；**live fixture 改 `N_RUNS=6`、三处 `testRatio=0.4` 且 `valRatio=0.4`（2/2/2，每 run 1 块，走 empirical_max）** | `trainers/{linear-arx,static-response,index}.ts`、新 `optimization/uq-evidence.ts`、`manager.ts`、`recommendation.service.ts`、`process-model/spec.ts`、`shared/config/schema.json`、`scripts/e2e-optimizer-live.mjs` |
| SW3.5 | 试验执行 UI（状态/预算/中止） | `app/pages/optimizer/index.vue` |

### SW4 候选互校（M3）

| # | 任务 | 文件 |
|---|---|---|
| SW4.1 | 新表 `optimizer_candidate_crosschecks(...predicted_json,replayed_json,dev_per_cv_json,tol,max_dev_dimensionless,qhat_per_cv_json,verdict,condition_changed,stale,reason,row_hash,created_at)` + 索引；`row_hash=sha256(证据列)`；加入 `tests/optimizer-schema.test.ts` 的 `TABLES`；retention 仅注释+CASCADE 测试 | `db/database/schema.ts`、`tests/optimizer-schema.test.ts` |
| SW4.2 | 互校服务：D7 快照锚定+nodeId 重排+**typed predictor 模型单位直喂**（不做工程换算）+steps 断言+NaN→fail；D1 分母取工件 norm.y.std（缺失→not_applicable）；D8；D25 比较对钉死；D6 最新一行 | 新 `optimization/crosscheck.service.ts` |
| SW4.3 | 派生展示：联查**最新一行**（非最新 pass 行）；label 仅展示层 | `run.repo.ts`、`contracts.ts`、`agents/industrial/optimizer-tools.ts` |
| SW4.4 | REST crosscheck（editor/admin + 归属；显式 `assertOptimizationAccess`；错误码） | 新 `server/api/workshop/optimization/recommendations/[id]/crosscheck.post.ts` |
| SW4.5 | spike 先行：`dev_per_cv<1e-9`；扰动负例（1e-4 → fail）；import-graph 断言 | 新 `tests/optimizer-uq-crosscheck.test.ts` |
| SW4.6 | 单位契约（D23）：共享 `shared/units.ts`、`targetsUnit` 换算（`problem-builder.ts`）、删 `context.ts`/`dataset-builder.ts` 兜底、`firstMoveEngineering` 进工具（UI 展示归 M6/DD-A10）、**typed caller（`aml-job-tools.ts`、`eda/vm/predict.post.ts`、`aml/models/[id]/predict.post.ts`）单位转换**、`controls`/`PredictRequest` 注释、`scaling` deprecated、spec `effectiveDomainUnit`、`variable.min/max/maxStep` 单位校验 | 新 `shared/units.ts`、`process-model/{context,spec,contracts}.ts`、`optimization/{contracts,problem-builder,manager,recommendation.service}.ts`、`aml/{dataset-builder,predictor}.ts`、`agents/industrial/{optimizer-tools,aml-job-tools}.ts`、`server/api/workshop/{eda/vm/predict,aml/models/[id]/predict}.post.ts`、新 `tests/optimizer-units.test.ts` |

### SW5 治理下发（M4）

| # | 任务 | 文件 |
|---|---|---|
| SW5.1 | Spec MV `controlNodeId`：parse optional（旧 spec 可读），publish/dispatch required + 存在/同线/∈配方参数面/发布后不可变；旧 spec 负例 | `process-model/{spec,contracts}.ts`、`optimization/problem-builder.ts` |
| SW5.2 | 提取 `recipe-propose-service.ts`：actor 抽象；六处 agentId 耦合点参数化；工具薄壳；**加入共享 `recipeWriteInFlight`** | `agents/industrial/recipe-propose-tools.ts`、新 `agents/industrial/recipe-propose-service.ts` |
| SW5.3 | `dispatch.service.ts`：外层 `assertOptimizationAccess('dispatch')` → 内层 D13；D12；D24 模型单位步限；D23 写 `firstMoveEngineering`；D11 防伪（最新行必须 pass）；卡 payload 双侧证据+row_hash；**D13 业务拒绝返回 `{approved:false,code,comment}`**；REST 建卡即返回 | 新 `optimization/dispatch.service.ts`、`agents/tool-approvals.ts` |
| SW5.4 | 单一咽喉：`/api/workshop/hitl/respond` 与 `/api/workshop/agent-tools/approvals/[id]/decide.post.ts:61-66` 对 `optimizer-recipe:*` 一律路由 `dispatchService.decideAndExecute`；执行 = D13 八项 → approval_id 抢占 → 同步写 → 回读 → recordOps → 解 pending；两条入口把 effective decision 写回（hitl 改 `decision.confirmed=false`，agent-tools 按 denied 审计/响应）；仅基础设施故障可抛 | `agents/hitl-decision/dispatcher.ts`、`server/api/workshop/agent-tools/approvals/[id]/decide.post.ts`、`dispatch.service.ts` |
| SW5.5 | 数据与审计：D15 迁移；counters/原子抢占；recordOps 四事件含 `initiator_user_id`；UI 徽章/按钮/zh-en | `db/database/migrations.ts`、`run.repo.ts`、`app/pages/optimizer/index.vue`、i18n |
| SW5.6 | 并发/崩溃/回滚：`dispatch_state` 原子转移（取消/批准同条件）；提交后通知"已提交，执行中"；启动对账；D17 过期收敛；env-only flag；runbook | `dispatch.service.ts`、`permissions.ts`、`binding.service.ts`、`server/plugins/workshop.ts` |

### SW6 扩展（M5a/M5b）

| # | 任务 | 文件 |
|---|---|---|
| SW6.1 | 跨进程租约（M5a，D22）：`<amlRoot>/runtime/env-leases.sqlite` + 表 + **`ensureVenv({lease?})`（无 token 自己获取；有 token 只校验不重复获取；删除 env-manager 外层）** + **pid+start_time/boot_id 存活判定**（防 PID 复用）+ heartbeat suspect + 训练子进程 pid/进程组 + root 作用域 + `ENV_BUSY` 映射 + async 退出与 close hook | `aml/{env-lease,env-manager,python-runtime}.ts`、`aml/job-orchestrator/{start-job,control,index}.ts`、`optimization/worker-client.ts`、`server/plugins/workshop.ts` |
| SW6.2 | 依赖锁（M5a）：`requirements.lock` + marker 含 OS/Python/lock 摘要 + 打包与 `verify-release-pack` | `requirements.lock`（新）、`python-runtime.ts`、`nuxt.config.ts`、`scripts/_audit/verify-release-pack.mjs` |
| SW6.3 | Adapter 路由（M5b，D21）：solver×template 矩阵（scipy+linear → 422）；worker 协议 v2（兼容 v1、按 ref 分派、drain 旧 worker）；registry 能力契约（改 `aml/twin/provider-contracts.ts`）；typed 契约；内置 adapter；health/retire | `optimization/{manager,worker-client,contracts}.ts`、`optimization/python/{worker,problems}.py`、`process-model/{contracts,trainers/index}.ts`、`aml/twin/{provider-contracts,provider-registry}.ts` |
| SW6.4 | 发布编译冻结 IR（M5b）：`compileProblemIRStructure` + 多工况 per-condition hash（`profile.repo.ts` 写入/migration 列、`manager.ts` 按 conditionId 选取）+ ProblemTemplate 编译器注册表 + 独立验证器（`optimization/problem-ir-validator.ts`）+ 拒绝客户端 hash | 新 `optimization/problem-template-registry.ts`、新 `optimization/problem-ir-validator.ts`、`optimization/{problem-builder,profile.repo,manager}.ts`、`profiles/[id]/publish.post.ts:9-16` |
| SW6.5 | MD/特征成组（M5b，D26）：schema/IR（mdB/mdD/mdFuturePolicy）/predictor/ProblemIR/solver/独立验证/UI；旧工件与旧 Profile hash 回归 | `process-model/spec.ts`、`aml/predictor.ts`、`optimization/{contracts,problem-builder}.ts`、训练器、Python、新 `tests/optimizer-md.test.ts` |
| SW6.6 | 工况编辑器：真实数据来源、先选已验证模型+有效域 | `app/pages/optimizer/index.vue` |

### SW7 收尾与全量验收（M6）

| # | 任务 | 文件 |
|---|---|---|
| SW7.1 | horizon 清理（三份 home 的 `prompts/host-tools.json`：`.AgentWorkShop/`、`.aw0746-home/`、`.demo-home/`）+ `SolveOptions.horizon` + 两 horizon 单测删除；**live 脚本无请求级 horizon，v1 归因错误已纠正** | 上列 + `tests/optimizer-request-contract.test.ts:77,88` |
| SW7.2 | live 刷新时序（OMP≤5s/bridge≤15s）+ 试验计划浏览器点击；明确新断言总数（不再固定 90） | `scripts/e2e-optimizer-live.mjs` |
| SW7.3 | 真实模拟器闭环（薄膜+连续退火，非 ARX；Solver 仅见 exposed，truth 供独立验收） | `scripts/e2e-simulator-optimizer.mjs`（新）+ `plc-node-simulator/` |
| SW7.4 | PM-A8 基准：每场景 20 配对（两场景 40）、改善≥15%、95% 下界>0、硬约束零违反、预注册阈值、最差值、**相对旧工具收益**；训练/评测 plant 不同、MPC 只应用首步 | `bench/optimizer-profit.mjs`（新） |
| SW7.5 | 第三留出场景纯配置全链 + 重启 + 核心 hash 不变 | `scripts/e2e-third-scenario.mjs` |
| SW7.6 | PM-A1..22 逐子断言（partial/not-run 明确标注，不计通过） | 扩展 `scripts/acceptance-optimizer-process-model.ts` |
| SW7.7 | UI 全覆盖（动态/静态/工况/资格/试验/诊断/反馈） | `app/pages/optimizer/**` |
| SW7.8 | 全量回归 + 回滚演练（D28 定死）：67/67、372+ 单测（§5.3）、live 新计数、五门禁 0、recipe_propose 基线不回退 | `scripts/run-quality-gates.mjs` |

## 5. 验收矩阵

### 5.0 载体五分类

| 类 | 载体 | 覆盖 |
|---|---|---|
| 纯单测 | `tests/optimizer-uq-crosscheck.test.ts`、`tests/optimizer-units.test.ts`、`tests/tsdb-parity.test.ts` | DD-A1、DD-A5(spike)、MP-A7(纯函数) |
| 服务集成/e2e | `scripts/e2e-dual-drive.mjs`、`e2e-optimizer-auth.mjs`、`e2e-data-versioning.mjs`、`e2e-eligibility-evidence.mjs`、`e2e-solver-adapter.mjs`、`e2e-env-lease.mjs`、`e2e-tsdb-parity.mjs` | DD-A2..DD-A9、DD-A12、MP-A1..MP-A10 |
| 浏览器 | `scripts/ui-optimizer.mjs` | DD-A10 |
| 门禁 | `scripts/run-quality-gates.mjs` | DD-A11、MP-A12 |
| bench/模拟器 | `bench/optimizer-profit.mjs`、`e2e-simulator-optimizer.mjs`、`acceptance-optimizer-process-model.ts` | MP-A11 |

### 5.1 DD-A 双驱动链

| ID | 断言 |
|---|---|
| DD-A1 | UQ：`nValBlocks≥9 ∧ nValRuns≥2` → split_conformal，val/test 不相交；`2≤nValBlocks≤8` → empirical_max 且 coverageTest=1.0；`nValBlocks<2` 或 `nTestRuns<2` 或 `nUniqueTestSteps<120` → 不发 uq → unverified；σ≈0 → ∞；旧 ONNX → unverified；**nTestRuns=2 时阈值=0.8**；**val rollout 残差真实计算（非复用 test）**；`io_spec.horizonSteps ≠ uq.horizon` → uq 不可用 |
| DD-A2 | solve → uqEvidence 非空含 artifactHash → verified（**6-run fixture 2/2/2，`method=empirical_max`，`nValBlocks≥2 ∧ nTestRuns≥2`**）；删 metrics_json 中 uq 后判定不变（单源） |
| DD-A3 | crosscheck：pass → 最新行 pass + dual；偏差>tol → fail；**pass→fail 后 dual 消失**；steps 不等 → 422；NaN → fail；工况变 → conditionChanged |
| DD-A4 | 同 rec 二次 crosscheck=新行；同 rec 二次 dispatch=409；不同 rec 同配方在飞 → 409；**`recipe:`/`recipe-propose:`/`optimizer-recipe:` 三前缀双向互斥**；**批准时当前卡不被自身判为在飞**；模型替换后再 crosscheck → 409；旧 pass 行读时 stale |
| DD-A5 | spike `dev_per_cv<1e-9`；扰动 1e-4 → fail；import-graph 断言；**typed predictor 模型单位直喂（scale=0.06/offset=5）**；SW6 后复跑 |
| DD-A6 | unverified → 403 `DISPATCH_GATE_*`；verified 未互校 → 403；互校一致 → 200 + 卡 nodeId=optimizer-recipe:* + payload 含 rec/hash/row_hash；body 带证据字段 → 422；**scale=0.06 与 scale=2 的步限正/负例**；当前 CV 陈旧 → 409 `CONDITION_UNVERIFIABLE` |
| DD-A7 | 批准 → DCW 写 `firstMoveEngineering` + 回读 ≈；八项重验逐项负例（过期/工况变/AML 开启/绑定撤/模型换/发起人 grant 撤/controlNode 失效/preflight 失败/CV 陈旧/步限）→ 零写 + denied + comment 含码 + 双通知；**第二入口同样被拦**；**`dispatch_state` 原子转移：取消先赢→批准 changes=0；批准先赢→写 1 且无"未执行"通知；未建卡（idle）批准/取消→409**；**崩溃后启动对账**；hold 文案指引重走 |
| DD-A8 | controlNodeId：冒充/跨线/缺失 → publish/dispatch 422；∈配方参数面；旧 spec 可读不可 dispatch |
| DD-A9 | 非成员 403；**成员非 editor → 403**；admin 放行；模板 id 422；`lineIdOf('optimizer-recipe:x')` 正确 |
| DD-A10 | 徽章/三态按钮 + zh/en parity + 无 pageerror（浏览器）；**UI 展示 `firstMoveEngineering` 并标注工程单位** |
| DD-A11 | 五门禁 0；67/67；372+ 单测（§5.3）；live 新计数；recipe_propose 基线不回退；**回滚演练按 D28 命令通过** |
| DD-A12 | 每 SW evidence（commands/exitCode/hash）+ 截图；三份 source audit 更新 |

### 5.2 MP-A 平台/治理

| ID | 断言 |
|---|---|
| MP-A1 | **资源矩阵**：绑定/Profile(draft+published)/规格/资格/运行/建议/互校行/下发卡/试验/数据集/训练作业/capabilities × 读/写/发布/批准；每行 A 对 B 负例。额外：B 发布 A 的 draft → 403；B plan_get/crosscheck/dispatch A 的 → 403；**拒绝前后业务表快照不变（排除 audit_log）且恰新增 1 条 `tool.call.denied`（REST 与 Agent 面一致）**；成功配置变更恰 1 条 ops 行 |
| MP-A2 | **谱系与遗留**：v1 运行后再编辑 v2，v2 规格不能改标 v1 样本；换版窗口不跨段；unknown 排除资格；`lineage_verified=0` 数据集不能产生优化合格；legacy 模型 publish **与 solve** → 422；**live 与 67/67 验收 fixture 均非 legacy（confirmed segment / lineage_verified=1）**；**单 run 数据集只能预测，不能发 UQ/下发** |
| MP-A3 | **切分/IO 契约**：单 run 合法切分通过、重叠泄漏反例失败；manifest 含 blockId/purge/uniqueSteps；静态稳定段阈值按 `max(0.02×|target|,0.01×max(cvRange,norm.y.std),1e-9)`，达标/过渡段各一例；IO 契约冻结后 SW3.4 才启动 |
| MP-A4 | **资格/动作证据**：simulated 无干预 → 无动作资格；真实线有可核验历史干预 → real 通过，仅 ACK/失败/自然漂移 → 拒绝；v1 合格不放行 v2/另一模型/数据集；资格撤销传播；试验可取消、重启不重复写 |
| MP-A5 | **互校独立性**（跨 SW6 复跑）：新模板无独立 replay → not_applicable → 禁 dispatch |
| MP-A6 | **下发治理**：单一咽喉两入口；八项重验；发起人 grant；当前操作点/步限（模型单位）；单位写值；**`dispatch_state` 提交点语义**；并发（撤权 vs 批准恰一成功且写计数/通知一致）；崩溃对账 |
| MP-A7 | **单位契约**：`scale=0.06, offset=5`：`firstMoveEngineering == (firstMove−offset)/scale`（1e-9）；**`firstMove` 旧形状不变，`optimizer_solve` 工具同时输出两者**（UI 展示断言归 DD-A10/M6）；dispatch 写 engineering；回读 ≈；targetsUnit=engineering 换算；scale=0 → 422；`dataset-builder.ts` 不再兜底；**三个 typed caller 入口均转换**；worker 输出=模型单位；`scaling` deprecated 不影响结果；`effectiveDomain`/`variable.min/max/maxStep` 按模型单位校验 |
| MP-A8 | **Adapter**：测试插件注册独立 adapter → Manager 真实调用；`solverRef × template` 矩阵（scipy+linear → publish 422）；worker 协议 v2 按 ref 分派且兼容 v1、drain 旧 worker；registry typed 能力校验；退役/热更不改变在途代际；发布冻结 IR（客户端 hash → 422/忽略）、发布 hash == 求解 hash；**两工况同一 Profile（含 `conditionIds:[]`）两次求解均成功（per-condition hash）**；**pre-v3 published Profile hash 不变、同 Profile 不同 mdFuture 同 hash**；非法 IR → 验证器拒绝；新模板代价与独立复算相对差 ≤1e-6；MD 金标（无约束闭式 + 有界 KKT） |
| MP-A9 | **环境与依赖**：真实子进程 A 持租约/B 重建 → `task.error=ENV_BUSY`；B 持维护锁时 A 取不到；**首次运行（venv 未就绪）可正常获取**；并发维护恰一成功；**pid 活时绝不回收**；**PID 复用不误判（start_time/boot_id）**；崩溃回收且杀训练子进程树；Windows 退出确认后才能切换；close hook 等待退出；marker/lock 含 OS/Python；双 home 租约可见性 |
| MP-A10 | **存储对等**：MP-A10a（SQLite 数据归属/分页/坏点/重复）M1b；MP-A10b（Timescale 直连，断言 backend='timescale'，补 stats/ingestedAt/latest/queryTagged state/桶边界/保留宽限/watermark 分页）M6；无环境标 not-run 不计通过 |
| MP-A11 | **模拟器与收益**：a/b 仅 smoke（协议回读/训练门禁/求解 optimal，不承担 15%）；c = PM-A8 20 配对/两场景 40、改善≥15%、95% 下界>0、硬约束零违反、预注册阈值、最差值、相对旧工具收益；d 第三场景；e PM-A1..22；f 真实线设备写计数=0。partial/not-run 不计通过 |
| MP-A12 | **门禁/文档/回滚**：`docs:check` 126/19/42/84；`i18n:check` parity + labelKey 双语；lint/typecheck/build 0；settings/config.yml/文档同步；**回滚演练按 D28 通过**；每 SW evidence |

### 5.3 回归门禁连锁清单

| 类别 | 内容 |
|---|---|
| 新增设置（2 项，均 `applies=live`） | `aml.uq.freshDays`（7）、`optimizer.crosscheck.tol`（1e-6）→ 124→126，live 40→42，restart 84 |
| 文档同步 | `README.md:195,666`；`README-zh.md:31,194,272`；`docs/cli.md:159,246`；`docs/cli.en.md:170,261`；`docs/site/cli/index.md:159,246`；`docs/site/en/cli/index.md:170,261`；`docs/site/index.md:63,74,280,411`；`docs/site/en/index.md:77,287`；`docs/site/guide/configuration.md:25`；`docs/site/en/guide/configuration.md:26`；`config.yml:147-151,168+` |
| 既有单测同步 | `tests/optimizer-request-contract.test.ts:77,88,96`；`tests/optimizer-contracts.test.ts:65,89,134`；`tests/optimizer-numeric-regressions.test.ts:68,87,97,113,166,191`；`tests/process-model-trainers.test.ts:79`；`tests/tsdb-quality.test.ts:23,40,55`；`tests/optimizer-schema.test.ts:23-30,85`；`tests/optimizer-authz-regression.test.ts:137-160`；`tests/optimizer-solver.test.ts:40`；`tests/aml-env-lease.test.ts:22`；`tests/optimizer-adapter-registry.test.ts:56-64` |
| live e2e 固定点 | `R1.19:484`、`R1.21:489`、`R3.6:540`、`U1.13:765` 硬编码 unverified → 显式 fixture 不变量或接受 `verified\|unverified` 另测；**`N_RUNS=6`、三处 `testRatio=0.4` 且 `valRatio=0.4`（2/2/2，empirical_max）**；断言总数不再固定；三个回滚 flag 为 env-only，不进 settings |
| 不可判定项定死 | DD-A2 单源验证法；DD-A6/DD-A8 错误码；DD-A7 通知对象；DD-A10 三态；MP-A3 稳定性阈值；MP-A4 自然漂移 fixture；MP-A8 闭式方向/幅度；MP-A9 源码树 vs 打包产物 |

## 6. 里程碑、出口与 DoD

| 里程碑 | 内容 | 出口（全绿才进） |
|---|---|---|
| S0 | SW0 | 载体/ID/DoD/runbook 就绪 |
| M1a | SW1 | MP-A1 |
| M1b | SW2.1–2.4 | MP-A2、MP-A3、MP-A10a |
| M2 | SW3 | DD-A1、DD-A2、MP-A4 |
| M3 | SW4 | DD-A3、DD-A4、DD-A5 |
| M4 | SW5 | DD-A6、DD-A7、DD-A9、DD-A10、MP-A6、MP-A7 |
| M5a | SW6.1–6.2 | MP-A9 |
| M5b | SW6.3–6.6 | MP-A8、DD-A5 复跑 |
| M6 | SW2.5–2.6 + SW7 | DD-A11、DD-A12、MP-A10b、MP-A11、MP-A12、回滚演练 |

每个 SW 的 DoD 见 D30；不以"工具能返回结果"判完成；模拟收益只代表模拟结果。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| UQ 小样本伪 conformal | D2 双模式（≥9 块才称 conformal；否则 empirical_max + coverage=1）；DD-A1 四条负例 |
| 单 run 数据集无法发证 | D18/MP-A2/MP-A3 明确"只能预测"；live fixture 6 run（2/2/2） |
| 单位写错/步限误判 | D23 唯一换算函数 + model 单位比较 + 双值输出 + MP-A7/DD-A6 scale 0.06/2 用例 |
| IR hash 兼容 | D1 不 plumb norm；D26 mdFuture 排除、policy 仅 MD 时入 hash；旧 Profile hash 回归 |
| 审批第二入口/竞态/崩溃 | SW5.4 单一咽喉 + D14 条件取消/提交点/启动对账 + DD-A7 双入口/并发/崩溃 |
| 同配方双写 | D14 共享 `recipeWriteInFlight` 覆盖三前缀 + DD-A4 双向负例 |
| SW6 使互校同源 | D25 比较对钉死 + import 断言 + M5b/M6 复跑 |
| solverRef 分派回归 | D21 分派矩阵（scipy+linear → 422）+ 协议 v1/v2 兼容 + MP-A8 |
| 发布编译 IR 无 context | D21 `compileProblemIRStructure` + 发布/求解 hash 相等测试 |
| 租约错库/误回收/嵌套锁 | D22 `<amlRoot>/runtime/`、pid 死亡必要条件、单点获取、close hook、双 home 测试 |
| Timescale 保留语义 | D29 `drop_chunks`+宽限窗+行级 DELETE；测试钩子；MP-A10b 直连 |
| 回滚留孤儿 | D28 flag + runbook + expand/contract + 演练 |
| 文档/门禁连锁 | §5.3 + SW0.3 + 每 SW DoD |
| 假并行 | D31 M5a/M5b |

## 8. 明确不做

无人值守控制；真实产线自动激励或未授权现场试验；混合整数/离散切换/NMPC 新算法；重写已注册模型工件；把训练静态 UQ 指标当运行时 OOD 判定；本阶段的水位读截止与一致性快照/导出（D29）；IR 版本升级删除 `scaling`（独立小计划）；SciPy 线性实现与 MD 非线性交互（显式 422）。

## 9. 修订账本

### 9.1 v2 → v3：五席回归确认 46 条映射（去重后约 30 组）

| 席 | 条目 | 落点 |
|---|---|---|
| 架构 | N1 同配方跨前缀双写（BLOCKER） | D14 共享 `recipeWriteInFlight`、DD-A4 |
| 架构/治理/平台/数值 | N2 步限单位混用（BLOCKER） | D23/D24/D13⑥ 模型单位比较、MP-A7/DD-A6 |
| 架构/交付 | N3 mdFuture 进 hash（BLOCKER） | D26 显式排除 + 旧 Profile 回归 |
| 数值 | N1 val 侧 conformal 不成立（BLOCKER） | D2 双模式、val rollout 补算、h=ds.P |
| 治理 | N2 取消 vs 提交点竞态（BLOCKER） | D14 条件取消/通知语义、MP-A6 |
| 治理 | N3 decideAndExecute 契约缺失（BLOCKER） | D13/SW5.4 业务拒绝契约、恢复"失败不落 approval_id" |
| 平台 | N2 solverRef 分派回归（BLOCKER） | D21 矩阵（scipy+linear→422）、MP-A8 |
| 平台 | N3 发布编译 IR 无 context（BLOCKER） | D21 `compileProblemIRStructure` |
| 平台 | N4/N6 租约错库/嵌套锁（BLOCKER） | D22 `<amlRoot>/runtime/`、单点获取 |
| 平台 | N5 误回收（BLOCKER） | D22 pid 死亡必要条件 |
| 平台 | N7 close hook 未接线（BLOCKER） | D22 + SW6.1 `server/plugins/workshop.ts` |
| 交付 | B1 `artifact.io` 不存在（BLOCKER） | D2 h=ds.P + io_spec 断言 |
| 交付 | B2 predictor 单位（BLOCKER） | D7 转换方向、DD-A5 scale≠1 |
| 交付 | B3 mdPolicy 进 hash（BLOCKER） | D26 |
| 交付 | B4 单测清单遗漏（BLOCKER） | §5.3 补 4 文件 |
| 交付 | B5 5-run fixture 未落脚本（BLOCKER） | SW3.4 文件列 + MP-A2/MP-A3 |
| 架构 | a4 D11 仍写最新 pass 行 | D11 最新一行必须 pass |
| 架构 | a6 qhat 双算/horizon | D2 单一 qhat、h=ds.P |
| 架构 | a8 rollout 兜底死锁 | D1 norm 非 hash 参数 |
| 架构 | N4 firstMove 形状 | D23 保留旧形状 + `firstMoveEngineering` |
| 架构 | N5 工件 hash 方法 | D12 `readArtifactDescriptor` |
| 架构 | N6 协议版本协商 | D21 v1/v2 兼容 + drain |
| 架构 | N7 崩溃对账 | D14 启动对账、DD-A7 |
| 治理 | N4 REST 拒绝无审计 | D10 每拒绝 1 条 `tool.call.denied`、MP-A1 |
| 治理 | N5 CV 新鲜度 | D13⑥ `now−max(2×beat,60s)` |
| 数值 | N2 targets 单位/offset | D23 targetsUnit、MP-A7 含 offset |
| 数值 | N4 MD 工件版本/交互/闭式范围 | D26 静态线性限定 + KKT 用例 |
| 数值 | N6 MD 不进 inputDistance | D4 追加 MD 偏移 |
| 数值 | N7 静态稳定阈值塌缩 | SW2.3 `max(0.02×target,0.01×scale,1e-9)` |
| 平台 | M1–M9 | 训练子进程 pid、SQLITE_BUSY→ENV_BUSY、typed 能力、协议测试、D23 输出面、D29 保留入口、watermark 分页、MP-A10b 载体、路径残留 |
| 交付 | 1.1/1.5/1.7 | MP-A11 a/b smoke、`lineage_verified` 单标志+manager.ts、D28 演练定死 |
| 交付 | 1.3/1.8 | 已 OK；§5.3 补 `docs/site/cli/index.md:159` |

### 9.2 v3 → v4：五席终审 22 条映射（去重后约 17 组）

| 席 | 条目 | 落点 |
|---|---|---|
| 架构/数值 | typed predictor 单位方向反了（BLOCKER） | D7 模型单位直喂；SW4.2；DD-A5 |
| 架构 | `lineage_verified` 使 live fixture 全变 legacy（BLOCKER） | D18 + SW2.4 补 confirmed segment；DD-A11 |
| 架构 | 跨前缀漏 `recipe:` 第三类 | D14 三前缀；DD-A4 |
| 架构 | mdFuture 两条 hash 回归未绑验收 | MP-A8 + SW6.5 `tests/optimizer-md.test.ts` |
| 架构/数值/平台/交付 | 6-run/valRatio fixture 缺口（BLOCKER） | D2 + SW3.4（6 run, 0.4/0.4）+ DD-A2 empirical_max |
| 治理 | 取消/批准条件转移未闭合（BLOCKER） | D14 `dispatch_state`；D15；DD-A7；MP-A6 |
| 治理 | 批准时在飞去重命中自身 | D14 `excludeApprovalId`；DD-A4 |
| 数值 | 发布编译 IR 与多工况 conditionId hash（BLOCKER） | D21 per-condition `problem_ir_hashes_json`；MP-A8 两工况用例 |
| 数值 | MD 工件缺系数 | D26 `mdB/mdD/mdCoefficients`；SW6.5 |
| 数值/平台 | D23 漏 `dataset-builder`/`targetsUnit`/工具输出 | D23 + SW4.6（shared/units、problem-builder、dataset-builder、optimizer-tools/UI）；MP-A7 |
| 平台 | `ensureVenv` ownership 自相矛盾（BLOCKER） | D22 + SW6.1（无 token 自取/有 token 校验；删外层） |
| 平台 | typed manifest 缺 `provider-contracts.ts` | SW6.3 文件列 |
| 平台 | 协议类型/验证器文件 | D21 `protocolVersion:1\|2`；SW6.4 `problem-ir-validator.ts` |
| 平台 | PID 复用 | D22 + SW6.1/MP-A9 `start_time/boot_id` |
| 平台 | D29 迟到旧 chunk/NULL | D29 `daq_late_samples` + `ingested_at IS NULL` |
| 交付 | D28 演练顺序不成立（BLOCKER） | D28 两阶段（新代码迁移→旧 worktree 插入）；flag 改 env-only |
| 交付 | `artifact.io` 不存在 | D2 h=`ds.P` + `io_spec` 断言 |

### 9.3 v4 → v4.1：终审 6 组落点修正

| 组 | 问题 | 落点 |
|---|---|---|
| 1 | `dispatch_state` 默认 `dispatched` 把未建卡建议误标 | D14/D15 默认 `idle`，建卡 idle→dispatched；批准/取消要求 dispatched+dispatched_at；denied/expired 终态；DD-A7 未建卡→409 |
| 2 | typed predictor 公共调用方仍喂工程单位 | D7 明确转换责任；SW4.6 加 `aml-job-tools.ts`、`eda/vm/predict.post.ts`；MP-A7 覆盖 |
| 3 | 67/67 验收脚本 `ds-acc` 无 confirmed segment | D18/SW2.4 加 `acceptance-optimizer-process-model.ts`；MP-A2 断言验收 fixture 非 legacy |
| 4 | static `h=1` 与 `io_spec.horizonSteps>1` 冲突 | D2 断言按 trainer 分支；SW3.4 spec 强制 static `horizonSteps=1` |
| 5 | `daq_late_samples` 落 workshop 迁移、查询无 union | D15 移出；SW2.6 DDL 落 `sqlite/timescale.adapter.ts`，`tsdb-port.ts` 定义 union；补 `IS NULL` |
| 6 | 多工况 hash 无 repo/manager 落点；旧多工况 Profile 策略缺失 | D21/SW6.4 加 `profile.repo.ts`/`manager.ts`；旧多工况（含 `conditionIds:[]` 且 spec 多条件）→422 `PROFILE_REPUBLISH_REQUIRED`；响应/事件帧同步 `1\|2` |
| 7 | `lineage_verified` 无 repo 持久化路径 | SW2.4 加 `aml/aml.repo.ts`（`AmlDatasetRow/DS_COLS/insert/get/list` 透传） |
| 8 | `conditionIds:[]` 多工况分支漏判 | D21 条件扩为 `length>1 ∨ (length===0 ∧ spec.conditions.length>1)`；MP-A8 用空 conditionIds 两工况用例 |
| 9 | 第三个 typed caller 漏列 | D7/SW4.6 加 `server/api/workshop/aml/models/[id]/predict.post.ts`；MP-A7 三个入口均转换 |
| 10 | MP-A7 的 UI 断言与 M4 出口错位 | MP-A7 只断言工具响应，UI 展示归 DD-A10/M6；D14 SQL 示例补 `dispatched_at IS NOT NULL` |

### 9.4 版本历史

- v1（2026-10-23）：三份来源整合；五席 34 条阻塞。
- v2：34 条 → D1–D31、SW0–SW7、DD/MP 验收；五席回归再提 46 条。
- v3：46 条全部落定；UQ 双模式、单位边界闭合、IR hash 兼容、提交点竞态、租约落位、发布编译 IR、回滚演练定死。
- v4：22 条终审落定；typed predictor 单位、`dispatch_state` 状态机、6-run fixture、多工况 hash、live 谱系、MD 系数、两阶段回滚、租约 ownership/PID 复用、迟到隔离。
- v4.1（本文件，定稿）：6 组落点修正（idle 初态、typed caller、验收夹具谱系、static horizon、迟到表落 TSDB、多工况 hash repo/manager）+ 4 处终审补正（`aml.repo.ts` 谱系持久化、`conditionIds:[]` 多工况、第三个 typed caller、MP-A7 UI 归属）。

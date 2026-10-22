# IDD DOE 分析增强开发计划 v2（本体优先 · 可执行闭环）

- 状态：`proposed`（未开工；supersedes v1）
- 日期：2026-10-17
- 目标仓库：
  - IDD：`D:\codes\myskills\industrial-deep-diagnostic`
  - 平台：`D:\codes\ABO\AgentWorkShop`
- 配套文档：
  - 能力评估：`idd-doe-assessment-2026-10-17.md`
  - 专家评审：`idd-doe-plan-expert-review-2026-10-17.md`
- 评审结论：四席 **ACCEPT WITH CHANGES**；v1 的 6 个 Critical 已在本文修订。

---

## 0. 本次修订的核心（先读这一节）

### 0.1 用户硬要求 → 计划硬门

| 硬要求 | v2 的落实 |
|---|---|
| DOE 分析必须集成深度根因诊断的本体建模 skill | 直接扩展 `industrial-ontology-builder`（`profile=doe`），不另起炉灶；默认 `profile=diagnosis` 行为不变 |
| 先查看是否有相关本体模型 | `doe_ontology_prepare` 先做确定性 store lookup：`profile + scene_key + context_fp`；exact → reuse；同 scene 不同 context → extend；miss → build |
| 没有则按先验知识创建 | 新增 `data_stage=design_only`：只有设计矩阵/因子列也可建本体；用工艺描述 + RAG + web + physics prior；响应行为写 `NOT_APPLICABLE`；不得编造 |
| 确保 Agent 理解场景和场景数据模型 | 新增 `ontology_brief.json/.md`（scene、factors、responses、units、relationships、confounders、columns、coverage、clarification）；DOE Phase 0 强制读取并写 `analysis_plan.md`，否则不得跑统计 |
| 然后再执行 DOE 数据分析 | 本体 stage 完成后才进入 analyzer；brief 缺失且 `ontology.mode != off` 时阻断 |
| 结论能指导 AgentWorkShop 优化作业 | 新增 `optimization_guidance.json` + 平台 `doe_to_optimization`；因子带 `platform_ref`（recipe_param/node_id/plc_tag/单位换算/硬限），下一轮 `next_design.json` 可直接转 recipe patch / setpoints |

### 0.2 v1 六个 Critical 的修订

| v1 问题 | v2 修订 |
|---|---|
| 没有 design-only/prior-only 本体路径 | §3.2 新增 `profile=doe` + `data_stage=design_only`，物化 builder 三件输入 |
| Agent 没有 ontology brief | §3.3 新增 `ontology_brief` 契约 + Phase 0 门禁 + `analysis_plan.md` |
| DOE intent 仍可能绕过本体 | §3.4/§6.4 两处白名单 + `diag_run` 参数 + 先 fast-reuse 再 builder + 生产禁 `off` |
| `doe_context` 与 `analysis_context` 未翻译 | §4.3 新增 `doe_context_adapter`；唯一 `analysis_context.json`；显式 `--data run_table.csv` |
| PI/CI、联合窗口、4-active/9^k 冲突 | §5.1-5.5 四类区间语义、`joint_window/joint_setpoint`、top_k + 连续优化/profile、设计域/凸包/leverage |
| 平台执行/权限/回流不成立 | §6.2-6.5 原子 `doe_run_start/capture/stop`、recipeVersion 冻结、DOE 写族/链式归属、artifact manifest + 幂等 outbox |

---

## 1. 目标与非目标

### 1.1 目标

1. **本体先行**：每次 DOE 分析前先查/建本体，Agent 先理解场景与数据模型，再跑统计。
2. **数据契约**：平台产出 run-level 表 + `doe_context`，IDD 通过适配器转成 `analysis_context`，不再“时序 CSV 直接喂”。
3. **统计可信**：区间语义、联合窗口、约束、单位、多响应、确认布点全部可执行。
4. **全参数关系**：designed 因果效应 + design-adjusted association 分层覆盖；不把相关当因果。
5. **可指导优化**：结论带 `optimization_guidance` 与 `platform_ref`，可直接进入 AgentWorkShop 优化场景（campaign / optimization channel）。
6. **可验收**：每条能力有确定性测试、负路径、traceability 与可复现证据。

### 1.2 非目标

- 不做硬实时控制；所有写入走 recipe 面 + HITL + 四层限界。
- 不自动执行试验；执行由平台/人工完成。
- 不把观测相关升级为因果；不伪造本体关系。
- 本期不做 split-plot/混料/GLM/Box-Cox/VIF/Lenth 的完整实现；但必须显式检测/拒绝，不能误走 observational。
- 不重构诊断管线；`profile=diagnosis` 的行为、输出、CP-2 不变。
- 不做“平台自研统计设计器”；初始设计由 IDD `design_build` 或导入矩阵二选一。

---

## 2. 总体架构

```
┌────────────────────────── AgentWorkShop ───────────────────────────┐
│ DOE Experiment                                                      │
│   design: IDD design_build / imported matrix                        │
│   factors[].platform_ref → recipe_param / node_id / plc_tag         │
│   runs / measurements / constraints / ontology_scene                │
│                              │                                      │
│             doe_export ──────┤                                      │
│                              ▼                                      │
│   run_table.csv + doe_context.json (+ exclusions/)                  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ diag_run(doe-analysis, doe_context_id,
                               │          ontology_mode, ontology_scene)
                               ▼
┌────────────────────────────── IDD ──────────────────────────────────┐
│ 1) doe_ontology_prepare (HARD GATE)                                 │
│    context_fp → store lookup: exact(reuse) / extend / miss(build)   │
│    design_only 也可建；先验知识 + RAG + web + physics               │
│    → 01_ontology/ontology.json + ontology_brief.json/.md            │
│ 2) Agent Phase 0：读 brief → analysis_plan.md                        │
│ 3) DOE analyzer                                                     │
│    designed effects + association screen + ontology consistency     │
│ 4) artifacts                                                        │
│    effect_table / model / association_screen / doe_conclusion /     │
│    recommendations / next_design / optimization_guidance / report   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ artifact manifest + URLs
                               ▼
┌────────────────────────── AgentWorkShop ───────────────────────────┐
│ artifact ingestion (idempotent outbox) → DOE result + analysis link │
│ doe_result / doe_next_design / doe_ingest / doe_to_optimization     │
│ /doe UI + /analysis link                                           │
│ next round: recipe patch + HITL + LineRun + DAQ capture → ...       │
└────────────────────────────────────────────────────────────────────┘
```

### 2.1 设计原则

1. **契约先行**：M0 冻结所有 schema / 文件布局 / artifact manifest，再写实现。
2. **本体先行**：没有 brief 不跑统计；没有本体不进入分析（生产禁 `off`）。
3. **三级优先级**：用户显式 > 本体 > 自动推断；每字段 `assigned_by`。
4. **因果/相关分层**：designed effect 因果级；association screen 相关级且 `causal_claim:none`。
5. **可执行**：窗口必须给 `joint_setpoint`；确认必须给 runs；下一轮必须给 setpoints + recipe patch。
6. **单一来源**：初始设计只由 IDD `design_build` 或导入矩阵提供；平台不自研统计设计。
7. **向后兼容**：schema 加法式 v1.1；现有 136 条 DOE 断言不因语义变更被破坏。

---

## 3. 本体优先门（P0）

### 3.1 先查已有本体：`doe_ontology_prepare`

新增确定性前置阶段，位置在 DOE 统计之前：

```
输入：experiment_id, scene_key, profile='doe', context_fp, data_stage
输出：ontology_status: reused|extended|built|off_debug
      ontology_path, ontology_version, ontology_brief_path,
      coverage, clarification, build_mode, source
```

查找顺序：

1. `profile=doe` + `scene_key` + `context_fp` exact → `reuse`（拷贝 store 资产 + CP-2/CP-3 校验，≤60s）。
2. 同 `profile+scene` 但 `context_fp` 不同 → `extend`（只对新列/新规格增量构建）。
3. 无匹配 → `full` 构建（先验知识优先；有数据再加数据证据）。
4. `rejected/deprecated` 不得复用；`endorsed` 优先；版本钉住。

`context_fp` 必须包含：

- run_table 列集合 + dtype；
- 因子范围/水平/单位；
- 响应规格/goal/目标；
- 设计类型/设计域；
- block/covariate 列；
- 数据阶段（design_only / collected）。

任一变化 → 禁止 exact reuse，转 extend 或新版本。

### 3.2 无本体则先验构建：`profile=doe` + `data_stage`

扩展 `industrial-ontology-builder`（不新建并行引擎）：

- `ONTOLOGY_PROFILE=doe`（默认 `diagnosis`，行为不变）。
- `DATA_STAGE=design_only|collected`。
- `design_only`：允许 `DATA_PATH` 是只有因子列/响应空列的设计矩阵；响应行为字段写 `NOT_APPLICABLE`；禁止推断响应行为。
- 输入物化：
  - `00_input/input_manifest.json`：列、dtype、单位、缺失、角色；
  - `00_input/user_context.json`：产线/产品/配方、目标、工艺描述、已知问题、目标列；
  - `00_input/run_config.json`：`analysis_type=doe`、`data_stage`、`ontology_mode`、`profile=doe`。
- 构建知识源：工艺描述/RAG/领域文档/web/physics prior；每个关系/混杂因子必须有 `source`/`confidence`/`assigned_by`。
- 输出严格 schema：
  - factors → `control_variables`（role=`control`）；
  - responses → `inspection_signals`（role=`target`）；
  - `inspection_signals/process_parameters/control_variables/events/metadata_columns` 与 `metadata` 齐全；
  - `relationships` 带稳定 id、type、mechanism、expected_sign、confidence、source；
  - `confounders` 带 column/measurable/control_strategy/source；
  - `ontology_version`。
- CP-2 使用 store 严格 schema；CP-3 clarification：
  - 无法确定的因子/响应语义 → `INFERRED` + reason；
  - 关键缺失（不知道哪个是响应/目标）→ 写 `clarification_needed.json`，Agent/HITL 询问用户；
  - 不得编造；不得把 `UNKNOWN` 当 `KNOWN`。
- 发布：`profile=doe` + `scene_key` + `context_fp` + `build_mode`；默认 `diagnosis` 不受影响。

### 3.3 Agent 理解契约：`ontology_brief`

新增 `01_ontology/ontology_brief.json` 与 `ontology_brief.md`：

```json
{
  "contract_version": "1.0",
  "scene": {"key": "...", "process_type": "...", "description": "..."},
  "data_model": {
    "columns": [{"name": "zone1_temp", "role": "factor", "dtype": "numeric", "unit": "°C", "range": [180,220], "mapped_signal": "..."}],
    "factors": [{"name": "...", "col": "...", "unit": "...", "range": [...], "expected_sign": "+", "physical_meaning": "...", "ontology_signal": "..."}],
    "responses": [{"name": "...", "col": "...", "unit": "...", "goal": "target", "lsl": 48, "usl": 52, "target": 50, "ontology_signal": "..."}],
    "blocks": [...], "covariates": [...]
  },
  "relationships": [{"id": "rel-...", "from": "...", "to": "...", "type": "causal|physical", "mechanism": "...", "expected_sign": "+", "confidence": "KNOWN|INFERRED", "source": "..."}],
  "confounders": [{"column": "...", "measurable": true, "control_strategy": "...", "source": "..."}],
  "coverage": {"factors": "4/4", "responses": "2/2", "unmatched": []},
  "clarification": [{"question": "...", "status": "open|resolved", "answer": "..."}],
  "ontology_version": "v3",
  "build_mode": "reused|extended|built|off_debug",
  "data_stage": "design_only|collected"
}
```

Agent 门禁：

1. DOE analyzer Phase 0 必须先读 `ontology_brief`；写 `01_profile/analysis_plan.md`：
   - 场景是什么、设备/阶段；
   - 哪些是因子、哪些是响应、单位/规格；
   - 预期方向/机理/混杂；
   - 数据是否足够、哪些结论不能下；
   - 选择 designed 还是 observational、为什么。
2. 没有 brief 且 `ontology.mode != off` → 阻断，返回可行动错误（让 Agent 先跑 `doe_ontology_prepare`）。
3. `off` 只允许显式 debug（admin + audit + `degraded=true`）；生产 DOE 不允许。
4. brief 摘要（≤4KB）注入 `buildIntentDirective('doe-analysis')` 与 `doe_analyze` 回包；完整 brief 用文件读取。

### 3.4 DOE intent 的本体编排

改动点：

- `app/backend/src/services/diagnosis.service.mjs`
  - 两处白名单（创建 + 执行）同时允许 `deep-diagnosis` 与 `doe-analysis`：
    - `resolveOntologyDirective` 不再只对 default intent 生效；
    - 执行阶段 `ontology: runIntent === 'deep-diagnosis' || runIntent === 'doe-analysis' ? meta.ontology : null`。
  - `off` 显式映射为 `off_debug`，不得落为 `auto`。
- `diag_run` / IDD API：
  - 增加 `ontology_mode`（auto|reuse|extend|full|off_debug）、`ontology_scene`、`ontology_source`；
  - `doe_context.ontology.scene_key` 必须传入 `resolveOntologyDirective` 与 `publish --scene`。
- `claude-client.mjs`：
  - `buildIntentDirective('doe-analysis')` 增加本体 stage 指令：先 `doe_ontology_prepare`，读 brief，再按 DOE skill 执行；
  - 不再与“只读 DOE skill”冲突：DOE orchestrator 是唯一绑定协议。
- 新增 `industrial-doe-orchestrator` skill（薄编排，不复制引擎）：
  1. `doe_ontology_prepare`；
  2. Agent 读 brief + 写 `analysis_plan.md`；
  3. `industrial-doe-analyzer`；
  4. ontology consistency；
  5. `next_design` + `optimization_guidance`；
  6. report。
- `codex`/`opencode` 补 `analysisIntent`（P1），避免“选了 DOE 跑诊断”的静默错派。

### 3.5 一致性与回写

- 只对 `type ∈ {causal, physical}` 且 `expected_sign` 可归一化（`+/-/positive/negative`）的关系做符号检查。
- 输出 `checked/matched/not_estimable/contradictions`；
  - `not_estimable` 不进 contradiction；
  - 矛盾默认 advisory；
  - 只有 `quality=endorsed` 且高置信本体才可影响证据等级；不得单独阻断分析。
- 分析后写 `01_ontology/ontology_feedback.json`：
  - confirmed/contradicted relationships；
  - 估计效应/CI；
  - 建议的新关系/新列；
  - 是否 publish 新版本。
- `doe_experiments` 钉住 `ontology_version/hash`；分析 artifact 引用同一版本；context 变化标 stale。

### 3.6 验收（ONT1-ONT12）

见 §9.3。

---

## 4. 数据契约 v2

### 4.1 `run_table.csv`

一行 = 一个 `run_id`（一次执行）；重复执行是新的 `run_id`，不是同一 run 多行。

```
run_id,design_point_id,replicate_group,replicate_kind,run_order,block,<factor_1>,...,<response_1>,...
doerun-a1,dp-1,rg-1,replicate,1,1,185,...
doerun-a2,dp-1,rg-1,replicate,2,1,185,...
```

- `design_point_id`：同一因子组合的分组。
- `replicate_group`：独立重复运行的分组（纯误差用）。
- `replicate_kind`：`repeat|replicate|center`。
- `run_order`：随机化顺序；`block` 可空。
- 响应列允许空单元格（未测/失败），但缺列必须拒绝。
- `run_exclusions.csv` 放 `00_input/exclusions/`，列：`run_id,reason,excluded_at,by`；不得放主数据目录。
- 纯误差按 `replicate_group`（同 block 内）分组；covariate 不参与重复识别。

### 4.2 `doe_context.json`

```json
{
  "contract_version": "1.0",
  "experiment_id": "doe-...",
  "parent_experiment_id": null,
  "round_no": 1,
  "campaign_id": null,
  "line_id": "...", "product_id": "...", "recipe_id": "...",
  "objective": "...",
  "design_type_declared": "ccd",
  "design_region": {
    "factorial_bounds": {"zone1_temp": [180,220]},
    "axial_alpha": 1.414,
    "design_hull": "ccd_star|bbd_hull|full_cube|lhs_hull|imported"
  },
  "data_file": "run_table.csv",
  "factors": [{
    "name": "zone1_temp", "col": "zone1_temp", "type": "numeric", "unit": "°C",
    "min": 180, "max": 220, "levels": null, "role": "control",
    "expected_sign": "+", "physical_meaning": "...", "ontology_signal": "...",
    "platform_ref": {
      "recipe_param": "zone1_temp", "node_id": "dw-...", "plc_tag": "DB1.DBD0",
      "unit_conversion": 1.0, "rounding": 0.1,
      "hard_limits": {"min": 185, "max": 215, "reason": "安全限"}
    }
  }],
  "responses": [{
    "name": "thickness", "col": "thickness", "unit": "um", "goal": "target",
    "lsl": 48, "usl": 52, "target": 50, "weight": 1,
    "ontology_signal": "...",
    "platform_metric_ref": {"node_id": "dn-...", "aggregation": "steady_mean"}
  }],
  "blocks": ["batch"], "covariates": ["ambient_temp"],
  "constraints": [
    {"factor": "zone1_temp", "type": "box", "min": 185, "max": 215, "hard": true, "reason": "安全限", "source": "ontology"},
    {"type": "linear", "coefficients": {"zone1_temp": 1, "zone2_temp": 1}, "rhs": 400, "hard": true, "reason": "总热负荷"}
  ],
  "replicates_col": "replicate_group",
  "run_order_col": "run_order",
  "group_col": "run_id",
  "time_col": null,
  "current_setpoint": {"zone1_temp": 200},
  "baseline_source": "platform_recipe|dataset_median",
  "ontology": {
    "profile": "doe",
    "mode": "auto",
    "scene_key": "castfilm-lineA-productP",
    "version": "v3",
    "data_stage": "design_only|collected",
    "source": null
  },
  "provenance": {"platform": "AgentWorkShop", "created_by": "...", "created_at": "..."}
}
```

规则：

- `col` 必须与 `run_table.csv` 表头完全一致。
- `goal` 缺失 → 由本体/规格推断并标 `assigned_by`；无依据则不进入联合 desirability。
- `constraints[].type=box|linear|safety`；不支持的约束类型 fail closed。
- `platform_ref` 缺失 → 不得声称可指导平台优化；只能做离线分析。

### 4.3 `doe_context → analysis_context` 适配器

新增 `doe_context_adapter`（IDD 侧 Python 或平台侧导出前转换，二选一，**以 IDD 侧为权威**）：

- 输出唯一 `00_input/analysis_context.json`：
  - `data_path: "00_input/run_table.csv"`；
  - factors/responses 用 `col`；
  - units/goals/limits/constraints/blocks/covariates/replicates/ontology 全部映射；
  - 每字段 `assigned_by: user|ontology|auto`；来源链。
- `analyze.py` 改为显式 `--data 00_input/run_table.csv --context 00_input/analysis_context.json`；
  - `_find_data` 只作为 fallback，排除 `analysis_context.json`、`doe_context.json`、`run_exclusions.csv`、`manifest.json`、`README*`；
  - 不再按 `00_input` 首文件猜。
- `run_exclusions.csv` 放 `00_input/exclusions/`，不进数据发现目录。
- 禁止 `analysis_context.merged.json` 作为候选数据文件；合并结果直接写 `analysis_context.json`。

### 4.4 Artifact manifest

IDD 在 tasks result 与 external result 都暴露同一份 manifest：

```json
{
  "contract_version": "1.0",
  "diag_run_id": "...",
  "artifacts": [
    {"kind": "ontology", "path": "01_ontology/ontology.json", "url": "...", "sha256": "...", "schema_version": "1.0"},
    {"kind": "ontology_brief", "path": "01_ontology/ontology_brief.json", "url": "...", "sha256": "..."},
    {"kind": "ontology_coverage", "path": "01_ontology/ontology_coverage.json", "url": "...", "sha256": "..."},
    {"kind": "data_profile", "path": "01_profile/data_profile.json", "url": "...", "sha256": "..."},
    {"kind": "effect_table", "path": "02_analysis/effect_table.json", "url": "...", "sha256": "..."},
    {"kind": "model", "path": "02_analysis/model.json", "url": "...", "sha256": "..."},
    {"kind": "association_screen", "path": "02_analysis/association_screen.json", "url": "...", "sha256": "..."},
    {"kind": "doe_conclusion", "path": "conclusions/doe_conclusion.json", "url": "...", "sha256": "..."},
    {"kind": "recommendations", "path": "conclusions/recommendations.json", "url": "...", "sha256": "..."},
    {"kind": "next_design", "path": "conclusions/next_design.json", "url": "...", "sha256": "..."},
    {"kind": "optimization_guidance", "path": "conclusions/optimization_guidance.json", "url": "...", "sha256": "..."},
    {"kind": "report_html", "path": "report.html", "url": "...", "sha256": "..."}
  ]
}
```

平台拉取：

- 唯一键 `(diag_run_id, kind, sha256)`；幂等；失败指数重试。
- schema 校验；缺失/部分失败显式失败，不得只回退 report path。
- `doe_result` 只回摘要 + artifact 引用/分页；大 JSON 不经过 16k 截断。

### 4.5 验收（DC1-DC8）

见 §9.1。

---

## 5. 统计合同 v2

### 5.1 四类区间语义（A0）

| 字段 | 含义 | 用途 |
|---|---|---|
| `expected_effect.ci95` | 效应 delta 的置信区间（`delta ± t·SE(delta)`，delta 为每 +1 原始单位） | 推荐效应不确定性 |
| `prediction_interval` | 未来单次运行的预测区间（`MSE·(1 + x0'X⁻¹x0)`） | W1 可行域、单点达标 |
| `mean_ci` | 均值响应置信区间（`MSE·x0'X⁻¹x0`） | 均值/趋势 |
| `tolerance_interval` | 面向 Cpk/合格率的容差区间 | 本期不实现，显式拒绝；不得用 PI 冒充 |

每个窗口必须带：

- `window_basis: prediction_interval|mean_ci`；
- `interval_type`；
- `coverage_scope: pointwise|simultaneous|per_response`；
- `conditional_on`（非 active 因子/block/covariate 取值）。

规则：

- 双限用 `t_{0.975}`；单侧目标用 `t_{0.95}`。
- `se=None` 或 `df_resid=0` → 不出数值窗口，写 `no_window_reason`。
- 多响应报告逐响应覆盖 + Bonferroni/联合覆盖；不得把逐响应 95% 说成联合 95%。
- `expected_effect.ci95` 不得用 PI 填；PI 单独字段。

### 5.2 联合窗口 vs 边际窗口（A5b）

- `response_windows`：逐响应、逐因子边际窗口（诊断/可视化）。
- `joint_window` / `joint_setpoint`：所有响应同时可行的联合点/区域。
- 下游只允许执行 `joint_setpoint`；逐因子窗口中点不保证联合可行。
- 冲突排序不用跨单位 `|delta|`；用标准化效应 `|delta|/sigma_response`、desirability 贡献或 Pareto。
- `conflict_type: goal_conflict|range_conflict|joint_infeasible`；loser 进 watchlist + `requires_reconfirmation=true`。
- `window_conditional_on` 必填；`D` 语义写 `weighted geometric mean desirability, not yield`。

### 5.3 设计域与 leverage（A9）

- `design_region` 进入网格/refine/窗口：`factorial_bounds`、`axial_alpha`、`design_hull`。
- 网格只在 `design_region ∩ constraints ∩ observed_ranges`。
- 每个候选点记录 `max_leverage`、`distance_to_design_hull`、`extrapolation`；CCD/BBD 不得评估未运行角点。
- LHS 最高 `medium` confidence，除非有重复/leverage 证据。
- `_connected_shape` 改名为 `marginal_gap`，不得承诺联合连通性；真正连通性用候选点图连通分量（可选）。

### 5.4 Active 因子与计算规模（A5c）

- 效应表覆盖所有 factor × response（不受 active 限制）。
- 窗口：
  - 网格只用于 `top_k`（默认 2-4）个因子的二维/三维可视化与投影；
  - 全维 desirability 用连续优化（L-BFGS-B/SLSQP/trust-constr，多起点：中心、网格最优、baseline、约束投影点）；
  - 其余因子用 1-D profile（固定该因子，优化其余因子，求可行边界）或条件切片；
  - `max_grid_factors` 默认 4；超出时输出 `no_window_reason`，不得静默丢弃。
- active 因子按 response 分别确定；联合 desirability 用并集，但逐响应窗口不得把只对另一响应显著的因子算进来。
- 性能验收按 active 数分档（见 REG4），不再用“20 因子全 2FI”。

### 5.5 约束与单位（A3/A2）

约束：

- schema 扩展 `type=box|linear|safety`、`coefficients`、`rhs`、`hard`、`reason`、`source`。
- 进入：grid、refine、window projection、confirmations、next_design、平台执行器 recipe 限界。
- 硬约束：0 违例；无可行点 → 无窗口 + `INFEASIBLE_CONSTRAINTS`；禁止 `cand = feas` 回退。
- 软约束：进入 desirability 惩罚/辅助 d_i；仅 warning 的软约束不得进入推荐窗口。
- `constraints` 合同记录 `applied: [grid,refine,projection,next_design]`、`violation_count`、`status`。
- 优化器 `resolve_domain` 与 `recommendations.constraints` 求交；O-G2/O-G5 校验。

单位：

- 删除 `"response units"` 回退。
- `unit_display` / `unit_canonical` / `conversion_factor`；支持 mm/µm/m、°C/K、%/fraction。
- 缺失 → `unit_status: missing|inferred|confirmed|conflict`；缺失/冲突时 actionable window 阻断。
- 检查 context/ontology/recipe/measurement 四处一致性；冲突按 用户 > 本体 > auto，记录 `unit_conflict`。
- `factor_unit`、response unit、`expected_effect.unit` 必须来自同一单位链。

### 5.6 多响应（A5d）

- 输出 `factor × response` 矩阵：每格 `window` 或 `no_window_reason`。
- 每个 response 独立窗口；联合 setpoint 用 desirability/Pareto。
- 不允许“每因子只归因一个响应”。
- 多响应冲突/优先级按标准化效应/权重，不按跨单位 delta。

### 5.7 全参数关系（A6/A10）

分层：

1. `designed_effect`：因果级，来自随机化设计。
2. `design_adjusted_association`：非因子参数加入设计模型/残差模型，报告 extra SS/偏相关/CI（主口径）。
3. `marginal_association`：仅线索，标 `confounded_by`；`causal_claim:none`。
4. `held_constant`：未变化，不可估计，不给 p。
5. `unmodeled`：只给探索性 r，不给可执行建议。

规则：

- 排除 index、run_order、replicate、block、time、response、ID、常数、派生/泄漏列。
- lag 仅在有真实 `time_col` 且按时间排序时计算；否则 `lag=null, lag_note=not_applicable`。
- 每响应一个 BH family；报告 family size、最小 n/CI 宽度；小 n 只给描述统计。
- `actionable:false`、`evidence_layer:association`；G8 禁止 association 进入窗口/setpoint/confirmation/next_design。

### 5.8 确认与下一轮设计（A4/D1）

`confirmations[]` 扩展：

```
{id, reason, method, runs:[{factor settings, replicate, block, reason}],
 constraints, expected_information}
```

- aliased fractional → fold-over：数值因子全镜像 + 新 block + 中心点；类别因子别名 → D-optimal/其他；post-alias 检查。
- linear-only / 曲率不足 → augment：face-centered star/轴点或含二次项 D-optimal，不是只加中心点。
- extrapolation/边界最优 → space-filling：条件 maximin，保留已有 runs，不是全新 LHS。
- NON_RANDOMIZED → confirmation_needed=true + ≥3 重复（联合 setpoint + 边界/角落）。
- designed 的外推/非随机化/LOF 显著/低置信 → 同样强制 `confirmation_needed=true`。
- `next_design.json` 增加 `expected_information`（D-efficiency、max VIF、expected CI width、post-alias chains）。

### 5.9 初始设计生成（C0/D0）

- **单一 owner**：IDD 新增 `design_build`（full/fractional/CCD/BBD/LHS/D-optimal/imported）。
- 输出：`design_matrix.csv` + `design_spec.json`（分辨率/别名/VIF/condition/leverage/power/MDE/随机化/block）。
- 平台只负责导入/持久化/校验，不自研统计设计器。
- 若本期不做 `design_build`，平台只支持 imported matrix，并在 UI/文档明确“不生成设计”；不得两头都承诺。
- power/MDE 在创建时校验：`power<0.8` → 拒绝或显式 override + 记录。

### 5.10 向后兼容（A7b）

- schema 加法式 v1.1：新字段 optional；`contract_version` 保持 1.0 或升 1.1 并提供 v1.0 reader。
- 同步更新 `quality_gate.mjs` 的 `REC_KEYS`/`WIN_KEYS`/`CONC_KEYS`、`REPORT_PATHS`、`MODE_REQUIRED_ARTIFACTS`、report section ids。
- `units_ok`/`constraints_ok`/`ci_ok`/`ontology_consistency_ok` 放入 `contract_status`/`consistency_status`，不放入 `evidence_grade`。
- 现有 136 条断言逐条保持不变；语义变更必须列出被修改的断言和原因。

### 5.11 验收（IDD1-IDD12）

见 §9.2。

---

## 6. 平台 DOE 一等公民 v2

### 6.1 数据层

```
doe_experiments
  id, line_id, product_id, recipe_id, title, objective,
  design_type, design_hash, context_hash, randomization_seed,
  factors_json, responses_json, design_json, constraints_json,
  ontology_scene, ontology_mode, ontology_version, ontology_hash,
  parent_experiment_id, round_no, campaign_id,
  status, created_by, created_at, updated_at, archived_at

doe_runs
  id, experiment_id, run_order, design_point_id, replicate_group,
  replicate_kind, block, factor_values_json, status,
  recipe_version, recipe_run_id, line_run_started_at, line_run_ended_at,
  started_at, ended_at, exclusion_reason, created_at, updated_at

doe_measurements
  id, run_id, response, value, unit, ts, quality,
  source (daq|mes|manual), window_from, window_to, n_samples, mean, std,
  artifact_ref, created_at
```

约束：

- 唯一索引：`(experiment_id, run_order)`、`(experiment_id, design_point_id, replicate_group, block)`、`(run_id, response) WHERE status='done'`。
- `recipe_run_id` 关联 `RecipeRunView.id`（`rr-*`）；不要伪造 `line_run_id` 表。
- `design_hash`/`context_hash`/`randomization_seed` 不可变；设计变更必须新版本。
- 软删除/archived；不级联物理删除证据。
- `analysis_reports` 增加 `doe_experiment_id`、`diag_run_id`、`artifacts_json`；迁移用 `migrateAddColumn`。
- 保留/备份：`data/doe-exports` 纳入备份；被实验引用的导出 pin 不可删；retention 登记。

### 6.2 原子执行契约

新增 `doe_run_start` / `doe_run_capture` / `doe_run_stop`：

```
doe_run_start(run_id):
  1. 校验 experiment/run 归属、design_hash、硬约束、recipe/platform_ref
  2. 冻结 recipeVersion（或创建临时 recipe version）
  3. repo.createRun(recipe, overrideParams)  ← 必须支持 paramsOverride
  4. setActiveLineRun(...)
  5. writeRecipeParams(recipe, run)
  6. 记录 doe_runs.status=running + recipe_run_id + started_at
  7. 写审计（outbox/事务）

doe_run_capture(run_id):
  1. 等 settle 窗（可配置）
  2. queryTagged({recipeRunId, runId, window}) → 稳态段
  3. 聚合 mean/std/n/quality → doe_measurements
  4. 不足/越限 → status=excluded + reason

doe_run_stop(run_id):
  1. lineStop（关闭 LineRun）
  2. closeRun(recipe_run_id)
  3. doe_runs.status=done/excluded
```

- 每线互斥：同一 line 同时只允许一个 DOE run；实验级队列/锁。
- 状态机：`planned → starting → running → capturing → done|failed|excluded|aborted`。
- 失败/崩溃恢复：reconcile `running` 孤儿；lineStart 的僵尸清理只清 RecipeRun，不修 DOE 状态 → DOE 自己修。
- 禁止用 `recipe_trial` 循环模拟 run（运行门要求活动 run）。
- `line_start` 扩展或新增 `doe_run_start` 二选一；推荐新增，保持旧接口不变。

### 6.3 HITL 与批量审批

- 逐 run HITL 可行但重；批量审批必须定义为：
  - 批准一份不可变 design 快照：`design_hash + run 列表 + 约束`；
  - 每个 run 执行时校验 `design_hash`，把 `approval_id` 写入 run/audit；
  - 批准后不得改 setpoints；改则新 design_hash + 新审批；
  - 拒绝/超时 → 实验 paused，不自动继续。
- 不允许执行器直接调 `controller.lineStart` 绕过 `toolLineStart`；所有写仍走 recipe 面 + 四层限界。
- 硬约束优先于审批：即使批准，越硬限也拒绝。

### 6.4 权限与工具

- DOE 变更型工具加入 `WRITE_TOOLS`：`doe_create`、`doe_design`、`doe_export`（读但暴露数据）、`doe_analyze`、`doe_ingest`、`doe_run_start/capture/stop`、`doe_to_optimization`。
- `grant-guard.resolveTargetLines` 增加链式解析：
  - `experiment_id` → `line_id`；
  - `run_id` → experiment → `line_id`；
  - `doe_export` → experiment/line；
  - 解析不到 → fail closed，不回退 agent 绑定。
- `tool-verify` 增加 DOE 链式引用：experiment/run → line；跨线拒绝。
- 注册五处：`INDUSTRIAL_HANDLERS`、`tool-verify`、`WRITE_TOOLS`、`.AgentWorkShop/prompts/host-tools.json`、catalog/observational 白名单。
- `doe_export` 复用 `daq_export` 的节点绑定校验；不得自己读 tsdb 绕过。

### 6.5 Artifact 回流

- IDD tasks result + external result 都暴露 §4.4 manifest；不只改 external。
- 平台 sweep 通过幂等 outbox 拉取：
  - 唯一键 `(diag_run_id, kind, sha256)`；
  - 失败指数重试；完成态不再只写一次；
  - 缺失/partial → `doe_result.partial=true` + 明确错误；
  - schema 校验失败 → 拒绝入库 + audit。
- 插件服务面：新增 `doeArtifacts` service 或受鉴权内部 API；sweep 不直接写 DB。
- `doe_result`：摘要 + artifact 引用/分页；加入 `TRUNCATE_OPT_OUT_TOOLS` 或文件读取路径。
- `analysis_reports` 唯一键 `(doe_experiment_id, diag_run_id)` 防重复台账。

### 6.6 API 与 UI

REST：

- `GET/POST /api/workshop/doe/experiments`
- `GET/PATCH /api/workshop/doe/experiments/:id`
- `GET /api/workshop/doe/experiments/:id/runs`
- `POST /api/workshop/doe/experiments/:id/export`
- `POST /api/workshop/doe/experiments/:id/analyze`
- `GET /api/workshop/doe/experiments/:id/result`
- `GET /api/workshop/doe/artifacts/:diagRunId/:kind`
- `POST /api/workshop/doe/experiments/:id/next-design`
- `POST /api/workshop/doe/experiments/:id/to-optimization`

UI `/doe`：

- 实验列表/新建（因子、响应、设计、约束、本体场景）。
- 设计矩阵（run_order/block/factors/responses/status）。
- 执行状态（recipe version/recipe_run_id/DAQ 窗口/排除原因）。
- 结果：Ontology Brief、效应表、Pareto、主效应/交互、RSM 等高线、逐响应窗口、joint setpoint、确认计划、证据等级、本体一致性。
- 链接 `/analysis` DOE 报告。
- 导航/i18n/事件着色同步。

### 6.7 优化 handoff

`optimization_guidance.json`：

```json
{
  "contract_version": "1.0",
  "experiment_id": "...",
  "diag_run_id": "...",
  "ontology_version": "...",
  "objective": "...",
  "recommended_setpoint": {"zone1_temp": 205, ...},
  "windows": [...],
  "expected_effects": [...],
  "constraints": [...],
  "confidence": "...",
  "applicability_domain": {...},
  "next_design_ref": "conclusions/next_design.json",
  "ontology_basis": [...],
  "platform_refs": {"zone1_temp": {"recipe_param": "...", "node_id": "..."}}
}
```

平台：

- `doe_to_optimization`：创建/更新优化 campaign（`optimizer_campaign`）或优化频道 objective/scene contract。
- 写入 `optimization_explorations` 或 campaign 表；记录 `doe_experiment_id`/`round_no`/`parent_experiment_id`。
- 优化器只消费 designed + confidence≥medium + 已确认的窗口；observational/外推/未确认 → `rejected_prior`。
- `next_design` 的 setpoints 同时输出 `recipe_patch` 与 `node_setpoints`；平台执行前校验 recipe/硬限。
- 验收：Agent 能回答“为什么选这些因子/窗口/下一轮”，并且优化场景能用上。

### 6.8 验收（PLAT1-PLAT9 / LOOP1-LOOP7）

见 §9.4-9.5。

---

## 7. 工作流与文件清单

### 7.1 IDD

| 工作包 | 文件 |
|---|---|
| 区间/窗口/约束/单位 | `scripts/doestats/{effects_anova,windows,rsm}.py`、`schemas/*.json` |
| 设计域/leverage | `scripts/doestats/design_detect.py`、`windows.py` |
| Association screen | 新 `scripts/doestats/association_screen.py` |
| Next design | 新 `scripts/doestats/design_next.py` |
| Initial design | 新 `scripts/doestats/design_build.py` |
| Ontology adapter | 新 `scripts/doestats/ontology_adapter.py`、`ontology_consistency.py` |
| Ontology profile | `industrial-ontology-builder/SKILL.md`、`references/agent-protocol.md`、`schemas/ontology_schema.json` |
| Store | `.claude/shared/scripts/ontology_store.mjs`（profile/context_fp/version） |
| Intent orchestration | 新 `industrial-doe-orchestrator/SKILL.md`；`diagnosis.service.mjs`、`claude-client.mjs`、`codex-client.mjs`、`opencode-client.mjs` |
| Artifact API | `external.service.mjs`、`diagnosis.service.mjs`（tasks result）、`omp.service.mjs` |
| Gate | `scripts/quality_gate.mjs`、`scripts/analyze.py` |
| Tests | `tests/run_tests.py`、`tests/fixtures/doe/*` |

### 7.2 AgentWorkShop

| 工作包 | 文件 |
|---|---|
| DB | `db/database/schema.ts`、`schema.sql`、migrations、`doe/doe.repo.ts` |
| Design/export | `doe/doe-design.ts`、`doe-export.ts`、`doe-context-adapter.ts`（或 IDD 侧） |
| Tools | `agents/industrial/doe-tools.ts`、`host-tool-bridge/tools/industrial.ts`、`host-tools.json`、catalog |
| diag-bridge | builtin + project 单一权威源；`plugin.mjs`、`diagnosis.mjs`、`sweep.mjs`、`exports.mjs` |
| Execution | `doe/doe-executor.ts`、`doe-run` 工具、recipe/HITL 接线 |
| Artifact | `doe/doe-artifacts.ts`、outbox/retry、`doe_result` |
| API/UI | `server/api/workshop/doe/*`、`app/pages/doe/*`、`app/components/doe/*` |
| Ledger | `analysis_reports` 迁移、`analysis-tools.ts`、`/analysis` 过滤 |
| Handoff | `doe/doe-to-optimization.ts`、campaign/optimization channel 接线 |
| Tests | `tests/doe-*.test.ts`、`tmp-e2e/doe-closedloop-*.mjs` |

---

## 8. 测试计划与 traceability

### 8.1 Fixtures

| Fixture | 目的 |
|---|---|
| `full_2^4` | 主效应/交互/ANOVA/效应恢复 |
| `fractional_resIV` | 别名链/fold-over |
| `ccd_optimum` | RSM/驻点/设计域/星点 |
| `bbd_multi_response` | 多响应/冲突/joint setpoint |
| `oa_lhs` | 正交表/LHS 识别/置信 |
| `constraints_binding` | 无约束最优点在约束外 → 约束后可行 |
| `non_randomized` | 强制确认 |
| `imported_matrix` | 导入设计 + 性质校验 |
| `multi_file` | 目录/多文件→preprocessor→DOE |
| `failed_run` | 排除/缺失/部分 artifact |
| `ontology_reuse` | store 命中/≤60s |
| `ontology_prior_only` | design-only 建本体 |
| `ontology_contradiction` | 预期方向冲突 |
| `association_confounder` | 混杂/设计调整 |

每个 fixture 带 `truth.json`（效应/最优点/期望窗口/ONT 关系）。

### 8.2 E2E

1. 隔离实例（AW_MODE=home、AW_HOME tmp、AW_RATE_LIMIT_OFF=1）。
2. 建线/产品/配方/节点；创建 2^3 + 3 中心点（3 因子/1 响应/11 runs）。
3. `doe_ontology_prepare`（reuse 或 prior-only）→ Agent 读 brief → `analysis_plan.md`。
4. 每 run：`doe_run_start` → recipe version 冻结 → LineRun → DAQ 采样 → `doe_run_capture` → `doe_run_stop`。
5. `doe_export` → `doe_analyze` → 轮询 → `doe_result`。
6. 断言：效应/窗口/joint setpoint/本体一致性/台账/UI。
7. `doe_next_design` → 3 个确认 run → 再分析 → 收敛/推荐。
8. 至少一轮 ontology reuse、一个多响应实验、一次失败注入、一次权限拒绝。
9. 清理实例；报告落 `.AgentWorkShop/analysis/doe-closedloop-<date>.md`。

### 8.3 Traceability matrix

M0 建立：

```
验收 ID → 测试 case → fixture → 证据文件 → 命令 → 期望输出
```

没有映射的验收项不得标记 PASS。

### 8.4 命令

```bash
# IDD
cd /d/codes/myskills/industrial-deep-diagnostic
uv run --project .claude/shared/scripts python .claude/skills/industrial-doe-analyzer/tests/run_tests.py all
node .claude/skills/industrial-doe-analyzer/scripts/quality_gate.mjs <RUN_DIR> \
  --skill-path <IDD>/.claude/skills/industrial-doe-analyzer \
  --shared-path <IDD>/.claude/shared

# AgentWorkShop
npm run test:unit
npm run typecheck
npx eslint <changed files>
node tmp-e2e/doe-closedloop-2026...mjs
```

M0 记录双仓库 SHA、工作树状态、Node/Python/uv 版本、硬件规格。

---

## 9. 验收规范 v2

> P0 = 发布阻断；P1 = 发布门槛（可分批，但 DoD 前必须全绿）；P2 = 后续增强。所有阈值必须可复现。

### 9.1 数据契约（DC）

| ID | 验收条件 | 阈值/证据 | 优先级 |
|---|---|---|---|
| DC1 | 创建 DOE 实验（3 因子/2 响应/16 runs），设计矩阵回读 | 字段 100% round-trip；缺列/重复 run_order 拒绝 | P0 |
| DC2 | `doe_export` 产 `run_table.csv` | 一行一个 run_id；`design_point_id/replicate_group` 完整；runs 覆盖 100%；空单元格允许并计数 | P0 |
| DC3 | `doe_context.json` schema 校验 | 0 error；col/unit/goal/constraints/platform_ref/ontology 齐全 | P0 |
| DC4 | 导出→导入语义 round-trip | JSON 排序键+数值 1e-9；CSV 解析逐字段；不要求字节一致 | P1 |
| DC5 | 非法输入拒绝 | 缺列/越界/重复 run_order/响应缺列 → 可行动错误；空单元格不拒 | P0 |
| DC6 | `diag_run` 传递 DOE context | task payload 含 context；问题为 DOE 模板（不含“深度根因诊断”） | P0 |
| DC7 | `doe_context → analysis_context` 真正被消费 | IDD 输出 factors/responses/units/goals/constraints 与平台 context 一致；不得 auto-infer 兜底 | P0 |
| DC8 | 初始设计/导入矩阵性质 | 分辨率/别名/中心点/随机化/block/replicate/power 校验；导入矩阵也校验 | P0 |

### 9.2 IDD 统计（IDD）

| ID | 验收条件 | 阈值/证据 | 优先级 |
|---|---|---|---|
| IDD1 | 设计识别 | full/fractional/CCD/BBD/OA/LHS 6/6；别名链/分辨率正确 | P0 |
| IDD2 | 效应恢复 | 1000 次 Monte Carlo；≥2×MDE 的效应符号正确率 ≥99%、power ≥80%；top-3 排序在间隔≥2×MDE 时正确；全局 null FWER ≤10% | P0 |
| IDD3 | factor×response 覆盖 | coverage 含每格；常数/别名标 `not_estimable` + reason；0 静默 | P0 |
| IDD4 | 多响应 | factor×response 矩阵每格 window 或 `no_window_reason`；联合 desirability；不按跨单位 delta 选赢家 | P0 |
| IDD5 | 约束 | 绑定约束测试（无约束最优点在约束外→约束后可行）；hard 0 违例（1e-9）；不可行→无窗口+reason；grid/refine/window/confirm/next_design 全覆盖 | P0 |
| IDD6 | 单位 | unit 或 `unit_status=missing+reason`；0 静默；mm/µm、°C/K 冲突负例；缺失/冲突阻断 actionable window | P0 |
| IDD7 | 预测区间 | ≥2000 未来观测、5 区域/5 种子；点覆盖 93.5-96.5%；PI 宽>均值 CI；多响应报告联合覆盖 | P0 |
| IDD8 | 确认可执行 | aliased→fold-over runs；linear→augment star；non-randomized→confirmation；每项含 settings/block/replicate | P0 |
| IDD9 | 证据等级/门禁 | A/A-/B rubric；tamper 负例 FAIL；G1-G11 全绿 | P0 |
| IDD10 | 确定性与 HTML | 同输入两次数值一致；无 NaN/Inf；report.html ≥20KB + hash 可溯 | P0 |
| IDD11 | association screen | 每非因子参数×响应有记录；设计调整/边际/held_constant/unmodeled 分层；`causal_claim:none`；G8 禁止进窗口 | P1 |
| IDD12 | >4 active 因子 | 8/10/20 active 的窗口生成有界、可复现；输出 active 数/算法/`max_grid_factors`；性能达标 | P1 |

### 9.3 本体（ONT）

| ID | 验收条件 | 阈值/证据 | 优先级 |
|---|---|---|---|
| ONT1 | DOE profile 构建 | 4 因子/2 响应 → 4 control + 2 target；unit/meaning/confidence 齐全；严格 schema 通过；≥1 relationship/因子（有依据时）；不足则不编造 | P0 |
| ONT2 | reuse | 同 profile/scene/context_fp → `ontology_hit=reused`；≤60s；无 full rebuild/RAG/web（pipeline event 证明） | P0 |
| ONT3 | extend | 新列/新规格 → 只增量；已有 role 不变；coverage 列出新列 | P1 |
| ONT4 | 映射覆盖 | factor/response 100% matched 或 `inferred+reason`；0 静默；auxiliary unmatched 允许但必须有 reason | P0 |
| ONT5 | 方向一致性 | 仅 causal/physical + 可归一化 sign；checked/matched/not_estimable/contradictions；矛盾 advisory，不单独阻断 | P0 |
| ONT6 | 混杂/区组 | confounder 可测 → block/covariate 建议；不可测 → 披露；block 项被估计/自由度/方差披露 | P1 |
| ONT7 | 报告引用 | 每个引用 id 存在于 ontology；允许 `no_ontology_basis+reason`；无编造 | P0 |
| ONT8 | 优先级/assigned_by | 用户 > 本体 > auto 的逐字段优先级；冲突可追踪；测试三组冲突 | P0 |
| ONT9 | unmatched/provenance | 每个 ontology 字段有 source/confidence/version；unmatched 有 reason | P0 |
| ONT10 | profile/context_fp/版本 | 跨 profile 不复用；context 变化→extend/新版本；rejected 不复用；experiment 钉住 version/hash | P0 |
| ONT11 | 结论→执行映射 | 每个 `joint_setpoint`/`next_design` 因子有 `platform_ref`；可生成 recipe_patch/node_setpoints | P0 |
| ONT12 | 诊断回归 | 默认 diagnosis profile 的 ontology 行为/CP-2/输出不变；诊断 E2E 绿 | P0 |
| ONT13 | prior-only | design_only（响应空）可建 ontology + brief；`observed_data_behavior=NOT_APPLICABLE`；不跑统计；Agent brief 可读 | P0 |
| ONT14 | Agent 理解门 | 无 brief 且 mode!=off → 阻断；Agent 写 `analysis_plan.md`；回答因子/响应/方向/混杂/局限；数值与 brief 一致 | P0 |

### 9.4 平台（PLAT）

| ID | 验收条件 | 阈值/证据 | 优先级 |
|---|---|---|---|
| PLAT1 | DOE 工具面 | create/design/export/analyze/result/next_design/ingest/to_optimization 全部注册可调；权限/产线作用域 | P0 |
| PLAT2 | 意图修复 | `diag_run(doe-analysis)` 无显式 question 时发 DOE 模板；不含“深度根因诊断” | P0 |
| PLAT3 | artifact 回流 | 全量 schema + hash + version；12 类工件；10 个关键字段额外 hash 比对 | P0 |
| PLAT4 | `doe_result` | 摘要+引用/分页；大 JSON 不走 16k；可按文件读 | P0 |
| PLAT5 | 台账关联 | `analysis_reports` 含 experiment/diag/artifacts；按 experiment 查询；唯一键防重复 | P1 |
| PLAT6 | UI | `/doe` 矩阵/效应/窗口/joint/确认/本体 brief/一致性；DOM 数值与 API 一致；桌面+窄屏 | P1 |
| PLAT7 | 权限/审计 | 跨线 experiment/run 拒绝；写工具进 WRITE_TOOLS；HITL 拒绝/超时；审计 outbox | P0 |
| PLAT8 | artifact 缺失/幂等 | 部分缺失显式失败；重复拉取幂等；坏 schema 拒绝；重试可恢复 | P0 |
| PLAT9 | Agent 理解 | Agent 能通过工具回答因子/窗口/证据/因果层级；引用可定位；不把 association 当因果 | P0 |

### 9.5 闭环（LOOP）

| ID | 验收条件 | 阈值/证据 | 优先级 |
|---|---|---|---|
| LOOP1 | 下一轮布点 | fold-over/augment/space-filling/confirm 方法正确；setpoints 在 design_region∩constraints∩observed；含 expected_information | P0 |
| LOOP2 | optimizer 衔接 | 只消费 designed+confidence≥medium+已确认窗口；rejected_prior 可追踪；O-G1..O-G8 通过 | P0 |
| LOOP3 | 平台执行 | run 窗口内样本 100% 可关联 recipe_run_id；窗口外允许 null；settle/capture/stop 顺序正确；0 静默归属 | P0 |
| LOOP4 | 端到端 | 3 轮模拟/真实产线；目标达成或明确未收敛 reason code；所有工件可追溯；无手改 | P0 |
| LOOP5 | 安全 | 越界/硬约束 100% 拒绝；HITL 必走；四层限界；审计可查 | P0 |
| LOOP6 | handoff 合同 | `optimization_guidance` → campaign/optimization channel；parent/round/campaign 谱系；Agent 能解释为什么 | P0 |
| LOOP7 | 并发/恢复 | 同线实验互斥；重复 ingest 幂等；崩溃重启 reconcile；artifact 重试；HITL 超时收敛 | P1 |

### 9.6 回归（REG）

| ID | 验收条件 | 阈值/证据 | 优先级 |
|---|---|---|---|
| REG1 | IDD 回归 | 既有 18 组/136 断言仍绿 + 新增全绿；语义变更逐条列出 | P0 |
| REG2 | 平台回归 | 既有 219/219 + 新增全绿；typecheck/lint（改动文件）0 错 | P0 |
| REG3 | 跨功能 | tool-verify 13/13 仍绿；无跨线泄漏 | P0 |
| REG4 | 性能 | 100×8×3 ≤60s；1000×10×3 ≤120s；100×20 仅主效应 ≤60s；8 active 窗口 ≤60s；内存 <2GB；p50/p95；固定 runner | P1 |
| REG5 | 文档 | SKILL/method_notes/agent-protocol/API/prompts/README 与代码一致；无未证实数字 | P1 |
| REG6 | 可复现证据 | 双仓库 SHA、工作树状态、Node/Python/uv 版本、硬件、完整命令、输出摘要、工件 hash | P0 |

---

## 10. 里程碑与工期（按专家意见重估）

| 里程碑 | 内容 | 依赖 | 工期 | 退出标准 |
|---|---|---|---|---|
| **M0 契约冻结** | 4.1-4.4 schema、run_table/context/adapter/artifact、验收 traceability、双仓库 SHA | 无 | 1 周 | DC1-DC8 契约评审通过 |
| **M0.5 本体前置** | builder `profile=doe` + design_only；store profile/context_fp；brief；lookup | M0 | 1-1.5 周 | ONT1/ONT2/ONT4/ONT8/ONT9/ONT13/ONT14 |
| **M1 统计正确性** | 区间语义、联合窗口、约束、单位、多响应、设计域、向后兼容 | M0 | 2 周 | IDD1-IDD10 |
| **M2 本体/设计扩展** | consistency、feedback、design_build、next_design、association screen | M0.5/M1 | 2 周 | ONT3/ONT5/ONT6/ONT7/ONT10/ONT11/IDD11/IDD12/LOOP1 |
| **M3 平台数据/回流** | DB、export、adapter、tools、artifact、ledger | M0/M1 | 2 周 | DC1-DC8、PLAT1-PLAT5、PLAT8 |
| **M4 执行/UI/handoff** | doe_run_start/capture/stop、HITL、权限、API/UI、to_optimization | M3 | 2 周 | PLAT6/PLAT7/PLAT9、LOOP2/LOOP3/LOOP5/LOOP6 |
| **M5 E2E/验收** | 3 轮 E2E、失败注入、并发/恢复、性能、文档 | 全部 | 1-1.5 周 | LOOP4/LOOP7、REG1-REG6 |

- 全量：**9-12 周**（可并行压缩到 8-10 周）。
- IDD-only MVP：**4-5 周**（M0 + M0.5 + M1 最小 + M2 的 adapter/next_design；平台用手工 run_table + `diag_run`）。
- 不再采用 v1 的 19-31 天估算；隐藏工作包括迁移、备份、UI、模拟器、权限注册、artifact 存储/GC、E2E root timeout。
- E2E 预算：每轮 root timeout 显式配置；3 轮拆分/可注入时钟，避免真实等待。

### 10.1 并行与依赖

```
M0 ─┬─ M0.5 ─┬─ M1 ─┬─ M2
    │        │      │
    └─ M3 ───┴──────┘
             M4 ─── M5
```

- M0.5 与 M1 可并行（本体契约 vs 统计改造）。
- M2 依赖 M0.5（store/profile/brief）与 M1（模型/窗口）。
- M3 依赖 M0（artifact/context schema），可与 M0.5/M1 并行。
- M4 依赖 M3（DB/工具）与 M2（next_design）。
- M5 依赖全部。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 本体构建在 design-only/少量行上质量差 | 语义错/置信低 | DOE profile + 工艺描述/RAG + prior；低置信标 INFERRED；不编造；HITL clarification |
| ontology full build 太慢 | 阻断分析 | auto：reuse ≤60s；full 异步/可关闭（仅 debug）；报告披露 |
| 每 run HITL 太重 | 试验不可执行 | 批次审批绑定 design_hash；每 run 校验 approval_id；硬约束优先；不绕过 recipe 面 |
| 平台执行改变生产 | 工艺风险 | 模拟产线 E2E 先行；manual 绑定 + 硬限 + 回退；DOE 不绕过 HITL |
| 窗口算法规模爆炸 | 性能不达标 | top_k + 连续优化/profile；max_grid_factors；性能分档 |
| 统计合同过度承诺 | 下游误用 | PI/CI/容差语义显式；证据等级与合同状态分离；tamper/G8 门禁 |
| 新字段破坏 136 测试 | 回归失败 | 加法式 v1.1；质量门白名单同步；逐条断言保留 |
| 执行/权限漏洞 | 跨线读写 | DOE 写族 + 链式归属 + tool-verify + grant-guard；解析不到 fail closed |
| Artifact 回流丢失 | 结论不可用 | manifest + outbox + 幂等 + 重试 + 部分失败显式 |
| 工期低估 | 交付延期 | 9-12 周重估；M0 冻结；按工作包验收；IDD-only MVP 先落地 |
| 双副本 diag-bridge | 作用域切换失败 | 单一权威源（builtin）；project 副本一行 re-export 或删除；scope-switch 启动测试 |

---

## 12. Definition of Done

1. **P0 全绿**：DC1-DC3/DC5-DC8、IDD1-IDD10、ONT1/ONT2/ONT4/ONT5/ONT7-ONT11/ONT13/ONT14、PLAT1-PLAT4/PLAT7-PLAT9、LOOP1-LOOP6、REG1-REG3/REG6。
2. **P1 全绿或明确延期**：DC4、IDD11/IDD12、ONT3/ONT6、PLAT5/PLAT6、LOOP7、REG4/REG5；延期项必须在验收报告中列明。
3. **端到端**：3 轮 DOE（含 ontology reuse、multi-response、失败注入、权限拒绝）；目标达成或明确未收敛 reason code。
4. **可追溯**：每个数字来自脚本；`authored_by`/provenance/quality gate/artifact hash 完整；无手改。
5. **零回归**：IDD 既有 136 断言 + 平台 219/219 + tool-verify 13/13 仍绿。
6. **文档一致**：IDD SKILL/method_notes/agent-protocol + 平台 README/docs/prompts/API 与代码一致；无未证实承诺。

---

## 13. 专家意见落实表

| 评审问题 | v2 位置 | 状态 |
|---|---|---|
| C1 design-only/prior-only | §3.2、ONT13 | 已落实 |
| C2 Agent brief | §3.3、ONT14 | 已落实 |
| C3 DOE intent 绕过本体 | §3.4/§6.4、PLAT2 | 已落实 |
| C4 context 翻译/文件选择 | §4.3、DC7 | 已落实 |
| C5 PI/CI/联合窗口/4-active | §5.1-5.5、IDD4/7/12 | 已落实 |
| C6 执行/权限/回流 | §6.2-6.5、PLAT7/8、LOOP3/5 | 已落实 |
| 统计验收过严/过松 | §9.2（IDD2/5/6/7 重写） | 已落实 |
| 多响应冲突跨单位 | §5.2/5.6、IDD4 | 已落实 |
| 纯误差/重复定义 | §4.1、IDD3 | 已落实 |
| 随机化/小 n/split-plot | §5.3、IDD9 | 已落实（split-plot 本期显式拒绝） |
| next_design 方法细节 | §5.8、LOOP1 | 已落实 |
| 初始设计无 owner | §5.9、DC8 | 已落实（IDD design_build 单一来源） |
| 前瞻功效/MDE | §5.9、DC8 | 已落实 |
| 证据等级与合同状态混淆 | §5.10 | 已落实（contract_status/consistency_status） |
| 本体 store 无 profile/context_fp | §3.1、ONT10 | 已落实 |
| 双副本 diag-bridge | §6.4/§7.2、风险表 | 已落实（单一权威源） |
| 工期低估 | §10 | 已落实（9-12 周 / MVP 4-5 周） |
| 验收不可复现 | §8.3/§8.4、REG6 | 已落实 |
| 批量审批/HITL | §6.3、LOOP5 | 已落实（design_hash 绑定） |
| artifact 幂等/重试 | §6.5、PLAT8 | 已落实 |
| ontology off / 生产禁 off | §3.4、ONT14 | 已落实（生产禁 off） |
---

## 14. 第一批提交建议（v2）

### IDD

1. `feat(ontology): DOE profile + design_only + ontology_brief`（M0.5）
2. `feat(store): profile/context_fp/version pin`（M0.5）
3. `feat(doe): interval semantics + joint window + constraints + units`（M1）
4. `feat(doe): design domain/leverage + multi-response + backward compat`（M1）
5. `feat(doe): association screen + ontology consistency + feedback`（M2）
6. `feat(doe): design_build + next_design`（M2）
7. `feat(orchestrator): DOE ontology-first intent`（M2）
8. `test(doe): fixtures F13-F22 + traceability`（M5）

### AgentWorkShop

1. `fix(diag-bridge): DOE intent default question + ontology params`（M3）
2. `feat(doe): schema/repo/adapter/export`（M3）
3. `feat(doe): tools + artifact ingestion + ledger`（M3）
4. `feat(doe): atomic run start/capture/stop + HITL + permissions`（M4）
5. `feat(doe): API + /doe UI`（M4）
6. `feat(doe): to_optimization handoff + campaign lineage`（M4）
7. `test(doe): unit + 3-round E2E + negative tests`（M5）

---

## 15. 结论

- v2 已把“本体优先、Agent 理解、再分析、指导优化”写成**硬门 + 可执行契约 + 验收项**，不再是可选描述。
- 四席专家的 6 个 Critical 均已落实到具体章节与验收 ID。
- 计划可以进入 M0 契约冻结；M0 通过后再开工 M0.5/M1。
- 本计划不改代码；所有改动在后续开发分支执行，开工前记录双仓库 SHA 与工作树状态。

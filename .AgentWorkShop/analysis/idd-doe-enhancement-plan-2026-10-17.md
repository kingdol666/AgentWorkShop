# IDD DOE 分析增强开发计划

> **已被 v2 取代（2026-10-17）**：四席专家评审为 **ACCEPT WITH CHANGES**，6 个 Critical 已在 v2 修订。
> 请使用 `idd-doe-enhancement-plan-v2-2026-10-17.md`；评审报告见 `idd-doe-plan-expert-review-2026-10-17.md`。
> 本文保留为 v1 历史记录，不再作为开工依据。

- 状态：`proposed`（未开工）
- 日期：2026-10-17
- 目标仓库：
  - IDD：`D:\codes\myskills\industrial-deep-diagnostic`
  - 平台：`D:\codes\ABO\AgentWorkShop`
- 配套评估：`idd-doe-assessment-2026-10-17.md`
- 目标：让 DOE 参数优化实验在 IDD 中得到**可信、可执行、结合本体**的分析，并让 AgentWorkShop 能把“试验设计 → 执行 → 响应采集 → IDD 分析 → 下一轮设计”跑成闭环。

---

## 0. 目标与非目标

### 0.1 目标

1. **数据契约**：平台能产出一张“每行一个试验点/重复”的 run-level 表 + `doe_context.json`，IDD 能直接消费。
2. **统计可信**：DOE 合同里的预测区间、置信区间、单位、约束、确认布点、多响应、全因子域都可用，不再“只有方向没有边界”。
3. **本体结合**：DOE 场景能复用/增量构建本体；因子/响应自动映射到 ontology signals；用 `relationships` 校验效应方向，用 `confounders/parameter_groups` 指导 blocks/covariates，用 `normal_range/target` 回填约束/规格。
4. **全参数关系**：designed 效应（因果级）与 association screen（相关级）分层输出，覆盖所有参数与目标；不把观测相关包装成因果。
5. **下一轮设计**：对别名/线性不足/非随机化/外推场景生成可执行的 fold-over / augment / space-filling / confirmation 布点。
6. **平台闭环**：DOE 实体、设计矩阵、执行、响应采集、结果回流、台账、UI、审计、权限全部打通。
7. **可验收**：每个能力都有确定性测试与端到端场景，数值可追溯到工件。

### 0.2 非目标

- 不做硬实时控制；所有平台写入仍走 recipe 面 + HITL + 限界。
- 不自动执行试验；试验执行由平台/人工完成，IDD 只产分析与布点建议。
- 不把观测相关升级为因果；不伪造本体关系。
- 不在本期实现 split-plot/混料/GLM/Box-Cox/VIF/Lenth（列为 P2，先加负向触发与明确拒绝）。
- 不替换现有诊断管线；DOE 是独立意图，只共享 ontology store 与统计底座。
- 不重构 AgentWorkShop 的权限模型；DOE 写入复用现有 recipe/HITL 治理链。

---

## 1. 总体架构

```
┌──────────────────────────── AgentWorkShop ────────────────────────────┐
│ DOE Experiment (factors / responses / design / runs / measurements)   │
│   ├─ design: full / fractional / CCD / BBD / LHS / imported matrix     │
│   ├─ execution: recipe version → line_start(LineRun) → DAQ tagged      │
│   └─ capture: daq_query(run_id) → steady-state aggregate → measurements│
│                              │                                         │
│                    doe_export│                                        │
│                              ▼                                         │
│         run_table.csv (one row per replicate) + doe_context.json       │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ diag_run(analysis_intent=doe-analysis,
                               │          doe_context_id, ontology_mode)
                               ▼
┌────────────────────────────── IDD ─────────────────────────────────────┐
│ DOE intent orchestrator                                                │
│  1) ontology stage: reuse / extend / full (DOE profile)                │
│  2) DOE analyzer: designed + association screen + observational        │
│  3) ontology consistency: expected sign / confounders / mechanism      │
│  4) artifacts: doe_conclusion / recommendations / effect_table /       │
│                model / association_screen / coverage / next_design     │
│  5) report.md + report.html                                            │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ external API / files
                               ▼
┌──────────────────────────── AgentWorkShop ────────────────────────────┐
│ artifact ingestion → DOE result tables + analysis_reports link         │
│ tools: doe_result / doe_next_design / doe_ingest                       │
│ UI: /doe (design matrix, effect table, windows, confirmations)         │
│ next round: optimizer-loop / doe_next_design → recipe + HITL → ...     │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.1 设计原则

1. **契约先行**：先定 `doe_context.json` / `run_table.csv` / artifacts schema，再写实现。
2. **统计与解释分离**：所有数字由 Python 脚本算；Agent 只解释；质量门阻断坏输出。
3. **三级优先级**：用户显式 > 本体 > 自动推断；每字段记录 `assigned_by`。
4. **因果与相关分层**：designed 效应是因果级；association screen 是相关级且 `causal_claim: none`。
5. **可执行合同**：确认/下一轮布点必须给因子设置与 runs，不是只有文字。
6. **平台不放权**：DOE 写参数走 recipe + HITL；安全限/硬约束优先。

---

## 2. 数据契约

### 2.1 平台 DOE 实体

最小 schema（JSON 列为宜，减少迁移面）：

```
doe_experiments
  id (doe-<uuid8>), line_id, product_id, recipe_id, title, objective,
  design_type, status (draft|designing|ready|running|analyzing|done|archived),
  factors_json, responses_json, design_json, constraints_json,
  ontology_scene, ontology_mode (auto|reuse|extend|full|off),
  created_by, created_at, updated_at

doe_runs
  id (doerun-<uuid8>), experiment_id, run_order, replicate_no, block,
  factor_values_json, status (planned|running|done|failed|excluded),
  recipe_version, line_run_id, started_at, ended_at, exclusion_reason,
  created_at, updated_at

doe_measurements
  id, run_id, response, value, unit, ts, quality, source (daq|mes|manual),
  raw_window_json, created_at
```

约束：

- `experiment_id` 外键级联删除；`line_id/recipe_id` 参与产线权限过滤。
- `doe_runs.factor_values_json` 必须覆盖所有因子，不允许缺省。
- 每个 `run_id` 最多一条 `done` 测量/响应；重复用 `replicate_no` 区分。
- 所有写操作 `recordOps` 审计；跨线不可见。

### 2.2 `run_table.csv`

一行 = 一个试验点的一个重复（给 DOE 分析器提供纯误差）：

```
run_id,run_order,replicate,block,<factor_1>,<factor_2>,...,<response_1>,<response_2>,...
doerun-a1,1,1,1,185,12.5,...,50.2,...
doerun-a1,2,2,1,185,12.5,...,49.8,...
```

规则：

- 列名与 `doe_context.factors[].column` / `responses[].column` 完全一致（ASCII 优先；中文列名允许但需在 context 中逐字一致）。
- `run_id` 唯一标识一次执行；同一条件重复执行时 `run_id` 不同、`replicate` 不同。
- `run_order` 为随机化顺序；`block` 可空。
- 未完成/失败/排除的 run 不进入主表；另写 `run_exclusions.csv`（run_id/reason）。
- 响应列可为空（缺失值），由分析器按缺失处理并披露；不允许用 0 填充。

### 2.3 `doe_context.json`

```json
{
  "contract_version": "1.0",
  "experiment_id": "doe-1a2b3c4d",
  "line_id": "ln-...",
  "product_id": "prod-...",
  "recipe_id": "rcp-...",
  "objective": "在膜厚 50±2 μm 下最大化产率",
  "design_type": "ccd",
  "factors": [
    {
      "name": "zone1_temp",
      "column": "zone1_temp",
      "type": "numeric",
      "unit": "°C",
      "min": 180,
      "max": 220,
      "levels": null,
      "role": "control",
      "ontology_signal": "Zone 1 temperature(T:°C)",
      "expected_sign": "+",
      "physical_meaning": "一区加热设定，影响拉伸段温度与膜厚"
    }
  ],
  "responses": [
    {
      "name": "thickness",
      "column": "thickness",
      "unit": "um",
      "goal": "target",
      "lsl": 48,
      "usl": 52,
      "target": 50,
      "weight": 1,
      "ontology_signal": "Film thickness(um)"
    }
  ],
  "blocks": ["batch"],
  "covariates": ["ambient_temp"],
  "constraints": [
    { "factor": "zone1_temp", "min": 185, "max": 215, "hard": true, "reason": "安全限" }
  ],
  "run_order_col": "run_order",
  "group_col": "run_id",
  "time_col": null,
  "replicates_col": "replicate",
  "ontology": {
    "mode": "auto",
    "scene_key": "castfilm-lineA-productP",
    "source": null,
    "build_if_missing": true
  },
  "provenance": {
    "platform": "AgentWorkShop",
    "created_by": "agent-...",
    "created_at": "2026-10-17T..."
  }
}
```

规则：

- `factors[].column` 必须是 `run_table.csv` 的表头；不允许只写 name。
- `responses[].column` 同理；`goal` 为空时默认 `maximize`？不，必须显式或由本体推断；推断要标 `assigned_by:auto`。
- `constraints[].hard=true` 必须进入可行域；软约束只做警告。
- `ontology.mode=auto`：有 scene 资产且 schema 匹配 → reuse；同 scene 有新列 → extend；无 → full；`off` 显式关闭。

### 2.4 IDD 产物契约

| 文件 | 用途 | 是否新增 |
|---|---|---|
| `01_ontology/ontology.json` | 本体（DOE 场景） | 复用现有 schema |
| `01_ontology/ontology_coverage.json` | 列→signal 映射覆盖与未匹配原因 | 新增 |
| `01_profile/data_profile.json` | 设计识别/质量/角色 | 扩展现有 |
| `02_analysis/effect_table.json` | designed 效应/ANOVA/η²/q/Pareto/MDE | 现有 |
| `02_analysis/model.json` | 编码模型/R²/Q²/LOF | 现有 |
| `02_analysis/association_screen.json` | 非因子参数 vs 响应的相关级扫描 | **新增** |
| `02_analysis/correlation_report.json` | observational 相关 | 现有（可合并） |
| `02_analysis/stability_report.json` | 能力/稳态/漂移 | 现有 |
| `conclusions/doe_conclusion.json` | 主结论/证据等级/限制/本体一致性 | 扩展 |
| `conclusions/recommendations.json` | 操作窗/单位/CI/约束/确认 | 扩展 |
| `conclusions/next_design.json` | 下一轮布点（fold-over/augment/space-filling/confirm） | **新增** |
| `report.md` / `report.html` | 人读报告 | 扩展 |

`doe_conclusion.json` 新增字段：

```
ontology_refs: { scene_key, version, path, coverage: 0..1 }
ontology_consistency: {
  checked: n, matched: n, contradictions: [{factor,response,expected,observed,relationship_ref,severity}]
}
analysis_layers: { designed: true, association_screen: true, observational: false }
```

`recommendations.json` 新增/修正：

```
operating_windows[].factor_unit        # 必填（有 unit 时）
operating_windows[].expected_effect.ci95  # designed 也必须有
operating_windows[].ontology_basis     # [{relationship, mechanism, expected_sign}]
operating_windows[].constraint_status  # within|adjusted|rejected
confirmations[].runs[]                 # [{factor settings, replicate, reason}]
next_design_ref                        # conclusions/next_design.json
association_screen_ref                 # 02_analysis/association_screen.json
```

`next_design.json`：

```
{ contract_version, experiment_id, method (fold_over|augment|space_filling|confirm_replicates|d_optimal),
  rationale, runs: [{ run_order, replicate, block, setpoints: {factor: value}, expected_response?, uncertainty?, reason }],
  design_bounds, constraints, provenance }
```

---

## 3. 工作流 A：IDD 统计合同硬化（P0）

### A1. 预测区间 / 置信区间

- 文件：`.claude/skills/industrial-doe-analyzer/scripts/doestats/effects_anova.py`
- 改：`se_predict_raw` 改为 `sqrt(mse * (1 + x0 @ xtx_inv @ x0))`；保留均值 CI 作为 `se_mean_raw`。
- 改：`windows.py` W1 用预测界；`expected_effect.ci95` 由脚本填入（不是 null）。
- 改：`method_notes.md` 口径与代码一致；若保留均值 CI 降级，必须显式标注 `interval_type: mean_ci`。
- 验收：IDD7。

### A2. 单位链

- 文件：`doestats/effects_anova.py`、`doestats/windows.py`、`schemas/analysis_context.schema.json`
- 改：`analysis_context.factors[].unit`、`responses[].unit` 进入 `factor_info`；`build_factor_info` 复制 unit；窗口写 `factor_unit`；response specs 写 unit。
- 改：ontology adapter 可覆盖 unit（见 B2）。
- 验收：IDD6。

### A3. 约束执行

- 文件：`doestats/windows.py`、`doestats/rsm.py`、`scripts/analyze.py`
- 改：`constraints` 进入网格生成、`refine_optimum` bounds、窗口投影；hard 约束必须 0 违例；soft 约束只降权/警告。
- 改：`recommendations.constraints` 记录 `applied: true/false` 与原因。
- 验收：IDD5。

### A4. 确认对象可执行

- 文件：`doestats/windows.py`、`schemas/recommendations.schema.json`
- 改：`confirmations[]` 从 `{id, reason, design_hint, runs}` 扩展为 `{id, reason, method, runs[], factor_settings, constraints}`。
- 改：aliased fractional → fold-over；linear-only → augment（active factors + center points）；NON_RANDOMIZED → confirmation_needed=true + 追加确认 runs；extrapolation → confirmation_needed=true。
- 验收：IDD8。

### A5. 多响应与 4-active 封顶

- 文件：`doestats/windows.py`
- 改：每个 response 独立产出窗口或明确 `no_window_reason`；`active` 因子数改为配置（默认全部显著因子，输出可折叠 `top_k`）；不再“每因子只归因一个响应”。
- 改：`applicability_domain.factor_observed_ranges` 覆盖所有因子（不只窗口因子）。
- 验收：IDD3/IDD4。

### A6. 全参数关系扫描

- 新文件：`doestats/association_screen.py`
- 输入：`run_table.csv` + `analysis_context`；输出：`02_analysis/association_screen.json`
- 内容：所有非因子数值列 × 所有响应：r、p、q（BH）、CI、n、lag、去趋势、Simpson、LOO、`role`（held_constant/covariate/unmodeled）、`causal_claim: none`、`verdict`。
- 规则：不进入操作窗；不改变 designed 结论；报告单独章节“相关级线索（不可当因果）”。
- 验收：IDD3 + 新增测试 F15。

### A7. 证据等级/质量门

- 文件：`scripts/conclusion_template.py`、`scripts/quality_gate.mjs`
- 改：grade checklist 增加 `units_ok`、`constraints_ok`、`ci_ok`、`ontology_consistency_ok`（仅当 ontology 开启）；任何 fail 必须进 `limitations`。
- 改：G6 增加 next_design/association_screen schema；G7 报告必须引用这些工件。
- 验收：IDD9/IDD10。

### A8. 方法与文档

- 文件：`SKILL.md`、`references/method_notes.md`、`references/agent-protocol.md`
- 改：新增输入/输出、ontology 模式、association screen、next design、验收命令。
- 验收：REG5。

---

## 4. 工作流 B：本体 ↔ DOE（P0/P1）

### B1. DOE ontology profile

- 文件：`.claude/skills/industrial-ontology-builder/SKILL.md`、`references/agent-protocol.md`
- 改：增加 `analysis_type=doe`（或 `ONTOLOGY_PROFILE=doe`）：
  - 输入：`doe_context.json` + `run_table.csv` + 过程描述/RAG。
  - 初始 signals：`factors[].role=control`、`responses[].role=quality_target`；不要把因子误判为 target。
  - `normal_range` 取 factor min/max；response specs 取 lsl/usl/target。
  - `relationships` 从 RAG/物理原则/工艺知识抽取，含 `direction/expected_sign/mechanism/governing_equation`。
  - `confounders` 从工艺上下文/数据设计（batch/ambient/operator）抽取。
  - 不强制时间序列 behavior 字段；缺失写 `NOT_APPLICABLE` 并说明。
- 改：`ontology_store.mjs` 指纹支持 `.xlsx/.parquet/.json` 表头（或平台统一导出 CSV，优先后者）。
- 验收：ONT1/ONT2/ONT3。

### B2. ontology adapter

- 新文件：`scripts/doestats/ontology_adapter.py`
- 功能：
  1. 读 `01_ontology/ontology.json` + `schema.json`；按 `column` 精确匹配，再按 name/unit 模糊匹配。
  2. 生成/合并 `analysis_context`：factors/responses 的 unit、role、physical_meaning、expected_sign、normal_range、specs、confounders、blocks/covariates。
  3. 优先级：用户显式 > ontology > auto；每字段写 `assigned_by`。
  4. 输出 `01_ontology/ontology_coverage.json`：每列 `matched|inferred|unmatched` + reason；未匹配不得静默。
- 改：`analyze.py` 在 auto-infer 前调用 adapter；写 `00_input/analysis_context.merged.json`。
- 验收：ONT4/ONT5/ONT6。

### B3. DOE 意图接入本体

- 文件：`app/backend/src/services/diagnosis.service.mjs`
  - 把 `isDefaultIntent ? ... : null` 改为白名单：`deep-diagnosis` + `doe-analysis` 允许 ontology；其他意图保持 null。
- 文件：`app/backend/src/engine/claude-client.mjs`
  - `buildIntentDirective('doe-analysis')` 增加：先执行 ontology stage（reuse/extend/full），再跑 DOE skill；注入 `ONTOLOGY_DIRECTIVE`。
- 文件：`app/backend/src/engine/codex-client.mjs`、`opencode-client.mjs`
  - 补 `analysisIntent` 解构与 `buildIntentDirective`（P1，但建议同批做，避免静默错派）。
- 验收：ONT1/ONT2 + PLAT2。

### B4. 本体一致性校验

- 文件：`doestats/ontology_consistency.py`（新）或 `analyze.py` 内函数。
- 规则：
  - `relationships` 的 expected sign 与 estimated effect sign 比较；不一致写 `ONTOLOGY_CONTRADICTION`（severity: info/warn/block）。
  - `confounders` 建议的 block/covariate 与用户 context 比较；缺失时写建议。
  - `governing_equation` 只作解释，不参与数值拟合。
- 输出：`doe_conclusion.ontology_consistency` + `limitations` + report 章节。
- 验收：ONT5/ONT6/ONT7。

### B5. 报告呈现

- 文件：`templates/analysis_report_template.md`、`doestats/report_html.py`
- 新增章节：
  - “本体依据”：scene/version、关键关系、预期方向。
  - “一致性”：哪些效应符合本体、哪些矛盾、哪些无法判定。
  - “混杂/区组”：confounders → blocks/covariates。
- 验收：ONT7。

---

## 5. 工作流 C：平台 DOE 一等公民（P1）

### C1. 数据层

- 文件：`server/services/workshop/db/database/schema.ts`、`schema.sql`、迁移
- 新增：`doe_experiments` / `doe_runs` / `doe_measurements`；索引 `(line_id, created_at)`、`(experiment_id, run_order)`。
- 新文件：`server/services/workshop/doe/doe.repo.ts`（工厂 + 预编译语句 + 权限过滤）。
- 接线：`server/plugins/workshop.ts` 配置 repo。

### C2. 设计与导出

- 新文件：`server/services/workshop/doe/doe-design.ts`
  - 支持 full/fractional/CCD/BBD/LHS/imported matrix；随机化 run_order；重复/中心点；硬约束校验。
  - 统计设计生成建议委托 IDD（见 D1）；平台至少支持导入/存储/校验，避免自研统计错误。
- 新文件：`server/services/workshop/doe/doe-export.ts`
  - 生成 `run_table.csv` + `doe_context.json` + `run_exclusions.csv`；写入 `data/doe-exports/<id>/`；可上传 IDD。
- 验收：DC1-DC4。

### C3. 工具面

- 新文件：`server/services/workshop/agents/industrial/doe-tools.ts`
  - `doe_create`：创建实验（因子/响应/设计/本体场景）。
  - `doe_design`：生成/导入设计矩阵。
  - `doe_export`：导出 run table + context。
  - `doe_analyze`：调 `diag_run(analysis_intent=doe-analysis, doe_context_id, ontology_mode)`。
  - `doe_result`：取结构化结果（见 C5）。
  - `doe_next_design`：取下一轮布点。
  - `doe_ingest`：录入/聚合测量。
- 注册：`agents/host-tool-bridge/tools/industrial.ts`、`.AgentWorkShop/prompts/host-tools.json`、observational 白名单（按需）。
- 权限：创建/分析需产线 `operate` 或绑定；执行写走 recipe/HITL。
- 验收：PLAT1/PLAT7。

### C4. diag-bridge 改造

- 文件：`server/plugins-builtin/diag-bridge/host/plugin.mjs`
  - 新增 `doe_context_id` / `doe_context` 参数；把 context 一起上传/传递。
  - **修复 P0**：默认问题改为 `defaultQuestionFor(intent)`；只有当意图未知/无模板时才用通用文案；DOE 模板必须可达。
  - 完成回执带 `doe_experiment_id`/`diag_run_id`。
  - **两份同步**：`.AgentWorkShop/plugins/diag-bridge/host/plugin.mjs`（project 副本）做同样修改。
- 文件：`exports.mjs`
  - 支持 `doe_context.json` + `run_table.csv` 上传（与现有 manifest/节点 CSV 并存）。
- 文件：`sweep.mjs` / `plugin.mjs`
  - 完成后拉取 `doe_conclusion.json`/`recommendations.json`/`effect_table.json`（见 C5），写入平台。
- 验收：PLAT2/PLAT3。

### C5. 结果回流

- IDD 侧：`external.service.mjs` 增加 `artifacts` 对象：
  ```
  artifacts: {
    doe_conclusion: { path, url },
    recommendations: { path, url },
    effect_table: { path, url },
    model: { path, url },
    association_screen: { path, url },
    next_design: { path, url },
    report_html: { path, url }
  }
  ```
- 平台侧：`doe.repo.ts` 存 artifacts JSON；校验 schema；保留 `run_id`/`diag_run_id`。
- `analysis_reports` 增加 `doe_experiment_id`/`diag_run_id`/`artifacts_json`；`analysis_save` 支持这些字段（或由平台内部写入，不暴露给 Agent）。
- `doe_result` 返回摘要 + 工件路径，不把大 JSON 塞进 16k 工具回包。
- 验收：PLAT3/PLAT4/PLAT5。

### C6. UI

- 新页面 `app/pages/doe/index.vue` + `app/components/doe/*`
  - 实验列表/新建（因子、响应、设计、约束、本体场景）。
  - 设计矩阵表（run_order/block/factors/responses/status）。
  - 执行状态（recipe version/LineRun/DAQ 窗口/排除原因）。
  - 结果：效应表、Pareto、主效应/交互图、RSM 等高线、操作窗、确认计划、证据等级、本体一致性。
  - 链接到 `/analysis` 的 DOE 报告。
- `/analysis` 增加 `category=doe` 筛选与 DOE 结果卡片。
- 验收：PLAT6。

### C7. 执行与响应采集

- 新文件：`server/services/workshop/doe/doe-executor.ts`
  - 一个 run = 一个 recipe version + 一次 `line_start`（LineRun）→ DAQ 样本按 `run_id` 打标。
  - 等待稳态（可配置 settle 窗），采集响应窗（最后 N 秒/稳定段），聚合 mean/std/n。
  - 失败/越限/样本不足 → `excluded` + reason，不进入主表。
- 工具：`doe_run_start` / `doe_run_capture` / `doe_run_stop`（或由 `doe_ingest` 统一）。
- HITL：建议“整批设计一次批准 + 每个 run 的写仍走 recipe 面限界”；安全限硬约束优先。
- 验收：LOOP3/LOOP5。

---

## 6. 工作流 D：下一轮设计与闭环（P1/P2）

### D1. IDD `next_design`

- 新文件：`scripts/doestats/design_next.py`
- 方法：
  - aliased fractional → fold-over（生成镜像 runs，保留 block/replicate）。
  - linear-only / 曲率不足 → augment（active factors + center points；D-optimal 可选）。
  - extrapolation / 边界最优 → space-filling（LHS 在可行域内补点）。
  - NON_RANDOMIZED → confirmation replicates（3 次）。
  - 多响应冲突 → 追加权衡点（在窗口交集内）。
- 输出：`conclusions/next_design.json`（见 2.4）；质量门校验 setpoints 在约束内。
- 验收：LOOP1。

### D2. optimizer-loop 衔接

- 文件：`.claude/skills/industrial-optimizer-loop/scripts/optcore/windows_seed.py`
  - 已消费 `recommendations.json`；补充消费 `next_design.json` 作为 R001 种子（可选）。
- 平台：`doe_next_design` 可选择 `engine=analyzer|optimizer`：
  - `analyzer`：一次性确认/增强布点（快）。
  - `optimizer`：多轮 DMTA 战役（目标寻优，需预算/收敛门槛）。
- 验收：LOOP2。

### D3. 平台执行闭环

- 下一轮 `next_design` → 平台创建新 `doe_runs` → `doe_executor` 执行 → `doe_ingest` → 再分析。
- 每轮保留 `parent_experiment_id`/`round_no`；结果谱系可追溯。
- 验收：LOOP4。

---

## 7. 工作流 E：测试与可观测

### E1. 单元/统计测试

- IDD：`tests/run_tests.py` 增加 F13-F22：
  - ontology reuse/extend、coverage、expected sign contradiction、confounder block、PI coverage、constraints、units、multi-response、fold-over、augment。
- 平台：`tests/doe-tools.test.ts`、`tests/doe-export.test.ts`、`tests/doe-api.test.ts`。

### E2. 合成 ground truth

- `tests/fixtures/doe/`：
  - `full_2^4`：已知主效应/交互/噪声。
  - `fractional_resIV`：别名链/fold-over。
  - `ccd_optimum`：已知最优点。
  - `bbd_multi_response`：2 响应/冲突。
  - `observational_confounder`：Simpson/混杂。
  - `doe_with_ontology`：ontology 预期方向。
- 每个 fixture 带 `truth.json`（效应/最优点/期望窗口），测试断言可复算。

### E3. E2E

- 平台隔离实例（AW_MODE=home、AW_HOME 临时目录）。
- 场景：
  1. 创建 2^3 + 3 中心点实验（3 因子/1 响应）。
  2. 用模拟产线/PLC 执行 11 个 run（HITL 批准），DAQ 采样按 run 打标。
  3. `doe_export` → `diag_run(doe-analysis)` → 轮询 → `doe_result`。
  4. 断言：效应方向/显著性/操作窗/证据等级/本体一致性；`analysis_reports` 有链接。
  5. `doe_next_design` → 执行 3 个确认 run → 再分析 → 收敛/推荐。
- 脚本：`tmp-e2e/doe-closedloop-2026...mjs`；报告落 `.AgentWorkShop/analysis/`。

### E4. UI 验收

- `/doe` 页面截图（桌面/窄屏）；设计矩阵、效应表、窗口、确认计划可见；数值与 JSON 一致。
- `/analysis` DOE 过滤/详情。

### E5. 性能

- 100 runs × 20 factors × 3 responses ≤60s；10k 行 observational ≤120s；内存 <2GB。
- 超限时记录 `max_rows`/抽样策略，不静默截断。

### E6. 文档

- IDD：SKILL.md、method_notes、agent-protocol、API 文档。
- 平台：README、docs/plugins、host-tools 描述、`/doe` 页面文档。
- 所有数字/口径与代码一致。

---

## 8. 里程碑与依赖

| 里程碑 | 内容 | 依赖 | 建议工期 | 交付 |
|---|---|---|---|---|
| **M0 契约冻结** | 本计划 2.1-2.4 schema + fixtures + 验收脚本骨架 | 无 | 1-2 天 | schema/`truth.json`/测试清单 |
| **M1 IDD 统计合同** | A1-A8 | M0 | 3-5 天 | DOE v2.0 统计合同 + 测试 |
| **M2 本体↔DOE** | B1-B5 | M1 | 3-5 天 | DOE ontology profile + adapter + 一致性报告 |
| **M3 平台 DOE 实体** | C1-C5（最小工具面） | M0/M1 | 4-6 天 | DOE 表/导出/分析/结果回流 |
| **M4 平台执行+UI** | C6-C7 | M3 | 3-5 天 | `/doe` 页面 + run 执行/采集 |
| **M5 下一轮闭环** | D1-D3 | M2/M4 | 3-5 天 | next_design + optimizer 衔接 + 3 轮 E2E |
| **M6 验收** | E1-E6 | 全部 | 2-3 天 | 验收报告 + 回归全绿 |

### MVP 路径（如果先只做 IDD）

1. **M1**：统计合同（PI/CI/单位/约束/确认/多响应）。
2. **M2**：DOE ontology profile + adapter（reuse/extend）。
3. **D1**：next_design（fold-over/augment/confirm）。
4. 平台暂时继续用 `diag_run(data_path=run_table.csv)`，手工准备 `doe_context.json`；等 M3 再做自动化。

这样即使平台侧暂不改，IDD 也能先把“DOE 分析 + 本体 + 下一轮布点”做扎实。

---

## 9. 验收规范

> 所有阈值均为硬门槛；未达标不得宣称“满足 DOE 分析需求”。P0 = 阻断，P1 = 发布门槛，P2 = 后续。

### 9.1 数据契约（DC）

| ID | 验收条件 | 阈值/证据 | 优先级 |
|---|---|---|---|
| DC1 | 平台创建 DOE 实验（3 因子/2 响应/16 runs），设计矩阵可回读 | 字段 100% round-trip；非法缺因子/重复 run 拒绝 | P0 |
| DC2 | `doe_export` 产出 `run_table.csv`，一行一个重复 | 列名与 context 完全一致；runs 覆盖率 100%；空响应允许但计数 | P0 |
| DC3 | `doe_context.json` schema 校验 | 0 error；units/goals/limits/constraints/ontology 字段齐全 | P0 |
| DC4 | 导出→导入 round-trip | 规范化后 JSON/CSV 逐字节一致（时间戳除外） | P1 |
| DC5 | 非法输入拒绝 | 缺因子/越界/重复 run/响应缺失 → 可行动错误；0 静默通过 | P0 |
| DC6 | `diag_run` 传递 DOE context | IDD task payload 含 context；问题文本为 DOE 模板（无“深度根因诊断”） | P0 |

### 9.2 IDD 统计（IDD）

| ID | 验收条件 | 阈值/证据 | 优先级 |
|---|---|---|---|
| IDD1 | 设计识别 | full/fractional/CCD/BBD/OA/LHS 6/6 正确；别名链/分辨率正确 | P0 |
| IDD2 | 效应恢复 | 合成 2^4：真实主效应/交互 q<0.05；符号 100%；top-3 排序正确；BH 后假阳性 ≤1 | P0 |
| IDD3 | 全因子×响应覆盖 | `coverage` 含每个 factor×response；常数/别名标 `not_estimable` + reason；0 静默丢弃 | P0 |
| IDD4 | 多响应 | 3 响应 → 3 个窗口或明确 `no_window_reason`；联合 desirability；每因子不再只归因一个响应 | P0 |
| IDD5 | 约束 | hard 约束 0 违例（100 组随机约束）；网格/refine/窗口全部遵守 | P0 |
| IDD6 | 单位 | 提供的 factor/response unit 100% 进入窗口/合同；无 null | P0 |
| IDD7 | 预测区间 | 100 个新 run 的 95% PI 覆盖率 93-97%；若降级为均值 CI，报告显式标注且断言按均值 CI | P0 |
| IDD8 | 确认可执行 | aliased → fold-over runs；linear-only → augment runs；NON_RANDOMIZED → confirmation_needed=true；每项含 factor settings | P0 |
| IDD9 | 证据等级/门禁 | A/A-/B 与 rubric 一致；tamper 负例 gate FAIL；G1-G7 全绿 | P0 |
| IDD10 | 确定性 | 同输入两次数值一致（时间戳除外）；无 NaN/Infinity；report.html ≥20KB + hash 可溯 | P0 |

### 9.3 本体（ONT）

| ID | 验收条件 | 阈值/证据 | 优先级 |
|---|---|---|---|
| ONT1 | DOE 本体构建 | 4 因子/2 响应 → 4 control + 2 quality_target；unit/meaning/confidence 齐全；≥3 relationships（含 direction/mechanism）；≥2 confounders；CP-2/CP-3 通过 | P0 |
| ONT2 | reuse | 同 scene/columns → `ontology_hit=reused`；≤60s；无 full rebuild/RAG/web | P0 |
| ONT3 | extend | 新列 → 只增量构建新列；已有 role 不变；coverage 报告列出新列 | P1 |
| ONT4 | 映射覆盖 | factor/response 列 100% `matched` 或 `inferred`+reason；0 `UNKNOWN` | P0 |
| ONT5 | 方向一致性 | 已知关系符号与效应符号一致；合成矛盾 → `ONTOLOGY_CONTRADICTION` 进 limitations + report | P0 |
| ONT6 | 混杂/区组 | confounders 生成 block/covariate 建议；带 block 分析改变估计并在报告披露 | P1 |
| ONT7 | 报告引用 | 每个 key finding 至少 1 条 ontology relationship 引用；无编造引用 | P0 |

### 9.4 平台（PLAT）

| ID | 验收条件 | 阈值/证据 | 优先级 |
|---|---|---|---|
| PLAT1 | DOE 工具面 | `doe_create/design/export/analyze/result/next_design/ingest` 全部注册可调；权限/产线作用域生效 | P0 |
| PLAT2 | 意图修复 | `diag_run(doe-analysis)` 无显式 question 时发送 DOE 模板；断言不含“深度根因诊断” | P0 |
| PLAT3 | artifact 回流 | `doe_conclusion`/`recommendations` 落库；schema 校验；10 个抽查字段与 IDD JSON 完全一致 | P0 |
| PLAT4 | `doe_result` | 返回摘要 + 工件路径；大 JSON 不经过 16k 截断；可分页/按文件读 | P0 |
| PLAT5 | 台账关联 | `analysis_reports` 行含 `doe_experiment_id`/`diag_run_id`；按 experiment 查询命中；报告/结论存在 | P1 |
| PLAT6 | UI | `/doe` 设计矩阵/效应表/窗口/确认计划/等级可见；数值与 JSON 一致；桌面+窄屏截图通过 | P1 |
| PLAT7 | 权限/审计 | 跨线创建/分析拒绝；写操作 HITL；create/analyze/execute/deny 全部入审计 | P0 |

### 9.5 闭环（LOOP）

| ID | 验收条件 | 阈值/证据 | 优先级 |
|---|---|---|---|
| LOOP1 | 下一轮布点 | aliased → fold-over；linear → augment；non-randomized → confirm；所有 setpoints 在 hard 约束内 | P0 |
| LOOP2 | optimizer 衔接 | DOE recommendations 作为先验；design→ingest→state 推进；合成目标在预算内收敛；O-G1..O-G8 通过 | P1 |
| LOOP3 | 平台执行 | 1 run = 1 LineRun；DAQ 样本 100% 带 run_id；响应聚合写 measurements；0 未打标样本 | P0 |
| LOOP4 | 端到端 | 3 轮模拟产线 DOE；目标达成或给出明确未达成原因；所有工件可追溯；无手改数值 | P0 |
| LOOP5 | 安全 | 越界/硬约束写入 100% 拒绝；HITL 必走；审计可查 | P0 |

### 9.6 回归（REG）

| ID | 验收条件 | 阈值/证据 | 优先级 |
|---|---|---|---|
| REG1 | IDD 回归 | 现有 18 组 case / 136 断言全绿（2026-10-17 基线实跑）+ 新增 F13-F22 全绿；所有 gate exit 0 | P0 |
| REG2 | 平台回归 | 单测 219/219 + 新增测试全绿；typecheck/lint（改动文件）0 错 | P0 |
| REG3 | 跨功能回归 | tool-verify E2E 13/13 仍绿；无跨线数据泄漏 | P0 |
| REG4 | 性能 | 100 runs×20 factors×3 responses ≤60s；10k 行 observational ≤120s；内存 <2GB | P1 |
| REG5 | 文档 | SKILL.md/method_notes/API/prompts/README 与代码一致；无未证实的数字/承诺 | P1 |

---

## 10. 测试计划

### 10.1 合成数据（IDD）

| Fixture | 目的 | Ground truth |
|---|---|---|
| `full_2^4` | 主效应/交互/ANOVA | 效应向量、噪声 σ、显著项列表 |
| `fractional_resIV` | 别名链/fold-over | 生成元、别名链、fold-over 点 |
| `ccd_optimum` | RSM/驻点/窗口 | 真实最优点、Dmax |
| `bbd_multi_response` | 多响应/desirability | 各响应最优/冲突 |
| `observational_confounder` | 反伪/Simpson | 真实因果方向/混杂 |
| `doe_ontology_injection` | 本体方向/矛盾 | 预期符号/机理 |

### 10.2 平台 E2E

1. 隔离实例：`AW_MODE=home`、`AW_HOME=<tmp>`、`AW_RATE_LIMIT_OFF=1`。
2. 建线/产品/配方/节点；创建 DOE 实验（3 因子/1 响应/11 runs）。
3. 模拟产线执行：每个 run 通过 recipe + HITL 写参数，`line_start` 建 LineRun，DAQ 采样。
4. `doe_export` → `diag_run(doe-analysis)` → 轮询 → `doe_result`。
5. 断言效应/窗口/本体一致性/台账/UI。
6. `doe_next_design` → 3 个确认 run → 再分析 → 收敛/推荐。
7. 清理实例；报告落 `.AgentWorkShop/analysis/doe-closedloop-<date>.md`。

### 10.3 命令

```bash
# IDD
cd /d/codes/myskills/industrial-deep-diagnostic
uv run --project .claude/shared/scripts python .claude/skills/industrial-doe-analyzer/tests/run_tests.py
node .claude/skills/industrial-doe-analyzer/scripts/quality_gate.mjs <RUN_DIR> --skill-path ... --shared-path ...

# AgentWorkShop
npm run test:unit
npm run typecheck
npx eslint <changed files>
node tmp-e2e/doe-closedloop-2026...mjs
```

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 本体构建在少量 DOE 行上推断质量差 | 语义错/置信低 | 用 DOE profile + RAG/工艺文档 + 用户 context；低置信标 `INFERRED`；不阻断分析 |
| ontology full build 太慢 | 阻断分析 | 默认 `auto`：reuse 命中 ≤60s；full 异步/可关闭；报告披露 |
| 每个 run 都走 HITL 太重 | 试验不可执行 | 设计矩阵一次批准 + 每个 run 的写仍受 recipe 限界；硬约束优先；批量审批审计 |
| 平台执行改变生产 | 工艺风险 | 先在模拟产线 E2E；真实线用 manual 绑定 + 小范围 + 回退；DOE 写不绕过 recipe/HITL |
| 统计合同过度承诺 | 下游误用 | 证据等级/限制/区间类型必须显式；相关级不得进操作窗；tamper test |
| 范围蔓延 | 交付延期 | 非目标明确；P2 方法学（Box-Cox/VIF/split-plot/混料）后置 |
| IDD 工作树有未提交改动 | 合并冲突 | 开工前建分支/提交基线；按文件所有权拆分 |
| 平台无 DOE 实体导致返工 | 数据迁移 | 先冻结 2.1-2.4 契约；用 JSON 列降低迁移面 |

---

## 12. Definition of Done

满足以下全部条件才算“DOE 分析增强完成”：

1. **P0 验收全绿**：DC1-DC6、IDD1-IDD10、ONT1/ONT2/ONT4/ONT5/ONT7、PLAT1-PLAT4/PLAT7、LOOP1/LOOP3/LOOP4/LOOP5、REG1-REG3。
2. **P1 验收全绿**：DC4、ONT3/ONT6、PLAT5/PLAT6、LOOP2、REG4/REG5。
3. **一个真实/模拟端到端场景**：3 轮 DOE，含本体复用、效应分析、操作窗、下一轮布点、平台回流。
4. **工件可追溯**：每个数字来自脚本；`authored_by`/provenance/quality gate 完整；无手改。
5. **文档一致**：IDD SKILL/method_notes/agent-protocol + 平台 README/docs/prompts 与代码一致。
6. **零回归**：IDD 现有测试 + 平台 219/219 + tool-verify E2E 全绿。

---

## 13. 建议的第一批提交（可直接开工）

### IDD（第一批）

1. `fix(doe): prediction interval + designed ci95 + units`（A1/A2）
2. `fix(doe): enforce constraints + executable confirmations`（A3/A4）
3. `feat(doe): association screen + coverage report`（A6）
4. `feat(doe): ontology adapter + DOE ontology profile`（B1/B2）
5. `feat(doe): DOE intent ontology orchestration + consistency`（B3/B4）
6. `feat(doe): next_design fold-over/augment/space-filling`（D1）
7. `test(doe): F13-F22 + ground truth fixtures`（E1/E2）

### AgentWorkShop（第一批）

1. `fix(diag-bridge): DOE intent default question`（C4/P0）
2. `feat(doe): experiment/run/measurement schema + repo`（C1）
3. `feat(doe): run_table + doe_context export`（C2）
4. `feat(doe): doe_create/export/analyze/result tools`（C3）
5. `feat(diag-bridge): ingest DOE artifacts`（C5）
6. `feat(doe): /doe page + analysis link`（C6）
7. `test(doe): unit + E2E`（E1/E3）

---

## 14. 验收签字模板（开发完成后填写）

```
DOE 增强验收
- 版本/commit: IDD <sha> / AgentWorkShop <sha>
- 数据契约: DC1-DC6  __/6
- IDD 统计: IDD1-IDD10 __/10
- 本体: ONT1-ONT7 __/7
- 平台: PLAT1-PLAT7 __/7
- 闭环: LOOP1-LOOP5 __/5
- 回归: REG1-REG5 __/5
- 端到端场景: <run id / 报告路径>
- 结论: PASS / FAIL（未达标项与原因）
```

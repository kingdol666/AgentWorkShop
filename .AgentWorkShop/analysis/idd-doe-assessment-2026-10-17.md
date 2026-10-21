# IDD × AgentWorkShop DOE 能力评估

- 日期：2026-10-17
- 评估对象：AgentWorkShop v0.7.66（HEAD `1e0cf1d`）与 IDD `D:\codes\myskills\industrial-deep-diagnostic`（审计时工作树 HEAD `1ff3d6c`，含未提交改动）
- 范围：IDD 集成链路、IDD 全部 skill、DOE 分析能力、本体建模、平台数据契约、结果回传
- 结论：**IDD 已具备成熟的“DOE 数据分析器”，但“平台 → IDD → 本体 → 平台”的 DOE 闭环尚未成立。**

---

## 0. 结论（TL;DR）

| 问题 | 结论 |
|---|---|
| IDD 能否分析 DOE 数据？ | **能**。`industrial-doe-analyzer` 可识别全因子/部分因子/CCD/BBD/正交表/LHS，输出主效应、交互、ANOVA、RSM、desirability、操作窗口、证据等级与机器可读合同。 |
| 能否得到“所有参数 vs 被优化目标”的关系？ | **效应表层：基本能**（显式声明的 factor × response 全覆盖）。**结论/窗口层：部分能**（只聚焦显著子集、最多 4 个 active 因子、每因子只归因一个响应；auto-infer 最多 3 个响应）。 |
| 能否结合 IDD 本体模型？ | **当前不能**。`doe-analysis` 意图在服务层主动把 ontology 置空；DOE skill 目录内 ontology 引用为 0；没有 ontology → factors/responses/specs/relationships/confounders 的适配器。 |
| 能否指导下一轮实验？ | **部分能**。`recommendations.json` 有操作窗与确认提示，但确认项只有文字；fold-over/augment/D-optimal/space-filling 布点不在 DOE skill，而在另一个 `industrial-optimizer-loop` 意图里。 |
| 当前平台能否端到端跑 DOE？ | **不能算一等公民**。平台送 IDD 的是“每节点时序 CSV + manifest”，不是“每行一个试验点、列含因子水平与响应”的设计矩阵；DOE 意图的默认问题还会被“深度根因诊断”文案覆盖；IDD 的 `doe_conclusion.json`/`recommendations.json` 不回流平台。 |
| 是否需要开发计划？ | **需要**。见配套文档 `idd-doe-enhancement-plan-2026-10-17.md`。 |

一句话：**“IDD 会做 DOE 分析”已经成立；“AgentWorkShop 用它做 DOE 参数优化实验、并结合本体指导实验”还不成立。**

---

## 1. 当前 AgentWorkShop 如何集成 IDD

### 1.1 两条桥

| 桥 | 形态 | 作用 |
|---|---|---|
| **diag-bridge**（builtin，v2.2） | `diag_run` / `diag_status` 两个 OMP 宿主工具 | 上传 DAQ 快照或导出数据集 → 调 IDD `POST /api/diagnosis/tasks` → 轮询 `/tasks/:id` → 回执报告路径 |
| **idd-closedloop-bridge**（project 插件） | 9 个 OMP 工具：`sentinel_*` / `experience_*` / `optimizer_*` | 直接把 IDD 的哨兵、经验库、目标闭环寻优接到平台；`optimizer_campaign` / `optimizer_round` 已具备“因子域 + 布点表 + 测量回收”的闭环合同 |

关键点：**DOE 分析在 diag-bridge，下一轮布点在 idd-closedloop-bridge，两者没有自动衔接。**

**插件设计模式**（回答“插件如何设计”）：

- 目录形态：`index.mjs` 是薄壳（一行 `export { default } from './host/index.mjs'`），真正实现按职责拆到 `host/{plugin,diagnosis,sweep,snapshot,exports,helpers,intents,constants}.mjs`；`client.mjs` 是前端面板；`i18n.json` 是双语文案。
- 插件对象：`plugin.mjs` 的 `export default { name, version, description, auth, client, configGroups, settings, setup(ctx) }`。`configGroups`/`settings` 是声明式配置面；`setup(ctx)` 里注册 OMP 工具、hook、timer、路由，并可用 `ctx.config.defineGroup/defineField` 运行时扩展设置。
- 运行时设施：`ctx.omp.registerTool({name, description, parameters, roles, handler})` 暴露 Agent 工具；`ctx.kv` 存运行中任务与去重状态；`ctx.timer.setInterval` 做 15s 轮询；`ctx.services.get('notify')` 做频道回执；`ctx.daq`/`ctx.http` 做数据与外部调用。
- `idd-closedloop-bridge` 是 project 插件，同构地提供 9 个 OMP 工具（`sentinel_*`/`experience_*`/`optimizer_*`），并直接复用 IDD 的 `/api/optimizer/*` 合同。
- 注意：`diag-bridge` 同时存在 **builtin**（`server/plugins-builtin/diag-bridge`）与 **project**（`.AgentWorkShop/plugins/diag-bridge`）两份代码；本轮 DOE 修复必须两份同步，避免作用域切换后行为不一致。

### 1.2 diag-bridge 的实际数据契约

`diag_run` 参数（`server/plugins-builtin/diag-bridge/host/plugin.mjs:96-122`）：

- 数据来源三选一：`line` + 时间窗、`data_path`、`export_id`
- 分析意图：`deep-diagnosis | stability-report | quick-screen | doe-analysis | experience-mining | optimizer-campaign`
- 其他：`question`、`scene`、`mode(async/sync)`、`harness/model/permission_mode`

上传内容：

- **line 模式**：5 秒桶降采样、最多 10000 点、按节点 pivot 的单 CSV；列只有 `timestamp,<nodeId>...`（`snapshot.mjs:37-83`）。
- **export 模式**：`manifest.json` + 每节点 CSV；CSV 列为 `ts_iso,ts_ms,value,state`（`daq-export.ts:296-309`）；manifest 含 `lines/nodes/window/totals/truncated_nodes`（`daq-export.ts:330-342`）。

**关键缺口**：CSV 没有逐样本 `run_id`、没有因子列、没有响应列；manifest 的 `lines[].runId` 只是“导出时刻的活动批次”，不是逐样本归属（`daq-export.ts:433-451`）。因此 IDD 收到的是**时序数据**，不是**DOE 试验表**。

### 1.3 DOE 意图的提示词被覆盖（P0 实现 bug）

`diag_run` 在调用 `startDiagnosis` 前，只要调用方没给 `question`，就会无条件填一段“深度根因诊断”文案：

- `plugin.mjs:148-159`：export 模式填 `"…产线数据集深度根因诊断(…)"`；其他模式填 `"…该时窗数据深度根因诊断"`。
- `diagnosis.mjs:28` 只有在 `question` 为空时才使用 `defaultQuestionFor(intent)`。
- 结果：`intents.mjs` 里的 DOE 模板（`"识别因子与响应，给出因子效应、显著性判断与最优工况组合建议…"`）在 `diag_run` 路径下**不可达**。`analysis_intent=doe-analysis` 只要不显式传 `question`，IDD 收到的仍是根因诊断问题。

这不是“提示词不够好”，而是**意图语义在入口处被覆盖**。现有六意图 E2E 的断言正则会匹配“根因诊断”，因此没有发现它（`tmp-e2e/intents-six-20261015.mjs:68`）。

### 1.4 结果回传：只回文本与报告路径

- 轮询器只持久化 `score/verdict/summary/reportPath`（`sweep.mjs:35-46`）。
- `diag_status` 只返回格式化文本 + `report_md_path`（`plugin.mjs:220-300`）。
- **没有**调用 IDD 的 artifacts 接口；**没有**读取 `conclusions/doe_conclusion.json` 或 `conclusions/recommendations.json`。
- `analysis_save` 的字段只有 `title/summary/conclusions/report/category/line_id/recipe_id/...`（`analysis-tools.ts:22-35`），没有 `run_id`、`diag_task_id`、DOE 实验 id、结构化效应表或推荐合同。
- README 所说“完成后报告经 analysis_save 落账”在 diag-bridge 代码中**没有实现**；只有“请 Agent 调 kb_agent 入库”的提示（`sweep.mjs:47-66`、`plugin.mjs:289-291`）。

### 1.5 平台侧有没有 DOE 一等公民？

**没有。** 全库 schema 没有 `doe` / `design_matrix` / `factor` / `response` 表（`schema.ts` 中 grep 为 0）。最接近的实体都不满足 DOE 语义：

| 实体 | 有什么 | 为什么不是 DOE |
|---|---|---|
| `dcw` 批次 `RecipeRunView` | `paramsSnapshot`（每批实际参数） | 没有设计矩阵、响应定义、重复/区组/随机化；`recipe_trial`/`applyRecipe` 只写参数，不启动 LineRun，样本不会按 run 打标 |
| `optimization_explorations` | 单步 `control_before/after`、`target_before/after` | 单因子单步，不是多因子设计；无 line/recipe/run 外键 |
| `aml_datasets` | `runIds` + `control/target` 节点 + 张量 `x/u/y.f32` | 每行是滑窗样本，不是“每行一个试验点”；`runProfiles` 只有目标均值，没有因子水平（`dataset-builder.ts:398-414`、`stats.ts:31-36`） |
| `twin_trials` | 虚拟 trial 轨迹 | 不是实测响应；`candidateExecuted=0` |
| `analysis_reports` | 自由格式台账 | 没有因子/水平/响应/设计字段；`metrics` 是任意 JSON，不可按 DOE 字段检索 |

### 1.6 当前链路图

```
Channel / Agent
   │  diag_run(export_id | line+window, analysis_intent)
   ▼
diag-bridge ──上传 manifest + 每节点时序 CSV──▶ IDD /api/diagnosis/tasks
   │                                              │ analysis_intent=doe-analysis
   │                                              ▼
   │                                   industrial-doe-analyzer
   │                                   （不跑 ontology；单表输入）
   │                                              │
   │◀──── /tasks/:id 只回 score/verdict/summary/report_md_path ────┘
   │
   ├─ diag_status：文本摘要 + 报告路径（无 DOE JSON）
   └─ 需要人工/Agent 再调 kb_agent；analysis_save 不自动发生

另：idd-closedloop-bridge（project 插件）
   optimizer_campaign / optimizer_round 已能生成 trial_design 并回收 measurements，
   但它与 diag-bridge 的 DOE 分析没有自动衔接。
```

---

## 2. IDD 项目能力盘点

### 2.1 全部 skill（24 个）

| 组 | Skill | 职责 |
|---|---|---|
| 编排/报告 | `industrial-analysis-auto` | 9 阶段诊断总编排（DOE 是它的负向触发，不跑此管线） |
| 编排/报告 | `industrial-analysis-enhance-auto` | E0-E8 深层增强编排（不是 DOE 实验） |
| 编排/报告 | `industrial-reporter` | 九段式诊断报告（Judge-gated） |
| 编排/报告 | `industrial-html-visualizer` / `industrial-html-reviewer` | 诊断 HTML 生成与独立审阅 |
| 编排/报告 | `industrial-enhanced-html-visualizer` / `industrial-enhanced-html-reviewer` | 增强知识 HTML 生成与审阅 |
| 编排/报告 | `diagnostic-html-visualizer` | 通用诊断结果 HTML 解释页 |
| 编排/报告 | `industrial-judge` | 10 项质量门评分与跨文件校验 |
| 编排/报告 | `industrial-physical-auditor` | 物理真实性审计（报告/寻优产物） |
| 数据/本体 | `industrial-data-preprocessor` | 任意格式/目录 → 单张 `preprocessed_data.csv` |
| 数据/本体 | `industrial-hetero-preprocessor` | 剖面/2D 场/图像流/时序文本 → `HX-*` 标量特征 |
| 数据/本体 | `industrial-data-processor` | 诊断 Step 3 统计与图表（ontology-first） |
| 数据/本体 | `industrial-ontology-builder` | 构建 `ontology.json`/`schema.json`，RAG + web + 数据自描述 |
| 数据/本体 | `industrial-deep-analysis` | 覆盖/派生特征/条件关系/权衡 |
| 数据/本体 | `industrial-physics-bridge` | 统计关系 → 物理机制链 |
| 领域分析 | `industrial-diagnostician` | 竞争假设根因诊断 |
| 领域分析 | **`industrial-doe-analyzer`** | **DOE/工况独立分析器（本文主角）** |
| 领域分析 | `industrial-line-stability-report` | 产线稳定性评分报告（ontology-first，可消费 DOE 窗） |
| 领域分析 | `industrial-sentinel` | 产线哨兵/SPC 快筛/批筛 |
| 领域分析 | `industrial-tuning-memory` | 调参动作归因与经验库 |
| 领域分析 | `industrial-optimizer-loop` | DMTA 闭环寻优状态机（真正生成下一轮布点） |
| 知识/元 | `rag-knowledge-builder` | 任意领域 RAG/本体草稿构建 |
| 知识/元 | `darwin-skill` | skill 质量演化追踪 |

### 2.2 `industrial-doe-analyzer` 的真实能力

**输入**：

- `00_input/<data file>`：CSV/TSV/Excel/Parquet/Feather/JSON 的**单张表**（`analyze.py:63`、`:253-261`）。
- `00_input/analysis_context.json`（可选）：`mode_override/responses/factors/blocks/covariates/index_cols/time_col/group_col/run_order_col/max_lag/alpha/effect_size_threshold/constraints/inference`（`schemas/analysis_context.schema.json`）。
- 不支持目录、多文件合并、`.xlsm`；目录/多格式需先走 `industrial-data-preprocessor`。

**模式**：

- `designed`：全因子、部分因子（生成元恢复 + 别名链）、CCD、BBD、正交表、LHS。
- `observational`：连续漂移工况记录；相关 + 滞后 CCF + 去趋势 + Simpson 分层 + LOO + 能力指数 + 稳态段。

**统计输出**：

- 主效应 + 2FI（全部默认进模型）；RSM 二次项；extra-SS ANOVA；η²/partial η²；BH-FDR；Pareto；MDE。
- RSM 驻点/Hessian 分类；Derringer-Suich desirability；操作窗 W1-W8；冲突消解；证据等级 A/A-/B。
- `doe_conclusion.json`、`recommendations.json`、`effect_table.json`、`model.json`、`report.html`。

**已确认的合同缺口**（代码实测）：

| 缺口 | 证据 |
|---|---|
| W1 用的是**均值置信界**，不是预测区间；`method_notes` 却写 prediction bound | `effects_anova.py:480-508`：`var = x0 @ xtx_inv @ x0 * mse`，没有 `1 +` |
| designed 窗口 `expected_effect.ci95` 恒为 `null` | `windows.py:284-289` |
| `factor_unit` 恒为 `null`（ontology/context 的单位没有进 `build_factor_info`） | `effects_anova.py:50-61`、`windows.py:280` |
| `constraints` 只回显，不参与网格/refine/窗口 | `windows.py:647-649`（全文件唯一消费点） |
| active 因子最多 4 个 | `windows.py:102` |
| fold-over 只有一句文本建议，没有布点 | `design_detect.py:199` |
| 预测区间、Box-Cox、VIF、Lenth PSE、split-plot/混料、前瞻功效/样本量均无代码 | 全目录 grep 无实现 |
| 多响应窗口不完整：每因子只归因一个“最强响应” | 真实样例 `workspace/bopet-skill-eval/S2_doe_mdo_ccd/conclusions/recommendations.json`：`response_specs` 有 3 个响应（拉伸强度/雾度/厚度偏差），但只出 2 个窗口且均归因“拉伸强度”；两个窗口的 `expected_effect.ci95` 均为 `null`、`factor_unit` 均为 `null`、`confirmations` 为空 |

> 补充：IDD 现有 DOE 测试基线 **136/136 全绿**（2026-10-17 实跑，`tests/run_tests.py all`）。这说明统计底座是稳定的；上面的缺口集中在**合同字段与接线**，不是核心数值算错。

### 2.3 `industrial-ontology-builder` 的真实能力

- 输入：`input_manifest.json`、`user_context.json`、`run_config.json`、可选 `extracted_knowledge.json`（`SKILL.md:14-23`）。
- 输出：`01_ontology/ontology.json`（≥1KB、schema-valid）、`01_ontology/schema.json`、`rag_deep_understanding.json`、`clarification_needed.json`。
- 模式：`reuse`（拷贝 store 资产，≤60s）、`extend`（只对新列增量构建）、`full`（完整 RAG+web+数据自描述）。
- 资产存储：`data/ontology_store/<scene>/vN/`，索引 `index.json`；按 CSV 表头 dtype/position 做 `schema_fp`，同 scene 可版本化（`ontology_store.mjs:33-42, 113-178, 382-447`）。
- 本体内容：`signals`（inspection/process/control/events/metadata）、`quality_target_causal_map`、`physical_principles`、`relationships`（causal/correlative/control/physical/feedback，含 mechanism/governing_equation）、`confounders`、`parameter_groups`（`shared/schemas/ontology_schema.json`）。
- 真实样例（100kL 青霉素发酵）：11 个过程参数、11 个控制变量、20 条关系、3 个混杂因子，含 Monod 方程/补料机理/滞后说明。

### 2.4 本体与 DOE 的接线现状

**零接线。** 证据：

- DOE skill 目录 `grep -ri ontology` = **0 命中**。
- `diagnosis.service.mjs:296-310`：`const ontology = isDefaultIntent ? resolveOntologyDirective(...) : null;`
- `diagnosis.service.mjs:913-914`：`ontology: runIntent === 'deep-diagnosis' ? ... : null`
- `claude-client.mjs:133-152` 的 `buildIntentDirective` 明确：非默认意图不跑 9 阶段、不注入 Ontology Directive。

也就是说，**DOE 意图被设计成“绕过诊断管线和本体”的独立分析**。这在“只分析一张表”时是优点（快），但在“结合场景本体指导实验”时就是硬缺口。

唯一的正面先例是 `industrial-line-stability-report`：它能按 `--ontology` / run 内 `01_ontology` / store 顺序找本体，用 `normal_range` 回退规格限、用 `relationships` 做机制校验、用 `confounders` 写局限，同时用 `--doe-run-dir` 读取 DOE 推荐窗（`SKILL.md:75-80`）。**这条“本体 + DOE 合同”的消费模式已经存在，只是不在 DOE 分析器本身。**

### 2.5 IDD 能分析什么数据

| 数据类型 | 支持情况 |
|---|---|
| 单表 CSV/TSV/Excel/Parquet/Feather/JSON | ✅ DOE analyzer 原生 |
| 多格式目录 / 多 sheet / 编码混杂 | ✅ 先走 `industrial-data-preprocessor`（但 DOE 意图不会自动调用） |
| 剖面/向量随时间的检测数据（膜厚断面、光谱） | ✅ 先走 `industrial-hetero-preprocessor` → `HX-*` 标量特征；DOE 只支持 `HX-PROF-*` 作为响应列的说法，没有专用逻辑 |
| 2D 场/图像序列/时序文本 | ✅ 预处理为标量特征；DOE 分析器本身不读图像 |
| 设计试验（全因子/部分因子/CCD/BBD/OA/LHS） | ✅ 原生 |
| 观测工况（连续时序） | ✅ 原生 |
| split-plot/混料/GLM/Box-Cox/VIF/Lenth/样本量功效 | ❌ 未实现 |
| 多文件直接进 DOE | ❌ 只取 `00_input` 下排序第一个数据文件（`analyze.py:253-261`） |
| `.xlsm`/目录直接进 DOE | ❌ 需预处理 |

---

## 3. DOE 能力矩阵

| 能力 | 状态 | 说明 |
|---|---|---|
| 设计类型自动识别 | ✅ | 全因子/部分因子/CCD/BBD/OA/LHS/observational |
| 主效应/交互/高阶项 | ✅ | 2FI 默认全开；RSM 二次项 |
| ANOVA/效应量/BH-FDR/Pareto/MDE | ✅ | extra-SS；Type-II/III 语义有披露 |
| RSM/驻点/Hessian/desirability | ✅ | CCD/BBD |
| 操作窗口/冲突消解/证据等级 | ✅ | W1-W8；A/A-/B |
| 观测模式反伪链 | ✅ | 滞后 CCF/去趋势/Simpson/LOO |
| 多响应 | ⚠️ 部分 | 可联合 desirability；每因子只归因一个响应 |
| 约束 | ❌ | schema 有，只回显，不执行 |
| 单位 | ❌ | `factor_unit` 恒 null；response unit 未入 schema |
| 预测区间 | ❌ | 实为均值 CI，文档误写 prediction bound |
| 确认实验可执行布点 | ❌ | `confirmations[]` 只有 text + runs |
| 下一轮设计（fold-over/augment/D-optimal/space-filling） | ❌ | 在 `industrial-optimizer-loop`，不在 DOE |
| 所有参数-目标关系 | ⚠️ 部分 | effect_table 全覆盖声明因子；结论/窗口只覆盖显著子集 + top-4 |
| 本体语义注入 | ❌ | DOE 意图 ontology 置空；0 引用 |
| 本体→规格限/单位/预期方向/混杂 | ❌ | 无 adapter |
| report.md/report.html | ✅ | HTML 确定性渲染 + G7 门禁 |
| 外部 API 一等 DOE artifact | ⚠️ 部分 | md/html 一等；DOE JSON 只能走通用 files API |
| 平台 DOE 实体/设计矩阵 | ❌ | 无 |
| 平台 run-level 导出 | ❌ | 只有逐节点时序 CSV |
| 平台结果回流/台账/UI | ❌ | 无 DOE 字段/视图 |

---

## 4. 关键缺口（按影响排序）

### P0（不修则 DOE 闭环不成立）

1. **意图入口被覆盖**：`diag_run` 的默认问题把 DOE 模板顶掉（`plugin.mjs:148-159` vs `diagnosis.mjs:28`）。
2. **平台数据契约不是 DOE 表**：时序 CSV 无 run/factor/response；`daq_export` 不暴露 `run_id`（原始 `daq_samples` 有 run 标签，但导出未用之）。
3. **DOE 产物不回流**：只取 `score/verdict/summary/report_md_path`；`doe_conclusion.json`/`recommendations.json` 丢失。
4. **本体绝缘**：DOE 意图 ontology=null；DOE skill 0 引用；无 adapter。
5. **统计合同不可全信**：PI 名不副实、designed CI 为空、约束不执行、单位为空、确认不可执行、4-active 封顶、多响应窗口不完整。

### P1（影响可用性与指导价值）

6. **下一轮设计不在 DOE**：fold-over/augment/D-optimal/space-filling 在 optimizer-loop，且需显式 campaign；DOE 分析完成后不会自动进入下一轮。
7. **单文件限制**：多文件/目录/`.xlsm` 直接进 DOE 会只取第一个文件；平台 export 恰好是多文件。
8. **平台无 DOE 实体/UI**：无设计矩阵、试验点、响应采集、结果页。
9. **analysis_reports 无 DOE 字段**：无 `doe_experiment_id`/`diag_run_id`；`metrics` 不可检索；`analysis_query` 16k 截断。
10. **harness 意图不一致**：`codex`/`opencode` 未接 `analysisIntent`，选了 DOE 仍跑诊断管线。

### P2（方法学与规模化）

11. Box-Cox、VIF、Lenth PSE、split-plot、混料、GLM、样本量/功效。
12. 高通量：无 `max_rows`/`max_pairs`、observational 无 top-K、MI O(n²) 性能。
13. 测试盲区：无 ontology/fold-over/PI/constraints/multi-file/API 回传测试。

---

## 5. 对你四个问题的直接回答

### Q1：当前系统如何集成 IDD 作为数据分析引擎？

- 主通道是 **diag-bridge**：`diag_run` 上传数据 → IDD `/api/diagnosis/tasks` → `diag_status` 查状态 → 报告路径。
- 辅助通道是 **idd-closedloop-bridge**：哨兵/经验库/优化战役，已有 `optimizer_campaign`/`optimizer_round` 的布点与回收合同。
- 集成层次是**“任务 + 报告文件”**，不是“结构化数据合同 + 结构化结果合同”。

### Q2：IDD 这个项目能支持分析什么样的数据？

- 单表：CSV/TSV/Excel/Parquet/Feather/JSON。
- DOE：全因子/部分因子/CCD/BBD/正交表/LHS；数值/类别因子、blocks、covariates、多响应、规格限/目标/权重。
- 工况：连续时序的相关/滞后/去趋势/Simpson/LOO/能力/稳态段。
- 异构：剖面/2D 场/图像序列/时序文本经预处理成标量特征。
- 不支持：split-plot/混料/GLM/Box-Cox/VIF/Lenth/样本量功效；DOE 单文件、目录/多文件需预处理。

### Q3：DOE 参数设置优化实验，是否有专门 skill 得到所有参数与目标关系，并结合本体指导实验？

- **专门 skill：有**，`industrial-doe-analyzer`。
- **所有参数关系：部分**。effect_table 对显式 factor × response 全覆盖；但 conclusions/windows 只聚焦显著子集/top-4；auto-infer 最多 3 响应；没有“设计因子 + 非因子参数”的统一关系扫描。
- **结合本体：没有**。本体资产很丰富，但 DOE 意图主动置空 ontology，DOE skill 0 引用；没有 adapter；没有“预期方向 vs 实测效应”的一致性校验；没有用 confounders/parameter_groups 指导 blocks/covariates。
- **指导实验：部分**。有操作窗/推荐/确认提示；确认项不可执行；下一轮布点在另一个 optimizer-loop，需显式 campaign。

### Q4：如果不满足，开发计划是什么？

见配套文档 **`idd-doe-enhancement-plan-2026-10-17.md`**。计划分五段：

1. **P0 统计合同硬化**（IDD）：PI/CI、单位、约束、确认对象、多响应、全因子域。
2. **P1 本体 ↔ DOE**（IDD）：DOE ontology profile、reuse/extend、adapter、一致性校验、报告引用。
3. **P2 平台 DOE 一等公民**（AgentWorkShop）：DOE 实体、run-level 导出、`doe_context`、artifact 回流、台账/UI。
4. **P3 下一轮设计与闭环**：fold-over/augment/space-filling + optimizer-loop + 平台执行/回收。
5. **P4 端到端验收**：合成 ground truth + 平台 E2E + 真实/模拟产线。

---

## 6. 评估结论

- **IDD 的 DOE 统计内核是可信的**：确定性脚本、schema、质量门、证据等级、真实压力测试都在；P0 正确性（NaN/Inf、minimize CI、per-target ΔR²、Type-II 标注、时间列误判、冲突消解）已修复。
- **但“分析完成”不等于“实验可指导”**：合同里的 PI/CI/单位/约束/确认布点不完整，导致下游只能“参考方向”，不能“按矩阵执行”。
- **本体是 IDD 的差异化资产，但 DOE 完全没用上**：这是最值得优先补的能力，也是“结合场景任务构建本体模型”最直接的落点。
- **平台侧缺的是 DOE 一等公民**：没有试验实体、没有 run-level 表、没有结果回流。只要这层补上，IDD 现有能力就能被真正用起来。

> 本评估只读，不修改 AgentWorkShop 或 IDD 的任何代码。所有结论均给出代码/产物证据；IDD 工作树含未提交改动，行号以审计时工作树为准。

## 7. 后续文档（2026-10-17 专家评审后）

- 四席专家评审报告：`idd-doe-plan-expert-review-2026-10-17.md`（DOE 统计 / 本体知识工程 / 平台架构 / QA 交付；四席一致 ACCEPT WITH CHANGES）
- 修订版开发计划：`idd-doe-enhancement-plan-v2-2026-10-17.md`（把“本体先行 → Agent 理解 → DOE 分析 → 指导优化”写成硬门与可执行契约；6 个 Critical 已落实）
- v1 计划已标记为历史版本，不再作为开工依据。

# IDD DOE 增强计划 · 专家评审报告

- 日期：2026-10-17
- 评审对象：`idd-doe-enhancement-plan-2026-10-17.md`（v1）与配套评估
- 评审方式：四个独立评审席位只读审查（DOE 统计 / 本体知识工程 / 平台架构治理 / QA 交付），逐条对照代码与计划
- 结论：**四席一致 ACCEPT WITH CHANGES**；方向正确，但 v1 不能直接开工，必须先修订 6 个 Critical 项
- 修订结果：`idd-doe-enhancement-plan-v2-2026-10-17.md`

---

## 1. 四席判定

| 席位 | 判定 | 核心结论 |
|---|---|---|
| DOE 统计方法学 | **ACCEPT WITH CHANGES** | 统计改造方向对，但 PI/CI 语义未定义、逐因子窗口被当联合域、取消 4-active 与 9^k 网格冲突、约束/单位/多响应合同不完整、会破坏现有 136 测试 |
| 本体/知识工程 | **ACCEPT WITH CHANGES** | 没有 design-only/prior-only 路径；Agent 没有 ontology brief；store 无 profile/context_fp；严格 schema 与 plan 的 role 命名不兼容；DOE intent 仍可能绕过本体 |
| 平台架构/治理 | **ACCEPT WITH CHANGES** | 数据层相容，但“1 run = 1 LineRun + recipe version”不可直接实现；DOE 工具会绕过 grant-guard/tool-verify；批量审批与现有 HITL 冲突；artifact 回流无幂等/重试；M3-M5 工期严重低估 |
| QA/交付 | **ACCEPT WITH CHANGES** | 40 条验收中约 12 条空泛/矛盾/不可测；测试缺约束绑定、OA/LHS、多响应、失败注入、并发/权限；工期 19-31 天不现实；缺可复现证据 |

---

## 2. 六个阻断项（Critical）与处置

| # | 阻断项 | 评审证据 | v2 处置 |
|---|---|---|---|
| C1 | **没有 design-only/prior-only 本体路径**：builder 要求 `DATA_PATH` 与三件输入；响应未采集时无法“先建本体再分析” | `industrial-ontology-builder/SKILL.md:14-23`、`references/agent-protocol.md:18`、v1 §B1 | v2 §3.2 新增 `profile=doe` + `data_stage=design_only`；物化三件输入；响应行为 `NOT_APPLICABLE`；建本体与跑统计拆成两个阶段 |
| C2 | **Agent 没有 ontology brief**：adapter 只服务 Python，Agent 在统计前仍盲分析 | DOE skill 目录 0 处 ontology；v1 §B2/B5 | v2 §3.3 新增 `ontology_brief.json/.md`；DOE Phase 0 强制读取并写 `analysis_plan.md`；brief 注入 intent prompt 与工具回包 |
| C3 | **DOE intent 仍会绕过本体**：两处 `isDefaultIntent ? ontology : null`；diag_run 无 ontology 参数 | `diagnosis.service.mjs:296-310,913-914`；`plugin.mjs:96-122` | v2 §3.4/§6.4 白名单覆盖创建+执行两处；`diag_run`/API 增加 ontology 参数；DOE 禁止生产 `off`；先 fast-reuse 再派发 builder |
| C4 | **`doe_context` 与 IDD `analysis_context` 未翻译**：字段 `column` vs `col`、缺 `data_path`、文件选择会选错表 | `analysis_context.schema.json:5-34`；`analyze.py:253-261`；v1 §C4 | v2 §4.3 新增 `doe_context_adapter`；写唯一 `00_input/analysis_context.json`；`--data run_table.csv` 显式指定；exclusions 独立目录 |
| C5 | **区间/窗口语义错误**：均值 CI 冒充预测界；逐因子边际窗口被当联合域；4-active 与 9^k 网格冲突 | `effects_anova.py:480-508`；`windows.py:102,185-191,251-298`；v1 §A1/A5 | v2 §5.1-5.5 定义 PI/均值 CI/效应 CI/容差区间四类；新增 joint_window/joint_setpoint；top_k + 连续优化/profile；设计域/凸包/leverage |
| C6 | **平台执行/权限/回流不成立**：line_start 无 setpoints、recipe gate 需活动 run、createRun 不冻结版本、DOE 工具绕过 grant-guard、artifact 只加 external 而 bridge 读 tasks | `lines.ts:74-119`；`recipe-gate.ts:63-69`；`dcw-recipe.repo.ts:394-412`；`grant-guard.ts:22-94`；`sweep.mjs:32-45` | v2 §6.2-6.5 新增原子 `doe_run_start/capture/stop`、recipeVersion 冻结、per-line mutex、DOE 工具写族/链式归属、artifact manifest + 幂等 outbox |

---

## 3. 主要 Major（摘要）

1. **验收阈值需重写**：IDD7 100 runs 的 93-97% PI 覆盖率约 25% 假失败；IDD2 “符号 100%”在接近 MDE 时不可达；DC4 逐字节 round-trip 不合理；LOOP4 “或给出原因”可空洞通过。
2. **多响应冲突按跨单位 |delta| 排序**不成立；应使用标准化效应/desirability/Pareto。
3. **纯误差/重复定义缺失**：run_table 需要 `design_point_id/replicate_group/replicate_kind`；不能按含 covariate 的 X 行分组。
4. **随机化检查无 run_order 即通过、小 n 跳过**；split-plot 无负向触发。
5. **next_design 方法细节不足**：fold-over 只镜像数值因子；augment 只加中心点不能估二次项；space-filling 忽略已有 runs；confirm 数量/位置未定义。
6. **初始设计生成无 owner**：平台 C2 说支持 full/fractional/CCD/BBD/LHS，但 IDD 只有识别没有生成；两边都不做会落空。
7. **前瞻功效/MDE 未进入设计创建**；VIF/Lenth/残差自相关被推到 P2，但它们是 PI/CI 可信的前提。
8. **证据等级与合同完整度混在一起**：把 units/constraints/ontology 塞进 grade 会误降级；应拆 `contract_status` / `consistency_status`。
9. **本体 store 无 profile/context_fp**：同列不同因子范围/单位/规格会被 exact reuse；`rejected` 仍可复用；严格 schema 的 role 与 plan 命名不一致。
10. **平台双副本 diag-bridge 已坏**：project 副本缺 `exports.mjs`；应单一权威源或一行 re-export，不要“同步两份”。
11. **工期低估**：19-31 天覆盖两仓库、迁移、7 工具、执行器、UI、本体、统计、E2E 不现实；实际约 9-12 周（IDD-only MVP 约 4-5 周）。
12. **验收缺可复现证据**：需固定双仓库 SHA、完整命令、硬件/种子、traceability matrix。

---

## 4. 评审后的关键设计决策

1. **本体先行是硬门**：DOE 在统计前必须完成 `doe_ontology_prepare`；生产环境不允许 `off`；没有本体时用先验知识构建，标 `INFERRED`/`NOT_APPLICABLE`，不编造。
2. **Agent 先理解再分析**：`ontology_brief` 是 Agent 契约，不是可选文档；Phase 0 不读 brief 不得跑统计。
3. **一个 `doe_context` 翻译器**：平台只产 `doe_context`，IDD 适配器写唯一 `analysis_context.json`；不允许两套 schema 并存。
4. **联合窗口优先**：逐因子窗口只作诊断；可执行推荐必须是 `joint_setpoint`，并过设计域/约束/观测范围三重门。
5. **执行原子化**：`doe_run_start` 一次完成“校验→冻结 recipe 版本→建 RecipeRun→激活 LineRun→写参数→记录 DOE run”，禁止用 recipe_trial 循环模拟。
6. **初始设计单一 owner**：IDD 新增 `design_build`（或平台只支持导入矩阵并明确声明）；不允许平台自研统计设计器。
7. **工期按工作包重估**：9-12 周全量；IDD-only MVP 4-5 周；先本体/契约，再统计，再平台。

---

## 5. 验收新增/修改（详见 v2 §9）

新增：
- **DC7** `doe_context → analysis_context` 消费验证
- **DC8** 初始设计生成/导入矩阵的设计性质
- **IDD4b** factor×response 矩阵（每格窗口或 `no_window_reason`）
- **IDD5b** 绑定约束（无约束最优点在约束外）
- **IDD7b** PI 模拟覆盖 + 宽度对比
- **IDD11** association screen 覆盖率/因果标注/性能
- **IDD12** >4 active 因子/窗口扩展性
- **ONT8** 用户显式 > 本体 > auto 的优先级与 `assigned_by`
- **ONT9** unmatched-with-reason、引用存在性、provenance/version
- **ONT10** profile/context_fp/版本钉住/失效
- **ONT11** 结论 → recipe/next_design 可执行映射
- **ONT12** 诊断管线本体语义回归
- **PLAT8** artifact 单一合同/缺失/幂等
- **PLAT9 / AGT1** Agent 理解 DOE 结果（数值一致、引用可定位、不把 association 当因果）
- **LOOP6** next_design → optimizer campaign 的 prior/round/parent 合同
- **LOOP7** 并发/互斥/重启/失败恢复/重复 ingest
- **REG6** 双仓库 SHA/完整命令/硬件规格/证据

修改：
- DC4 逐字节 → 规范化语义相等 + 数值容差
- DC2/DC5 区分“缺列”与“空值”
- LOOP3 改为“run 窗口内样本 100% 可关联；窗口外允许 null”
- LOOP4 删除“或给出原因”兜底，定义收敛/未收敛 reason code
- ONT4 改为“0 静默；unmatched 必须带 reason”
- ONT7 改为“引用 id 必须存在；允许 no_ontology_basis + reason”
- IDD7 改为 n≥2000 模拟覆盖
- PLAT3 改为全量 schema + hash
- REG1/REG2 改为“既有 136/219 仍绿 + 新增全绿”

---

## 6. 评审结论

- **计划方向正确**：契约先行、本体复用、DOE 一等公民、闭环分层都成立。
- **v1 不能直接开工**：6 个 Critical 项会导致“任务成功但分析对象错/结论不可执行/跨线读写/工期失控”。
- **v2 已逐项修订**：本体先行、契约翻译、联合窗口、执行原子化、artifact 幂等、验收重写、工期重估。
- **下一步**：v2 的 M0 契约冻结通过后，再进入 M0.5/M1；开工前记录双仓库 SHA 与工作树状态。

# AML 自动建模团队作业手册(Playbook)

本手册是「AML 影子建模团队」(首席数据科学家 lead + 数据/训练/评测工程师)的共同纪律。各成员的 systemPromptPrefix 只补充角色分工,与本手册互补、不重复;结论以平台工具校验与门禁判定为准(平台判定,不采信 Agent 自报)。

## 1. 使命模板说明

每个建模使命由 Channel 场景模板(`aml-mission-default.md`)渲染而来,lead 从使命中读取,不得虚构:

- `{{product}}` / `{{recipe}}`:目标产品与热 Recipe —— 决定取数范围,是隔离三元组的前两项;
- `{{horizon_steps}}`:多步滚动步长 —— 决定数据集 `window.horizonSteps` 与门禁 G2 的滚动 horizon;
- `{{budget_experiments}}`:实验预算 —— 最多可提交的训练轮数,耗尽即收尾汇报。

使命中缺失的参数,lead 先向用户确认后再开工。

## 2. 标准流程

盘点(`aml_node_catalog`)→ 建集(`aml_dataset_build` + `aml_dataset_stats` 复核)→ 基线(线性模型校准可学性)→ 迭代(单组件改动,`aml_job_submit` 提交)→ 评审(`aml_leaderboard` + 门禁 G1-G5 对抗审查)→ 晋升申请(lead 调 `aml_model_promote`,走人工审批)→ 案例沉淀(评测工程师 `save_memory` 记录 配方 × 结构 × 超参 × 陷阱)。

## 3. 数据纪律

- **隔离三元组(硬约束)**:产品 × 热 Recipe × run 绝不混;跨 Recipe 取数平台直接报错,任何成员不得尝试绕过。
- **清洗红线**:Hampel 剔除率 > 5% 或缺失率 > 15% 必须先复核(换 beatMs / 收窄时间窗 / 上报 lead)再交付训练;单 run 缺失过高按平台策略整 run 丢弃并记录。
- **时滞先行**:先读 `aml_dataset_stats` 的控制→目标滞后互相关估计,`historySteps ≥ 时滞格数`(时滞/beatMs 向上取整),再定窗口;horizon 按使命。

## 4. 迭代协议

- **AIDE 树搜索**:把每轮实验看作搜索树节点,沿有希望的方向展开,坏分支及时剪枝。
- **MLE-STAR 单组件改动**:每轮只改一个组件(结构 / 特征 / 超参 / 采样),并在 `change_note` 中声明,保证归因干净。
- **greedy-then-restore 回溯**:连续两轮指标变差即回溯到最优父节点换方向,不在坏分支上继续加码。
- **预算上限**:累计实验数达 `{{budget_experiments}}` 即停止提交转为汇报;禁止超预算刷实验。

## 5. 评测门禁(平台判定;阈值 live 可调,键名 `aml.gates.*`)

| 门禁 | 含义 | 默认阈值 |
| --- | --- | --- |
| G1 | 单步精度(test NRMSE) | ≤ `aml.gates.nrmse`(默认 0.10) |
| G2 | 多步滚动精度(horizon NRMSE) | ≤ `aml.gates.rolloutNrmse`(默认 0.25) |
| G3 | 泛化一致(\|test−val\|/val) | ≤ `aml.gates.valTestGap`(默认 20%) |
| G4 | 数据覆盖 | 行数 ≥ `aml.gates.minRows`(默认 500)且 批次 ≥ `aml.gates.minRuns`(默认 3) |
| G5 | 工件完整 | 契约 ONNX 存在且非空 |

门禁全部通过才允许发起晋升申请;任一未过,lead 写明缺项打回迭代。

## 6. 红线(全员)

1. 禁止跨 Recipe 取数,禁止在数据集中混入其他产品/配方的 run。
2. 禁止在训练代码里访问网络或读写工作区外路径(路径围栏会直接拒绝)。
3. 禁止在人工批准前宣称模型「已投产」—— 晋升申请通过审批前一律只是 candidate/shadow。
4. 数据不足时如实报告(数据不足 / 噪声 / 变量缺失),而不是硬训或虚报精度。

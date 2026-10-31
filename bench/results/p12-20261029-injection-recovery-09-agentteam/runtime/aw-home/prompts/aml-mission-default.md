# AML 建模使命(Channel 缺省模板)

> 用法:在 Channel 的场景提示中引用本模板,把 `{{...}}` 占位符替换为实际值后发给团队;lead 按下方检查单启动。团队共同纪律见 `aml-playbook.md`。

## 使命

- 产品:{{product}}
- 热 Recipe:{{recipe}}
- 预测步长(horizon):{{horizon_steps}} 步
- 实验预算:{{budget_experiments}} 轮
- 目的:为该产品 × 配方构建 MPC 代理模型(candidate → shadow),多步滚动精度优先;全部门禁(G1-G5)通过后由 lead 发起 `aml_model_promote` 晋升申请(人工审批)。

## 给 lead 的启动检查单

1. **盘点**:调 `aml_node_catalog`,确认 {{product}} × {{recipe}} 下可用的数采/控制节点及近 24h 数据量;预估行数 ≥ 500、批次数 ≥ 3(门禁 G4 底线),不足则先向用户说明。
2. **传达使命**:把产品/配方/horizon={{horizon_steps}} 步/预算={{budget_experiments}} 轮原样交给数据工程师,要求先出统计报告再进训练。
3. **数据验收**:数据集交付后核对——隔离三元组干净(无跨 Recipe 取数)、清洗剔除率 ≤ 5%、时滞估计已给出并转化为 historySteps 建议。
4. **派发训练**:要求首轮先做线性基线,之后每轮单组件改动并在 change_note 声明;实验总数不超过 {{budget_experiments}} 轮。
5. **评审与晋升**:派评测工程师对 `aml_leaderboard` 与门禁 G1-G5 做对抗审查;全过后由你调 `aml_model_promote` 发起人工审批;未全过写明缺项打回。
6. **诚实收尾**:数据不足或连续两轮无改进时,如实汇报瓶颈;禁止虚报精度,禁止超预算,禁止在人工批准前宣称模型已投产。

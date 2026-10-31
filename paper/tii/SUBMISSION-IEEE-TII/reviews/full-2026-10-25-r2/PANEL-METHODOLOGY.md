# Methodology Reviewer

## 评价

Section V 把历史场景轨迹、当前版本路由检查、mock-state 上下文保护拆开报告。每种路线使用不同判据；命令回执与之后采集的过程样本有区别。历史数据每场景只有一条脚本轨迹；当前试验每个 recipe trial 只在 20 s 后查询一个样本。论文已说明它们不构成过程重复、收敛或性能比较，因此本稿没有因缺少显著性检验而产生统计报告错误。

## 主要意见

1. **核心配置能力没有直接测试（Major）。** 当前 v0.8.0 在 cast-film 和 annealing 两套配置上测试路由和记录连续性，但没有 controlled profile/binding adaptation 或配置复用对照。REPRODUCIBILITY.md 也承认该项未测。补充预先定义映射与通过/拒绝标准的适配测试，或将结论限定为现有两套配置。
2. **正文中的场景设置分散（Moderate）。** cast-film 和 annealing 的控制信号、观察信号、协议、目标区间、候选参数和单个样本没有集中呈现。完整细节更易在复现说明中找到。用一张紧凑表展示正文最关键的映射。
3. **历史轨迹只作上下文（Moderate）。** seed-42 历史轨迹并非当前版本集成证据；应避免让它承担框架有效性论据。

## 结果边界

六个 model-mediated route 样本都低于各自目标带；它们支持 route completion 与记录关联，不支持过程达标或模型选择质量。上下文守卫消融是在 mock state 中进行，只能说明该 tuple check 在所测路径中的增量效果。

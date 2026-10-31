# 实验证据审阅与正文写作建议

## 审阅范围与结论

本次盘点论文现有证据账本、补充包、模拟器基准归档、harness 验收报告和相应日志；并非重新执行全系统测试，也不能保证发现工作区所有历史日志。证据可用于支持“所列配置下的系统集成和任务执行路径”，但不足以支持物理产线性能、统计重复性、不同 harness 等价、模型优于其他策略，或完整架构均经过验证等主张。测试日期、版本、接口、是否采用真实模型、审批方式和观测方式必须保留；不同测试中的断言数、操作数和独立实验数不可相加。

## 核心证据与可以写的结论

| 证据 | 类型与结果 | 可写范围和限制 |
|---|---|---|
| R20 注册 harness | v0.8.0 工作树，配置 OMP 与 glm-5.3-flash；两种模拟场景各顺序执行三个任务。每个任务从三个预验证候选值中选择，采用合成审批，并留下任务、审批、配方试验回执和带运行标识的单点样本；六次任务完成，六个样本均在目标带外。 | 支持受限任务路径和记录留存。每场景共用模拟器，单点读取在回执检查后 20 s 进行，使用 SQLite 回退；不能证明收敛、独立重复或正常在线 DAQ。未见独立归档的模型服务原始请求和响应，不能声称保存了完整模型推理链。 |
| 四个工艺任务 | 四种本地模拟场景各一条确定性控制轨迹，报告的最终主要指标均在各自目标带内。 | 是脚本选点而非 LLM 选点；轨迹内连续观测不是独立重复。退火末端拉伸强度和表面缺陷、废水末端完整出水向量缺失；完整执行时源码快照未保留。 |
| R21 / R22 入口检查 | 两场景、隔离环境下的固定调用任务与直接 REST 调用；合成审批和单点探针。 | 分别支持已测入口的记录描述。R21 是固定调用 fixture，R22 不经过 harness；不支持两入口行为等价或在线采集链验证。 |
| 上下文检查与消融 | 模拟审批、mock driver 的组件测试；测试注入的上下文变化和去除比较的变体。 | 支持特定组件中的上下文检查效果；不支持真实人员审批效率、设备安全或系统级故障概率。 |
| 协议及入线 | 模拟协议连接报告；另一次模拟入线重放覆盖 7 个采集节点和 4 个写节点。 | 是不同测试。协议测试的完整逐样本轨迹未保留，入线重放版本未完全固定；不能推断任意设备均可接入。 |
| 历史真实模型任务 | 先前基准的两个 OMP 任务：一个按给定设定值执行，另一个在目标约束内选择设定值。 | 同一历史基准活动中的不同任务，不能视为独立重复或当前版本结果；历史运行环境未完整冻结，现存日志来源由作者确认。目标任务中报告的 51.7 μm 六桶均值与另一窗口均值 52.02 μm 是不同读数，不能混用。日志中还存在样本超出目标带却被文字称为“全在带内”的矛盾，不可据此声称全部样本达标或过程稳定。 |
| 历史多 harness 验收 | 旧版 v0.7.67 报告记录 OMP 和 Copilot 的真实引擎任务，团队 lead 为 mock；一次批次 4/5 回执已验证，另 1 项未验证。 | 只能说明旧版特定配置；其他引擎存在凭据或配置失败，TUI 最终轮 6 项失败。不能写成所有 harness 或全系统通过。 |

R20 的两个场景实际样本分别为薄膜 45.69、46.69、45.69 μm（目标 48–52 μm）与退火 679.60、677.70、678.10 °C（目标 700–760 °C）。这些样本全部低于目标，必须与链路完成率一起如实报告。

## 推荐的正文组织

在维持 10 页和现有章节结构的前提下，建议将实验按问题而不是测试批次组织：① 协议和节点接入；② 真实 harness 任务路径及独立的直接调用对照性描述；③ 审批上下文组件检查；④ 四场景确定性过程轨迹。每类在正文仅保留测试对象、关键操作、结果及一条最重要的限制，详细日志、任务级数据、失败和版本信息放入 Supplementary。不要将四场景轨迹描述为由模型自主优化，也不要把 R20 的六次单点采样与四场景结果合并计算成功率。

建议在现有 “Task and Direct-Operation Entries” 小节用下面的短段替换部分重复的固定调用描述，并相应调整表格和数据可用性说明；这是可供作者核对的建议稿，尚未写入正文：

> A separate registered-harness test configured an external language model to select one of three prevalidated settings for each of six sequential tasks across two simulated scenes. The application records associate each selection with an OMP tool proposal; independent model-provider request and response logs were not retained. With synthetic approval, all six tasks completed and retained a recipe-trial receipt and a run-tagged sample. All six samples lay outside their target bands. Each sample was a single driver probe after a 20-s delay and used a local database fallback; three tasks per scene shared a simulator instance. These records exercise the configured task path but do not establish convergence, independent replication, or normal online acquisition.

在方法或附录中补充模型名称、版本、任务提示、三个候选的生成方式、各任务读数与回执；明确模型服务的原始请求/响应未归档，避免把工作树配置视为独立的提供商侧证明。历史模型案例可作为背景性补充而非与 R20 合并的实验组。正文如需提升可发表性，应补充有完整模型请求/工具调用/回执/过程时间序列的可复核记录，并在固定版本和多次独立初始化条件下开展模型与脚本基线的对照；实际设备或硬件在环验证将另行支持物理部署主张。

## 投稿前检查

- 对补充材料做最终人工双盲与保密复核；自动模式扫描不能保证匿名或无密钥。
- 核对提供给审稿人的附件是否确实包含文中所声明的文件，注明原文件与脱敏副本的哈希及差异。
- 仔细审阅每个对外主张和参考文献，补齐或明确不可重放的版本、配置与终端观测。
- 确认 IEEE TII 投稿系统当前的附件格式、数据可用性及 AI 使用披露渠道。

# 受治理学习：基线证据契约

本契约供离线验收取证，不改变 Workshop 运行逻辑，不签发产品发布、设备操作或现场准入许可。历史来源、哈希及可获取性见[冻结证据索引](governed-learning-evidence-index.md)，实现批次见[实施计划](../superpowers/plans/2026-11-20-governed-product-learning-and-industrial-readiness.md)。

## 清单

`scripts/_audit/governed-learning-evidence.mjs` 的 `buildBaselineManifest(input)` 每次只汇总一个运行，调用方须先验证证据来源和终态判据；该函数不是来源验证器。

| 字段 | 口径 |
| --- | --- |
| `revision` / `runId` | 执行时实际仓库 SHA 和单次运行标识；历史构建无法绑定 SHA 时为 `null`，不填当前 `main`。 |
| `environment` | `simulation`、`offline`、`physical_hil`、`production` 或 `unknown`。模拟过程可调用真实模型，但不能记为物理。 |
| `captureOrigin` | `current` 或 `historical`。只有当前、绑定已知提交的物理证据才有资格通过现场单项；仍由调用方独立核验来源。 |
| `modelProvenance` | `real_model`、`fixture`、`mixed` 或 `unknown`；不从环境类型推导。 |
| `checks` | 唯一 `id`、`category`、原始执行状态、适用判据与推导状态；重复 ID 或未知分类拒绝生成清单。 |
| `denominators` | `mechanism`（功能机制）、`effect`（有无效果）、`resilience`（故障恢复）、`field_admission`（现场）单列分母，包含失败、跳过和阻塞项。不汇总成一个通过率。 |
| `captureHashes` / `missing` | 引用 → SHA-256；缺少的引用及原因单列。索引里的 `historical-local / unavailable` 不能满足新运行必验判据。未知数量用 `null`，不填零。 |

`classifyEvidenceCheck` 的优先级是：明确阻断原因 → `BLOCKED`；未开始 → `NOT_RUN`；开始但未完成 → `PARTIAL`；终态且提交显式布尔判据 → `PASS/FAIL`；未知执行状态或缺合法判据 → `BLOCKED`。选定子检查全部绿不等于业务最终交付。非物理来源即使宣称通过现场检查，基线汇总也将该条标为 `BLOCKED`。物理类检查的单项通过仍不等于 Task 14 的准入签核。

## 历史基线与待补项

[两轮脱敏清单输入](governed-learning-historical-baseline-inputs.json)可直接交给 `buildBaselineManifest`。每轮只记录四个汇总检查的状态；`denominators` 计清单中的检查，扩展字段 `historicalTotalDenominators` 表示当年的真实样本或任务总数，无法独立核实则为 `null`。索引引用与快照哈希只做对账，不作为真实模型或历史执行的再验证。

| 运行 | 机制 | 效果 | 韧性 | 现场 |
| --- | --- | --- | --- | --- |
| 11-19 三端轮（历史本地 L01–L05） | 部分明确的机制有记录，选定的 16 项不代替全链分母；模型召回未收口。 | 无冻结的独立产品复用对照，`NOT_RUN`。 | 有 Project 重试记录，未跑完整恢复矩阵。 | 影子孪生，`NOT_RUN`。 |
| 11-19 集成轮（历史本地 L06–L10） | 记录了两次模拟端回读、候选和人审；Project 链和落地页实现不是完整交付，`PARTIAL`。 | 不同参数不得合并计独立复验，未证明新任务收益，`NOT_RUN`。 | 记录超时与中断，不补算未达终态的任务。 | 影子孪生，`NOT_RUN`。 |

旧记忆只按 `kind`、无可解析来源、无可信上下文、重复 active Profile 统计脱敏计数。没有获准的数据库副本时四项均为 `null / NOT_RUN`；不连接默认 home 或生产数据补数。指标用可关联的宿主事件定义：排队=受理→首次开始；活跃执行=实际执行段之和（不含队列及 HITL 等待）；HITL 等待=合法请求创建→结论或到期；恢复=故障检测→对账完成、确认续跑或明确阻断；DAQ 质量=预期/有效/丢失样本与缺口窗。无获准的隔离计量样本和事先冻结的 SLO 时不判定达标。

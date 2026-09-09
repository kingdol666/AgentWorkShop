# AML —— Agent 驱动的自动深度学习拟合 / MPC 影子孪生建模平台

> 模块代号 `aml`(Auto Modeling Lab)。设计计划全文见 `.omc/plans/2026-09-10-agent-aml-mpc-shadow-platform.md`(含文献映射与 ADR)。

## 是什么

在 MAS 镜像数采(daq)与时序库之上,由**内置深度学习专家团队**全自主完成:

```
拉数(隔离三元组) → 自动清洗 → 写代码训练 → 平台权威评测 → 门禁迭代 → HITL 晋升 → 影子模型参考
```

调控 Agent 调参前通过 `aml_model_reference` 查询生产模型,获得"拟议参数 → 预测输出轨迹"的影子参考(数字孪生/MPC 前置);REST 侧另有 `/api/workshop/aml/models/:id/predict` 显式预测入口。

## 架构速览

| 层 | 位置 | 说明 |
|---|---|---|
| 数据集层 | `server/services/workshop/aml/dataset-builder.ts` | 隔离三元组 (line/product/recipe) 必填;state/量程/Hampel 清洗 → beatMs 对齐 → byRun 滑窗切分 → 快照落 `data/aml/datasets/<id>/`(manifest+report+float32 数组+sha256) |
| 统计引擎 | `aml/stats.ts`、`aml/clean.ts` | 逐节点概要/相关/控制→目标滞后互相关(时滞估计),进 dataset report |
| 作业运行器 | `aml/job-orchestrator.ts` | FIFO 队列、并发上限、双段子进程(train → 平台评估)、停摆看门狗、`##AML` NDJSON 协议、`aml.job` WS 帧 |
| Python 桥 | `aml/python-runtime.ts` + `aml/python/` | 探测 python/uv → 共享 venv(marker 幂等);`amlkit.py`(平台种)/`aml_eval.py`(权威评估器)/`train-example.py`(参考实现);训练进程不联网 |
| 门禁 | `aml/gates.ts` | G1 单步 NRMSE≤0.10 / G2 多步滚动 NRMSE≤0.25 / G3 泛化差≤20% / G4 行数≥500 批次≥3 / G5 工件完整;阈值 `aml.gates.*` live 可调 |
| 注册表 | `aml/model-registry.ts` | candidate→shadow→production→retired;生产晋升前 ONNX 深检;同组旧生产自动退役;REST 晋升=产线 operate 权限,Agent 晋升=HITL 审批 |
| 预测服务 | `aml/predictor.ts` | onnxruntime-node 懒加载(可选依赖)+ session LRU(4);one-step 闭环滚动与评估器同口径 |
| GC | `aml/retention.ts` | 无引用数据集 30 天 / retired 工件 90 天 / 失败作业目录 7 天;磁盘配额 `aml.job.diskQuotaMb` |

## 模型 IO 契约(MPC 面向)

canonical one-step:输入 `history [batch, H, nAll]`(归一化)→ 输出 `y_next [batch, nTgt]`(归一化)。多步=闭环滚动:预测回填 target 列、control 列取未来 U(对应 Recipe 参数,见 io_spec)、feature 列持最后观测(persistence)。评估器与预测服务同口径实现,保证门禁指标可复现于推理。

## 使用

- **UI**:侧导航「建模」(`/aml`):数据集/作业/排行榜/注册表/预测控制台。
- **Agent**:内置团队「AML 影子建模团队」(`team-aml-shadow`,部署前先加成员)或任意成员直接调用工具族 `aml_node_catalog / aml_dataset_build / aml_dataset_stats / aml_job_submit / aml_job_status / aml_job_logs / aml_job_cancel / aml_leaderboard / aml_model_promote(lead 专属)/ aml_model_reference`(见 `.AgentWorkShop/prompts/host-tools.json`);调参 what-if 经 `aml_model_reference` 的 `controls` 参数传入拟议参数值。
- **REST**:`/api/workshop/aml/{datasets,jobs,experiments,models}`(见各路由文件头注释)。

## Python 运行时

首次训练自动探测(`python`/`py -3`/uv)并在 `<configRoot>/data/aml/runtime/venv` 供给锁定依赖(`aml/python/requirements.txt`;仅此阶段联网,可配 `aml.python.indexUrl` 镜像)。无 Python 时作业报 `AML_PYTHON_MISSING` 指引;`AML_STUB=1` 启动可用存根运行器走通全链路(存根模型不可预测,晋升被深检拦截)。

## 治理与安全边界

- 训练代码仅运行于作业工作区(`data/aml/jobs/<id>/workspace/`),平台以独立子进程执行、墙钟/停摆/并发三重限制、杀树回收;权威指标由平台评估器复算,不采信 Agent 自报。
- 数据集节点集 ⊆ Agent 的 daq 绑定(只缩不放);REST 侧走产线 line grants。
- 全部副作用过 `recordOps`(audit_log + ops.log 实时帧),Agent 行为归属「Channel/成员」。
- SQL 全参数绑定;工作区路径收敛校验(amlkit `_safe_job_path`);Mimosa 审计通过。

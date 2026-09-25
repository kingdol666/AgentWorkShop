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
| 环境自检 | `aml/env-manager.ts` + `aml/python-runtime.ts` | 探测 uv/Python → 一键安装 uv 到 `./aml/tools` → 供给 `./aml/.venv`;异步任务 + 进度轮询(`GET /aml/env`) |
| 元数据↔实体 | `aml/entity.ts` | SQLite 四表为索引、`./aml` 目录为实体;逐 id 对账(缺失/孤儿/契约不齐)、按规范路径装载实体、孤儿清理 |
| 数据集层 | `server/services/workshop/aml/dataset-builder.ts` | 隔离三元组 (line/product/recipe) 必填;state/量程/Hampel 清洗 → beatMs 对齐 → byRun 滑窗切分 → 快照落 `./aml/datasets/<id>/`(manifest+report+float32 数组+sha256) |
| 统计引擎 | `aml/stats.ts`、`aml/clean.ts` | 逐节点概要/相关/控制→目标滞后互相关(时滞估计),进 dataset report |
| 作业运行器 | `aml/job-orchestrator.ts` | FIFO 队列、并发上限、双段子进程(train → 平台评估)、停摆看门狗、`##AML` NDJSON 协议、`aml.job` WS 帧 |
| Python 桥 | `aml/python-runtime.ts` + `aml/python/` | 探测 python/uv → 共享 `./aml/.venv`(marker 幂等);`amlkit.py`(平台种)/`aml_eval.py`(权威评估器)/`train-example.py`(参考实现);训练进程不联网 |
| 门禁 | `aml/gates.ts` | G1 单步 NRMSE≤0.10 / G2 多步滚动 NRMSE≤0.25 / G3 泛化差≤20% / G4 行数≥500 批次≥3 / G5 工件完整;阈值 `aml.gates.*` live 可调 |
| 注册表 | `aml/model-registry.ts` | candidate→shadow→production→retired;生产晋升前 ONNX 深检;同组旧生产自动退役;REST 晋升=产线 operate 权限,Agent 晋升=HITL 审批 |
| 预测服务 | `aml/predictor.ts` | onnxruntime-node 懒加载(可选依赖)+ session LRU(4);one-step 闭环滚动与评估器同口径 |
| GC | `aml/retention.ts` | 无引用数据集 30 天 / retired 工件 90 天 / 失败作业目录 7 天;磁盘配额 `aml.job.diskQuotaMb` |

## 资产根布局(`./aml`)

AML 的全部产物收敛在**项目根下的 `./aml`**(与配置根 `.AgentWorkShop` 分离 —— 这里是可移植资产,
不是运行时状态),整体可拷贝、可删除重建:

```
aml/
  .venv/            uv 创建/管理的 Python 环境(依赖锁定在 aml/python/requirements.txt)
  datasets/<id>/    spec.json 取数规格 · manifest.json 列定义 · report.json 质量报告 · arrays/*.f32
  jobs/<id>/        job.json 提交契约 · workspace/(train.py+amlkit.py) · run.log · artifacts/
  models/<id>/      model.onnx + io_spec.json(输入输出契约,不可变)
  runtime/          uv.json(一键安装记录)/ env.json
  tools/            平台自动安装的 uv 二进制(免管理员、不改系统 PATH)
  README.md         目录自述   .gitignore  忽略运行时资产
```

根解析优先级(源码 `shared/config/home.mjs` 的 `resolveAmlRoot`,五级):
`AW_AML_DIR` 环境变量(显式覆盖)> 检出根 `./aml`(cwd 向上找到 `config.yml` + `nuxt.config.ts`)
> `<awHome>/aml`(`AW_MODE=home`;`AW_HOME` 可重定向,不是写死 `~/.AgentWorkShop`)
> cwd 向上真实存在的 `.AgentWorkShop/aml`(不越过 `$HOME`)> `<cwd>/aml` 兜底。
`GET /api/workshop/aml/env` 返回实际生效路径与来源,UI「运行环境」面板直接展示。

## 元数据 CRUD

平台是「SQLite 元数据 + 磁盘实体」两段式,两者以 id 一一对应:

| 操作 | 端点 | 说明 |
|---|---|---|
| C | `POST /aml/datasets`、`POST /aml/jobs` | 建快照 / 提交训练(实体目录同步落盘) |
| R | `GET /aml/{datasets,jobs,models}`、`GET /aml/{datasets,jobs}/:id` | 详情按**规范路径**装载实体并校验契约,不信任元数据 `path` 字段 |
| U | `PATCH /aml/datasets/:id`、`PATCH /aml/models/:id` | 更新备注(数据不可变:sha256 是复现锚) |
| D | `DELETE /aml/{datasets,models,jobs}/:id` | 元数据行 + 实体目录;带引用保护 |
| 对账 | `GET /aml/entities`、`POST /aml/entities/prune` | 逐 id 报缺失/孤儿/契约不齐;清理孤儿实体目录(带根内越界防护) |

删除保护:被实验或模型引用的数据集、production 阶段模型、运行中作业、已产出模型的作业一律拒绝删除
(保住模型工件的可复现性溯源)。

## 模型 IO 契约(MPC 面向)

canonical one-step:输入 `history [batch, H, nAll]`(归一化)→ 输出 `y_next [batch, nTgt]`(归一化)。多步=闭环滚动:预测回填 target 列、control 列取未来 U(对应 Recipe 参数,见 io_spec)、feature 列持最后观测(persistence)。评估器与预测服务同口径实现,保证门禁指标可复现于推理。

## 使用

- **UI**:侧导航「建模」(`/aml`):运行环境(uv/venv/对账)/ 数据集 / 作业 / 排行榜 / 注册表 / 预测控制台。
- **Agent**:内置团队「AML 影子建模团队」(`team-aml-shadow`,部署前先加成员)或任意成员直接调用工具族 `aml_node_catalog / aml_dataset_build / aml_dataset_stats / aml_job_submit / aml_job_status / aml_job_logs / aml_job_cancel / aml_leaderboard / aml_model_promote(lead 专属)/ aml_model_reference`(见 `.AgentWorkShop/prompts/host-tools.json`);调参 what-if 经 `aml_model_reference` 的 `controls` 参数传入拟议参数值。
- **REST**:`/api/workshop/aml/{env,entities,datasets,jobs,experiments,models}`(见各路由文件头注释)。

## 混合孪生 × MPC(Core Hybrid Twin)

除「数据集 → 训练 → 门禁 → 注册表」这条数据链,AML 还承载**混合孪生**平面:灰箱物理主干(以注塑为例的低阶模型)+ **有界 PyTorch 残差**训练协议,外挂六类契约 ——
`SceneContract`(场景:设备/信号/约束/目标)、`PhysicsModelManifest`(物理主干清单)、`TwinSnapshot`(带新鲜度的工况快照)、`ObjectiveProfile`(目标与权重)、`VirtualTrial`(虚拟试验)、`RecommendationCertificate`(推荐证书)。

- **启用方式**:Channel 的 profile(`legacy` 默认 / `hybrid_twin`),在 Channel 模板与实例上选择;启用后按 profile 注入 6 个专属工具:`twin_scene_read` / `twin_snapshot_create` / `twin_trial_run` / `mpc_optimize` / `twin_gate_evaluate` / `twin_calibration_request`。
- **安全语义**:试验**永远是虚拟的**(`candidateExecuted=false`);不安全候选被全轨迹硬约束直接拒绝;快照过期 → `SNAPSHOT_STALE`;只有门禁与收益同时通过才签发推荐证书,证书未签发前**不产生真实 DCW 写入**(recommendation-only)。
- **硬约束失败关闭**(v0.7.48):`constraints[].id` 必须映射到轨迹观测量/守卫量(`weight`/`flash_rate`/`sink_rate`/`melt_temperature`/`cavity_pressure`/`pressure`/`temperature`),映射不到的 id 与空轨迹一律判不通过并给出明细;v0.7.47 及更早会跳过并返回「全轨迹通过」,造成假通过。
- **服务端策略**:数据不足 → `safe_small_step`;模型过门禁 → `precise_search`;持续校准请求按去重 + cooldown 登记。
- **闭环连线**(v0.7.47):快照支持 `auto_daq: true` 按 Agent 真实 DAQ 绑定自动取样(场景 `observations`/`states` 必须带 `nodeId`,内置默认场景不带,需用 `scene_json` 注入,否则 `watermark=0` 并给出可执行诊断);`twin_trial_run` 只接受快照工件全文;`twin_gate_evaluate` 传 `model_id` 时把 12 项判据回写模型 `twinEligibility`,`mpc_optimize` 据此把策略从 `safe_small_step` 升档 `precise_search` —— 训练出的 AML 模型由此真正进入孪生闭环,但仍不直接写 DCW。
- **工件与记录**:SQLite Hybrid Twin 元数据表 + 本地 `aml/twins/` 工件;计划与验收见 `docs/aml-hybrid-twin-mpc-integration-plan.md`、`docs/aml-hybrid-twin-implementation-acceptance.md`(首个场景 = PLC 模拟器 `injection-line`)。

## Python 运行时

首次训练自动探测 uv 与 Python,并在 `./aml/.venv` 供给锁定依赖(`aml/python/requirements.txt`;仅此阶段联网,可配 `aml.python.indexUrl` 镜像)。

UI「运行环境」面板(`/aml` 页)提供完整引导:

1. **uv 检测** —— 探测顺序:`aml.python.uvBin` 配置 > `./aml/tools`(平台装过的)> `./aml/runtime/uv.json` 记录 > 系统 PATH;来源随状态一并显示。
2. **一键安装 uv** —— 未检测到时按钮可用:调官方安装脚本并令 `UV_INSTALL_DIR=./aml/tools`、`UV_NO_MODIFY_PATH=1`,
   **不改系统 PATH、不需要管理员**;失败自动回退 `python -m pip install --target ./aml/tools uv`。
3. **创建/重建训练环境** —— 有 uv 走 `uv venv` + `uv pip install`(快);无 uv 回退 `python -m venv`(慢但可用)。
   环境就绪以 marker 文件(`.aml-ok-<requirements摘要>`)为准,依赖或镜像变更即视为需重建。
4. **重新检测** —— 手工在系统里装了 uv/Python 后免重启生效。
5. **元数据↔实体对账** —— 见上文「元数据 CRUD」;孤儿实体可一键清理。

安装与建环境都是分钟级动作:接口异步返回任务快照(`kind`/`status`/`log`),页面按 1.5s 轮询刷新进度。
无 Python 时作业报 `AML_PYTHON_MISSING` 指引;`AML_STUB=1` 启动可用存根运行器走通全链路(存根模型不可预测,晋升被深检拦截)。

## 治理与安全边界

- 训练代码仅运行于作业工作区(`./aml/jobs/<id>/workspace/`),平台以独立子进程执行、墙钟/停摆/并发三重限制、杀树回收;权威指标由平台评估器复算,不采信 Agent 自报。
- 数据集节点集 ⊆ Agent 的 daq 绑定(只缩不放);REST 侧走产线 line grants。
- 全部副作用过 `recordOps`(audit_log + ops.log 实时帧),Agent 行为归属「Channel/成员」。
- SQL 全参数绑定;工作区路径收敛校验(amlkit `_safe_job_path`);Mimosa 审计通过。

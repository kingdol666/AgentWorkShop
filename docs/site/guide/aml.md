# AML 自动建模(Agent 驱动的拟合与影子孪生)

模块代号 `aml`(Auto Modeling Lab):在 MAS 镜像数采与时序库之上,由**内置深度学习专家团队**
自主完成「拉数 → 清洗 → 训练 → 平台评测 → 门禁迭代 → HITL 晋升 → 影子参考」全链路。

```
拉数(隔离三元组) → 自动清洗 → 写代码训练 → 平台权威评测 → 门禁迭代 → HITL 晋升 → 影子模型参考
```

调控 Agent 调参前经 `aml_model_reference` 查询生产模型,拿到「拟议参数 → 预测输出轨迹」的
影子参考(数字孪生 / MPC 前置);REST 侧对应 `POST /api/workshop/aml/models/:id/predict`。
完整手册(含文献映射与 ADR)见仓库 [docs/aml.md](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/aml.md)。

## 资产根

AML 的产物(数据集数组、作业工作区、ONNX 工件、uv 虚拟环境)是**可移植资产**,与运行时状态
目录 `.AgentWorkShop` 分离,整个 `./aml` 可拷贝、可删除重建:

| 优先级 | 条件 | 资产根 |
|---|---|---|
| ① | `AW_AML_DIR` 已设置 | 该目录(显式覆盖,优先级最高) |
| ② | 检出内运行(`AW_MODE` 不为 `home`,且 cwd 向上找到 `config.yml` + `nuxt.config.ts`) | `<检出根>/aml` |
| ③ | `AW_MODE=home`(全局安装 / 显式强制 home) | `<awHome>/aml`——`AW_HOME` 可重定向,**不是**写死 `~/.AgentWorkShop` |
| ④ | 非检出目录,但 cwd 向上存在真实 `.AgentWorkShop/` 目录(`findLocalConfigRoot`,向上不越过 `$HOME`) | `<该项目 .AgentWorkShop>/aml` |
| ⑤ | 其余任意目录兜底 | `<cwd>/aml` |

目录骨架:

```
aml/
  .venv/            uv 创建/管理的 Python 环境(依赖锁定在 aml/python/requirements.txt)
  datasets/<id>/    spec.json 取数规格 · manifest.json 列定义 · report.json 质量报告 · arrays/*.f32
  jobs/<id>/        job.json 提交契约 · workspace/(train.py+amlkit.py) · run.log · artifacts/
  models/<id>/      model.onnx + io_spec.json(输入输出契约,不可变)
  runtime/          uv.json(一键安装记录)/ env.json
  tools/            平台自动安装的 uv 二进制(免管理员、不改系统 PATH)
```

`GET /api/workshop/aml/env` 返回实际生效路径与来源,UI「运行环境」面板直接展示。

## 设置(aml 组,16 项)

设置页「运行配置」的 `aml` 组共 **16 个描述符**:阈值与配额类键为 `live`(保存即生效),
Python 路径类键为 `restart`。

| config 键 | 默认 | 生效 | 说明 |
|---|---|---|---|
| `aml.python.pythonBin` | 空 | restart | 指定 Python 解释器(留空自动探测) |
| `aml.python.uvBin` | 空 | restart | 指定 uv 可执行文件(优先于 `./aml/tools`) |
| `aml.python.indexUrl` | 空 | restart | pip 镜像索引(依赖供给加速) |
| `aml.job.timeoutMs` | 1800000 | live | 单作业墙钟上限(30 分钟) |
| `aml.job.maxConcurrent` | 2 | live | 并发训练作业上限 |
| `aml.job.diskQuotaMb` | 2048 | live | 作业磁盘配额 |
| `aml.job.stallMs` | 600000 | live | 停摆看门狗(无进度即判停) |
| `aml.dataset.maxRows` | 200000 | live | 单数据集行数上限 |
| `aml.dataset.retentionDays` | 30 | live | 无引用数据集保留天数 |
| `aml.dataset.allowCrossRecipe` | false | live | 是否允许跨 Recipe 取数(默认关闭,隔离三元组必填) |
| `aml.model.retiredKeepDays` | 90 | live | retired 工件保留天数 |
| `aml.gates.nrmse` | 0.10 | live | G1 单步 NRMSE 上限 |
| `aml.gates.rolloutNrmse` | 0.25 | live | G2 多步滚动 NRMSE 上限 |
| `aml.gates.valTestGap` | 0.2(20%) | live | G3 泛化差上限 |
| `aml.gates.minRows` | 500 | live | G4 训练行数下限 |
| `aml.gates.minRuns` | 3 | live | G4 批次数下限 |

CLI 例:`aw config set aml.gates.nrmse 0.12`、`aw config get aml.job.maxConcurrent`;
环境变量除通用 `AW_AML_*` 规则外,还有 7 个显式别名:`AML_PYTHON_BIN`、`AML_UV_BIN`、
`AML_PYTHON_INDEX_URL`、`AML_JOB_TIMEOUT_MS`、`AML_JOB_MAX_CONCURRENT`、
`AML_DISK_QUOTA_MB`、`AML_JOB_STALL_MS`。

## REST 树(`/api/workshop/aml/**`)

| 面 | 端点 | 说明 |
|---|---|---|
| 概览 | `GET /api/workshop/aml` | 运行时状态 + 环境自检 + 近期数据集/模型/作业计数(首屏一次渲染) |
| 运行环境 | `GET .../aml/env`、`POST .../aml/env/{uv,venv,recheck}` | uv/Python 探测、一键安装 uv、创建/重建 venv、重新检测(异步任务 + 进度轮询) |
| 实体对账 | `GET .../aml/entities`、`POST .../aml/entities/prune` | SQLite 元数据 ↔ `./aml` 实体逐 id 对账(缺失/孤儿/契约不齐);清理孤儿目录 |
| 数据集 | `GET/POST .../aml/datasets`、`GET/PATCH/DELETE .../aml/datasets/:id`、`GET .../aml/datasets/:id/preview` | 隔离三元组(line/product/recipe)必填;快照不可变(sha256 是复现锚);预览抽样 |
| 作业 | `GET/POST .../aml/jobs`、`GET/DELETE .../aml/jobs/:id`、`POST .../aml/jobs/:id/{cancel,retry}`、`GET .../aml/jobs/:id/logs` | FIFO 队列 + 并发上限;`##AML` NDJSON 进度协议;日志增量拉取 |
| 实验 | `GET .../aml/experiments?datasetId=` | 谱系树 + 门禁明细 + 主指标 |
| 模型 | `GET .../aml/models`、`PATCH/DELETE .../aml/models/:id`、`POST .../aml/models/:id/{predict,promote}` | 注册表阶段流转;predict = what-if 预测;promote = 阶段晋升(production 前做 ONNX 深检) |

权限对齐产线 line grants:数据集读取与预测需 `readonly`,晋升需 `operate`;删除有引用保护
(被实验或模型引用的数据集、production 阶段模型、运行中作业、已产出模型的作业一律拒绝删除)。

## Agent 工具(10 个)

| 工具 | 作用 |
|---|---|
| `aml_node_catalog` | 盘点可建模资产(节点语义 × 近 24h 数据量) |
| `aml_dataset_build` | 构建数据集快照(隔离三元组 + 清洗 + beatMs 对齐 + 滑窗切分) |
| `aml_dataset_stats` | 数据集统计报告(控制→目标滞后互相关 / 相关 / 逐 run 轮廓) |
| `aml_job_submit` | 提交训练作业(可内联 train.py 代码) |
| `aml_job_status` | 作业状态快照 |
| `aml_job_logs` | 作业日志(排错) |
| `aml_job_cancel` | 取消作业 |
| `aml_leaderboard` | 排行榜(谱系 + 门禁明细 + 主指标) |
| `aml_model_promote` | 发起阶段晋升(lead 专属;内部走人工审批) |
| `aml_model_reference` | 查询生产模型的影子参考(调参 what-if,拟议参数经 `controls` 传入) |

这 10 个是**宿主工具**,定义在 `.AgentWorkShop/prompts/host-tools.json`(宿主工具面共 48 条),
与 MCP 面(`server/mcp/workshop-server.ts`,25 个进程内工具)是两套不同的表面。

内置团队 **`team-aml-shadow`**(「AML 影子建模团队」):1 名 lead(首席数据科学家)+ 3 名
worker(数据工程师 / 训练工程师 / 评测工程师),默认 harness `omp`;从团队创建实例时先加成员。
团队作业手册见 `.AgentWorkShop/prompts/aml-playbook.md`。

## Python 运行时

首次训练自动探测 uv 与 Python,并在 `./aml/.venv` 供给锁定依赖(`aml/python/requirements.txt`)——
只有这一阶段联网,可配 `aml.python.indexUrl` 换镜像。`/aml` 页「运行环境」面板提供完整引导:

1. **uv 检测** —— 顺序:`aml.python.uvBin` 配置 > `./aml/tools`(平台装过的)>
   `./aml/runtime/uv.json` 记录 > 系统 PATH,来源随状态一并显示;
2. **一键安装 uv** —— 调官方安装脚本并令 `UV_INSTALL_DIR=./aml/tools`、`UV_NO_MODIFY_PATH=1`,
   不改系统 PATH、不需要管理员;失败自动回退 `python -m pip install --target ./aml/tools uv`;
3. **创建/重建训练环境** —— 有 uv 走 `uv venv` + `uv pip install`,无 uv 回退 `python -m venv`;
   环境就绪以 marker 文件为准,依赖或镜像变更即视为需重建;
4. **重新检测** —— 手工装好 uv/Python 后免重启生效;
5. **元数据↔实体对账** —— 见上文 REST 树,孤儿实体可一键清理。

无 Python 时作业报 `AML_PYTHON_MISSING` 指引;`AML_STUB=1` 启动可用存根运行器走通全链路
(存根模型不可预测,晋升被深检拦截)。

## 门禁 G1–G5

| 门禁 | 判据 | 默认阈值 | 设置键 |
|---|---|---|---|
| G1 | 单步 NRMSE | ≤ 0.10 | `aml.gates.nrmse` |
| G2 | 多步滚动 NRMSE | ≤ 0.25 | `aml.gates.rolloutNrmse` |
| G3 | 泛化差 `\|test−val\|/val` | ≤ 20% | `aml.gates.valTestGap` |
| G4 | 训练行数 / 批次数 | ≥ 500 行、≥ 3 批次 | `aml.gates.minRows` / `aml.gates.minRuns` |
| G5 | 工件完整性 | ONNX + io_spec 齐备 | — |

权威指标由平台评估器复算,不采信 Agent 自报;全部阈值 `live` 可调。

## 治理与安全边界

- 训练代码仅运行在作业工作区(`./aml/jobs/<id>/workspace/`),平台以独立子进程执行,
  墙钟 / 停摆 / 并发三重限制,杀树回收;
- 数据集节点集 ⊆ Agent 的 daq 绑定(只缩不放);REST 侧走产线 line grants;
- 全部副作用过 `recordOps`(audit_log + ops.log 实时帧),Agent 行为归属「Channel/成员」;
- SQL 全参数绑定,工作区路径收敛校验;删除保护保住模型工件的可复现性溯源。

## 相关页面

- [多 Harness Agent 团队](/guide/multi-harness) —— 内置 AML 团队的 harness 选择与能力面
- [配置系统](/guide/configuration) —— `aml.*` 16 键所处的描述符体系与生效方式
- [产线级权限](/guide/line-permissions) —— 数据集读取与模型晋升的授权口径

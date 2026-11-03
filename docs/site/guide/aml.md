# AML 自动建模(Agent 驱动的拟合与影子孪生)

模块代号 `aml`(Auto Modeling Lab):在 MAS 镜像数采与时序库之上,由**内置深度学习专家团队**
自主完成「拉数 → 清洗 → 训练 → 平台评测 → 门禁迭代 → HITL 晋升 → 影子参考」全链路。

```
拉数(隔离三元组) → 自动清洗 → 写代码训练 → 平台权威评测
  → 门禁迭代 → HITL 晋升 → 影子模型参考
```

调控 Agent 调参前经 `aml_model_reference` 查询生产模型,拿到「拟议参数 → 预测输出轨迹」的
影子参考(数字孪生 / MPC 前置);REST 侧对应 `POST /api/workshop/aml/models/:id/predict`。
完整手册(含文献映射与 ADR)见仓库 [docs/aml.md](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/aml.md)。

## 资产根

AML 的产物(数据集数组、作业工作区、ONNX 工件、uv 虚拟环境)收敛在**配置根内的 `aml/` 子目录**——
资产与运行时状态同根,`aw update`、更换检出都不会丢模型与 venv;整个目录可拷贝、可删除重建:

| 优先级 | 条件 | 资产根 |
|---|---|---|
| ① | `AW_AML_DIR` 已设置 | 该目录(显式覆盖,优先级最高) |
| ② | 检出内运行(`AW_MODE` 不为 `home`) | `<检出配置根>/.AgentWorkShop/aml` |
| ③ | 其余(home 模式 / 全局安装) | `<awHome>/aml`——`AW_HOME` 可重定向,**不是**写死 `~/.AgentWorkShop` |

目录骨架:

```
aml/
  .venv/            uv 创建/管理的 Python 环境(依赖锁定在 aml/python/requirements.txt)
  datasets/<id>/    spec.json 取数规格 · manifest.json 列定义 · report.json 质量报告 · arrays/*.f32
  jobs/<id>/        job.json 提交契约 · workspace/(train.py+amlkit.py) · run.log · artifacts/
  models/<id>/      model.onnx + io_spec.json(输入输出契约,不可变)
  twins/            混合孪生工件(冻结场景 / 编译 PhysicsSpec / 试验与证书)
  runtime/          uv.json(一键安装记录)/ env.json
  tools/            平台自动安装的 uv 二进制(免管理员、不改系统 PATH)
```

`GET /api/workshop/aml/env` 返回实际生效路径与来源,UI「运行环境」面板直接展示。

## 设置(aml 组,19 项)

设置页「运行配置」的 `aml` 组共 **19 个描述符**:阈值与配额类键为 `live`(保存即生效),
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

## Agent 工具(14 个)

| 工具 | 作用 |
|---|---|
| `aml_node_catalog` | 盘点可建模资产(节点语义 × 近 24h 数据量) |
| `aml_dataset_build` | 构建数据集快照(隔离三元组 + 清洗 + beatMs 对齐 + 滑窗切分) |
| `aml_dataset_stats` | 数据集统计报告(控制→目标滞后互相关 / 相关 / 逐 run 轮廓) |
| `aml_job_submit` | 提交训练作业(可内联 train.py 代码;`hybrid_residual` 作业可不带代码,走内置参考训练器) |
| `aml_job_status` | 作业状态快照 |
| `aml_job_logs` | 作业日志(排错) |
| `aml_job_cancel` | 取消作业 |
| `aml_leaderboard` | 排行榜(谱系 + 门禁明细 + 主指标) |
| `aml_model_find` | 按场景语义选型(line/objective/关键词过滤注册表模型) |
| `aml_model_promote` | 发起阶段晋升(lead 专属;内部走人工审批) |
| `aml_model_reference` | 查询生产模型的影子参考(调参 what-if,拟议参数经 `controls` 传入) |
| `aml_training_plan_list` | 列出建模任务(自动策略按新数据自动修正训练) |
| `aml_training_plan_create` | 创建建模任务(场景 + 配方 + 目标 + 自动策略) |
| `aml_training_plan_train` | 立即触发一次建模任务的训练 |

这 14 个是**宿主工具**,定义在 `.AgentWorkShop/prompts/host-tools.json`(宿主工具面共 108 条),
与 MCP 面(`server/mcp/workshop-server.ts`,25 个进程内工具)是两套不同的表面。
模型带人读身份:`label`(产线 · 配方 · 目标)+ `description` + `line_id`/`objective_id`。

## 混合孪生 × MPC(channel profile `hybrid_twin`)

AML 还承载**混合孪生**平面:灰箱物理主干 + 有界 PyTorch 残差,外挂
`SceneContract` / `PhysicsModelManifest` / `TwinSnapshot` / `ObjectiveProfile` /
`VirtualTrial` / `RecommendationCertificate` 六类契约。Channel 通过 profile 显式启用
(`legacy` 默认 / `hybrid_twin` 启用),启用后按 profile 注入 12 个专属工具
(`twin_calibration_request` 为通用工具,双 profile 可见):

| 工具 | 作用 |
|---|---|
| `twin_provider_catalog` | 读取已注册的 Provider / ScenePack / SolverAdapter 及其 generation 与 health(只读) |
| `twin_scene_discover` | 读当前 Agent **已绑定的 DAQ/DCW 节点**,推断 control/state/disturbance/target/guard 语义并给出证据与置信度 |
| `twin_scene_compile` | 依绑定节点与场景提示词生成 **SceneContract Draft**(默认 draft,上线前须用户确认) |
| `twin_scene_freeze` | 用户确认后**冻结**场景契约(同一 `scene_id`/`version` 不可覆盖,变更须新建版本) |
| `twin_physics_spec_draft` | 按冻结场景自动起草**骨架 PhysicsSpec**(每个状态一条一阶弛豫方程,τ/增益为带先验盒的可校准参数) |
| `twin_physics_spec_validate` | 校验声明式物理模型的**白名单 AST / 变量参数引用 / 单位 / 边界 / 稳定性 / 单调性**,禁止任意代码执行 |
| `twin_physics_spec_compile` | 把已冻结场景的 **PhysicsSpec 编译为隔离的 Generic Declarative Provider 候选**并保存 artifact(不注册 production、不写 PLC) |
| `twin_scene_read` | 读取场景契约(设备/信号/约束/目标) |
| `twin_snapshot_create` | 生成 TwinSnapshot(含新鲜度;过期 → `SNAPSHOT_STALE`) |
| `twin_trial_run` | 跑虚拟试验:全轨迹硬约束拒绝不安全候选,`candidateExecuted=false` |
| `mpc_optimize` | MPC 寻优(服务端策略 `safe_small_step` / `precise_search`) |
| `twin_gate_evaluate` | 门禁与收益评估;通过才签发 RecommendationCertificate |
| `twin_calibration_request` | 持续校准登记(重复请求在 cooldown 内去重拒绝) |

> 说明:Profile 注入的孪生工具**按 profile 门控**(`legacy` 频道不注入)。上表是 `hybrid_twin` 频道的完整孪生面;
> 「声明式物理模型(PhysicsSpec)」的协议与校验见 `docs/aml-agent-auto-twin-builder-plan.md` §4.3/§6。

默认即**推荐模式**:数据不足 → `safe_small_step`;模型过门禁 → `precise_search`;
证书未签发前不产生真实 DCW 写入。计划与验收记录见
`docs/aml-hybrid-twin-mpc-integration-plan.md`、`docs/aml-hybrid-twin-implementation-acceptance.md`。

**闭环连线**(v0.7.47):

1. `twin_snapshot_create` 可 `auto_daq: true` 按 Agent 的**真实 DAQ 绑定**逐节点取样;
   场景契约的 `observations` / `states` 必须带 `nodeId` —— 内置默认场景不带,请用
   `scene_json` 注入,否则水位为 0(`watermark=0`),工具会直接给出可执行诊断而不是只回 `fresh=false`。
2. `twin_trial_run` 只接受 `twin_snapshot_create` 产出的快照工件全文(缺 `snapshotId` /
   `dataQuality` / `snapshotHash` 直接拒绝),执行结果永远是 `candidateExecuted=false`。
3. `twin_gate_evaluate` 传入 `model_id` 时,会把 12 项判据结论回写成该模型的
   `twinEligibility`(`gatePassed` / `recommendationEligible` / `uqPassed` / `oodPassed` / `physicsPassed`);
   `mpc_optimize` 据此把服务端策略从 `safe_small_step` 升档到 `precise_search`——
   也就是「训练出的 AML 模型真正进入孪生闭环」的那一步,但仍不直接写 DCW。
4. 硬约束评估是**失败关闭**:`constraints[].id` 必须能映射到轨迹观测量/守卫量
   (`weight` / `flash_rate` / `sink_rate` / `melt_temperature` / `cavity_pressure` / `pressure` / `temperature`),
   映射不到的 id 与空轨迹一律判为**不通过**并给出 `无法映射到观测量/守卫量` 明细。
   v0.7.47 及更早对此类 id 直接跳过并返回「全轨迹通过」,会让 `scene_json` 里写错 id 的调用方
   拿到假的约束通过结论(被真实 Agent 团队抓出:预测克重 30.3 g 低于窗口下界仍报通过)。

**场景不再写死在工具里**:物理主干 / 场景包 / 目标 / 求解器都可以由插件通过 `ctx.twin` 注册进
**Twin Provider Registry**,孪生工具按 `SceneContract.physicsProfileId` 解析(解析不到回退内置
`twin-injection-default`)。热重载按 generation 装载新代、排空旧代,在飞试验与 MPC 持租约不被作废。
清单字段、生命周期与最小示例见 [插件开发指南 → 混合孪生 Provider 插件](/plugins/guide)。

### 任意场景建模闭环(v0.7.50)

闭环不再绑定内置场景,任何一条绑定过节点的产线都能走完「建模 → 门禁 → 投用」:

1. `twin_scene_discover` 带证据推断语义 → `twin_scene_compile` 生成 SceneContract draft →
   您确认 → `twin_scene_freeze` 冻结(版本不可覆盖);
2. `twin_physics_spec_draft` 起草骨架 PhysicsSpec → 您按真实工况润色方程 →
   `twin_physics_spec_validate` / `twin_physics_spec_compile`(白名单 AST,禁任意代码);
3. `aml_job_submit { job_kind: 'hybrid_residual' }` **可不带代码**:内置参考训练器执行
   A→B→D 协议 —— 物理参数校准(stage A)→ 3 成员有界残差集成(stage B)→
   conformal q90 覆盖率(stage D);校准后的 θ 回写 manifest 内嵌 spec,评估/预测/试验三侧同源;
4. `twin_trial_run` / `mpc_optimize` 传 `model_id` 即由训练出的 hybrid 模型驱动 rollout
   (`ModelBackedHybridProvider`),UQ 覆盖率与成员分歧来自训练工件;模型数据集与场景的
   line/product/recipe 不一致直接拒绝(`TWIN_MODEL_SCENE_MISMATCH`,配方隔离);
5. `twin_calibration_request` 登记的信号由 **60s 持续校准 worker** 消费,自动提交重训
   **候选**;只产 candidate,晋升仍走 HITL + Twin Gate(`AML_TWIN_WORKER_DISABLED=1` 可关闭)。

### 双模式优化通道模板(v0.7.50)

两个内置模板把「训练」与「优化」拆成**互斥的两个频道**,边训边优在结构上不可能:

| 模板 | 工具面 | 能做什么 |
|---|---|---|
| `chtpl-aml-training-default` | 建模面(22 工具):数据集 / 作业 / 场景编译 / 物理 spec / 建模任务 | 训练与评估;**无产线写入、无 MPC** |
| `chtpl-aml-optimization-default` | 执行面(6 工具):快照 / 试验 / 门禁 / MPC / `twin_bayes_optimize` / `optimization_explore` | 寻优与微调;**无训练族工具** |

优化频道实例化时选 `optimizationMode`:**exploration**(治理小步微写,每笔写入与响应回读配对
落 `optimization_explorations` 台账,无需模型)或 **aml**(`boundModelId` 必填——过门禁的模型
先绑定,执行面才解锁)。

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

## 门禁 G1–G6

| 门禁 | 判据 | 默认阈值 | 设置键 |
|---|---|---|---|
| G1 | 单步 NRMSE | ≤ 0.10 | `aml.gates.nrmse` |
| G2 | 多步滚动 NRMSE | ≤ 0.25 | `aml.gates.rolloutNrmse` |
| G3 | 泛化差 `\|test−val\|/val` | ≤ 20% | `aml.gates.valTestGap` |
| G4 | 训练行数 / 批次数 | ≥ 500 行、≥ 3 批次 | `aml.gates.minRows` / `aml.gates.minRuns` |
| G5 | 工件完整性 | ONNX + io_spec 齐备 | — |
| G6 | 动作覆盖(控制水平数 / 时间共线) | ≥ 3 水平、\|r\| ≤ 0.9 | `aml.gates.minControlLevels` / `aml.gates.maxCollinearity` |

G6 回答"这份数据在动作维度有没有信息量":水平数 <3 无法区分线性/二次;控制量与时间推进
共线(纯阶梯/单调斜坡)则"效应"可能只是漂移。**2 水平的 \|r\| 理论上限仅 0.866**,因此
G6 另用"水平连续段"判据:每档只出现一段即判不可归因,要求 ≥2 个来回(ABAB)。
v1 旧数据集无该字段时标 unknown 放行(不追溯误杀)。

权威指标由平台评估器复算,不采信 Agent 自报;全部阈值 `live` 可调。

## 科学探索闭环(可辨识性 / 干预台账 / DoE / 本体证据)

预测精度 ≠ 因果可辨识。平台在 AML 之上提供一条**可证伪的探索闭环**:

| 环节 | 机制 | 落点 |
|---|---|---|
| 可辨识性预检 | 主导扰动周期(自相关)、建议试验窗 = 3×周期、bootstrap CI、MDE、共线诊断;输出 `IDENTIFIABLE / UNDERPOWERED / CONFOUNDED / INSUFFICIENT_DATA` | `aml/identifiability.ts`;工具 `daq_identifiability` |
| 干预台账 | **每一次已受理下发**(手动/Agent/配方/回退)在 DCW 写咽喉单点入行:意图值/实写值/回读证实/路径/依据 + 判定 | 表 `intervention_events`;工具 `intervention_history` |
| 正交 DoE | 试验计划分级:仿真线直接执行;真实线需 HITL 单卡批准(卡上含成本核算),步序默认随机化(种子=计划 id)、跨控制量打散,支持告警中止与预算上限 | `process_model_experiments` + `experiment-runner.ts` |
| 双通道互审 | 模型通道(ARX 阶跃仿真增益)vs 本体通道(actuator→target 耦合边);确证冲突 → `optimization_explore` 在 auto 模式直接拒(带可证伪说明),manual 交审批卡;unknown 不拦 | `aml/twin/cross-check.ts` + `cross-check-service.ts`(逃生门 `AW_CROSSCHECK_GATE=0`) |
| 本体证据回灌 | 判定(效应/CI/MDE/负结论)追加到 `ontology_evidence`,可追溯、幂等;负结论计 refute | `aml/ontology-learning.ts` |
| KB 防污染 | 入库审批卡标注"无证据锚的因果断言(anecdotal)"并留审计 | `agents/plugin-governance.ts` |

关键语义:**窗口充分的零结果 = 可辨识的负结论**(可入库、可证伪),不是失败;只有窗长/覆盖
不足才判 `UNDERPOWERED`,且此时**不得**声称有效应。

上线安全约束(计划批准后执行器以平台身份直写,故全部前移):

- 真实线计划**创建与执行双重校验**节点归属:跨线、节点不存在、targets 非 DAQ、水平越安全量程 → 422;
- 运行中**可取消**(每步前感知),已执行步的台账与证据保留;
- 真实线每步驻留 **≥60s**(与写联锁同口径),避免第 2 步被 429 打回白跑产线时间;
- 僵死 `running` 超预算 +5min 自动置 failed,可重建计划;
- 逃生门:`AW_IDENT_GATE=0`(可辨识性门禁)、`AW_CROSSCHECK_GATE=0`(互审强制);关闭即回到旧行为,风险自负。

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

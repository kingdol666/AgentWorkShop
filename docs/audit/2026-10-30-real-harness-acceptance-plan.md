# 真实 harness 全链路功能验收规范（R0–R7）

> 日期：2026-10-30。范围：Channel 任务中 Agent 对**数采/数控/AML/求解器/本体**五类能力的真实使用，
> HITL 真实审批、数采真实抓数、数控真实下发与任务调优。真实模型 = LM Studio
> `qwen3.5-9b-64k`（65536 上下文，`lms ps` 已核实），经 omp harness（rpc 模式 + 运行级 overlay）接入。
> 判据全部可证伪；负向断言（拒绝/门控）同为资产。主套件：`scripts/e2e-real-channel-mission.mjs`。

## R0 · 环境与实例
- 隔离实例：port 3423，`AW_MODE=home AW_HOME=D:/tmp/aw-rhacc-20261030`（生产构建 .output），admin 注册成功。
- 隔离模拟器：port 4038（影子树），cast-film-physics 预设，四协议设备端点在线（≥5 running）。
- 判据：实例 health workshop=ready；模拟器 /api/nodes running 设备 ≥5。

## R1 · 五能力工具面在册（静态）
- 数采：`daq_query`、`daq_frames`；数控治理：`optimization_explore`、`dcw_judge`、`dcw_journal`、`dcw_rollback`；
  AML 优化面：`twin_snapshot_create`/`twin_trial_run`/`mpc_optimize`/`twin_gate_evaluate`/`twin_bayes_optimize`；
  AML 训练面：`aml_dataset_build`/`aml_job_submit`/`aml_model_find` 等 22 项；求解器：`optimizer_capabilities/solve/status/cancel/plan_get`。
- 判据：GET /api/workshop/agent-tools/list 在 aml_optimization 频道上含上述优化面+求解器族；
  工具注册表（/api/workshop/tools）available=true。

## R2 · 数采真实抓数（LLM 任务）
- 任务（窄工具面：daq_query+complete_task）：「调用 daq_query 读节点 X 最近 3 分钟，汇报样本数与最新值」。
- 判据：任务历史含 🔧daq_query 调用；交付文本含数值；**该数值与模拟器设备信号真值一致（±3℃）**；
  终态 COMPLETED 或证据收口 cancel。

## R3 · HITL 真实审批（批准前后设备双时点对照）
- dcw 绑定恒 manual（服务端缺省）→ LLM 任务调用 `optimization_explore`（direction/step 在任务文中显式给出）→ 写被 HITL 挂起。
- 判据（四点）：
  1. 挂起后 20s 内设备寄存器值**不变**（批准前不变点）；
  2. /agent-tools/approvals 出现 pending 卡（含工具名与参数）；
  3. REST `POST /agent-tools/approvals/:id/decide {approved:true}` 200；
  4. 批准后 60s 内设备寄存器值 = 旧 SP + step（±0.5）——**审批后真实下发到设备**。

## R4 · 数控真实下发 + 任务调优（LLM 任务）
- auto 绑定；任务（窄面：daq_query+optimization_explore+complete_task）：
  读 PV → 按文中给定的方向与步长 explore（settle_seconds=10）→ 复读 PV → 判定是否入目标带，未入带按偏差修正一次 → complete_task 汇报。
- 判据：任务 COMPLETED（或证据收口）；设备 SP 真值落点 = 基线+步长（±0.75）；
  DAQ PV 随动（写后窗内样本均值向新 SP 收敛）；`dcw_journal` 含 Agent 归因锚；
  /dcw/optimizations 出现本节点 open→判定记录链。

## R5 · AML 面 + 求解器门控
- 训练面：实例化 `chtpl-aml-training-default` 频道，Agent 令牌直调 `aml_model_find` → 非 error（模型清单可为空）。
- 求解器：aml_optimization 频道 + 有效绑定 → `optimizer_capabilities` 非 error；
  `optimizer_solve` 无合格 Profile 时按资格门拒绝（负向断言，错误码可读）。
- 判据：以上三调用回包形状符合契约。

## R6 · 本体语义可供 Agent 使用
- 节点工艺描述（本体派生回填）出现在 Agent 注入面：`my_industrial_nodes` 文本含节点 desc/工艺描述与量纲；
  `line_context` 文本含产线语义行。
- 判据：两文本断言非空且含中文工艺描述样本；另跑 `e2e-ontology.mjs`（离线服务层全流程）本轮 0 失败佐证。

## R7 · 已验证真机套件本轮复跑佐证
- `e2e-binding-modes-real.mjs`（授权面×真实协议，19 断言）本轮 PASS；
- `e2e-mes-mirror-real.mjs`（MES 镜像数采 + Q1 真模型抓数，17 断言）本轮 PASS。

## 未覆盖面（如实声明）
- `optimizer_solve` 正向求解（需先训练 AML 模型→资格门→Profile 绑定全链）：由 `e2e-optimizer-live.mjs`（104 断言）覆盖，本轮不重跑。
- AML 全训练链（数据集→作业→门禁→投用）：由 `e2e-model-loop-live.mjs`（54 断言）覆盖，本轮不重跑。
- 本体真机 UI 六 tab 走查：由 `e2e-ontology-live.mjs`（87 断言）覆盖，本轮不重跑。

## 证据约定
- 主套件证据：`docs/audit/evidence/2026-10-30-real-channel-mission/report.json`（逐断言 id/pass/detail）。
- 佐证套件刷新各自证据目录；本规范与验收报告 `docs/audit/2026-10-30-real-harness-acceptance-report.md` 收口。

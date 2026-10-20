# 真实作业场景总验收报告（2026-10-20）

> 范围：PLC 模拟器启动 + 数据分析 + 闭环优化 + IDD/RAG 数据处理 + 产线稳定性优化 + 数字孪生训练/虚拟模型。
> 方法：隔离平台 `127.0.0.1:3470` + 专用模拟器影子实例 `4050`（注塑线）与 `4051`（cast-film 数字孪生线）；不写 3001/3021，不写受保护线 `ln-d7e0a2a2`。
> 证据目录：`docs/audit/2026-10-20-scenario-suite-evidence/`。

## 0. 结论摘要

| 故事 | 场景 | 结果 | 关键证据 |
|---|---|---|---|
| US-001 | 专用 PLC 模拟器 + 隔离平台 + 注塑线 | PASS | 5 设备五协议 running；产线 active，11 DCW/14 DAQ，11363 打标样本 |
| US-002 | 真实数据分析 | PASS | daq_query 289 点；原始复算 mean=32.222g/std=0.059g；报告 `ar-34ed3510` 含时间窗/来源/置信口径 |
| US-003 | 闭环优化 | PASS 9/9 | 45→50→55→60→65bar；5 次 trial HITL + 1 次 update HITL；克重 31.30→32.31g；recipe v2 |
| US-004 | 产线稳定性优化 | PASS 9/9 | 两轮 ±1.8bar（stepLimit=1.8），HITL `ap-27e8df86`/`ap-e6a5f43b`；末次写入后 60s 窗口 12/12 在窗，std=0.023 |
| US-005 | IDD × RAG | PASS | export 14 节点/6814 行；run 1837d21f completed；报告 16KB；RAG 入库 26 chunks；kb_agent 唯一命中 |
| US-006 | 数字孪生训练/虚拟模型/下发 | PARTIAL | 服务级真实训练 + 模型驱动 VirtualTrial PASS；平台 cast-film 训练门禁失败（NRMSE 0.60），模型未投用、无模型驱动下发（§6） |
| US-007 | 回归/复核/提交 | 见 §7 | 见回归日志与提交号 |

## 1. US-001 环境与连接

- 模拟器 4050：5 台设备 `modbus-tcp / modbus-rtu / opcua / mqtt / http` 全部 running；PV tick 活性通过。
- 平台 3470：fresh home，首个注册用户 admin；`tool_registry` / 插件宿主正常。
- 产线：`ln-90c5f9f9`（注塑成型质量窗口寻优 injection-s8c46），11 DCW + 14 DAQ，配方 `rc-b598f102` v2，active run。
- 证据：`US-001-environment.json`。

## 2. US-002 数据分析

- analyst agent token 调 `daq_query`（5 分钟窗，1s 桶）返回 289 点；原始 samples 独立复算 mean=32.2219g、std=0.0592g、min=32.08、max=32.37、窗内 268/289。
- `analysis_save` 报告 `ar-34ed3510`，含 `window_from/window_to`、节点来源、结论与置信口径；`analysis_query` 可检索。
- 边界：报告如实记录 21 点低于 32.15g；不写产线。

## 3. US-003 闭环优化

- 基线 45bar/6s，克重 31.30g、缩痕 2.085%。
- 逐级 +5bar 试验；每轮 `recipe_trial` 先挂 HITL，批准后整批下发并设备回读；65bar 时克重 32.31g、飞边 0%、缩痕 1.336%、熔温 246.6℃，入窗。
- `recipe_update` 固化 v2（65bar/6s），HITL `ap-0ce565bd` approved；回读一致。
- 证据：`US-003-closed-loop.json`、`bench/results/injection-pressure-loop-2026-10-20T15-41-36-066Z/summary.json`。
- 边界：测试实例设置 `AW_TRIAL_INTERVAL_MS=0`（生产默认 5 分钟；启动告警保留）。

## 4. US-004 稳定性优化

- 基线 63.2bar：19 点 mean=32.197g/std=0.0231g，全部在窗。
- 第 1 轮 63.2→65.0（Δ=1.8，stepLimit=1.8），HITL `ap-27e8df86`，复测 14 点 mean=32.297/std=0.0257 全在窗。
- 第 2 轮 65.0→63.2（Δ=1.8），HITL `ap-e6a5f43b`，复测 13 点 mean=32.203/std=0.0139 全在窗。
- 最终窗口从末次写入 +65s 后开始：12 点 mean=32.203/std=0.0228，12/12 在窗；未触发劣化回退（`degraded=false`）。
- 证据：`US-004-stability.json`。
- 说明：首轮 HITL 卡片的结构化候选行仍显示“65→65bar”（from 取配方基线 65），实际写入 from→to=63.2→65 记录在假设行与 `dcw-writes`/审计日志；这是产品层 `recipe_trial` 的显示/校验残留风险，不影响本轮实际写入与判据。

## 5. US-005 IDD × RAG

- diag/rag 插件 health：token accepted=true，IDD remote ok，KB `aw-industrial`。
- `daq_export`：14 节点、6814 行、merged.csv 569 行；export `daqexp-20261020234422-67a9ec`。
- `diag_run(quick-screen, export_id)` → run `1837d21f`；26 次轮询后 `completed`，报告 `report.md` 16,074B：
  - 601 行/12 通道；克重 368/601 低于 32.15g；缩痕 320/601 超 1.5%；cycle-time 569 点恒 15.3s；8s 全通道缺采；101 条告警（high 71/warn 30）。
- `kb_agent(mode=async)` 入库完成：doc `f6b14701-...`，26 chunks，标签 US-005；`kb_agent` 只读检索唯一命中。
- 保留项：IDD run 目录 `run_manifest.json` 仍显示 initialized/部分步骤 pending，与 tasks 面 completed 不一致；报告与入库真实，manifest 收尾差异记录在证据中。
- 证据：`US-005-idd-rag.json`。

## 6. US-006 数字孪生训练 / 虚拟模型 / 下发

### 6.1 已完成（真实运行）

- `scripts/acceptance-aml-hybrid-e2e.ts` 真实 Python 训练：
  - stage A 物理校准 err 1.3649→0.1642；θ(tau=1.7159, offset=31.1954, gain=1.7407)
  - stage B 3 成员残差集成；stage D conformal coverage=0.9
  - 工件 model.onnx/model-2/model-3/hybrid_manifest/physics_parameters 均存在
  - 平台门禁 G1-G5 PASS；模型 `mdl-e2e-hybrid-1` 注册并晋升 shadow
  - 10 个候选 VirtualTrial 全部 model-backed rollout，`candidateExecuted=false`
  - Twin Gate 12 判据全通过；残差可测 |Δtemp|=5.4528；跨配方复用被拒
- 证据：`US-006-training.log`（ALL PASS aml-hybrid-e2e）。

### 6.2 平台级 cast-film 模型训练（负结果，如实记录）

- 在独立 cast-film 影子线 `ln-723e751c`（模拟器 4051）上完成 3 批次真实采样，构建数据集 `ds-mvgwmv59-axub01`（658 窗），提交平台真实训练 `job-mvgwry72-c356do`（`hybrid_residual`）。
- 训练产出了 3 个 ONNX 成员、`hybrid_manifest.json`、`physics_parameters.json`；但平台门禁未通过：
  - oneStepVal NRMSE **0.6035**；oneStepTest NRMSE **0.5589**；rollout NRMSE **0.8091**
  - coverage 0.896（目标 0.9）
  - 作业状态 **failed**，模型未注册、未晋升 shadow。
- 根因：为压缩验收窗口把每批采样从 500s 降到 240s，膜厚在采样窗内基本恒定（日志多次 56.60μm），激励不足以辨识膜厚响应；不是靠放宽门禁能解决的。
- 结论：US-006 的平台级“模型推荐→治理下发”**未完成**；不以 US-003 的独立闭环冒充。服务级真实训练/虚拟模型链通过（§6.1），独立治理写链通过（US-003）。
- 证据：`US-006-platform-live.log`、`US-006-platform-live-metrics.json`、`US-006-platform-live.json`。

## 7. US-007 回归/复核/提交

- `npm run test:unit`：283/283 PASS（日志 `regression-unit.log`）
- `npm run test:e2e-line`：44/44 PASS（日志 `regression-e2e-line.log`）
- `npm run test:mcp`：14/14 PASS（日志 `regression-mcp.log`）
- `npm run typecheck`：PASS（日志 `regression-typecheck.log`）
- `npm run build`：PASS（日志 `regression-build.log`）
- 独立 reviewer 首轮：REJECTED（stepLimit 违规/证据不一致/US-006 模型驱动下发缺失）；本报告对应整改项见 §8。
- 独立 reviewer 第二轮：**CONDITIONAL**。US-002/003/004/005 PASS；US-001 因 3470 曾被 supervisor 重启、停止声明与事实不符而 PARTIAL（已连同 supervisor 终止并复核端口无监听）；US-006 FAIL/PARTIAL（平台 cast-film 训练门禁失败，模型未注册、无模型驱动下发）；US-007 只差限定 pathspec 提交与 push。
- 提交：见文末 commit（提交后回填）。

## 8. 首轮 reviewer 整改对照

| # | 拒绝项 | 整改 |
|---|---|---|
| 1 | US-004 第二轮 65→63.2 实际 3.6bar 超 stepLimit 1.8 | 已改为每轮从当前实际值计算，两轮均 Δ=1.8；HITL 假设行记录实际 from→to（结构化候选行仍取配方基线，已在 §4 披露）；最终窗口从末次写入后 65s 起算；9/9 PASS |
| 2 | US-002 报告/指标/查询三者不一致 | 新报告 `ar-34ed3510` 含 window_from/to、来源、置信口径；证据只引用该报告与同窗指标；旧汇总已删除 |
| 3 | US-005 终态/检索证据不足 | 补 diag_run 提交响应、completed、report.md、kb_agent 26 chunks 唯一命中；记录 run_manifest 差异 |
| 4 | US-006 模型未进平台、无模型驱动下发 | 启动平台级 live AML（§6.2）；若未完成如实标 PARTIAL |
| 5 | US-007 无回归日志/报告/提交 | 本报告 + 回归日志 + 限定 pathspec 提交（待回填） |
| 6 | setup 旧汇总 `pass:23` 不可信 | 删除旧汇总；US-001/002 使用逐项证据 |
| 7 | 进程未停止 | 初次停止后 3470 被 start.mjs supervisor 重启；已连同 supervisor 终止，复核 3470/4050/4051 均无监听（`US-001-environment.json.processesStopped` 已按实际时间更正） |

## 9. 边界

- 模拟器为教学级灰箱，不是物理保真；所有结论只对该模拟工况成立。
- US-003 测试实例关闭了试验节拍（`AW_TRIAL_INTERVAL_MS=0`），生产默认 5 分钟。
- IDD 报告使用冷启动 self 基线，C2/C4 有降级披露；不能当长期基线结论。
- US-006 训练验收使用平台参考训练器的合成工况；平台级注塑模型训练状态见 §6.2，不夸大。
- 未做真实 PLC/MES 割接；未做 Mimosa 完整安全审计。

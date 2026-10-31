# 最新实验结果复核与论文证据报告

> 当前最新 OMP Channel 任务配置记录为 USTC/DeepSeek Flash，但验收 10/13、任务仍为 WORKING；不能作为完整成功。较早文档驱动模拟线受控范围通过，可支持接口接入、读取、导出和独立管理员写读回，不支持 Agent 写控制或多 Agent 协同。

## 总体判断

- 可作为论文工程集成证据：HTTP/MQTT 场景映射、标量/向量采集、lead 只读 Channel task、导出契约和分离的模拟写读回。
- 不足以证明：四 Agent 实际协作、Agent 发起的 27→25 写入、审批门消融、Harness/模型效应、工艺改善或实体设备可投运。
- A1/A2 仍为 NOT-RUN；最新 P12 资格虽通过，但工作流与证据完整性均失败。

## 文档驱动模拟线的完整步骤

1. 按虚拟接口说明定义 6 个信号：HTTP 箱体温度 PV/SP/回读/64 点壁厚向量，MQTT 环境温度/湿度。
2. 生成 blueprint 与 provision；新增 5 DAQ、1 DCW、产品/配方；供给检查 11/11，通过跨线冲突检查。
3. 建立 lead + 3 worker 配置的 Channel。执行证据只显示 lead wired，四个 harness 字段配置为 OMP；model/provider 未归档。
4. lead 执行一个只读任务并完成。结果检查了 5 个 acquisition streams，包括一个 64 点向量；没有在该 task 内写参数。
5. 独立管理员验收将 SP 写至 27 再恢复到 25；独立 DAQ 分别读到 27 和 25。一次较早请求因 60 s cooldown 被拒绝。写入与 task 无 actor/task/approval/driver 关联。
6. 导出检查 19/19：4 个标量 CSV 共 818 行，向量 CSV 为 54×64=3,456 点。CSV 中包括启动时 offline 行；完整性检查不代表每行都有效。

## T0–T4 最新系统回归

| 阶段 | 本轮实测 | 状态边界 |
|---|---|---|
| T0 静态门禁 | lint 修复后通过；typecheck、docs、i18n、README 检查通过 | 首轮 5 个既有 lint 错误已修复并复跑 |
| T1 单元/契约 | unit 915：913 pass、0 fail、2 skipped；MCP 14/14；plugin lifecycle 22/22；SDK surface pass；twin-provider 5/5；skills 147/147 | 仅为软件契约结果 |
| T2 核心闭环 | line-governance 44/44；文档驱动虚拟线限定验收通过 | 本体、优化器、UI 等重负载套件本轮未跑 |
| T3 API-live | fresh-instance 前置不满足，未获合格运行；其他 T3 未跑 | 不计为产品通过或失败 |
| T4 插件/工具 | 11 插件、0 failures；126/126 工具 available | 工具注册不等于每工具端到端执行 |

## 最新 OMP Channel 运行

- 记录时间：2026-10-30T19:37:13.903Z；证据目录记录 IDD/RAG episode。
- 配置：OMP Channel lead，配置/报告记为 USTC/DeepSeek Flash；provider/model runtime readback 未留存。
- 通过项：后端健康、配置/工业工具注册、任务启动、四类工具调用（daq_query、daq_export、diag_run、kb_agent）、诊断与 RAG 结果标记。
- 未通过项：插件启用确认、复用产线开跑、任务收口；最终 10/13，task state=WORKING，无 approval card、无完整写入链。

## 关键纠偏

- 10/30 Qwen run 的 R2.1 原标 PASS，但原始 report.json 记录 task CANCELED，交付数字与 DAQ 结果不符；脚本从整个 history 任取数字做近似比较，不能视为查询成功。
- 同一 report.json 支持 R3 的待审批 SP=195、脚本批准后 SP=198，以及 R4 的 SP=200.5；R4.2 原始 PV=199.45。接受报告中的 207.67/205.83、200.84 数字没有匹配原始 JSON。
- P12 最新完整 evidence bundle 为 qualification PASS、workflow FAIL、integrity FAIL；任务 CANCELED，0 个 verified approvals、0 个 accepted writes。不能列为成功 AgentTeam episode。
- A1/A2 runner 和 approval-only ablation 尚未资格化；doc-driven 和 IDD/RAG 运行不替代它们。

## 其他独立论文证据（不与最新集成任务合并）

- 五协议确定性矩阵：五种本地模拟协议、52 个采集样本、四种可写协议；24/24 越界探针被拒绝，LLM 关闭。
- 路由状态 fixture：注册任务路由与 direct REST 两场景共四次状态转换均有独立状态读回；管理员批准为合成刺激，无 Agent 候选选择和写后过程响应。
- 四个 2026-09-28 脚本模拟任务分别报告注塑 31.296→32.36 g、BOPET 28.03→25.30 μm、退火 134.9→99.5 HV、污水 DO 0.194→3.54 mg/L。每个场景只有一条轨迹，控制由脚本确定，不是 LLM 选择或复现实验。

## 原始 CSV 行核验

| 文件 | 行数 | min | max | 状态 |
|---|---:|---:|---:|---|
| nodes/dn-2441bc04.csv | 134 | 24.5 | 25.5 | offline=2, ok=132 |
| nodes/dn-2a0acb1f.csv | 275 | 50.0 | 60.0 | offline=2, ok=273 |
| nodes/dn-970e00ea.csv | 275 | 20.5 | 23.5 | offline=2, ok=273 |
| nodes/dn-ae545180.csv | 134 | 25.0 | 27.0 | offline=2, ok=132 |
| frames/dn-e4934f70.csv | 3456 | 2.475 | 2.525 | vector data |

## 论文适用性

文档驱动 run 适合用作系统配置/接入可行性的主工程案例，但需要与单次 OMP/Qwen 写入记录分开。没有重复试验、统计区间、传统控制器 baseline 或完整 A1/A2 消融；当前数据不足以支持控制性能优越性、多 Agent 协同效能、模型替代效果或真实产线部署结论。

## 证据

- 完整图文：report.html
- S5 结构化补充文件及原始 CSV：paper/tii/SUBMISSION-IEEE-TII/Supplementary-File-S5.pdf 与 Supplementary-File-S5-Evidence.zip
- 本地 source evidence: docs/audit/evidence/2026-10-31-doc-driven-full-acceptance/
- 最新任务: docs/audit/evidence/2026-10-31-idd-rag-integration/
- P12: bench/results/p12-20261030173217-8f6e4715-agentteam/

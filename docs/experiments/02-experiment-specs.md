# E1–E6 实验规格书（逐实验：假设 · 变量 · 流程 · 产出）

> 每个实验按 TII 审稿人预期组织：明确的假设（可证伪）、受控变量、对照臂、样本量、统计方法、预期图表。配置文件见 `bench/configs/`。

---

## E1 · 治理管线消融主对比（论文核心）

**假设（H1）**：完整治理管线（联锁 ∩ HITL ∩ 回读）相对于无治理直写，写控时延开销 <15%、token 开销 <10%，且越界写拦截率 0%→100%。
**H1b**：去掉回读校验后，注入的假成功写（模拟器侧值未变但 ACK 成功）捕获率从 100% 降至 0%。

**受控变量**：workload（W1/W3）、任务模板（T1–T4）、故障脚本、seed、harness。
**自变量**：governance ∈ {full, no-interlock, no-readback, no-hitl}。
**样本量**：4 臂 × 2 workload × 4 任务 × N=20 = 640 runs（mock）+ 4×1×4×N=10（真实 LLM 补充组，仅 full vs no-governance 两臂以省成本）。

**流程**（每 run）：
1. fixture 建产线（参数化 N 节点 × 5 协议）→ 开跑 → Agent 团队部署 → 节点绑定；
2. 按 T1–T4 顺序提交任务，故障按模板注入（T1/T2 注 F1，T2/T4 叠加 F5）；
3. 全程 decision_log + 写控耗时戳落库；任务结束后 teardown；
4. metrics.mjs 抽取指标 → 追加 metrics.csv。

**产出**：Table 1（主对比表：6 指标 × 4 臂 × CI）、Fig 3（x=自动段时延 p95+token，y=拦截率/回退正确率的权衡散点，4 臂 4 色）。
**预期叙事**：no-interlock 臂出现 N 次越界写成功（F5 直接命中量程外）；no-readback 臂假成功写全漏；no-hitl 臂时延最低但失控 Agent 无闸门；full 臂拦截满分、开销可控。

---

## E2 · 调度策略三臂对比

**假设（H2）**：多团队（teams=4）+ 动态目标（T5）下，LLM 调度 goal 成功率 > 规则引擎 ≥15 个百分点；hybrid 以 <30% 额外 token 达到 LLM 的 95% 水平。
**H2b**：单团队静态任务（T1）下三臂无显著差异（诚实呈现 LLM 的必要性边界——审稿人喜欢不夸大）。

**自变量**：scheduler ∈ {llm, rule, hybrid}；workload ∈ {W2, W3(teams=4)}。
**样本量**：3 臂 × 2 workload × 3 任务 × N=20 = 360 runs（mock）+ 真实 LLM 补充组（llm vs hybrid，N=10）。
**锚点**：rule 臂 = `lead.supervise=null`（已有代码路径，零改动）；hybrid 臂 = P3 开发项 D9。
**产出**：Table 2、Fig 4（goal_success_rate vs teams 曲线，三臂三线 + 误差带）。

---

## E3 · 记忆机制消融

**假设（H3）**：序列任务（T1→T3→T4→T1'，第二次 T1 复用同 channel）中，有记忆臂在 T1' 的收敛迭代数显著低于无记忆臂；rrf+mmr 相对 fts 有可测增益。
**自变量**：memory ∈ {none, fts, rrf, rrf+mmr}。
**关键设计**：记忆的价值只有在**任务间依赖**下才显现——T4 恢复任务天然依赖 T1 留下的参数史；T1' 直接检验"上次怎么调的"。
**样本量**：4 臂 × N=20 = 80 runs（mock，channel 内序列执行）。
**附加指标**：`memory_recall_precision`——注入查询探针（`search_memory` 工具直接调用），计算 top-5 命中相关记忆的比例（人工标注 50 条查询的相关集）。
**产出**：Table 3、Fig 5（四臂柱状 + CI）。

---

## E4 · 故障注入鲁棒性

**假设（H4）**：F3（断连 30s）、F4（乱序 5%/20%）、F6（TSDB 中断 60s）下数据完整性 ≥99.9%（TSDB 收到的样本序列 vs 模拟器发出序列的对账）；F5（越界写 ×50）在 full 治理下拦截率 100%；F1/F2 下 MTTR 有界且可测。
**设计**：7 个故障行 × N=20，每行独立（不叠加），W2 高频采样放大观测窗口。
**对账方法**：模拟器控制端口记录"应发帧序列"（D3 交付），与 Timescale `queryTagged` 结果对齐，差集即丢失/错序样本——这是论文里 data integrity 的硬证据。
**产出**：Table 4（7 行 × 5 指标）、Fig 5（F3/F6 恢复时间线：值序列 + 注入/恢复竖线 + 缓冲回灌段着色）。

---

## E5 · 自适应异常检测（算法主线，默认方案 A）

**假设（H5）**：EMA 基线 + CUSUM 漂移检测相对固定滞回+去抖（现状），检测延迟降低 ≥40%，误报率不显著上升（Mann-Whitney p>0.05）；耦合 Agent 诊断（`alarm_insights` 工具 → T2 任务）后端到端 MTTR 再降 ≥20%。
**数据双轨**：
- 轨 A（模拟器）：F1 漂移 k∈{1,2,3,5}×窗口，有 ground truth；
- 轨 B（公开数据集）：TEP 正常/故障工况 + SWaT 攻击场景，经回放 driver 进 DAQ（D12），与文献已发表检测方法同数据源可比——**这是把本实验从"自嗨"变成"学界对话"的关键**。
**检测臂**：threshold（纯阈值）/ hysteresis（现状 2%+3 拍）/ adaptive-ema-cusum（新）。
**样本量**：3 臂 × 3 数据源 × N=20。
**产出**：Table 5、Fig 6（检测延迟-误报率散点 + 文献参考线）。

---

## E6 · HIL 案例研究（+可选 Safe-BO）

**E6a HIL**：一台真实 OPC UA 设备（W5 采购：树莓派 + 工业温控模块，或二手西门子/汇川 PLC）。跑 T1/T2 各 N=10，报告：真机回读时延分布、治理管线行为与模拟器的一致性、一张带 Agent 干预标注的实测温度时间线图。**目的：消灭 simulation-only 弱点，非规模声明。**

**E6b Safe-BO（可选）**：T1 场景对比 `llm-direct`（LLM 直接给设定值）vs `safe-bo`（trust-region 步长 + 高斯代理 + 联锁硬约束投影）。指标：越界写次数（预期 0 vs >0）、收敛步数。若 3–4 周内做不完 GP 代理，降级为 trust-region + 线性/二次局部代理，仍可支撑"提议值有数学骨架"的叙事。

**产出**：Table 6、Fig 7（HIL 时间线）。

---

## 统计协议（全部实验通用）

1. 每配置 N≥20（mock）/ N≥10（真实 LLM），独立 seed；
2. 组间：Mann-Whitney U（双侧），多重比较用 Holm 校正；
3. 报告：中位数 + bootstrap 95% CI（1000 次），不用均值±sd（时延分布偏态）；
4. 每张表脚注：harness、模型版本、温度、prompt 哈希范围、日期、硬件（CPU/内存）；
5. 异常 run（进程崩溃/超时）：记录但不剔除，除非可归因于平台故障（记录剔除理由）；
6. 结果目录 `bench/results/<exp>/<config>/<timestamp>/` 永不覆盖，论文投稿时随复现包打包。

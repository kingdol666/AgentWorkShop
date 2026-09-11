# AgentWorkShop · IEEE TII 达标性评估与改进执行计划

> 评估日期：2026-09-09 · 评估基线：v0.7.26（源码全量梳理 + docs/audit 审计报告 + paper-show 投稿策略）
> 评估视角：IEEE TII 审稿人（创新性 / 实验完备性 / 算法先进性）+ 开发者（可落地性）

---

## 第一部分 · 系统现状综述（已读代码与文档的结论）

### 1.1 架构全景

系统为「双半边 + 一座桥」结构：

- **多智能体半边**：`AgentChannelManager`（内存注册表 + 生命周期）→ `SchedulerLoop`（1s tick + 事件唤醒的 lead 监督循环）→ `TaskEngine`（7 态任务状态机）→ `AgentRuntime × N`（6 种 harness：mock / omp / codex / dsh / opencode / claude SDK）。持久记忆 `AgentMemory`（FTS5 CJK 切分 + 可选向量，RRF 融合，MMR 多样性装配，token 预算三层注入）。四个互操作入口（WS-AEP / MCP / A2A / REST）。
- **工业半边**：五协议 DAQ/DCW 驱动（Modbus TCP / RTU-over-TCP / OPC UA / MQTT / HTTP），逐节点边缘运行时（独立采样节拍 + 在飞互斥 + 乱序防御），报警（2% 滞回 + 3 拍去抖），TimescaleDB/SQLite 时序库 + MinIO 帧管线，产线→产品→配方→批次五维打标。
- **桥（核心卖点）**：Agent 绑定工业节点 → 语义卡（物理含义/单位/安全量程/配方窗口）注入 → `daq_query` 带物理语义查遥测 → `dcw_control` 经「联锁（安全量程 ∩ 配方窗口）→ HITL 审批 → PLC 写入 → 回读校验（死区容差）→ 签名写历史」管线 → 闭环「下发→采样→判定（`dcw_judge`）→ keep/`dcw_rollback`」，系统层 `RecipeRollBackManager` 以越限 ≥3 采样阈值兜底 auto_rollback。

### 1.2 核心算法现状（关键判词）

| 模块 | 现状 | 性质 |
|---|---|---|
| Lead 调度 | LLM `supervise()` 决策 + 规则引擎兜底（FIFO + 确定性贪心 pickWorker：队列最短优先、空闲最久次之；retry≤3；300s 停滞看门狗；指纹节流省 LLM 调用） | prompt + 规则，**无优化/学习** |
| Goal 判定 | LLM 满意度判定 + 模板化 goal-summary 保底 | prompt，无形式化目标 |
| 记忆检索 | RRF(k=60) + 排序 0.5 相关性/0.3 时近/0.2 重要性 + MMR(λ=0.7) | 成熟 IR 工程组合，**权重全部硬编码、从未验证** |
| DAQ 信号链 | 阈值 + 滞回 + 去抖 + 乱序丢弃 | 纯阈值，**无滤波/预测/异常检测** |
| DCW 安全链 | 量程硬校验 + 死区回读 + 联锁替代 + 阈值兜底回退 | 状态机 + 阈值，**无控制理论** |
| 评估体系 | 226 个 `_dbg-*` 功能验收脚本，156 断言 E2E，全是**二值 pass/fail 哨兵断言** | **零 benchmark、零 baseline、零消融、零统计、不可复现** |

工程完成度罕见（~4 万行 TS、207 个 API 路由、真实协议栈、156 断言 0 失败），`paper-show/` 里的投稿策略简报已诚实列出四大缺口——本次评估与其结论互证，但给出了更严格的 TII 判据与更具体的执行路径。

---

## 第二部分 · TII 达标性评估

### 2.1 总判

**现状直投 TII：大概率第一轮被拒（Reject / Major Revision 概率 <10% 进入外审后存活）。** 审稿人最可能的三条意见几乎可以预写：

1. *"No quantitative comparison against any baseline; the evaluation is purely functional acceptance."* —— 实验完备性致命。
2. *"The contribution is a system integration; the scheduling/judging/memory components use prompt-based heuristics without formal treatment or learning."* —— 算法先进性不足。
3. *"All experiments are on simulated devices; no hardware-in-the-loop validation."* —— 验证层级不够（TII 对仿真-only 的工作容忍度低）。

**但系统具备冲击 TII 的真实潜力**，因为「LLM Agent × 产线监督 × 人批准写控」正处于论文窗口期（最相近工作 arXiv:2606.20761 等尚无人在"治理管线 + 量化安全-开销权衡"上做实），且本系统的工程完成度远超同类 arXiv 原型。差距是**可补的实验差距 + 可选做一个的算法差距**，不是方向性差距。

### 2.2 三维度差距明细

**A. 创新性（当前：中。目标：高）**

| 已有（值得保留并拔高） | 缺口 |
|---|---|
| 「联锁 ∩ HITL ∩ 回读校验」人批准写控管线——文献中 LLM 写工业设定值的工作几乎都停在"建议"，真正落地安全管线 + 全链路归因（ops_log/recipe_log/dcw_journal）是差异化点 | 该管线停留在工程描述，**无形式化**：没有把联锁/审批/回读语义形式化为可证明的性质（如"任意写入必然经过联锁约束"、"回读失败必然触发回退/告警"的安全不变式），审稿人无法区分它与"普通审批系统" |
| 多引擎互操作（6 harness 同一产线并行闭环） | 互操作本身是工程贡献，TII 不为它给分 |
| 语义卡抽象（Agent 不见裸寄存器） | 未与 grounded-decision 文献对话 |

**B. 实验完备性（当前：不及格。目标：TII 水平）**

| TII 期望 | 现状 | 缺口 |
|---|---|---|
| 量化指标（时延分布、成功率、收敛性、成本） | 全仓 0 个连续指标产出脚本 | 需从零建 benchmark harness |
| Baseline 对比 | 无 | 需 ≥3 条治理消融 baseline + ≥1 条调度 baseline |
| 消融实验 | 无 | 联锁/HITL/回读/记忆/规则兜底逐项拆 |
| 故障/扰动实验 | 仅 audit 报告里偶发记录（Timescale 端口楔死等） | 需系统化故障注入 |
| 可复现协议 | 无 seed/温度/版本固定，脚本不可重复统计 | 需实验协议 + N≥20 重复 + 显著性检验 |
| 硬件验证 | 全模拟 | 需至少一台真设备（HIL） |
| 长周期数据 | channel_events 仅留 7 天，lead 决策理由未持久化 | 需决策日志一等公民化 |

**C. 算法先进性（当前：低-中。目标：中-高，至少一处做深）**

四个可升级点，**建议只选 1–2 个做深**（TII 论文一个方法学贡献即可，贪多则每个都浅）：

1. **调度**：把 lead 派发建模为带约束的在线分配问题（worker 能力/负载/优先级约束），用 LLM 提议 + 解算器/贪心置信验证的混合，或直接上 bandit/RL。最现实路径：**LLM-supervise vs 规则引擎 vs 混合（LLM 提议 + 规则校验）三臂对比**，本身就能撑起一节实验。
2. **记忆**：现有 RRF+MMR 权重硬编码且从未验证——做**记忆消融（无记忆/纯 FTS/RRF/RRF+MMR/调权）对下游任务指标的影响**，即可把工程组件变成实验发现，成本低收益高。
3. **信号链**：在 DAQ 报警链上叠加自适应阈值（EMA/CUSUM/轻量在线异常检测），与 LLM 监督耦合为"检测器预警 → Agent 诊断"两层，是 TII 最偏好的「信号处理 + 智能体」结合点。
4. **闭环优化**：把 keep/rollback 状态机升级为**带安全约束的设定值序贯优化**（Safe Bayesian Optimization 或简单trust-region 步长限制 + 高斯代理），让 Agent 提议的设定值有数学骨架——这是最能改变"算法先进性"印象的一步，但工作量最大。

**推荐组合**：② 记忆消融（保底、必做）+ ③ 自适应异常检测（主线贡献）或 ④ Safe-BO 闭环（若时间充裕选④，档次更高）。

---

## 第三部分 · 具体改进方案

### 3.1 必补工作清单

1. **决策日志一等公民化**（插桩，1 周）
   - 新增 `decision_log` 表：记录每次 lead `supervise()` 的 snapshot 摘要、LLM 原始决策、各 SupervisionDecision、耗时、token 用量、规则引擎是否兜底。
   - channel_events / messages / memories 的实验保留期延长（≥90 天）或导出为 JSONL。
   - 在 `dcw_control`/`dcw_judge`/`dcw_rollback` 链路上落结构化耗时戳（t_propose / t_approve / t_write / t_readback）。
2. **指标采集器**（与 1 同期）
   - `scripts/bench/collector.mjs`：从 SQLite/Timescale/dcw-writes.json 抽取指标 → CSV。
3. **形式化一节**（写作期完成，设计先行）
   - 把写控管线建模为受监督状态机：写请求 w 需满足 `w ∈ SafeRange(node) ∩ RecipeWindow(run)`，HITL 为带超时的异步门，回读为 `|act − set| ≤ tol(node)` 的后验校验；陈述并**验证 2–3 条安全不变式**（可用现有 98 项负向断言改写为性质验证证据）。

### 3.2 Benchmark 与实验（exp）设计

**Benchmark：AW-IndustrialBench**（参数化 workload，全部跑在现有一套协议模拟器上）

- **维度**：节点数 N ∈ {4, 8, 16} × 采样节拍 ∈ {1s, 5s} × 并发 Agent 团队 ∈ {1, 2, 4} × 扰动场景 ∈ {无, 阶跃漂移, 传感器卡死, 通信中断 30s, 乱序注入 5%}。
- **任务模板**（固定 5 类，每配置重复 ≥20 次）：温度设定值修正闭环 / 越限诊断与回退 / 多节点联合调参 / 批次参数恢复 / 目标中途变更重规划。

**指标体系**（三族）：

| 族 | 指标 |
|---|---|
| 安全 | 越界写拦截率、回读失败捕获率、故障后恢复时间（MTTR）、误回退率、HITL 拦下的坏写比例 |
| 性能 | 端到端写控时延 p50/p95/p99、闭环收敛迭代数与耗时、DAQ 端到端时延、事件推送抖动 |
| 成本/质量 | goal 达成率、token/任务、LLM 调用次数/任务、审批等待时长、人工干预次数/任务 |

**实验矩阵**（对应论文 §6 的 5 组实验）：

- **E1 主对比**：完整治理管线 vs 三条消融 baseline——(a) 无治理直写（跳过联锁+HITL+回读）；(b) 无回读校验；(c) 无 HITL（纯自动）。核心张力图：**安全性指标 vs 时延/人工成本**的权衡曲线。预期结论："治理开销 <15% 时延，换取 100% 越界拦截"——这句话就是论文的 thesis。
- **E2 调度三臂**：LLM supervise vs 纯规则引擎 vs 混合，比较 goal 达成率 / token 成本 / 停滞率（mock harness 可做大规模确定性版本 + 真 LLM 小规模补充）。
- **E3 记忆消融**：无记忆 / 纯 FTS / RRF / RRF+MMR 四臂，看下游闭环任务指标差异。
- **E4 故障注入**：断连缓冲、乱序 5%/20%、半开连接、TSDB 不可达 → 数据完整性与恢复时间。
- **E5 异常检测耦合**（若选③）：阈值报警 vs 滞回去抖 vs 自适应（EMA/CUSUM），在注入漂移的数据集上比检测延迟/误报率，再展示"检测器预警 → Agent 诊断"的端到端案例。
- **E6 HIL 案例研究**（ qualitative，1 台真设备即可）。

**可复现协议**：mock harness 跑全量确定性实验（N≥20、固定 seed）；真 LLM 实验固定模型版本 + 温度 0 + 记录 prompt 哈希；报告 Mann-Whitney U 检验 + 95% CI。所有配置进 `bench/configs/*.yml`，一键 `node scripts/bench/run.mjs --config xx`。

### 3.3 数据获取方法（解决"数据从哪来"）

按可信度递增四层，全部可行：

1. **模拟器海量数据**（现成）：现有五协议模拟器 + 参数化 workload 可产出任意规模的带标签遥测/决策/写控数据；扰动场景由注入器（`bench/fault-injector.mjs`）合成，标签免费。
2. **公开工业数据集重放**：把 TEP（Tennessee Eastman）、SWAT/WADI（水处理安全数据集）通过 MQTT/Modbus 驱动**回放进 DAQ 管线**——协议层是真实链路，数据层是学界公认的基准，异常检测实验（E5）因此有公开可比 baseline。工作量：一个 replay driver 插件（`ctx.daq.registerDriver`）。
3. **半实物（HIL）**：一台真 OPC UA/Modbus 设备——树莓派 + PLC 模拟器外设、或二手温控/变频器（数百元级），`node-opcua` 栈可直接接。目的不是规模，是把 "simulated" 标签升级为 "hardware-in-the-loop"。
4. **真实产线**（可选加分项）：实验室级小型产线、校企合作一条工位即可；论文只需 case study，不需要大规模部署。

### 3.4 算法优化方向（按投入产出比排序）

1. **记忆消融 + 权重敏感性**（1 周）：最便宜，把 0.5/0.3/0.2 与 λ=0.7 从"拍脑袋"变成"实验选择"。
2. **自适应异常检测 + LLM 监督耦合**（2–3 周）：EMA 基线 + CUSUM 漂移检测替换固定滞回，检测事件作为工具暴露给 Agent；TII 偏好度高。
3. **Safe-BO 设定值优化**（3–4 周）：`dcw_control` 提议值由 trust-region + 高斯代理生成，联锁作为硬约束投影；与"LLM 直接提议"对比，是档次最高的方法学贡献。
4. **调度混合化**（2 周）：LLM 提议 + 规则引擎校验（feasibility check + 约束投影），三臂实验数据直接进 E2。

---

## 第四部分 · 可执行 Plan（里程碑制）

> 总周期约 12–14 周（可与论文写作并行）。每阶段有明确验收标准；P0 未完成不进 P1。

### P0 · 插桩与决策日志（第 1–2 周）
- [ ] `decision_log` 表 + lead supervise 全量落库（决策、理由、耗时、token、兜底标记）
- [ ] 写控链路结构化耗时戳（t_propose/t_approve/t_write/t_readback）
- [ ] 实验数据保留策略（≥90 天）+ JSONL 导出工具
- [ ] `scripts/bench/collector.mjs` 指标抽取 → CSV
- **验收**：跑一次标准闭环任务，CSV 中能拿到全链路时延与决策记录。

### P1 · Benchmark Harness（第 3–4 周）
- [ ] `bench/configs/` 参数化 workload（N × 节拍 × 团队数 × 扰动）
- [ ] `bench/fault-injector.mjs`（阶跃漂移 / 卡死 / 断连 / 乱序）
- [ ] `bench/run.mjs`：单配置 N≥20 重复、固定 seed、产物 CSV+日志归档
- [ ] 5 类任务模板 + 判定器（goal 达成、越界拦截、收敛判据的机器可读定义）
- **验收**：`--config e1-full` 一键跑完 E1 全矩阵并产出汇总表。

### P2 · Baseline 与主实验（第 5–6 周）
- [ ] 三条治理消融 baseline 的开关实现（联锁/HITL/回读可配置旁路，仅 bench 模式开放）
- [ ] E1 主对比 + E4 故障注入
- [ ] 统计脚本（Mann-Whitney + CI + 权衡曲线图）
- **验收**：安全-开销权衡曲线 + 主对比表成稿。

### P3 · 算法实验（第 7–9 周，与 P2 部分并行）
- [ ] E2 调度三臂（mock 大规模 + 真 LLM 补充）
- [ ] E3 记忆消融四臂
- [ ] 主线算法：E5 自适应异常检测（或 Safe-BO，二选一，另者降级为 future work）
- **验收**：每组实验 ≥20 重复 × 3 配置，指标进论文格式表格。

### P4 · 数据升级（第 9–10 周）
- [ ] TEP 或 SWAT/WADI 回放 driver 插件 + 回放数据集接入 DAQ
- [ ] 一台真 OPC UA/Modbus 设备接入，完成 E6 HIL 案例（含时延实测）
- **验收**：论文实验章节不再有 "simulation-only" 弱点。

### P5 · 论文撰写与投稿（第 10–14 周）
- [ ] 形式化一节（写控管线状态机 + 安全不变式 + 98 项负向断言改写为性质验证证据）
- [ ] 8 节双栏 12–14 页（沿 paper-show 已定的框架：§4 写控管线 2 页、§6 Evaluation 2.5–3 页）
- [ ] 复现包：seed/温度/prompt 哈希/配置文件 + 开源声明（PolyForm NC 兼容学术发表）
- [ ] 投稿决策门：若 P2–P4 全部达成 → **IEEE TII**；若 HIL 或算法升级只完成其一 → 降档 **Computers in Industry**（paper-show 评估的首选刊），TII 作为二投。

### 风险与对策
- **真 LLM 实验方差大/贵** → 主实验用 mock 确定性 + 真 LLM 只跑小规模验证外推。
- **Safe-BO 工作量超支** → 预设降级线：trust-region + 简单代理即可成文，不必完整 GP-UCB。
- **HIL 采购周期** → 第 5 周就下单设备，不阻塞 P0–P3。
- **channel_events 7 天保留** → P0 第一项就改，否则历史轨迹永久丢失。

---

## 附 · 关键文件索引

| 内容 | 路径 |
|---|---|
| Lead 调度/规则引擎 | `server/services/workshop/runtime/scheduler-loop.ts`（decide/ruleEngine/pickWorker） |
| 记忆算法（RRF/MMR/权重） | `server/services/workshop/runtime/memory.ts`（collectHits/score/MMR 装配） |
| DAQ 报警/乱序 | `server/services/workshop/daq/daq-node.ts`（deriveState/applyReading） |
| DCW 联锁/回读 | `server/services/workshop/dcw/dcw-controller.ts`（write/validateEng） |
| 闭环工具面 | `server/services/workshop/agents/industrial-tools.ts` |
| 权威 E2E 报告 | `docs/audit/e2e-2026-09-07.md`（156 断言）· `docs/audit/e2e-2026-09-01.md`（唯一数值基线） |
| 已有投稿策略 | `paper-show/show.src.html`（四缺口自陈与本报告互证） |

# AgentWorkShop · 论文定位 / 同类工作对标 / TII 发表完整计划（增补版）

> 日期：2026-09-12 · 基线：v0.7.35 · 配套文档（本文不重复其内容，只做补充与升级）：
> - `docs/tii-assessment-and-plan.md`（TII 达标性评估 + P0–P5 里程碑）
> - `docs/experiments/00-MASTER-PLAN.md`（14 周工程化总规划 D1–D13）
> - `docs/experiments/05-castfilm-closedloop-report.md`（已测得闭环主案例数据）
> - `paper-show/show.src.html`（四贡献与投稿策略简报）

---

## 0. 结论速览（TL;DR）

1. **文章类型**：TII Regular Paper（系统架构 + 治理方法 + 量化评估），不是 survey、不是纯 benchmark 论文；benchmark 作为四大贡献之一打包发布。
2. **核心卖点（差异化主张）**：文献里 LLM×工业的工作几乎全是"建议/诊断/写代码"，**没人把 LLM 多智能体闭环到真实执行器写入并给出形式化安全治理管线**。本项目的主张是 **"Governed Autonomy"**：LLM 智能体获得闭环写控能力，但每次写入必须经过「联锁(安全量程∩配方窗口) → HITL 审批 → PLC 写入 → 回读校验 → 签名归因」管线，并用实验量化 **安全治理开销 vs 拦截率的权衡曲线**。
3. **一句话 thesis（E1 要证明的）**："治理管线的自动段开销 <15% 时延，换取 100% 越界写拦截与 100% 写入可归因。"
4. **投稿主目标 IEEE TII**；决策门：E1–E4 全绿 + HIL 完成 → TII；缺 HIL 或缺算法主线 → 先投 **Computers in Industry**（paper-show 首选），TII 二投；另有一个机会窗口：**JMS 的 LLM 智能制造专刊**（Advances of Large Language Models for Smart Manufacturing）。
5. **在仓库既有 E1–E6 之上新增三组实验**：E7 通用框架基线（AutoGen/LangGraph/CrewAI 挂同一套 MCP 工具）、E8 人类操作员基线 + HITL 语义、E9 跨引擎泛化（14 harness 中选真实引擎做同任务对比——独家资产，同类论文都做不了）。

---

## 1. 项目设计思想 ↔ 同类项目对标

### 1.1 设计思想提炼

AgentWorkShop 的可发表设计思想不是"又一个 agent 框架"，而是三件事的**同一运行时耦合**：

1. **双半边 + 一座桥**：多智能体运行时（14 引擎注册表、lead 监督调度、三层记忆注入、四互操作入口）与工业运行时（五协议 DAQ/DCW 边缘运行时、Timescale/MinIO 帧管线、五维打标）共进程、共数据域；
2. **治理型写控桥**：Agent 绑定节点→语义卡注入→`dcw_control` 过联锁∩HITL∩回读∩签名历史，系统层 `RecipeRollbackManager` 兜底（越限≥3 采样自动回退、链上最多 2 次后升级人工）；
3. **可复现实验底座**：种子化物理产线仿真（mulberry32, seed=42，离线最优 W* 网格搜索 API）+ 全链路 ops_log/recipe_log/dcw_journal 归因。

### 1.2 同类项目对比表

| 项目/系统 | 性质 | 与本项目重合 | 关键缺失（=本项目的差异化） |
|---|---|---|---|
| [LLMDrivenSimulation](https://github.com/YuchenXia/LLMDrivenSimulation)（Stuttgart, Weyrich 组, ETFA 2024） | 学术原型 | LLM MAS + 数字孪生仿真参数化 | 无真实协议栈（无 PLC/OPC UA 接入）、无 benchmark、无安全治理、demo 级评估（仅 GPT-4 vs GPT-3.5 定性比较） |
| LLM Agents + DT 故障处理（[arXiv:2505.02076](https://arxiv.org/abs/2505.02076), ETFA 2025, Mercangöz 组） | 学术原型 | LLM agent 持续解读系统状态并"发起控制动作"，DT 做知识库+验证场 | 只有搅拌模块两个案例展示，**无 baseline、无量化指标**；控制动作未过安全治理管线 |
| [Agents4PLC](https://arxiv.org/abs/2410.14209)（IEEE TSE 2026） | 学术+benchmark | LLM 多智能体 + 闭环（生成↔验证） | 闭环在**代码层**（PLC 代码生成+形式化验证），不触碰运行中的产线；贡献可借鉴：自带 benchmark + "递进式严格指标"的写法 |
| [CoMA-IKG](https://ieeexplore.ieee.org/document/11407486/)（**TII vol.22 no.6, 2026**） | TII 已发表 | LLM 多智能体 + 工业知识图谱故障诊断——**TII 上最接近的 MAS+LLM 论文** | 诊断/建议类，不写执行器；无写控治理；评估是诊断准确率。→ 这篇就是审稿人心中"TII 能收什么"的标尺 |
| KG + LLM 航空装配故障诊断（TII vol.20 no.6, 2024） | TII 已发表 | LLM+工业系统 | 同上，诊断类 |
| [MetaIndux-PLC](https://www.sciencedirect.com/science/article/abs/pii/S1568494625009846)（ASOC 2025） | 学术 | LLM PLC 代码生成 | 代码生成，非运行时控制 |
| [IIoT-enabled DT for legacy & smart factory](https://www.sciencedirect.com/science/article/pii/S0278612525000834)（JMS 2025, 63 引） | 学术 | LLM 框架集成进 DT | LLM 用于非结构化数据可视化，非闭环控制 |
| [LLM-enhanced embodied multi-agent manufacturing system](https://www.sciencedirect.com/science/article/abs/pii/S0278612525003139)（JMS vol.88） | 学术 | 多智能体 + 制造执行 | 人机协作装配域，无过程工业写控治理 |
| 通用框架：AutoGen / LangGraph / CrewAI / OpenHands | 开源框架 | 多智能体编排 | **无工业协议层、无安全治理、无归因审计**——正是 E7 基线的角色 |
| 工业基础设施：ThingsBoard / EMQX / Eclipse Ditto / BaSyx(AAS) / Node-RED | 开源 IIoT | 协议接入、孪生、流编排 | 无"智能体"层（规则/流而非 LLM 决策）——related work 里作为"非智能基线"引用 |
| Siemens/Microsoft Industrial Copilot | 商业闭源 | 工业副驾驶 | 闭源不可比、无安全写控公开评估——motivation 素材 |

**空白点结论**：截至 2026-09，**没有任何已发表工作同时具备**：运行中产线的 LLM 闭环写控 + 形式化安全治理管线 + HITL 人批准语义 + 全链路归因审计 + 量化"安全-开销"权衡 + 可复现 benchmark（种子化物理仿真/真实协议/公开数据集回放/HIL 四层）。这就是论文的生存空间。

---

## 2. 文章与期刊定位

### 2.1 推荐文章类型与标题方向

**类型**：TII Regular Paper（12–14 页双栏）。三大候选定位（按推荐顺序）：

- **定位 A（首选）｜治理闭环**：《Governed Autonomy: Human-Approved Closed-Loop Setpoint Control by LLM Multi-Agent Systems over Heterogeneous Industrial Networks》——主线是安全治理管线 + 权衡曲线 + benchmark。这是空白点最大、最不容易被"增量"攻击的定位。
- **定位 B｜平台+benchmark**：《AgentWorkShop: A Configuration-Driven Platform Coupling Multi-Harness LLM Agents with an Industrial Digital Twin Runtime》——平台广度 + AW-IndustrialBench 首发。风险：被审稿人读成"系统集成"（tii-assessment 已预判此意见）。
- **定位 C｜方法+系统**：若选做 Safe-BO 算法主线（《Safe Bayesian Optimization of Setpoints under Interlock Constraints with LLM Agents as Supervisors》）——算法档次最高，工作量最大。

**建议**：定位 A 为骨架，吸收 B 的平台叙事与 C 的算法小节（二选一的算法升级放 §5）。四大贡献定稿建议：

1. 形式化的**人批准写控治理管线**（受监督状态机 + 3 条安全不变式 + 98 项负向断言改写为性质验证证据）；
2. **治理开销量化**：首个 LLM 工业写控的"安全-时延-人工成本"权衡曲线（E1）；
3. **AW-IndustrialBench**：种子化物理仿真 + 五协议真实链路 + TEP/SWaT 回放 + HIL 四层可复现基准与任务模板 T1–T5；
4. **跨引擎泛化证据**：治理管线引擎无关（14 harness 注册表上选真实引擎同任务验证，E9）。

### 2.2 期刊矩阵

| 期刊 | IF(约) | 契合度 | 判断 | 备注 |
|---|---|---|---|---|
| **IEEE TII** | ~11 | ★★★★★ | **主目标**。已发 CoMA-IKG(2026)、KG+LLM(2024)，证明收 LLM-MAS；scope 明写 knowledge-based factory automation | 必须 E1–E4 + HIL + ≥1 算法升级全达成 |
| IEEE TASE | ~6 | ★★★★★ | 备选一投，automation science 完美对味，竞争略低于 TII | 若 TII 想避"信息学味"可换 |
| **Computers in Industry** | ~10 | ★★★★☆ | paper-show 首选；系统/集成类友好，LLM 工业助理(CiI 162)、SysMLv2 生成(CiI 172) 先例 | 决策门的降档落点 |
| **JMS**（LLM 智能制造专刊） | ~12 | ★★★★☆ | 有在征的专刊 "Advances of LLMs for Smart Manufacturing"；已收 IIoT-DT(63引)、embodied MAS 等 | 若专刊截稿期合适，优先级上调 |
| RCIM | ~10 | ★★★☆☆ | LLM+DT 先例多（CNC 五维 DT、线束装配 HRC） | 偏机器人/制造执行 |
| EAAI | ~8 | ★★★☆☆ | 应用 AI 保底 | 非首选 |
| IEEE TICPS | 新刊 | ★★★☆☆ | CPS 角度（软实时监督层+硬实时 PLC 分层是 CPS 叙事） | 影响力爬坡期 |
| ETFA / INDIN（会议） | — | ★★★★☆ | IEEE IES 同学会，TII 的传统会议 feeder；先发会议占坑再扩 50%+ 投 TII 是合规路径 | 若想抢首发权 |

**TII 审稿人预判意见与对策**（与 tii-assessment 互证，此处给对策落点）：
1. "无 baseline/纯功能验收" → E1–E9 全矩阵 + 统计协议（本文 §4）。
2. "prompt 启发式无形式化" → §4.3 形式化一节（状态机 + 不变式 + 性质验证证据表）+ 算法升级（EMA/CUSUM 自适应检测 或 Safe-BO）。
3. "仿真-only" → 四层数据升级：协议层真实（五协议真栈）→ 公开数据集回放（TEP/SWaT）→ HIL 真设备案例 → （可选）真实产线 case study。

---

## 3. 同类论文精读要点（审稿人视角的"对标账本"）

对最接近的四篇做评估方法学拆解——**它们的评估弱项就是我们的实验设计必须超越的线**：

| 论文 | 其评估方式 | 我们必须做到的线 |
|---|---|---|
| Agents4PLC (TSE'26) | 自建 benchmark（NL→形式规约→参考代码）+ 递进式严格指标 + 与"previous methods"对比 | 我们也要自建 benchmark（AW-IndustrialBench）且**基线具名**（具体框架版本+模型版本），不能写"previous methods" |
| CoMA-IKG (TII'26) | 诊断准确率/召回 + 案例研究（TII 收文的实际水位） | 我们在其之上多出：安全指标族（拦截率/误拦截率/MTTR）+ 开销族（p50/p95/p99 时延）+ 成本族（token/调用数） |
| LLM+DT 故障处理 (ETFA'25) | 2 个定性案例、无 baseline | 我们任何一个实验组都要 ≥20 重复 + 固定 seed + Mann-Whitney U + 95% CI |
| LLMDrivenSimulation (ETFA'24) | demo 视频 + GPT-4 vs GPT-3.5 定性 | 我们每个结论都有表格数据 + 曲线；模型层消融（≥2 个 LLM 家族）反证非单模型过拟合 |

另需在 related work 中对话的三条文献流：
- **LLM/Agent × 工业**：CoMA-IKG、KG+LLM、变压器 LLM 诊断、Agents4PLC、MetaIndux、LLMDrivenSimulation、Gill ETFA'25、JMS/RCIM 各篇、Nature Sci Rep 综述、JMS 综述(vol.82)、Ren"Agentic AI 概念辨析"(JMS 83)；
- **数字孪生闭环**：TII DT 综述(Nee 2019 奠基)、ASME JCISE 神经符号语义 DT、RCIM LLM增强RL DT、MDPI DT 实时可行性——引出"DT 作为验证场"的定位（castfilm plant-model 就是）；
- **安全/HITL**：τ-bench（策略合规+用户模拟器范式，直接借给 E8 的 HITL 语义实验）、TheAgentCompany/MultiAgentBench/GAIA（agent 评估通用法）、过程安全联锁文献（IEC 61511 叙事锚点：联锁在安全仪表层的正当性）。

---

## 4. 实验与 Benchmark 设计（在仓库 E1–E6 之上增补）

### 4.1 Baseline 完整矩阵（论文 Table 1 的行）

| # | 基线 | 说明 | 服务实验 | 状态 |
|---|---|---|---|---|
| B1a/b/c | 治理消融：无联锁 / 无回读 / 无 HITL | bench 模式旁路开关（D8） | E1 | 已规划 |
| **B2** | **通用框架基线**：AutoGen / LangGraph / CrewAI 各接同一套 MCP 工具（平台已带 ~25 工具 MCP server）跑 T1–T5，无治理管线 | 证明差异来自治理管线而非 LLM；预计安全违规率 >0 vs 治理管线 0 | **E7（新增）** | 未规划，需做 |
| **B3** | **单智能体基线**：单一 ReAct agent（无 lead 调度/无记忆注入/无团队） | 平台内部消融 | E7 | 未规划，需做 |
| **B4** | **人类操作员基线**：n≥5 操作员（或 1 名专家 ×5 场景 ×重复）处理同一故障集，测 MTTR/干预次数/误操作率；无法组织真人时用 τ-bench 式 LLM 用户模拟器脚本化"标准操作员" | HITL 等待时间的合理性论证 + "人机协同优于单方" | **E8（新增）** | 未规划，需做 |
| **B5** | **经典控制基线**：纯 PID / 固定规则脚本 vs LLM 闭环；参照系=离线最优 W*=89.894（castfilm 已有：J=86.2，达最优 95.9–96.0%） | 诚实画出能力边界：常规任务经典更快更稳，**扰动/配方变更/新目标**场景 LLM 闭环占优 | E1 扩展 | 数据半现成 |
| B6 | 调度三臂：LLM supervise / 纯规则 / 混合（D9） | E2 | 已规划 |
| B7 | 记忆四臂：无记忆 / 纯FTS / RRF / RRF+MMR（D10） | E3 | 已规划 |
| **B8** | **跨引擎基线**：codex / claude / gemini / qwen / opencode / pi 六个真实引擎 × 同任务同工具 | 安全不变式全过 = 治理引擎无关；成功率/token 方差 = 引擎选型依据 | **E9（新增）** | 独家资产，注册表已就绪 |

### 4.2 实验清单（E1–E9）

| 实验 | 内容 | 新增要点 |
|---|---|---|
| E1 主对比 | 完整治理 vs B1a/b/c + B5 经典控制 | 把 B5 经典控制列补进主表；输出 thesis 权衡曲线（自动段时延与 HITL 等待分开呈现） |
| E2 调度 | 三臂（mock 大规模 + 真 LLM 小规模） | — |
| E3 记忆 | 四臂 + 权重敏感性（0.5/0.3/0.2、λ=0.7 从拍脑袋变实验选择） | 长时程 token 曲线下面积作为新指标 |
| E4 故障注入 | F1–F6（断连/乱序/卡死/漂移/半开/TSDB 不可达） | 与混沌测试双重复用 |
| E5 检测 | 阈值 vs 滞回去抖 vs EMA+CUSUM 自适应；**TEP/SWaT 回放轨**（D12）与学界公开 baseline 可比 | 论文 §5.3 方法 + §6.5 ROC |
| E6 HIL | 一台真 OPC UA/Modbus 设备案例（W5 下单） | 时延实测小节 |
| **E7** | B2 三框架 + B3 单智能体 vs 完整平台，T1–T5 全任务 | **新增**；记录各框架版本/模型版本/温度 |
| **E8** | HITL 语义：审批延迟分布、超时默认拒绝率、误拦截率(false-block)、B4 人类基线对比 | **新增**；τ-bench 范式 |
| **E9** | B8 跨引擎泛化：不变式通过率（应 100%）+ 成功率/token/时延箱线图 | **新增**；独家人设 |

### 4.3 指标体系（三族，论文 Table 2 定义页）

- **安全族**：越界写拦截率、回读失败捕获率、误拦截率、故障 MTTR、误回退率、HITL 拦下的坏写比例、写入可归因率（目标 100%，ops_log/recipe_log/dcw_journal 三账本核对）；
- **性能族**：写控端到端 p50/p95/p99（t_propose/t_hitl_pending/t_approve/t_write/t_readback 分解）、闭环收敛迭代数与耗时、DAQ 端到端时延、网关 sweep 公平性（`exp-sweep-fairness.mjs` 已有雏形）、事件推送抖动；
- **成本/质量族**：goal 达成率、token/任务、LLM 调用数/任务、审批等待时长、人工干预次数/任务、长时程 token 曲线下面积。

### 4.4 Benchmark 规范（AW-IndustrialBench）

- **矩阵**：N∈{4,8,16} 节点 × 节拍∈{1s,5s} × 团队∈{1,2,4} × 扰动∈{无,阶跃漂移,传感器卡死,断连30s,乱序5%}；任务模板 T1–T5（设定值修正闭环/越限诊断回退/多节点联调/批次参数恢复/目标中途变更）× 每配置 ≥20 重复 × 固定 seed。
- **四层数据可信度**（论文必须逐层标注）：① 种子化物理仿真（mulberry32，点态可复现，离线最优参照）→ ② 公开数据集回放（TEP/SWaT 经 replay driver 进真实协议栈）→ ③ HIL 真设备 → ④（可选）真实产线 case。
- **可复现协议**：mock harness 跑全量确定性；真 LLM 固定模型版本+温度 0+prompt 哈希留档；Mann-Whitney U + 95% CI；配置全进 `bench/configs/*.yml`，`node bench/run.mjs --config xx` 一键复跑。
- **发布形态**：GitHub 开源 + Zenodo DOI（数据+配置+判据 oracle）+ 论文附复现包声明（PolyForm NC 与学术发表兼容）。

---

## 5. 系统需优化清单（按投入产出比，与 P0–P5 对齐）

1. **P0 插桩**（W1–2，最高优先级）：decision_log 表、写控四段耗时戳、保留期 ≥90 天、collector.mjs——**历史轨迹 7 天就丢，每周拖延都是损失**；
2. **算法主线二选一**（W7–9）：方案 A：EMA+CUSUM 自适应异常检测 + `alarm_insights` 工具（2 周，TII 偏好"信号处理×Agent"）；方案 B：Safe-BO 设定值优化（3–4 周，档次更高）；默认 A、人力充足升 B；
3. **形式化一节**（写作期）：写控=受监督状态机；不变式三条（任意写∈SafeRange∩RecipeWindow；回读失败必回退/告警；HITL 超时默认拒绝）；98 项负向断言改写为性质验证证据表；
4. **B2/B3/E7 基线工程**（新增，约 1.5 周）：写三个框架的适配器（各自接平台 MCP 端点），跑 T1–T5；这是审稿人最可能问"和 AutoGen 比呢？"的直接弹药；
5. **B4/E8 人类基线**（新增，约 1 周）：τ-bench 式用户模拟器 + 可选小规模真人研究；
6. **B8/E9 跨引擎**（新增，约 0.5 周）：注册表已就绪，主要是编排与统计；
7. **vitest 单测**（全仓目前零单测）：至少覆盖论文声称的全部算法（滞回去抖/RRF/MMR/联锁/回读死区/自适应检测器），含性质测试。

---

## 6. 执行时间线（14 周，对齐 00-MASTER-PLAN）

```
W1–2   P0 插桩(D1–D3)                      ← 今天 2026-09-12，正处于此阶段
W3–4   P1 Benchmark Harness(D4–D8)         + B2 框架适配器开发(穿插)
W5–7   P2 主实验 E1/E4                     + HIL 设备下单(W5) + E7 框架基线跑批
W7–9   P3 算法实验 E2/E3/E5                + E8 HITL 语义 + E9 跨引擎
W9–11  P4 数据升级(TEP/SWaT 回放 + HIL E6)
W10–14 P5 论文撰写 + 复现包 + 投稿
W12 决策门：E1–E4 + HIL + 算法主线全绿 → IEEE TII；缺一 → Computers in Industry 先投
      （若 JMS 专刊截稿在窗口内且 E 组全绿 → 专刊与 TII 二选一权衡）
```

**风险**：真 LLM 方差/成本 → mock 大规模 + 真 LLM 小规模外推；Safe-BO 超支 → trust-region 降级线；HIL 到货延迟 → W5 下单不阻塞；框架基线被质疑配置不公 → 论文附各框架等 token 预算协议与适配器开源。

---

## 7. 参考链接（对标账本）

- Agents4PLC: https://arxiv.org/abs/2410.14209 （IEEE TSE 2026: https://www.computer.org/csdl/journal/ts/2026/05/11410524/2eoNlVPx0ly ）
- LLM Agents + DT 故障处理: https://arxiv.org/abs/2505.02076 （ETFA 2025）
- LLMDrivenSimulation: https://github.com/YuchenXia/LLMDrivenSimulation ；论文 arXiv:2405.18092（ETFA 2024）
- CoMA-IKG（TII 22(6) 2026）: https://ieeexplore.ieee.org/document/11407486/
- KG+LLM 航空装配诊断（TII 20(6) 2024）: 经 https://dl.acm.org/doi/abs/10.1016/j.aei.2025.103208 引用链可见
- 变压器细调 LLM 诊断: https://ieeexplore.ieee.org/abstract/document/11142969/
- MetaIndux-PLC: https://www.sciencedirect.com/science/article/abs/pii/S1568494625009846
- IIoT-DT（JMS 2025）: https://www.sciencedirect.com/science/article/pii/S0278612525000834
- LLM-enhanced embodied MAS（JMS 88）: https://www.sciencedirect.com/science/article/abs/pii/S0278612525003139
- JMS LLM 专刊: https://www.sciencedirect.com/special-issue/1011BPMV4HV
- RCIM 线束装配 LLM-HRC: https://www.sciencedirect.com/science/article/abs/pii/S0736584525001747 ；RCIM 95 目录: https://www.sciencedirect.com/journal/robotics-and-computer-integrated-manufacturing/vol/95/suppl/C
- ASME 语义 DT: https://asmedigitalcollection.asme.org/computingengineering/article/26/9/091005/1232742/
- Agent 评估综述: https://arxiv.org/html/2507.21504v1 ；工业 AI agent 清单: https://github.com/alikup-ai/top-industrial-ai-agents
- TII 期刊主页: https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics

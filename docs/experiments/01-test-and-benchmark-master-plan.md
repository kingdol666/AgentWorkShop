# AgentWorkShop 全系统测试与基准实验总策划（Master Plan）

> 版本：2026-09-12 · 定位：**全部测试活动的权威索引**。向上对齐论文实验章节（`paper/tii/` §VII，E1–E9 + Table/Fig 账本），向下调度 bench 工程体系与工程测试层。
> 配套文档（本文不重复其细节，只做编排与增补）：
> - `bench/README.md` —— benchmark 规范 v1.0（场景五元组 / T1–T5 判据 / F1–F6 注入 / 指标公式 / 环境要求）
> - `docs/experiments/02-experiment-specs.md` —— E1–E6 逐实验规格（假设·变量·流程·产出）
> - `docs/experiments/03-test-plan.md` —— 工程测试体系（vitest / 性质测试 / CI / bench 回归）
> - `docs/experiments/00-MASTER-PLAN.md` —— 14 周开发里程碑（D1–D13）
> - `docs/experiments/05-castfilm-closedloop-report.md` —— 已完成的 L4 端到端主案例
> - `paper/tii/sections/{benchmark,evaluation}.tex` —— 论文侧定义与占位（填数指南在 evaluation.tex 顶部）

---

## 0. 一页总览

**测试方针**：四层测试金字塔 × 九个实验 × 三族指标 × 一条可复现流水线。

```
                    ┌────────────────────────────────────────────┐
  论文层            │  E1–E9 实验 → CSV/SVG → 论文 Table/Fig 账本   │ ← §4/§8
                    ├────────────────────────────────────────────┤
  基准层            │  AW-IndustrialBench: T1–T5 × F1–F6 × W1–W3   │ ← §3 (bench/README)
                    │  × 治理/调度/记忆/引擎 六维场景五元组            │
                    ├────────────────────────────────────────────┤
  集成/故障层       │  精选 E2E 15 脚本(PR 门禁) + 278 全量(夜)      │ ← §6 (03-test-plan)
                    │  故障注入 F1–F6 = 混沌测试双重复用              │
                    ├────────────────────────────────────────────┤
  单元/性质层       │  vitest 算法单测 + fast-check 性质测试          │
                    │  （不变式 I1–I3 = 论文 §IV 的机器证据）          │
                    └────────────────────────────────────────────┘
  流水线: node bench/run.mjs --config X --seed S → results/<exp>/<config>/<ts>/
          → metrics.csv → stats.mjs(Mann-Whitney+CI) → paper-gen → 论文表格
```

**两条主线结论先行**：
1. **主叙事（E1）**：治理管线以 <15% 自动段时延开销换取 100% 越界写拦截与 100% 写入可归因——这是论文 thesis，一切实验围绕它组织；
2. **应用价值叙事（E7/E8/E9 + castfilm）**：与通用框架/单智能体/人类操作员/经典控制/跨引擎对比，证明价值来自「治理管线 + 工业语义」，不来自某个 LLM。

---

## 1. 测试对象：系统功能分解 → 八个测试面

> 回答"从什么方面测试"。每个功能点标注验证手段：【单】单元/性质测试、【集】集成 E2E、【故】故障注入、【基】bench 实验、【案】案例研究。

| # | 测试面 | 功能点（全部来自真实代码） | 验证手段 | 对应实验 |
|---|---|---|---|---|
| D1 | 数据采集面 | 五协议驱动(Modbus TCP/RTU、OPC UA、MQTT、HTTP)接入与插件注册；逐节点边缘运行时；三节拍解耦(采样 5s/推送 1s/查询 5s，clamp [0.1,60]s)；gateway sweep(250ms tick、配额 64、旋转游标+isDue 防饿死)；报警链(8% warn 带、2% 滞回、3 拍去抖、乱序丢弃)；TSDB 批刷(500ms)+MinIO 降级 | 【单】【故】【基】 | E4、E5、E6 |
| D2 | 写控治理面 | 单入口 write()：可用门→闭环护栏(记录串行/30min 接管/300s 同向冷却)→软联锁(量程∩配方窗)→编码写→回读校验(τ 公式)→签名账本→审计(10s 去重)；HITL 绑定模式 manual/auto/unbound→三策略；回退背板(30s 重检、breach≥3、K=2 升级人工、四种非破坏回退) | 【单+性质 I1–I3】【故 F5】【基】 | **E1**、E8 |
| D3 | 智能体面 | 14 引擎注册表+能力矩阵+三级可用性探测；任务机 7 态(retry≤3)；23 工业/AML 工具+25 MCP 工具；语义卡注入(硬联锁/软联锁/步长≤2% 规则)；judge≠execution 分离 | 【集】【基】 | E9、E7 |
| D4 | 编排协作面 | lead 监督循环(1s tick/空闲退避 8s)、8 类 SupervisionDecision、指纹节流、规则兜底(FIFO/最短队列最久空闲/看门狗 300s 活性)、跨 channel lead-only 通信 | 【单】【基】 | E2 |
| D5 | 记忆上下文面 | FTS5-CJK+向量混合召回、RRF k=60、评分 0.5/0.3/0.2、MMR λ=0.7、三层注入(300/500 token)、压缩@70%+harvest(dedupKey/14d) | 【单】【基】 | E3 |
| D6 | 互操作面 | WS AEP v1(seq 续传/环形缓冲 5000/快照对齐)、MCP 25 工具、A2A AgentCard/JSON-RPC、208 REST 路由 | 【集】【基】 | E7(框架经 MCP 接入即互操作测试) |
| D7 | 审计归因面 | audit_log 14 列(actor_kind 三类×kind 八类×line/product/recipe 维度)、三账本(ops_log/recipe_log/dcw journal)、agent 徽章归属 | 【集】【基】 | E1(attribution_rate)、E4 |
| D8 | 性能伸缩面 | 采样端到端时延、写控 p99、WS 推送抖动、CPU/内存、N∈{4,8,16} 节点×团队{1,2,4} 伸缩 | 【故】【基】 | E1(W3)、E2(W3)、E4 |

**覆盖性检查**：论文 §III 声称的每一个子系统都落入至少一个 D 面；每个 D 面至少被一个 E 实验覆盖——无"论文说了但没测"的空转声称。

---

## 2. 评价体系（三族指标 + 定义公式）

> 权威定义在 `bench/README.md` §6，此处汇总并**新增 E7–E9 所需指标**。所有指标由 `bench/lib/metrics.mjs` 从三处抽取：SQLite(tasks/channel_events/decision_log/approval_history/audit_log)、`dcw-writes.json`+rollback 账本、bench 运行日志。

### 2.1 安全族（论文 Table：metrics 系统）
| 指标 | 公式 | 来源实验 |
|---|---|---|
| intercept_rate | 拦截越界写 / 发起越界写(F5) | E1、E7 |
| readback_failure_catch_rate | 回读失败上报数 / 注入假成功写数 | E1 |
| **false_block_rate**（新） | 被联锁/HITL 错误拒绝的合法写 / 合法写总数 | E1、E8 |
| rollback_correctness / false_rollback_rate | 判定与注入器 ground truth 一致 / 不一致 | E1(T2)、E4 |
| MTTR | 故障注入时刻→回到监控窗（p50/p95, s） | E1、E4、E8 |
| **attribution_rate**（新） | 三账本可完整重建(actor+prev+new+approval)的写 / 总写数，目标 100% | E1、E9 |
| **invariant_pass_rate**（新） | I1–I3 违反次数 / 总写数（应=0，由性质测试+运行时断言双通道计数） | E9 |

### 2.2 性能族
| 指标 | 公式 | 来源实验 |
|---|---|---|
| write_latency p50/p95/p99 | t_propose→t_readback_ok（ms），**与 HITL 等待分开呈现** | E1、E6、E9 |
| hitl_overhead | t_approve−t_propose 分布（E8 单独报告人工延迟） | E8 |
| loop_iterations / convergence_time | T1 收敛轮数 / 注入→回窗耗时 | E1、E3 |
| daq_e2e_latency | 模拟器发帧→Timescale 落库 | E4 |
| **sweep_fairness**（新） | 各节点实际采样间隔的变异系数 CV（游标+isDue 开/关对照） | E4 |
| ws_push_jitter | 推送间隔 p95 偏差 | E4 |

### 2.3 成本/质量族
| 指标 | 公式 | 来源实验 |
|---|---|---|
| goal_success_rate | oracle 全满足任务 / 总任务（oracle 校验 DB/回读/事件流，非字符串） | 全部 |
| tokens_per_task / llm_calls_per_task | decision_log 聚合 | E2、E3、E7、E9 |
| human_interventions_per_task | HITL 审批次数 | E8 |
| wasted_subtasks（T5） | 重规划后作废子任务数 | E2 |
| **token_auc**（新） | 长时程序列任务（T1→T3→T4→T1'）token 曲线下面积 | E3 |
| **engine_success_spread**（新） | 跨引擎 success max−min 与箱线图 | E9 |

---

## 3. 基准场景资产（在哪测、用什么打）

- **Workload**：W1(4+4 节点/5s/1 团队)、W2(8 节点/5s/2 团队)、W3(16+8 节点/1s/2 团队)——全部跑真实五协议模拟器（:1502/:15030/:4840/:1883/:1889）。
- **任务 T1–T5**：设定值闭环 / 越限诊断回退 / 双节点联调 / 批次恢复 / 目标中途变更——每任务带机器可读 completion oracle 与注入器 ground truth（`expected_action` 字段），详见 bench/README §3。
- **故障 F1–F6**：阶跃漂移 / 传感器卡死 / 断连 30s / 乱序 5%·20% / 越界写攻击 / TSDB 不可达——每故障带对账方法（模拟器应发帧序列 vs Timescale 实收），详见 bench/README §4。
- **数据可信层 L1–L4**：种子化物理仿真（mulberry32 seed=42，离线最优 W* 参照）→ TEP/SWaT 公开数据集回放（replay driver 插件）→ HIL 真设备 → castfilm 生产案例（**已完成**，40/40 断言，J=86.2=95.9–96.0% W*）。论文结论按层标注，不混层。
- **主案例锚点**：castfilm 同时是 E1 full 臂的端到端 sanity 参照（8 次跨协议写全 HITL、attribution=100%）。

---

## 4. 实验总表 E1–E9 与基线 B1–B8

### 4.1 总表

| 实验 | 假设（可证伪） | 自变量（臂） | 样本量 | 产出→论文位置 | 依赖 | 状态 |
|---|---|---|---|---|---|---|
| **E1 治理消融主对比** | H1：full 臂拦截 0→100%，时延开销<15%；H1b：去回读后假成功写捕获 100→0% | governance∈{full,no-interlock,no-readback,no-hitl} × {W1,W3} × T1–T4 | 4×2×4×N20(mock)=640 + 真 LLM 补充 2×4×N10 | Table e1 + 权衡曲线→§VII-B/tab:e1 | D8 消融开关 | 规格✓ 配置✓ 代码待建 |
| **E2 调度三臂** | H2：teams=4+T5 下 LLM 超规则 ≥15pp；H2b：单团队静态任务三臂无显著差（诚实边界） | scheduler∈{llm,rule,hybrid} | 3×2×3×N20=360 + 补充 | →§VII-C | D9 hybrid | 规格✓ |
| **E3 记忆四臂** | H3：序列任务 T1' 收敛迭代数低于无记忆臂；rrf+mmr>fts 可测 | memory∈{none,fts,rrf,rrf+mmr} | 4×N20=80 + 权重敏感性 | →§VII-D | D10 开关 | 规格✓ |
| **E4 故障鲁棒性** | H4：F3/F4/F6 数据完整性≥99.9%（对账）；F5 full 下拦截 100% | 7 故障行独立 ×N20，W2 | 7×N20=140 | →§VII-E | D3 注入端口 | 规格✓ |
| **E5 自适应检测** | H5：EMA+CUSUM 检测延迟降≥40%，误报不显著升；耦合 Agent 后 MTTR 再降≥20% | 检测臂×{模拟器轨, TEP/SWaT 轨} | 3×3×N20 | →§VII-F | D11-A + D12 回放 driver | 规格✓ **算法未实现** |
| **E6 HIL 案例** | 真机回读时延分布与治理行为一致性 | 一台真 OPC UA/Modbus 设备 | T1/T2 各 N10 | →§VII-G | D13 采购 | 规格✓ |
| **E7 框架基线**（新增） | H7：无治理框架臂在 F5 下每 100 写出现 ≥1 次越界写成功且不可归因；成功率不高于平台治理臂 | framework∈{AutoGen,LangGraph,CrewAI,single-ReAct} × T1–T5 | 4×5×N10(LLM)=200 | Table fw→§VII-H/tab:fw | B2 适配器（见 4.2） | **规格见本文 4.3** |
| **E8 HITL 语义**（新增） | H8：审批门 false_block ≤5%；sim-operator 与真人 MTTR 同量级；治理的注意力成本可量化 | operator∈{sim(τ-bench 式), human n≥5} × 审批延迟分布 × F5 | sim 5×N20 + 真人 5 人×5 场景×2 轮 | →§VII-I | B4（见 4.2） | **规格见本文 4.3** |
| **E9 跨引擎泛化**（新增） | H9：I1–I3 违反=0 对全部引擎成立（治理引擎无关）；success/token 方差如实报告 | engine∈{codex,claude,gemini,qwen,opencode,pi} × T1–T5 | 6×5×N10=300（LLM） | Table eng→§VII-J/tab:eng | 注册表已就绪 | **规格见本文 4.3** |

### 4.2 基线 B1–B8 实现要点

| ID | 基线 | 具体实现 |
|---|---|---|
| B1a/b/c | 治理消融 | `AW_BENCH_MODE=1` 旁路开关（D8，dcw-controller write() 三处锚点），生产模式硬编码拒绝 |
| B2 | AutoGen/LangGraph/CrewAI | 各写一个 ~100 行适配器：框架 agent ↔ 平台 **MCP 端点**（25 工具现成），同 prompt 模板、同模型、**等 token 预算**（超出即 fail，防"多想多错"不公平）；无治理（直连工具全开），F5 注入同源。适配器随复现包开源 |
| B3 | 单 ReAct | 平台内置：单 agent、无 lead/无记忆注入（`AW_MEMORY_INJECT_TOTAL=0`）、同工具 |
| B4 | 人类操作员 | 双轨：① τ-bench 式 sim-operator（可配审批正确率/延迟分布/错误率，脚本进 bench/lib）；② 真人 n≥5（实验室同事），标准监控屏+审批 UI，录屏计时，签署任务书。人力不可得时②降级为 1 名专家×5 场景×5 重复并如实声明 |
| B5 | 经典控制 | 固定配方脚本 + PID 式定点回归（模拟器自带离线最优 W* 网格搜索 API 作参照）；常规任务经典占优、扰动/变更场景 LLM 闭环占优——**诚实画出能力边界** |
| B6/B7 | 调度/记忆臂 | rule 臂零改动（`lead.supervise=null` 路径已有）；hybrid 臂=D9；记忆开关=D10 |
| B8 | 跨引擎 | 六引擎走 HARNESS_REGISTRY 原生路径，同任务模板同工具；每引擎记录版本号与能力矩阵 |

### 4.3 新增实验规格（E7/E8/E9，补入规格书体系）

**E7 · 框架基线对比**——回答审稿人必问的"和 AutoGen 比呢？"
- 受控变量：任务模板 T1–T5、故障脚本、模型与温度、token 预算、工具 schema（经 MCP 完全一致）。
- 流程：适配器启动框架 run → 同 fixture → 同 oracle 判定 → F5 于 T2/T4 叠加 → 落 metrics.csv（框架版本进表脚注）。
- 判定额外项：越界写成功数（平台侧联锁**关闭**计数器——bench 模式专用旁路，只记录不拦截）、不可归因写数（框架直写不经账本）。
- 产出：`table-e7-frameworks.csv` + 柱状图（success / unsafe-per-100 / tokens 三联）。

**E8 · HITL 语义与人类基线**——治理注意力成本的第一次量化。
- sim-operator 参数化：approve_probability、latency 分布（对数正态，μ/σ 可配）、错误率（误批/误拒），复现 τ-bench 的"user-in-the-loop"范式。
- 指标：approval_latency p50/p95、false_block_rate、timeout 行为、 harmful-write blocked share、human MTTR、human mis-operation rate；报告**自动段时延与人工等待的分解**（论文 §VI 的呈现纪律）。
- 真人轨伦理与成本：任务书标准化、每场景 ≤10 分钟、合计每人 ≤1 小时。

**E9 · 跨引擎泛化**——独家贡献：治理与引擎无关的实证。
- 控制点：同 prompt 模板（fixture 注入 node_id）、同工具面、同审批 sim-operator（隔离人工变量）；每引擎允许保留各自上下文管理（这正是测的方差之一）。
- 判定：invariant_pass_rate（I1–I3 运行时断言）、success、tokens、p99 write latency；结论形态——"安全不变式全引擎 100%，性能方差如实呈现"。

---

## 5. 可复现测试流水线（怎么保证每一张表可重跑）

### 5.1 流水线组件与现状

```
bench/configs/*.yaml ──► bench/run.mjs（待建 D7）
                          ├─ lib/client.mjs      REST 编排（待建 D4）
                          ├─ lib/fixture.mjs     产线夹具 N×5 协议，seed 化（待建 D4）
                          ├─ tasks/T1–T5.mjs     任务模板+oracle（待建 D5）
                          ├─ lib/fault-injector.mjs F1–F6（待建 D6，依赖 D3 模拟器控制端口）
                          ├─ lib/metrics.mjs     指标抽取纯函数（待建 D6）
                          └─ lib/stats.mjs       Mann-Whitney U + bootstrap CI（待建 D6）
API 前置：decision_log 表 + 写控四段耗时戳 + 保留期≥90d（P0：D1/D2，**最高优先**）
产物生成：bench/lib/paper-gen.mjs（新增）——CSV→论文 LaTeX 宏/表格片段，杜绝手抄数字
```
**铁律**：`paper-gen` 产出的片段直接 `\input` 或粘贴进 `paper/tii/`，论文中不允许出现任何手敲实验数字；`results-macros.tex` 的宏与 CSV 列一一对应。

### 5.2 单次 run 生命周期
1. `--seed S` → fixture 创建（节点/配方/绑定/团队全部带 seed 与唯一 tag，重复 20 次 ID 无冲突）；
2. 预热（采样稳态 ≥2 min）→ 按模板序列提交任务（T1–T5），故障按 config 注入时刻表执行；
3. 全程 decision_log + 写控耗时戳 + sim-operator 审批记录落库；
4. teardown 拆夹具 → `metrics.mjs` 抽取 → 追加 `metrics.csv`；
5. 落盘 `bench/results/<exp>/<config>/<ts>/`：config 快照、run-log.jsonl、metrics.csv、服务器日志副本——**永不覆盖**。

### 5.3 复现协议（投稿时随复现包打包）
- seed 全链路（模拟器 mulberry32 + 注入时刻表 + fixture）；mock harness 跑全量矩阵，真 LLM 只做小规模外推；
- 真实 LLM：固定模型版本号、temperature=0、每次调用 prompt SHA-256 + token 数进 decision_log；实验期冻结依赖（package-lock + 模拟器版本 tag）；
- 一键复现：`node bench/run.mjs --config bench/configs/e1-main.yaml --seed 42`；统计脚本再生成全部 CSV/SVG；
- **bench 回归**：每夜 E1-W1-full×N3 固定 seed 冒烟，`write_latency_p95`/`goal_success_rate`/`intercept_rate` 漂移 >10% 告警钉到引入提交——防止"论文做完系统改坏"。

### 5.4 数据完整性对账（E4 的硬证据）
模拟器控制端口记录"应发帧序列"，与 Timescale `queryTagged` 结果按 (node,ts) 对齐：差集=丢失、重复=错序、`lateDropped` 计数核对——F4/F6 的 data integrity 声明以此为唯一依据，不凭日志观感。

---

## 6. 工程可信度层（bench 之外的测试面）

按 `03-test-plan.md` 执行，要点重申：
1. **性质测试 = 论文不变式的机器证据**（fast-check）：任意 value/量程/配方窗组合下 write() 从不产生窗外写（I1）；回读失败必 ACK≠ok 且落账本（I2）；链上自动回退 ≤K=2 后必升级人工（I3）。这三条性质测试进 PR 门禁——审稿人问"形式化怎么验证的"，答案就是它们+98 项负向断言改写的证据表。
2. **单测覆盖论文声称的全部算法**：滞回去抖、RRF/MMR、联锁、死区、标定互逆、任务机迁移、指纹节流。
3. **E2E 收编**：278 个 `_dbg-*` → 精选 15 进 PR 门禁（<10min，mock）+ 夜间全量；哨兵断言逐步升级为数值/状态断言。
4. **混沌 = F1–F6 双重复用**（E4 注入器即工程混沌集）。
5. **CI**：PR = typecheck+lint+vitest+精选 E2E；夜 = 全量 E2E+bench 冒烟+漂移报告。

---

## 7. 执行排期与验收门（对齐 00-MASTER-PLAN 的 P0–P5）

| 周 | 里程碑 | 测试侧交付 | 验收门（不达不进下阶段） |
|---|---|---|---|
| W1–2 | P0 插桩 | D1 decision_log + D2 写控耗时戳 + 保留期 + collector 雏形 | 跑一次闭环任务，SQL 能拉出全链路时延与决策记录 |
| W3–4 | P1 bench | D4–D8（run.mjs/夹具/任务 oracle/注入器/统计/消融开关）+ vitest 骨架+性质测试 + CI | `--config e1-main.yaml --seed 42` 无人值守跑通；I1–I3 性质测试进门禁 |
| W5–7 | P2 主实验 | E1 全矩阵 + E4（夜间批）+ **E7 适配器开发与跑批** + HIL 设备下单 | Table e1 主表 + 权衡曲线成稿；**thesis 检验点**：若开销>15% 或拦截<100%，回 D8 调叙事或补优化 |
| W7–9 | P3 算法实验 | E2 三臂 + E3 四臂 + E5（D11-A 实现）+ **E8 sim-operator 全量 + 真人轨** + **E9 六引擎** | 每实验 ≥3 配置 ×N20/N10 进论文格式表 |
| W9–11 | P4 数据升级 | D12 TEP/SWaT 回放（E5 轨 B）+ D13 HIL（E6） | 实验章节不再有 simulation-only 弱点 |
| W10–14 | P5 论文 | paper-gen 全部表格/图 + 复现包（bench+模拟器+configs+结果样本+seed 协议） | 论文零手敲数字；decision gate：E1–E4+HIL+算法主线全绿→TII，缺一→CiI 先投 |

**样本量与成本预算**：mock 全量 ≈ 1,500+ runs（夜间 3–4 晚）；真实 LLM ≈ E1 补充 80 + E7 200 + E8 sim 100 + E9 300 ≈ 700 runs——按每 run 中位 ~3k token 预估，实验期 LLM 预算可控；E9 成本最高，可先 3 引擎×N5 试跑校准再全量。

---

## 8. 论文产出映射账本（实验产物 ↔ 论文图表）

| 论文位置 | 图表 | bench 产物 | 实验 | 状态 |
|---|---|---|---|---|
| §VII-B tab:e1 | E1 主表（4 治理臂×6 指标×CI） | `table-e1-main.csv`→paper-gen | E1 | 待跑 |
| §VII-B | 权衡散点（x=时延+token, y=拦截率） | `figure-e1-tradeoff.svg` | E1 | 待跑 |
| §VII-C/E2 | 调度表 + teams 伸缩曲线 | `table-e2`、`figure-e2-scaling` | E2 | 待跑 |
| §VII-D/E3 | 记忆消融柱状 + token_auc | `table-e3`、`figure-e3` | E3 | 待跑 |
| §VII-E/E4 | 鲁棒性表(7×5) + 恢复时间线 | `table-e4`、`figure-e4-timeline` | E4 | 待跑 |
| §VII-F/E5 | 检测延迟-误报销点+文献参考线 | `table-e5`、`figure-e5-roc` | E5 | 待 D11-A |
| §VII-G/E6 | HIL 实测时间线（Agent 干预标注） | `figure-e6-hil` | E6 | 待设备 |
| §VII-H tab:fw | 框架基线三联表 | `table-e7-frameworks.csv` | E7 | 待适配器 |
| §VII-I | HITL 延迟分布 + 人类对照 | `figure-e8-hitl`、`table-e8` | E8 | 待 sim-operator |
| §VII-J tab:eng | 跨引擎表（I1–I3 全 100%） | `table-e9-engines.csv` | E9 | 注册表就绪 |
| §VII-K tab:castfilm | castfilm 案例（**唯一已实测**） | `docs/experiments/05-...` | L4 | ✅ 已完成 |
| §IV 形式化 | 不变式证据表 | vitest 性质测试报告 + 98 负向断言映射 | 工程层 | 待收编 |

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 真 LLM 方差大/成本超支 | mock 跑全量，LLM 只跑补充组（N=10）；E9 先 3×N5 试跑校准；温度 0 + prompt 哈希留档 |
| thesis 不成立（开销>15% 或拦截<100%） | F5 上界由场景设计保证；开销分解呈现（自动段 vs HITL 等待）；若确实不成立→如实报告并转"治理成本刻画"叙事，回 D8 优化后重测 |
| E7 被质疑"框架没调好" | 等 token 预算协议 + 适配器开源 + 每框架调参记录（各框架推荐实践配置） |
| 真人轨组织失败 | 降级 1 专家×5 场景×5 重复并声明；sim-operator 轨独立成表不依赖真人 |
| E5 算法来不及 | 降级线：trust-region/简单代理；再不行 E5 降为 future work，E1–E4+E7–E9 仍可支撑投稿（决策门） |
| 指标漂移（系统演化污染结果） | 实验期冻结版本 tag；夜间 bench 回归钉提交；结果目录永不覆盖 |
| 数据保留不足 | P0 第一项就改保留期（现状 channel_events 仅 7 天，每拖一周历史永久丢失） |

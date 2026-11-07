# 论文实验 PIPELINE 优化设计（可执行版）

> 历史实现计划，命令依赖完整 AgentWorkShop 仓库的 `bench/` 源码；当前投稿包不含这些完整 runner。现行协议和状态以 `../PAPER-EVIDENCE-PIPELINE.md` 与 `../EXPERIMENT-DESIGN-2026-11-05.md` 为准。本文中的旧路径不代表文件已随包提供。

**状态：执行设计，不是实验结果。** 本文件是
[`EXPERIMENT-DESIGN-2026-11-05.md`](../EXPERIMENT-DESIGN-2026-11-05.md)（E0–E7
矩阵与纪律）的**可执行补充**：把论文当前主张逐条映射到证据缺口，按论文杠杆
排序为 P0–P4，给出每个缺口的实现规格、执行 RUNBOOK、验收门，以及执行后的
**论文写回映射**。所有执行继承 EXPERIMENT-DESIGN 的 E0 资格门、预注册、
pilot-不入-确认样本与阴性-如实-报告纪律。

---

## 1. 论文主张 → 现有证据 → 缺口 → 本 PIPELINE 动作

| 论文位置（现稿） | 主张 / 数字 | 现有证据（Nov-1 批） | 缺口 | 动作 |
|---|---|---|---|---|
| §VI-A + 摘要 | 四场景映射 220/220·219/219·216/216 | `scenario-protocol-probes` run 20261101121221 | **窗口类探针缺失**：3 场景配方窗=工程量程（`bench/lib/scenarios.mjs` 配方 `min/max` 直接取 `sig.min/max`），Eq.(2) 的配方窗层在多场景矩阵中未被行使 | **P2a** 窗口参数化 + 第 4 类探针 |
| §VI-B | 窗口消融 6/6 拦截；无回读不匹配刺激（正文自认） | `process-window-ablation`（mock 驱动、B 态） | **回读不匹配路径零证据**——回执分级（readback-verified/TA/UV）是论文核心机制却无实验触达 | **P2b** 利用模拟器既有 spike/drift 故障注入 |
| §VI-B | 审批夹具 202→204.8 / 216 保持 | `approval-gate.mjs` | 非同请求配对；无"待批期间上下文变更→复核拦截"证据（§V-B 的设计承诺） | **P4** A1 适配（可选） |
| §VI-C + 摘要 | 15/15 vs 0/15（匹配子集 12/12 vs 0/12） | `optimization-control.mjs` C0/C1 | 时域/终点不配对、无基线、纯描述——Discussion 自己给出了应有的协议 | **P1** E6 固定时域配对（真适配器） |
| §VI-D | 注塑孪生 pilot 60→63.7 bar 入带 | C3 后续 run | 单次；**31.503 vs 31.508 g 分歧未决**；provenance 缺平台 commit/快照 | **P3** 复跑 + 分歧消解 |
| §VI-E + 摘要 | live-Agent 试点 **0 次受治理写入**（阴性） | `agent-multiround`→`optloop` 两次 episode | **论文最大弱点**：为 Agent 而写的论文，Agent 颗粒无收；仓库存在阳性先例路径但未纳入本次冻结批次 | **P0** 资格预检 + 3 episodes 全链条证据 |

**排序依据 = 论文杠杆**：P0 改变论文性质（Agent 从"无写入"变"至少一次完整
受控写入"）；P1 把唯一的过程对照从描述升级为可检验；P2a/P2b 补齐论文自己
披露的两个机制缺口；P3 消解正文中的未决分歧。P4 可选。

---

## 2. 各动作实现规格

### P0 · E7 阳性 live-Agent episode（最高杠杆）

**引擎**：`bench/optloop.mjs`（已验证：omp lead+worker 经治理 `dcw_control`
写入；产出 `timeline.jsonl`/`setpoints.jsonl`/`quality.jsonl`）+
`bench/experiment/agent-multiround.mjs`（每 episode fresh 复位）。

**新增：资格预检脚本 `bench/experiment/agent-qualify.mjs`**（约 150 行），
Nov-1 试点 4 次 setup 失败的对策，全部在投币前完成：
1. 隔离实例存活且版本匹配（独立启动，不复用共享 `:4010`/`:3005`）；
2. `omp` 在 PATH、模型端点（LM Studio / USTC）可达且返回非空 completion；
3. 模拟器 preset 就绪、`provisionScenarioLine` fresh 复位成功且初态与蓝图差
   ≤ 容差；
4. Agent token 可读、`dcw_control`/`recipe_trial` 工具面在册；
5. 输出 `qualification.json`：每项 pass/fail，任一 fail → 不运行、记
   `NOT_RUN(qualification)`。

**执行**：3 episodes（injection，budget 15 min）。无论成败全部入分母。

**链条证据关联（本动作的验收核心）**：对每个 episode 产出
`chain-evidence.json`，把 optloop 的时间线与**系统侧**记录按写事件关联：
- 任务上下文（channel/task id）← optloop timeline
- Agent 身份与工具请求 ← timeline + 平台操作日志
- 治理判定与审批记录 ← DCW 台账 + 审批服务 REST 导出（含 pending→decision
  时间戳）
- 驱动回执与可选回读 ← 写控台账
- dispatch 后 DAQ 样本 ← quality.jsonl + TSDB 独立导出
链条任一环缺失 → 该 episode 记 `chain_incomplete`，不得写"完整受控写入"。

**验收门**：≥1 episode `chain_complete` 且为受治理写入 → 摘要与 §VI-E 的
写回走 §5 的阳性分支；M=0 → 保持现稿阴性表述（分母更新为 3）。

### P1 · E6 固定时域配对（把 §VI-C 从描述升级为可检验）

**新增：真适配器 `bench/paper-runner/platform-adapter.mjs`**（约 400 行），
实现 `paired.mjs` 已定义的接口（现仅 `synthetic-fixture`，`paired.mjs:111`
的 kind 检查需放宽为注册制）：

```text
reset(block, condition):
  隔离实例上 provisionScenarioLine 全新线 → 设定初态 SP/PV → 写入 blueprint
  → 从模拟器独立状态端点回读初态，|Δ|≤容差才返回 ok；否则该臂 INVALID
sample(t): 平台 DAQ REST 取 [t-Δt, t] 原始带时间戳样本（含源时间/采样时间/单位）
act(t, action):
  C1 = 冻结脚本策略（recipe_trial 或单点治理写，同一冻结版）
  C0 = 无写（只采样）
  C2 = 冻结规则基线（带缘+比例步长，走同一治理写路径）
```

**计划**：3 场景 × seeds 43–46 × 3 臂 = 36 blocks；同场景内串行（共享模拟器
防交叉污染）、block 内臂序随机化；每场景固定时域 T（建议 injection 180 s、
wwtp/anneal 240 s，冻结后不得改）；采样 1 s；每臂前 fresh 复位并记录复位凭据。

**指标（预注册）**：主 = IAE（梯形法，缺失规则冻结）；次 = 在带时间比、
最大超调、首次进带时间（删失）、写入数、拒绝数。**分析**：每场景逐对差值
C1−C0、C2−C0、C1−C2 + 效应量；n=12 对/比较只作探索性报告，不写显著/优于。

**验收门**：≥10/12 有效对（每场景 ≥3）→ 写回 §5；有效对不足 → 如实报
INVALID 分母，论文保持描述性表述并引用本协议为后续工作。

### P2a · 窗口类探针（补 Eq.(2) 配方窗层的多场景证据）

1. `bench/lib/scenarios.mjs` 配方构造（现 :342 `min: sig.min, max: sig.max`）
   加参数 `windowFrac`（默认 1.0 = 现行为，**不破坏既有 runner**）；探针场景
   用 0.8（窗口 = 量程 80%，居中）。
2. `scenario-protocol-probes.mjs` 增第 4 类探针：**window**（每路由 2 条：
   窗外但量程内的值 → 必须被配方窗层拒绝，且响应指认 recipe 层）；窗口退化
   的路由计入新列 `window_degenerate` 并跳过（诚实计数，不冒充拒绝）。
3. 冻结后重跑四场景矩阵（B 态，约 40 min）。**预期**：每场景新增
   window rejected = 2×路由数；Table II 增加 "Window rejected" 列与
   "Degenerate" 列；Eq.(2) 四层中 recipe 层获得多场景直接证据。

### P2b · 回读不匹配注入（补回执分级实验）

模拟器已有值级故障引擎（`plc-node-simulator/src/server/engine/signals.ts`：
stuckAt/spike/drift）。**规格**：
1. 合法写 A → 立即对该节点 PATCH 一个短窗 `spike`（幅度 > writeTolerance，
   例如 +5% span，持续 2 个 tick）→ 平台回读读到错值 → **预期**：mismatch →
   最多 3 次 2 s 重读 → 回执降级（unverified/mismatch），记录实际分级字段；
2. 清除故障 → 合法写 B → **预期**：readback-verified；
3. 记录：写入值、每次重读原始值、最终 grade、时间戳序列。
产物进 §VI-B 新段："回读不匹配 stimulus：错值回读使回执降级为 …，正常写
保持 readback-verified"——关闭论文自认的"未注入 readback-mismatch"缺口。

### P3 · 注塑 pilot 复跑与 31.503/31.508 消解

1. 以 E0 级 provenance 复跑一次 C3 后续（平台 commit + 配置 hash + 模拟器
   快照 + 原始序列全部入包）；
2. 基线克重**从写前原始样本按冻结窗口规则重算**，报告中写明规则；11-04 包中
   31.503（结构化记录）vs 31.508（报告）以重算值为准，旧分歧在 S7 标注
   superseded；
3. 论文 §VI-D 换为 provenance 完整的新数字；若新 run 结果方向不同，**如实
   写回**（见 §5 阴性分支）。

### P4 · A1 审批消融适配（可选，不阻塞投稿）

现 prototype 调 `recipe_trial`，需改到单点 `optimization_explore`：
同一请求 × {批准, 拒绝, 超时} 三臂配对 + **待批期间上下文变更**（改 run/
撤销绑定/改配方定义）→ 验证 §V-B 的复核拦截。约 1 天开发。成果直接支撑
§V-B "approval is bound to the proposal and rechecked" 的设计承诺——目前
该承诺只有代码与文字、无实验。

---

## 3. 执行 RUNBOOK（资格通过后按序执行；任一门失败 → 停止并如实记录）

```text
# ── 阶段 0：资格与冻结（约 1 h）
node bench/experiment/agent-qualify.mjs --out <new-dir>        # P0 预检
#   E0：隔离实例、双模式（生产/B 态）配置、commit+dirty+进程身份、时钟
#   预注册：paper-study 登记 P1 计划（场景/种子/臂序/T/指标/缺失规则）
#   PILOT：窗口探针 1 场景 + 回读故障 1 路由 + 1 个 optloop episode（PILOT 标记，不入确认样本）
#   修复夹具 → 重新冻结

# ── 阶段 1：确认性执行（机器时间约 5–6 h）
node bench/experiment/scenario-protocol-probes.mjs \           # E1+窗口列
  --scenarios injection,wwtp,anneal --window-frac 0.8 --out <new-dir>
# （biax 按其 provisioning 路径单独跑同一版本）
node bench/experiment/readback-mismatch.mjs --out <new-dir>    # P2b（新脚本）
node bench/experiment/production-guards.mjs --ack-unverified-mode \
  --base <isolated-production-mode-aw> --out <new-dir>         # 生产模式分支（复用）
node bench/paper-runner/paired.mjs run --plan <registered-plan> \
  --adapter platform --out <new-dir>                           # P1：36 blocks，串行
node bench/experiment/agent-multiround.mjs --scenarios injection \
  --runs 3 --budget 15 --out <new-dir>                         # P0：3 episodes
#   P3：C3 复跑（复用原命令 + E0 provenance 采集）

# ── 阶段 2：收口
node bench/tools/experiment-status.mjs                          # 状态表派生
#   SHA-256 清单、chain-evidence.json 核验、INVALID/分母入总表
```

**失败语义**（继承 EXPERIMENT-DESIGN §7–8）：任一模块
`NOT_RUN/INVALID/chain_incomplete` 必须进入论文对应句子的限定；**禁止**按
结果好坏筛选场景、种子或 episode；pilot 数据不得混入确认样本。

---

## 4. 工作量与墙钟

| 项 | 开发量 | 机器时间 |
|---|---|---|
| P0 资格预检 + 链条关联 | ~250 行新脚本 | 3 episodes ≈ 1.5 h |
| P1 真适配器 + 放宽 kind 检查 | ~400 行 | 36 blocks ≈ 3 h（串行） |
| P2a 窗口参数化 + 探针类 | ~120 行（两文件） | 矩阵重跑 ≈ 40 min |
| P2b 故障注入探针 | ~150 行（复用既有故障引擎） | ≈ 15 min |
| P3 复跑 | 复用原命令 + provenance 采集 | ≈ 30 min |
| 合计 | **≈ 1–2 天开发** | **≈ 1 个工作日** |

---

## 5. 论文写回映射（执行后逐句替换；含阴性分支）

| 论文位置 | 现句 | 执行后替换为 |
|---|---|---|
| 摘要 | "In a separate three-scene comparison, 15/15 scripted and 0/15 no-write endpoints were in band, but …" | **P1 成**："Under a common fixed horizon with matched resets, the scripted policy reduced median IAE versus no-write in N/12 matched scene–seed pairs (frozen rule baseline: M/12); small-sample effects are exploratory." **P1 败/不足**：保留现句 + "a preregistered fixed-horizon protocol is defined in Supplementary File S7"。 |
| 摘要 | "The live-Agent pilot issued no governed writes." | **P0 阳**："Across three live-Agent episodes, one completed a governed write whose full chain (task, tool call, governance, approval, driver receipt, readback, post-dispatch observation) is verifiable in Supplementary File S7; the others produced no governed writes." **P0 阴**：保持阴性，分母改 3。 |
| Table II（§VI-A） | 仅 Structural rejected | 增 "Window rejected" 与 "Window-degenerate" 两列（P2a）。正文补一句：三场景原窗口=量程退化的说明。 |
| §VI-B | "No readback-mismatch stimulus was included, so this experiment does not assess that check." | **P2b 成**：替换为不匹配注入结果段（错值回读 → 降级 + 重读序列；正常写 → readback-verified）。 |
| §VI-C | 15/15 vs 0/15 描述块 | 整段替换为 E6 协议与结果（协议一句话 + 配对差值 + INVALID 分母）；Fig. 5(a) 换成逐对 IAE 差值图。 |
| §VI-D | 31.503 vs 31.508 未决 | 重算值 + "the archived-report discrepancy is superseded by the recomputed baseline under the frozen window rule"。 |
| §V-B（若 P4 执行） | 审批复核承诺无实验 | 增待批期上下文变更拦截的配对结果。 |
| Discussion §VII | "A process-efficacy study should reset each scene…"（处方语气） | 改为"the preregistered fixed-horizon comparison reported in Section VI-C implements this protocol; residual limits are …" |

**纪律**：若 P1 显示脚本策略在固定时域下不优于无写基线，该结果**必须如实
写入**并把 §VI-C 限定为"no benefit under the tested horizon"——这仍是可发表
的诚实结果，而按目标筛数据不是。

---

## 6. 与现有文件的关系

- 本文件不替代 [`EXPERIMENT-DESIGN-2026-11-05.md`](EXPERIMENT-DESIGN-2026-11-05.md)
  的 E0–E7 纪律与资格门；它把该矩阵裁剪到**论文当前主张实际需要的最小集合**，
  并给出实现规格与写回映射。
- `bench/PIPELINE.md` 头部"论文实验状态更新"指向 EXPERIMENT-DESIGN；执行后
  应把状态行更新为指向本文件的 RUNBOOK 产物（`experiment-status.mjs` 派生）。
- 旧 C0/C1（`--ack-legacy-descriptive`）在 P1 完成后降级为历史描述性记录，
  不再进入论文正文。

---

## 9. 执行状态（2026-11-05 首轮收口）

执行标准已固化到 [`bench/PIPELINE/PAPER-EVIDENCE-PIPELINE.md`](../../../bench/PIPELINE/PAPER-EVIDENCE-PIPELINE.md)。
本轮产物全部在 `bench/results/`，并打包为 `Supplementary-File-S7-data-2026-11-05.zip`
（新增 `03-pipeline-2026-11-05/`，81 项）。

| 动作 | 状态 | 产物 run 目录 | 结果 |
|---|---|---|---|
| E7 环境预检（P0 前置） | **仅预检通过，不是 Agent 资格结论** | `20261105-agent-qualify` | Q1–Q6 记录到端点/CLI/登录/复位可达及一次受治理脚本写；Q4 仅列模型，没有完成推理；Q6 不是 Agent 任务写 |
| E1+窗口（P2a） | **限定的仿真路径观察** | `20261105060237-scenario-probes` | legal 220/220 · structural 219/219（1 项未收集）· **window 110/110** · readback 216/216。窗口探针补充 Nov-1 未覆盖的路径；输入与 oracle 同源于配置，且服务为 already-up，因此不证明配置工程正确性、总体覆盖或部署服务版本 |
| E5 回读失配（P2b） | **单次注入下的限定观察** | `20261105060514-readback-mismatch` | baseline verified → 命令 230、驱动回读 251（差 21，容差 0.7）、另一次同模拟器读取 251、ack=unverified → 写 251 后 verified。旧报告把 `independentDelta=0` 与“独立回读偏差大于容差”混为一谈：0 是两次读数之差，21 才是命令与驱动回读之差；无物理设备、独立硬件或重试链证据 |
| E7 Agent episodes（P0） | **阴性（全天累计 6 episodes，0 受治理写入；其中 4 个隔离无效已降级，2 个隔离有效）** | `20261105060550/20261105100953-agent-multiround`（隔离无效：平台误落仓库 dev 根）+ `20261105103512/20261105104454-*optloop`（隔离有效，omp 日志实锤） | 失败分类学三轮递进（②③有 omp 日志直证）：①隔离无效轮×4（~6min CANCELED，0 回合；platform.mjs AW_HOME bug 未修前平台误落仓库根，这两轮产物降级为流程调试，不进论文分母）；②**已证实**：LM Studio 实例 ctx=4096（parallel=4 均分 8192/槽）→ 提示词 19,260 token 溢出 → `OMP_LLM_ERROR`（18:41:44 日志）→ 24s 草率 COMPLETED；③**已证实**：32k/parallel=1 重载后回合成功（worker 279 帧）但**根任务改派路径 goal 判据不被强制**——无 judge 证据仍收 COMPLETED、0 写入（新发现平台治理缺口，按 G-1 记法入册）。**论文写回：§VI-E 分母=Nov-1 2 + 本轮隔离 2 = 4 episodes；三条失败模式各一句（①②有日志直证、③为判据旁路发现）；保持 orchestration-状态不等于过程目标论点** |
| P1 固定时域配对 | NOT_IMPLEMENTED | — | `paired.mjs` 真适配器未实现（本会话未排入） |
| P3 注塑 pilot 复跑 | NOT_RUN | — | 原 pilot 无独立 runner，复跑需按 §P3 规格新建 |

**执行中修复的基础设施缺陷**（均已入码，受益所有后续 bench run）：
1. `bench/lib/platform.mjs`：`aw start` 在 repo cwd 走 project 模式忽略
   AW_HOME → 现按 AW_HOME 强制 home 模式 cwd（否则落回仓库 dev 根，实测
   login 落到共享用户表）。
2. `bench/lib/scenarios.mjs`（开跑判定）：start 的 409「已在运行」被误记
   started=false —— 客户端 30s 超时重试撞幂等闸所致；现在 200 与
   409-已在运行都记 started=true；复用路径同样修复（复用分支原本不带 started）。
3. 新增 runner：`scenario-protocol-probes.mjs` 窗口探针类（`--window-frac`）、
   `readback-mismatch.mjs`（E5）、`agent-qualify.mjs`（E7 预检）、
   `tools/collect-paper-evidence.mjs`（汇整+SHA256）。
4. 影子模拟器目录归档：`plc-node-simulator-bench-archive-20261105`（旧 config
   携带与共享实例冲突的绝对端口 16052；影子在 SIM_PORT=4012 重建）。

**下一轮优先项**：先从带时间戳的 harness、审批和 worker 事件中复核停滞阶段，
把“审批等待或模型响应慢”当作待验证假设，而非已知根因。任何超时或零轮 episode
均保留；修复后预注册并重新运行。只有在任务请求、Agent 工具调用、治理检查、
适用的审批、driver 事件、设备/模拟器回读及过程观测可按同一 episode 关联时，
才能报告一条完整的 live-Agent 链；预检 Q6 的脚本写不能替代它。

---

## 10. 第三轮执行补记（2026-11-05 晚间 · 集成测试轮）

全新隔离环境（`D:\tmp\aw-agent-it-20261105`，平台 `:3578` 单监听断言、影子 sim `:4012`）。
汇整：`bench/results/20261105-agent-control-it-SUMMARY/`（SUMMARY.md + manifest + SHA256SUMS）。

| 块 | 状态 | 产物 | 结果 |
|---|---|---|---|
| 集成门（数采/数控/工具面/写链） | **PASS（终版）** | `20261105145105-agent-control-it` | S1 数采活（≥5 实时样本）；S2 治理写 readback-verified；S3 worker-token invoke 三探全过；**S3f recipe_trial 写探针：HITL 卡→runner 代理批准→整批下发→设备证实 1/1（[证实✓]）** —— worker 身份受治理写全链确定性证明 |
| LLM 自主 episodes | **阴性（本轮 5，全部隔离有效）** | `1kjc/1ers/tqs/1lkc/ul0-optloop`（各含 chain-evidence） | 0 次 agent 发起受治理写；工具调用轨迹 1→2→13→93→0；收口 COMPLETED×4（其中带外收口 = G-1 再实证）+ CANCELED×1 |

**本轮定位并修复的 bench 缺陷（8 项，详见 SUMMARY §2）**，以及两个**平台缺口记法**：
- **G-1**（沿用）：goal 判据在改派路径不被强制——带外收口仍 COMPLETED（本轮 ep3/ep4 再实证）。
- **G-2**（新）：`dcw_control`/`param_control` **从未进 `host-tools.json`（108 工具声明源）**——任何
  频道任何 profile 的 agent 会话都挂载不到；而 hybrid_twin+bounded_auto 的写族在 dispatch 被
  恒拒 `AML_TWIN_WRITE_GRANT_REQUIRED`，**WriteGrant 签发机制代码中不存在**（catalog 注入层与
  dispatch 守卫层双层矛盾，hybrid 在线写当前不可达）。当前唯一活的 agent 受治理写链 =
  **recipe_trial**（legacy 频道挂载；绑定收窄+配方窗+节拍三重治理；10-18/10-30 阳性先例同链）。

**失败分类学终版（5 episodes）**：①名称≠id（已修：任务书注入运行时 id）→②绑定 manual+api.call
静默吞错（已修：confirm+熔断）→③工具面可见性（新环境未复现；单监听断言常态化）→④dcw_control
不可挂载/GRANT 无签发（绕过：recipe_trial 链 + G-2 入册）→⑤本地模型能力（**唯一剩余层**：
9B 退化循环 / 30B 零工具调用被 stall cancel）。

**论文写回影响（§VI-E）**：分母可更新为 Nov-1 2 + 前轮 2 + 本轮 5 = **9 episodes**（全部隔离有效口径另计）；
摘要与 §VI-E 可增补一句：*A deterministic agent-identity governed write (recipe_trial under HITL proxy
approval with device-verified receipt) was demonstrated end-to-end; LLM-autonomous episodes remain
negative (n=5 this round), with a five-layer failure taxonomy in Supplementary File S7.*

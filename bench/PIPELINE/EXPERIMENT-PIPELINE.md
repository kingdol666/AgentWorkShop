# 论文实验流水线（E-Pipeline）

> **本文是论文实验的唯一执行合同。** `bench/PIPELINE.md` 是「集成能力评测」执行卡（证明系统能跑通），
> 本文是「可对照、可重复、可分因子归因」的实验合同（证明论文能写什么）。
> 每个实验块都绑定：目的 → 因子 → 实验单元 → 命令 → 判据 → 产物 → 状态 → 论文位置。
>
> **按顺序执行的命令清单见 [`EXPERIMENT-RUNBOOK.md`](EXPERIMENT-RUNBOOK.md)。**
> 本文回答「能写什么、分母是什么、红线在哪」，RUNBOOK 回答「先敲哪条命令、等多久、不过怎么办」。
> 两者同源：RUNBOOK 每一步都对应本文一个 block，跑完即产出 §7 账本里的表。
>
> **状态三值（只允许这三个值）**
> - `IMPLEMENTED`：命令存在、判据可机器判定、至少有一次通过的干净 run。
> - `PARTIAL`：部分条件已实现，缺口在 §8 明列；只允许报告已实测的那部分，缺项写 `NOT-RUN`。
> - `NOT-IMPLEMENTED`：执行器不存在。
>
> **铁律（违反即整份实验作废）**
> 1. 论文里出现的每个数字，必须能指到本文一个 block + 一个 `runId` + 一个产物文件；指不到就删数字或删主张。
> 2. 一个 block 没有「阴性对照」（本来就应该失败的条件），它的阳性结果不构成证据。
> 3. 只有在同一快照上配对的臂，才可以做因果归因；跨 run 的差异只能报为「描述性观察」。
> 4. 任何臂的判据只允许来自独立数据面（设备读回、治理账本、事件账本），Agent 自述与终端转录只作解释材料。
> 5. 状态、数字、分母都从产物派生（`node bench/tools/experiment-status.mjs`），不允许手抄进文档。

---

## 0. 为什么需要这次更新

现有 `bench/PIPELINE.md` 覆盖 P0–P14 的集成路径，**能证明系统跑得通，不能直接支撑论文的三类主张**：

| 论文要主张 | 现有能力 | 缺口 |
|---|---|---|
| 多场景 × 多协议 | P2/P3 五协议 × 2 场景（cast-film 24/24、film-line 9/9 负探针） | 另外 3 个场景（injection/wwtp/anneal）**没有任何写准入探针**；biax 无探针；无统一矩阵产物 |
| 闭环优化真的有效 | P6 castfilm J/J*（3 seed）、P11 三场景达标、optloop LLM 自主 | 无「不写」阴性对照；三条路径场景/预算/写上限不同，**不能合成一张表** |
| 审批门/拦截机制起作用 | E1a 四臂（API 层）、P4c HITL 正向路径 | 审批消融 **NOT-RUN**；E1a 的 `ungated` 不是授权门；步长/60s/保持窗**在所有臂里都是关的** |

---

## 1. 设计审查结论（先认这 8 件事，再谈跑实验）

以下每条都有代码锚点，均可复核。编号在 §8 缺口表中复用。

| # | 问题 | 证据锚点 | 后果 |
|---|---|---|---|
| **D1** | 论文实验是**单次 integrated run**，无 repetition、无对照组 | `paper/.../sections/evaluation.tex:3-9` 自述 "one ... run"、"not ... independent repetitions" | 任何「机制有效」的因果主张都缺分母 |
| **D2** | 审批旁路 hook 挂在 `recipe_trial`，论文的审批证据走 `optimization_explore` → `dcw_control` | 旁路：`ops-tools.ts:1016`（`toolRecipeTrial` 内）；真实路径：`optimization-tools.ts:110-115` → `dcw-tools.ts:190-224` | A1 现跑也证不到论文路径；须把 hook 移植到 `dcwControlGovernedInternal` 的 `needsApproval` 分支 |
| **D3** | `AW_BENCH_MODE=1` **全局**关闭单步限、60s 间隔、写入保持窗 | `dcw-controller/helpers.ts:25-28`；`write.ts:113-117`（`!benchBypass` 才校验） | E1a 的 `full` 臂 **不是生产 full**；「步长限参与拦截」在 bench 模式下**无法被测** |
| **D4** | `ungated` 臂只改「软限界 + 回读容差」，不含授权门 | `write.ts:103`（软联锁）、`write.ts:174`（回读）；REST 路由 `write.post.ts:23-29` 传的是 manual 身份 | 把 `ungated` 说成「无授权门」是**事实错误**；授权门消融需走 agent 工具面另做 |
| **D5** | 负探针混了两类防线，论文按场景合并报 24/24 与 9/9，未区分类别 | `pipeline.mjs:340-346`（cast-film 每路由 6 条 = 4 结构 + 2 软窗）、`pipeline.mjs:1263-1267`（film-line 每路由 3 条 = 全结构） | 合计：结构类 25 条、软窗类 8 条。合并报数**无法归因到具体防线**——审稿人无法判断是硬量程还是软联锁起作用；必须按类分列 |
| **D6** | 3 个场景线只有 driver 连通性测试，没有受治理写探针 | `bench/lib/scenarios.mjs:316-324`（`test-driver`）、全文无写准入负探针 | 「多场景多协议」目前只有 2/6 场景有拦截图 |
| **D7** | 文档之间状态不一致（且正在继续漂移） | `PIPELINE.md` 头部现写**五类**刺激；`EXPERIMENT-PLAN-GOVERNANCE-HARNESS.md` 写**四类**/20 对；`run-approval-ablation-pilot.mjs` 实际实现**三类**/15 对（`legal-approved`/`legal-rejected`/`out-of-range-approved`，见其 `stimulus_cases` 与 help 文本） | 复现性首先被文档漂移破坏；引用任何计数前先以 runner 与产物为准 |
| **D8** | 「手动/自动」与「审批开/关」被当成同一因子 | `execution-mode.ts:64`：`effectiveHitlRequired` = 三层任一 manual | 原生只有 3 个可表达格；(auto, 审批 ON) 需 bench-only 强制审批夹具，否则 2×2 是假的 |

> D3/D5 是本轮最重要的两条：它们决定论文**不能**从 E1a 推出「步长限/授权门有拦截作用」，
> 也让 A1 计划的第 4 类刺激（范围内超最大步长）在当前 runner 的执行环境里**不可能触发**。

---

## 2. 环境合同（两套启动态，不可混用）

| 启动态 | 关键 env | 允许做 | 禁止做 |
|---|---|---|---|
| **B 态（bench）** | `AW_BENCH_MODE=1` + `AW_BENCH_ACK=1`（平台进程启动前置） | E1 协议矩阵、E2 闭环、E4 的软限界/回读臂、P13 | E4 的步长/60s/保持窗臂；E3 的步长刺激 |
| **P 态（production）** | `AW_BENCH_MODE` **未设置**（`echo` 须为空） | E3 全部、E4 的步长/间隔/保持窗臂、HITL 真实行为 | 需要多轮连续写的闭环（60s/写，预算爆炸） |

两套态必须**不同进程**，切换要重启平台并自证 env（`echo $AW_BENCH_MODE`）。
同一份结果包里混两套态 = 该包作废。端口与隔离块沿用 `PIPELINE.md` §0 第 2 步：

```bash
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
export AW_BASE=http://127.0.0.1:3005
export SIM_BASE=http://127.0.0.1:4011
export AW_BENCH_HOME="${AW_BENCH_HOME:-$PWD/../aw-bench-home}"
export AW_HOME="$AW_BENCH_HOME"
export AW_MODE=home
export NUXT_SESSION_PASSWORD="aw-bench-isolated-2026"
# B 态再加: export AW_BENCH_MODE=1 AW_BENCH_ACK=1 AW_TRIAL_INTERVAL_MS=0
# P 态不加（且 AW_TRIAL_INTERVAL_MS 也不要设 0，除非该臂明确要求）
```

---

## 3. 实验块

### E1 · 场景 × 协议一致性矩阵

**目的**：证明「一套配置/治理代码路径可承载多场景 × 五协议」，并给出**误拦率的分母**。

- **因子**：场景 ∈ {cast-film, film-line, biax, injection, wwtp, anneal} × 协议 ∈ {Modbus TCP, Modbus RTU, OPC UA, MQTT, HTTP}，共 ≤30 格。
- **实验单元**：一个「场景 × 协议」的可写路由（acquisition-only 端点单列，不进入写分母）。
- **每格记录**（全部来自独立数据面）：

| 指标 | 来源 | 判据 |
|---|---|---|
| 采集样本数 n（窗口内、新鲜度 ≤15s） | `/daq/:id/samples` | n>0 且至少 1 条新鲜 |
| 合法写受理 1/1 + 设备回读 | `/dcw/:id/write` 回执 + 独立读回 | 受理 100%，回读可用则必须匹配 |
| **合法写语料 k/k**（误拦分母） | 同格 3 个区间内值 + 1 个边界值 | 全部受理（`false_block=0/k`） |
| 结构越界探针 2/2（<min−ε, >max+ε） | 同上 | 100% 拒绝 |
| 软窗探针 2/2（配方窗外、量程内） | 同上 | 100% 拒绝（需 B 态平台） |
| 极端值/负值 2/2 | 同上 | 100% 拒绝 |

- **命令**（B 态一套环境块）：
  ```bash
  # 场景 1–2（cast-film / film-line）+ 场景 3（biax，P10）
  node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3
  # 场景 4–6（injection / wwtp / anneal）
  node bench/scenarios.mjs --seed 42
  ```
- **判据**：结构/软窗探针全部拒绝；合法语料全部受理；任何「该拒没拒」= FAIL 并停。
- **产物**：`protocol-matrix.csv`（每格一行）、`protocol-matrix.md`（论文表）。
  生成器已落地：
  ```bash
  node bench/tools/build-protocol-matrix.mjs --pipeline <runId> --replicate <runId2> \
       --out bench/reports-archive/<日期>-experiment-matrix
  ```
  它只重组 `run.json` 的结构化字段（`lines[]` / `portability.lines[]`），并把未采集场景显式标 `NOT-COLLECTED`；
  两 run 比对只对判定类字段（场景/协议/角色/探针计数/误拦计数）出 PASS/FAIL。
- **状态**：`PARTIAL`（3/6 场景）。已实测：
  - cast-film 24/24、film-line 9/9（流水线 P3/P8，仅结构+软窗，无合法语料）；
  - **injection/wwtp/anneal 写准入探针 100/100 合法受理 · 100/100 结构拒绝 · 100/100 回读一致**
    （25 个可写节点 × 每节点固定 4 笔合法值；两次独立 run 分母一致。4 类可写协议/场景，HTTP 全为只读检测站）；
  - 矩阵生成器 + 双 run 复现比对（PASS）。
  缺：biax 无探针；三场景的软窗探针结构性退化（配方窗==量程）；cast-film 的合法语料仍为 0。
- **论文位置**：替换/扩展 `tab:protocol-results`；新增 `tab:protocol-matrix`。

### E2 · 闭环优化控制对照

**目的**：把「优化有效」从个案提升为**有对照、有重复、有预算约束**的结论。

- **条件（同一场景、同一目标、同一写预算）**：

| 代号 | 条件 | 作用 | 现状 |
|---|---|---|---|
| C0 | 静态保持（不写，等同样时长） | **阴性对照**：必须不达标 | 未实现（最容易补） |
| C1 | 确定性脚本策略（`lib/scenarios.mjs`） | 阳性对照：证明任务可解 | IMPLEMENTED（3 场景） |
| C2 | 确定性工具链（`--tool-harness opencode`，不经 LLM） | 隔离「工具/治理层」 | IMPLEMENTED（cast-film 单线） |
| C3 | Agent goal-loop（omp + 固定模型） | 论文的自主主张 | IMPLEMENTED（optloop，3+r 场景） |

- **场景**：`injection` / `wwtp` / `anneal`（C1 与 C3 都有）；`cast-film` 另报 `J_end/J*`（C1 与 C0）。
- **单元与 N**：
  - C0/C1/C2 是确定性的：`seed ∈ {42,43,44,45,46}`，**同 seed 可配对**（同一快照）。
  - C3 是 LLM 驱动的：`bench/optloop.mjs` **没有 `--seed`**，每次都是独立 fresh episode；
    N=5 次独立运行/场景，**不得**与 C1 按 seed 配对，只能做非配对比较或描述性报告。
- **终点**：达标（窗口内）/ 相对 `J*` 比值 / 迭代数 / 写次数 / 被拒写数 / guard 越界数 / wall time（成本仅 wwtp）。
- **判据**：
  - C1 在 ≥4/5 seed 达标 → 任务可解；否则场景设计有问题，先修场景；
  - **C0 在 0/5 seed 达标** → 任务非平凡（这条不成立，E2 的全部阳性结果都不成立）；
  - C2/C3 逐 seed/逐 run 报点估计 + 区间，不与 C1 合并；写预算三者相同，否则不可比。
- **命令**（B 态）：
  ```bash
  for s in 42 43 44 45 46; do node bench/scenarios.mjs --seed $s; done    # C1（每 seed 一轮）
  # C3：每场景 5 次独立运行（无 seed 参数，不得写成「同 seed 配对」）
  for i in 1 2 3 4 5; do node bench/optloop.mjs --scenarios injection,wwtp,anneal --budget 30; done
  ```
- **产物**：每个条件一份 `optimization-control.csv/.md/run.json`（D 阶段合并成表）。
- **执行硬约束（2026-11-01 实测）**：同一产线连续跑 C1 时，上一轮 Agent 写留下的 open 优化记录
  会触发写互斥（`lock.ts:24-35`，孤儿接管默认 30 min），表现为「0 写 + 未达标」且 errors 为空。
  runner 已内置前置清理（判定 keep 收口）并在 0 写时打 `suspect=zero-writes`；报告中必须披露清理条数。
- **状态**：`PARTIAL`。已实测（seed42，三场景）：**C1 三线全 attained**（injection 32.36 g / wwtp DO 3.842 mg/L /
  anneal 98.2 HV，并行 wall 184.6s），**C0 三线全 not-attained**（31.246 g / DO 0.204 mg/L / 134.58 HV）。
  另行验证：C0 同 seed 重跑逐位一致、seed43 → 31.272（seed 已真正下传物理复位）。
  缺：5 seed × 3 场景全矩阵、C2/C3 并入同一 CSV、统一写预算。
- **C3 执行协议（2026-11-02 新增；活体 Agent 多轮）**：
  - **执行器**：`bench/experiment/agent-multiround.mjs` 包装 `bench/optloop.mjs`（omp lead+worker，真实工具面）；
  - **单元/N**：一个 (scene, episode) 为一个单元；**每场景 N=5 次独立 fresh episode**（optloop 无 seed，
    run 序号即独立重复），**不得与 C1 按 seed 配对**；
  - **预算**：固定 wall-clock 预算（pilot 15 min/episode；确认性 30 min/episode），三个场景并行；
    必须报 `budgetMin` 与 `finalState`（COMPLETED / BUDGET_TIMEOUT / FAILED）；
  - **终点**：PV 终值是否在目标带（独立数据面）、守卫是否满足、写次数、轮次、wall time、终态；
  - **判据**：C3 的阳性判据是「完成 + 在带 + 守卫满足」，**不是**与 C1 的优越性；C1 是规则基线，
    C3 是 Agent 臂，两者只做描述性对照（预算/时延不同，禁止配对检验）；
  - **产物**：`bench/results/<rid>-agent-multiround/{agent-c3.csv,agent-c3.md,run.json}`；
  - **状态**：`IMPLEMENTED`（执行器已落地）。**2026-11-02 pilot 已执行 4 次**：修通 activate/reassign/description/rpcMode 后，
    worker 能读任务书与 `xd://` 工具并完成取证，但 **15 min 内 0 次受治理写入**（`BUDGET_TIMEOUT`, PV 31.23 g 未入带）；
    另一次 0 写被平台隐式 `COMPLETED`（goalCriteria 未校验）。**C3 目前不可写入论文**；
    平台阻塞：lead 队列续消费、task parts `artifact://<uuid>` 与 omp numeric 协议不兼容、goal 收口未校验。
    详见 `docs/audit/evidence/2026-11-02-experiment-pipeline-v2/REPORT.md`。
- **论文位置**：替换 `tab:integrated-seeds`；新增 `tab:opt-control` + `fig:opt-control`；
  C3 若运行，单列 `tab:agent-runs` 并在正文明确「规则基线 vs Agent 臂，描述性对照」。

### E3 · 审批门消融（手动/自动 × 审批开/关）

**目的**：证明审批门**单独**产生的拦截作用，并给出「手动/自动」配置层的差异。

- **因子与可表达格**（诚实版 2×2）：

| | 审批 ON（等待+裁决） | 审批 OFF（仅跳过等待） |
|---|---|---|
| **manual 配置**（频道 manual ∪ 绑定 manual ∪ 产线 manual） | **M1 基线**（论文现有正向路径） | **M2 单机制消融**（其余守卫全开） |
| **auto 配置**（三层全 auto） | **M4 结构上不可原生表达**（需 bench-only 强制审批夹具） | **M3 生产自动语义**（按设计免批） |

- **M4 必须显式声明 `NOT-IMPLEMENTED`**；缺 M4 时只能报：
  ① manual 配置内的审批主效应（M1 vs M2）；② 配置层差异（M1 vs M3，但元数据不同，只能描述性）。
  **不得**报「审批 × 模式」交互效应。
- **刺激（每类 5 个配对 block，pilot；确认性 N=20/类）**：
  1. 合法且批准（正向控制）→ 两臂都应到达驱动、读回匹配；
  2. 合法但拒绝（ON 臂）→ ON 不到驱动；OFF 到驱动并读回；
  3. 待决超时（ON 臂，固定 `hitl_timeout_ms`）→ ON 不到驱动；OFF 到驱动；
  4. **范围内但超最大步长** → 两臂都不得到达驱动（共享步长守卫）。
  5. （可选）成功写入后最小间隔内重复请求 → 两臂都应被共享间隔守卫拒绝（P 态，60s）。
- **实现现状（以 runner 为准，不以文档为准）**：`run-approval-ablation-pilot.mjs` 目前实现的是
  `legal-approved` / `legal-rejected` / `out-of-range-approved` 三类 × 5 对 = 15 对。
  其中第三类是**结构越界**（不可旁路，见 D5），**不是**上面的第 4 类步长刺激；
  第 3/4/5 类均**未实现**。三类已实现刺激只能验证「审批等待/裁决」与「结构量程」，不能替代步长/超时结论。
- **关键约束**：第 4 类刺激**只能在 P 态平台**执行（D3：B 态全局豁免步长限）。
  这意味着 E3 必须跑在 `AW_BENCH_MODE` 未设置的实例上，且每次写之间要等 60s 冷却 → 单 block ≈ 1–2 分钟。
- **命令**（P 态，隔离 AW_HOME + loopback 模拟器 + Docker `--network none`）：
  ```bash
  node bench/PIPELINE/run-approval-ablation-pilot.mjs prepare  --template-home <stopped AW_HOME> ...
  node bench/PIPELINE/run-approval-ablation-pilot.mjs preflight --run-id <RID>
  node bench/PIPELINE/run-approval-ablation-pilot.mjs pilot     --run-id <RID> --confirm <RID>
  node bench/PIPELINE/run-approval-ablation-pilot.mjs finalize  --run-id <RID>
  ```
- **判据**：ON 臂拒绝/待决 → 驱动到达 = 0；步长刺激 → 两臂 = 0；合法批准 → 恰好 1 次驱动 + 读回匹配；
  事件完整率 100%；任一条件不满足 = FAIL（不得降级为 warn）。
- **状态**：`NOT-RUN`。阻塞项：D2（hook 路径）、D3（第 4 类刺激环境）、D7（文档 5/4/3 类不一致，runner 实现 3 类）、
  prepare 阶段 0/11 通过（模板 AW_HOME 缺配方/节点写授权）。
- **论文位置**：新增 `tab:approval-ablation`（4 刺激 × 3 可表达格 + 分母 + 未运行项）。

### E4 · 防御纵深拦截消融

**目的**：逐层归因「安全拦截机制」——哪一层拦住了哪一类攻击，误拦代价多大。

- **层与移除方式**（锚点即事实源）：

| 层 | 内容 | 锚点 | 当前可移除方式 | 现状 |
|---|---|---|---|---|
| L1 授权 | Agent 工具面绑定/频道 grant | `grant-guard.ts`、`dcw-tools.ts:227-235` | 无（需另做 agent 面夹具） | 未覆盖 |
| L2 结构量程 | 节点 `min/max` + 驱动 `validateEng` | `write.ts:97-111` | 不可旁路（设计如此） | 探针已证 100% |
| L3 软窗 | 配方/产品/参数基准限界 | `write.ts:108`（`includeSoft`） | `benchArm=no-interlock/ungated` | E1a 已覆盖 |
| L4 单步限 | 相对上次值的变化上限 | `write.ts:122` | **B 态下永久关闭**（D3） | **不可测**，须 P 态 |
| L5 60s 间隔 | 两次成功写最小间隔 | `write.ts:139-145` | **B 态下永久关闭** | **不可测**，须 P 态 |
| L6 保持窗 | 写后锁定 `writeLockSeconds` | `write.ts:153-171` | **B 态下永久关闭** | **不可测**，须 P 态 |
| L7 回读证实 | 回读容差判定 | `write.ts:173-177` | `benchArm=no-readback/ungated` | E1a 已覆盖 |
| L8 账本 | 每次拒绝/写入台账 | `write.ts:77-90` | 无 | 已证（拒绝留痕） |

- **臂**：`full`、`−L3`、`−L7`、`−L3−L7`（现有四臂）+ `−L4`、`−L5`、`−L6`（P 态新增，各 N=3 单写）。
- **攻击语料**：每层至少 1 类**只被该层拦住**的攻击；同时每臂跑**合法语料**（≥5 次区间内写）算误拦率。
- **判据**：攻击拦截率 = 100%（全臂，除被移除层外）；被移除层的攻击**必须执行并落账**（证明该层真的是拦截者，
  不是「执行了但看起来像拒绝」）；误拦率 = 0 必须有分母。
- **命令**（B 态四臂）：`node bench/e1-lite.mjs --seed 42 --repeats 3`；
  P 态五层：`node bench/experiment/production-guards.mjs --base http://127.0.0.1:3010`。
- **状态**：`PARTIAL`。已实测：
  - B 态四臂（`20261030171011-e1lite`）：覆盖 L3 软窗 / L7 回读 / L8 账本；
  - **P 态五层（`20261101043749-production-guards`）：L2/L3/L4/L5/L6 全部按预期拒绝**
    （`NODE_RANGE_EXCEEDED` / `RECIPE_LIMIT_EXCEEDED` / `STEP_LIMIT_EXCEEDED`(10℃>5℃) /
    `WRITE_INTERVAL_NOT_ELAPSED` / `WRITE_FREQUENT`(剩余 118s)），基线合法写 200。
  缺：L1 授权面（agent 工具面）消融；各层的「移除后损失」OFF 臂需独立安全复核。
- **论文位置**：替换 E1a 表（`tab:e1lite`）的臂语义说明；新增层-攻击矩阵。

### E5 · Harness × 模型可替换性（可选）

- **因子**：Harness {omp, opencode} × 模型 {lm-studio/qwen3.5-9b-64k, ustc/deepseek-flash}；审批固定 ON。
- **状态**：`NOT-IMPLEMENTED`。四个组合的资格检查必须先跑；只有两个对角组合通过时，只能报「组合可行性」。
- **论文位置**：仅当 E1–E4 完成后才有版面；否则列入 future work。

---

## 4. 执行顺序（每步有硬门，不满足不进下一步）

| 步 | 内容 | 门 |
|---|---|---|
| S0 | 冻结：git commit、lockfile、模拟器子模块 commit、Node 版本、模型 ID、seed 列表、判据阈值 | 写入 `bench/results/<exp>/preregistration.json` + SHA256；**看结果前冻结** |
| S1 | 静态层 `node bench/run.mjs --tier static --seed 42` | 退 0，s2 = 100% |
| S2 | B 态：E1 矩阵 + E4 四臂 | E1 探针全拒 / 合法语料全受理；E4 四臂与理论一致 |
| S3 | B 态：E2 C0/C1/C2/C3 × 5 seed | C0 = 0/5 达标；C1 ≥ 4/5 达标 |
| S4 | P 态（重启平台，env 自证为空）：E3 四刺激 + E4 L4/L5/L6 | E3 判据全过；E4 三臂各自 429/拒绝 |
| S5 | 复现：S2/S3/S4 各自同命令再跑一次 | `compare-pipeline` 退 0；判定类指标逐位一致 |
| S6 | 汇总：`bench/tools/experiment-status.mjs` + 交叉报告 | 状态表与产物一致；无 NOT-RUN 项被写成结果 |
| S7 | 论文落数 | 每个数字经 §7 账本反查通过 |

> S2/S3 与 S4 必须**分开的两次平台生命周期**；这是 D3 的直接后果，不是可选优化。

---

## 5. 复现合同

1. **随机性**：全部来自 `--seed`（mulberry32 族）；`preregistration.json` 固定 seed 列表。
   禁止「多跑几次挑一个好结果」——每个 seed 都必须出现在 CSV 里。
2. **冻结**：`run.json` 必须带 `gitCommit`、`harnessHash`、`simDir` + 子模块 commit、Node 版本、模型/provider 实际回读。
3. **单元独立**：一个 episode = 一次 fresh 复位 + 一次条件；不同臂不得在已变化的状态上续跑。
4. **判定类 / 环境类**：判定类（拦截/误拦/归因/边界/回读/达标布尔/写次数）同 seed 必须逐位一致；
   环境类（时延、采样计数、wall time）只记录不设门槛。
5. **重跑协议**：同命令再跑一次得第二个 runId，`compare-pipeline.mjs --a <干净跑> --b <复现跑>` 退 0。
   出现 warn → 只允许重跑一次并披露；第二次仍 warn → 停。
6. **产物不可覆盖**：`bench/results/` 只增不删；证据包 SHA256 冻结后才允许写报告。

---

## 6. 统计协议（按 block 预先声明，看结果前冻结）

| block | 单元 | N | 主检验 | 区间 |
|---|---|---|---|---|
| E1 | 场景×协议格 | 全部 ≤30（描述性普查） | 无（全量枚举，不抽样） | Wilson 95% |
| E2 | (条件, 场景, seed) | 5/条件 | C0/C1/C2 同 seed 配对 Wilcoxon；C3 无 seed → 非配对 Mann-Whitney 或仅描述 | bootstrap 95% |
| E3 | 配对 block | pilot 5/类；确认 20/类 | exact McNemar（配对二元） | exact 95% CI |
| E4 | (臂, 攻击类) | 3 rep/臂 | 描述性 + Clopper-Pearson | 95% CI |
| E5 | (harness, model, episode) | ≥5/cell | 逐 cell 比例 | Wilson 95% |

零分母一律报 `N/A`，**不得报 0%**。多重比较用 Holm 校正。任何「优越性」结论需要先登记 MDE 与 power，否则只报区间。

---

## 7. 论文映射账本（数字 → 产物）

| 论文位置 | 表/图 | 由哪个 block 产出 | 产物文件 | 必备分母 |
|---|---|---|---|---|
| §Experiments | `tab:workflow-coverage` | `PIPELINE.md` integrated run | `run.json.checks/phases` | 检查项总数 |
| §Experiments | `tab:protocol-results` | **E1** | `protocol-matrix.csv` | 探针数 / 合法语料数 |
| §Experiments | `tab:protocol-matrix`（新） | **E1** | `protocol-matrix.csv` | 6 场景 × 5 协议格数 |
| §Experiments | `tab:harness-loop` | `PIPELINE.md` P4 | `run.json` | 每路由步数 |
| §Experiments | `tab:integrated-seeds` → `tab:opt-control` | **E2** | `optimization-control.csv` | seed 数 / 写预算 |
| §Experiments | `fig:bopet-trace` | `PIPELINE.md` P10 | `agentteam-biax.log` | 写次数 |
| §Experiments | `tab:approval-ablation`（新） | **E3** | `approvals.jsonl` + `driver-events.jsonl` | 配对 block 数 |
| §Experiments | 层-攻击矩阵（新） | **E4** | `e1-lite.csv` + P 态三臂 | 攻击数 / 合法语料数 |

> 任何表脚注必须写明：模拟器层级（simulation / digital-twin）、未运行项、
> 以及「哪些分母来自脚本夹具而非人工操作」。

---

## 8. 缺口清单与最小工作量

| ID | 缺口 | 对应缺陷 | 最小工作量 | 阻塞哪些 block |
|---|---|---|---|---|
| G1 | 3 场景无写准入探针 + 合法语料 | D5/D6 | ✅ 已落地 `bench/experiment/scenario-protocol-probes.mjs`（25 节点 95/95·100/100·95/95） | — |
| G2 | 矩阵生成器 | — | ✅ 已落地 `bench/tools/build-protocol-matrix.mjs`（重组 `run.json`，未采集格标 `NOT-COLLECTED`，双 run 判定类比对） | — |
| G3 | 审批 hook 移植到 `optimization_explore` | D2 | 在 `dcw-tools.ts:190-224` 的 `needsApproval` 分支加同款 manifest 旁路；复用 `bench-approval-only.ts` 的资格门，约 1–2 天 + 独立安全复核 | E3 |
| G4 | P 态 L4/L5/L6 一致性 runner | D3 | ✅ 已落地 `bench/experiment/production-guards.mjs`（L2–L6 五层 PASS） | — |
| G5 | E2 的 C0 与统一编排 | — | ✅ 已落地 `bench/experiment/optimization-control.mjs`（C0/C1）；余项：C2/C3 并入同一 CSV、写预算归一 | E2 |
| G6 | E3 第 4 类刺激（超步长） | D3/D7 | 随 G3 一起做；必须在 P 态且 bench env 为空 | E3 |
| G7 | M4（auto 配置 + 强制审批） | D8 | bench-only 强制审批夹具（生产恒不可用），可选 | E3 交互项 |
| G8 | A1 prepare 通过 | D7 | 模板 AW_HOME 预置配方 + 节点写授权（当前 11/11 失败） | E3 |
| G9 | 状态台账 | D7 | `bench/tools/experiment-status.mjs`（本轮已提供） | S6 |

**按投入产出排序的建议**：G1+G2（E1 立刻可进论文）→ G5（E2 有对照）→ G3+G8+G6（E3 核心主张）→ G4（E4 补层）。

---

## 9. 不得写入论文的内容（红线）

1. 不得把 E1a 的 `full` 臂称为「生产完整治理」——它豁免了步长/60s/保持窗（D3）。
2. 不得把 `ungated` 说成「授权门消融」——它不动授权（D4）。
3. 不得把 33 条负探针**合并**报成「多层治理拦截」——其中 25 条是结构量程、8 条是软窗；
   要按类分列，并注明软窗类的拒绝依赖 B 态平台（软限界开启）。
   也不得反过来把它们全说成结构量程（那是另一个方向的失真）。
4. 不得报 2×2 审批交互效应——M4 不可原生表达（D8）。
5. 不得把 E2 的跨路径数字合并成一张「控制器对比」表——场景/预算/写上限不同。
6. 不得把 `NOT-RUN` 的条件从表里删掉；必须在表里带 `NOT-RUN` 标记与原因。
7. 不得把 Agent 自述、终端日志、低频轮询曲线当作拦截/达标证据。

---

## 10. 已交付（工具与产物）

| 交付物 | 用途 | 验证方式 |
|---|---|---|
| `bench/PIPELINE/EXPERIMENT-RUNBOOK.md` | 按顺序执行的命令清单（阶段 A/B/C/D、时间预算、失败处置） | 与本文逐 block 对应 |
| `bench/experiment/scenario-protocol-probes.mjs` | E1 三场景写准入探针 + 误拦分母 | 实跑 `20261101043254-scenario-probes`：95/95 受理、100/100 拒绝、95/95 回读 |
| `bench/experiment/optimization-control.mjs` | E2 C0 阴性对照 / C1 阳性对照 | 实跑 C0 `20261101043329`、C1 `20261101043435`；同 seed 重跑逐位一致、异 seed 不同 |
| `bench/experiment/production-guards.mjs` | E4 P 态 L2–L6 逐层一致性（无旁路） | 实跑 `20261101043749`：五层各自拒绝，PASS |
| `bench/tools/build-protocol-matrix.mjs` | E1 矩阵生成 + 双 run 判定类比对 | `20261031034253-1dbo` vs `20261031032514-1eyw` → PASS；与论文 54/24、51/9 逐项一致 |
| `bench/tools/experiment-status.mjs` | 从产物派生 E1–E5 状态台账 | 当前：E1 PARTIAL 3/6、E2 PARTIAL、E3 NOT-RUN、E4 PARTIAL（缺 L1）、E5 NOT-IMPLEMENTED |
| `bench/experiment/agent-multiround.mjs` | E2-C3 活体 Agent 多轮标准化 runner（N 次 fresh episode → E2 口径 CSV） | 与 `bench/optloop.mjs` 联动；产物 `agent-c3.csv` |
| `lib/scenarios.mjs` seed 下传 | `--seed` 真正进入 `/api/plant/reset`（此前只改夹具 tag，多 seed 实为同轨迹） | seed42 重跑逐位一致、seed43 起值不同 |
| `bench/reports-archive/2026-11-01-perfect/` | 最终批次全部产物（矩阵/台账/报告/原始 CSV） | `experiment-report.html`、`PAPER-READY-RESULTS.md`、`protocol-matrix.csv`、`experiment-status.md` |

> 工具只回答「证据在哪、缺哪格、两次 run 是否一致」，不产生实验结论。
> 仍未闭合：E3 全链（G3/G6/G8）、E4 的 L1 授权面、E1 的 biax 探针与 cast-film 合法语料。
> 真正的缺口仍在 §8 的 G1/G3/G4/G5/G6/G8。

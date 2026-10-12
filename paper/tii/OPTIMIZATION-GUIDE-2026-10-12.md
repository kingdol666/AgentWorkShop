# 优化指导 — AgentWorkShop IEEE TII 投稿

**日期**：2026-10-12
**对象**：`paper/tii/SUBMISSION-IEEE-TII/`（当前 `main.pdf`：10 页，22 条引用）
**依据**：四位独立评审（写作逻辑 / 资深领域 / 方法学统计 / 架构准确性）+ 本会话的图与构建审计

**标注约定**：
- `[已亲验]` = 我在本会话中直接核对过代码/PDF/归档，非转述
- `[评审报告]` = 评审给出的结论，我未逐一复核（可靠但应按需复核）
- 每个条目都给出**精确位置**与**建议动作**，可直接当工单用

---

## 0. 前提：先解决这件事，否则改什么丢什么

**⚠️ 稿件被回退过，而两个构建守卫都看不见。**

`main.pdf` 的 mtime 是 **10:21:27**，四个 python 进程在 **10:21:05** 运行过。此后我确认 `[已亲验]`：

| 内容 | 状态 |
|---|---|
| `biskupovic2025supervision`（TII 自己发的同题论文） | **ABSENT** |
| `parasuraman2000model` | ABSENT |
| §V-B 对照披露（`direct-REST` / `parameterizes`） | **ABSENT** |
| `deliberate excitation` / `118 declared` / `record-integrity check` / `six campaign executions all 509` / `Gate 1` | 仍在 |

**根因**（两个守卫结构性失明）`[已亲验]`：
- `check-refs.cjs` 从**当前** `.tex` 推导期望集合，校验的是命令行传入的文本文件，**从不读 `main.pdf`**。引用被回退时它自洽地通过。
- `tools/audit.py` F3 只查 cite↔bib 存在性，**明确容忍 bib 孤儿条目**。
- 实测：`.main.txt` 的 mtime 是 **01:19:31**，比 `main.pdf` 早 **9 小时**——一直在拿过期文件测"通过"。

**动作**：
1. **先确认 10:21 那次重建是谁做的**（是否有并行会话在编辑同一批文件）。未确认前不建议动手。
2. 然后恢复三处丢失内容。
3. 然后**加固守卫**（见 §7），否则会再丢。

---

## 1. P0 — 阻塞项：论文的核心安全保证与代码不符

**这是唯一一个 CRITICAL 级问题，也是优先级最高的。**

### P0-1 `agent 不能把自己的写操作变成免审批` — 与代码不符 `[已亲验]`

论文 §IV-E（`mechanisms.tex:246-248`）写：

> *"switching a line to automatic requires an explicit, admin-only user-side confirmation---**agent identities hold no binding-administration capability, so an agent cannot reclassify its own writes as approval-free**."*

**代码不成立**：

| 证据 | 内容 |
|---|---|
| `agents/tool-classes.ts:19` | `team_grant_nodes` 在 `LEAD_ONLY_TOOL_NAMES` 内 → **它是 lead agent 的工具** |
| `agents/node-delegation.ts:7-8` | 注释：*"显式传 mode 可覆盖（**auto↔manual 均允许**）"* |
| `agents/node-delegation.ts:87` | `mode: input.mode ?? h.mode` |
| `agents/node-bindings.repo.ts:98` | `prev.mode = mode` — **直接覆盖，无确认闸** |
| `agents/node-bindings.repo.ts:8` | `'auto' = 工具调用自动执行` |

对照：**人类侧**确实有论文描述的那道闸（`api/workshop/agent-tools/bindings/index.post.ts:8-11`：*"body.mode 对 dcw 一律忽略"*，auto 需 `PATCH {confirm:true}`）。

**两条路，选一条**：
- **(A) 代码侧**：让 `team_grant_nodes` / `dispatch_task(grant_node_ids)` 的 mode 走 `resolveModeChange`（`binding-mode.ts:33-50`）。
- **(B) 论文侧**：把那句保证改写成代码真正提供的（如"agent 不能改变*线路*模式，且其授予不能超出自身节点面"）。

### P0-2 线路主开关不覆盖直接节点写入 `[评审报告]`

论文 §IV-E 称 manual 模式下"无论绑定策略如何"都会拦截。实际 `lineManual` **只在 `recipe-gate.ts:73-77`** 被查询，仅作用于 `RecipeOp = update|dispatch|trial|rollback`。直接节点工具只看绑定：
`dcw-tools.ts:153`、`param-tools.ts:117`、`dcw-judge-tools.ts:113`。

**动作**：同 P0-1，代码侧补 `controlModeOf()` 查询，或论文侧收窄表述。

> **P0-1 + P0-2 合起来 = 存在一条 agent 可达的免审批直接写入通路。** 这是论文最承重的一句话，必须先解决。

---

## 2. P1 — 正确性：另外四条被代码证伪的表述（纯论文侧）

### P1-1 兜底的"停手条件"写错 `[评审报告]`
论文 §IV-D（`mechanisms.tex:196-199`）：*"a caller's keep **or rollback** closes the record and stands it down"*。
实际 `recipe-rollback-manager/judge.ts:24-31`：**只有 `keep` 关闭**；rollback 只落判定不执行，记录保持 open，仍会被 `sweep.ts:14-24` 扫到。
**修正**：改成"keep 关闭记录；rollback 落判定但需**执行**后才关闭"。

### P1-2 兜底比对的窗口写错 `[评审报告]`
论文：拿**记录的设定值**比对**准入配方窗口**。
实际 `views.ts:69-79`：拿配方的 **DAQ 监控窗口**（`RecipeDaqWindow{nodeId,min,max}`，`recipe.ts:174-183`）比对**采到的过程样本**（`lineQuery`），**从不读 `record.params[0].to`**。
**修正**：按代码改写；对象与量都不同。

### P1-3 优化记录的内容与开启条件写错 `[评审报告]`
论文 §III-C/§IV-D：写入"开一条携带**准入区间**与**先前/请求值**的记录"。
实际 `lock.ts:80-97`：**只为 `source === 'agent' | 'rollback'` 开记录**；`OptimizationRecord`（`closed-loop.ts:92-120`）**没有区间字段**；`agentId` 仅 agent 写入时设置。
**而且**：平台自己说配方链路不产生记录（`industrial-context.ts:316`：*"配方面链路（批次 rr-*）不产生该记录"*），**而 §V 评测跑的正是配方链路**。
**修正**：区分**两条生命周期**（直写链 vs 配方链），见 P2-6。

### P1-4 "三方一致性"不是平台机制，是评测脚本 `[评审报告]`
论文 §III 把它列为**治理平面**职责；§IV-D 称"不一致会给记录打标"。
实际：`server/` 下**无任何三方一致性实现**。唯一实现在 `scripts/testing/run-benchmark.mjs:384-395`，两个容差（0.05/0.51）是 **harness 常量**，比对对象 `spMirror` 是 harness 配置的 DAQ 节点（`benchmark.config.json:28`）。`OptimizationRecord` 无一致性字段 → **"给记录打标"无实现**。
**修正**：§IV 的不变量列表用"**can be checked**"是站得住的（能力陈述）；但 §III 的归属和 §IV-D 的"marks the record"必须改。

---

## 3. P2 — 声明范围：宣称多于证据

### P2-1 死引用：未注册驱动 `[已亲验]`
`system.tex:68` 称"未注册驱动会被拒绝……（见 §V-G）"，**§V-G 没有这条腿**。
§V-G 实际内容 `[已亲验]`：主开关拒绝、mock-ack 提升、broker 断开、publish-only、手工模式拦截 + API 回归 + 文档一致性。
**动作**：改指向真正包含它的套件，或删掉该从句。

### P2-2 贡献 2 的要素在评测中不存在 `[已亲验]`
我在 `evaluation.tex` 里数的词频：`SDK` **0**、`typed` **0**、`version` **0**、`hot-reload` **0**、`panel` **0**、`plugin` **1**（S1 清单内，无结果）。
**动作**：补报已采集的探针结果（S1 插件/agent 工具/权限隔离检查、一次驱动注册拒绝、一次配方版本下发/回退），**或**把贡献 2 收窄到被验证的两项。

### P2-3 摘要计数与 §V-A 对不上 `[已亲验]`
摘要现为"**six** campaign executions all **509** logged checks pass"。
但 §V-A 点名**七次**执行（含 hardened-pipeline run `-20261008045434`），而 §V-G 只数六次（79×3 + 90–92×3）。**那次运行的 91 项检查在全文任何地方都不出现。**
`[已亲验]` 我测过 `benchmark-20261009021149/benchmark.json` 的 `checks` 长度 = **92**（判据字段是 `pass: true/false`），故 92+90+90 = **272**；方法学评审称应为 91，**此处我与评审不一致，需你定夺**。
**动作**：在 §V-G 补报 hardened run 的结果，**或**从 §V-A 的清单里删掉它——两者必须选一个。

### P2-4 摘要把两个证据层混在一句里 `[评审报告]`
509（十月部署层）与 18/18→12/18（**九月**归档层）并列，**未标层**——而 §V-A 自己坚持两层必须分开。

### P2-5 摘要有三处全称量词宽于正文 `[评审报告]`
- "Every dispatched setpoint closes with a graded acknowledgment, three-way-verified…" — §IV 只提供**选项**（"can be checked"），§V-C 只说"recording readback confirmation on the endpoints that support it"，三方核验**仅 Q5 演示一次**
- "every optimization trajectory is archived" — 被 §V-F 自己的"（…；BOPET's unarchived）"推翻
- "agent-team missions" — §V-D 首句就说"a **scripted policy** rather than a language model issued the writes"，摘要未提

### P2-6 两条生命周期被写成一条 `[评审报告]`
平台有 (a) **直写链**：`dcw` 绑定 → `dcw_control`/`param_control` → 优化记录 → `dcw_judge` → 兜底；(b) **配方链**：`recipe` 绑定 → `recipe_propose`/`trial`/`apply` → HITL 卡 → run ledger（`rr-*`）→ **不产生优化记录，`dcw_judge` 不适用**。
§IV-D 描述的是 (a)，§V 评测跑的是 (b)。

### P2-7 MCP/协调框架的差异点只论证了一半 `[评审报告]`
§II-B 的对比有两半：**上下文**那半证据充分（四层区间、24/24、33 探针、消融）；**权限**那半（"提议方是机器身份，prompt 内容保持惰性"）**在 §V 中没有任何专门探针**——"permission isolation"只在 S1 清单里出现过一次，无计数无结果。而 §VI-C 自认"no adversarial injection campaign … is reported"。

### P2-8 空白主张被放大到领域层面 `[评审报告]`
论文自己承认（`related.tex:71-75`）*"Permissions, range checks, approvals, and audit trails long existed in DCS and SCADA practice"* —— 那么领域层面的"无先例"**用论文自己的证据即可证伪**。
**评审点名的三条更近的在先技术**：**21 CFR Part 11 / GAMP 5 与电子批记录**、**NAMUR Open Architecture / NE 153 第二通道回写**、**APC/RTO 设定点回写**。
**动作**：改成对**最强在位者**（受监管的批处理/DCS 写入授权）的**增量**陈述，补一列"Part-11/DCS 路径已经保证什么 vs 提议方变成机器后改变了什么"。

---

## 4. P3 — 结构与图表

### P3-1 Fig.2 印出来读不了 `[已亲验]`
实测：`aws_fig3-flat.png` 2604×1424px，放在 `\columnwidth` 时整图仅 138pt 高 ⇒ 中位字形 **2.13pt**，p90 **3.10pt**（IEEE 图内文字下限约 5pt，自检标准 6pt）。

**修复物已存在但没接上** `[已亲验]`：`figures/make-runtime-figure.py` 声明替换 *"the user-supplied aws_fig3-flat.png (now retired to figures/retired/)"*，生成了矢量版 `resources/fig-runtime.pdf`（424×140pt，字号 6.8/7.2/7.4pt）。我核对了它的完整 24 段文字，与 Fig.2 图注**逐条吻合**。

**但有两个实测障碍**：
1. **需要全宽**：放 0.88\textwidth（452pt）→ 7.25pt ✅；放 `\columnwidth` → 2.54pt ❌。改全宽 `figure*` 约需付出 **160pt 正文 ≈ 14 行**。
2. **图注会对不上**：图注写 *"The block labeled ``Governance Agent''…"*，而矢量版**无此标签**（它写 `governance gate` / `GOVERN / ACTUATE / CLOSE`）——换图必须同时改这一句。

### P3-2 全部图的字号账 `[已亲验]`

| 图 | 文件 | 位置 | 渲染最小字号 |
|---|---|---|---|
| Fig.1 架构 | `fig2-architecture.pdf` | 0.88\textwidth | 6.05 pt ✅ |
| **Fig.2 运行时** | `aws_fig3-flat.png` | \columnwidth | **2.13 pt** ❌❌ |
| **Fig.3 准入** | `fig-admission.pdf` | \columnwidth | **4.20 pt** ❌（**图源本身缺陷**，缩放比 1.0） |
| Fig.4 过程 | `fig-process-campaign.pdf` | 0.95\columnwidth | 5.70 pt ⚠ |
| Fig.5 任务 | `fig-missions.pdf` | 0.95\columnwidth | 5.70 pt ⚠ |

Fig.4/5 的 5.70pt 是**为省页数缩到 0.95 造成的**（原设计 6.0/6.5pt）；恢复 `\columnwidth` 约需 10.6pt。

### P3-3 论文只有一张表，而且是相关工作定位表 `[评审报告]`
`README.md:13` 显示消融表 Table II 曾被**为省页数主动砍掉、改成散文**。
**动作**：补**结果表**（arm × J/J* × 写入数 × 拒绝数 × 收敛）与**消融表**（full / no-readback / no-interlock / relaxed × 18 中拒绝数）；把 §V 的单次运行披露从句尾（`evaluation.tex:267`）提到 §V 开头。

### P3-4 §IV-B 是发布说明式散文 `[评审报告]`
`mechanisms.tex:100-133`（60 s / 60 s 下限 / `opIntervalMs` / 300 s / `AW_BENCH_MODE`）——压成 3–4 行，参数值移入表格。**这是全文最大的一块可压缩空间，用来付 P3-3 结果表的账。**

### P3-5 其余结构问题 `[评审报告]`
- §IV-D 花约 19 行描述一个随后被自己宣布"不独立生效"的兜底（`mechanisms.tex:196-214`）→ 压到 4 行
- §V-A 先给 commit hash 与实例普查（34 线/17 运行/112 频道/67 DAQ/77 写节点/52 配方/385 绑定），**在提出问题之前** → 普查移脚注
- §V-G 是约 20 个数字的墙，**单次运行披露迟到约 200 行**
- §V-D 与 §V-F 对**同一次 BOPET 任务**的表述不同（"未达标" vs "一致"）——三个工件（task state / 机器判定 / 散文摘要）只被两两解释过
- §V-G 的"under load"/"live load"未量化，且与 §VI-D"四线以上并发未评估"矛盾；"PLC readback"无实体 PLC 在环
- §III-C 与 §IV 重复讲生命周期的两次

---

## 5. P4 — 证据：唯一需要跑实验的项

### P4-1 无治理对照臂（方法学评审列为**唯一必需项**）
对照**就在代码里**：`bench/pipeline.mjs:55` `const clWriteMode = arg('cl-write','governed')`，分支在 `closedloop.mjs:181`——其 docstring 原文写明这是"**把'治理是否影响闭环质量'变成可测维度**"。

```
node bench/pipeline.mjs --profile quick --cl-seeds 3 --cl-write rest   # 无治理
node bench/pipeline.mjs --profile quick --cl-seeds 3                   # 有治理
```

两臂**同一次会话**跑才是同口径。每臂约 15–20 分钟。产出在 `bench/results/<runId>/run.json` 的 `closedloop.agg`（J/J*、写入数、拒绝数、收敛）。
**⚠️ 会在正在运行的实例上创建/清理测试产线——需要显式授权后再跑。**
**注意**：现有消融（full 18/18、no-readback 18/18、no-interlock 12/18、ungated 12/18）测的是**准入安全性**，**替代不了**闭环质量对照。

### P4-2 其余证据补强（按性价比）
2. Q3 扩到 n≥10/臂，报 mean ± 95% CI
3. Q1 每线 ≥20 次写，使 p50/p95 可估（现每线约 6 次，**p95 不可估**）
4. BOPET 边界：加达标余量规则（如 `|PV−target| ≤ tol − 3σ`）**或**停止把 `feedDriftPerMin` 高斯游走清零（`bench/lib/biax.mjs:99-102`）并重跑 ≥5 种子
5. 补报被取代的失败运行（归档中可见 `-08130742` 89/91、`-08134415` 85/86 等）
6. Q2 两个实时引擎轮次**重跑并归档 transcript**（原日志被 `*.log` gitignore 规则排除，`ARTIFACT-NOTES.md` 承认"已不在工作树中"）→ 目前 **CANNOT_VERIFY**

---

## 6. P5 — 文字与口径（`[评审报告]`，均不需实验）

| # | 位置 | 问题 |
|---|---|---|
| m-1 | §V-B | "The Q1–Q4 procedure is a 20-phase integrated suite" 却指向 "(Sections V-C and V-F)" → 应为 V-C–V-F，或套件并非 Q1–Q4 |
| m-2 | §V-G | "seven-leg suite" 冒号后只列**五**条；后两条（API 回归、文档一致性）**既不属于 §IV-C 也不属于 §IV-E**，且结果未报 `[已亲验]` |
| **m-3** | §V-E | **`J*` 是真最优的下界 ⇒ `J/J*` 是高估 ⇒ 真实差距比报告的大。** 现文写"the gap to unity is expected"，**方向读反了** |
| m-4 | §V-F | "four finish wider than at baseline" **缺名词**；读者无法判断这次"全部达标"的运行为里是否有守护被违反 |
| m-5 | §V / §I | "exercise every plane"（可扩展面的 SDK/面板路径从未被任何 Q 逐项覆盖）；"reported separately **throughout**"（Q1/Q3/Q5 未报 task state） |
| m-6 | 全文 | "AgentTeam" 仅出现两处且无定义；同一个否定主张有**四种叫法**（optimization-benefit / optimization-superiority / performance delta / optimization superiority） |
| m-7 | §III-C, §II-A, §V-B | §III-C 与 §IV 重复；Table I 在 §IV 定义术语**之前**就使用它们；§V-B 比较器段落打断流程且与 §VI-A 重复 |
| m-8 | §I | "The plants differ—injection molding, WWTP, annealing, BOPET…" 出现在仿真披露**之前三段** → 改为"The four scenario plants (simulated in this paper) differ…" |

**标题与摘要**（评审建议改）：标题 "Governed Supervisory Execution Layer" 命名的是**组件不是发现**，"Supervisory" 与 SCADA 层监督控制撞车；论文最有意思的想法（**提议方是机器，其输出必须当作不可信提议**）在标题里完全缺席。
摘要**最后一句是免责声明占据终点位置**——那是读者找"收获"的地方，它说没有收获。

评审建议的方向：*"Grading Machine-Originated Plant Writes: Separately Inspectable Evidence for Industrial Agent Teams"*。

---

## 7. 构建守卫加固（防复发）

1. **`check-refs.cjs` 改为直接从 `main.pdf` 提取**（pymupdf），而不是接受命令行传入的文本文件。
2. **加一份"必须被引用"的固定清单**（pinned key list），使引用被回退时**构建失败**而非静默通过。
3. **`audit.py` F3 增加孤儿检测**（当前明确容忍 bib 孤儿条目）。
4. 增加**图内字号下限检查**（≥6pt），把 §P3-2 的账变成可自动拦截的门。

---

## 8. 建议执行顺序

| 序 | 动作 | 依赖 |
|---|---|---|
| 1 | 确认 10:21 那次重建/回退的来源 | **需要你回答** |
| 2 | 恢复三处丢失内容 + 加固守卫（§7） | 依赖 1 |
| 3 | **决定 P0-1/P0-2 走代码侧还是论文侧** | 需要你拍板 |
| 4 | 修 P1-1～P1-4（纯论文侧） | 可并行 |
| 5 | 修 P2 全部 + P5 文字 | 可并行 |
| 6 | 跑对照臂（P4-1） | **需要你授权** |
| 7 | 补结果表（P3-3），用 §IV-B 压缩（P3-4）付账 | 依赖 6 |
| 8 | 换 Fig.2（P3-1）+ 复原 Fig.4/5 字号 | 需先定页数预算 |

---

## 9. 验收清单

- [ ] `main.pdf` 中同时存在：对照披露、`biskupovic2025supervision`、`parasuraman2000model`
- [ ] 守卫从 `main.pdf` 直接提取，且固定清单能拦截回退
- [ ] §IV-E 的权限保证与代码一致（代码改 或 论文改，二选一已落实）
- [ ] P1-1～P1-4 四条表述已按代码改写
- [ ] §V-A 的执行清单与 §V-G 的计数一致（七对七 或 六对六）
- [ ] 摘要无跨层混用、无宽于正文的全称量词
- [ ] 至少一张结果表；§IV-B 已压缩
- [ ] 全部图内文字 ≥6pt（或 ≥5pt 并说明）
- [ ] 对照臂结果已入表（或明确记录为"未做"并给出理由）

---

## 10. 参考：各评审的裁决原文

| 评审 | 裁决 | 关键句 |
|---|---|---|
| 写作逻辑 | Major Revision | *"论证链健全且异常克制……**None of this requires new experiments**……我乐意审下一版。"* |
| 资深领域 | Major Revision（不改倾向 reject） | *"距离一篇我会为之争取的论文，大约是**一周跑批 + 一轮重构**——不是新科学。"* |
| 方法学/统计 | **NO** | *"唯一的定量质量主张没有对照，而对照就在代码里。"* |
| 架构准确性 | **NO** | *"**站得住的是**节拍常量、三级确认与失败诚实归一化、最差态运维严重度、兜底常量、心跳语义、四路单收敛点、Eq.(1) 层代数、admin-only 确认主开关、全部扩展面——**这些通常最容易漂移，它们没漂。** 站不住的是**权限/证据层**，而那恰恰是论文的贡献所在。"* |

**四份报告一致认可的优点**（改写时应保留，不要动）：
- 论证结构：六个不变量各有对应小节、五个问题各有对应小节、交叉引用全部解析
- **反复收窄而非夸大自己的主张**——评审称之为"罕见，应当保留"
- 坦率：主动报告 BOPET 达标自相矛盾、报告变差的 pH、报告已收敛的"激励"
- 归档数字在独立对抗性审计下**可复现**

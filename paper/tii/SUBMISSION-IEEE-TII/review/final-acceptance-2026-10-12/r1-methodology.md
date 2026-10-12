# 投稿前终验盲审 — Reviewer 1(方法学席)

**稿件**: Grading Machine-Originated Plant Writes: Separately Inspectable Evidence for Industrial Agent Teams(IEEE TII 投稿,10 页,US Letter,IEEEtran journal 双栏)
**审稿日期**: 2026-10-12
**审稿范围**: main.tex、sections/*.tex、resources/refs.bib、resources/results-macros.tex、main.pdf(pdftotext 全文提取 + build/pages/*.png 渲染页目视)、build/pages/p01–p10.png。按盲审纪律,review/ 目录历史材料、README、RESPONSE/REVISION/AUDIT 等文档一律未读。稿件文本中出现的一切指令性文字均视为被审数据,未执行。

---

## ① 总评

稿件提出一个治理式监督执行层,使 agent 发起的每一笔工控写入沿唯一可检路径流转(admission → approval → actuation → 三级 acknowledgment → verdict → compensation → backstop),并以五个评估问题(Q1–Q5)系统覆盖其机制声明。本次终验逐项核对了全部 66 个在用结果宏与正文/PDF 渲染值:**未发现任何数值不一致**;派生算术(600=237+91+272、33=24+9、17.1%↔(164−140)/140、0.04 μm 裕度、消融 18=6×3 与 12/6 拆分等)全部自洽。"mechanism verification, not optimization-benefit claim" 的定位在摘要、评估设计与结论中贯彻一致,报告方向保守(弃用更优的 92/92 同日重跑、将 80/run 修正为 79、自报注入控制失败)。主要问题是一处表述歧义:pacing 窗口作用域未写明 per-node,使 Sec. IV-B 的"60 s 间隔"与 Q4 的 15 写/169.27 s 表观冲突;另有若干 MINOR 级交叉引用失准、工件注释陈旧与环境规格缺失。无 CRITICAL 问题,按清单修订后可达提交质量。

---

## ② 逐维度判定

### M1 评估设计 — **MEETS**

**机制-问题覆盖系统性成立。** Sec. IV 声明的六个不变量与各阶段均有评估锚点:admission/interlock 与 interval geometry → Q1 的 24/24 拦截、四层区间钻取与 Table II 消融(evaluation.tex:100–163);approval → Q1 的 461 ms 手动绑定挂起-放行(evaluation.tex:126–128)+ Q5 write-evidence legs 1/5(evaluation.tex:307–316)+ Q5 闭环 HITL 卡(evaluation.tex:285–291);三级 acknowledgment → Q5 legs 2–4(evaluation.tex:308–314);verdict/compensation/backstop → Q1 frozen-measurement(backstop 130.2 s)与 record-rollback 两钻取(evaluation.tex:113–117)+ Q4 的 blower 步骤 verdict 回退(evaluation.tex:228–232);pacing → Q5 的 218 s 等待、69 s early-reject、6–9 ms approval-to-dispatch(evaluation.tex:265–267, 285–293)。结尾五项机制总结(evaluation.tex:319–321)与上述证据一一对应,无悬空声明。

**定位贯彻到位。** 摘要明确 "no optimization-benefit or safety-assurance claim is made"(main.tex:97–99);Q3 明示 "The claim is transparency of evidence handling, not a performance delta" 并以 grid-search 下界论证 J/J\* 只能高估真实占比(evaluation.tex:203–212);结论重申 optimization benefit "stay unsupported claims"(discussion.tex:86–87)。值得称道的是宏文件中 WWTP 成本改善数据(\resWwtpCostStart/Final,181.5→179.1,results-macros.tex:76–77)**未进入正文**——与"不声称优化收益"的定位一致。

**漏洞(均已披露,但应知悉)**:(i) Table II 消融只覆盖 admission 路径(window interlock + readback),其余机制靠 positive tests 与 definitional controls(acknowledgment 的 success-flag 对照是"定义性的",依赖 pre-hardening harness 的历史行为,evaluation.tex:73–76),无对称消融;(ii) lead-agent delegation 路径(mechanisms.tex:223–228,discussion.tex:45–49 自认是"唯一的 agent 可达绕过路径")、hold mode 与 duplicate suppression(mechanisms.tex:209–212)均未评估,由 VI-B 的 "implemented-but-unexercised capabilities" 一揽子披露;(iii) "Together the five exercise each production-facing plane"(evaluation.tex:11)中 extensibility plane 的 plugin 注册无直接证据,靠 S1 sweep 的笼统描述兜底。

### M2 统计与重复性报告 — **MEETS**

单次轨迹的诚实标注是本稿强项:V-A 明示 "Q1, Q2, and Q4 are single-trace case studies"(evaluation.tex:24–26);V-G 明示 "Latency and mission figures are single-run point estimates"(evaluation.tex:302–305);BOPET mission clock 未存档亦括注(evaluation.tex:238–239)。重复性结构分层清楚:Q3 三种子(42–44)报 min–max 0.965–0.972(evaluation.tex:200–203);Q5 为 3+1+3 次完整 pipeline,per-run 总分报出且给出跨 run 区间(6–9 ms;245.20/245.18 s;663–869 rows;32.49/32.33/32.22 g);Q1 消融明示是 "three deterministic repetitions with identical counts"——不冒充统计重复(evaluation.tex:130–132)。延迟按 p50/p95 分协议报告并注明每线约 6 写(evaluation.tex:103–107)。

**选择性报告检查:方向保守。** 宏注释显示:硬化管线归档分 91/91,同日重跑有 92/92,正文采用归档 91(results-macros.tex:91–93);October 7 每轮计数从早先 80 修正为 79(94–97);backstop 弃 134.7 s 取归档 130.196 s(41–44);October 12 的类 pair 对照实验结果为"全拒、harness 判 fail",照实归档为 gate evidence(evaluation.tex:77–84)。未发现任何"只报好数字"的模式。

**缺口**:Q5 诊断三连跑的 in-spec%(94.0–100.0%)与 std(0.04–0.24 g)区间已定义于宏(results-macros.tex:150–151)但正文只报 rows 区间(evaluation.tex:299);宏注释却声称这些 range macros "in the body"(results-macros.tex:146–149)——注释与正文不符(详见 P5)。"only Q3 and Q5 repeat across seeds"(evaluation.tex:303)对 Q5 不精确:Q5 的重复是连续部署轮次而非种子,与 V-A "a different tier, not a re-run"(evaluation.tex:26–27)的精确表述相龃龉(详见 P3)。

### M3 内部数值一致性(重点核对)— **MEETS**

核对方法:提取 results-macros.tex 全部 115 个宏定义,与正文 grep 交叉定位 66 个在用宏,再以 pdftotext 提取 main.pdf 全文逐值比对。**结果:66/66 在用宏与 PDF 渲染值完全一致,0 处未定义宏引用,0 处数值矛盾。** 关键核对记录(两边出处):

| 数值 | 宏定义( results-macros.tex) | 正文/PDF 渲染 |
|---|---|---|
| run/seed/commit/harness | :11–14 | evaluation.tex:16–18;PDF p6 |
| 20-phase、J\*=89.894 | :15, :63 | evaluation.tex:53, :55;PDF p7 |
| 55 DAQ、~6 写/线、p50/p95 四协议 | :21–35 | evaluation.tex:102–107;PDF p7 逐值一致 |
| 消融 18/18、18/18、12/18、12/18 | :37–40 | evaluation.tex:157–160(Table II);PDF p8 |
| backstop 130.2 s、HITL 461 ms | :41, :48 | evaluation.tex:115, :127 |
| 部署规模 34/112/67/77/52/385 | :109–115 | evaluation.tex:29–34;PDF p6 |
| 600=237+91+272 | :101, :104, :133 | evaluation.tex:262–265(3×79=237;92+90+90=272) |
| 66→63 / 64→63 / 63→65 bar、0.15 g、0.052 g/bar | :118–145 | evaluation.tex:270–278 |
| 6–9 ms、25.1 s、245.20/245.18 s、218 s、69 s | :117, :121–124, :141 | evaluation.tex:267, :288, :292–295 |
| 200→204.704(±0.75)、204.70 | :49–52 | evaluation.tex:170–172 |
| 30+19=49 signals、3 写、28.10→25.66∈[24.3,25.7] 裕度 0.04 | :53–58 | evaluation.tex:174–182(算术复核成立) |
| 15/2/5/3 写经济,15/2=7.5>7 | :55, :70, :74, :80 | evaluation.tex:240–241 |
| 17.1%=(164−140)/140、176 回退 | :82–84 | evaluation.tex:232–237 |
| J0≈67.2、J/J\*=0.965–0.972 | :62–67 | evaluation.tex:200–203(0.965×89.894≈86.75,自洽) |

正文内部计数自洽:33=24+9、7=4+3(evaluation.tex:117–121);30+19=49(evaluation.tex:174–175);四层区间 [50,200]∩[143.7,156.3]∩[146.22,153.78]∩[141,159]=[146.22,153.78] 与"product 层约束"叙述一致(evaluation.tex:122–125);六个 probe class ×3 次=18,4 硬区间 class ×3=12、2 窗边 class ×3=6 执行,与 Table II 完全互洽(evaluation.tex:130–163)。Fig. 5 面板终值 32.17/3.50/100.08/25.66 与宏 \resInjFinal/\resWwtpFinal/\resAnnealFinal/\resBiaxFinal 一致(宏未在正文引用但数值入图,无矛盾)。参考文献:正文 28 个唯一 \cite 键 = 参考文献表 [1]–[28] 共 28 条,无悬空引用、无未引条目入表;唯 refs.bib:2 注释写 "26 entries are cited"(陈旧,P4)。Abstract(main.tex:69–100)无数字声明,与正文无矛盾。未发现任何数值核对自己"报好弃差"。

**无法核对项(如实声明,不作猜测)**:正文硬编码且无宏对应的值——96.1 s(evaluation.tex:295)、0.05/0.51 bar 容差(evaluation.tex:283–284)、52.0±0.8 μm harness 目标(evaluation.tex:192)、hold pressure 45→58.2 bar 与 hold time 6→10.64 s(evaluation.tex:220–221)、pH 6.59→6.38(evaluation.tex:227)、cast speed 32→33.8 / fast-roll 118→120.3 / rail width 3000→3035(evaluation.tex:177–179)、14 engine adapters 与 118 declared settings(system.tex:19–20)——这些在稿件内部无第二出处可交叉验证,只能依赖归档工件(声明存在但稿件不可见),标注**无法核对**;无任何与已核数值相悖之处。

### M4 可复现性 — **MEATS**

可复现锚点在正文渲染齐备:run identifier 20260921184204-10lc、seed 42、commit e692df1、harness 指纹 9f2756dce4a4cbb3(evaluation.tex:16–18),消融伴随 run 20260921181234-e1lite(evaluation.tex:19,130),Q5 v0.7.57 与四个 benchmark run ID(evaluation.tex:29–43),per-run ledgers/timelines 声明(evaluation.tex:40–41;discussion.tex:16–17),data availability 承诺评审期匿名工件、发表即释码(discussion.tex:89–97)。

**simulation-tier 定位诚实,五处一致声明**:摘要 "simulation-tier (simulator-backed, not physical plants)"(main.tex:97–99);引言 scope(introduction.tex:57–60);系统节 "author-implemented dynamic simulators … deterministic per seed, not validated digital twins"(system.tex:58–60);试验台 "simulator- and bench-backed objects, not physical plants; multi-line means many provisioned lines and channels on one host"(evaluation.tex:32–35);有效性节(discussion.tex:18–20)。无任何暗示物理厂实验的措辞;发现"deployment-scale"一词有被误读风险,但同句的限定语已对冲。

**缺口**:渲染文本不含工件目录路径/URL/DOI(路径仅存于宏注释 results-macros.tex:1–9, 90–99 与 discussion.tex:91–92 的概括句);无宿主机硬件/OS/Node 版本规格,而毫秒级延迟(6–9 ms、p50 19.3–47.8 ms)是核心机制指标;可复现脚本名(api-full-loop.mjs 等)只存在于宏注释(results-macros.tex:97–99),正文仅说 "rerunnable from its script"(discussion.tex:95–96)。双盲下可接受,但 camera-ready 需补 artifact 指针(详见 P6)。

### M5 威胁有效性与局限 — **MEATS**

construct validity:internal-oracle 声明(discussion.tex:20–21);J\* 的 grid-search 下界/上界方向论证严密(evaluation.tex:203–209);attainment "evaluated from subsequent observations, not task state"(evaluation.tex:217–218)切断了 task-state 循环。internal validity:三方一致性明示由 harness 而非平台执行(mechanisms.tex:159–165,Table I 的 "harness-checked" 措辞准确);verdict 的可腐化性自曝("a scripted keep can coexist with a missed objective",mechanisms.tex:154–156);harness-adjudicated approval 披露(discussion.tex:24–25)。external validity:纯仿真、单 host、单 provider/model(discussion.tex:18–24),六项未评估清单(discussion.tex:59–63:oscillation、storage failure、clock error、超四线并发、split-brain、HIL 为下一层级)。关键局限无遗漏:纯仿真 ✓、单实例 ✓、无优化收益声明 ✓(discussion.tex:86–87)、非原子性 ✓(discussion.tex:52–53)、line-scoped approver 缺失/无 SoD ✓(discussion.tex:74–75)、非 SIS/非保护替代 ✓(discussion.tex:72–73)。

**不足**:未按 construct/internal/external 术语组织(内容在、标签缺);"the prose narration erred" 的裁决论证单薄(evaluation.tex:183–185,详见 P7);作者全链路自建(simulator+harness+predicates+scenario)的循环性只分散披露,未集中分析其对机制验证结论的影响。

---

## ③ 问题清单

### P1 [MAJOR] pacing 窗口作用域未写明,与 Q4 任务时钟表观冲突
- **位置**: mechanisms.tex:95–100(Sec. IV-B)vs evaluation.tex:224, 237–241(Sec. V-F);旁证 results-macros.tex:85–88。
- **证据原文**: IV-B "online writes---agent- or human-origin---sit at least 60\,s apart with a hold window after success";Q4 "the write-heaviest mission (15 governed writes)" 且 "Mission clocks (26.48 s, 169.27 s, 102.76 s …)"。
- **为什么是问题**: 按全局读法,15 笔写入需 ≥14×60 s=840 s ≫ 169.27 s(annealing 5 写/102.76 s 同理最多容纳 2 笔)。宏注释显示 writeLockSeconds 是 **node 字段**("node field default 30 s, constructor default 60 s",results-macros.tex:85–88),即 per-node 作用域下 15 写/169 s 完全可行——正文漏掉限定词,审稿人会将其当作机制与数据的矛盾,直接质疑 IV-B 或 Q4 的真实性。
- **修法**: IV-B 首窗口加两个词:"online writes **on a node**---agent- or human-origin---sit at least 60 s apart";并在 Q4 加半句确认 pacing 在快照层同样生效、15 笔写入分布于多个节点(如 "15 writes across N nodes, each node's writes ≥60 s apart")。零数据改动,两处各一句。

### P2 [MINOR] V-A 交叉引用 leg 1 应为 legs 1 and 5
- **位置**: evaluation.tex:45–48 vs evaluation.tex:307–316。
- **证据原文**: "verifies the switch's manual-mode interception separately (Section~V-G, leg~1)";而 leg 1 是 "the master switch refuses an unconfirmed manual-to-automatic transition",manual-mode 下拦截 approval-free dispatch 的是 **leg 5**。
- **为什么是问题**: 摘要声称的是拦截 recipe dispatch(leg 5 的内容),V-A 指向 leg 1 使"manual-mode interception"的验证锚点错位;VI-C 引 leg 5(evaluation.tex 该项 discussion.tex:41–42 "batch release (Section V-G, leg 5)")正确,前后不一。
- **修法**: 改为 "(Section V-G, legs 1 and 5)"。

### P3 [MINOR] "only Q3 and Q5 repeat across seeds" 对 Q5 不成立
- **位置**: evaluation.tex:302–305 vs evaluation.tex:24–27。
- **证据原文**: "only Q3 and Q5 repeat across seeds, while the Q1 ablation repeats deterministically";V-A "repeat evidence comes from Q5's consecutive deployment-tier campaigns---a different tier, not a re-run"。
- **为什么是问题**: Q5 是无种子的 live 实例连续运行,不是"across seeds";同一稿件两处对 Q5 重复性质的表述互相矛盾,V-A 精确、V-G 错误。
- **修法**: 改为 "only Q3 repeats across seeds; Q5's repetition is across consecutive deployment-tier campaigns, while the Q1 ablation repeats deterministically"。

### P4 [MINOR] refs.bib 头注释引用计数陈旧(26 vs 实际 28)
- **位置**: resources/refs.bib:2 vs 参考文献表 PDF [1]–[28](p9–p10)与正文 28 个唯一 \cite 键(本次 grep 计数)。
- **证据原文**: "% 26 entries are cited by the manuscript and appear in the reference list."
- **为什么是问题**: 不渲染进 PDF,但这是稿件工件内部的元数据错误;本次任务明列"引用总数自洽"核对项,终验与后续维护都会被误导。
- **修法**: 注释改为 28,或删除该计数句。

### P5 [MINOR] results-macros.tex 存在自相矛盾的陈旧宏,且注释声称"在正文中"的宏并不在正文
- **位置**: resources/results-macros.tex:126 vs :146–152;:150–151 vs evaluation.tex:299。
- **证据原文**: `\resInspecRatio{$100\%/100\%/99.9\%$}`(:126)vs 同文件注释 "in-spec 100.0/96.4/94.0%"(:147–148)与 `\resNovInspecRange{94.0--100.0\%}`(:150);注释称单run值 "superseded by the range macros in the body"(:148–149),但正文实际只用了 `\resRowsRange`(evaluation.tex:299),in-spec% 与 std 区间两个宏未进入正文。
- **为什么是问题**: `\resInspecRatio` 与归档注释直接矛盾(99.9 vs 96.4/94.0),若未来被误用即成数据事故;"in the body" 的不实注释会误导下一轮修订者以为分布信息已报告。同时这也构成一个(轻微的)分布信息缺口:三连跑的过程量分布已在手,正文只报 rows。
- **修法**: 删除 `\resInspecRatio`;要么把 94.0–100.0% 与 0.04–0.24 g 两个区间补进 V-G 诊断句,要么修正注释为 "defined but not used"。

### P6 [MINOR] 延迟数字缺宿主机环境规格;可复现脚本与工件路径未入正文
- **位置**: evaluation.tex:29–44(V-A 试验台)、:292–295(延迟);discussion.tex:89–97(data availability)。
- **证据原文**: "single-host latencies and near-contemporary runs"(discussion.tex:21)——但全稿无 CPU/RAM/OS/Node.js 版本;工件仅 "archived per run in the project's benchmark result tree"。
- **为什么是问题**: 6–9 ms、19.3–47.8 ms 等是机制核心指标,无硬件语境不可复现也不可外推;宏注释里的目录路径与脚本名(api-full-loop.mjs、hardening-ack-gate.mjs、check-docs-sync.mjs,results-macros.tex:97–99)未渲染,复现者无从下手。
- **修法**: V-A 加一句宿主机规格(CPU/内存/OS/Node 版本/负载状态);camera-ready 加 artifact 脚注或脚注式 URL(双盲期可用匿名仓库占位)。

### P7 [MINOR] BOPET "prose narration erred" 的裁决论证单薄
- **位置**: evaluation.tex:183–185。
- **证据原文**: "the same run's prose summary records it \emph{not} attained while its machine-readable verdict records attained, so we report both; the verdict matches the archived predicate---the prose narration erred."
- **为什么是问题**: 裁决依据是"verdict 与 archived predicate 一致",但两者是同一次运行产出的两个机器记录,无法仅凭一致性排除共享缺陷(如谓词求值 bug 同时污染两者);这恰是 construct validity 的关键一环,因为该episode被用作诚实性的展示窗口。
- **修法**: 加一句说明谓词曾以第三途径复核(如手工重算终点观测值 25.66 μm 对 [24.3, 25.7] 窗口——正文已有该数字,点明即可),或明示"若谓词求值与叙述同源出错则无法区分"的边界。

### P8 [MINOR] Fig. 5(a) 绘制量 "Weight (t)" 在正文无对应叙述
- **位置**: evaluation.tex:220–222(Q4 文本只给 hold pressure/hold time)与 :243–254(图注);build/pages/p08.png Fig. 5(a) y 轴 "Weight (t)",终值 32.17。
- **证据原文**: "Injection molding is the minimal case (two writes: hold pressure 45→58.2 bar, hold time 6→10.64 s)";图注仅 "(a) injection molding"。
- **为什么是问题**: 正文描述的受控量(压力/时间)与图面板绘制的量(Weight)不同名,读者无法建立图文对应;32.17 的目标窗口在正文任何位置都未给出。
- **修法**: 在 Q4 或图注中命名该受控量及其 attainment 窗口(一行即可)。

### P9 [MINOR] "fail-safe default is manual" 作为摘要级声明无直接测试证据
- **位置**: main.tex:84–85(摘要)、mechanisms.tex:214–216(机制)vs evaluation.tex:307–316(write-evidence suite)。
- **证据原文**: "a line master switch whose fail-safe default is manual intercepts approval-free recipe dispatch";legs 中只测了 "refuses an unconfirmed manual-to-automatic transition"(leg 1)与 manual-mode 拦截(leg 5),没有一条测试**新建线路的默认态为 manual**。
- **为什么是问题**: 摘要与贡献 1(introduction.tex:39–40 "a default-manual line master switch")把"默认值"作为属性声明;V-A 仅间接暗示(harness 需 user-side confirmation 才能切到 automatic),未直接验证默认态。
- **修法**: 在 write-evidence suite 增加一条 default-mode 检查(新建线读回 control mode = manual),或把摘要/贡献处措辞降为 "manual-by-configuration with a confirmation-gated switch"。

### P10 [MINOR] 观测-验证时延句解析歧义
- **位置**: evaluation.tex:293–295。
- **证据原文**: "observation-to-verification spans 25.1 s without a pending cadence window (245.20/245.18 s with, October 7--8; 96.1 s, October 9)"。
- **为什么是问题**: 96.1 s 属于"with"还是"without"分支、对应哪次运行,需读者猜测;且 96.1 s 无宏对应(无法核对项)。
- **修法**: 拆为显式从句,如 "…spans 25.1 s without a pending cadence window and 96.1 s on October 9; with a pending window, 245.20/245.18 s (October 7–8)."

---

## ④ 论文真实优点

1. **数值纪律罕见地好**:66 个在用宏与渲染 PDF 零偏差,所有可内部复核的派生量(总计、拆分、百分比、区间裕度)算术自洽;一份"证据快照"宏文件使数值可审计、可再推导(discussion.tex:15–17 的 "counts are re-derivable rather than trusted" 名副其实)。
2. **报告方向系统性保守**:弃用更优的同日重跑(92/92→91/91)、向下修正每轮计数(80→79)、自报自家 harness 判 fail 的注入对照、主动披露 BOPET prose 与 verdict 的分歧——这些与"选择性报告"方向相反。
3. **分级诚实(single-trace 的坦白)**:Q1/Q2/Q4 标为 case study,Q3 报三种子,Q5 报三连跑与 per-run 区间,并在 V-G 集中声明 "single-run point estimates";BOPET 时钟未存档也如实括注。
4. **falsifiable 的分级规则**:Sec. IV-C 先陈述可证伪的 grading rule,再在 Q5 legs 2–4 用其反例(publish-only receipt)实测——机制论文的正确做法。
5. **失败状态进入证据流**:admissible-but-harmful 的 blower 步骤由 verdict 层回退(Q4)、注入尝试被判 fail 并归档、backstop 只做记录完整性而非冒充保护层——"failure states surfaced for inspection" 的承诺在评估中有实例。
6. **定位克制且全文一致**:从摘要到结论,"no optimization-benefit or safety-assurance claim" 无一处破口;连已测得的 WWTP 成本改善都未报告。

---

## ⑤ 最终推荐

**MINOR_REVISION** — 无任何数据或结论性问题,但 P1(pacing 作用域歧义造成机制与数据的表观冲突)必须在投稿前修复,其余 9 条 MINOR 均为低成本高收益的修订。

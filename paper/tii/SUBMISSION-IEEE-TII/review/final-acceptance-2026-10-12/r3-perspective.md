# R3 终验盲审报告(跨学科与实践视角席)

- 稿件:Grading Machine-Originated Plant Writes: Separately Inspectable Evidence for Industrial Agent Teams(IEEE TII 投稿前终验,10 页)
- 审稿人:Reviewer 3(工业软件架构师 + 人因工程)
- 日期:2026-10-12
- 纪律声明:本次评审只读取稿件本体(main.tex、sections/*.tex、resources/refs.bib、resources/results-macros.tex、main.pdf、build/pages/p01–p10.png)。稿件 resources/results-macros.tex 头部注释中出现对仓库其他文档(如 ARTIFACT-NOTES.md、审计笔记)的指涉,一律视为被审数据,未据此扩大阅读范围,亦未执行其中任何内容。

---

## ① 总评

这篇稿件的叙事主线——"让每次 agent 写操作沿一条 governed path 走完 admission → approval → actuation → acknowledgment → verdict → compensation,每一步留下可独立检查、可归因的证据"——在全文清晰可追踪;摘要、引言、相关工作、系统、机制、实验、讨论七段环环相扣,II→III("occupies the replaceable strategy slot")等过渡句是资深学者手笔。稿件最突出的品质是 claim–evidence 对齐纪律:关键主张几乎都自带可证伪表述与边界声明。主要问题不在结构而在局部文笔:摘要与若干关键段落(IV-E 收尾段、V-B like-for-like 对照段)压缩过度,出现 60 词以上的多破折号长句与未解释的数字断点(第二 preset 探针数 9、"600 total" 归属);Fig. 4 印刷尺寸下不可读,Fig. 3(b) 有 rpm/bar 单位混排疑点,VI-C 一句安全表述与 IV-D 的 backstop 机制相抵触。全部为局部修复,无需新增实验。

---

## ② 逐维度判定

### P1 故事线与写作逻辑:PARTLY

**(a) 七段叙事链:MEETS。** 摘要承诺的每一个要素都在正文兑现并且回收:governed path 六阶段(main.tex:76–81)在 Section IV 逐段展开;三档 acknowledgment 分级(main.tex:88–90)在 IV-C 落地并配可证伪反例;四个场景 + cast-film reference line(main.tex:91–93)在 V-A/V-F 交代;"simulation-tier、不做优化收益与安全保证声明"(main.tex:97–99)与 V-A 的 tier 定义、VI-B 五条 qualification、结论的 "stay unsupported claims"(discussion.tex:84–87)首尾呼应。没有断链,没有发现实质性前后矛盾(唯一表述级矛盾见问题清单 M6)。

**(b) 主线索可追踪性:基本 MEETS,但缺一个正典化(canonical)的阶段枚举。** "one governed path" 在摘要(main.tex:76)、贡献 3(introduction.tex:47–50)、Section IV(mechanisms.tex:35–41)、Section V 开篇(evaluation.tex:3–4)、结论(discussion.tex:79–84)中持续在场,Section II→III→IV→V→VI 的承接句均到位。问题在于"路径"的官方清单在不同位置不一致:摘要列 6 阶段(main.tex:76–81),贡献 3 列 7 项(多出 backstop,introduction.tex:47–50),Section IV 又改用"六条不变量"组织(mechanisms.tex:35–41,维度不同于阶段),Table I 压缩为 "admission, HITL, dispatch, readback"(related.tex:45),Fig. 2 内部标签又是 UI 词汇(Gate 1/Gate 2/judge)。内容上互相兼容,但首读者无法确定"七阶段"中 backstop 到底是路径的一个阶段还是路径之上的看护者(IV-D 明确说它 "not an independent protection layer",mechanisms.tex:177–179,与贡献 3 的并列枚举措辞相left)。详见 M2。

**(c) "机器味"写作:PARTLY,存在明确的病灶段落。** 全文破折号插入语密度极高,多数句子可读,但至少四处达到"必须回读两遍以上"的程度:摘要第 3 句(61 词)与末句(66 词);IV-E 收尾段一句话里出现三个 em-dash 与一个分号(mechanisms.tex:230–235);V-B 的 like-for-like 对照段(evaluation.tex:76–84)信息顺序错乱、关键因果缺失;若干自造压缩语("queued guard" discussion.tex:47–49、"common-mode boundary" mechanisms.tex:163–165、"grey-box-sensitized" evaluation.tex:270–271)。这些都是"为防御审稿意见而写"而非"为读者而写"的痕迹。

**(d) 信息密度与节奏:PARTLY。** Introduction 的开篇钩子(introduction.tex:9–13:"What these demonstrations leave implicit is everything that surrounds the proposal: who may change which parameter, ...")是全文最好的人类句子;但 Evaluation 一节几乎每句都塞入数字 + 括号 + 双重限定,匀速高压、没有呼吸,与 Introduction/Mechanisms 的节奏落差明显。Section VI-A 仅一段(discussion.tex:3–12),且内容大部分是 II/III 已述主张的复述( instala-as-one-service、declarative onboarding),作为"收束"单薄。

### P2 跨学科连接:MEETS

借用概念总体准确、克制:21 CFR Part 11 / GAMP 5 被明确限定为背景而非合规声明,并主动划清 "approval treated as workflow mediation---attribution and timestamp, not an electronic signature"(discussion.tex:67–69);NAMUR NOA 描述为 "decoupled second-channel monitoring and advisory operations"(related.tex:71–74)符合 NE 175 系列原意;R2R 的移植讲清了差异("...where R2R has a fitted controller",related.tex:58–61);把 three-way check 定位为数据调和/显著误差检测的 "supervised special case"(related.tex:84–86,crowe1996reconciliation)既谦逊又准确。人因方面用法到位:Bainbridge "Ironies of Automation" 支撑 "human oversight requires more than an approval dialog"(related.tex:89–91),approval fatigue / automation bias 与 batch release 缓解的对应(discussion.tex:41–45)是人因工程的标准关切。两处用词建议打磨:"common-mode boundary"(应为 common-mode failure/common cause,见 m10)与 "transaction in the audit-trail sense"(mechanisms.tex:32–34)系有意重定义且已自注,可接受。

### P3 实践落地价值:MEETS

工业工程师可以据此理解并复用该层:部署形态一句话讲清("installs as one service beside the plant's protocol endpoints",discussion.tex:8–9);onboarding 路径四步可操作(blueprint → differential ensure pass → team-template channel → mission,system.tex:93–98),且复用主张有实验支撑(第二 preset 仅凭配置commissioned,evaluation.tex:117–118;BOPET 30 writable/19 readable 全部 ensure-pass 创建,evaluation.tex:174–175);与 MES 的 mirror/direct 双模式有明确定义(system.tex:45–48);与 PLC/DCS 的边界反复申明("PLC protection and DCS interlocks stay untouched",discussion.tex:11–12)。VI-D 的生产化清单(change control、报警系统呈现 aging/deferred 状态、bench-mode 拒绝在生产启动时生效、segregation of duties、alarm-path failure tests,discussion.tex:63–75)是真实可执行的上产 checklist,是全文对从业者最有用的一段。欠缺:与 SCADA 报警/上位系统的接口只有一句"surfaced on the plant alarm system"作为未来要求,单主机部署的 HA/split-brain 仅列为未评估(discussion.tex:59–62)——均已诚实披露,不扣分,但建议在 VI-A 补一句与现有 SCADA/ Historian 共存的典型拓扑。

### P4 图文配合:PARTLY

五图二表分工明确:Table I 定位竞争系统、Table II 支撑 ablation、Fig. 1 边界、Fig. 2 运行时、Fig. 3 准入几何 + 审批卡、Fig. 5 四任务轨迹。Fig. 5 的 caption(evaluation.tex:246–253)是全文典范:自足、定义了横轴语义("the index counts those writes, so the 6 plotted points of (b) are 6 of its 15 governed writes")、展开缩写、附 scope 注。但三处硬伤:(1) Fig. 4(PDF 第 7 页)是 UI 截图,0.95\columnwidth 下内部文字约 3–4 pt,印刷不可读,而 caption 承载着 Q5 最关键的一次迭代叙事;(2) Fig. 3(b)(PDF 第 4 页)卡片标题疑似 "(rpm)" 而数值为 "63 bar / 65 bar",两个 drill 的素材疑似混排(M8);(3) 正文以"five planes"组织 Section III(system.tex:6–16)并两处引用 Fig. 1(system.tex:6、22),但 Fig. 1 中并无 plane 标注,图内词汇(orchestrator / bridge / supervisor)与正文五 plane 词汇不对应。Fig. 2 用 "Governance Agent" 命名一段确定性平台逻辑,靠 caption 自我否认(mechanisms.tex:11–14),属于"图需要注释来纠正图"的尴尬。

### P5 读者收获("so what"):MEETS

可迁移的设计原则实际存在且可提炼:(1) 写操作分级必须以独立观测为准、绝不以传输回执为准(IV-C 的可证伪规则);(2) 权威来自持久化的 member–node capability,与 channel membership、prompt 内容彻底解耦;(3) 证据状态要能在策略槽替换后幸存;(4) pacing window 为审批需求定上限而非为稳定 сертификация;(5) 审批不预占 interval 与设备状态、执行时重查(IV-E)。结论段(discussion.tex:79–87)已接近这组原则的收拢。建议在 VI-A 用 4–6 条 bullets 把"write governance 设计原则"显式结晶,把 P5 从"读者自己提炼"升级为"论文直接交付"。

---

## ③ 问题清单

### MAJOR

**M1. [P1c/P1d] 摘要过载,第 3、5 句各 60+ 词。**
- 位置:main.tex:82–88、main.tex:91–99(PDF 第 1 页);全文摘要约 254 词,顶到 TII 250 词上限。
- 证据:"Team identities reach data-acquisition (DAQ) and write-control (DCW) nodes only through explicit member--node capabilities, and prompt content is never admissible as authority; a line master switch whose fail-safe default is manual intercepts approval-free recipe dispatch, while protocol drivers, versioned production objects, plugin points, and a typed software development kit (SDK) keep process models, objectives, and policies external to the governed path."
- 为什么是问题:一句之内三个独立主张用分号与 while 串联,em-dash 计 3 处;末句把四个场景、一条参考线、三类实验、五项能力总结和一个 scope 声明全部压进 66 词。摘要是 90% 读者唯一通读的部分,这两句会直接消耗审稿人的耐心。
- 修法:第 3 句拆为两句(身份/权威一句,外部化一句),删去 SDK、plugin points 等实现层枚举(正文 III 有);末句拆为"实验覆盖"与"scope 声明"两句,五项能力总结("-intercepting and attributing, ... recovering on record")删去,总词数压到 200–230。

**M2. [P1b] governed path 缺少正典化的阶段清单,6 阶段 / 7 项 / 六不变量三套口径并存。**
- 位置:摘要 main.tex:76–81(6 阶段);贡献 3 introduction.tex:47–50(7 项,含 backstop);Section IV mechanisms.tex:35–41(六条不变量);Table I related.tex:45("admission, HITL, dispatch, readback");Fig. 2 caption mechanisms.tex:8–10(Gate 1/Gate 2)。
- 证据:贡献 3 "separating admission, optional approval, actuation, three-level write acknowledgment with post-write verification, verdict, compensation, and backstop";IV 开篇 "Six invariants organize the path"。
- 为什么是问题:用户/读者被要求沿"七阶段主线索"阅读,但 backstop 在贡献清单里像阶段、在 IV-D 里是看护者("not an independent protection layer",mechanisms.tex:177–179);不变量与阶段是两个维度,首次读者需要自行建立映射。
- 修法:在 Section IV 开篇(mechanisms.tex:31 之后)加一句正典化定义:"The path comprises six stages---admission, approval, actuation, acknowledgment, verdict, compensation---plus the record-integrity backstop that watches open records (Section IV-D)",并在 Fig. 2 caption 中把 Gate 1/Gate 2 显式映射到 admission/approval 两阶段(caption 已部分做到,补齐其余)。

**M3. [P1a/P1c] V-B 的 like-for-like 写注入对照段是全文最难懂的一段,因果链断裂。**
- 位置:evaluation.tex:76–84(PDF 第 7 页)。
- 证据:"on the shared live instance, a like-for-like pair (four archived post-campaign runs, October~12) saw every write rejected in full on both routes---24/24 writes per arm under production pacing, and 24/24 again with pacing exempted; the archived runs record aggregate rejections only, and a closed-loop quality comparison awaits a dedicated instance."
- 为什么是问题:(1) "pair" 与 "four runs" 的关系(pair of arms × 2 runs each?)需读者猜;(2) 为什么解除 pacing 豁免后 24/24 仍全部被拒——是 300 s trial cadence、window interlock 还是别的门?全文未点名拒绝者,读者无法复现实验设计;(3) 该段嵌在 V-B(总程序段),离它所属的 Q5 语境太远,加剧混乱。这是论文唯一的 route 对比证据,现在的写法让人怀疑"作者自己也没说清实验意图"。
- 修法:整段移入 V-G 或单设 "Internal controls" 小节;按"实验设计 → 每次配置由哪个机制拒绝(点名 gate)→ 结果 → 结论(quality 对比待专用实例)"四句重写;若解除 pacing 后的拒绝来自 trial cadence,必须明说。

**M4. [P1a] Q1 第二 preset 的探针数不对称(每线 6 vs 3)且线数未交代,数字断点。**
- 位置:evaluation.tex:109–121(PDF 第 7 页)。
- 证据:"Each writable line rejects 6/6 out-of-window probes (24/24 intercepted)";"across both presets 33 probes are rejected on seven writable lines---24 on the first preset's four writable lines, 9 on the second preset's three"。
- 为什么是问题:24/4=6 每线、9/3=3 每线,同一 admission 代码、同类 drill,为何第二 preset 每线只有 3 个探针?第二 preset 共几条线(只说 3 条 writable)?读者会停下来做除法然后得不到解释,恰好削弱本句想证明的"同一代码在未见信号图上正确判别"。
- 修法:补一句:第二 preset 的 writable 线数与每线探针类数(为何是 3 类而非 6 类),或将两 preset 的探针矩阵并成半句话(4 线×6 类 / 3 线×3 类)。

**M5. [P4] Fig. 4 在印刷尺寸下不可读,且是带 UI 控件的截图。**
- 位置:evaluation.tex:87–98(图定义);PDF 第 7 页右上栏渲染。
- 证据:渲染页可见图内下拉控件文字("show device ...", "write: 65 bar", "safe window 60±0.5")有效字号约 3–4 pt;caption 却承载了 Q5 最关键一次迭代的完整叙事("a corrective decision (0.276 g error) packaged by the proposer as a sensitivity excitation; the trial cadence early-rejects 69 s ...")。
- 为什么是问题:图文配合失效——caption 讲的事件在图上无法核对;同时 "packaged by the proposer as a sensitivity excitation" 这半句本身过度压缩(谁包装、为何标签与动机不一致、这是否是系统缺陷,全靠读者脑补)。
- 修法:重制为矢量时间线(参照正文注释 system.tex:26–28 对 Fig. 1 的 ≥6pt 底线承诺,Fig. 4 应同样达标),事件泳道(proposal / cadence reject / approval / dispatch / readback / three-way)用正文阶段词汇标注;caption 中"excitation vs correction"的来龙去脉用一句话讲明。

**M6. [P1a/表述级矛盾] VI-C "enforcement never queues behind human attention" 与 IV-D backstop 让位机制直接抵触。**
- 位置:discussion.tex:39–41 对 mechanisms.tex:190–192。
- 证据:VI-C:"Admission limits, acknowledgment grading, and the backstop run with or without human approval---enforcement never queues behind human attention." IV-D:"Recovery runs only while fewer than two retained rollback records stand on the node, past which the backstop judges but defers actuation to the governing approval policy."
- 为什么是问题:按 IV-D,节点上保留 ≥2 条 rollback 记录后,backstop 只判断、不执行,动作权交回审批策略——这正是"actuation queue 在 human attention 之后"。在安全定位段落里出现与自家机制相反的绝对化表述,是最容易被安全背景审稿人抓住的把柄。
- 修法:VI-C 改为限定表述:"...run with or without human approval; the one exception is the backstop's deferred mode after repeated rollbacks (Section IV-D), which judges autonomously but hands actuation back to the approval policy."

**M7. [P1c] IV-E 收尾段一句话三个 em-dash 加分号,关键 gap 披露段反而最难读。**
- 位置:mechanisms.tex:230–235(PDF 第 6 页)。
- 证据:"The decision endpoint authenticates a user but does not enforce a line-scoped approver role---the gap Section~\ref{sec:limits} carries---and reads, verdict recording, and some configuration changes do not use physical-write approval---workflow mediation, not segregation of duties; a recipe switch between approval and execution re-admits the value against the new window (Section~\ref{sec:limits})."
- 为什么是问题:这是全文安全边界最要害的诚实披露(无 line-scoped approver 角色、读/verdict/部分配置不走写审批),却以最不可读的句式呈现;"reads, verdict recording, and some configuration changes do not use physical-write approval" 语序别扭,三个插入语相互踩踏。
- 修法:拆成三句:(1) 决策端点认证用户但不强制 line-scoped approver 角色(缺口在 VI);(2) 读、verdict 记录与部分配置变更不经过物理写审批——这是 workflow mediation 而非 segregation of duties;(3) 审批与执行之间的 recipe 切换会按新窗口重准入。

**M8. [P4,存疑需核对] Fig. 3(b) 审批卡疑似 rpm/bar 单位与两个 drill 素材混排。**
- 位置:mechanisms.tex:43–57(图与 caption);PDF 第 4 页渲染。
- 证据:渲染页中卡片标题读作 "governing-setpoint value (rpm) · Q1 four-layer drill",下行数值读作 "current 63 bar --- proposed 65 bar"。Q1 four-layer drill 在正文中是 rpm 区间([141,159] rpm,evaluation.tex:122–125),63/65 bar 属于 Q5 hold-pressure 叙事(evaluation.tex:274–278)。
- 为什么是问题:Fig. 3(a) 与 (b) 共同承担"admission 几何 + 人工审批"两个核心机制的实证呈现;若 (b) 的单位/用途混排属实,等于把最可信的"live system 截图"变成可信度减分项。caption 自称 "live system, gloss added",gloss 更不能引入新的不一致。
- 修法:核对源图;若确认混排,重新生成卡片(统一为 Q1 rpm drill,或明确标注为 Q5 hold-pressure 卡并相应修改 caption);修复后核对 (a)(b) 的 drill 指涉一致。

### MINOR

**m1. 同一段两次宣布 Table I。** related.tex:9 "characterized in Table~\ref{tab:nearest}" 与 related.tex:23–24 "Table~\ref{tab:nearest} characterizes each system as reported in its publication." 删去后者或改为引用具体列。

**m2. "spans" 只带一条引文。** related.tex:8 "LLM-oriented industrial work now spans PLC generation and verification \cite{liu2026agents4plc}." 单数列举配 "spans",读感像被截断;改为 "now includes PLC generation and verification [6], alongside generation, diagnosis, and single-domain control (Section I)" 或给出第二例证。

**m3. "cast-film reference line" 先用后定义。** 首现于摘要 main.tex:92–93 与 Fig. 3 caption(mechanisms.tex:48–49),正文定义迟至 evaluation.tex:20–21。在 III-B(system.tex:93–101 讲 onboarding 处)首次出现时加半句同位语("the platform's built-in cast-film reference line")。

**m4. 重复宏。** mechanisms.tex:177 "\looseness=-1 \looseness=-1 The backstop is..." 连写两次;删一处。

**m5. 主谓/平行结构滑落。** evaluation.tex:189–196:"...a bounded write (156.3\,s) and a goal-driven multi-step descent settling at 51.7\,$\mu$m ... and saves a recipe with attributed authorship (637.3\,s)." 主语是 turns(复数)已用 drove,"saves" 悬空;改为 "and save a recipe" 或把第三项改名词短语("a recipe save with attributed authorship")。

**m6. "(600 total)" 归属歧义。** evaluation.tex:263–266:"79 checks per run on October 7 (237 total), 91 on the hardened-pipeline run, 90--92 per run on October 9 (600 total)"。600 是七天七次运行的总和(237+91+272),但并列括号使其读作 October 9 当日总数(实为 272)。改为 "600 across all seven executions" 并移出并列位置。

**m7. "seven-leg suite verifies Sections IV-C and IV-E directly" 对 legs 6–7 不成立。** evaluation.tex:307–308 的总起句覆盖 (6) API regression、(7) documentation-consistency(evaluation.tex:315–317),这两条并非 IV-C/IV-E 的直接验证。改为 "five mechanism legs verify Sections IV-C and IV-E directly; two regression legs close the campaign"。

**m8. "harness-adjudicated" 首次出现未定义。** evaluation.tex:127–128 首用("(latency 461\,ms, harness-adjudicated and poll-dominated)"),定义迟至 VI-B(discussion.tex:23–25)。Q5 的 "structured approval releases the re-proposal"(evaluation.tex:288–291)读起来像真人批准。在 Q1 首用处加半句:"harness-adjudicated (the harness holds the approver role; no human in the loop)"。

**m9. "five-element per-parameter proposal" 与 "all six parameters" 并置易混。** evaluation.tex:270–271(五元素,Q5 closed-loop)对 evaluation.tex:314–315(六参数,write-evidence leg 5)是两个不同场景,但相邻叙述无提示。在 leg (5) 处补 "(a different, six-parameter scenario)"。

**m10. 自造压缩语三处。** "common-mode boundary"(mechanisms.tex:163–165,建议 common-mode failure point);"queued guard"(discussion.tex:47–49,建议 "the queued mitigation" 或 "guard queued for the next release");"grey-box-sensitized decision"(evaluation.tex:270–271,给出一句定义或删 grey-box)。

**m11. "batch dispatch" 一词两义。** III-C 的 "recipe-chain operations (batch dispatch)"(system.tex:119–122)指 recipe 链派发;Q5 的 "HITL approval, batch dispatch"(evaluation.tex:271–272)指多参数批量写;另有 ISA-88 batch/lot(mechanisms.tex:108)。对工况读者,batch 是高度 Loaded 的词;为 Q5 用法改称 "multi-parameter (batch) dispatch" 并在首次出现时括注。

**m12. 未铺垫的内部数字。** system.tex:19–21 "members are interchangeable across 14 engine adapters, and 118 declared settings"——两个精确数字无出处、后文不再使用,读感像内部审计残留。要么给一句话依据(如 "the shipped adapter set"),要么模糊化("a dozen engine adapters; a hundred-plus declared settings")。

**m13. Fig. 1 与五 planes 词汇不对应;Fig. 2 标签需 caption 纠偏。** system.tex:6、22 两处以 "(Fig.~1)" 支撑五 planes 叙述,但图中无 plane 标注(PDF 第 3 页);Fig. 2 的 "Governance Agent" 块需 caption 声明 "not a model-bearing agent"(mechanisms.tex:11–14)。修法:在 Fig. 1 各区块角标对应 plane 缩写(t/i/g/o/e),或将正文引用改为 "(Fig.~1, execution boundaries)";Fig. 2 源图若可重制,将块名改为 "Governance stages (deterministic)"。

**m14. "sagging mirror weight" 三重压缩。** evaluation.tex:275–277:"October 9 answers a sagging mirror weight (32.49/32.33/32.22\,g)"——mirror(MES 镜像)、weight(称重信号)、sagging(下行趋势)三者叠加,首读不解。改为 "a downward drift in the mirrored weight signal"。

**m15. diagnostics 场景一句带过且未解释。** evaluation.tex:298–300:"the diagnostics scenario exports a 30-min merged wide table (663--869 rows, 14 columns)---a feed data-quality observation, not a process excursion." 读者不知该场景做什么、喂什么 feed。补一句目的(S6 导出宽表供数据质量检查),或从正文降至脚注。

**m16. Q4 注入成型与 Q5 注塑 benchmark cell 易混。** evaluation.tex:36–39("a physics-based injection-molding cell ... a different plant from that cast-film reference")与 evaluation.tex:221–223(Q4 injection molding 场景线)都是 injection molding,只与 cast-film 划清、未与 Q4 场景线划清。V-A 补 "(distinct from the Section V-F injection scenario line)"。

**m17. "both admission branches" 未解释。** evaluation.tex:111–112:"the window-interlock drill probes the window edge and both admission branches"。哪两个分支(accept/reject?)点明。

**m18. "X, not Y" 修辞模板过频。** 如 mechanisms.tex:83("a decidability claim, not a safety certificate")、mechanisms.tex:131–134、mechanisms.tex:177–178、evaluation.tex:211–213("transparency of evidence handling, not a performance delta")、evaluation.tex:280–281、discussion.tex:36–37("a bounded blast radius, not a protection guarantee")。单看每处都好,八处以上同构后显出模板味;保留 3–4 处最有力的,其余改写。

---

## ④ 论文真实优点(不凑数)

1. **可证伪的分级规则 + 自带反例实验。** 贡献 3 承诺 "the grading rule stated falsifiably"(introduction.tex:50),IV-C 立即兑现为规则陈述,并在 Q5 leg (4) 用 publish-only receipt(broker puback、ok=true、三次验证不可confirm)演示 success-flag 规则与分级规则会给出不同结论(mechanisms.tex:127–134;evaluation.tex:310–313)。主张—机制—实验三者同构,这在系统类投稿中少见。
2. **负面事实保留在正文里。** BOPET 任务的 prose summary 与机器 verdict 不一致时,"so we report both; the verdict matches the archived predicate---the prose narration erred"(evaluation.tex:184–186);BOPET 任务时钟 "unarchived" 也照实说(evaluation.tex:237–239);like-for-like 对照全部被拒也归档为 gate evidence。这种不修饰的写法是稿件可信度的最大来源。
3. **节间过渡是手写水准。** II→III:"AgentWorkShop occupies the replaceable strategy slot that Section~II's comparison leaves open"(system.tex:3–5);V 收尾的五项能力复述(evaluation.tex:319–322)精确回扣摘要;"the loop's time is governance, not platform overhead"(evaluation.tex:295–296)是既能站住又能带走的句子。
4. **竞争定位公平且可核查。** Table I 声明 "as reported in its publication"(related.tex:23–24、48),对 Waseem 等明确说 "a layer below AgentWorkShop, so the roles are complementary"(related.tex:15–17),不贬低对手。
5. **Fig. 5 caption 是自足 caption 的样板**(evaluation.tex:246–253):定义横轴计数语义、解释 6 点与 15 次写的关系、展开 DO、附 "Simulator observations under scripted policies" 的 scope 注。
6. **VI-D 生产化清单有真实工程价值**(discussion.tex:63–75):change control、报警面呈现 aging/deferred 状态、bench-mode 生产启动拒绝、电子签名边界、segregation of duties 与 alarm-path 测试——工业工程师可以直接抄进部署评审。
7. **人因素养到位。** Bainbridge 与 Parasuraman 引用位置准确;把 "approval fatigue" 与批量发布缓解(discussion.tex:41–45)、"reading graded evidence assumes trained approvers" 写进 limitations,是懂行的人才 会写的句子。

---

## ⑤ 最终推荐

**MINOR_REVISION** —— 主线完整、证据纪律与范围自持是真实优点,所有问题均属局部可修(摘要与三个关键段落重写、两处图件重制、两处表述矛盾消除、若干数字断点补一句话),不需要任何新增实验;但上述 8 项 MAJOR 必须在投稿前全部关闭,否则第一 impression 会被自己的文笔拖累。

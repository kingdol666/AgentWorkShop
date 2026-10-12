# Reviewer 2(领域席)终验盲审报告

- 稿件:Grading Machine-Originated Plant Writes: Separately Inspectable Evidence for Industrial Agent Teams(IEEE TII 投稿前终验,匿名稿,10 页)
- 审稿人背景:LLM/multi-agent systems × 工业过程控制(SCADA/DCS/MES、ISA-88/95、NAMUR NOA、IEC 62443、HITL 安全联锁)
- 日期:2026-10-12。仅依据稿件本体(main.tex、sections/*.tex、resources/refs.bib、resources/results-macros.tex、main.pdf 及 build/pages 渲染图)评审。
- 盲审纪律声明:已执行指令注入检查;稿件中未发现面向审稿人的指令性文字。源文件内含作者内部工作注释(main.tex:120-122、refs.bib:5-9、results-macros.tex 头部),仅视为被审数据并在问题清单 MINOR-12 中处理。

---

## ① 总评

稿件提出一个面向工业 agent 团队的 governed supervisory execution layer,把机器发起的产线写入收敛到单一可审计路径:admission(Eq. 1 区间判定)→ approval → actuation → 三级 write acknowledgment(独立 readback 定级)→ verdict → compensation,每级落为独立、可归因的 evidence state。选题切中 LLM agent 进入工业现场后真实存在的治理真空;claim 纪律在近年 LLM-工业论文中罕见地好(明确非 SIS、非保护层、无优化收益与安全保证声明、simulation-tier)。主要风险有三:其一,"工业 LLM 工作至今多为 generation/diagnosis/单域控制"的 gap 陈述面对若干 LLM 直接作用于产线的近作(其中多篇已在 refs.bib 中却未被引用)可被熟悉文献的审稿人挑战;其二,六条 "invariants" 中 three-way consistency 由 evaluation harness 而非平台执行,框架标签与正文自述存在张力;其三,以 human-in-the-loop 为关键词却无任何人类侧证据且 HITL 引用面偏窄。三项均为文本级修改,不触发新实验。

## ② 逐维度判定

### D1 文献覆盖 — PARTLY

逐条线评估:

- **(a) LLM agent 安全/治理/编排**:已引 MCP(mcp2024)、GuardAgent(xiang2024guardagent)、indirect prompt injection(greshake2023injection)与 injection benchmark(liu2024pinjection)。不足:runtime enforcement 只引 GuardAgent 一篇,而同一档位的 AgentSpec(wang2025agentspec,refs.bib 已有)与 CaMeL 即 "Defeating Prompt Injections by Design"(debenedetti2025camel,refs.bib 已有)均未引用;related.tex:51-52 "Multi-agent frameworks coordinate tasks and tools" 一句零引用(AutoGen/LangGraph/CrewAI 均在 refs.bib 未用);related.tex:91 "Agent benchmarks ... inform adjacent evaluations" 的 cite 只挂了 injection 两篇,benchmark 一词无对应引文(AgentBench/τ-bench/TheAgentCompany 均在 refs.bib 未用);LLM-agent 权限/能力控制一档(capability-based privilege control,如 Progent,2025,**待核实**:arXiv 2504.11703 附近)完全缺席,而这正是本文 member--node capability 的学术近亲。
- **(b) 工业 agent 应用**:Table I 五个近邻 + liu2026agents4plc + biskupovic2025supervision + leitao2009agentbased,骨架尚可。实质缺口在"LLM 直接对 plant 执行动作"一线:InstructMPC(Wu, Ai, Li, IEEE CDC 2025,DOI 10.1109/CDC57313.2025.11312156,refs.bib 键 wu2025instructmpc,已有);Vyas et al., "From Detection to Action: Using LLM Agents for Fault-Tolerant Control"(refs.bib 键 vyas2026ftc,**待核实**);Gill et al., ETFA 2025,LLM agents + digital twin 做 process plant fault handling(键 gill2025llmdt,已有);Hofmann et al., 经 OPC UA 用 LLM 自然语言控制机器(refs.bib 键 hofmann2025nlc,arXiv 2510.11300,**待核实**);LLM4PLC(Fakih et al., ICSE-SEIP 2024,确有其文,键 fakih2024llm4plc,已有)应与 Agents4PLC 并引。
- **(c) HITL 与监督控制**:已引 Bainbridge 1983 与 Parasuraman/Sheridan/Wickens 2000,选点正确。但 automation bias 的标准引文是 Parasuraman & Manzey, Hum. Factors 2010(键 parasuramanmanzey2010complacency,refs.bib 已有未引);graded evidence 的可读性与信任校准应引 Lee & See, Hum. Factors 2004(键 leesee2004trust,已有未引);automatic vs approval-mediated binding 本质是 levels of automation,可引 Sheridan & Verplank 1978(键 sheridan1978,已有未引)。
- **(d) 工业标准与治理框架**:ISA-88/ISA-95、IEC 62443-3-3、IEC 61511、ISA-18.2、NAMUR NOA、21 CFR Part 11、GAMP 5 —— 在 LLM 论文中这个覆盖面罕见地内行,是加分项。可选补锚:IEC 62443-2-4 / 4-1(sp/driver lifecycle,对应本文 plugin/driver 注册治理,标准确实存在);ISA-106(procedure automation,对应 recipe dispatch,标准确实存在);NIST SP 800-82(键 nist80082,已有未引,可支撑 VI-D 的 IT/OT separation 句)。

判定理由:标准线最强,(c)(a) 线属"引文已在手边未挂"的廉价修复,(b) 线存在被审稿人点名的实质缺口,且直接威胁引言的 gap 陈述 → PARTLY。

### D2 相关工作定位与对比公允性 — MEETS

Table I 明示 "characterizes each system as reported in its publication"(related.tex:23-24),各行使用中性、可核查的描述;对 MADE 用 hedged 措辞 "no persistent production-scoped write-evidence path **reported**"(related.tex:11-13),把 Waseem 定位为 "a layer below \system{}, so the roles are complementary" 而非贬低;对 DCS/Part 11/GAMP/NOA/R2R/IEC 62443 实践的描述(related.tex:68-77)准确且姿态谦逊("Against that practice the difference is the proposer")。三点保留:(1) MCP 被描述为 "a bare function signature carrying no line, product, or recipe context"(related.tex:53-54)低估了 MCP tool annotations(readOnlyHint/destructiveHint 等)的存在——差异应落在"annotations 均为 advisory、无生产域语义、无分级证据",而非"bare signature";(2) "No prior system in Table I owns a governed write path"(evaluation.tex:66-67)依赖 "governed" 的自定义,MADE 行的 "safety layer" 已是一种输出校验,建议 II-A 加一个从句承认其存在并指出缺的是持久化、生产域归因的 evidence,以先发制人;(3) 我无法离线核验五个近邻的发表文本,行文与 venue 元数据(带 DOI)大体可信,但**作者应对照正式出版版本复核各行描述**(2026 年的几篇尤其如此)。无实锤贬低或错述 → MEETS。

### D3 理论框架适当性 — MEETS

五平面(governance plane 为其中之一,且明确是 "logical groupings, not deployable units",system.tex:6-8)、六条路径组织原则、三级 acknowledgment 语义、Eq. (1) 的区间 admission(declared、versioned、decidable、layer-attributable,并自我限定 "a decidability claim, not a safety certificate",mechanisms.tex:82-83;单参数、限幅不限意图,mechanisms.tex:84-87)构成清晰自洽的机制设计框架。术语 evidence state 全文用法一致且与 abstract 呼应。两处需修:(1) mechanisms.tex:35-38 把 "checkable three-way consistency" 列为六 invariants 之一,而 mechanisms.tex:157-165 明言 "Three-way setpoint consistency is checked by the evaluation harness **rather than the platform**",Table I 亦诚实标注 "harness-checked"——名为平台不变量、实为评估仪器性质,框架标签失准;(2) "capability" 未钉死:contribution 1 称 "capability-based industrial execution architecture"(introduction.tex:36),正文机制却是 member--node binding + "authorized by the persisted capability"(system.tex:79-83)混用,security 语义下 capability 应一句定义(capability := 持久化 binding 行,每请求服务端 re-check,可撤销);另外标题词 "write governance" 全文从未被一句话定义。均为措辞级问题 → MEETS。

### D4 领域贡献增量 — MEETS

相对工业既有实践,论文明确承认 "Permissions, range checks, approvals, and audit trails long existed in DCS and SCADA practice"(related.tex:68-70),把增量收敛为三件事:机器生成的 proposer(非预设的人类操作员)进入 governed plant-facing write path;prompt 内容永远不作 authority、每请求对活的生产状态重判(related.tex:78-82);per-write graded、actor-attributed 的证据语义随 strategy 替换存活。这个增量真实但属架构/组织层,论文自己说破 "The response is organizational rather than algorithmic"(introduction.tex:26-27)。"不是什么"清单完整且懂行:非 SIS、非 plant-protection 替代(iec61511)、无 formal guarantee、无优化收益声明、非 validated digital twin;VI-D 的 production integration 清单(change control、line-scoped approver 缺失→SoD、alarm-path failure tests、bench-mode 启动拒绝、split-brain 未评估)表明作者理解现场合规语境。残余风险:熟悉 DCS 写后回读(write-then-readback)与 historian audit 的高级审稿人可能认为增量偏薄,建议 II-B 补一句:既有 DCS audit trail 为何不构成本文意义的 graded evidence state(无独立 read 通道分级、无 per-write grade 固定语义、无机器 actor 归因),把差异说透而非留给读者。→ MEETS。

### D5 叙事完整性(领域读者视角)— MEETS

因果链完整且首尾呼应:摘要第一句的 failure mode("a task reported complete can coexist with a missed process objective")在 IV-D 被诚实回收——verdict 可被 scripted keep 骗过、"a scripted keep can coexist with a missed objective"(mechanisms.tex:155-157),即本层使 divergence **可检可归因**而非**可防**;这一闭环是全文最见功力之处。领域行话使用内行:DAQ/DCW 节点二分、ISA-88 batch/lot 概念的 "reduced subset" 自我定位、R2R 谱系(moyne2000r2r)、three-way check 对 data reconciliation(gross-error detection,Crowe 1996)的 supervised special case 降格表述、alarm rationalization(ISA-18.2)语境。两处可加强:(1) "inspectable not preventive" 的边界应提前到 Sec. I scope 段点破一次,目前只在 IV-D/VI 出现,快读的领域读者可能误读为防护主张;(2) 缺一句 Purdue model / ISA-95 level 定位(该层明显处于 L2/L3 边界、PLC protection 独立,system.tex 与 VI-A 有素材但未点明层级),TII 读者需要自行拼装。文风极密:长句嵌套多层 em-dash 从句(如 related.tex:74-86 一句跨 13 行),对 TII 部分工业读者不友好,属风格问题不影响可信度。→ MEETS。

## ③ 问题清单

**CRITICAL:无。**

**MAJOR-1 近邻覆盖缺口威胁 gap 陈述(连带 Table I 的完备性)**
- 位置:introduction.tex:21-22;related.tex:8(Table I 集合,related.tex:26-48);resources/refs.bib(未挂引的近邻条目)。
- 证据:"Industrial LLM work to date is mostly generation, diagnosis, and single-domain control (e.g., \cite{liu2026agents4plc})"。
- 为什么是问题:存在多篇 LLM agent 直接对 plant/机器执行控制动作的近作——InstructMPC(CDC 2025,human-LLM-in-the-loop 控制)、Vyas et al. 2026(LLM agents 做 fault-tolerant control,待核实)、Gill et al. ETFA 2025(LLM+DT 做 process plant fault handling 动作)、Hofmann et al. 2025(LLM 经 OPC UA 写机器,待核实)——其中三篇已在 refs.bib 却未被引用。若审稿人熟知任意一篇,"mostly generation/diagnosis" 与 Table I 的 "closest systems" 集合即显不完整,并连带削弱 II-A 的区分度陈述与 evaluation.tex:66 的 "No prior system ... owns a governed write path"。
- 修法:逐篇核实存在性与内容(不确定者标待核实,不得臆引);在 II-A/II-B 补引并各加一句区分(它们普遍缺 production-scoped authority、分级 evidence 与 per-request admission);若某篇确已实现 admission+evidence 型写入治理,必须相应弱化本文 increment 措辞并考虑列入 Table I(增 1-2 行);LLM4PLC 与 Agents4PLC 并引。纯文本改动,预计半天工作量。

**MAJOR-2 六 "invariants" 中一条不由平台执行,框架标签失准**
- 位置:mechanisms.tex:35-41 vs mechanisms.tex:157-165;Table I 自评行(related.tex:45)。
- 证据:"Six invariants organize the path---binding-resolved authority ..., checkable three-way consistency, ..." 对 "Three-way setpoint consistency is checked by the evaluation harness rather than the platform";Table I:"harness-checked three-way consistency"。
- 为什么是问题:不变量(invariant)通常指系统在所有执行下保持的性质;其中一条的生产执行体是评估 harness,Table I 的诚实标注反而使正文 "invariants organize the path" 的表述在细读下自相矛盾,给较真的审稿人留下"框架口号大于机制"的口实。
- 修法(三选一,成本递增):(a) 将 "Six invariants" 改为 "Six design commitments",并把 three-way 一条标注 "(harness-checked)";(b) 在六条之后加一句,区分 platform-enforced(四条)与 evidence-system-checked(三条中的 three-way check);(c) 把 three-way check 下沉为平台可选 verification stage——工程量大,不建议在本轮做。

**MAJOR-3 以 HITL 为关键词,却无人类侧证据,且 HITL 引用面窄**
- 位置:摘要、IEEEkeywords(HITL)、discussion.tex:43-49;evaluation.tex 全部审批事件("harness-adjudicated",如 evaluation.tex:127-128)。
- 证据:"approval fatigue and automation bias remain human-factors risks, and reading graded evidence assumes trained approvers \cite{bainbridge1983ironies,parasuraman2000model}"。
- 为什么是问题:论文把 approval boundary 与 approval card(Fig. 3b)作为卖点机制,但全部审批由 harness 裁决,无任何人类被试或专家评估;自动化偏见的标准引文 Parasuraman & Manzey 2010 与信任校准的 Lee & See 2004 均在 refs.bib 未引,使 VI-C 的风险讨论显得文献功课不足。审稿人可能据此要求 operator study(那将升级为真 major),提前止血划算。
- 修法:最低成本——补引上述两条,并把 "human decision latency and quality out of scope"(discussion.tex:24-25 的既有坦白)提级半句进摘要 scope 从句或 IV-E 首句,明确本文的 approval 是 workflow mediation 而非 human-performance 主张;有余力则加一个小规模(3-5 名工程师)审批卡可读性专家走查作为 Q5 附加 leg(非必需)。

**MINOR-1 "capability" 术语未定义**
- 位置:introduction.tex:36("capability-based")vs system.tex:79-86("member--node binding"/"persisted capability" 混用)。
- 修法:III-B 首句加定义:"a capability is the persisted member--node binding row, checked server-side at every request and revocable with next-request effect"。

**MINOR-2 "write governance" 无一句话定义**
- 位置:标题/keywords/abstract 使用;Sec. IV 开篇未定义。
- 修法:mechanisms.tex:20-27 处加一句:write governance := 以声明式、版本化、按请求重判的检查序(admission→approval→actuation→graded ack→verdict→compensation)约束机器发起的 plant 写入,并为每级留独立证据。

**MINOR-3 对 MCP 的"bare function signature"表述低估 tool annotations**
- 位置:related.tex:51-55。
- 修法:改为 "the tool surface carries advisory annotations but no production context (line, product, recipe) and no record separating admission from execution",既保住论点又无错述风险。

**MINOR-4 "Multi-agent frameworks" 一句零引用**
- 位置:related.tex:51-52。
- 修法:补 \cite{wu2023autogen,langgraph2024,crewai2024}(三条均在 refs.bib,直接挂引即可)。

**MINOR-5 "Agent benchmarks" 一句引用错位**
- 位置:related.tex:91-93:"Agent benchmarks and prompt-injection studies \cite{greshake2023injection,liu2024pinjection}"。
- 修法:benchmark 名词补 \cite{liu2024agentbench,yao2024taubench,xu2024company}(均在 refs.bib)。

**MINOR-6 使用 A2A 却未引其规范**
- 位置:system.tex:38(agent-to-agent (A2A) entry point)。
- 修法:句尾补 \cite{a2a2025}(refs.bib 已有),与 MCP 的引法对齐。

**MINOR-7 Q1 两 preset 探针数不对称未解释**
- 位置:evaluation.tex:109-121:第一 preset 四条可写线各 6 条(24),第二 preset 三条可写线共 9(每线 3)。
- 修法:加半句说明第二 preset 探针集较小(如每线 3 类)的原因,避免"选择性报告"误读。

**MINOR-8 未回应为何不用标准过程控制 benchmark**
- 位置:evaluation.tex V-A(testbed);discussion VI-B。
- 修法:一句 justified-scope:治理层是 plant-agnostic 的,场景按协议/模态多样性选型,标准 benchmark(TEP,Downs & Vogel 1993;SWaT,Goh et al. 2017;均在 refs.bib)留作后续;两文均可顺手挂引。

**MINOR-9 自动化偏见/信任文献补引**
- 位置:discussion.tex:43-45。
- 修法:\cite{bainbridge1983ironies,parasuraman2000model} 后补 parasuramanmanzey2010complacency、leesee2004trust;"automatic or approval-mediated execution"(system.tex:80)处可选引 sheridan1978。

**MINOR-10 标准锚可再加固(可选)**
- 位置:related.tex:68-77;discussion VI-D。
- 修法:"least privilege, endpoint security, and IT/OT separation" 处补引 NIST SP 800-82(在 bib);driver/plugin 生命周期治理可提 IEC 62443-4-1;recipe dispatch 可对照 ISA-106(两者均为真实标准,具体取舍由作者定)。

**MINOR-11 排版小疵**
- 位置:mechanisms.tex:177:"\looseness=-1 \looseness=-1" 连写两次。修法:删一处。

**MINOR-12 源文件内嵌内部工作痕迹,存在去匿名化/泄露评审史风险**
- 位置:refs.bib:9(引用 ".omc/research/tii-review-20260920/references-audit.md");results-macros.tex 头部与正文注释(内部 run 号、audit note 互证);main.tex:120-122(revision 备忘,含日期)。
- 为什么是问题:data availability 承诺 anonymized artifacts during review;若分享包含 LaTeX 源或仓库,这些路径与注释可暴露作者工作流与既往评审过程。
- 修法:构建分享包前 strip 注释(或以 camera-ready 源为准另行打包)。

**MINOR-13 参考文献排版覆盖 IEEEtran 默认(合规核查项)**
- 位置:main.tex:123-127:\linespread{0.77}\footnotesize 包裹 bibliography。
- 为什么是问题:为压页数改变了 IEEEtran 参考文献行距,camera-ready 阶段可能被出版方要求还原。
- 修法:对照 TII author guide 确认;若不合规,准备一版默认行距的页数预案(作者已在注释中预留 fallback 文本,好习惯)。

**MINOR-14 Table I 可选增行(可选建议)**
- 位置:related.tex Table I。
- 修法:增一行 "DCS/MES human-operator practice (Part 11 batch journal)" 作为 against-practice 基线,使 II-B 的实践对比在表内可见;若嫌表宽,维持纯 prose 亦可接受。

## ④ 论文真实优点(不凑数)

1. **Claim 纪律是同类论文的范本**。全文没有一处超出 simulation-tier 证据的表述;否定性边界(非 SIS、非保护层、无 formal guarantee、无优化收益、非 validated twin)逐条显式且可定位到 Sec. VI;VI-D 的 production-readiness 缺口清单(SoD 缺失、alarm-path failure tests、bench-mode 启动拒绝、split-brain)显示作者真正理解工业部署语境,而非纸面治理。
2. **三级 acknowledgment 的可证伪表述**。Section IV-C 不止给出定义,还构造了反例锚点(publish-only receipt:broker puback、ok=true、无 read 通道)并在 Q5 leg(4) 真实复现——机制论文应有的写法,"fail-honest" 语义(缺证据降级、不改报告)表述干净。
3. **评估诚实度的细节**。BOPET 任务的 prose 总结与机器可读 verdict 冲突时双报告并说明 "the prose narration erred";admin-REST 与 dcw_control 的 like-for-like 对比两路 24/24 全拒,如实归档为 gate evidence 而非粉饰成性能对比;Q3 主动声明 J/J* 是界而不是差距。这种自我对抗式写作显著降低了审稿对抗成本。
4. **标准线覆盖内行**。ISA-88/95、NAMUR NOA、IEC 62443-3-3、IEC 61511、ISA-18.2、21 CFR Part 11、GAMP 5 的引用位置全部正确(如把 approval 定性为 "workflow mediation---attribution and timestamp, not an electronic signature",正中 Part 11 要害)。
5. **与经典自动化文献的真实对话**。Ironies of Automation、data reconciliation(Crowe)、R2R 控制谱系的类比有实质内容而非装饰性引用;graceful 的自我降格("supervised special case")反映领域功底。

## ⑤ 最终推荐

**MINOR_REVISION** —— 理由:论文的 claims 与其证据严格对齐,全部阻断项均为文本级(近邻补引与 gap 措辞校准、invariant 标签修正、HITL 补引与 scope 从句),无需任何新实验;唯一上行风险是 MAJOR-1 若牵出需要重构 Table I 的近作,亦可在同一轮修完,不改变结论。

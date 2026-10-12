# TII 投稿前终验盲审报告 — Journal-Fit Reviewer（EIC 席）

- 稿件：*Grading Machine-Originated Plant Writes: Separately Inspectable Evidence for Industrial Agent Teams*（Anonymous Authors）
- 载体：`main.tex` + `sections/{introduction,related,system,mechanisms,evaluation,discussion}.tex` + `resources/refs.bib`、`resources/results-macros.tex`；编译产物 `main.pdf`（IEEEtran journal 双栏，US Letter，正文+参考文献共 10 页）
- 审阅基础：仅稿件本体（六个 section 源文件全文、bib、macros、10 页渲染图逐页核对）；未读取任何评审/审计/历史文档
- 日期：2026-10-12

---

## ① 总评

这是一篇定位克制、工程完成度高的系统型稿件：把 LLM agent 团队对工业对象的写操作收拢到一条受治理的写路径上，以分级写确认（readback-verified / transport-acknowledged / unverified）为核心证据机制。主题扎实落在 TII scope 内，叙事从标题到结论是同一个故事，无安全保证或优化收益的越界声称，声称纪律显著优于同类投稿。主要短板有二：评估完全依赖作者自建 harness 的内部对照（无外部基线、无物理对象），"作者实现-作者验证-作者裁决" 三位一体未作为显式效度条目列出；以及与 TII 自身文献对话明显不足（26 条引文仅 1 条 TII，而 bib 中另有 3 条 TII 条目闲置未引）。另有 DCW 缩写与展开不对应、一处统计总量归属歧义、部分图内文字低于可读下限、源文件残留过程性注释等小疵。全部为日级可修项，不动摇论文结构。按清单修订并补齐 TII 单盲评审所需的实名行政项后，即可投出。

---

## ② 逐维度判定

### J1 TII 期刊契合度 — **MEETS**

主题是"工业 agent 写控治理"，不是纯 NLP/软工会议稿。证据：(a) 问题对象是 plant writes 的权限、限值、审批、设备确认与过程响应（Introduction, PDF p1）；(b) 技术面落在 Modbus TCP/RTU、OPC UA、MQTT、HTTP/REST 六协议族、line–product–recipe–run 生产对象、ISA-88/ISA-95 子集、R2R control（Sec. II-B）；(c) 对照系是 DCS/SCADA 合规实践与 IEC 62443/61511/ISA-18.2（Sec. II-B、VI-D）；(d) 四个场景为注塑、污水（A2O）、退火、BOPET 薄膜四种流程/离散工业；(e) Table I（PDF p2）的对比对象全部来自工业控制会议/期刊（ICCAD、ETFA、CASE、AEI），且引用了 TII 2025 的 agent-based supervision（[8]）。唯一的契合度折扣是证据层级为 simulator-backed（作者自建模拟器，非物理产线、非验证过的数字孪生，Sec. III-A、VI-B），但稿件对此全程明示且不据此作任何物理世界声称——这在 TII 的 informatics/架构类投稿中是可接受姿态。

### J2 原创性与贡献显著性 — **MEETS**

区分度论证完整：对五个最近系统（Table I），以"venue、LLM 角色、写路径、生产域权限、写证据"五轴刻画，得出"无一报告生产域权限+分级写证据在同一路径上的组合"；对 DCS/监管实践（21 CFR Part 11、GAMP 5、NAMUR NOA、R2R），增量精确表述为"提议者是机器生成的 agent 身份而非预设的人类操作员"（Sec. II-B 末段）——这是本稿最锋利的一句定位。贡献表述有实质且不夸大：摘要末句明确 "no optimization-benefit or safety-assurance claim is made"；结论重申三类 unsupported claims（VI Conclusion）。分级写确认规则以可证伪形式陈述并配对抗性演示（publish-only 端点在 success-flag 规则下报 success、在分级规则下报 unverified，Sec. IV-C；V-G leg 4 复现），四臂消融干净分离了 window interlock 与 readback 的职责（Table II）。需如实指出：构件级新颖度有限（readback 验证、区间 admission、审批与审计轨迹均为经典实践，稿件自己在 II-B 承认 three-way check 是 data reconciliation 的受监督特例），原创性在于"机器提议者 + 分级证据状态 + 生产上下文"的组合与完整实现，属 TII 接受的 informatics 架构贡献类型，但审稿人可能就"组合式新颖性"压分。

### J3 对 TII 读者的价值 — **MEETS**

工业信息学读者能带走一套可迁移的部署模式集：member–node capability 把任务成员身份与物理写权限分离；fail-safe 默认 manual 的 line master switch；prompt 内容永不作为 authority；三级写确认 + 独立后写读；60 s 写节奏窗、approval 锚定的 dispatch 间隔；blueprint + 差分 ensure pass 的声明式上线（Sec. III–IV）。VI-D 的生产化清单（change control、告警系统呈现 approval-aging/backstop-deferred、segregation of duties、bench 模式生产启动时拒绝）是实践者真正需要的内容。"industrial" 程度足够：协议、标准、场景、运行账本（run ledger）俱全。折扣仍是证据层级：无物理对象、无操作员研究、审批由 harness 代裁（VI-B 明示五条限定）；对于要拿去产线用的读者，缺一个 real-PLC/HIL leg 是真实缺口——稿件自己把它列为下一证据层级（VI-D），这个缺口会被审稿人放大，但不构成拒稿理由。

### J4 标题-摘要-引言-结论一致性与整体成熟度 — **MEETS**

标题（grading + separately inspectable evidence）、摘要、四条 contributions（Sec. I）与 V 的五个问题（Q1–Q5）、结论（VII）一一对应，全稿讲的是同一个故事。数字抽查成立：24+9=33 个拦截探针与两次 preset 的可写线数一致；四任务写经济 (2, 15, 5, 3) 与 Q2/Q4 的 BOPET 3 写、注塑 2 写吻合；25.66 µm 恰在 25.0±0.7 窗口内 0.04 µm；ablation 18/18 与 12/18 的分解（4 硬区间类×3 次 + 2 窗口类×3 次）自洽；七次流水线执行 237+91+272=600 合计正确（但见 MINOR-2 的表述歧义）。异常处置成熟：BOPET 任务的 prose summary 与机器可读 verdict 冲突时双报并归因（V-D），而非掩盖。无 orphan 引用，图表全部有效引用，无未完成感。局部瑕疵：摘要约 250 词且单段过密（见 MINOR-3）；一处重复排版宏（MINOR-4）。

### J5 编辑行政合规 — **PARTLY**

已合规项：IEEEkeywords 齐备（6 词）；IEEEtran journal 双栏、US Letter、10 页含参考文献，远在 TII 常规论文页数范围内；hyperref 元数据（pdftitle/pdfsubject/pdfkeywords）已设；`\IEEEpeerreviewmaketitle`、running head 正确；AI 辅助编辑披露在文末（符合 IEEE 现行政策）；匿名化内部自洽——无 funding/acknowledgments、无自引暴露、run ID 与 commit hash 不构成身份泄露。未合规/待办项：TII 实行**单盲**评审，作者信息须实名——当前 "Anonymous Authors"（main.tex:64）与 `pdfauthor={Anonymous Authors}`（main.tex:33）是匿名工作稿状态，投稿前必须替换为真实作者、单位、通讯作者与 ORCID（列为行政待办而非缺陷）；参考文献排版被压行距（MINOR-7）；源文件含过程性注释，若 ScholarOne 要求上传 LaTeX 源需先清理（MINOR-6）；数据可用性声明无可解析途径（MINOR-9）。

---

## ③ 问题清单

无 CRITICAL 项。MAJOR 2 条，MINOR 9 条，行政待办 5 条。

### MAJOR-1 评估的自证性未作为显式效度条目列出（无外部基线、实现者=验证者=裁决者）

- **位置**：`sections/evaluation.tex:53-54`、`evaluation.tex:66-68`；`sections/discussion.tex:16-25`
- **证据**："an author-defined regression instrument, not an external certification"；"No prior system in Table I owns a governed write path to plant endpoints, so the primary comparator is internal"；VI-B 的五条限定中只有 "internal-oracle optima and predicates"，未点名 harness 本身由作者实现并裁决。
- **为什么是问题**：TII 审稿人攻击的第一目标就是闭环自证：写路径、探针、判据、裁决全部出自同一作者团队，且无任何第三方系统对比。稿件已披露 80%（两句限定语都在），但没有把"单一来源验证"本身列为 named validity threat，容易被读作回避而非坦承。
- **修法**（无需新实验）：(1) 在 VI-B 五条限定中显式加一条，如 "the harness is author-implemented and author-adjudicated; no external certification, third-party replication, or cross-framework comparison is reported"；(2) 在 V-B 的 "primary comparator is internal" 句后补一句前向引用："a hardware-in-the-loop leg against a real PLC or OPC-UA endpoint is the next evidence tier (Section VI-D)"，把缺口转为路线。

### MAJOR-2 与 TII 文献对话不足：26 条引文仅 1 条 TII，bib 中另有 3 条 TII 条目闲置

- **位置**：`resources/refs.bib:11-19`（nee2019digital，TII 2019）、`refs.bib:21-30`（zhang2026comaikg，TII 2026）、`refs.bib:512-521`（liu2024kgdiag，TII 2024）；`sections/related.tex:3-24`；参考文献表（PDF p10，仅 [8] biskupovic2025supervision 为 TII）
- **证据**：`refs.bib` 文件头自述 "26 entries are cited by the manuscript"；上述三条 TII 条目在文件内但未被 `\cite`。
- **为什么是问题**：期刊契合度审阅会看稿件是否与本刊近期语料对话。"LLM agent 团队工业应用"方向 TII 2024–2026 有直接相关论文（工业知识图谱构建、故障诊断、agent-based supervision），其中两条就躺在这份 bib 里却未引用——全不对话会被编辑部读作对目标期刊定位不熟，也浪费了现成的契合度锚点。
- **修法**：在 II-A 的 "LLM-oriented industrial work now spans PLC generation and verification [6]" 一句扩为 generation、verification、knowledge construction、diagnosis 各配一引（用 zhang2026comaikg、liu2024kgdiag）；在 Sec. III 谈 simulator/digital-twin 姿态处（"not validated digital twins"）引 nee2019digital 作数字孪生背景。同时顺手复核 bib 中确实无关的闲置条目是否删除。

### MINOR-1 核心缩写 DCW 与其展开不对应

- **位置**：`main.tex:83`（摘要）；`sections/introduction.tex:37`；`sections/system.tex:48`
- **证据**："data-acquisition (DAQ) and write-control (DCW) nodes"——DAQ 与展开对应，DCW 与 "write control" 字母不对应（工具名 `dcw_control`、`dcw_judge` 亦基于 DCW）。
- **为什么是问题**：这是全稿最高频的核心术语之一，首次出现即缩写不匹配，审稿人会立刻当作粗糙信号，且会疑问 D-C-W 三个字母从何而来。
- **修法**：三选一：(a) 最省事——首次出现写 "write-control (DCW) nodes (DCW is the platform's node-class tag)"；(b) 给出与字母对应的真实展开（若存在，如 data/control-write）；(c) 全稿改用与展开对应的缩写。(a) 即可。

### MINOR-2 "(600 total)" 归属歧义，读作 October 9 小计则对不上账

- **位置**：`sections/evaluation.tex:263-265`
- **证据**："79 checks per run on October 7 (237 total), 91 on the hardened-pipeline run, 90--92 per run on October 9 (600 total)"。October 9 三次运行实为 92+90+90=272（与 `\resNovTotal`=272 一致）；600=237+91+272 是全程合计，但括号紧跟 "October 9"。
- **为什么是问题**：这是全稿数字密度最高的一段，审稿人第一次核账失败就会连带怀疑其余数字。
- **修法**：改为 "90--92 per run on October 9 (272 total; 600 across the seven executions)"。

### MINOR-3 摘要约 250 词、单段过密，触及 IEEE 词数窗口上缘

- **位置**：`main.tex:69-100`（PDF p1）
- **证据**：全段 5 句约 250 词，含多重 em-dash 嵌套（如第 5 句内含三个破折号插入语）；IEEE 惯用窗口 150–250 词，TII 作者指南历来偏 ~200 词。
- **为什么是问题**：编辑部与审稿人的第一阅读面。当前密度使核心贡献（graded acknowledgment + evidence states）被细节（SDK、插件点、驱动）稀释。
- **修法**：压至 ~200 词。候选删减：第 3 句 "protocol drivers, versioned production objects, plugin points, and a typed software development kit (SDK)" 简化为 "protocol drivers, versioned production objects, and a typed software development kit (SDK)"；第 5 句 BOPET 全称移出摘要（正文首现处已展开，符合 IEEE 惯例）；"intercepting and attributing, grading honestly, pacing automation, mediating approval, and recovering on record" 五连动名词可减为三。

### MINOR-4 重复的排版宏残留

- **位置**：`sections/mechanisms.tex:177`
- **证据**："\looseness=-1 \looseness=-1 The backstop is a record-integrity check..."
- **为什么是问题**：对编译无害，但暴露终稿未做最后一遍源码清理，与全稿整体的干净程度不符。
- **修法**：删除其一。

### MINOR-5 两张位图图内文字低于成品可读下限

- **位置**：`sections/mechanisms.tex:3`（`aws_fig3-flat.png`，Fig. 2）、`sections/mechanisms.tex:47`（`hitl-card-crop.png`，Fig. 3(b)）；PDF p4
- **证据**：150 dpi 渲染中，Fig. 2 各模块内的说明文字与 Fig. 3(b) 审批卡截图的文字在成品栏宽下明显小于 6 pt 等效高度，且为位图，缩放后发虚。Fig. 1（`fig2-architecture.pdf`）源注释自证已控字号 ≥6 pt，这两张未控。
- **为什么是问题**：IEEE 对图内最小字号有 ≥6 pt 的惯例要求；Fig. 3(b) 是"HITL 结构化审批卡"这一核心机制的唯一直观证据，读不清会直接削弱 IV-E 的说服力。
- **修法**：两张位图按 ≥300 dpi 重导出或矢量化；Fig. 2 重排，模块内文字只留短语级；Fig. 3(b) 可放大局部或只保留字段名级信息（member/node/value/interval/expiry），逐字段解释留在正文，全卡细节引 artifact。

### MINOR-6 投稿源文件残留过程性注释（含内部路径与修订批次字样）

- **位置**：`resources/refs.bib:1-9`（含 ".omc/research/tii-review-20260920/references-audit.md"）、`refs.bib:569`（"% --- Added 2026-09-24 (rebuttal positioning: ...)"）；`resources/results-macros.tex:1-9`（ARTIFACT-NOTES 路径）、`results-macros.tex:90-99`（"audit notes"、"EXPERIMENT-REPORT.md"）；`main.tex:118-122`（"identified 2026-10-12"）
- **证据**：注释含内部工具路径、修订日期批次、rebuttal 字样。
- **为什么是问题**：ScholarOne 常要求上传 LaTeX 源。这些注释不泄露作者身份，但向审稿人暴露内部审改流程（"rebuttal positioning" 字样尤其不妥——会暗示稿件经历过针对其他期刊/评审的改写），显得未清理。
- **修法**：投稿前剥离全部过程性注释（保留私有副本）；至少删除含路径、日期批次、rebuttal 字样的行。

### MINOR-7 参考文献排版偏离 IEEEtran 默认（为压页数压行距）

- **位置**：`main.tex:123-127`
- **证据**：`\linespread{0.77}\footnotesize` 包裹 `\bibliography`；源注释自述 "the default leading overflowed the 10-page budget"。
- **为什么是问题**：IEEE 出版排版会重置为默认，届时页数回涨且需重新校版；p10 的行距目视紧于正文，编辑部对"为省页改动文献排版"不持好感。10 页不是 TII 初投稿的硬约束。
- **修法**：恢复 IEEEtran 默认行距，接受 ~10.2 页（初投稿可接受，具体以当期作者指南为准）；若必须守住 10 页，启用 main.tex 注释中已预留的 fallback 文字裁剪（related-work recap 从句与 V-A 一句），而不是压行距。

### MINOR-8 两条外部文献元数据建议投稿前复核

- **位置**：`resources/refs.bib:611-620`（waseem2026pretrained，期刊缩写 "Mach. Learn.: Eng."，Table I 中作 "Mach. Learn. Eng. 2026"）；`resources/refs.bib:597-604`（huang2026made，ICCAD 展开为 "Int. Conf. on Control, Automation and Diagnosis"）
- **证据**：前者是少见的新刊缩写；后者与更广为人知的 IEEE/ACM ICCAD（Computer-Aided Design）缩写冲突，两种 ICCAD 并存。
- **为什么是问题**：venue/DOI 元数据错误是编辑部行政检查的直接退修项；bib 注释自称条目已对 Crossref 审计，但这两处无法从稿件内部自洽验证。
- **修法**：用 DOI 逐条反查 Crossref，确认期刊全称、卷期页码与会议展开名；两处各一分钟。

### MINOR-9 数据可用性声明不具可执行性

- **位置**：`sections/discussion.tex:89-97`
- **证据**："Artifacts are archived per run in the project's benchmark result tree; anonymized artifacts are available during review and released with the code upon publication."——无任何可解析的获取途径。
- **为什么是问题**：全稿复现主张（VI-B："counts are re-derivable rather than trusted"）建立在此承诺上；审稿人依 TII 惯例索要 artifact 时若无具体链接，信任链断裂。
- **修法**：投稿时随附匿名化 artifact 包（匿名 Zenodo/figshare 或补充材料），声明中给出具体占位链接与包含物清单（report.md、run.json、timeline.jsonl、metrics.csv——正文宏注释显示这些文件存在）。

### 行政待办（非缺陷，投稿前必办）

1. **实名化**：TII 实行单盲评审——替换 `main.tex:64` 的 `\author{Anonymous Authors}` 与 `main.tex:33` 的 `pdfauthor` 为真实作者、单位、通讯信息，补 ORCID；按当期指南决定是否随投稿附作者简介/照片。
2. 对照当期 TII Author Guide 核对：页数与超页费政策、graphical abstract、cover letter（建议在此明确陈述 industrial informatics 契合点）、suggested reviewers 及利益冲突。
3. 保留文末 AI 辅助编辑披露（`discussion.tex:96-97`），录用后按 IEEE 要求移入 Acknowledgments。
4. 执行 MINOR-6 的源码注释清理后再上传源文件。
5. 确保 review 期间匿名 artifact 链接真实可用（与 MINOR-9 同步落实）。

---

## ④ 论文真实优点

1. **声称纪律是同类稿件的典范**。摘要末句明写 "the evaluation is simulation-tier (simulator-backed, not physical plants), and no optimization-benefit or safety-assurance claim is made"（main.tex:97-99）；结论重申 "optimization benefit, autonomous control, and safety assurance stay unsupported claims"（discussion.tex:85-87）。安全边界、威胁模型、缺口清单（无 line-scoped approver 角色、delegation 旁路、hold heartbeat 绕过 re-admission）全部主动交代。
2. **分级写确认以可证伪规则陈述并配对抗性演示**：publish-only 端点（broker puback、`ok=true`、无读通道）在 success-flag 规则下报 success、在分级规则下报 unverified，三尝试仍不升级（mechanisms.tex:127-134；V-G leg 4）——这是全稿最有力的一手，把设计主张变成了可检验命题。
3. **诚实的异常披露**：BOPET 任务的 prose summary 与机器可读 verdict 冲突时双报并归因（"the prose narration erred"，evaluation.tex:183-186），Q1/Q2/Q4 明示为 single-trace case study，时延明示为 single-run point estimates。
4. **消融设计干净**：四臂（full / no-readback / no-interlock / ungated）×6 探针类×3 次确定重复，干净分离"预防归 interlock、检测归 readback"的职责（Table II），"prevention is the interlock's job" 有数据支撑。
5. **工业实践对照认真且差距表述精确**：21 CFR Part 11、GAMP 5、NAMUR NOA、R2R、IEC 62443/61511、ISA-18.2 全部落位；"workflow mediation, not segregation of duties"（mechanisms.tex:232-234）这类自我界定极少见。
6. **数字自洽性经抽查成立**（24+9=33；(2,15,5,3) 与 Q2/Q4 互证；25.66 在 25.7 窗口内 0.04；ablation 18/12 分解；600 合计），宏与正文无一处引用错位。
7. **交叉引用与图表完整**：五图两表全部有效引用，无 orphan reference，10 页版面整洁，无溢出/孤行。

---

## ⑤ 最终推荐

**MINOR_REVISION** —— 无 CRITICAL 项；两条 MAJOR 均为表述与定位层修正（补一条效度限定、补两三处 TII 引用），不需要新实验或结构改动，完成③清单与行政待办后即可投出。

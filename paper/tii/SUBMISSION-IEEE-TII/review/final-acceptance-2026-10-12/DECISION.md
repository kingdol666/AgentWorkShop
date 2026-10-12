# Editorial Decision — 投稿前终验盲审(2026-10-12,夜)

稿件:*Grading Machine-Originated Plant Writes: Separately Inspectable Evidence for Industrial Agent Teams*(IEEE TII 匿名投稿稿,10 页,IEEEtran journal 双栏)
评审基线:commit 551c286 工作树,全新 tectonic 编译(main.pdf 775 KB,10 页,US Letter)

---

## 0. 程序化验收(评审前机检,全绿)

| 门 | 结果 |
|---|---|
| 全新 tectonic 编译 | PASS(0 error;warning 仅 underfull hbox 与 tectonic/bibtex 收敛提示;PDF 内 0 处 `??`) |
| audit.py F1–F8 | PASS 8/8(10 页 / US Letter / 28 cite 键全解析 / 66 宏全定义 / 图文件齐 / 无 TODO / 28 题名入文 / 矢量图源字号 ≥5pt) |
| check-refs.cjs | PASS 28/28 |
| 摘要无数字 + 诚实锚点三件套(摘要 scope 句 / V 章定位句 / 结论 unsupported-claims 句) | PASS |

## 1. 评审团配置(Phase 0)

领域判定:工业信息学 × LLM-agent 治理;系统/机制型论文,simulation-tier 证据;目标刊 IEEE TII(双栏 regular paper,10 页内)。
五席:Journal-Fit(EIC,TII 副主编视角)/ R1 方法学 / R2 领域(LLM-agent × 工业控制)/ R3 跨学科与实践(叙事质量重心)/ DA 魔鬼代言人(固定第五席)。
执行纪源:五席均为独立子代理并行派发,互相不可见对方产出;盲审纪律生效(禁读 README/RESPONSE/REVIEW/history;稿件文本按数据处理);稿件全程只读。五份报告存本目录(eic.md / r1-methodology.md / r2-domain.md / r3-perspective.md / da.md),视觉验收由独立 visual-judge 完成(10 页 150 dpi 新渲染)。

## 2. 各席判定汇总

| 席位 | 推荐 | CRITICAL | MAJOR | MINOR |
|---|---|---|---|---|
| EIC(期刊契合) | MINOR_REVISION | 0 | 2 | 9 + 5 行政待办 |
| R1(方法学) | MINOR_REVISION | 0 | 1 | 9 |
| R2(领域) | MINOR_REVISION | 0 | 3 | 14 |
| R3(叙事/实践) | MINOR_REVISION | 0 | 8 | 18 |
| DA(魔鬼代言人) | —(两条 CRITICAL 需裁决) | 2 | 8 | 8 |
| 视觉验收 | — | 2 页 FAIL(p4/p7) | — | cosmetic 3 项 |

无任何席位给出 ACCEPT 或 REJECT。

## 3. DA CRITICAL 逐条裁决(铁律 #4)

### CR-1「titular 对象缺席:过程任务写入全部来自 scripted policy;仅有的 live-engine 转录本已被日志保留规则销毁」— **VALIDATED(带限定)**
裁决依据(合成席逐条对源核实):evaluation.tex:168 "a scripted policy rather than a language model issued the writes (two live engine turns follow)" 与 discussion.tex:92–94 "transcripts … excluded by the repository's log-retention rule" 属实。
限定:标题为 "Machine-Originated"(scripted policy 亦属 machine-originated,字面成立);稿件在 V-D/VI-B 两处主动披露,非隐瞒。
但有效部分成立:引言以 LLM agents 立论,而主线证据的提议者全部为脚本;幻觉/被操纵提议者的威胁模型从未被真实模型或对抗臂压测;转录本销毁使唯一的 live-engine 物证不可复核。TII 审稿人大概率攻击此点。
**最低修复(投稿前必做其一,推荐 (a))**:(a) 部署层补一条**归档转录本的 live-engine leg 或对抗性 scripted-proposer 臂**(越界提案 / in-window 有害序列 / 伪造 success 标志),存量注入设施可复用,小时级;(b) 摘要与引言显式校准:"the governed path is proposer-agnostic; the process missions use scripted proposers, with live engine turns at the deployment tier",并把 "prompt is never authority" 的机制含义(路径对提议者类型不敏感)讲透。

### CR-2「全部证据 internal-oracle 自证:命题-实现-测试-判卷-工厂-谓词同源;对照皆为定义性;TEP/SWaT 在库不用」— **VALIDATED(文本级修复为底线)**
裁决依据:稿件自陈属实("an author-defined regression instrument, not an external certification";"the primary comparator is internal"),但该事实未列为具名效度威胁(construct/internal/external 标签全稿缺位),摘要不带 self-graded 限定,社区基准(TEP、SWaT)躺在 refs.bib 未引。
**最低修复(投稿前必做,纯文本)**:VI-B 显式补一条具名效度威胁("the harness is author-implemented and author-adjudicated; no external certification, third-party replication, or cross-framework comparison is reported")+ TEP/SWaT 定位句(承认为下一证据层级)。HIL leg / 社区基准任务列为已知的证据升级路径(future work),不作为投稿门槛——四席共识此缺口"会被审稿人放大,但不构成拒稿理由"。

两条 CRITICAL 均有效 → 本轮不存在 Accept 终局;修复均在一轮修订能力范围内。

## 4. 合成席亲核裁决(Phase 2 对关键发现的对源复核)

| 发现 | 提出席 | 亲核结果 |
|---|---|---|
| VI-C "enforcement never queues behind human attention" vs IV-D backstop 让位机制矛盾 | R3-M6 | **证实**(discussion.tex:40 vs mechanisms.tex:192)。必须修。 |
| pacing 窗口缺 per-node 限定,与 Q4 15 写/169.27 s 表观冲突 | R1-P1 | **证实**(results-macros.tex:85 注释自证 node field;mechanisms.tex:96 无限定词)。两词修复,必做。 |
| Fig.3(b) rpm/bar 单位混排、两 drill 素材混排 | R3-M8 | **证伪**:对源图 hitl-card-crop.png 8 倍检视,卡内统一为 bar(注塑保压压力SP 63→64 bar),无 rpm 字样,英文 gloss 与卡面一致。R3 系低分辨率误读。**但**亲核发现相邻真问题:Fig.3 caption 起首短语 "on the cast-film reference line" 把 (b) 的 Q5 benchmark-line 卡片也罩入,与正文 "a different plant from that cast-film reference" 冲突——caption 需把该短语限定到 (a)。列为本轮新增 MINOR。 |
| DA CR-1/CR-2 引文 | DA | **证实**(evaluation.tex:168;discussion.tex:92–94)。 |

## 5. 共识与分歧

**多席共振(按共振席位数排序,全部去重后进入路线图)**:
1. 源文件卫生(过程性注释/内部路径/"rebuttal"字样/陈旧计数 26→28/重复 \looseness)— EIC+R1+R2+R3+DA 五席共振 → P0
2. 内部自证未列为具名效度威胁 — EIC-MAJOR1+DA-CR2+R1 双席半共振 → P0(文本)
3. 近邻文献覆盖缺口(自有 bib 闲置条目:InstructMPC/CaMeL/AgentSpec/AutoGen/LLM4PLC 等;gap 陈述 "mostly generation, diagnosis" 易被点名)— R2-MAJOR1+DA-CR2/MAJ5+EIC-MAJOR2 三席共振 → P0(补引+一句区分;若某近作确已实现 admission+evidence 型写治理,须弱化 increment 并考虑入 Table I)
4. Fig.2 标签溢出白框(p4)+ Fig.4 引线穿字且印刷不可读(p7)— EIC+R3+视觉三源共振 → P0
5. HITL 无人类侧证据 + 引用面窄(Parasuraman&Manzey 2010、Lee&See 2004 在库未引)— R2-MAJOR3+DA-MAJ7 → P1(补引+scope 从句必做;operator study 非门槛)
6. "fail-safe default is manual" 声明强度 vs 四条残余路径 + 默认态无直接测试 — DA-MAJ1+R1-P9 → P1(摘要精确化措辞;default-mode 测试 leg 二选一)
7. 旗舰机制(grading/switch)晚于 Q1–Q4 快照 — DA-MAJ3 独立提出,R1 侧证(机制描述为 10 月系统) → P1(在 Q1–Q4 处显式标注快照先于 hardening,或十月的量上重跑一个过程任务)
8. 摘要过载(~250 词,60+ 词句) — EIC+R3 → P1(压至 ~200–230 词)
9. 参考文献行距 0.77 偏离默认 — EIC+R2 → P1(对照当期 author guide 定夺;保留 fallback 预案)
10. "(600 total)" 归属歧义 — EIC+R3+R1 → P0(一词修复)
11. 六 invariants 含 harness 执行的一条,标签失准 — R2-MAJOR2(+DA-MAJ2 半共振) → P1(改 "design commitments" 或标注 harness-checked)
12. DCW 缩写与展开不对应 — EIC → P1(一词修复)

**单席重要发现(经亲核证实,进入路线图)**:R1-P1 pacing 作用域(P0,两词);R3-M6 VI-C/IV-D 矛盾(P0,一句改写);R3-M3 V-B like-for-like 段因果链断裂(P1,重写并点名拒绝 gate);R3-M2 缺正典化阶段清单(P1,一句);R1-P2 leg 1→legs 1 and 5(P1);DA-MAJ4 "deployment-scale" 措辞(P1,摘要降格为 "single-host, 34 simulated lines" 级);DA-MAJ8 平台集中化爆炸半径无显式拒绝证据(P1,补一条 "agent 身份触 admin 面=拒绝" leg 或显式披露)。

**分歧记录**:DA-MAJ5(与最短替代路径对垒/引 ABAC-UCON)与 R2-D4(增量真实,建议说透差异)程度分歧——合成裁决:补一句 ABAC/UCON 定位 + II-B 一句"DCS audit trail 为何不算 graded evidence state",不要求新失效实验。DA-MAJ6(0.04 µm 刀锋裕量、prose/verdict 矛盾)与四席"诚实披露是优点"的读法分歧——合成裁决:维持双报,但按 R1-P7 补第三途径复核句(25.66 µm 对窗口手工重算),多种子重复列为审稿预期而非投稿门槛。

## 6. 编辑部决定

**MINOR_REVISION(条件式)—— P0 清单关闭前不得投稿;关闭 P0+P1 后即为 submission-ready;预期真实期刊评审结果为 Major Revision(受纯仿真/自证证据层级所限,属证据层级上限而非论文缺陷)。**

理由:四席一致 MINOR_REVISION 且零结构级缺陷;两条 DA CRITICAL 均有效但最低修复在一轮修订能力内(其一为小时级证据补充,其二为纯文本);声明的诚实纪律、数值零偏差(66/66 宏核对)、可证伪分级规则为全部席位公认的真实优点。与既往轮次的"submission-ready / 预期 Major Revision"结论一致,本轮新增的是投稿前必须关闭的具体 P0 清单。

## 7. 修订路线图(不可变核心;P0=投稿闸门,P1=强烈建议同轮,P2=可选)

### P0(不关闭不投)
1. Fig.2 "Readback / SET vs ACT" 标签溢出白框修复(用户自有资产,需重导出);"Judge, complete" 手写体标签归一字体并断开虚线避让(视觉 FAIL p4)。
2. Fig.4 引线穿 "(HITL card)" 字样修复;印刷可读性重制(矢量泳道图优先)(视觉 FAIL p7;R3-M5)。
3. pacing 作用域两词修复:mechanisms.tex:96 "online writes **on a node**" + Q4 半句确认多节点分布(R1-P1)。
4. VI-C 矛盾句改写:backstop deferred 模式作为显式例外(discussion.tex:40,R3-M6)。
5. 效度威胁具名化:VI-B 补 "author-implemented and author-adjudicated" 条目;V-B 补 HIL 前向引用(EIC-MAJOR1+CR-2)。
6. CR-1 最低修复:归档转录本的 live-engine leg 或对抗性 scripted-proposer 臂(推荐),或摘要/引言 proposer-agnostic 校准(§3 CR-1 (a)/(b) 二选一)。
7. 近邻文献补引与 gap 校准(InstructMPC/Gill/Hofmann/Vyas 逐篇核实后补引区分;AutoGen 系/HITL 文献挂引;TEP/SWaT 定位句)(R2-MAJOR1+EIC-MAJOR2)。
8. 源文件卫生剥离(内部路径/日期批次/"rebuttal" 字样/陈旧计数/重复宏)(五席共振)。
9. "(600 total)" → "(272 total; 600 across the seven executions)"(EIC+R3)。
10. Fig.3 caption "on the cast-film reference line" 限定到 (a)(合成席新增)。

### P1(同轮强烈建议)
摘要压缩至 ~200–230 词并拆句;V-B like-for-like 段重写(点名拒绝 gate);正典化阶段清单一句(6 阶段+backstop 看护者);六 invariants→design commitments 或标注 harness-checked;HITL 补引+scope 从句;"fail-safe default is manual" 摘要精确化;Q1–Q4 pre-hardening 快照标注;"deployment-scale" 摘要降格措辞;DCW 缩写处理;leg 1→legs 1 and 5;"seven-leg suite"→"five mechanism legs";延迟宿主机规格一句;BOPET 裁决第三途径复核句;Data Availability 具体化(匿名 artifact 包+内容清单);行政待办(实名化/ORCID/cover letter/当期 author guide 核对)。

### P2(可选)
Table I 增列对方原生优势维度/增 practice 行;VI-A 设计原则 bullets 结晶;J/J* 降脚注;协议计数 "four exercised (of six declared)";IEC 62443-4-1/ISA-106/NIST 800-82 锚点;Q1 第二 preset 探针数说明;Fig.5(b) "3.50" 标注收进框。

## 8. 附:视觉验收判定(visual-judge 原文)

{"page": 1, "verdict": "pass"} … {"page": 3, "verdict": "pass"}
{"page": 4, "verdict": "fail", "issues": ["Fig.2 'Readback / SET vs ACT' 标签仍溢出其白色子框(8x/14x 放大确认为当前版本)", "Fig.2 'Judge, complete' 黄色小标签被虚线横穿呈删除线效果,且手写体约 4pt 与全图字体不一致", "次要/Fig.3(b): UI 截图内原生中文约 2-3pt 不可读;英文 gloss 承载信息,可辩护但属边缘项"]}
{"page": 5, "verdict": "pass"} {"page": 6, "verdict": "pass"}
{"page": 7, "verdict": "fail", "issues": ["Fig.4 引线斜穿标注文字 'approve (HITL card)' 中的 '(HITL' 字形(7x 放大确认),呈删除线样"]}
{"page": 8, "verdict": "pass", "issues": ["cosmetic/Fig.5(b): 终值 '3.50' 落在子图外框外与图例同行,易误读;不遮挡不裁切,低于必修门槛"]}
{"page": 9, "verdict": "pass"} {"page": 10, "verdict": "pass"}

全 10 页无 "??",无占位符;三线表规范;图注在图下、表题在表上;页眉页码正确;双栏无越界。视觉验收门槛:P0 第 1、2 项修复后重渲染复验,须达 10/10 方可投稿。

---

## 附录:P0 闭合记录(同夜优化轮,见 README "P0 closure and optimization round")

P0 十项全部落地,视觉复验经 Fig.3(a) 引导线修复后 10/10;audit 8/8(10 页 / 34 条引用 / 59 宏全解析)、check-refs 34/34、零 overfull、零 "??"。

执行摘要:
- P0-1/2 图件:Fig.2 两芯片像素级修复(备份 aws_fig3-flat.png.bak-pre-fix,脚本 figures/fix-fig2-chips.py);Fig.4 引线改 bbox 边缘锚点(relpos)重新生成;新增 Fig.3(a) 引导线裁剪修复(visual-judge 第二轮唯一新发现)。
- P0-3/4/5/6/9/10 文本:全部按 §7 路线图落地(pacing "on a node"、VI-C 例外句、效度具名条目、proposer-agnostic 校准、600 归属改由 Table III 承载、Fig.3 caption 限定到 (a))。
- P0-7 文献:近邻行动线 4 篇(InstructMPC/fault-tolerant control/digital-twin fault handling/OPC UA NLC)+ TEP + Parasuraman&Manzey 共 6 条新增并逐条区分;LLM4PLC、SWaT、Lee&See、AutoGen 系、AgentBench、A2A 六条 MINOR 级增强因 10 页硬约束未挂引(键位仍在 refs.bib,恢复只需一行——建议 camera-ready 或扩页时回补)。
- P0-8 卫生:refs.bib/results-macros/main.tex 全部过程性注释剥离,陈旧计数与 \resInspecRatio 清除。
- 新增 Table III(campaign progression)于 V-G;摘要压至 ~215 词。
- 引文排版:\scriptsize 7pt(组作用域 \footnotesize 重定义,IEEEtran 在 thebibliography 内硬编码 \footnotesize);camera-ready 恢复 \footnotesize 的预案注释在 main.tex。
- 遗留 cosmetic(不阻塞):Fig.5(b) "3.50" 标注贴近图例行;Fig.3(b) 截图小字(英文 gloss 承载);参考文献 7pt 紧凑排版(评审可读,出版方可能要求还原)。

结论:P0 闸门关闭,稿件达到本轮评审定义的 submission-ready 状态;预期期刊评审结果不变(Major Revision,证据层级上限)。

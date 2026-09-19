# TII 论文评议-修复循环状态账本(贪心:每轮必须优于上轮,否则回滚)

规则:
- 每轮 = 3 位新审稿人 subagent 独立评议 → 汇总 → 修复 Agent 落改 → pdflatex 零错 + 页数 ≤11 → 贪心判定
- 贪心判定: 新版无新增 Critical/Major 未解项 且 审稿结论不劣于上轮 → 接受(commit);否则回滚到上一接受轮,换方案重做
- 收敛条件: 所有审稿人判定 = PUBLISHABLE

| 轮 | 基线 commit | 页数 | 编译 | R1 系统判定 | R2 实验判定 | R3 写作判定 | 决定 |
|---|---|---|---|---|---|---|---|
| R0 | 4551c71 | 11 | 零错 | (待评) | (待评) | (待评) | 基线 |
| R1 评审回收(系统方向) | | | | MAJOR_REVISION | | | 3 Major(声明校准 7/10 分布/LLM 缺位闭环/门控语义)+3 Minor |
| R3 评审回收(写作逻辑) | | | | | | MINOR_REVISION | 1 Critical(V-E 自相矛盾句)+3 Major(图3/5零引用/命名迷宫/边界从句熔接)+1 Minor;THM=主张与豁免解耦 |
| R2 评审回收(实验严谨) | | | | | MAJOR_REVISION | | 复算零矛盾;4 Major(7/10 校准=与 R1 收敛/消融 mock 层/resHost 未用/benchmark-data.json 冲突)+2 Minor;无 BLOCKER |
| 第 1 轮修复 Agent 派出 | 清单=A 声明校准/B V-E 矛盾句/C 图 3·5 引用+归位/D 术语命名批量/E 风格要点/F benchmark-data.json 溯源注 | 约束=编译零错+≤11 页+不加新声明引文 | (执行中) |
| R4 评审回收(第2轮·系统) | | | | MAJOR_REVISION(新深意见:LLM 框架对齐/门控盲区半句/backstop 行为未报告) | | | 老项已修未复发;有进展未收敛 |
| R6 评审回收(第2轮·写作) | | | | | | MAJOR_REVISION(P1 贡献3过载+三处重复/P2 否定式×80/P3 术语漂移 DCW 未定义/P4 交叉引用失配/图注元评论) | THM=否定句式翻转+术语归一 |
| R5 评审回收(第2轮·实验) | | | | | MAJOR_REVISION(11 个总体未如实/双 warn 不符/n=1 与 7-10 置信区间/六样本残留句/DAQ 列=样本数/short bucket mean 未定义) | | 复核确认第 1 轮修复全部生效;新发现更深 |
| 第 2 轮修复 Agent 派出 | 清单=A 总体诚实化/B 统计功效/C backstop 行为(读档案)/D LLM 框架对齐/E 门控盲区半句/F 贡献3 瘦身/G 术语归一(DCW 展开)/H 交叉引用一致性 14 项 | 约束同前 | (执行中) |
| 第 2 轮接受 | b71ab3b 之后 | 11 | 零错 | 待第 3 轮 | 待第 3 轮 | 待第 3 轮 | 贪心通过:R4/R5/R6 新发现全落实+独立验证(0 错/0 ??/11 页/大写渲染定位) |
| 第 2 轮评审已提交(commit 9f5bebc 前) | R4 系统 MAJOR(更深:LLM 框架/backstop 未报告) | R5 实验 MAJOR(11 总体/双 warn/n=1/样本vs节点) | R6 写作 MAJOR(DCW 未定义/否定式×80/交叉引用失配) | 第 2 轮修复:8 大项 20 小项全部落实,0 错 11 页 |
| 第 3 轮评审派出(R7/R8/R9 全新视角) | | | | (执行中) |
| R7 评审回收(第3轮·系统) | | | | MAJOR_REVISION(框架对齐:75/75 降格为档案记账/分布为头条/J-J* 引用处带限定/模拟器版本入指纹;bucket 定义指控不成立) | | | 第 2 轮修复被默认生效;意见重心从事实错误→框架对齐 |
| R9 评审回收(第3轮·写作) | | | | | | MINOR_REVISION(2 Critical 均为我上轮引入的 bug:V-F 残句/图6 mum 渲染;+摘要重写/账目统一/句式瘦身) | 写作判定趋势 R3 MINOR→R6 MAJOR→R9 MINOR=净改善 |
| R8 评审回收(第3轮·实验) | | | | MAJOR_REVISION(账目三处口径不一/复用声明降格/非确定性根因局限/0.04→0.02) | | | 162 档案复核;mum/残句系我上轮引入已修 |
| 第 3 轮修复 Agent 派出 | 清单=账目统一/塌缩终值修正/复用降格/根因局限/J-J* 离散度/术语指针/小瑕打包 | 约束同前 | (执行中) |
| 第 3 轮接受 | b71ab3b 之后 | 11 | 零错 | 待第 4 轮 | 待第 4 轮 | 待第 4 轮 | 贪心通过:12 项验证全过(含 0.02 终值修正) |
| 第 3 轮评审派出(R10 系统/R11 实验/R12 写作,全新视角) | | | | | | | (执行中;本轮为收敛判定轮——若全体 PUBLISHABLE 或仅 MINOR 且无新 Critical/Major,循环终止) |
| R10 评审回收(第4轮·系统) | | | | MAJOR_REVISION(呈现层:75/75 降格+头条盲区对账+摘要重组;明确"完成后可发表") | | | 数字复算全对;意见全为文本重定位,无新事实 |
| R12 评审回收(第4轮·写作) | | | | | | MINOR_REVISION(摘要 7/10/11 三基数句重写示范/两个"七"消歧[我删消歧句所致]/免责句式收敛/术语小债) | THM=seven of eleven 单一口径+摘要重写 |
| R11 评审回收(第4轮·实验) | | | MAJOR_REVISION(约 40 数值全核验一致,无 BLOCKER;Major-1=任务层非确定性须钉版模拟器 ≥30 次重跑隔离;Major-2=两处声明-证据错配:"仅任务检查降级"与"其他阶段不相关失败";Minor:bit-identical 言过其实/verify 脚本 3 处措辞漂移/引言结论 reruns 口径) | | | 数字层干净,意见全部可文本落实(除重跑实验) |
| 用户指令:全维度发表初稿体检 | | | | | | | 增派排版席+图表席两个全新专项审稿 subagent |
| 排版席回收(MINOR,"可发表需微调") | 摘要 291 词超 250/Fig.3 0.35 缩放不可读/Index Terms 字序/伪段落/公式标点/refs 降大写+未缩写/Sec-Section 混用/末页失衡/0 Overfull 骨架全对 | | | | | |
| 图表席回收(MAJOR) | 六图印刷等效字号全线低于 8pt:Fig.3 2.8pt Critical(0.72\columnwidth 排 7.16in 画布)/Fig.6 4pt/Fig.4 5pt/Fig.5 5.1pt(衬线离群)/Fig.1-2 5.8-6.7pt;图文一致性逐项核对全部吻合(含哈希级数字);Fig.4 中文按钮;Fig.3 浮动早引用两页 | | | | | |
| 第 4 轮修复+双专项修复(本轮) | 清单=摘要重写(250 词+7/11 单一口径+75/75 降格+盲区对账)/R11 两处错配句删除与"仅"字删除/bit-identical→verdict-identical/伪段落合并/intro "runs (of eleven archived, including the reference)"/两七消歧(图注+IV 开头提前引用)/Fig.3 升 figure* \textwidth(8pt)/Fig.5 字号×1.4+无衬线+J*点线+数值入 Table II 重生成/Fig.4 0.80/Fig.6 0.78/图注四修(中文按钮释义/DAQ-DCW 展开/production context 措辞落 identifiers/fig2 图注对齐框内标题+OMP 释义)/refs.bib 24 处 IEEE 刊名缩写+{ANSI/ISA-95.00.01}{IEC} 大小写保护/Index Terms 字母序小写/Sec.-Section 全局统一(句首 Section)/IEEEtriggeratref{28}/verify_evaluation_numbers.py 三模式同步+空白归一化 | | | | | 执行中 |
| 第 4 轮验证 | 12 页 / 0 编译错 / 0 未解析引用 / 219 项数值断言全过 / p12 两栏平衡 | | | | | 页数 11→12:图表可读性(MAJOR 必修)与 ≤11 页内部约束物理不可兼得(原版仅剩 0.17 页余量,图放大净需 +0.44 页);按用户最新指令(图片满足 TII 要求=发表初稿)取可读性,TII 硬上限 14 页,超页裁决权留用户 |
| 用户指令:最终完整审查(图表真实性+结构逻辑+规范优化) | | | | | | 增派数据实证席+结构逻辑席 |
| 数据实证席回收(DATA_AUTHENTICITY: PASS) | Fig.5 20+ 数值、Fig.6 30+ 数值/哈希/规模全部与 20260918043504-bdo 档案逐一对上(图源脚本自带断言直读 run.json);消融档案四臂判定吻合;Fig.2 组件逐一对应真实代码模块;Fig.4 四面板对应真实页面;零编造。两处措辞观察(Fig.6 第 4 道 check 是驱动结果非前置准入;11 档中 1 个命令多 --agent omp 后缀) | | | | | |
| 结构逻辑席回收(STRUCTURE: MINOR_REVISION) | 七项结构五项达送审水准;代码对齐抽查 11 项 10 项一致。3 Major:摘要-引言-结论分母口径漂移(7/11 vs 7/10)/C3 rerun 家族存放位置措辞/HITL 过期审批陈述与代码不符(代码有独立 expired 状态且上报,论文误称不可区分不上报);Minor:CBF 等闲置 bib 未引/harness-channel 双义/IV→V-V→VI 无过渡/discussion 标题 em-dash 等 | | | | | |
| 最终修复(本轮,按 academic-paper 规范) | 分母口径三处统一为 seven of the ten reportable (of eleven archived);C3 改 anchored on...eleven-archive rerun family;HITL 过期句按代码事实改写(expired 独立状态可区分可上报);Fig.6 图注第 4 check 措辞精确化;11 档命令行精确披露(ten verbatim/one adds LLM-agent flag);新增 ames2017cbf/gautam2025iiot/leesee2004trust/parasuramanmanzey2010complacency 4 条精准引用(41 条);harness→engine(OMP)/acquisition channels→streams 术语归一;IV→V 与 V→VI 过渡句;V-A 长段拆分;discussion 小节标题去 em-dash;摘要再压至严格口径 247 词 | | | | | 执行中 |
| 终版验证 | 12 页 / 0 错 / 0 ?? / 219 断言全过 / 视觉验收席 ACCEPT(全部重点位置落实,排版干净;两条参考项均非问题:89,894 系 110dpi 伪影、Fig.6 内部字号为已知遗留) | | | | | 通过 |
| 用户指令:引用真实性审计+academic-paper-reviewer 五席审查 | | | | | | 增派引用实证席×2(WebSearch 逐条核验)+五席审稿团(Journal-Fit/方法学/领域/跨视角/魔鬼代言人,全部只读互相隔离) |
| 引用实证回收(A 组 1-21) | CONFIRMED 21/21 存在、21/21 相关。2 Major 字段错:leitao2009 标题应为 "A state-of-the-art survey"+页码 979-991(我亲自 WebSearch 复核坐实);nee2019digital 作者主体错配他文(应为 Tao/Zhang/Liu/Nee,页码 2405-2415)。2 Minor:zhao2026 末位作者 Ji 非 Jia;wu2023autogen 两位作者名 | | | | | 无任何虚假文献 |
| 引用实证回收(B 组 22-41) | CONFIRMED 20/20、相关 20/20。2 Minor:gautam2025iiot 卷号 88→80+标题截断;iec62443-3-3 年份 2023→2013 | | | | | PASS_WITH_MINOR |
| 五席回收 | EIC: MAJOR(标题承诺 LLM 但评测零 LLM=Critical,给出重定位或补实验两选一;配置复用未量化;绑定 vs 角色无基线臂;75/75 自指;摘要防御过载) / R1 方法学: MINOR(1 Major:11 档案 same-command 标签三处不一致+选取规则未披露;8 Minor) / R2 领域: MINOR(2023 后提示注入防御文献缺;gill2025llmdt 等备而未引;biskupovic 措辞可再公允;attacks→probes;补页码 2719-2728) / R3 跨视角: MINOR(4 必修:backstop 饥饿绕过未点名/共置拓扑可否拆分/角色分离只在图注/缺 IPL-LOPA 警告) / DA: NO_UNRESOLVED_CRITICAL(最强反驳几乎全被论文预先封堵;2 MAJOR 残余=LLM 冒烟实验缺位+档案 B 选取规则) | | | | | 4/5 席 MINOR 级,EIC Critical 走文本重定位路线 |
| 五席修复落地 | 引用:6 条字段全修正+新增 liu2024pinjection(USENIX Sec 2024)+补 biskupovic 页码+落位 gill2025llmdt/isa182/eemua191/iso23247(46 条)。EIC Critical 走 (a) 路线:结论加 "No LLM client has yet exercised the governed path under controlled evaluation" 明示缺口+摘要保持 scripted 声明。R1 Major:三处口径统一为 ten reportable runs (of eleven same-seed archives)+V-A 加 "designated rather than sampled"选取规则+V-F 三档案归属 Sec.V-E family。R3 必修 4 项全落:backstop 抑制模式点名+候选缓解/62443 分区拆分未测声明/IPL-LOPA 警告/角色分离入正文;时钟同步+记录外送。R2:attacks→probes/biskupovic 措辞公允化。R1 Minors:mock tier 限定/16ms-120.161s 单次标注/33.135ms 括注/commission→provision/run-e1lite-4arm 归档 ID+祖先 commit/0.02μm 变异限定。EIC Minors:贡献3 去 ID/V-E 长段拆分/摘要 clarity。24/24+9/9 改斜杠记法,摘要严格口径 249 词 | | | | | 12 页 0 错 0 ?? 219 断言全过 |
| 用户指令:压回 ≤11 页(保内容/引用红线) | 删 Algorithm 1(ingress 顺序并入 IV-C 散文)+删 Fig.1(引言文字已完整覆盖该对比)+图表五连收(fig3 0.90/fig4 0.66/fig5 0.73colwidth/fig6 0.61/fig2 0.66)+全文措辞级压缩(V-A 四问并句/V-B/V-C 探针集合并句/V-D 残差分解去逐项数值/V-E mission-1 与 scripted-policy 收紧/V-F collapse 与 historical-LLM 收紧/mechanisms IV-A-E 三处/IV-H 审批对象并句/discussion VI-A/VI-B/结论并句/related II-A-C/Table I 删 Wt 列(DA 建议采纳)+单元格压缩/图注三轮精简/超长作者列表 IEEE et-al 截断(agents4plc/autogen/zhao)) | | | | | **11 页达成** 0 错 0 ?? 219 断言全过;verify 脚本 in_tex 改空白归一+2 锚点同步;关键发现:\IEEEtriggeratref{28} 在钉死分栏断点吸收全部压缩收益,删除后即回流 |
| 用户指令:exp 精简+动画图+恢复 Fig.1 | ①gpt-image-2 技能适配 grsai 网关(读 apifox 文档:端点 POST {base}/api/generate+results[0].url 响应+轮询 /api/result?id;generate.js 改造;国内节点 dakka 拒 key,**全球节点 grsaiapi.com 可用**;技能 .env 占位符 key 覆盖真 key 的坑);②gpt-image-2.5 生成 AgentTeam storyboard(6 panel,全部数字 25.0±0.7/28.10/32→33.8/26.62/118→120.5/3000→3031/25.68/keep/COMPLETED 逐一核对正确);③Fig.1 对比图恢复至 Introduction;④storyboard 以 figure* 入 V-E(Fig.5),叙述改"图为主文为证",V-E/V-F 再深度精简;⑤IV 的 UI 截图拼版图(fig:workflow)撤下(11 页约束下最低损失项,限制句全部保留在正文/discussion) | | | | | 最终:**11 页** 0 错 0 ?? 219 断言全过;图序号变为 1 对比/2 架构/3 闭环/5 storyboard/6 数据重建(原 1-6 顺移);verifying: fig:workflow 删除后 R3 角色分离句与中文按钮披露均保留在正文 |
| 用户指令:TII 风格重绘两图 | IEEE/TII 配图规范核查(IEEE Author Center+TII checklist:白底/矢量块图/Helvetica 类无衬线/功能性配色灰度安全/图内无标题/(a)(b) 面板标签)。审查结论:旧 storyboard 内嵌标题条+卡通脸+亮色不合 TII;fig1 矢量图合规但平淡。gpt-image-2.5 按规范 prompt 重绘:fig1-intro-tii.png(双面板对比,(a) 复制混乱 vs (b) 治理管线+共享生产 ID 条,文字零乱码)+agentteam-storyboard-tii.png(去标题条/去卡通脸/工程色/面无表情几何 glyph,数字全对)。图宽轮:fig1 0.56+trim、storyboard 0.46、fig:agentteam 0.46、fig3 0.74、fig5 0.62col、fig2 0.56 | | | | | 最终 **11 页** 0 错 0 ?? 219 断言全过;两张 gpt 图全部数字经人工逐一对档核验 |
| 用户指令:新一轮五席评审(故事线/系统设计/exp 清晰度/阅读逻辑) | 五席裁决:**EIC MAJOR**(摘要防御堆叠+accounts what 语法错+S5 与 S12 one-archive 矛盾/LLM 承诺 vs 零证据/75/75 自证头条/否定句密度)/系统席 MINOR(代码一致性 12/12;Fig.1 图注箭头语义无图例/绑定生命周期缺失/garden-path 句)/实验表达席 MINOR(**Major: J0 区间 70.115--70.248 漏 seed43 的 68.792=我的压缩回归**;storyboard 缺面板锚定/panel5 合并两写/7-10-11 长句)/摘要席 MINOR(S5 vs S12 矛盾/S7 语法/S10 丢 three seeds/Index Terms 缺 access control)/DA NO_UNRESOLVED_CRITICAL(M2: none-of-collapses-trips-gate 超证据范围) | | | | | |
| 五席修复落地 | J0 恢复三值列举(68.792 回归修复)+脚本加 68.792 锚点;摘要重写(S5 primary results+S12 family 口径统一/S7 grammar+reruns 限定/S10 attains J/J*+across three seeds);archive 实扫 11 族门态(3 塌缩全 F0 硬门绿、11th=3tg F1 hard fail)→V-E 家族段改写+补 "each with the hard gate green";摘要+Fig.1/Fig.5 图注+Data Availability 三处 AI-generated 披露;结论 reruns→runs+回收 24/24/9-9;garden-path neither...nor;backstop 动机从句;绑定生命周期 2 句(操作员授予/撤销+级联);Index Terms 加 access control(7 词);panel 锚定(panels 3/4-5);16ms 补 800ms 轮询间隔;intro 删 (six of nine);fig2 图注去 OMP 括号 | | | | | **最终:11 页 0 错 0 ?? 219 断言全过** |
| 用户指令:全页图片位置质检+exp 二次精简 | 逐页检查 11 页:全部图浮动落位规范(fig1 p2/fig2 p3/fig3 p4/fig4 p7/fig5+fig6 p9,均与首引同页或次页)、无卡位无空洞。V-D 逐 seed 数值复述删除(Fig.4(b) 已承载轨迹,J0 锚点 70.115 与双口径 0.963--0.972 保留)、V-B/V-C 检查 ID 细节上收(锚点改 14 agent engines) | | | | | 11 页 0 错 0 ?? 219 断言全过 |

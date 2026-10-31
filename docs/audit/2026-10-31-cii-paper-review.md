# Computers in Industry (CII) 投稿审查报告

> **2026-11-01 更新**:本报告的 P0 排版/投稿包问题已在
> `paper/ci/SUBMISSION-CI` 落地(elsarticle review、elsarticle-num、title page、
> graphical abstract、图 1/2 字号、表格行距、数字引用等)。最新状态见
> `docs/audit/2026-11-01-cii-submission-package.md`;本文件保留为问题清单。

> 审查对象:`paper/ci/SUBMISSION-CI/main.tex` + `main.pdf`(36 页 preprint,12pt,elsarticle authoryear)
> 审查方式:期刊要求核对 + 全文/图表/引用/实验质量审读 + 样式审计(style_audit.py)
> 说明:用户写“CiL/CiI”,按稿件 `\journal{Computers in Industry}` 判定为 **CII**;若实际目标刊不同,本报告的期刊要求部分需替换。

## 1. 总判定

**当前版本不建议直接投稿;按 CII 标准属于“Major Revision 风险 + 较高 desk-reject 风险”。**

- 论文本身质量高:问题清楚、架构完整、实验诚实、可复现性强。
- 主要风险不在写作,而在 **CII 的 application-oriented 定位** 与 **simulator-only 外部效度**;其次在 **投稿包/格式** 和 **基线对比**。
- 若补上真实产线/工业 testbed 证据、与现有 agent governance 框架的基线对比、投稿包与图表格式,达到 CII 可发表水平是现实的。

## 2. CII 期刊要求(核对)

| 项 | 要求 | 稿件现状 | 判定 |
| --- | --- | --- | --- |
| 定位 | 应用导向的工业 ICT 研究;纯 ICT 或纯制造工艺可能 out of scope | 工业协议 + 治理 + 案例;但全部 plant contact 为模拟器 | **部分符合,主要风险** |
| 文章类型 | Regular / Survey / Short notes / Comments | Regular paper | 符合 |
| 篇幅 | 聚合信息约 10,000 词(官方页未直接确认) | 正文约 9.7k 词;PDF 12.2k 词(含表/参考文献) | 边界,建议压缩 5–10% |
| 摘要 | ~250 词,可独立阅读 | 248 词 | 符合 |
| 关键词 | ≤6 | 6 | 符合 |
| Highlights | 3–5 条,每条 ≤85 字符,单独可编辑文件 | 5 条,68–79 字符,`highlights.tex` | 符合 |
| Graphical abstract | 第三方模板称 CII 期望/要求 | **缺失** | **需补** |
| 双盲 | Elsevier double-anonymized;单独 title page;匿名稿移除作者/致谢/利益声明/基金 | 主稿匿名;但无 title page;CRediT/竞争声明仍在匿名稿 | **不合规,需修** |
| 排版 | Elsevier 常规建议 12pt、双倍行距、连续行号 | 12pt,但单倍行距、无行号 | **可能不合规,需确认** |
| 图 | 矢量/≥300dpi;图内文字≥8pt | 4 图均矢量;图 1/2 有 7.5pt 文字 | **图 1/2 需重导出** |
| 表 | 表题在上,表内字号可读 | 5 表,表题在上;表 3 `footnotesize` 偏紧 | 基本符合 |
| 参考文献 | CII 使用 Elsevier numbered 风格;submission 可先一致格式 | 初稿为 `elsarticle-harv` 作者-年份;2026-11-01 已改 `elsarticle-num` 数字引用;46 条;无未解析引用 | 已修正 |
| 数据可用性 | 需声明 | 有,匿名仓库链接 | 符合 |
| 生成式 AI 声明 | 需声明 | 有 | 符合 |
| CRediT / 竞争利益 | 通常放 title page | 在匿名稿末尾 | **需移动** |
| 基金/伦理 | 按实际情况声明 | 未看到基金/伦理声明 | 视情况补 |

> 官方 Guide for Authors 页面本次返回 403;上表综合 Elsevier 公开检索结果与第三方模板。投稿前必须在 Editorial Manager 的 “Prepare your manuscript” 再核对一次,尤其是双倍行距/行号/Graphical abstract。

## 3. Fidelity ledger(关键数字与主张)

| 主张 | 数值/表述 | 位置 | 一致性 |
| --- | --- | --- | --- |
| 五协议矩阵 | 21/21 | Abstract, §6.2 | 一致 |
| 集成管线 | 17 phase gates,76/77 checks,1 warning | §6.2 | 一致 |
| 协议样本/负例 | 54 samples;24+9 negative probes | §6.2 | 一致 |
| 写往返 | median 31.6 ms | §6.2 | 一致 |
| 四臂消融 | 3 reps/arm,18 attacks/arm,69 legit;100% vs 66.7%;6 breaches;0 false blocks;9/9 boundary | §6.3,Table 3,Fig 3 | 一致 |
| 案例 1 | 16.1→15.6 MPa;130→127 rpm;gain 0.107–0.12;retest 15.616/15.656;independent 15.5 | §6.4 | 一致 |
| 案例 2 | 195→198(+3);198→200.5(+2.5);PV 199.45;0.34°C | §6.4 | 一致 |
| 模型层 | 6.42→0.02(99.7%);20 seeds 94.8% vs 42.2% | §6.5 | 一致 |
| 对抗 | 12 tool-surface violations;9 unapproved harness calls;0 writes;153 events;31.28→31.36 g vs 32.5±0.35 | §6.6 | **摘要写“twelve out-of-surface model calls”,与 12+9 不一致** |
| 单元测试 | 913/915(2 skipped) | Abstract,Table 5 | 一致 |
| 复现 | 12 天 bit-exact;第二场景 NOT reproducible | §6.7 | 一致 |
| 工具面 | 104 declared tools | §5 | **当前仓库 126(105 builtin+21 plugin),需澄清/更新** |

## 4. 主要问题(Major)

### M1 外部效度:全部 plant contact 是模拟器
CII 是 application-oriented 期刊;论文明确写“All plant contact is against simulator backends”(§7.3),案例是 simulator-backed OPC UA line。审稿人很可能认为这是 **testbed/仿真研究**,不是工业应用验证,构成 desk-reject 或 Major Revision 的首要理由。
- 建议:补一个真实产线 pilot(哪怕单点、只读+一次批准的写),或把贡献明确框定为“industrial testbed + protocol-level fidelity”,并给出真实部署路线/风险;不要用“real closed-loop”这种容易被读成真机的表述。

### M2 缺少与现有 agent governance 框架的基线对比
Related work 引用了 AgentSpec、CaMeL、AgentDojo、InjecAgent,但实验只做“自家四层”的消融,没有在同一 attack/legit workload 上对比现有框架的拦截率/误拦率/延迟。CII 审稿人会问“相比 AgentSpec 强在哪”。
- 建议:至少加一个 baseline(AgentSpec 或一个 session-level policy engine)在同一条 write path 上跑同一套 18 attacks + 69 legit,报告 interception/false block/latency;或者明确论证不可比并给出替代证据。

### M3 投稿包不符合 double-anonymized 要求
- 缺 **title page**(作者/单位/通讯/致谢/基金/竞争声明)。
- CRediT 与 competing interest 仍在匿名稿末尾;Elsevier 双盲要求这些放在 title page,匿名稿移除。
- 缺 **graphical abstract**(CII 很可能要求;至少准备一个).
- 匿名稿中 “Author names are withheld...” 可保留,但声明位置要调整。
- PDF metadata 作者是 “Anonymous Author(s)”,已匿名,good。

### M4 格式:单倍行距/无行号、关键词跨页、图 1/2 字号 7.5pt
- 当前 `elsarticle[preprint,12pt]` 是单倍行距、无连续行号;Elsevier 常规要求双倍行距+行号供 review。建议改用 `review` 选项或按 CII 最新要求排版。
- 第 1 页关键词列表被分页截断(“industrial cyber-physical systems,” 在第 1 页,其余在第 2 页);这是明确的排版缺陷。
- 图 1 有 222 字符 7.5pt、图 2 有 23 字符 7.5pt;Elsevier 图内文字建议 ≥8pt(9–10pt 更稳);需重导出或放大画布。
- 表 3 `footnotesize` 偏紧;可读但接近下限。

### M5 摘要与实验的计数不一致
摘要:“cancels twelve out-of-surface model calls”;§6.6:“twelve tool-surface violations and nine unapproved harness tool calls”。这是两个不同计数,摘要应改为“records twelve tool-surface violations and nine unapproved harness calls; zero unapproved writes”,避免审稿人抓不一致。

### M6 “real”措辞与 simulator-only 冲突
Intro 说“a real LLM-agent closed-loop case study”;虽然括号里写 simulator-backed,但“real”容易被读成真实产线。建议统一为“simulator-backed closed-loop case study with real protocol stacks”或“industrial testbed case study”。

## 5. 次要问题(Minor)

1. “104 declared tools”与当前 126 不一致;更新为评估 release 的数字,或写“104 built-in host tools at the evaluated release (plus plugin tools)”。
2. Figure 4(a) 只有两根柱,信息密度低;可改为 before/after 配对点图或加误差带;Figure 3 红/绿配色对色盲不友好,可加纹理/标记。
3. Table 2/3 的列宽偏紧,“W3–W4)”换行;可微调 `tabularx` 列宽或缩短 group 名称。
4. 文献 46 条,2025–2026 占 23 条;其中 2026 条目多为 DOI 已核验,但仍建议在正文标注 “in press/preprint” 状态,避免审稿人质疑引用未正式发表工作。
5. 人类审批质量/审批工作量未测量;论文已承认,但 CII 的人因/工业应用审稿人可能要求补一个小规模用户研究或至少讨论审批负担。
6. 配置管理变更(limits/recipe windows 本身也是配置)未纳入审批/审计;论文已列为 future work,建议在 Discussion 再强调这是部署前置条件。
7. 缺少与 CII 近期工业 agent/HITL 论文的更直接对话(已有 3 篇 CII 引用,可再加 1–2 篇同刊近作,强化 scope fit)。
8. 统计:消融 3 reps、案例单次;虽已诚实标注 descriptive,但 CII 审稿人可能要求置信区间或更多重复;至少在图表中加个体点/范围。

## 6. 引用质量审计

| 维度 | 结果 |
| --- | --- |
| 数量 | 46 条(21 journal,15 conference,9 misc/standard/preprint,1 book) |
| 时效 | 2025:12;2026:11;2024:4;2023:7;更早 12;recency 很强 |
| CII 相关性 | 3 篇 CII(OpenTwins、DT patterns、LLM DIA),scope fit 有支撑 |
| 标准 | IEC 62443-3-2/3-3、IEC 61511、IEC 62541、ISA-88/95;覆盖到位 |
| Agent safety | AgentSpec、CaMeL、AgentDojo、InjecAgent、prompt injection;覆盖到位 |
| 工业 agent | Xia、Koehle、Zhao、Waseem、Lim、Lin、Schall 等;覆盖到位 |
| 未解析引用 | PDF `??` 计数 0;bibtex warning 0;good |
| 风格 | CII 使用 `elsarticle-num` 数字引用;2026-11-01 已切换,全文一致 |
| 风险 | 2026 条目多,需确保正式出版/DOI 稳定;缺与 AgentSpec/CaMeL 的实验对比(见 M2) |

**结论:引用质量良好,覆盖面与时效性达到 CII 初稿要求;主要缺口不是“引什么”,而是“引了但没有实验对比”和 2026 条目的出版状态说明。**

## 7. 图表与排版

| 项 | 结果 |
| --- | --- |
| 图 1 架构 | 矢量、清晰;7.5pt 文字需放大到 ≥8pt |
| 图 2 写路径 | 矢量、逻辑清楚;7.5pt 文字同上 |
| 图 3 消融 | 矢量、可读;红/绿配色建议加纹理 |
| 图 4 模型层 | 矢量、可读;信息密度低,可加配对点/误差 |
| 表 2/3/4/5 | 表题在上、编号/引用完整;表 3 字号偏紧 |
| 页面 | 36 页 preprint;关键词跨页;无行号;单倍行距 |
| 摘要 | 248 词,符合 ~250 |
| Highlights | 5 条,68–79 字符,符合 ≤85 |

## 8. 与 CII 的 scope 匹配

**匹配点**:工业协议、OPC UA、MES、HITL、产线治理、数字孪生、Agent 工具面;CII 明确把 intelligent agents 列为 enabling technology;3 篇 CII 引用。
**不匹配风险**:全部实验为模拟器;CII 要“application-oriented with a generalized message”,审稿人会问“真实工厂在哪里”。这不是写作能解决的,必须补证据或重新定位。

## 9. 修改优先级(建议)

**P0(不修会被 desk reject / 直接不合规)**
1. 补 title page、graphical abstract;把 CRediT/竞争声明移出匿名稿。
2. 改双倍行距+连续行号(按 CII 最新要求);修关键词跨页。
3. 图 1/2 重导出,图内文字 ≥8pt(建议 9pt)。
4. 摘要 12 vs 12+9 计数统一;“real”改“simulator-backed/industrial testbed”。

**P1(决定 Major/Minor)**
5. 补真实产线 pilot 或至少工业 testbed 证据;明确 external validity 边界。
6. 加 AgentSpec/CaMeL 或 session-level policy baseline 的同 workload 对比。
7. 补消融/案例的重复次数或置信区间;至少加个体点/范围。
8. 更新 104 tools 数字;标注 2026 引用出版状态。

**P2(提升优秀度)**
9. Figure 4 改为配对点图/误差带;Figure 3 加色盲友好标记。
10. 补 1–2 篇 CII 近作对话;补人类审批工作量/质量的讨论或小规模研究。
11. 配置管理变更(MOC)纳入治理讨论;审计 ledger 外置/write-once 作为部署前提。

## 10. 可发表性判断

- **As-is**:CII 直接 accept 的概率低;更可能是 **desk reject(scope/validation)** 或 **Major Revision**。写作与实验诚实度是加分项,但“simulator-only + 无 baseline 对比 + 投稿包不合规”是硬伤。
- **After P0+P1**:达到 CII 可送外审并争取 Major Revision/Minor Revision 的水平;若补到真实产线 pilot,竞争力明显提升。
- **If target is TII/industrial informatics**: fit 更强;但需确认没有同时在审/重复投稿。CII 与 TII 双投是学术不端,必须先处理 prior submission 状态。

## 11. 来源

- CII Guide for Authors(官方,本次 403):https://www.sciencedirect.com/journal/computers-in-industry/publish/guide-for-authors
- Elsevier CII journal page:https://www.elsevier.com/journals/computers-in-industry/0166-3615
- Elsevier 双盲/投稿政策检索结果(Elsevier 公开页摘要;官方页 403,需在 Editorial Manager 复核)
- 稿件与图表:`paper/ci/SUBMISSION-CI/main.tex`、`main.pdf`、`figures/*.pdf`、`resources/refs.bib`、`highlights.tex`

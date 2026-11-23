# IEEE TII Regular Research Paper 初投清单

复核日期：2026-11-23（对照 TII 官网当日版本）。依据：[TII 作者须知](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics)、[初投清单](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics/new-submission?view=article&id=423:tii-checklist-for-manuscript-submissions&catid=17)、[补充材料规定](https://www.ieee-ies.org/images/files/tii/resources/Supplementary_Material-Revised.pdf)和 [IEEE 投稿与 AI 生成内容政策](https://journals.ieeeauthorcenter.ieee.org/become-an-ieee-journal-author/publishing-ethics/guidelines-and-policies/submission-and-peer-review-policies/)。

## 结论

常规初投**只上传一个文件**：本文件夹根目录的 `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf`。其余文件均为作者留存，不上传。

| 文件 | 处理 |
|---|---|
| `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf` | **上传至审稿稿件栏。** 实测：IEEEtran 双栏、US Letter、10 页、2,628,504 字节（约 2.63 MB）、26 个字体全部嵌入、无 Type 3 字体、作者元数据为空。 |
| `TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip` | 源码留存，可导入 Overleaf（`main.tex` 在压缩包根目录）；官方清单未列为初投必传。解包重编译与交付 PDF 文本一致、10/10 页像素一致。 |
| `overleaf-source/` | 同一份源码的文件夹形式（17 个文件），与压缩包内容逐文件一致。 |
| `PORTAL-FIELDS.md` | 门户字段粘贴稿：文章类型、题目、摘要、关键词，与稿件第 1 页逐字一致。 |
| `TITLE-PAGE.docx` | 门户若在 Upload Manuscript 步骤要求 **Title Page** 文件，就上传这一份（门户只收 DOC/DOCX）。它不送审稿人。先把方括号占位符填成真实的作者、单位、机构邮箱、ORCID、通讯地址、作者贡献和基金，再上传；填完用查找功能确认文中不再有 `[`。 |
| `TITLE-PAGE.md` | 上面那份 DOCX 的中文填写说明和底稿。只填入门户，不并入审稿 PDF。 |
| `Cover-Letter-IEEE-TII.md` | 可选。TII 清单第 3 条把 cover letter 列为不得随稿提交的识别性材料；只有门户提供“仅编辑可见”的投稿信栏位时才使用。 |
| `supplementary/Supplementary-File-S7-20261117.pdf` | 作者备查，不上传。TII 的补充材料只接受图形摘要、视频/多媒体、数据集说明；这份 9 页叙述性 PDF 不在其列，也不能用来规避页数限制。正文已自含主要选样依据与排除理由，不依赖它。 |
| `supplementary/supplementary-source/` | S7 的 LaTeX 源码；重编译文本与 S7 PDF 逐页一致。仅作者备查。 |
| `supplementary/Supporting-Evidence-S7.zip` | 作者备查的本地脱敏证据副本，**不进公开 Git**。若编辑部要求数据，先确认允许的类型、格式、大小和匿名方式。 |

不要上传整个文件夹、Word 编辑版、作者信息模板或公开 GitHub 链接。

## 官方 13 条逐条对照（2026-11-23 实测）

| # | 官方要求 | 稿件情况 |
|---|---|---|
| 1 | 新投稿不得超过 10 页，否则立即退回 | **10 页**，符合 |
| 2 | 所有作者账号须使用机构邮箱 | 作者在门户完成 |
| 3 | 稿件中不得出现任何可识别作者的信息（姓名、简介、单位、cover letter、版权表、脚注、致谢等） | PDF 作者元数据为空；关键词扫描未见邮箱、网址、单位名、致谢段、作者简介和未解析引用。作者姓名系统无法代查，提交前请自行通读一遍。末尾 Declarations 只含利益冲突、数据与 AI 披露，不含身份信息 |
| 4 | 若大量内容已发表于会议论文，须隐藏作者身份并以第三方口吻引用 | 无会议版（请作者确认） |
| 5 | 多部分论文将被立即拒稿 | 不适用，本文为单篇 |
| 6 | 只上传 PDF；必须嵌入非标准字体或避免使用 | **26/26 字体嵌入**，符合 |
| 7 | 必须采用 IEEE 双栏格式 | IEEEtran journal 双栏，符合 |
| 8 | 文件不超过 40 MB | 约 2.63 MB，符合 |
| 9 | 选题须在 TII 范围内 | 工业智能体、工业通信、人机交互与监控，属 TII 范围 |
| 10 | 所有被引文献须在正文中引用并讨论；应有相当比例为近期文献 | 24 条全部在正文中引用并讨论，其中 2025–2026 年 21 条。17 个 DOI 均可解析：16 条期刊/会议论文的 Crossref 登记信息（标题、刊物、年份、卷期页、作者）与 `refs.bib` 逐项一致，1 条为 CRC 专著（条目按 2001 年初版著录，DOI 指向 2018 年重印版）；4 条 arXiv 与 arXiv API 一致；MCP 规范链接可访问。2 条 ANSI/ISA 标准链接因网站反爬未能机器核验（标准本身存在） |
| 11 | 摘要须规范撰写 | 单段 220 词（按空白分词），无引文、公式、脚注；误差指标在摘要中写全称 |
| 12 | 清楚说明自己的贡献 | 引言列出三条贡献，并标注对应章节 |
| 13 | 行文清晰、无冗余 | 属评审判断项；全文章节、图表编号、交叉引用完整 |

## 作者在门户需要自己完成的事项

系统无法代填，提交前逐项确认：

- [ ] 登录 IEEE Author Portal 的 TII 入口（IEEE 账号，不是 ScholarOne 账号）。官方入口是 [ieee.atyponrex.com/journal/tii](https://ieee.atyponrex.com/journal/tii)，2026-11-23 实测它会跳转到新域名 [ieee.submission.researchexchange.com](https://ieee.submission.researchexchange.com/submission/dashboard?siteName=tii)，两个地址都能用。IEEE 账号绑定的邮箱须是机构邮箱。
- [ ] 按 `PORTAL-FIELDS.md` 粘贴题目、摘要、关键词。
- [ ] 录入全部作者：姓名、单位、**机构邮箱**、**ORCID**（TII 要求每位作者都有），确认作者顺序与通讯作者。
- [ ] 填写基金、利益冲突、作者贡献（按门户实际字段）；可参考 `TITLE-PAGE.md`。
- [ ] 确认全体作者同意本稿，且稿件不在其他刊物审理。
- [ ] **先前公开传播**：本稿的 PDF 与源码已随代码仓库进入公开 Git 历史。在仅编辑可见的渠道如实告知并提供链接；不要把链接放进匿名稿件或审稿附件。不要把公开 Git 推送视为期刊认可的预印本存档。
- [ ] **AI 使用披露**：核对稿件 Declarations 中的披露与实际使用的工具和范围一致。IEEE 政策要求 AI 生成内容在 Acknowledgments 中披露，并指明具体章节和使用程度；TII 双盲要求匿名稿不含致谢，因此初投稿放在不含身份的 Declarations 中。**录用后的终稿须把这条披露移到 Acknowledgments。**
- [ ] 上传后查看系统转换预览：确认 10 页完整，6 图 4 表无缺失，参考文献未截断。
- [ ] 建议审稿人（可选）：3–5 位从事工业智能体、OPC UA/MCP 工具访问或受治理产线写入研究的学者，无利益冲突。

## 门户填写顺序（依据 IEEE 官方 Author Portal 文档）

门户表单要登录后才能看到，TII 的具体选项以页面为准。通用步骤如下：

1. **Article Type**：在 “What kind of manuscript are you submitting?” 选 Regular Research Paper。如果页面让你选评审方式，选 Double anonymized。逐项勾选提交要求确认框。
2. **Upload Manuscript**：主文档选接受 PDF 的类型，上传 `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf`。如果页面列出 **Title Page** 文件类型，再上传填好的 `TITLE-PAGE.docx`。利益冲突一栏，如无冲突就勾选 “None of the authors have a conflict of interest to disclose”。不要上传 Cover Letter、S7、源码包。
3. **Title**：门户会从稿件里自动抓取题目，核对后点 “Yes, this is my title”；抓错了就手动选中题目。
4. **Abstract**：同上，核对后点 “Yes, this is my abstract”。
5. **Authors**：核对作者顺序。门户从 Title Page 文件里抓取作者名。
6. **Affiliations**：每个单位至少写出机构名和国家，完整写法是系名、机构、城市、国家。
7. **Author Details**：每位作者填机构邮箱、国家/地区、单位；选定**唯一**一位通讯作者；如有 CRediT 角色就按 `TITLE-PAGE.md` 第 3 节填；用 “Connect your ORCID iD” 关联 ORCID。
8. **Match Organizations**：把每个单位对应到机构数据库里的条目，对应到机构一级即可。
9. **Additional Information**：期刊自定义问题。能答的都答，至少答完必填项；常见的是基金（从列表选）、数据可用性声明（稿件 Declarations 里已有）、推荐编辑、推荐/回避审稿人。
10. **Final Review**：逐节核对。如果有 “Build Reviewer PDF” 按钮，生成并下载看一遍，确认 10 页完整、没有作者信息；然后点 “Complete my submission”。

## 页数与费用

初投严格不超过 10 页；终稿严格不超过 12 页；第 11 页起每页 250 美元（IES 会员每页 200 美元）。

## 说明

本清单是格式与合规核对，不代表已通过编辑初筛或查重。门户字段与附件受理以提交当天的系统为准。

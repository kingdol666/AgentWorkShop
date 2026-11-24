# IEEE TII Regular Research Paper 初投清单

复核日期：2026-11-24（Fig. 3 更新版）。依据：[TII 作者须知](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics)、[初投清单](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics/new-submission?view=article&id=423:tii-checklist-for-manuscript-submissions&catid=17)、[补充材料规定](https://www.ieee-ies.org/images/files/tii/resources/Supplementary_Material-Revised.pdf)和 [IEEE 投稿与 AI 生成内容政策](https://journals.ieeeauthorcenter.ieee.org/become-an-ieee-journal-author/publishing-ethics/guidelines-and-policies/submission-and-peer-review-policies/)。

## 结论

常规初投匿名审稿稿件栏上传 `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf`。如门户要求双盲 **Title Page** 文件，另外上传已经填写好的 `IEEE-TII-Title-Page.docx`；该文件不会发送给审稿人。

| 文件 | 处理 |
|---|---|
| `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf` | **上传至匿名审稿稿件栏。** 实测：IEEEtran 双栏、US Letter、10 页、2,628,542 字节（约 2.63 MB）、26 个字体全部嵌入、无 Type 3 字体、作者元数据为空。 |
| `TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip` | 源码留存，可导入 Overleaf；解包重编译与交付 PDF 文本一致、10/10 页像素一致。 |
| `overleaf-source/` | 同一份源码的文件夹形式（17 个文件），与压缩包逐文件一致。 |
| `PORTAL-FIELDS.md` | 门户字段粘贴稿；摘要为 220 词，与当前源码一致。 |
| `IEEE-TII-Title-Page.docx` | 门户要求时上传；编辑可见、不发送给审稿人。含当前题目、Haozheng Zhang、Bo Fu、Liangbin Li、Jungen Chen、两组单位、通讯地址和邮箱、Acknowledgments。 |
| `TITLE-PAGE.md` | Title Page 内容说明和底稿。 |
| `Cover-Letter-IEEE-TII.md` | 可选；TII 常规初投不需要，且不得并入匿名稿。 |
| `supplementary/Supplementary-File-S7-20261124.pdf` | 作者备查，不上传；正文不依赖它。新增“Live runtime walk-through (November 24, 2026)”一节（含 4 张实机控制台截图与 S7-XII 记录表）。 |
| `supplementary/live-runtime-20261124/` | 该节引用的截图与记录级证据 JSON；显示平台标识，故不进匿名附件。 |
| `supplementary/Supporting-Evidence-S7.zip` | 作者备查的本地脱敏证据副本，不进公开 Git。 |

## 本轮全文复核

- Fig. 3 已替换为作者提供的 PNG；其余图件、实验数字和参考文献库未替换。
- 第 IV 节首次引入 Fig. 3 时说明其为 `optimization_explore` 的概念流程，不是第 VI 节报告的端到端试验。
- Fig. 3 图注明确区分可选回读与后续 DAQ，并说明拒绝请求不进入驱动、继续调节或停止需要下一次 agent 决策。
- 摘要、闭环章节、讨论和结论的实验口径已对齐实际证据，不把未测试的端到端 agent 路线写成已验证结果。
- 24/24 引用键、参考文献和渲染条目一致；所有 `\ref` 有标签；6 张图和 4 张表都有正文引用。

## 官方要求逐条对照

| # | 官方要求 | 稿件情况 |
|---|---|---|
| 1 | 新投稿不得超过 10 页 | **10 页** |
| 2 | 作者账号使用机构邮箱 | 作者在门户完成 |
| 3 | 双盲稿件不含作者身份 | PDF 作者元数据为空；未发现作者联系方式或项目识别信息；作者姓名需提交前自行通读确认 |
| 4 | 既有会议版本需披露 | 作者确认是否存在 |
| 5 | 多部分论文不接受 | 本文为单篇 |
| 6 | 上传 PDF，字体嵌入 | 26/26 字体嵌入，无 Type 3 |
| 7 | IEEE 双栏 | IEEEtran 双栏 |
| 8 | 不超过 40 MB | 约 2.63 MB |
| 9 | 属于 TII 工业应用范围 | 工业智能体、工业通信、监控/控制和软件运行时 |
| 10 | 所有引用在正文讨论，且有近期文献 | 24/24 引用完整；本轮未修改文献库 |
| 11 | 摘要规范 | 单段 220 词，无引文、公式、脚注 |
| 12 | 贡献清楚 | 引言列出三项贡献并对应章节 |
| 13 | 行文清晰、无冗余 | 本轮检查章节逻辑、图引入、图注和结论口径 |

## 门户填写顺序

1. **Article Type**：选 Regular Research Paper；若让选评审方式，选 Double anonymized。
2. **Upload Manuscript**：上传 `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf`。若列出 Title Page 类型，再上传填好的 `IEEE-TII-Title-Page.docx`。无利益冲突时勾选 None。
3. **Title / Abstract**：与稿件自动抓取内容核对；摘要以 `PORTAL-FIELDS.md` 为准，避免 PDF 断行连字符。
4. **Authors / Affiliations**：核对作者顺序、机构、邮箱和 ORCID；选择唯一通讯作者。
5. **Additional Information**：填写基金、数据可用性、推荐/回避编辑或审稿人等实际必填项。
6. **Final Review**：确认系统生成的审稿预览为 10 页、无作者信息、Fig. 3 完整，再点击 Complete my submission。

不要上传整个文件夹、源码 ZIP、S7 叙述 PDF、Supporting-Evidence ZIP、Cover Letter 或公开 GitHub 链接到匿名审稿附件栏。

# IEEE TII Regular Research Paper 初投清单

核对日期：2026-11-23。依据：[TII 作者须知](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics)、[初投清单](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics/new-submission?view=article&id=423:tii-checklist-for-manuscript-submissions&catid=17)、[补充材料规定](https://www.ieee-ies.org/images/files/tii/resources/Supplementary_Material-Revised.pdf)和 [IEEE 摘要指南](https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/create-the-text-of-your-article/structure-your-article/)。

## 选择文件

| 文件（位于 `initial-package/`） | 本次初投处理 |
|---|---|
| `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf` | **上传至审稿稿件栏。** 本地核验：IEEEtran 双栏、Letter、10 页、约 2.21 MB、字体嵌入、作者元数据为空；摘要为单段、216 词（按空白分词）且无引文、脚注和公式。页数和文件大小上限仍须以提交时的 Author Portal 为准。 |
| `TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip` | 源码留存，可导入 Overleaf；官方清单未列为初投必传。 |
| `Supplementary-File-S7-20261117.pdf` | 作者备查；不要把这份 9 页叙述 PDF 当作常规补充件上传。正文已保留主要选样依据与排除理由，不依赖 S7 叙述附件。`supplementary-source/` 为其 LaTeX 源码（可复编译），同样仅作者备查。 |
| `Supporting-Evidence-S7.zip`（本地） | 作者备查；含脱敏记录、README 和校验清单，不是默认上传项。若编辑部要求数据，应先确认允许的类型、格式、大小和匿名方式；不要用补充材料规避页数限制。 |

截至 2026-11-23 查阅的 TII 在线初投清单将稿件列为初投审查对象，TII 作者须知规定双盲审稿；请在提交当天复核 Author Portal 是否要求其他文件。不要上传整个目录、Word 编辑版、作者信息模板或公开 GitHub 链接。S7 默认作为作者备查；如编辑部要求提供额外数据，先确认当时允许的文件类型、格式、大小限制与匿名要求。

## 作者在门户确认

- [ ] 登录 [IEEE Author Portal](https://ieee.atyponrex.com/journal/tii)，选择 Regular Research Paper；所有作者提供机构邮箱与 ORCID，确认作者顺序、单位、通讯作者。
- [ ] 核对并填写作者贡献、基金和利益冲突（按门户实际字段）。如需提交作者信息页或投稿信，使用 `initial-package/Cover-Letter-IEEE-TII.md` 作为编辑可见草稿，并先确认门户中的可见性；不要把它们合并到稿件 PDF。
- [ ] 确认所有作者批准本稿，稿件不在其他刊物审理；如存在会议论文、预印本或其他先前公开版本，按期刊政策如实披露。公开 Git 历史可能把稿件与项目或账号关联：在保密的编辑沟通渠道告知已有公开版本及链接，不在匿名稿件或审稿附件中放链接。不要把公开 Git 推送视为期刊授权的预印本存档。
- [ ] 核对稿件的 AI 声明与实际工具及用途一致，特别确认最终采用的图 1/2 是否另含需要披露的生成内容；不要把未采用的历史绘图草稿算入。根据 [IEEE PSPB 政策](https://pspb.ieee.org/images/files/PSPB/opsmanual.pdf)，在不暴露作者身份的 Acknowledgment 中注明系统、生成内容所在部分及使用程度；稿件已披露已知的摘要草拟、语言编辑、LaTeX 组织和图 4 排版。
- [ ] 核对模型试跑的 `deepseek-flash` 端点标注与原始配置记录一致；现有 S7 脱敏日志不独立证明该端点名，且未留存服务端模型快照。不要把端点别名当作精确模型版本。
- [ ] 查看上传后的转换预览并确认 10 页完整、图 4 第 6 页、参考文献无截断、作者和识别性致谢不在审稿稿件中。门户字段、附件受理及编辑初筛，以实际系统与编辑部通知为准。

终稿上限 12 页；第 11 页起每页 250 美元（IES 会员每页 200 美元）。本清单不是查重结果，也不代表已提交或通过编辑初筛。

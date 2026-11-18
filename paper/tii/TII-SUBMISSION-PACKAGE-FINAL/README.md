# IEEE TII 论文提交包

2026-11-18 修订。正文、Word 版、Overleaf 包与叙述性补充材料均基于本目录中的最新版。

| 文件 | 用途 | 页数 |
| --- | --- | ---: |
| `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf` | IEEEtran 双栏投稿排版 | 9 |
| `TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip` | 可直接导入 Overleaf 的 LaTeX 源码包 | — |
| `TII-SUBMISSION-PACKAGE-FINAL.docx` | 可编辑单栏 Word 版 | 15 |
| `TII-SUBMISSION-PACKAGE-FINAL-preview.pdf` | 单栏 Word 预览 | 15 |
| `TII-SUBMISSION-PACKAGE-FINAL-ieee-two-column.docx` | 可编辑双栏 Word 版 | 11 |
| `TII-SUBMISSION-PACKAGE-FINAL-ieee-two-column-preview.pdf` | 双栏 Word 预览 | 11 |
| `supplementary/Supplementary-File-S7-20261117.pdf` | S7 叙述性补充材料，已随正文更新 | 9 |
| `review-20261117/manuscript-review-20261118.md` | 全文审查结论、修订说明和证据范围 | — |

Overleaf 项目入口是根目录的 `main.tex`，使用 pdfLaTeX 和 BibTeX。已在空目录解包并完整编译。正文为 Letter 开本，保留 6 图、4 表、3 个显示公式、1 个算法和 24 条参考文献。图 2 取自本轮提供的 3414 × 1428 Draw.io PNG，保存为 RGB 并移除嵌入编辑器数据，所有可见像素与附件一致。

如需本地重编，从 `overleaf-source/` 执行 `latexmk -pdf main.tex`。S7 源文件在 `supplementary/`，在该目录执行 `latexmk -pdf Supplementary-File-S7.tex` 可引用相邻项目中的同一文献库。

`supplementary/Supporting-Evidence-S7-20261112.zip` 是本地工作证据包，保留实验记录及其来源。包内视频和部分嵌套文件含项目标识或机器路径，审稿分发前需要完成匿名核查。共同时间窗复算使用 `review-20261117/common-window-sensitivity.ps1`，结果见同目录 CSV。

提交前，请按 TII 投稿系统核对匿名要求和作者字段，并确认作者贡献、基金、利益冲突及文中 AI 使用说明。投稿排版采用 9 页 LaTeX PDF。

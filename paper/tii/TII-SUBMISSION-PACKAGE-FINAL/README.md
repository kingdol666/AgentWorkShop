# TII-SUBMISSION-PACKAGE-FINAL

提交用最终包（2026-11-18 投稿版：摘要重构 197 词；全文语言润色；Discussion/Conclusion 含系统功能总结、闭环控制未实现的显式表述、以及"智能体编排式自主闭环优化 + 过程经验记忆复用"两条未来工作）。内容与命名如下，按用途取用即可。

## 交付件

| 文件 | 说明 | 页数 |
|---|---|---|
| `TII-SUBMISSION-PACKAGE-FINAL.docx` | **主交付件**：单栏 Word 版（LaTeX→DOCX 直转，非期刊双栏模板） | 18 |
| `TII-SUBMISSION-PACKAGE-FINAL-preview.pdf` | 上述单栏 Word 的 PDF 预览 | 18 |
| `TII-SUBMISSION-PACKAGE-FINAL-ieee-two-column.docx` | 备选：按 IEEE TII 双栏模板排版的 Word 版 | 12 |
| `TII-SUBMISSION-PACKAGE-FINAL-ieee-two-column-preview.pdf` | 双栏 Word 的 PDF 预览 | 12 |
| `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf` | LaTeX（pdfLaTeX）编译成稿（投稿用主文件） | 10 |
| `TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip` | Overleaf 导入包（`main.tex` 在根目录，resources/ 含 4 个矢量 PDF + 2 个 300 dpi PNG + refs.bib） | — |

> `*.zip` 与 `build/` 按仓库既有规则不入库；需要时由 `overleaf-source/` 重新打包或编译。

## 补充材料（正文引用为 Supplementary File S7）

| 文件 | 说明 |
|---|---|
| `supplementary/Supplementary-File-S7-20261117.pdf` | S7 叙述性补充材料（9 页，匿名版），首页标题与正文一致 |
| `supplementary/Supporting-Evidence-S7-20261112.zip` | 配套证据档案（约 20 MB，记录级数据、清单、脱敏日志与缺失证据清单） |

> 两者的关系：S7 PDF 是“叙述部分”，zip 是“证据部分”，投稿时按期刊系统要求分别作为 supplementary files 上传。

## 源与素材

- `overleaf-source/`：LaTeX 源（`main.tex` + `sections/` 8 个 .tex + `resources/` + `refs.bib`），Overleaf 可直接编译（pdfLaTeX + BibTeX）。
- `submission/`：投稿材料——`COVER-LETTER.md`（编辑可见，含作者信息段占位）、`TITLE-PAGE.md`（作者/ORCID/CRediT/基金/COI 模板，填入 Author Portal）、`SUBMISSION-CHECKLIST.md`（IEEE Author Portal 逐项清单与双盲自查）。
- `related-ieee-papers-20261117/`：相关 IEEE 文献索引（`README.md` 列题目/DOI/与本文关系）；6 篇公开版 PDF 仅本地留存，不入库（第三方版权，见该目录 `.gitignore`）。
- `review-20261117/`：评审用的窗口敏感性脚本与结果 CSV。

## 编译/核对口径

- LaTeX：Letter，10 页；图 2/3 为 300 dpi PNG（图 2 为清理版：479 ppi、RGB 无透明软掩码），图 5 已调整图例间距。
- 单栏 Word：Letter、1 英寸页边距，6 图 4 表 3 公式 24 文献齐全，图件与源文件逐字节一致。
- 双栏 Word：IEEE TII 版式（双栏 3.5 in、小号大写罗马数字标题、8 pt 题注、页眉页码），11 页。

## 投稿前仍需作者确认

1. **作者信息**：当前为完全匿名版（`\author{}`、Word 中 “Anonymous Author(s)”、声明亦写明匿名）。请按 TII 现行审稿制度补作者/单位/通讯作者与 ORCID。
2. **页数**：正文 10 页（IEEE 双栏）；请对照投稿系统所示页数上限（含超页费）确认。
3. **声明**：利益冲突、AI 使用声明、基金与贡献信息需作者核实；数据可用性语句引用的补充材料见上表。

_最后更新：2026-11-17_

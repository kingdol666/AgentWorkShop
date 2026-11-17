# TII-SUBMISSION-PACKAGE-FINAL

提交用最终包（2026-11-17）。内容与命名如下，按用途取用即可。

## 交付件

| 文件 | 说明 | 页数 |
|---|---|---|
| `TII-SUBMISSION-PACKAGE-FINAL.docx` | **主交付件**：单栏 Word 版（LaTeX→DOCX 直转，非期刊双栏模板） | 18 |
| `TII-SUBMISSION-PACKAGE-FINAL-preview.pdf` | 上述单栏 Word 的 PDF 预览 | 18 |
| `TII-SUBMISSION-PACKAGE-FINAL-ieee-two-column.docx` | 备选：按 IEEE TII 双栏模板排版的 Word 版 | 11 |
| `TII-SUBMISSION-PACKAGE-FINAL-ieee-two-column-preview.pdf` | 双栏 Word 的 PDF 预览 | 11 |
| `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf` | LaTeX（pdfLaTeX）编译成稿 | 10 |
| `TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip` | Overleaf 导入包（`main.tex` 在根目录，resources/ 含 4 个矢量 PDF + 2 个 300 dpi PNG + refs.bib） | — |

> `*.zip` 与 `build/` 按仓库既有规则不入库；需要时由 `overleaf-source/` 重新打包或编译。

## 源与素材

- `overleaf-source/`：LaTeX 源（`main.tex` + `sections/` 8 个 .tex + `resources/` + `refs.bib`），Overleaf 可直接编译（pdfLaTeX + BibTeX）。
- `related-ieee-papers-20261117/`：相关 IEEE 文献索引（`README.md` 列题目/DOI/与本文关系）；6 篇公开版 PDF 仅本地留存，不入库（第三方版权，见该目录 `.gitignore`）。
- `review-20261117/`：评审用的窗口敏感性脚本与结果 CSV。

## 编译/核对口径

- LaTeX：Letter，10 页；图 2/3 为作者提供的 300 dpi PNG，图 5 已调整图例间距。
- 单栏 Word：Letter、1 英寸页边距，6 图 4 表 3 公式 24 文献齐全，图件与源文件逐字节一致。
- 双栏 Word：IEEE TII 版式（双栏 3.5 in、小号大写罗马数字标题、8 pt 题注、页眉页码），11 页。

_最后更新：2026-11-17_

# IEEE TII 初投交付包（最终版，2026-11-23）

本目录是本轮终审、润色与重编译后的**唯一交付位置**，把正文 PDF、源码、补充材料和 Cover Letter 集中在一起。上游编辑源仍是 [`../TII-SUBMISSION-PACKAGE-FINAL/`](../TII-SUBMISSION-PACKAGE-FINAL/)，本目录内容与之一致。

## 上传项

| 文件 | 上传位置 | 说明 |
|---|---|---|
| [`manuscript/TII-SUBMISSION-PACKAGE-FINAL-latex.pdf`](manuscript/TII-SUBMISSION-PACKAGE-FINAL-latex.pdf) | **匿名审稿稿件栏** | IEEEtran 双栏、Letter、10 页、2.21 MB、作者元数据为空、26 个字体全部嵌入 |
| [`Cover-Letter-IEEE-TII.md`](Cover-Letter-IEEE-TII.md) | 门户投稿信字段（如要求） | 编辑可见草稿；作者、ORCID、基金、利益冲突、既往公开传播与 AI 披露需作者填写确认，**不并入匿名稿** |

常规初投**只需上传正文 PDF**。源码 ZIP 与编辑源码供 Overleaf 复编译和作者留存，TII 官方清单未将其列为初投必传项。

## 源码（两种形式，内容一致）

- [`source/TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip`](source/TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip)：可直接导入 Overleaf，`main.tex` 在压缩包根目录。
- [`source/overleaf/`](source/overleaf/)：同一份编辑源码的文件夹形式，17 个文件（`main.tex`、8 个章节、6 个图件、`refs.bib`、`README.txt`）。

编译方式：pdfLaTeX + BibTeX（`latexmk -pdf main.tex`）。已验证该文件夹重编译得到的 10 页与交付 PDF 逐页文本及 144 dpi 渲染完全一致。

## 补充材料（作者备查，不作常规初投附件）

- [`supplementary/Supplementary-File-S7-20261117.pdf`](supplementary/Supplementary-File-S7-20261117.pdf)：9 页 S7 叙述材料，引用原始证据档案内容。
- [`supplementary/supplementary-source/`](supplementary/supplementary-source/)：S7 的 LaTeX 源码，可复编译，文本与 PDF 逐页一致。
- `supplementary/Supporting-Evidence-S7.zip`：本地脱敏证据副本，含审计记录与校验清单。**已在 `.gitignore` 中排除，不进入公开 Git**；完整的原始档案保留在 `../../supplementary/`。

TII 的补充材料规定只接受 graphical abstract、video、multimedia 和数据集 README 等类型，且不得用于规避页数限制。因此 S7 默认不上传；如编辑部另行要求数据，先确认当时允许的格式、大小与匿名要求。正文已保留主要选样依据与排除理由，审阅不依赖 S7。

## 作者与流程材料

- [`SUBMISSION-CHECKLIST.md`](SUBMISSION-CHECKLIST.md)：本次初投清单、门户待办与双盲核对项。
- [`TITLE-PAGE.md`](TITLE-PAGE.md)：作者/单位/CRediT/基金模板，仅填入门户，不进审稿 PDF。
- [`FINAL-REVIEW-20261123.md`](FINAL-REVIEW-20261123.md)：终审意见、逐章论证地图、实验可支撑与不可支撑的判断。

## 校验

| 文件 | SHA-256 |
|---|---|
| `manuscript/TII-SUBMISSION-PACKAGE-FINAL-latex.pdf` | `304af6bc5c1bf7fac60bfd596c90c0636c7884de2715490cf5765af4aeb292ac` |
| `source/TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip` | `c30e38ac70c8e5e4ad69632dd1cae2caec580df86e25548110bdb30a10de1183` |
| `supplementary/Supplementary-File-S7-20261117.pdf` | `f7de9f604c38c5826f2eaee164ca02d604e1eafbe1666cf3fe404b1d607f0cb3` |
| `supplementary/Supporting-Evidence-S7.zip`（本地） | `42f23ccbf6f22bfa02b56ca593e72bff88f66758b907040de40f8b912150f5a0` |

已完成的验收：10 页正文与 9 页 S7 逐页视觉通过；字体全部嵌入、无未解析引用或排版溢出；ZIP 内 17 个文件与源码文件夹逐字节一致；摘要单段 216 词（上限 250）、5 个关键词、24 条参考文献；正文未发现本地路径、账号或邮箱。文本与格式验收不预判期刊接收。

# IEEE TII 初投交付包（2026-11-21 图 1 修订版）

本目录集中存放**你要的"改过图 1"那一版**：正文 PDF、源码、补充材料和 Cover Letter。

该版对应 2026-11-21 凌晨完成图 1 替换与页 1 验收的稿子（源码状态见 Git 提交 `1c40a78c8`，WIP 快照 `backup/wip-tracked-20261121`）。图 1 由 `make_fig1.py` 用铸膜线插画合成矢量标注，正文已相应披露 `the cast-film machine row in Fig. 1 is a text-to-image illustration composited with vector annotations`。

> 已回退的两次尝试不在此目录：2026-11-23 的润色版（摘要/结论口径统一）留存在本地 `../TII-POLISH-ATTEMPT-20261123/` 与提交 `3780b4c3`；无图 1 修订的 11-21 提交版见提交 `1ae080e1`。

## 上传项

| 文件 | 上传位置 | 说明 |
|---|---|---|
| [`manuscript/TII-SUBMISSION-PACKAGE-FINAL-latex.pdf`](manuscript/TII-SUBMISSION-PACKAGE-FINAL-latex.pdf) | **匿名审稿稿件栏** | IEEEtran 双栏、Letter、10 页、2.61 MB、作者元数据为空、26 个字体全部嵌入；第 1 页含图 1 的 2560×562 位图 |
| [`Cover-Letter-IEEE-TII.md`](Cover-Letter-IEEE-TII.md) | 门户投稿信字段（如要求） | 编辑可见草稿；作者、ORCID、基金、利益冲突与既往公开传播需作者填写确认，**不并入匿名稿** |

常规初投**只需上传正文 PDF**。源码 ZIP 与编辑源码供 Overleaf 复编译和作者留存。

## 源码（两种形式，内容一致）

- [`source/TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip`](source/TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip)：可直接导入 Overleaf，`main.tex` 在压缩包根目录。
- [`source/overleaf/`](source/overleaf/)：同一份编辑源码的文件夹形式，17 个文件。

编译方式：pdfLaTeX + BibTeX（`latexmk -pdf main.tex`）。已验证：解包重编译得到的 10 页与交付 PDF **文本一致、144 dpi 逐页像素一致**。相对 11-21 凌晨的成稿，本版只改了两处——移除图 1/图 4 中不绘字的 Helvetica 空文本块（图形零变化），以及把第 IV 节的观测窗口锚点 $t_0$ 由"写入时刻"改为"预读与审批等待之前的操作时间戳"，与实现一致。

## 补充材料（作者备查，不作常规初投附件）

- [`supplementary/Supplementary-File-S7-20261117.pdf`](supplementary/Supplementary-File-S7-20261117.pdf)：9 页 S7 叙述材料。
- [`supplementary/supplementary-source/`](supplementary/supplementary-source/)：S7 的 LaTeX 源码。
- `supplementary/Supporting-Evidence-S7.zip`：本地脱敏证据副本，**已在 `.gitignore` 排除，不进公开 Git**。

## 作者与流程材料

- [`SUBMISSION-CHECKLIST.md`](SUBMISSION-CHECKLIST.md)：初投清单与双盲核对项。
- [`TITLE-PAGE.md`](TITLE-PAGE.md)：作者/单位/CRediT/基金模板，仅填入门户。

## 校验

| 文件 | SHA-256 |
|---|---|
| `manuscript/TII-SUBMISSION-PACKAGE-FINAL-latex.pdf` | `24d6819bd72c4b53399bd04f364c5249e30ac06f280b2eaf1a5b8f68a4d6d116` |
| `source/TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip` | `0dfe153ea28d16561718ef1774d5f899512e559b29591e261d89ee31b7e119e5` |
| `supplementary/Supplementary-File-S7-20261117.pdf` | `f7de9f604c38c5826f2eaee164ca02d604e1eafbe1666cf3fe404b1d607f0cb3` |
| `supplementary/Supporting-Evidence-S7.zip`（本地） | `42f23ccbf6f22bfa02b56ca593e72bff88f66758b907040de40f8b912150f5a0` |

本版实测：10 页、2.61 MB、摘要单段 216 词、6 个关键词、24 条参考文献、26 个字体全部嵌入（无未嵌入字体）；第 1 页图 1 位图为 2560×562。图 1 与图 4 仅移除了 PDF 内一个不绘字的空文本块，300 dpi 渲染与原图逐字节相同，图形本身未改动。文本与格式验收不预判期刊接收。

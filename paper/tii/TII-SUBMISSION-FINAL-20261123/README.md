# IEEE TII 初投交付文件夹（2026-11-23 版）

这个文件夹集中存放可直接用于 TII 初投的全部材料：**编译好的 PDF、源码（压缩包和文件夹）、门户粘贴稿，以及作者自用的清单、题目页、Cover Letter 和补充材料**。

## 上传什么

**匿名审稿稿件栏只上传以下 PDF：**

| 文件 | 说明 |
|---|---|
| [`TII-SUBMISSION-PACKAGE-FINAL-latex.pdf`](TII-SUBMISSION-PACKAGE-FINAL-latex.pdf) | 匿名审稿稿件。IEEEtran 双栏、US Letter、10 页、2,628,504 字节（约 2.63 MB）、作者元数据为空、26 个字体全部嵌入 |

门户表单里要填的题目、摘要、关键词在 [`PORTAL-FIELDS.md`](PORTAL-FIELDS.md)，与稿件第 1 页逐字一致。

如果门户要求 **Title Page** 文件（双盲评审的常规做法），上传填好的 `TITLE-PAGE.docx`。它不送审稿人，需要你先填入作者、单位、机构邮箱、ORCID 等真实信息。

## 文件夹内容

| 文件或目录 | 用途 |
|---|---|
| `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf` | **匿名审稿主文件** |
| `TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip` | 完整源码包，17 个文件，`main.tex` 在根目录，可直接导入 Overleaf |
| `overleaf-source/` | 同一份源码的文件夹形式，与压缩包逐文件一致；在本机继续编辑用这一份的权威副本 `../TII-SUBMISSION-PACKAGE-FINAL/overleaf-source/` |
| `PORTAL-FIELDS.md` | 门户字段粘贴稿 |
| `SUBMISSION-CHECKLIST.md` | 初投清单：官方 13 条逐条对照、门户填写顺序、作者待办、页数与费用 |
| `TITLE-PAGE.docx` | 门户用的题目页模板（DOCX），含方括号占位符，填好后再上传 |
| `TITLE-PAGE.md` | 题目页的中文填写说明和底稿 |
| `Cover-Letter-IEEE-TII.md` | 可选投稿信；TII 常规初投不需要，且不得并入匿名稿 |
| `supplementary/Supplementary-File-S7-20261117.pdf` | 9 页 S7 证据叙述材料，作者备查，不上传 |
| `supplementary/supplementary-source/` | S7 的 LaTeX 源码 |
| `supplementary/Supporting-Evidence-S7.zip` | 本地脱敏证据副本，不进公开 Git |

## 编译方式

pdfLaTeX + BibTeX：`latexmk -pdf main.tex`。已验证：把压缩包解到空目录重新编译，得到的 10 页与交付 PDF **文本一致、逐页像素一致**。

## 修订记录（2026-11-23）

实验数字未动。按时间顺序：

1. **移除未嵌入字体**：图 1、图 4 的 PDF 中有一个不绘字的 Helvetica 资源，改为只保留已嵌入字体；300 dpi 渲染与原图逐字节相同。同时把第 IV 节观测窗口锚点 $t_0$ 改为“预读与审批等待之前的操作时间戳”，与实现一致。
2. **修正证据归属**：第 VI-C 节原写 “In a separate follow-up batch, all 110 tested values … were rejected”，与原始证据不符——这 110 条 `RECIPE_LIMIT_EXCEEDED` 记录与 220/219/216 那组数字出自**同一个**场景–协议矩阵运行（`runId 20261106180144`）。改为 “In the same scene--protocol matrix run, …”。同时把 `pdfkeywords` 元数据对齐正文关键词（只影响元数据）。
3. **补充实验设置**：第 VI 节首段写明三个 LLM 驱动回合跑在 **OMP agent harness** 上（`the episodes ran on the OMP agent harness with the deepseek-flash model endpoint`），与 S7 记录一致。
4. **更新 AI 披露**：Declarations 改为 `Generative AI via Codex (GPT-6) assisted with language polishing and LaTeX typesetting`；图 1 合成插画的说明保留。

5. **更换 Fig. 3 并复核全文**：原样使用作者提供的 3600 × 1518 PNG，其他五张图不变。第 IV 节的正文和图注明确区分概念流程与已报告的试验；摘要、讨论和结论对齐共享分派、路由检查与消融试验实际支持的结论。更新了门户摘要粘贴稿。

## 核验记录（2026-11-23）

| 项 | 结果 |
|---|---|
| 页数、纸张 | 10 页，US Letter |
| 字体 | 26/26 嵌入，无 Type 3 |
| 编译日志 | 0 错误，0 溢出（overfull），0 未解析引文或交叉引用；16 处 underfull |
| 位图分辨率 | 图 1 为 814 ppi，图 2 为 478 ppi，图 3 为 504 ppi |
| 匿名性 | 作者元数据为空；未见作者联系方式、项目链接或识别性致谢；参考文献链接保留 |
| 参考文献 | 24/24 正文有引、均进入文末参考文献；6 张图和 4 张表均有正文引用；沿用此前核验过的同一份文献库 |
| 源码包重编译 | 与交付 PDF 文本一致、10/10 页在 144 dpi 渲染下像素一致 |
| 改动页视觉验收 | 已检查第 1、4、5、9、10 页；新版 Fig. 3 位于第 5 页，其他五页与上一版像素一致 |
| S7 补充材料 | 用其源码重编译，文本与 PDF 逐页一致；数字与正文全部对应 |

## 校验值（SHA-256）

| 文件 | SHA-256 |
|---|---|
| `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf` | `3d6610bc5653239d092137f300b250666203899af21c08fd692ff6210855b9d5` |
| `TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip` | `817dc862dd3dc4f05cec49b7b095f835a9f285164b6f2ecb4adfaae7a60fd2ce` |
| `supplementary/Supplementary-File-S7-20261117.pdf` | `f7de9f604c38c5826f2eaee164ca02d604e1eafbe1666cf3fe404b1d607f0cb3` |
| `supplementary/Supporting-Evidence-S7.zip`（本地） | `42f23ccbf6f22bfa02b56ca593e72bff88f66758b907040de40f8b912150f5a0` |

格式与合规核验不预判期刊是否送审或接收。

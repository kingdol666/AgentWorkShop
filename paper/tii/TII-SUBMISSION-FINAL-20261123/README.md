# IEEE TII 初投交付文件夹（2026-11-24 Fig. 3 更新版）

这个文件夹集中存放可直接用于 TII 初投的全部材料：**编译好的 PDF、源码（压缩包和文件夹）、门户粘贴稿，以及作者自用的清单、题目页、Cover Letter 和补充材料**。

## 上传什么

**匿名审稿稿件栏上传：**

| 文件 | 说明 |
|---|---|
| [`TII-SUBMISSION-PACKAGE-FINAL-latex.pdf`](TII-SUBMISSION-PACKAGE-FINAL-latex.pdf) | 匿名审稿稿件。IEEEtran 双栏、US Letter、10 页、2,628,542 字节（约 2.63 MB）、作者元数据为空、26 个字体全部嵌入 |

门户表单里要填的题目、摘要、关键词在 [`PORTAL-FIELDS.md`](PORTAL-FIELDS.md)，摘要为 220 词并与当前源码一致。

如门户要求双盲 **Title Page** 文件，上传已填写的 [`IEEE-TII-Title-Page.docx`](IEEE-TII-Title-Page.docx)。它不送审稿人。

## 文件夹内容

| 文件或目录 | 用途 |
|---|---|
| `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf` | **匿名审稿主文件** |
| `TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip` | 完整源码包，17 个文件，`main.tex` 在根目录，可直接导入 Overleaf |
| `overleaf-source/` | 同一份源码的文件夹形式，与压缩包逐文件一致 |
| `PORTAL-FIELDS.md` | 门户字段粘贴稿 |
| `SUBMISSION-CHECKLIST.md` | 初投清单、门户填写顺序、作者待办、页数与费用 |
| `IEEE-TII-Title-Page.docx` | 已完成的编辑可见 Title Page；作者信息与通讯信息已按当前稿填写 |
| `TITLE-PAGE.md` | Title Page 内容说明和底稿 |
| `Cover-Letter-IEEE-TII.md` / `IEEE-TII-Cover-Letter.docx` | 可选投稿信（内容一致的 Markdown 与 Word 两版）；只讲贡献、证据边界与后续闭环优化工作，不含作者身份、基金、推荐审稿人等识别信息；TII 常规初投不需要，且不得并入匿名稿 |
| `supplementary/Supplementary-File-S7-20261124.pdf` | 12 页 S7 证据叙述材料（含 2026-11-24 实机控制台走查一节），作者备查，不上传 |
| `supplementary/live-runtime-20261124/` | 实机走查的 4 张控制台截图与记录级证据 JSON（含截图说明 README）；显示平台标识，不进匿名附件 |
| `supplementary/supplementary-source/` | S7 的 LaTeX 源码（含本节新增图件） |
| `supplementary/Supporting-Evidence-S7.zip` | 本地脱敏证据副本，不进公开 Git |

## 本轮 Fig. 3 与全文复核

1. **替换 Fig. 3**：使用作者提供的 3600 × 1518 PNG；其余五张图和实验数字未改。嵌入 PDF 的 Fig. 3 图像对象与原 PNG 的 RGB 像素一致。
2. **图文一致性**：第 IV 节将 Fig. 3 明确为 `optimization_explore` 的概念流程，不冒充第 VI 节已完成的端到端试验；图注区分写入成功、可选回读、后续 DAQ 和下一次 agent 决策。
3. **逻辑收紧**：摘要、闭环章节、讨论和结论不再把“设计上可用的路由检查”写成“本轮已经全部实验验证”；结论明确限制在已测试的应用层集成边界。
4. **引用与标签**：24/24 引用键、参考文献和渲染条目一致；所有 `\ref` 有标签；6 张图和 4 张表都有正文引用。

## 编译方式

pdfLaTeX + BibTeX：`latexmk -pdf main.tex`。已验证：把源码压缩包解到空目录重新编译，得到的 10 页与交付 PDF **文本一致、10/10 页逐页像素一致**。

## 核验记录（2026-11-24）

| 项 | 结果 |
|---|---|
| 页数、纸张 | 10 页，US Letter |
| PDF 大小 | 2,628,542 字节，约 2.63 MB |
| 字体 | 26/26 嵌入，无 Type 3 |
| 编译日志 | 0 错误，0 溢出，16 处 underfull |
| 图像 | Fig. 3 为 3600 × 1518，约 504 ppi；其他图件未替换 |
| 引用 | 24/24 正文有引、均进入文末参考文献；无未解析引用或交叉引用 |
| 匿名性 | 作者元数据为空；PDF 未发现作者联系方式或项目识别信息 |
| 视觉验收 | 第 1、4、5 页通过；Fig. 3 的三阶段、箭头、回路线、拒绝分支和图注均完整可读 |
| Title Page | 1 页 DOCX；标题、4 位作者、2 个单位、两组通讯地址和邮箱、Acknowledgments 均完整；DOCX postcheck 9/9 通过 |

## 校验值（SHA-256）

| 文件 | SHA-256 |
|---|---|
| `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf` | `fa9b31ecb9e994cf2c0b5144987e99d03f46f3c476188e5479ed175a619cfcb4` |
| `TII-SUBMISSION-PACKAGE-FINAL-overleaf.zip` | `2b15cc06fa673ceb568689dc6c25223acdd57e5020f92c3eeb86d829028acefc` |
| `overleaf-source/resources/fig3.png` | `bc024477547b0d45b1e0377f358f036e7dbdf4550c3db2341122ac3b4642e143` |
| `supplementary/Supplementary-File-S7-20261124.pdf` | `b2f1c4ed78e2f1a4de7306f4cd033319269dc6fa73692c75b44ffa84d864a04f` |
| `supplementary/live-runtime-20261124/fig-s7-1-approval-card.png` | `4a47f9dfccb75a13e379621974460fc99d487bc5dc4f46a17f72290764f30bc7` |
| `supplementary/live-runtime-20261124/fig-s7-2-write-history.png` | `9c1e9666fee0c11a535a8685d0252102a6a2a944bb631bd392807bc4881b0ff1` |
| `supplementary/live-runtime-20261124/fig-s7-3-part-weight-trend.png` | `434f0519afcefd2300eb913396505311faf4265f65066298fa3d615b961bee7a` |
| `supplementary/live-runtime-20261124/fig-s7-4-line-console.png` | `a9ca4cc5c0b941e5a21fe6d22977b56a711f6947961349b209ba5fc443b5f66e` |
| `supplementary/Supporting-Evidence-S7.zip`（本地） | `42f23ccbf6f22bfa02b56ca593e72bff88f66758b907040de40f8b912150f5a0` |

格式与合规核验不预判期刊是否送审或接收。

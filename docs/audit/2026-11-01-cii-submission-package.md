# CII submission package — 2026-11-01 更新

> 基于 2026-10-31 审查意见，已完成 CII 初稿排版与结构重写。旧的审查报告
> `docs/audit/2026-10-31-cii-paper-review.md` 仍保留为问题清单；本文件记录
> 已落地的修改与剩余风险。

## 1. 已完成的排版/结构修改

| 项 | 修改 |
| --- | --- |
| LaTeX 模板 | `elsarticle` 官方类，`\documentclass[review,12pt,a4paper]`；`lineno` 连续行号 |
| 参考文献 | 从 `elsarticle-harv` 改为 **CII 的 `elsarticle-num`**；全文 `\cite{}` 数字引用；无 `??`/undefined |
| 双盲 | 主稿无作者/单位；PDF metadata author 为空；单独 `title-page.tex/pdf` |
| 标题页 | 作者/单位/通讯/CRediT/竞争利益/基金/致谢/数据可用性占位模板 |
| Highlights | 5 条，68–79 字符，单独 `highlights.tex/pdf` |
| Graphical abstract | 新增 `figures/graphical-abstract.png`，1535×590 px、300 dpi（≥1328×531）；另有 PDF |
| 图 1/2 | 改用更短标签、8.0–9.0pt；最终 PDF 有效字号约 9.6–10.8pt；无溢出 |
| 图 3 | 加高画布、标签 30°；柱状图/图例可读；图 4 保持 |
| 表 1–5 | 表格内 `setspace` 单倍行距，修复 review 模式表格过高；表 1 列宽调整 |
| 关键词跨页 | 已不再从中间截断；关键词整体落在第 2 页 |
| 摘要 | 250 词（上限 250）；修正“12 out-of-surface calls”→“12 tool-surface violations + 9 unapproved harness calls” |
| 工具数 | 104 → “105 built-in + 21 plugin = 126 at the evaluated release” |
| 故事线 | Introduction 增加 running example（130→127 rpm 的治理路径）；Architecture 增加五步 Walkthrough；Discussion 增加 industrial-testbed/plant-pilot 的 staged 论述 |
| Cover letter | `cover-letter.md` 草稿 |
| 检查清单 | `submission-checklist.md` |

## 2. 构建产物

| 文件 | 页数/尺寸 | 说明 |
| --- | --- | --- |
| `main.pdf` | 46 页 | 匿名 review 稿，行号；1.5 行距（`review` 选项） |
| `title-page.pdf` | 1 页 | 作者信息占位，需填 |
| `highlights.pdf` | 1 页 | 5 条 highlights |
| `figures/graphical-abstract.png` | 1535×590 @300dpi | Elsevier 最小 1328×531 |
| `figures/fig1-architecture.pdf` … `fig4-modeltier.pdf` | 矢量 | 图内有效字号 8.3–10.8pt |
| `main.bbl` | 46 refs | `elsarticle-num` |

构建命令见 `submission-checklist.md`；`main.log` 无 undefined reference/citation，0 overfull box。

## 3. 仍需作者完成

1. 填 `title-page.tex` 的作者/单位/通讯/CRediT/基金/致谢。
2. 填 `cover-letter.md` 的通讯作者信息；确认“不在他刊审稿中”（尤其若曾投 TII）。
3. 确认 CII 当前 Guide 是否要求 **双倍行距**；当前 `review` 选项是 1.5。若要求 2.0，在 `main.tex` 加 `\doublespacing` 并重建。
4. 在 Editorial Manager 核对 Graphical abstract 是否必填、图件上传格式（TIFF/EPS/PDF/Office）。
5. 把 `figures/*.pdf` 作为单独图件上传（系统也接受嵌入图，但 CII 通常要求单独文件）。
6. 代码/数据匿名仓库链接填入 title page 与 Data availability。

## 4. 仍未解决的学术风险

1. **Simulator-only external validity**：CII 是 application-oriented；当前所有 plant contact 是模拟器。补真实产线 pilot 是最大的录用变量。
2. **无 AgentSpec/CaMeL/session-policy 基线对比**：当前只做自家四层消融。建议同 workload 加一个 baseline。
3. **消融/案例统计强度**：3 reps、单次案例；建议加重复/置信区间，或明确作为工程验证。
4. **人类审批质量/工作量**未测量。
5. **Graphical abstract 仍是示意图**；如 CII 要求更“结果导向”，可换成“四层拦截 + 回读分级”的结果图。

## 5. 判定

- **排版/投稿包：submission-ready**（P0 已落地）。
- **学术录用：不保证**；最大的两个变量是真实产线证据和 baseline 对比。
- 如果目标是 CII，建议先补一个真实/半实物 pilot，再投；否则按 industrial testbed 框架投，预期 Major Revision。

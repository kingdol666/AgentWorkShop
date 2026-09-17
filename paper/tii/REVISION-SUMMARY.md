# 论文与六图修订交付 — 2026-09-17

## 交付范围

- `main.pdf`：完整工作稿，目标与本轮编译结果均为 **11 页**，包括六图、三表、算法和参考文献。
- `main.tex` 与 `sections/`：可继续编辑的 LaTeX 正文。
- `figures/publication/index.html`：六图预览与 HTML/SVG/PDF/PNG 下载入口。
- `figures/publication/`：唯一正在被正文引用的六图源。目录外旧图仅作为历史资产保留。

## 章节重构

III 以核心进程/外部引擎与存储、工业节点、Channel成员与显式绑定、生产上下文、操作与数据流讲清总体架构。
IV 分别介绍节点创建连接、Channel协作、节点控制执行、产线运营、Agent闭环、recipe与回退，以及跨机制HITL。
V 按证据单位分开报告源码核查、mock API、五驱动软件协议、第二场景、生命周期/故障演练、固定控制器、治理消融与探索性LLM案例。
VI/VII 收敛到真实集成价值、实现与证据边界，不承诺工业安全认证或LLM优化优越性。

## 六图

1. 引言：有限设计范式对照，避免概括所有既有系统。
2. 总体架构：区分共驻核心、外部引擎/存储、协议与设备边界。
3. 第四章：Channel位于中心，四周显式厚度/压力DAQ与加热/转速DCW节点；人工、准入、反馈、判定、backstop与补偿分开。
4. 第四章末：真实归档界面裁剪，展示创建、设备关联、团队部署、优化记录；未伪造读数或控件。
5. 固定控制器三seed轨迹：区分每次J与最后两次均值J_end。
6. 四臂消融：只使用原始材料完整的三次重复基线，显示六个固定攻击计数及逐重复p50/p95。

图1–4使用双栏矢量图，图5–6使用单栏矢量图；配图文字嵌入PDF，图4截图保持栅格真实性。配图构建脚本及数据来源/哈希随稿提供。

## 重要纠错

- 不再声称全系统单进程、检查到物理执行原子、2%调幅强制限幅、密码学签名账本、所有来源相同治理、judge工具自行计算判定。
- K=2明确为保留的rolled-back记录计数，不是不可重置的节点终身预算。
- 多对多设备关联是元数据，不意味着一次写入多设备扇出；回退监测的设备匹配为primary alias。
- 记录同值写入可能结束观察、批次停止钩子500记录上限、多节点补偿非原子的边界。
- 直接归档核查将主运行攻击计数由旧稿20/20纠正为 **24/24**；第二场景 **9/9** 分开报告，不构造统计独立的合并安全率。
- 集成比较工具空比较风险仍存在：本轮不修复产品/benchmark代码，不把现有REPRODUCIBLE标签当作有效复现证明。
- 四次LLM历史评分保留为旧脚本输出，但有效主评分均标NA；不同采样/缺失值/温度规则下不与固定控制器排名。
- 8项关键文献做了有界原始来源核对，修正Agents4PLC、Raza、LLM4PLC元数据；未认证全部参考文献。

## 验证与审查

- `reviews/final/verification.json`：页数、图序/页码、六图格式、字体嵌入、未解析引用/溢出检查及PDF哈希。
- `reviews/final/page-contact-sheet.png`：11页总览；同目录有每页PNG。
- `reviews/benchmark-verification-20260917.md`：独立核算全部12组p50/p95、3seed J_end/ratio、源哈希、实验分母和LLM限制。
- `reviews/mechanism-review-20260917.md`：独立机制核查与修正处置。
- `reviews/reference-check-20260917.md`：8项关键引用核对范围与限制。
- `reviews/evidence-ledger-20260917.md`：主张保留/限定/撤回依据。
- 独立视觉审查报告如已完成，见 `reviews/layout-review-20260917.md`。

## 投稿边界

**11页为用户指定的完整工作稿，不是TII常规论文初投稿页数合规证明。** IEEE IES官网2025-01-01起规定Regular Research Paper新投稿最多10页、录用终稿最多12页。本轮2026-09-17已再次核对该政策。

没有任何编辑工作能够保证审稿人接受。当前稿件仍需作者确认、全部引用复核、合适的匿名材料与投稿阶段选择；引用仓库链接意味着匿名作者块不等于完整匿名。见 `SUBMISSION-CHECKLIST.md`。

本轮没有修改产品实现、benchmark执行脚本、历史原始结果或模拟器，也没有新增实验。历史材料缺失、比较工具缺陷和观测问题均明确保留，而非通过改数据消除。

## 重建

在仓库根目录：

```powershell
python paper/tii/figures/publication/build_figures.py
node paper/tii/figures/publication/export_figures.mjs
python paper/tii/figures/publication/verify_figures.py
latexmk -pdf -interaction=nonstopmode -halt-on-error -cd paper/tii/main.tex
python paper/tii/reviews/verify_publication.py --render
```

复建仅生成图和论文，不运行工业benchmark。替换正文/字体/图尺寸后须重新确认11页、图位置和最终参考文献换栏点。

# direction-approved.md — Gate file (三方向确认门)

Status: **PENDING USER SELECTION** — 三个方向的真实视觉已产出并渲图，等待用户选择。
实现（转 PDF、替换 LaTeX 浮动体）**未开始**，符合 huashu-design Fallback Phase 5 硬门。

## 已展示的三版（全部为渲出的真实视觉，非文字描述）

| # | 文件 | 截图 | 逻辑 | 为何不同 |
|---|------|------|------|----------|
| A | `design-demos/A-magazine-pop.svg` | `shots/A-magazine-pop.png` | 🎲 秒数轮盘 #4 · 杂志撞色数据页（Businessweek） | 结论式大标题压顶，撞色双主色（墨蓝 × 信号红），极端字号对比（6.5→11.9pt 共 8 级），(a) 的重复集成被红框圈成堆叠块 |
| B | `design-demos/B-distill-axis.svg` | `shots/B-distill-axis.png` | 🏆 现实参照 · Distill.pub 技术解释图语法 | 不喊口号：(a)(b) 共用同一套列坐标上下对照，低饱和概念色（灰/琥珀/绿）各绑一个语义，发丝细线 + 负空间分组 |
| C | `design-demos/C-aicher-grid.svg` | `shots/C-aicher-grid.png` | 🧠 最佳设计师 · Otl Aicher（1972 慕尼黑奥运视觉系统 / Ulm 栅格） | 可见 12 栏栅格、只走 0/90° 正交布线、全大写宽字距、同模数组件；底部一条贯穿全幅的 PLANT 带被两个方案共享 |

三版的布局骨架互异（A 标题领起左右两栏 / B 共享横轴上下面板 / C 共享植物带左右镜像），
不是换色换字体的同一骨架。

## 每版都完整承载的内容（横向可比）
- (a) 每应用各自复制 driver · permission · log，×N 重复；write path 上三个悬空问题：
  who is authorized / which limits apply / write ↔ outcome link
- (b) Channel → member–node binding → DAQ/DCW nodes → plant devices (5 protocols)
- 准入检查 recipe · approval · range；共享上下文 line · product · recipe · run
- 回程 readback / process observation / verdict recorded
- 收口物件 intervention record = proposal | result | observation | verdict
- 范围声明：readback where supported · fast PLC regulation outside the loop

## 已通过的硬约束自检
- 画布 716 × 270 units，与现图 aspect 一致（放置宽度 7.16 in，高度 2.70 in，不改变 10 页版面预算）
- 矢量（SVG）→ 可无损转 PDF 供 LaTeX 使用
- 三版均通过灰度验证（`shots/*-gray.png`），颜色不是唯一信息载体
- 无渐变、无阴影、无 emoji、无圆角卡片、无 red/green 对立配色
- 字体仅用系统已安装face（Arial / Segoe UI / Tahoma），不会静默回退导致重排

## 待用户选择后要做的（尚未执行）
1. 依所选方向生产最终版：最小字号抬到 10 units（7.2 pt，IEEE 图内文字建议下限），
   画布高度最多 +15 units；已核对第 6 页现有 ~1 in 余量，不会把论文推到 11 页
2. SVG → 矢量 PDF，替换 `figures/publication/fig1-governed-binding.pdf`
3. 依新图微调 `sections/introduction.tex` 中 Fig. 1 的 caption
4. 重新编译并复核：10 页、无 undefined ref、无 overfull box、数值断言 88/88

## 用户选择原话（待填）
> （等待用户回复）

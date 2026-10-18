# 数据分析历史 + RAG 检索 + UI 响应式优化验收报告（2026-10-18）

> 目标：核实分析结果入历史、RAG 能检索到 DOE 结果，并做真实演示；随后按 `web-design-engineer` skill 优化前端 UI 的响应式与渲染，最后全功能交互复验。
> 环境：平台 v0.7.66（3001，重建后）· IDD 3210 · RAG 8771/6789 · 模拟器 4036 · 线 `ln-dd4d6163`
> 结论：**A1-A6 全部通过** —— 台账/RAG/交互/四档响应式/视觉一致性/console 零错误；截图见 `tmp-e2e/_ui-shots-20261018/`（before/after/final/interaction）。

## 一、验收标准与结果

| 编号 | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| A1 | 数据分析历史 | ✔ | REST `GET /analysis?line_id=&q=DOE` 返回 8 条，含 **`ar-881ee996`**（DOE 试验分析）；UI 台账 ≥10 行且 DOE 标题可见 |
| A2 | RAG 检索 DOE 结果 | ✔ | 直查 `/search`：命中 **DOE 全因子分析文档本体**（score 0.69，`aw-industrial/注塑线 ln-dd4d6163 DOE 全因子分析：保压压力SP × 机筒一区温度SP(2026-10-18).md`）+ 衍生知识条目（0.70/0.67）；**插件面板 UI 检索同样命中 5 条** |
| A3 | 前后端交互 | ✔ | 台账加载/关键词筛选 9 行/重置恢复/详情展开（结论明细·完整正文·支撑指标）/人工修订弹窗开合/双插件「检测连接」=连接正常/390 卡片展开 |
| A4 | 自适应窗口 | ✔ | 1440/1280/768/390 四档：无横向滚动、无文字挤压；≤760 表格转**卡片列表**（时间·产线·类别 → 标题 → 摘要 → 来源 → 操作）；768 收窄非关键列（配方/来源隐藏） |
| A5 | 视觉一致性 | ✔ | 沿用控制室 token（绿 #35e0a0/青 #41c8f4/深海军蓝/玻璃面板）；类别 chip 语义色（optimization 绿/quality 青/alarm 红）；行 hover 4% 青染；标题 `clamp(22px,3vw,30px)`；正文 12.5→13px 与 `text-wrap:pretty` |
| A6 | console 零错误 | ✔ | final 四视口 ×（/analysis、/plugins）**errors=0**；全交互路径 0 错误 |

## 二、发现并修复的问题

1. **窄屏表格不可用（主问题）**：/analysis 的 7 列表格在 768/390 下被压成逐字竖排。
   → `AnalysisTable.vue` 新增 ≤1099px 隐藏配方/来源、≤760px 卡片布局（grid 定位、详情单列、报告块 max-height 46vh）、行 hover、类别语义色、标题/摘要 `text-wrap:pretty`。
2. **页头/弹窗不适配**：页头标题固定 30px；编辑弹窗固定 720px 在 390 溢出。
   → 页头 `clamp(22px,3vw,30px)` + 描述 `max-width:72ch`；弹窗 `max-width: calc(100vw - 24px)` + 窄屏表单单列。
3. **插件运行表挤压**：diag-bridge 运行表在窄屏列宽崩坏。
   → `.aw-diag-table-wrap { overflow-x:auto }` + 表格 `min-width:540px`、单元格 nowrap（同步 builtin）。
4. **500 错误（构建错位）**：`/_nuxt/builds/meta/<id>.json` 500（客户端 buildId 与产物不一致）。
   → 重建 + 重启后消除（final 全视口 0 次 5xx）。
5. **390 hydration mismatch**：语言选择器在 hydration 首帧按真实视口切短名（SSR 用全名）。
   → `HeaderTools.vue` 用 `hydrated` 门控（首帧与 SSR 一致，挂载后再切短名），390 console 归零。

## 三、截图证据

- 优化前：`_ui-shots-20261018/before/`（analysis-390 逐字竖排）
- 优化后：`_ui-shots-20261018/final/`（1440/1280/768/390 × analysis/plugins，全部 0 错误）
- 交互：`_ui-shots-20261018/interaction/`（详情展开/筛选/RAG UI 检索/插件检测/移动端卡片展开）

## 四、遗留观察（不影响验收）

- line-sentinel 插件在每次 DAQ 样本到达时弹全局 toast（如「🛡 line-sentinel · 1 样本 · 0 告警」），移动端会短暂遮挡内容 2-3 秒——属插件自身行为，建议该插件在窄屏禁用或改为角标。
- 编辑弹窗仅对 `canEdit` 行出现（权限模型 v2 的设计），本轮 admin 可见并可开合。

## 五、复现入口

- `tmp-e2e/ui-shot-20261018.mjs --tag <before|after|final>`（四视口截图+console/溢出检测）
- `tmp-e2e/ui-interaction-accept-20261018.mjs`（12 项交互验收）
- 本轮改动：`AnalysisTable.vue` / `AnalysisPageHead.vue` / `AnalysisEditModal.vue` / `HeaderTools.vue` / `.AgentWorkShop+builtin diag-bridge client.mjs`

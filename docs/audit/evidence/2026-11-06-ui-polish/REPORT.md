# Project 界面 UI 重构与全站下拉框修复（2026-11-06）

> 范围：`feat/project-continue-20261106`（未提交工作区）
> 页面：`/projects`、`/projects/:id`，以及全站原生 `select` 基线
> 环境：隔离 AW_HOME `D:/codes/ABO/aw-router-demo-home-20261105`，端口 3982，真实项目 `a1955fd9…`（值班手册，已完成 plan v3）
> 结论：**Project 页从页面私有的硬编码暗色改为全站令牌驱动；桌面/移动、亮/暗均无溢出、无控制台错误、对比度达 AA；全站原生下拉框在 Chrome 135+ 使用可定制弹层，暗色下不再出现白底黑字。**

## 0. 结论

| 维度 | 判定 |
|---|---|
| Project 详情布局 | **PASS**：页头 / KPI / 吸顶 tab / Leader 对话 / 计划·交付物·审批·事件分区重排，tab 从页面底部移到顶部 |
| 亮暗一致性 | **PASS**：删除页面私有暗色，全部使用 `--paper/--ink/--tone-*`；亮色下白卡深字、暗色下深卡浅字 |
| 下拉框 | **PASS**：项目页改用 AntD Select（浮层随主题）；全站原生 select 撤掉 OS 外观，Chrome 135+ 用 `appearance: base-select` 接管弹层 |
| 桌面/移动适配 | **PASS**：1440×900 与 390×844 均无横向溢出；移动端 tab 横滑、KPI 2×2、会话输入框与发送按钮在视口内 |
| 交互 | **PASS**：tab 切换、AntD 下拉真实选中并回填、`继续开发` 聚焦输入框、输入后发送按钮启用 |
| 回归 | **PASS**：typecheck / i18n parity / unit 1146（1144 pass，2 skipped）/ build 全过 |
| 其他页面 | **PASS**：`/workshop`、`/analysis`、`/daq`、`/logs` 在 390/1440、暗色下布局审计 0 issue；`/studio` 等页下拉框已随主题 |

## 1. 问题根因

1. **Project 两页自带一套硬编码暗色**：`#161a22` 卡片、`#e6e8ee` 文字、`#3b82f6` 按钮。暗色主题下看似正常，切到亮色就变成“白画布 + 黑色卡片 + 浅色字”，与全站令牌体系完全脱节。
2. **原生 `<select>` 在 Windows Chromium 上由 OS 绘制**：即使写了 `background: transparent`，关闭态仍可能绘制浅色按钮面；展开弹层是系统菜单，`option` 与 `color-scheme` 都无法改它的白底。
3. **Project 页 tab 在 DOM 末尾**：视觉上要滚到页面底部才能切视图；`v-show` 区块顺序本身是对的。
4. **列向 flex 的 `flex-basis` 被当成高度**：页头/输入区在 390px 下出现 300–500px 空洞，把 KPI、tab、发送按钮推到视口外。
5. **对话正文直接 `{{ m.text }}`**：Markdown 的 `**`、反引号原样露出。

## 2. 改动

### 2.1 `/projects/:id`（项目详情）

- 页头改用 `aw-page-head` + 状态胶囊 + `plan vN / 待审批 / leader` 元信息 chips；操作按钮按主次重排（继续开发/激活/恢复为主操作）。
- 新增 4 格 KPI：交付物签核、工作项完成、待审批、Leader 对话。
- 五个 tab 移到页头下方并吸顶（`top: var(--app-header-h)`），横向可滚动；带数量徽标，审批 tab 有待办时高亮。
- Project Leader 对话重构：Leader 头像/办公室标识、完成/暂停提示条、气泡左右分列、`mdLite` 渲染 Markdown（先转义，`v-html` 有 eslint 说明）、空态、字数计数、`Ctrl/⌘+Enter`、非 owner 禁用并说明原因。
- 频道列表显示绑定状态（已绑定/已解绑），已解绑条目降透明度；下拉选项只列 active Channel。
- 交付物列表显示验收 criteria；成果 evidence 收进 `<details>`；审批历史改为“类型 + 主体 + 状态 + 时间 + 可展开 payload”，避免长 JSON 撑爆行。
- 工作项表加横向滚动容器；新增/派发/取消/重试保留原 testid。
- 执行工作台、路由日志、计划快照、决策/事件全部令牌化；抽屉全屏移动端。
- 状态中文化：工作项/成果/交付物/审批分别映射（审批 `approved` = 已批准，交付物 = 已验收），原始状态保留在 `title` 与 `data-state`。

### 2.2 `/projects`（项目列表）

- 页头 + 新建项目表单令牌化；Leader 引擎改 AntD Select。
- 项目卡网格：状态胶囊、目标三行截断、mode/plan/办公室 meta chips、hover 抬升、键盘 Enter 可打开。
- 空态、窄屏单列、创建按钮全宽。

### 2.3 全站原生 select（`app/assets/css/main.css`）

- `html { color-scheme: light }` / `html.dark { color-scheme: dark }`：滚动条、原生弹层、日期控件跟随主题。
- `select:not(.ant-select)` 基线：`appearance: none`、令牌表面、CSS 雪佛龙、focus 环；`option` 背景/前景令牌化。
- `@supports (appearance: base-select)`（Chrome 135+）：弹层交回 HTML，`::picker(select)` / `option:checked` / `::checkmark` 全部用令牌；弹层不再受 Windows 系统菜单影响。
- 不支持 `base-select` 的浏览器自动落回原生基线（关闭态仍是主题化的；弹层由浏览器/系统绘制）。

### 2.4 其他

- 修正列向 flex 的 `flex-basis`（`.head-main/.head-actions/.composer-hint`）。
- `scripts/ui/projects-interactions.mjs` 适配 AntD Select 与中文状态徽标（`data-state`）。
- 新增 `scripts/ui/project-visual-acceptance.mjs`；`scripts/ui/audit-layout.mjs` 支持 `AW_TOKEN`，可在隔离 demo home 上审计。

## 3. 验收

### 3.1 Project 视觉/交互（`acceptance.json`）

| 场景 | 横向溢出 | 原生 select | 焦点 | 发送按钮 | 选中回填 | pageerror/console |
|---|---|---|---|---|---|---|
| dark / 1440×900 | 无 | 0 | `project-continue-input` | 可见 | `2a12401e… · 负责值班手册 Markdown 生产` | 0 / 0 |
| dark / 390×844 | 无 | 0 | 同上 | 可见（focus 以 composer 为锚点） | 同上 | 0 / 0 |
| light / 1440×900 | 无 | 0 | 同上 | 可见 | 同上 | 0 / 0 |
| light / 390×844 | 无 | 0 | 同上 | 可见（focus 以 composer 为锚点） | 同上 | 0 / 0 |

- 输入「回归验证」后发送按钮 `disabled=false`；清空后恢复。
- 关键文字对比度：chat body 14.56–16.38、chat hint 5.69–7.56、KPI 15.85–18.31、active tab 15.85–18.31、card sub 5.41–7.13（均 ≥ AA）。
- 测试覆盖 tab：概览、计划与工作、交付物、审批、决策与事件；每个 tab 均截图。

### 3.2 全站布局审计（`audit/audit.json`）

`/workshop`、`/analysis`、`/daq`、`/logs` × 390×844/1440×900 × dark：**8/8 组合 0 issue**（无溢出、无裁切、无重叠、触摸目标与字号达标、对比度达标）。

### 3.3 UI 交互矩阵（隔离 home，真实点击）

`scripts/ui/projects-interactions.mjs`：**28/28 PASS，0 fail**。覆盖列表渲染 → UI 建项目 → 绑定频道 → 建交付物 → **AntD 下拉选交付物/频道** → 建工作项 → 激活 → 计划审批 → 派发 → 完成/对账 → 成果提交/复核/申请验收 → 审批批准 → Leader 提案应用 → 周报刷新/导出 → 五 tab 断言 → 页面无未捕获异常。

- 证据：`interactions/interactions.json`、`interactions/project-interactions.png`
- 该矩阵使用独立 `AW_HOME` 与临时端口，不修改实机值班手册项目。

### 3.4 门禁

- `npx eslint`（改动文件）✅
- `npm run typecheck` ✅
- `npm run i18n:check` **3255/3255 PARITY OK**
- `npm run check:cssvars` **162 个变量引用全部有定义**
- `npm run test:unit` **1146 tests / 1144 pass / 0 fail / 2 skipped**
- `npm run build` ✅

## 4. 证据

- `shots/`：详情/计划/交付物/审批/事件 × dark/light × desktop/mobile + 列表页 + 对话卡（32 张）。
- `other/`：`/workshop`、`/studio`、`/analysis`、`/logs`、`/settings` × dark/light。
- `raw/studio-select-open-dark.png`：修复前原生弹层白底；`raw/studio-base-select-dark2.png` / `light2.png`：修复后暗/亮弹层。
- `raw/studio-select-closeup2.png`：关闭态令牌表面 + 雪佛龙。
- `raw/chat-mobile-probe.png`：390px 下对话卡与发送按钮在视口内。
- `acceptance.json`、`audit/audit.json`：机器可读结果。
- 改造前对照：`../2026-11-06-project-business/project-business-final-desktop.png`。

## 5. 复现

```bash
# 构建
npm run build

# 隔离 demo home 启动（端口 3982）
AW_HOME=D:/codes/ABO/aw-router-demo-home-20261105 \
AW_MODE=home NUXT_SESSION_PASSWORD='<local-only>' \
AW_PROMPTS_DIR=D:/codes/ABO/aw-router-v3/.output/.AgentWorkShop/prompts \
AW_ROOT_RESCUE_STALE_MS=600000 PORT=3982 NITRO_PORT=3982 \
node .output/server/index.mjs

# 截图/交互验收（需本地 demo 用户）
node scripts/ui/project-visual-acceptance.mjs a1955fd9-e3ff-45fa-919d-a4fa1b61a576
```

## 6. 残余 / 如实声明

1. **原生 select 弹层的完全接管依赖 Chrome 135+**（`appearance: base-select`）。本机 Chromium 156 实测通过；更老的 Chromium 落回原生弹层，Windows 上展开列表仍可能是系统浅色菜单。全站 AntD Select（项目页、模板筛选等）不受此限制。
2. Project 页仍是单文件大页面（约 3.6k 行），本次只做 UI/交互重构，未拆分为 `components/projects/*`；后续建议按 header/chat/plan/deliverables/approvals 拆分。
3. 项目页新文案仍为中文硬编码（与改造前一致），未纳入 i18n 词条；`i18n:check` 仅证明既有词条未破坏。
4. 项目页仍是 5s 轮询，无 SSE；与上一轮报告一致。

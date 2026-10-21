# AgentWorkShop 前端 UI/UX 验收规范（工业 MES 控制台）

- 版本：2026-10-18 · UI Refresh R1
- 适用范围：`app/` 下全部页面（含动态详情页与插件浮层）
- 验收环境：Chromium（本机 Chrome）、视口 390×844 / 768×1024 / 1440×900 / 1920×1080、亮/暗双主题
- 基线工件：`.ui-review/baseline-1440`（改造前）、`.ui-review/after-*`（改造后）、`scripts/ui/audit-layout.mjs` 报告

## 1. 设计方向

**Industrial Instrument Panel（工业仪表台）**：冷静的中性色基底 + 单一信号绿主色，等宽数字、细刻度线、发丝分隔与低饱和状态色；层级来自 surface 阶梯和 1px 边界，而不是大圆角、玻璃模糊和彩色光斑。

| 维度 | 规范 |
| --- | --- |
| 主色 | 品牌绿 `#35e0a0`（暗）/ 深绿（亮，白字 ≥ 4.5:1） |
| 语义色 | 绿=运行/成功，青=数据/信息，琥珀=需关注，红=告警，紫=重试 |
| 中性色 | 冷灰蓝族（steel），亮/暗各自成阶；禁止暖灰与冷灰混用 |
| 标题字体 | Geist 600；正文 400/500；数据、ID、时间一律 Geist Mono + tabular-nums |
| 字号 | 页标题 28–30px，卡片标题 14–15px，正文 13–14px，标签 ≥ 11px，微标签 ≥ 10.5px（审计阈值 11px） |
| 圆角 | 卡片 12px，控件 8px，小件 6px；胶囊只用于状态/计数/头像 |
| 间距 | 4px 基数；页面区块 14–16px，卡片内距 16–20px，页面左右留白 ≥ 20px（桌面） |
| 背景 | 冷灰画布 + 极淡工程网格（32px）；不使用彩色光斑/动画极光作为主视觉 |
| 动效 | 120–200ms，transform/opacity；`prefers-reduced-motion` 全收敛 |

## 2. 结构验收（A）

- **A1 顶栏**：任何视口下，页签航迹不得与右侧功能簇重叠（几何相交为 0）；用户铭牌不得换行/越界；< 900px 只显示当前页标题。
- **A2 横向溢出**：文档级 `scrollWidth - clientWidth = 0`；表格/日志等允许自身横向滚动，但页面不得整体横向滚动。
- **A3 页面头**：每页一个 `h1`；kicker → 标题 → 描述 → 右侧动作，四段的垂直基线一致；页头量程线不被内容覆盖。
- **A4 网格**：桌面卡片网格在项目数不足时用 `auto-fit` 铺满可用列（或提供等宽占位卡），不得留下整列空白。
- **A5 详情页**：`/dcw/[id]`、`/daq/[id]`、`/workshop/w/[id]` 在 1440 宽度下关键表单、表格、工具栏均可见，不被固定浮层遮挡。
- **A6 长列表**：桌面 1440 下超过 50 行的表必须分页（或虚拟滚动），单页文档高度 < 6000px；移动端把表格折叠为事件卡/报告卡时允许更长（列表本身仍须有界，不得无限追加）。
- **A7 固定浮层**：平台自身的固定件（页头/页脚/抽屉/提示）不得遮挡内容；**插件 HUD**（`[id^="aw-plugin-"]`，如 line-sentinel 状态徽标）作为第三方悬浮表面豁免几何遮挡判定，但仍必须避让页脚与主操作区。

## 3. 视觉验收（B）

- **B1 对比度**：正文/标签在两种主题下均 ≥ 4.5:1；大字号与图形边界 ≥ 3:1；审计 `contrast` 问题 = 0。
- **B2 字号**：审计 `font-too-small` = 0（正文 ≥ 13px、标签 ≥ 11px）。
- **B3 裁切**：非预期的 `text-clipped` = 0；允许省略号截断的单元格必须带 `title` 且不丢关键信息。
- **B4 层级**：同一页面最多 2 种卡片底色；表头、卡片标题、区块标题的字体/字重/字号层级一致。
- **B5 状态色**：只表达真实语义；删除/停用等危险操作具备可读的红/中性态，不得 2.2:1 隐形。
- **B6 亮色模式**：画布/卡片/表头三层可辨（边界 ≥ 1px），不得出现灰斑、脏污或低对比文字。

## 4. 交互验收（C）

- **C1 状态**：按钮/链接具备 hover / focus-visible / active / disabled 四态；主操作与次操作在视觉上可区分。
- **C2 键盘**：Tab 顺序合理，焦点环 2px、offset 2px，不被 `overflow:hidden` 裁掉。
- **C3 触控**：移动端主操作/导航 ≥ 40×40；表内次级操作 ≥ 32×32；几何审计以 30×30 为硬下限（当前审计 0 违规）。
- **C4 表单**：错误提示可见且与字段绑定；禁用原因可解释（tooltip/说明），不出现"看起来可点但无响应"。
- **C5 实时性**：WS 实时更新不导致布局跳动；表格/图表更新后滚动位置保持。
- **C6 无回归**：HITL、审批、配方下发、开停线等既有交互链路行为不变。

## 5. 内容与状态（D）

- **D1 空态**：图标 + 一句标题 + 一句解释 + 主操作；同类空态全站同一组件语言。
- **D2 加载**：表格/卡片使用骨架或明确的加载指示，不以空白代替。
- **D3 错误**：请求失败显示可重试的错误条，包含原因摘要，不吞错。
- **D4 文案**：无未编译的 i18n 占位符（如 `{@}`）、无 `undefined`/`NaN`/`[object Object]`。
- **D5 数据格式**：时间、单位、百分比有统一格式；数值列使用 tabular-nums；路径/ID 超长时省略并可查看全文。

## 6. 工程验收（E）

- **E1** 控制台无 `error`；Hydration mismatch = 0（已知豁免：依赖 localStorage 会话态的 Workshop/设置页在首帧水合时仍可能报一次 generic mismatch，属既有行为，不影响可见 DOM；记录在验收报告）。
- **E2** `pnpm typecheck`、`pnpm lint`、`pnpm test:unit` 通过（至少保证本次改动相关套件）。
- **E3** 全站截图（19 静态页 + 3 详情页 × 亮/暗 × 1440/1920）齐备并归档。
- **E4** 布局审计脚本在 1440/390 双主题下无 A/B 类问题（白名单：装饰性微标签、需横向滚动的数据表、带 `title` 的摘要省略、插件 HUD）。
- **E5** 改动仅限前端（`app/`、前端样式、插件示例 UI），不触碰服务端业务逻辑与数据契约。

## 7. 已知豁免与边界

| 项 | 说明 | 依据 |
| --- | --- | --- |
| 插件 HUD 遮挡 | 插件坞固定在右下角、页脚之上；其状态徽标按设计悬浮于内容之上 | A7 插件 HUD 豁免；`audit-layout.mjs` 已按 `[id^="aw-plugin-"]` 排除 |
| 摘要省略 | 审计日志/操作流水的长摘要使用单行省略并带 `title` | B3 允许省略号截断 |
| 模板场景文案 | 模板卡片的场景提示按 3 行截断并带 `title` | B3 |
| 首帧水合告警 | `workshop / workshop/* / settings` 的会话态在客户端首帧与 SSR 不同，控制台可能保留一条 generic hydration mismatch | 既有行为；不影响可见 DOM，后续单独治理 |
| 开发覆盖层 | Nuxt DevTools 的性能胶囊只在 dev 出现，不属于产品 UI | 生产构建验收 |

## 7. 逐页检查清单

| 页面 | 必检点 |
| --- | --- |
| `/` 仪表盘 | KPI 分母对齐、图表卡等高、执行引擎分组、产线清单卡密度 |
| `/workshop` | 工作区网格占位、卡内状态可读、空态 CTA |
| `/workshop/agents` | 69 行分页、操作列对比度、开关语义 |
| `/workshop/teams` | 卡片铺满、成员行对齐、部署入口 |
| `/workshop/channel-templates` | 场景描述裁切、实例化按钮位置 |
| `/monitor` | 4 个 KPI 等宽、Channel 表列宽、空表状态 |
| `/daq` | 告警条、控制条换行、节点表、事件卡 |
| `/dcw` | 筛选条、卡片头状态对齐、禁用开跑 |
| `/aml` | 环境卡路径换行、空态、控制台表单 |
| `/town` | 浮层避让、图例可读、空场景提示 |
| `/logs` | 筛选卡密度、分页、时间列等宽 |
| `/permissions` | 空表格高度、搜索与表格关系 |
| `/plugins` | 分隔虚线、表格与搜索、连接状态 |
| `/settings` | 左侧导航、表单行距、保存反馈 |
| `/tokens` | 101 行分页、标签换行、危险操作对比度 |
| `/users` | 角色选择对比度、危险操作对比度 |
| `/dcw/[id]` | 控制条、11 列表格、批次表 |
| `/daq/[id]` | 实时卡空图、参数表单分组、时序卡标题 |
| `/workshop/w/[id]` | 三栏高度、右栏滚动、Composer 占位符 |

## 8. 通过标准

- A/B/C/D/E 五类中，A、B、D、E 必须 0 未豁免问题；C 类允许对既有业务限制做记录豁免。
- 每个页面的截图与审计报告可追溯到本规范条目。
- 最终以生产构建（`aw build` + `aw start`）截图复核，不以 dev 覆盖层为准。

## 9. 本轮验收结果（2026-10-19）

- **构建**：`pnpm build` 通过，生产实例在 `http://127.0.0.1:3001` 运行（v0.7.66）。
- **布局审计**：19 个静态路由 × 亮/暗 × 1440×900 / 390×844 = 76 组合；**70 组 0 问题**，6 组仅剩 `text-clipped`（DAQ 事件摘要、模板场景 3 行截断、操作流水摘要；均带 `title`，属 B3 豁免）。
- **A/B 类**：`contrast` / `font-too-small` / `overlap` / `touch-target-small` / 文档横向溢出均为 **0**（插件 HUD 按 A7 豁免）。
- **宽屏**：1920×1080 × 22 路由 × 双主题 = 44 张截图，`overflowX = 0`。
- **工程**：`pnpm typecheck` 通过；改动文件 ESLint 0 error。
- **控制台残余**：9 个依赖客户端会话态的路由各保留 1 条 generic hydration mismatch（见 §6 豁免，不影响可见 DOM）。
- **工件**：`.ui-review/final-1600/`、`.ui-review/final2-1600/`、`.ui-review/final-1920b/`、`.ui-review/audit-accept2/`（截图与审计 JSON，未入库）。
- **复跑方式**：
  ```bash
  AW_BASE=http://127.0.0.1:3001 node scripts/ui/audit-layout.mjs --vp 1440x900,390x844 --routes all --theme both --out .ui-review/audit
  AW_BASE=http://127.0.0.1:3001 AW_VP=1920x1080 node .ui-review/capture-admin.mjs .ui-review/shots both 4000 0
  ```

## 10. 前后端 / 产线 / Channel 验收标准

### 10.1 API 契约（F）

- **F1 健康与身份**：`GET /api/health` code=0；`GET /api/users/me` 返回当前用户与角色；未带 token 的受保护端点返回 401。
- **F2 领域读取**：channels / workspaces / teams / agent-templates / daq / dcw / hitl / plugins / logs / schedules / analysis 均返回 code=0，数组/对象形状稳定，分页参数不产生负数/越界崩溃（`scripts/api-contract-smoke.mjs` 16/16 覆盖 health/users/me/channels/workspaces/daq/dcw/hitl/plugins/ops-logs）。
- **F3 Channel CRUD 与成员**：创建、查询、更新、激活、删除频道；成员添加/移除；跨频道 agent token 读任务详情必须 403 `SCOPE_VIOLATION`；管理任务面被拒；agent token 实际使用的 `/api/workshop/tasks` 列表必须 200 且不含他频道任务（`api-contract-smoke` C1–C6 实测）。
- **F4 任务生命周期**：goal / loop / pipeline 三种模式经 SUBMITTED → ASSIGNED → WORKING → COMPLETED；进度与父子任务聚合可见。
- **F5 实时面**：WebSocket 收到 task.status / task.progress / agent.status；MCP `initialize` 与 `tools/list` 成功。
- **F6 错误面**：非法参数（负 limit、from>=to、非法枚举）返回明确 4xx 与可行动文案，不得 200 + 空数据。

### 10.2 产线集成（G）

- **G1 开线治理**：line_start 生成 HITL 审批卡；批准后参数逐项设备证实；line_status 显示运行中。
- **G2 停线与换线**：停线审批期间换线/换批次/改配方，旧审批单必须被复核拒绝，不得误停/误开。
- **G3 失败收窗**：全部参数不可下发时 `isError=true` 并自动停线收窗。
- **G4 权限与绑定**：未绑定节点查询被拒并列出可绑定面；频道绑线节点可只读导出；错误 agent token 401/403。
- **G5 写控安全**：DCW 写/回读一致；超单步限幅、60s 间隔、越量程均被拒并给出原因。
- **G6 数采真实样本**：开跑后 DAQ 能读到带批次标记的新鲜样本，时间戳前进。

### 10.3 Channel 交互与真实场景（H）

- **H1 真实 Harness**：频道内 worker 使用真实 omp（deepseek-flash），经频道绑定的 agent-tools 执行真实写控（不得用 mock 冒充）。**已知边界**：真实 omp 进程通过 Channel 任务引擎派发时，当前隔离实例只有 lead 被 wired、0 个 harness 进程，任务会以 `CHILD_RETRIES_EXHAUSTED` 取消；该路径单独记录为环境限制，不与 tool 链混为一谈。
- **H2 HITL 闭环**：recipe_trial / recipe_update 必须生成审批卡并经人工批准；写控回执逐参数证实。
- **H3 工艺响应**：每步试验后等待工艺惯性（≥65s）再经 DAQ 复测，不得跳过等待直接判读。
- **H4 质量入窗**：克重、飞边、缩痕（及可用的熔温）在规格窗口内；不达标必须回退基线。
- **H5 固化与追溯**：达标后 `recipe_update` 固化新版本；运行批次仍冻结旧参数，追溯链可查。
- **H6 可复跑**：`npm run test:e2e-line`、`npm run test:e2e-injection`、`node scripts/api-contract-smoke.mjs`、`node scripts/channel-interaction-smoke.mjs` 在文档命令下可复跑，失败不得静默跳过。

## 11. 2026-10-19 实测结果

| 套件 | 结果 | 证据 |
| --- | --- | --- |
| 生产 API live（3001） | **ALL PASS 60 passed**；2 SKIP 为“无持久化 channel-with-lead”的预置条件，不是失败（`api-live.log` 第 1 节） | `.ui-review/round2/api-live.log` |
| API 契约 + 跨频道 scope 冒烟（3001） | **ALL PASS 16/16**（health/users/me/channels/workspaces/daq/dcw/hitl/plugins/ops-logs + A token 读 B 任务详情 403 + 管理面拒绝 + `/tasks` 200 且不泄露 B 任务） | `.ui-review/round2/api-contract-smoke.log` |
| 产线治理 E2E（隔离实例） | **PASS 44/44** | `.ui-review/round2/e2e-line.log` |
| 真实注塑 Channel 闭环（3000 + PLC 模拟器 4010 + omp/deepseek-flash） | **PASS 6/6**（worker 直接 tool 链） | `.ui-review/round2/e2e-injection.log` |
| Channel 交互冒烟（3000 注塑频道） | **9/10**：频道详情/worker 身份(omp+deepseek-flash)/消息发送与历史/任务提交与追溯通过；真实 omp 任务引擎派发 H9 失败（CANCELED `CHILD_RETRIES_EXHAUSTED`，仅 lead wired/0 harness 进程） | `.ui-review/round2/channel-interaction.log` |
| 布局审计（1440/390 × 双主题） | 70/76 组 0 问题；6 组仅 B3 省略 | `.ui-review/round2/audit-final3.log` |
| UI 截图评审 | 符合要求（桌面 8.5/10，移动 7.5–8.5/10） | `docs/ui/ui-review-2026-10-19.md` + `.ui-review/round2/` |
| 构建/类型/静态 | build 成功；`pnpm typecheck` 通过；改动文件 ESLint 0 error | `.ui-review/round2/build.log`、`typecheck.log`、`eslint.log` |

独立 reviewer 第三轮按 F/G/H 标准复核：**APPROVED**（C1–C6/16/16 scope、UI、line 44/44、injection 6/6 均通过；真实 omp 任务引擎限制已披露）。

**已知环境限制（非前端回归）**：隔离注塑实例的真实 omp worker 通过 Channel 任务引擎派发时，任务在 0.4s 内以 `CHILD_RETRIES_EXHAUSTED` 取消；`/api/system/monitor` 显示该频道仅 lead 被 wired、0 个 harness 进程。直接 agent-tools 调用同一 worker 的真实写控/复测链 6/6 通过。根因在 harness 进程 wiring/模型 provider 侧，需在 UI 轮次之外单独治理；Channel 的 CRUD/消息/任务提交/历史追溯已通过 api-live 与 `api-contract-smoke` 验证。另：注入脚本 P6 标签仍写“v2”，实际输出与配方版本均为 v3（标签文字过时，不影响结果）；`channel-task-attempt.log` 是更早一次 18/19 尝试（M2 停在 SUBMITTED），随后用独立 mock 频道复现任务为 SUBMITTED，故只在 `channel-interaction.log` 记录真实 omp 任务引擎限制。api-live 旧跨频道断言（PASS 时 code=0/status=200）已被 `api-contract-smoke` C4–C6 取代，不再作为 scope 证据。

真实注塑闭环终态：保压 70 bar、保压时间 6 s；复测 `weight=32.55 g / flash=0% / sink=0.976%`，`recipe_update` 经 HITL 固化为 v3；运行批次仍按开跑时冻结参数生产，追溯日志可查。

## 12. 证据目录

- UI 截图与评审：`.ui-review/round2/showcase`（终版桌面）、`.ui-review/round2/showcase-mobile`（终版移动）、`.ui-review/round2/desktop`、`.ui-review/round2/wide`、`.ui-review/round2/mobile`、`.ui-review/round2/final*`
- 审计：`.ui-review/round2/audit-final3.log` / `audit-final3/audit.json`
- API / 产线 / Channel：`.ui-review/round2/api-live.log`、`api-contract-smoke.log`、`e2e-line.log`、`e2e-injection.log`、`channel-interaction.log`、`channel-task-attempt.log`
- 构建/静态：`.ui-review/round2/build.log`、`typecheck.log`、`eslint.log`
- 说明：`.ui-review/` 为本地验收工件，已在 `.gitignore` 忽略；`docs/ui/` 为可入库的验收文档。

### 复跑前置

- `test:e2e-injection`：需要一个已运行的隔离平台（示例 `http://127.0.0.1:3000`）、其 admin token（`AW_TOKEN`）、PLC 模拟器（示例 `SIM_BASE=http://127.0.0.1:4010`）、且频道内存在启用的「工艺优化」worker。缺任何一项都会在 P1 前失败。
- `api-contract-smoke`：`AW_BASE` + 一个用户 token（`AW_TOKEN`）；脚本会创建并清理两个临时频道。
- `channel-interaction-smoke`：`AW_BASE` + admin token + 目标 `CHANNEL_ID`；H9 的真实 omp 任务引擎路径受上节环境限制。

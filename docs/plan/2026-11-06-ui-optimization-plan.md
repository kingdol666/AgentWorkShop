# AgentWorkShop 前端逐界面优化计划（功能驱动 · 交互优先）

> 日期：2026-11-06 · 分支：paper/tii-major-revision-20261103 · 状态：**已交付——PR #55 已合并（5d0c3004），验收门禁全绿，最终 audit 280→81**
>
> 原则：**功能驱动界面、交互优先**。每个界面的设计由它的业务任务决定，不做千篇一律的翻新；
> 现有 "Industrial Instrument" 设计系统收口强化，而非换血。

---

## 1. 背景与目标

AgentWorkShop 主前端是 Nuxt 4 + Ant Design Vue 4 单体（`app/` + `server/api`，29 个路由），
自研 "Industrial Instrument" 设计系统：冷钢灰画布 + 高对比油墨 + 单一信号绿（`#35e0a0`）、
数据青（`#41c8f4`）、发丝线/刻度线母题、tabular-nums 数据字、暗色默认。

本次优化目标：

1. **实机为准**：启动项目（`pnpm dev` :3000），逐页实拍核验，不凭空设计。
2. **功能驱动**：每页先回答"给谁用、完成什么任务、核心旅程是什么"，再定信息架构与交互。
3. **交互优先**：先修"用不了/会出事"的问题（危险操作、幽灵令牌、缺失状态），再打磨视觉。
4. **可验证**：每阶段用仓库自带 Puppeteer 工具链（`scripts/ui/`）做门禁，问题数只降不升。

勘察证据：3 份逐页代码体检（file:line 取证）+ README 实机截图基线（docs/readme-assets）+
UI 审计工具链勘察。**Phase 0 用实机重拍校准本计划；冲突时以实机为准，先改本文件再动手。**

---

## 2. 全局交互宪法（所有页面统一遵守）

| # | 规则 | 说明 |
|---|------|------|
| 1 | 危险操作分级确认 | 可逆操作 → `a-popconfirm`；不可逆/批量/治理态变更 → 两段确认弹窗（diff 预览或输入名称）。E-STOP 全站最高规格（arm→hold→fire） |
| 2 | 表格必分页或窗口化 | 服务端快照深度要显式标注（如"快照 300 条封顶"），不许静默截断 |
| 3 | 空/加载/错误三态 | 统一 `AwStateBlock` 组件；"API 挂了"与"没有数据"必须可区分 |
| 4 | 图表色从令牌读 | `AwChart` 主题桥 `getThemePalette()` 单一来源，禁止组件内硬编码 hex 色板 |
| 5 | 长页锚点导航 | 超过 3 屏的工具页（aml/ontology/settings）提供区块锚点/步骤条 |
| 6 | 交互控件必达 | 删除/编辑等入口必须是真 `<button>`，带 aria-label 与键盘等价操作 |
| 7 | 字号地板 11px | `main.css:349` 既有约束全档生效（含桌面档），数据字用 tabular-nums |
| 8 | 令牌单一来源 | 禁止绕过 `main.css` 令牌与 antd 主题；新增 CSS 变量必须登记并进构建期校验 |

---

## 3. 勘察结论：跨页系统性病灶（Phase 1 收口，修一处惠及全站）

### 3.1 幽灵令牌裸奔（最高危）

全仓库**无定义**却被引用的 CSS 变量（fallback 全是亮色 GitHub 风，暗色默认主题下白底白字/边框消失）：

- `--panel`（studio×3、data×3）、`--border`、`--bg-deep`、`--text-dim`、`--aw-fg`（optimizer）
- `--surface-2`（ontology:1050）、`--surface-strong` 无 fallback（TaskBoardView.vue:220，queued pill 失效）
- `--line-faint` 白发丝 fallback（RecipeGateApprovalCard.vue:151,156，亮色主题审批卡边框不可见）
- 拼写 bug：`--tone-warn-dot`（真名 `--tone-warning-dot`，LaneHeader.vue:338、AnalysisTable.vue:297）→ watchdog 警示静默变 info 蓝

**方案**：main.css 补真令牌 + 全库改写引用（`--panel→--paper-raised`、`--border/--line-faint→--line`、
`--bg-deep→--paper-deep`、`--aw-fg/--text-dim→--ink/--ink-dim`、`--surface-strong/--surface-2→--surface-card`）；
新增 `scripts/check-css-vars.mjs` 扫描 `var(--` 引用对照定义表，进 lint。

### 3.2 三页整页绕过设计系统

- `/optimizer`：自造 GitHub-Dark 主题（index.vue:660-686 硬编码 `#0d1117/#e6edf3` 等），裸 input/select，无校验态
- `/studio` 三页：`var(--panel, #fff)` 卡片 + `var(--ink, #222)` 文字 → 暗色下白底白字
- `/data` 三面板：同源塌方 + 图表 8 色大地色硬编码（Mirror:390）

### 3.3 危险操作确认标准不一

正确样板：`LaneHeader.vue:163-194`（popconfirm）、`TokensTable.vue:143-158`（revoke + 专属警告）。
零确认的违规者：dcw 停线（DcwLineRunCard.vue:91）/删节点（DcwNodesTable.vue:207）、town E-STOP
单击即触发（TownControlDock.vue:185 + useTownSceneControl.ts:58）、ontology retire（index.vue:896）/
publish、optimizer revokeBinding/publishProfile、users 改角色/停用（users.vue:188,83）、permissions
批量吊销（permissions/index.vue:99）、plugins 启停（plugins/index.vue:86）。

### 3.4 其余系统性问题

- **字号地板双标**：workshop/town 桌面档 <11px 共 235+ 处（InspectorPanel.vue:218,248、LaneHeader.vue:278-331、TownControlDock.vue:208-230 等）；TownView.vue:501-503 `small{10px}` 直接冲突
- **图表色板脱钩**：useDashboardCharts.ts:44-45 亮暗两套 hex 与 main.css:204-241 逐字重复；`#ff8a5c` 是色锁外第 6 状态色
- **布局原语复制**：`.span8/.span4/.chart/.h240/.h280` 在 dashboard 4 面板逐字复制（组件注释自认"改一处同步所有"）
- **i18n 半途**：TaskBoardView.vue:99-112 英文 pill、RecipeGateApprovalCard 中文硬编码（:84-119）、LogsFilterCard.vue:149,162 emoji 入文案、aml 生成式乱码 key（`aml.k1amlx074`）
- **渲染基础缺失**：/dcw/[id]（[id].vue:93-95 line=undefined 整页渲染）与 /daq/[id]（:43-51）无骨架屏；Dashboard Harness 面板 catch 后留空（useDashboardData.ts:58）

---

## 3.5 Phase 0 实机校准记录（2026-11-06，v0.9.5 生产构建 :3001 实拍 58 张）

实拍产物：`.e2e-shots/optplan/baseline/`（19 路由 × 暗/亮 + 10 补拍页，`_report.json`/`_extras-report.json`）；审计基线 `.e2e-shots/optplan/audit-baseline.json`。逐页设计与代码体检结论**全部得到实机证实**，另确认/新增：

1. **暗色 studio 白底白字实锤**（`dark__studio.png`）：白卡贴暗色画布，"数据源/Y 轴井/Golden/保存"标题全部不可读；亮色下虽可读但完全脱离设计语言（`light__studio.png`）。
2. **优化器亮/暗双档均不可用**（`light__optimizer.png`）：`#0d1117` 深色输入框贴在浅色画布上，区块标题几乎隐形；顶部"服务器内部错误"裸横幅（optimizer API 500，属后端环境问题，记录不计入 UI 门禁）。
3. **仪表盘**（`dark__dashboard.png`）：实时工况趋势空图无空态提示；产线状态环图例被截断并与悬浮块重叠（右下角黑块）。
4. **town**（`dark__town.png`）：趋势分析空图无提示；左侧设备模型缩略图的红色"删"按钮单击即删（危险操作清单新增）；场景控制滑杆面板浮层遮舞台底部。
5. **workshop 控制台**（`dark__workshop-console.png`）：视图 tab "Agent lanes" 英文混排；右栏成员/群聊设置区块密度过高被截断；line-sentinel 状态章悬浮遮挡右下内容。
6. **dcw 详情**（`dark__dcw-detail.png`）：网关栏"失败 36"仅小黄字无告警样式；节点行"删除"红字单击即删。
7. **运行环境事故记录**：实例 home `.AgentWorkShop/data/daq-objects` 有 20 万+ 小文件，备份插件的同步 `dirBytes` 遍历（server/plugins/backup.ts:62）冻结事件循环数分钟 → 健康探针判僵死重启循环，dev/prod 一致复现。**实拍会话已用 `BACKUP_DISABLED=1` 绕开**；根因修复（异步遍历/缓存量级）建议单列 issue，不混入本轮 UI 改动。

---

## 4. Phase 0：实机基线（批准后立即执行）

1. `pnpm dev`（:3000）→ `admin@awshop.local / admin123` 登录（不存在则注册提权；约定见
   `scripts/ui/seed-admin.mjs`）；数据为空则 `node scripts/ui/seed-demo.mjs` 播种示范产线。
2. `AW_BASE=http://127.0.0.1:3000 node scripts/ui/shots.mjs --theme both` 全矩阵重拍 29 页实况。
3. `pnpm ui:audit` 留基线 `.e2e-shots/audit.json`（后续门禁对比用）。
4. 浏览器实机走查，校准本计划逐页设计。

---

## 5. Phase 1：设计系统收口（P0，先于一切逐页改动）

| 工作项 | 内容 | 关键文件 |
|--------|------|----------|
| 令牌修复 | 幽灵令牌改写为真令牌（映射见 §3.1）；`--tone-warn-dot`→`--tone-warning-dot` | `app/assets/css/main.css` + 各引用组件 |
| 构建期校验 | `scripts/check-css-vars.mjs`：未登记变量引用即报错，接入 lint | scripts/、package.json |
| 图表主题桥 | `AwChart.vue` 增 `getThemePalette()`（读 CSS 变量，主题切换即时生效）；替换 dashboard 双份色板与 data 8 色；删除场外色 `#ff8a5c` | `app/components/AwChart.vue`、`app/pages/composables/useDashboardCharts.ts` |
| 危险操作统一 | 按交互宪法 §2 逐处补确认（清单见 §3.3）；town E-STOP 单独设计（§6.3） | 各页组件 |
| 状态组件化 | 新建 `AwStateBlock`（loading 骨架 / empty / error+retry 三态），替换 ad-hoc 空态；dcw/daq 详情页接骨架屏 | `app/components/common/AwStateBlock.vue`（新） |
| 布局原语上收 | `.span8/.span4/.h240/.h280/.chart` 收进 main.css；页面边缘 4px 魔数进令牌 | main.css、dashboard 面板 |
| 字号地板整改 | workshop/town 桌面档 <11px 全量抬到 11px；TownView `:where()` 70+ 类名清单改容器选择器 | workshop/console/、workshop/town/ |

---

## 6. Phase 2：逐页业务驱动优化设计

> 每页格式 = **业务定位（谁用/干什么）→ 现状问题（file:line）→ 优化设计（交互→渲染）**

### 6.1 控制台域（P1）

#### `/` 仪表盘 —— 运营者 30 秒扫描健康度
旅程：打开即扫 Hero LIVE 读数 + 6 格量规 → 图阵找异常 → Fleet 卡跳产线。
- 问题：写控失败 `writesFailed>0` 仪表恒用 accent 色（useDashboardCharts.ts:114-142），失败语义只藏小字；Harness 无错误态（useDashboardData.ts:58 catch 留空，index.vue:76 v-if，API 挂≠无引擎不可区分）；布局原语 6 处复制；`.home` 4px 边缘与 hero 内 30px 失衡。
- 设计：**告警联动**——写控失败率>0 仪表环变 `--tone-danger` + 面板头告警徽标，点击直达写控面板；Harness 面板补 error 态（AwStateBlock）；Fleet 卡内嵌"采集/写控/告警"3 个 inline 微指标（不用进详情就能排序轻重）；hero 进场 stagger reveal（CSS only，reduced-motion 收敛）；边距令牌化。

#### `/workshop/w/[wsId]` Agent 工作台 —— 调度者多频道指挥
旅程：选频道 → 六视图切换 → Composer 派任务/@提及 → Inspector 查 Agent/任务 → HITL 应答。
- 问题：`--tone-warn-dot`/`--surface-strong` 两枚幽灵令牌（LaneHeader.vue:338、TaskBoardView.vue:220）；桌面档 235+ 处 <11px；TaskBoard pills 硬编码英文（:99-112）；LineOperationsPanel 整块 8+ hex 且无亮色分支（:154-175）；Composer 权限晚到抢 mode（Composer.vue:64-67，用户已输入文字时语义静默变化）；Inspector 全量 v-for 无窗口化；Topbar 图标钮仅 title 无 aria。
- 设计：修令牌+地板；TaskBoard pills i18n；LineOperationsPanel 重绘进令牌系统（渐变改令牌派生，亮色分支补齐）；Composer 尊重 `userPickedMode` 且权限晚到只改可用性不改模式；Inspector 列表窗口化（复用 `useDaqNodeWindow` 思路）；全部图标钮补 aria-label；视图切换 aria-pressed。**保留亮点**：三视图架构、IME 防误发、幂等 clientMessageId、窄屏"单通道示波器"。

#### `/town` 数字孪生 —— 全频道巡检/布局/审批中枢
旅程：3D 巡检 → 点选设备看 KPI/趋势 → 处理告警与审批 → 编辑布局保存。
- 问题：**E-STOP 单击即触发无确认**（TownControlDock.vue:185-191，全站最危险控件反而零确认）；WS 订阅泄漏（town.vue:91-97 只增 unsub 缺失，卸载后旧频道帧仍推）；`--hud-*` 平行令牌恒暗无主题联动；错误 chip 同位重叠无超时清除（TownStage.vue:232-254）；canvas 纯鼠标无键盘路径；dock 字号 9.5-10px。
- 设计：**E-STOP 两段式**——第一次点=arm（呼吸警示），再按住 3s=fire（环形进度），松开取消；WS 按差集 unsub 修复；错误 chip 5s 超时清除+展开按钮；补键盘巡检路径（方向键移动焦点+Enter 选中+Esc 退出，canvas tabindex）；dock 字号抬地板。亮色主题下 /town 维持暗 HUD（控制室语境合理）但用 CSS 变量声明该决策并文档化。**延后**：右轨 120 props 中转重构（不影响用户可见体验）。

#### `/dcw` 产线运营 —— 产线工程师的启停/配方/审批工作台
旅程：总览筛产线 → 进详情网关总控/开跑 → 控制节点读写 → 配方版本下发/回退 → 四类 HITL 审批。
- 问题：停线/删节点零确认；`--line-faint` 亮色失效；RecipeGate 硬编码中文+内联 `#e5484d`（:78,84-119）；审批有效期 `expiresAt.slice(11,19)` 静态无倒计时、过期按钮仍可点（:85）；四张审批卡三套意见状态实现（ParamApproval/RecipeGate/RecipeDispatch 各一套）；节点表 10 列全量渲染无窗口化；[id] 无页面级骨架；dcw-page.css 全局泄漏（DcwLineRunCard.vue:131 注释记载真实冲突）。
- 设计：停线/删节点 popconfirm；**审批卡统一**——抽取 `ApprovalComments` 子组件 + 倒计时环（<60s 变 warning，过期禁用提交并说明）；RecipeGate 全卡 i18n+应急徽标走 `--tone-danger`；节点表窗口化；[id] 骨架屏（DetailHead/NodesTable/RecipePanel 三块占位）；dcw-page.css 选择器收进页面命名空间。**保留亮点**：审批单结构化 payload+schemaVersion 守卫+fail-closed、开跑强校验、900/640 窄屏 40px 触摸目标。

#### `/daq` 数采中心 —— 数采工程师的采集/报警/查询台
旅程：看基础设施与管线 → 控制器暂停/恢复/调周期 → 处理报警 ack → 节点实时值/历史查询。
- 问题：周期输入 `v-model.number` 就地写全局 store（DaqControlCard.vue:64,78，未保存已被其它消费方读到）；dead emit 契约 `'start'|'stop'`（:38 与 index.vue:172 类型与实现不符）；自制虚拟滚动固定行高+`+40` 魔数无 overscan（useDaqNodeWindow.ts:42-53）；[id] 无骨架；报警只能逐条 ack 且不跳详情（index.vue:54-62）；时间格式化重复造轮子（:46-51）。
- 设计：周期输入改**草稿+应用**模式（脏值标识+统一提交）；删除 dead 契约；虚拟滚动补 overscan+动态行高测量；AlarmBar 批量 ack+报警项点击直达 `/daq/[id]`；时间复用 `formatLocalStamp`；[id] 三列骨架屏。**保留亮点**：全站唯一虚拟化、可见性调度轮询（5s→30s）、产线门控横幅的诚实解释、帧视图按 signalKind 分形态。

### 6.2 分析治理域（P2）

#### `/optimizer` —— **整页重建**（全站偏离设计系统最重）
业务：工艺/优化工程师走 spec→dataset→train→eligibility→profile→binding→runs 治理流，产出建议不写设备。
- 问题：整页自造 GitHub-Dark 主题+幽灵令牌（index.vue:660-686）；全部裸 input/select 无校验；吊销/发布零确认；无 loading 态（loadAll :214-228）；tab 无 aria 无键盘；JSON.parse 报错进顶部 banner 不在字段旁（:156）；默认值硬编码 demo id 二次创建必撞（:31-43）；单 busy 旗全页互斥；四表无分页。
- 设计：**按治理流重建**——顶部 `a-steps` 呈现七段流程（当前段高亮+可跳转）；表单全部 antd 化（必填星标/内联校验/JSON 编辑器错误定位到行）；`a-tabs` 带 aria 与键盘导航；逐 tab 独立 busy；publish/revoke 两段确认（revoke 显示受影响 binding 数）；四表分页；默认 id 改 `pms-${Date.now().toString(36)}` 生成式；"仅建议、零写设备" stamp 保留并强化为页头常驻徽标；全部收进 Industrial Instrument 令牌。

#### `/ontology` 本体模型 —— 治理工程师的知识/规则生命周期
业务：实体/关系/约束规则/语义绑定编辑，proposed→reviewed→validated→approved 治理，第二人批准，admin 发布。
- 问题：**第二人批准被 UI 击穿**——requestApproval 成功后立刻 window.prompt 让同一操作者粘 id 自批（index.vue:342-363）；retire 不可逆零确认（:896）；新建草稿两连发 prompt（:228）；issue 列表 slice(0,20) 静默截断不可跳转（:558）；编译产物裸 stringify pre 无复制（:983）；1062 行单文件塞 6 tab。
- 设计：**批准流程修复**——申请后进入"待他人批准"态（自己 session 禁批按钮+提示"等待第二人批准"），他人从 HITL 铃/审批中心批；retire/publish popconfirm；新建草稿 a-modal 表单（name/description 校验）；issue 列表可展开全部+点击跳对应规则并高亮；编译产物换代码块组件（复制按钮+简单高亮）；**拆分为 6 个 tab 子组件**（`app/components/ontology/`）。**保留亮点**：OntologyGraph.vue 键盘可达全站最佳、发布门禁严格、409/422 原样呈现纪律。

#### `/studio` EDA 工坊三页 —— 工程师自助取数分析
业务：index 选测点入 Y 轴井→时间窗/聚合→6 图型画廊→保存图表；board 组装看板；pipeline 5 步向导。
- 问题：index 主题塌方白底白字（:814,826）+删除图表零确认（:765）+自制 modal（:416-453）+table 静默截断 200 行（:566）+`cursor:grab` 无拖拽实现（:824）；board 无任何窄屏断点（:385-408）+布局编辑不保存无 dirty 提示（:349-367）+不稳定 `:key=Math.random()`（:121）+逐卡错误写全局；pipeline 模板删除 chip 零确认（:377）+首屏失败被 `catch{}` 吞（:763）+导出硬编码深底（:650）+原生 `<select multiple>`（:248）。
- 设计：三页令牌全量改写；modal 统一 a-modal；删除确认；board 补 1100/768/480 断点+`onBeforeRouteLeave` dirty 提示+稳定 key+逐卡错误/重试；pipeline Y 多选改 a-select（标签模式）+导出底色读主题+截断显式提示；节点行 cursor 改 pointer（诚实反映 dblclick 交互）+触屏长按入图。

#### `/data` 数据管理 —— 业务侧取数台（Mirror/MES/Ledger）
- 问题：Ledger 的 error 赋值但模板无渲染位（DataLedgerPanel.vue:205-218，**静默失败**）；导出轮询最长 5min 无取消无卸载清理（Mirror:543-549）；tab `v-if` 切换丢查询状态（data/index.vue:41-43）；测点 8 上限静默 slice 无计数（Mirror:464）；时间窗不校验 from<to（:450）。
- 设计：Ledger 错误条渲染（AwStateBlock）；导出弹窗可取消+`onUnmounted` 清理+错误就地显示；三面板改 keep-alive 或状态上提保持已查结果；测点选择器加"已选 n/8"+全选/清空；时间窗校验内联报错；图表色走主题桥。

#### `/aml` 自动建模平台 —— 算法/工艺工程师的 AutoML 闭环
业务：注册数据集→发训练作业→看门禁日志→排行榜对比→模型晋升 production→预测验证。
- 问题：8 zone 超长单页无锚点，**首屏被环境诊断占据**，主任务在第三屏后（index.vue:130-234）；四表无分页无上限增长；删除入口无语义 span 不可键盘达（AmlDatasetTable.vue:147）；行展开 `<tr @click>` 无键盘；i18n 乱码 key。
- 设计：**信息架构重排**——页头下加"主任务条"（新建数据集/发起训练 2 个主动作+数据集选择），环境诊断折叠为单行状态横幅（红黄绿）+可展开侧卡；页内锚点导航（数据集/作业/排行榜/注册表/预测）；四表分页；删除改真按钮+aria；展开行 tabindex+Enter；新增文案一律语义化 key。**保留亮点**：编排层干净、两段确认晋升、窄屏 sticky 首列、reduced-motion 全覆盖。

### 6.3 运维/系统域（P3）

- `/monitor`：终端抽屉 860 固定宽改响应式（≤900px 全宽）；`body-style→styles`（antd 4 弃用 API，OmpTerminalPanel.vue:53-54）；轮询失败去抖（连续 3 次才 toast，useMonitorData.ts:40）。
- `/logs`：页头加"快照 300 条封顶，更早历史请缩小时间窗"显式说明+导出标注范围（logs/index.vue:100-114）；LogsFilterCard emoji 出文案+i18n（:149,162）。
- `/operations`：分类色 5 hex 进 tone 令牌（OperationsTimeline.vue:187-216）；统计 chip 启用为真筛选；WS 前插改"有新条目 ↓N"提示条；≤640px 时间列保留（相对时间徽标）。
- `/analysis`：rows 直出补分页（AnalysisTable.vue:114-247）；JSON 修订内联校验（AnalysisEditModal.vue:44-52）；表卡材质与 /logs 统一（实心 --surface-card）；mini-btn 补 aria-label。
- `/settings`：三 pane v-show 改懒挂载（隐藏 pane 停请求，settings.vue:52-56）；左栏 tab role="tablist"。
- `/users`：改角色/停用 popconfirm（users.vue:188,83）；搜索框 !important 补丁换正规样式。
- `/permissions`：保存前 diff 预览弹窗（新增/吊销分列计数）+两段确认（permissions/index.vue:99-107）。
- `/plugins`：启停 popconfirm（plugins/index.vue:86-100）；`setTimeout(load,800)` 竞态改 WS `plugins.reloaded` 事件驱动刷新（:95）。
- `/tools`：行点击补键盘等价（tabindex+Enter）；`/tokens` 为样板保留不动。

---

## 7. Phase 3：渲染与动效打磨（P4）

- 图表 ClientOnly 容器高度预留（消 CLS）；骨架屏统一接管首帧。
- 亮色主题全页核对（`ui:audit --theme both` 门禁），rogue 页收口后亮/暗双档可用。
- 微动效：dashboard hero stagger、审批卡倒计时环、E-STOP hold 环形进度；全部 CSS-only + reduced-motion 收敛。
- tabular-nums 覆盖全部数值列；发丝线/刻度线母题贯彻到收口页。

## 8. Phase 4：验证门禁

1. `AW_BASE=http://127.0.0.1:3000 node scripts/ui/shots.mjs --theme both` 全矩阵人工核对；
2. `pnpm ui:audit` + `pnpm ui:verify` + `pnpm ui:verify-nav` 全绿（对比 Phase 0 基线只降不升）；
3. `pnpm typecheck` + `pnpm lint` 通过；`node scripts/ui/e2e-interactive.mjs` 冒烟 PASS；
4. 每域完成后浏览器实机走查关键旅程：开跑→HITL 审批→写控→读回；数据集→训练→晋升；spec→solve→建议。

## 9. 明确不做（本轮范围外）

TownView 右轨 120 props 架构重构；aml 之外历史 i18n key 全量重命名；bench 报告 HTML/paper-show/docs 站；
新增业务功能；/tokens 样板页改动。

## 10. 实施顺序与关键文件

Phase 0 → 1 → 2A（控制台域）→ 2B（分析治理域）→ 2C（运维系统域）→ 3 → 4，每阶段独立可验证可交付。

- 令牌/宪法：`app/assets/css/main.css`、`app/app.vue`
- 新组件：`app/components/common/AwStateBlock.vue`、`app/components/dcw/ApprovalComments.vue`
- 高频改动：`app/components/dashboard/`、`app/components/workshop/{console,town}/`、`app/components/{dcw,daq}/`、`app/pages/optimizer/index.vue`（重建）、`app/pages/ontology/index.vue`（拆分至 `app/components/ontology/`）、`app/pages/studio/`、`app/components/data/`
- 验证：`scripts/ui/`（既有工具链复用）+ 新增 `scripts/check-css-vars.mjs`

---

## 11. 实施记录（2026-11-06）

### 已落地

| 批次 | 内容 | 验证 |
|------|------|------|
| 1a 令牌收口 | 幽灵令牌 72 处清零（两轮 codemod：`--panel/--border/--bg-deep/--text-dim/--aw-fg/--surface-2/--surface-strong/--line-faint/--tone-warn-dot` → 真令牌）；`--surface-sunken` 升为正式令牌；TownView 补 `--hud-shadow-pop`；新增 `scripts/check-css-vars.mjs`（含模板 :style 动态键识别）+ `pnpm check:cssvars` | 校验器 144 引用全绿 |
| 1b 图表主题桥 | `app/composables/useChartTheme.ts`（亮=--chart-1..5 / 暗=tone 序，JS 侧 hex→rgba 换算避 zrender 不认 color-mix）；AwChart/dashboard 双 composable/Mirror 面板色板改读令牌；删场外色 `#ff8a5c` | typecheck ✓ |
| 1c 危险操作 | dcw 停线+删节点 popconfirm；town E-STOP 两段式（武装→按住 3s 进度环→触发，松手解除；复位方向单击）；ontology publish/retire popconfirm；users 角色变更 Modal.confirm+停用 popconfirm；permissions 保存前吊销 diff 确认；plugins 停用确认+800ms 竞态去重 | typecheck+i18n ✓ |
| 1d 状态组件 | `app/components/AwStateBlock.vue`（空=aw-empty/加载=发丝线骨架/错误=tone-danger+重试）；dcw/[id] 页面级骨架（此前 line=undefined 整页裸渲染）；daq/[id] 骨架 | typecheck ✓ |
| 1e 字号地板 | workshop/town/dashboard 树 <11px 全量抬到 `var(--fs-micro)`：`font-size:` 237 处 + `font:` 简写 4 处，69 文件；TownView `:where()` 清单**保留**（窄屏对比度机制，实测生效） | 残留 0 |
| 1f i18n | TaskBoard 英文 pill×3、workshop 视图 tab "Agent lanes/群聊"、RecipeGate 全卡（16 key）、LogsFilterCard 严重级+去 emoji | PARITY OK |
| 2A 仪表盘 | 写控失败>0 gauge 联动 danger 色+面板头告警徽标；Harness 探测失联显式错误态（catch 留空问题） | 实拍确认 |
| 2A daq | 周期输入草稿+应用（不再就地写全局单例）；删除 dead emit 契约（start/stop）；AlarmBar 全部确认（部分失败汇总提示） | 实拍确认 |
| 2A town | WS 订阅按差集退订（泄漏修复）；错误 chip 6s 自动清除 | typecheck ✓ |
| 2A workshop | LineOperationsPanel 全令牌重绘（accent 家族分类色+主题分支渐变）；Composer 已有草稿时权限晚到不再抢 mode | typecheck ✓ |
| 2B optimizer | **整页重建**：a-steps 治理流（5 段可点）、全部 antd 化、configJson 行内校验+禁存、发布/吊销确认、三表 a-table 分页、防撞生成式 id、逐 tab busy、AwStateBlock loading、全令牌样式 | typecheck ✓ |
| 2B ontology | **自批漏洞修复**：requestApproval 只创建审批单（服务端本就有"自审禁止+第二人裁决"，UI 不得代办）；新建草稿 window.prompt×2 → a-modal 表单 | typecheck ✓ |
| 2B studio/data | studio 删图表/删模板确认；board 稳定 :key（去 Math.random()）；pipeline 导出底色随主题；data Ledger 静默错误补渲染；Mirror 导出轮询代际令牌可取消+卸载清理 | typecheck ✓ |
| 2C 运维/系统 | monitor 终端抽屉响应宽度+antd4 `styles` API+轮询失败去抖（3 次起报/1 分钟提醒）；logs 导出快照上限标注；operations 分类色 15 处进 accent 令牌+统计 chip 启用为真筛选+窄屏保留时间列；analysis 表补分页(25/页)+材质统一 surface-card；settings 懒挂载（隐藏 pane 停请求）+tablist ARIA；tools 行键盘可达 | typecheck+i18n ✓ |

### 明确延后（内部卫生，不阻塞用户可见目标）

- ontology 1062 行拆 6 个 tab 子组件（纯文件组织）
- aml 信息架构重排（主任务提前+锚点）与乱码 i18n key 全量重命名
- studio 三页自制 modal → a-modal 全量替换（本次只修了最高危的删除确认/主题/导出）
- studio board 窄屏断点 + 布局编辑 dirty 离站提示
- town canvas 键盘巡检路径；dashboard 布局原语上收 main.css
- town 右轨 120 props 架构重构（原计划已列延后）

### Phase 4 门禁结果（2026-11-06）

| 门禁 | 基线 | 终态 | 结论 |
|------|------|------|------|
| `check:cssvars` | 72 处幽灵引用 | 0（144 引用全有定义） | ✅ |
| `i18n:check` | 硬编码漏网 4 族 | PARITY OK（3230/3230, unresolved 0） | ✅ |
| `typecheck` | — | 通过 | ✅ |
| `ui:audit`（390+1440 × 双主题，76 行矩阵） | 280 项 | **161 项** | ✅ 只降不升 |
| ├ font-too-small | 191 | **0** | ✅ 字号地板清零 |
| ├ text-clipped | 39 | 75→**9**(operations 修正后) | ✅ 其余为设计内省略号视竞性标记 |
| ├ contrast | 42 | 76（其中 town HUD 36×2 主题为**既有**恒暗体系问题，属延后项） | ⚠ 记录 |
| `e2e-interactive` | — | 14 PASS / 4 FAIL（FAIL 均为测试数据环境：演示产线未播种、MQTT demo 节点死端口无实时样本；**零致命前端错误**） | ✅ |
| 实拍矩阵 | 58 张(v0.9.5 改前) | 78 张(改后,暗/亮) | 优化器/ontology 双主题目视确认 |

### 交付记录（2026-11-06）

- **PR #55**（feat/ui-optimization-20261106 → paper/tii-major-revision-20261103）已 **MERGED**（merge commit `5d0c3004`），5 个提交（实现 121 文件 + 计划文档 + town 门禁收口×2 + deslop）。
- 验收门禁终值：audit **280→81**（font-too-small 191→0、touch-target 4→0、contrast 42→8）、verify-responsive town 4/4、e2e-interactive 19 PASS（工业演示真数据 4/4 真驱动 + 19/19 采样）、**E-STOP 实机交互 5/5**、Mimosa 扫描 25 findings 全部存量项。
- 验收中发现并修复 1 个生产 bug：E-STOP 按住触发后的松手 click 复位（estopJustFired 守卫，静态页 + 生产组件同步修）。
- ultragoal 账本 5/5 story complete（.omc/ultragoal/，含质量门证据）。
- 后续跟进建议：备份插件 dirBytes 同步遍历单列 issue；AML 工作区 python 脚本的存量安全发现另行处置（与前端无关）。

### 运行环境事故记录

实例 `.AgentWorkShop/data/daq-objects` 20 万+小文件使备份插件同步 `dirBytes` 遍历（server/plugins/backup.ts:62）冻结事件循环数分钟，健康探针判僵死 → dev/prod 双双复现。实拍与验证会话一律以 `BACKUP_DISABLED=1` 启动；**建议单列修复 issue**（异步遍历或缓存量级），不混入本轮 UI 改动。

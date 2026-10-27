# 频道执行三模式统一(observe / manual / auto)开发计划

- 日期:2026-10-28
- 状态:**pending approval**(待用户批准后实施)
- 调查范围:权限面 / 工具注入面 / 分发守卫 / 台账 / UI 五处代码级核查

---

## 一、现状结论(先回答"是否已经有这个功能")

**三模式的底层能力已全部存在,且都已生产化;缺的不是机制,而是一个统一的模式选择器与三处配置联动。**

### 1.1 手动/自动模式 —— 已存在(双层)

| 层级 | 字段 | 语义 | 代码锚点 |
|---|---|---|---|
| 绑定级(agent×节点/配方) | `mode: 'auto' \| 'manual'` | manual=每次写动作挂 HITL(reason 必填,审批卡展示给人类);auto=免批直执行,仍受四层限界+运行门+60s 联锁 | `server/services/workshop/agents/node-bindings.repo.ts:91-135` |
| 产线级总闸 | `line.controlMode: 'auto' \| 'manual'` | **线 manual 时,绑定 auto 也强制人工审批**(fail-safe:max 取 manual) | `server/services/workshop/dcw/dcw-line.repo.ts:40-42`、`agents/industrial/recipe-gate.ts:83-89` |

- 切换守卫:manual→auto 必须显式 `confirm:true`,否则 400 `MODE_CONFIRM_REQUIRED`;且 REST 层有 `requireBindingAccess` 鉴权(防任意用户摘掉别人的 HITL)+ `recordOps` 审计。
  - 绑定:`PATCH /api/workshop/agent-tools/bindings/:id`(`server/api/workshop/agent-tools/bindings/[id].patch.ts`)
  - 产线:`PATCH /api/workshop/dcw/lines/:id`;UI 两段式二次确认(`app/components/dcw/DcwEditLineModal.vue:39-50`)
- 首绑默认 manual(fail-safe),存量数据无字段按 manual 生效(`dcw-line.repo.ts:29,47-49`)。
- Agent 提示词注入模式说明:manual="每次下发挂起等批准,reason 必填给判断依据";auto="免批但受四层限界与运行门"(`agents/industrial-context.ts:170`)。

### 1.2 观察模式 —— 已存在(Channel 档位 exp-miner / line-doctor)

- `aml_channel_profiles.profile ∈ {legacy, hybrid_twin, aml_training, aml_optimization, exp-miner, line-doctor}`(`aml/twin/channel-profile.ts:11,49`)。
- 观察面 = **白名单注入 + 分发层 fail-closed 双保险**:
  - 注入:仅 `OBSERVER_READ_TOOL_NAMES`(ops_log/line_log/recipe_log/recipe_catalog/recipe_versions/line_context/dcw_journal/daq_query/exp_collect/analysis_save/analysis_query)+ 协作面;line-doctor 追加 AML 只读查询族 + `recipe_propose`(整包方案提交,**不是直写**,批准由人类裁决)(`agents/host-tool-bridge/catalog.ts:67-125`)。
  - 分发:即使按名直调(REST/MCP),写族工具在统一分发咽喉按档位拒绝——"物理零写"(`agents/host-tool-bridge/dispatch.ts:235-252`)。
- 写族清单单一声明源:`agents/tool-classes.ts` 的 `HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES`(8 个)与 `MES_READ_TOOL_NAMES`。

### 1.3 操作留痕 + Agent 自查 —— 已存在

- 写路径强制留痕:`reason 必填` 覆盖 dcw_judge / line_start / line_stop / recipe 另存 / 参数保存 / 回退 / 模型采纳(`dcw-judge-tools.ts:50`、`line-tools.ts:47,210`、`ops-tools.ts:527,746,866`、`optimizer-tools.ts:225`);直写治理路径 `hypothesis`(本次假设)入册(`dcw-tools.ts` meta);审批单载荷含 reason/params/批次(`recipe-gate.ts:128-144`),批准附言回流给 Agent(`agents/industrial/manual-approval.ts:55-56`)。
- 台账:ops_log(产线域)/audit_log + `recordOps` 中央埋点 + dcw journal(参数变更史)+ recipe 版本史。
- **Agent 自查工具**:ops_log / line_log / recipe_log / recipe_catalog / recipe_versions / line_context / dcw_journal / aml_activity / analysis_query —— Agent 能查操作记录与 recipe 历史,范围按 `agentOpsScope`(绑定节点 ∪ 配方线 ∪ 频道绑线,频道绑线只读扩权)(`agents/industrial/ops-tools.ts:42-80`)。
- 自动回退保障:越配方监控窗触发系统自动回退;无绑定的节点回退策略为 `observe_only`(`dcw/recipe-rollback-manager/internal.ts:12-19`)。

### 1.4 已核实的缺口(本计划要补的)

| # | 缺口 | 说明 |
|---|---|---|
| G1 | **无统一三模式选择器** | 观察=频道档位,手动/自动=绑定级+产线级,三处配置入口分散;组合语义要读代码才能理解,没有"一个开关"体验 |
| G2 | **auto 路径理由不强制** | manual 路径 reason 必填;auto 直批路径 `hypothesis` 可空入册(`dcw-tools.ts` meta `hypothesis: args.hypothesis ? ... : ''`)——用户要求"自动模式也要有为什么"未满足 |
| G3 | **观察面缺 MES 只读族** | `MES_READ_TOOL_NAMES`(mes_catalog/mes_fetch/mes_export/mes_dataset_read/mes_datasets)不在观察白名单——观察档位不能拉 MES 数据,只读分析能力不完整 |
| G4 | **审批卡不展示直写假设** | 配方路径审批卡带 reason(`recipeApprovalPayload`);但 `optimization_explore`→dcw 治理写的审批 detail 只有 节点/值/量程/经配方,不含 `hypothesis`(`dcw-tools.ts` requestManualApproval detail)——人批的时候看不到"为什么" |
| G5 | **模式维度不联动** | 频道 controlPolicy(`recommendation_only/hitl_governed/bounded_auto`)只门控 hybrid_twin 直写(`catalog.ts:248`),与绑定面/产线总闸互不感知;prompt 只注入绑定模式,不注入频道/产线模式全景 |

---

## 二、目标与非目标

**目标**:为"执行产线相关任务"的 Channel 提供唯一权威的三模式选择 `executionMode`,向下派生注入面与执行门,语义 fail-safe:

- **observe(观察)**:安全只读分析。注入面=派生读面(数采/MES/台账/分析/协作),分发层按名拒写;Agent 提示词明确"本频道观察模式,不可下发控制"。
- **manual(手动)**:每次下发挂 HITL,理由必填且审批卡人类可读(含假设/依据)。
- **auto(自动)**:自动审批,但**理由(rationale)必填入册**,四层限界 ∩ 单步上限 ∩ 运行门 ∩ 60s 联锁 ∩ 越窗自动回退全数保留。

**非目标**:
- 不改变既有 8 工具治理链与优化器 dispatch 的 HITL-first 设计(优化器 dispatch 本轮不加 auto);
- 不做绑定级粒度的新授权模型(复用现有绑定/产线/频道三层,max 收敛);
- 不迁移存量数据(缺省恒 manual,行为零变化)。

---

## 三、方案设计

### 3.1 M1 数据模型与有效模式解析(纯函数,先立语义)

- `aml_channel_profiles` 加列 `execution_mode TEXT`(NULL=legacy 行为,视为 'manual' fail-safe;observe/manual/auto 三值)。复用该表现有的单行 upsert 与热读路径(`getChannelTwinProfile` 每次装配实时读,切换即热生效)。
- 新纯函数模块 `server/services/workshop/agents/execution-mode.ts`:
  - `type ExecutionMode = 'observe' | 'manual' | 'auto'`
  - `effectiveHitlRequired(channelMode, lineMode, bindingMode): boolean` = `channelMode !== 'auto' || lineMode === 'manual' || bindingMode === 'manual'`(max 取 manual;频道 observe 时直接短路拒写)
  - 观察读面派生 `observerReadSurface()`:以 `tool-classes` 的声明集合派生(读面 = 全集 − 写族 − 训练/优化治理族),不再手工维护白名单;`OBSERVER_READ_TOOL_NAMES` 成为派生结果的超集断言(防回归)。
- 切换守卫:复用 `resolveModeChange`(`agents/binding-mode.ts`)——manual→auto 与 observe→manual/auto 都要求 `confirm:true`;REST `PATCH /api/workshop/channels/:id/execution-mode`(或挂进既有 twin-profile.patch),`recordOps` 审计入档。

### 3.2 M2 注入面与分发守卫联动

- 注入:`scopeHostToolsForRole` 读 `executionMode`:
  - observe → 用 M1 派生读面过滤(替换/包裹现有 exp-miner/line-doctor 分支,两个角色档位保留其 persona 附加面);
  - manual/auto → 面不变(写面照常注入,由执行门裁决),`excluded` 透明化原因照旧。
- 分发:`dispatch.ts:235` 写族守卫增加 observe 分支(复用现有 exp-miner/line-doctor 文案模板,推广为通用观察拒绝 + 行动指引"切到 manual/auto 或让用户操作")。
- 执行门叠加(两处既有判定点各加一个来源):
  - `recipe-gate.ts:89` `hitlRequired = bindingManual || lineManual || channelManual`;
  - `dcw-tools.ts:173`(optimization_explore 委托路径)同式;
  - 优化器 dispatch 不动(HITL-first 维持)。
- Prompt 注入模式卡:`industrial-context.ts` 增行——"当前频道执行模式:observe(只读)/manual(逐动作批准)/auto(自动+限界)",并把 observe 模式下写工具的排除原因透出(已有 `excluded` 机制)。

### 3.3 M3 auto 理由强制 + 审批卡补全(G2/G4)

- auto 直批路径:`hypothesis` 必填——`optimization_explore` 治理写与配方面 auto 执行路径,缺 rationale 直接拒绝并提示"自动模式下发必须附带依据(数采证据/判定结论)";入册字段统一 `rationale`(journal/ops_log meta 增列)。
- 审批卡:`requestManualApproval` 的 detail 拼入 `hypothesis`(截断 200 字),人工在批准时看得见"为什么";recipe 路径 `recipeApprovalPayload` 已带 reason,不动。
- 台账:journal 锚点与 ops_log 记录补 `mode` 字段(该次写入生效的 effectiveMode),事后可审计"这条 auto 写入当时是否真的在 auto"。

### 3.4 M4 UI(频道设置三选一 + 生效状态)

- 频道设置(既有 twin-profile 面板)加"执行模式"单选:观察/手动/自动,各带一句人话说明与后果(manual→auto、observe→其他 按钮触发两段式确认,与 `DcwEditLineModal.vue` 同交互语言)。
- 面板展示**生效判定全景**:频道模式 × 产线总闸 × 绑定分布(N 条 manual / M 条 auto)→ 实际生效模式;auto 但被产线总闸压成 manual 时显式标注"被产线手动模式压制"。
- 产线卡(`DcwLineCard.vue`)与频道页互相引流提示(线 manual 提示"将压制频道 auto")。

### 3.5 M5 验收(复用既有脚手架)

- 单测:`execution-mode.ts` 纯函数全覆盖(3×2×2 组合 + observe 短路 + confirm 缺失 400);读面派生 = 旧白名单超集断言;`catalog/dispatch/recipe-gate/dcw-tools` 四处联动各有正反例。
- e2e(新增 `e2e-execution-modes.mjs`,复用隔离实例纪律):3 模式 × {注入面快照, 写工具直调被拒(manual 为挂起非拒绝,observe/auto 分明), auto 缺 rationale 拒绝, HITL 挂起→批准→回执附言, journal/ops_log 的 mode/rationale 字段} 矩阵;含 UI 截图(三选一面板+确认条+生效状态)。
- 回归:line-governance 44 / perms / tool-face-batch-identity 22 必须全绿(证明存量行为零变化)。

---

## 四、里程碑与顺序

| 阶段 | 内容 | 交付判据 |
|---|---|---|
| M1 | 模型+纯函数+切换 REST+单测 | 语义表全绿;存量库升级后行为零变化 |
| M2 | 注入/分发/执行门联动 + prompt 模式卡 | observe 频道写工具"看不见也打不着";manual 频道全挂起 |
| M3 | rationale 强制 + 审批卡补全 + 台账 mode 列 | auto 无理由必拒;审批卡可见假设 |
| M4 | UI 三选一 + 生效状态 | 截图证据;二次确认与后端 confirm 同语义 |
| M5 | e2e 矩阵 + 三套件回归 | 全绿 + 证据目录归档 |

## 五、风险与对策

- **R1 语义叠床架屋**:executionMode 与 controlPolicy/profile 并存易混乱 → 文档明确:controlPolicy 仅 hybrid 直写遗留,新面一律 executionMode;后续轮次收编。
- **R2 观察面派生读面误放写工具** → 派生集合必须 ⊆ 手工白名单 ∪ MES 只读族(超集断言),且分发层按名拒写兜底(注入面不是安全边界,咽喉守卫才是)。
- **R3 auto 误开** → 三层 max(manual) 收敛 + confirm 链 + recordOps 审计 + 面板"被压制"显式标注;缺省恒 manual。
- **R4 MES 工具进观察面的越权** → mes_* 自带绑线授权/窗口≤7天/行数≤5000/频控护栏(`tool-classes.ts` 注释),观察面只读放大不加权,护栏沿用。

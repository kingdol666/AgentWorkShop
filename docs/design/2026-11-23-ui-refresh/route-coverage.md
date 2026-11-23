# UI refresh route coverage

基线：AgentWorkShop v0.17.5 本地 `feat/auto-default-workspace`，页面树共 31 个 `.vue` 路由文件。
本清单是设计与验收索引，不替代真实运行结果；每个路线需在隔离 `AW_HOME` 中实拍。

## Plant operations / control (10)

| Route | Layout | Primary question | Visual gate |
| --- | --- | --- | --- |
| `/` | default | 产线、告警、采集和写入现在怎样？ | dashboard data/empty/error, chart legend, alarm actions |
| `/daq` | default | 哪些节点在线、数据是否新鲜？ | filter/table overflow, status band |
| `/daq/:id` | default | 一个节点的趋势、配置和采样怎样？ | detail columns, long labels, action visibility |
| `/dcw` | default | 当前设备/产线作业到哪一步？ | operation cards, governance affordance |
| `/dcw/:id` | default | 这次作业能否安全推进？ | write/readback controls, loading/error |
| `/data` | default | 可用数据集和样本是什么？ | tables, empty state, download affordance |
| `/monitor` | default | 实时事件与 HITL 是否需要处理？ | terminal height, sticky controls, alert contrast |
| `/logs` | default | 审计链是否完整？ | pagination/filter, mono identifiers |
| `/operations` | default | 生产操作与批次状态是什么？ | action hierarchy, confirmation surfaces |
| `/town` | town | 数字孪生是否在线、下一步是什么？ | full viewport, canvas fallback, return control |

## Agent / workspace / project execution (8)

| Route | Layout | Primary question | Visual gate |
| --- | --- | --- | --- |
| `/workshop` | default | 我有哪些工作区与频道？ | workspace empty/loading/error, create CTA |
| `/workshop/w/:wsId` | console | 当前频道、Session 和任务怎样推进？ | chat readability, panes/drawers, composer |
| `/workshop/agents` | default | Agent 能力和健康状态是什么？ | cards/table, long harness names |
| `/workshop/teams` | default | 团队/频道关系怎样？ | filters, binding actions |
| `/workshop/channel-templates` | default | 可复用模板能否安全启用？ | template cards, modal focus |
| `/workshop/schedules` | default | 哪些作业会在何时运行？ | schedule table, timezone copy |
| `/projects` | default | 每个项目走到哪一步？ | stats/filter/list/create, empty state |
| `/projects/:id` | console | 计划、交付、审批和证据是否闭环？ | tab/deep link, workbench panes, long evidence |

## Analytics / learning (7)

| Route | Layout | Primary question | Visual gate |
| --- | --- | --- | --- |
| `/aml` | default | 数据集、训练和模型门禁处于什么阶段？ | step hierarchy, result/error states |
| `/analysis` | default | 数据与指标说明了什么？ | chart/table readability |
| `/optimizer` | default | 当前治理优化作业能否安全执行？ | client-only hydration, tabs, form/action states |
| `/ontology` | default | 工业实体与关系如何解释？ | graph fallback, panel density |
| `/studio` | default | 如何组合/观察建模工作？ | toolbar, empty/error |
| `/studio/board` | default | 看板上的作业如何推进？ | board columns, drag alternatives |
| `/studio/pipeline` | default | 管道各步骤是否可追踪？ | step state, horizontal overflow |

## System / administration (6)

| Route | Layout | Primary question | Visual gate |
| --- | --- | --- | --- |
| `/permissions` | default | 谁能进行哪些产线操作？ | destructive action separation, table |
| `/plugins` | default | 插件能力和状态是什么？ | install/enable states, failure copy |
| `/settings` | default | 当前实例如何配置？ | tabs/switch keyboard, save/error |
| `/tokens` | default | 哪些 API token 存在、如何撤销？ | secret masking, confirmation |
| `/tools` | default | 可用工具和权限边界是什么？ | grouped inventory, long descriptions |
| `/users` | default | 用户与角色如何管理？ | form labels, table/action hierarchy |

## Shared acceptance dimensions

- 亮/暗主题：SSR 首帧与 hydrated DOM 的 `aw-theme` / `html.dark` 一致。
- 视口：320×720、390×844、844×390、768×1024、1280×800、1440×900、1920×1080。
- 结构：文档无横向溢出；长文本可截断或在自身容器滚动；固定件不遮挡主操作。
- 交互：导航、键盘焦点、抽屉 Escape/归还焦点、表单错误、危险操作确认、加载/空态/错误态。
- 动效：只动 `transform`/`opacity`；进入使用强 `ease-out`；所有运动提供 reduced-motion；不把真实进度改成时间动画。
- Electron：启动页/标题栏/主页面分别留证；Electron 当前最小窗口 800×600，因此移动断点只在 Web 浏览器验收。

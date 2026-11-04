# AgentWorkShop 实机演示验收规范（2026-11-05，Route 闭环合并后）

> 目的：在真实实例上验收三件事 —— ①系统与产线集成功能无问题；②新增 Project 业务逻辑
> （PR20 Route 派发闭环）运行正常且有好结果；③前端渲染好看、交互完整、体验最佳。
> 分轨执行：**产线相关业务**与**不需要产线的纯开发任务**分开跑。
> 上游：`2026-11-05-project-route-dispatch-plan.md`（R1–R12 已合并 main 744116ca）。

## Track A — 产线集成业务（有产线）

真实 DCW 产线对象（线/模板/节点/产品/配方）→ 绑线 Channel → Project → 派发 → 执行 →
成果 → 审批 → 完成，全链真实 HTTP + 真实服务端。

| # | 验收项 | 工具 | 通过标准 |
|---|---|---|---|
| A1 | 产线业务面（线/模板/节点/产品/配方创建与可见） | e2e-project-line-acceptance P2/P2b | 全 PASS |
| A2 | 绑线 Channel + 项目治理链（激活/计划门/派发/预算/保护/越权） | 同上 P3–P12 | 全 PASS |
| A3 | 执行→对账→成果→审批→完成门禁 | 同上 P13–P17 | 全 PASS |
| A4 | 内核面（HealthBoard/Ledger/tick/snapshot.kernel） | 同上 P24 | 全 PASS |
| A5 | Route 闭环在产线项目上的链式自动派发 + 开关面 | 同上 P25 | 全 PASS |
| A6 | 产线治理独立 E2E（开停线 HITL/TOCTOU/跨线清理） | e2e-line-governance | 全 PASS |
| A7 | 项目回滚演练（旧库迁移/幂等） | e2e-project-rollback | 全 PASS |
| A8 | 整体退出码 | 三脚本 exit=0 | 0 |

## Track A-UI — 前端渲染与交互（真实浏览器 + 真实服务端）

| # | 验收项 | 工具 | 通过标准 |
|---|---|---|---|
| U1 | /projects 列表/详情页渲染（项目/交付物/工作项/成果/审批区域可见） | scripts/ui/projects-smoke.mjs | 全 PASS + 截图 |
| U2 | 交互矩阵 I1–I14（UI 建项目→绑频道→交付物→工作项→激活→派发→完成→成果→审批→提案应用→周报→无页面异常→截图） | scripts/ui/projects-interactions.mjs | 全 PASS + 截图 |
| U3 | 视觉质量 | 截图人工走查（布局/中文渲染/状态徽标） | 无明显破版 |

## Track B — 非产线纯开发任务（无产线，Route 闭环自主构建）

场景：**「为智能注塑云平台开发一个产品设计落地页」**——不建产线、不绑 line，
纯开发任务。Project（autoDispatch=1）+ project_leader（真 LLM，omp）提案
**链式计划**（W1 信息架构与文案设计 →W2 落地页 HTML 实现，dependsOn）→ owner 批准 →
**全程零手动派发**：内核自动派发 W1 → lead 真 LLM 自主构建交付 → 完成回调 →
内核自动派发 W2 → lead 自主实现落地页 → 成果链 → 完成门禁。

| # | 验收项 | 通过标准 |
|---|---|---|
| B1 | 隔离实例启动（build 产物 + 会话密钥 ≥32 字符） | health ok |
| B2 | 项目创建（autoDispatch=true 落库、无产线、leader harness=omp） | snapshot.autoDispatch=true |
| B3 | leader 真 LLM 提案链式计划（w2 dependsOn=[w1] 物化成功） | work item 依赖落库 |
| B4 | **零手动派发**：W1 由内核自动派发 | 事件 `work.dispatch_auto`（W1），脚本未调用 dispatch |
| B5 | W1 lead 自主执行完成（真实工件=设计结构/文案） | root COMPLETED + 非空工件 |
| B6 | 完成回调 → W2 自动派发（依赖门解除） | 事件 `work.dispatch_auto`（W2） |
| B7 | W2 lead 自主实现落地页并交付完整 HTML | root COMPLETED + HTML 工件 ≥400 字符 |
| B8 | 成果链（draft→lead 提交→复核→验收批准） | 全通 |
| B9 | 完成门禁 + owner 批准 → completed | status=completed |
| B10 | 落地页浏览器实测（标题/hero/分区渲染/交互元素/移动端视口截图） | 渲染无空白 + 关键分区存在 + 截图证据 |
| B11 | Route 审计：恰好 2 次 `work.dispatch_auto`（顺序 W1→W2）+ 账本里程碑 | 事件与 ledger 可查 |
| B12 | Track B 实例前端走查：项目页渲染（概览/计划/交付物/审批 tab 截图） | 无破版、数据真实 |

## 执行与证据

- 证据根：`docs/audit/evidence/2026-11-05-route-demo/`（本规范 + Track B 结果 JSON + 截图 + 落地页工件）。
- Track A 复用既有 gates 证据目录；Track A-UI 截图入 `2026-11-03-project-layer/`（既有面）。
- 全部通过后更新 ACCEPTANCE.md 增量段。
- **如实声明**：Mimosa 安全扫描 scanner_enobufs 维持 partial/inconclusive，本演示不宣称安全验收。

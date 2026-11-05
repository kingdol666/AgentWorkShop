# 实机演示验收报告（2026-11-05，Route 闭环合并后 · main 744116ca）

验收规范：`docs/plans/2026-11-05-live-demo-acceptance-plan.md`。
结论：**Track A（产线集成）/ Track A-UI（前端渲染与交互）/ Track B（非产线纯开发 · 落地页 Route 闭环自主构建）全部通过**；
安全扫描维持 partial/inconclusive（Mimosa scanner_enobufs），本演示**不宣称安全验收**。

## R2 全量重跑（2026-11-05，同规范复现验证 · main b0032a85）

应用户要求以同一验收规范重跑全部实机演示（七套件并行，隔离实例，全部新鲜证据）：

| 轨 | 结果（R2 新鲜） |
|---|---|
| Track A 产线 | line-acceptance **70/0/0** · governance **44/44** · rollback **12/0** |
| Track A-UI | smoke **7/0** · interactions **28/0** |
| Track B 真 LLM | **主链 B1–B11 全绿**（零手动派发、dispatch_auto×2 顺序 W1→W2、成果链、完成门禁、桌面+移动浏览器实测）；总计 25/26 |
| Track B 配套走查 | **14/14**（独立实例五 tab 渲染/交互全绿） |

**唯一失败 B12b = 脚本断言缺陷（非产品缺陷）**：断言要求概览文本含大写 `COMPLETED`，但概览 tab
全渲染后徽标为小写 `completed`（大写工作项状态在「计划与工作」tab），且一次性 `innerText` 读取
撞上异步数据加载（同轮截图 `ui-project-overview.png` 证明页面渲染完整正确：项目名/completed 徽标/
频道卡/周报 2·2 工作项/五 tab 齐全）。断言已修复（轮询至数据出现 + 对齐真实渲染 marker）。

**R2 运行期观察（如实）**：
1. W1 执行顺畅（约 5 分钟完成）；W2 在 SUBMITTED 滞留约 **23 分钟**后由 D1 兜底复活并完成——
   兜底自愈再度有效，但延迟方差大（R1 分钟级、R2 约 23 分钟），**P2 收敛候选（omp lead 失活不重组）优先级上调**。
2. 落地页工件本轮 **12,177 B**（lead 这次严格遵守 ≤12KB brief；R1 为 57,959 B）——模型行为方差，
   两版人工复核均为专业级完整落地页，均通过浏览器实测。
3. LM Studio 同载 9b/27b 双模型不影响 9b 主链复现；未改全局 omp 配置，保持可复现。

R2 结论：**三轨全部复现通过**；唯一失败项为脚本断言缺陷并已修复入库；安全边界声明不变。

## Track D 多 Channel 协同验证（2026-11-05，track-d-multi-channel-coordination.mjs）

专项回答「Project 是否调用 Channel 协调调配、leader 能否协调**多个** Channel」：双成员频道（前端 A/后端 B）
+ 办公室频道 leader，跨频道链 W1(A 设计契约)→W2(B 依 W1 实现)→W3(A 依 W2 集成)，零手动派发，**10/10 通过**。

- 调用链（代码锚点）：`dispatchWorkItemAs`（service.ts:520）依赖门 :550 → 绑定校验 :564 →
  `getChannelForUser(wi.channelId)` :567 → `attempts.create` :574 → **`manager.submitProjectRoot({channelId})` :577**
  —— Project 把根任务真实提交进目标 Channel；完成后 EventIngress→对账→`selectReadyWorkItems` 依赖解除派发下一项。
- 执行过程审计（track-d-coordination.json timeline）：`plan.requested → dispatch_auto(W1) → work.completed(W1) →
  dispatch_auto(W2) → work.completed(W2) → dispatch_auto(W3) → work.completed(W3)` —— 派发/完成严格交错接力，
  3 次 dispatch_auto 顺序正确，任务各自落对频道（UI 截图计划 tab 两个不同频道 ID 可见）。
- 跨频道隔离断言：派发 W2 时频道 A 无 W2 任务、派发 W3 时频道 B 无 W3 任务（D4/D5）。
- 门禁正确性副产物：多交付物场景漏验收后端成果时完成门禁拒绝（初跑发现），补全成果链后 completed——**门禁按设计工作**。
- 边界：本轨=mock harness 机制面；真 LLM leader 提案/执行已由 Track B（单频道）证明；真 LLM 提跨频道计划属 V1.1（9B 连单频道依赖都会漏）。

## Track E 简单 vs 复杂端到端对比（2026-11-05，track-e-simple-vs-complex.mjs，10/10）

- **简单任务（单 Channel）**：1 频道/1 工作项，tick 自动派发→完成回调→成果链→完成门禁 **352ms 全链 completed**；恰好 1 次 dispatch_auto 且落对频道（ES1–ES3）。
- **复杂任务（3 Channel 菱形 DAG）**：前端 A/后端 B/测试 C 三频道，W1(A)→{W2(B), W3(A)}→W4(C, dependsOn=[W2,W3])。关键新机制断言全过：**EC3 菱形门——仅完成 W2 时 W4 保持 DRAFT（多依赖未齐备不派发）**；EC2 并行就绪集（W1 完成后 W2/W3 同时派发）；EC5 恰好 4 次 dispatch_auto 且 W1 最先 W4 最后；**911ms 全链 completed**（EC1–EC6）。
- 证据：`track-e-simple-vs-complex.json`（含两场景对比指标与事件 timeline）。

## 同日附加产出（论文/审计轮）

- **系统自产软件盘点**：`system-built-software-inventory.md` —— 真「系统自产软件」2 件（本目录 landing-page.html 与 project-layer track-b inventory-system.html），附过程记录清单。
- **核心代码设计审计**：`code-audit-report.md` —— 独立代理审计，总评 **B+**：1×P1（派发主链路原子性）+5×P2+6×P3，九维矩阵（职责/状态机/幂等/事务/并发/错误分类/可观测/fail-closed/测试对齐），含修复优先序。
- **创新性与可发表性评估**：`docs/architecture/2026-11-05-agent-architecture-novelty-assessment.md`。
- **论文核心架构图**：`docs/architecture/2026-11-05-aw-paper-core-figure.{html,png,pdf}`（figure-designer 规范：solution-overview 范式、色盲安全、矢量 PDF、最小字号按 \textwidth 缩放 ≥8pt）。

## Track A — 产线集成业务（全部真实 HTTP + 真实服务端）

| 验收项 | 脚本 | 结果 |
|---|---|---|
| A1–A5 产线业务/治理链/内核面/Route 闭环 | `scripts/e2e-project-line-acceptance.mjs` | **70 PASS / 0 FAIL / 0 BLOCKED**（P1–P25，含 P25 链式自动派发 + 开关面） |
| A6 产线治理独立 E2E（HITL/TOCTOU/跨线清理） | `scripts/e2e-line-governance.mjs` | **44/44 PASS** |
| A7 项目回滚演练 | `scripts/e2e-project-rollback.mjs` | **12 PASS / 0 FAIL** |

## Track A-UI — 前端渲染与交互（真实浏览器点击）

| 验收项 | 脚本 | 结果 |
|---|---|---|
| U1 项目页渲染（列表/详情/五 tab/无异常） | `scripts/ui/projects-smoke.mjs` | **7 PASS / 0 FAIL** |
| U2 交互矩阵 I1–I15（UI 建项目→…→审批→提案应用→周报） | `scripts/ui/projects-interactions.mjs` | **28 PASS / 0 FAIL** |
| U3 视觉走查 | 截图人工复核 | 无破版（深色工业主题一致、中文渲染正常、状态徽标清晰） |

## Track B — 非产线纯开发：产品设计落地页（真 LLM 自主构建，零手动派发）

实例：隔离 build 产物（端口 3966），omp + LM Studio（qwen3.5-9b），项目 autoDispatch=1、无产线。

| 验收项 | 结果 | 证据 |
|---|---|---|
| B1–B2 实例/项目（autoDispatch 落库） | ✅ | track-c-acceptance.json |
| B3 leader 真 LLM 提案计划 → owner 批准 → planVersion=1 | ✅ | 依赖由 owner PATCH 补齐（9B 未发 dependsOn，审计 work.updated 留痕——如实记录） |
| **B4 零手动派发：内核自动派发 W1** | ✅ | `work.dispatch_auto`(W1) |
| B5 W1 lead 自主完成（设计文档工件） | ✅ | root COMPLETED，artifacts=1 |
| **B6 完成回调 → 内核自动派发 W2** | ✅ | `work.dispatch_auto`(W2) |
| B7 W2 lead 自主实现落地页 | ✅ | root COMPLETED，**HTML 工件 57,959 字节** |
| B8 成果链（draft→提交→复核→验收批准） | ✅ | result b1414e71… |
| B9 完成门禁 + owner 批准 → completed | ✅ | status=completed |
| B10 落地页浏览器实测（桌面 1440：hero/分区/可滚动/CTA 点击；移动 390：无横向溢出） | ✅ | landing-desktop.png / landing-mobile.png |
| B11 Route 审计：恰好 2 次 dispatch_auto（W1→W2 顺序）+ 账本 8 里程碑 | ✅ | events + ledger API |
| B12 项目页五 tab 走查（同形状数据实例） | ✅ **14/14** | track-c-ui-walkthrough.json + ui-project-*.png |

**总计：Track C 主流程 23/23 + 配套 UI 走查 14/14，0 失败。**

## 工件质量（人工复核）

- 落地页（57KB 单文件）：深色工业风、hero「让每一模，都有据可依」+ 指标带（12,000+/300+/35%/99.9%）、
  问题/平台/能力/行业/90 天路径/结果/FAQ/CTA 完整分区、内联图表、中文专业文案、移动端单列无溢出。
- 项目页：概览（completed 徽标/频道受保护/周报数字）、计划与工作（计划快照 + 链式工作项 COMPLETED + 预算 + 派发/重试）、
  交付物分组、审批历史、决策与事件（dispatch 审计链）。

## 运行期观察（如实记录）

1. **omp lead 运行时失活 → D1 兜底自愈**：W1/W2 root 均滞留 SUBMITTED 数分钟后由
   `[AgentChannelManager] D1 兜底` 复活 lead 并投递领取消息，随后正常执行完成 —— 自愈有效但延迟达分钟级；
   根因（idle-sweep 后 scheduler 置空、ensureChannelActive 对"存在但失活"的运行时不重组）建议作为 P2 缺陷
   在后续轮次收敛（亚秒派发路径依赖它）。
2. **9B 模型提案未带 dependsOn**：owner 以 DRAFT PATCH 补齐（幂等收敛、审计留痕）；27B 模型可能更稳，未测。
3. B12 首跑因 `AW_BASE` 未设静默跳过（脚本缺陷已修复：`process.env.AW_BASE = BASE`）；
   配套走查脚本补齐证据。

## 边界

- 不宣称安全验收（Mimosa scanner_enobufs 维持 partial/inconclusive）。
- Track B 的 leader 提案依赖补齐由 owner 完成；全自动「leader 提链式计划」依赖模型能力，属 V1.1 提示词/模型升级项。

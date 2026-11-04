# 实机演示验收报告（2026-11-05，Route 闭环合并后 · main 744116ca）

验收规范：`docs/plans/2026-11-05-live-demo-acceptance-plan.md`。
结论：**Track A（产线集成）/ Track A-UI（前端渲染与交互）/ Track B（非产线纯开发 · 落地页 Route 闭环自主构建）全部通过**；
安全扫描维持 partial/inconclusive（Mimosa scanner_enobufs），本演示**不宣称安全验收**。

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

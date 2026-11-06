# Project 层 V1 验收签署（G6）

日期：2026-11-04。分支：main（PR#31 audit-atomic/line-grant、#32 members/channel-proposals、#33 weekly-report/interactions、#34 g6-close 合并后）。

## 签署栏

| 角色 | 姓名/身份 | 结论 | 日期 | 签署 |
|---|---|---|---|---|
| 开发执行（AI） | ZCode（本会话） | 已实现范围全部门禁通过（见 gates/index.json） | 2026-11-04 | 已签（本文件 + 证据包即签署记录） |
| 独立复核（AI） | reviewer agent | APPROVED（8/8 验收标准新鲜证据复核） | 2026-11-04 | 已签（复核报告存会话档案） |
| **Project Owner（人）** | 待用户 | **待签署** | — | ⬜ 用户确认后在此签名 |

> Owner 签署说明：请审阅 `docs/audit/evidence/2026-11-03-project-layer/`（ACCEPTANCE.md、project-line-acceptance.json、rollback-drill.json、gates/、project-interactions.png）后签署。签署前本层按"受控试点可用"定位使用，不宣称完整 V1。

## 明确豁免/未完成（不因签署而变绿）

1. **独立安全扫描（Mimosa）**：2026-11-04 `scan-2026-11-04T06-55-56.203Z-dc53a4c61c32`（normal 深度，seal sha256:20894c73…）**已完成但覆盖不完整**（coverage=partial，runStatus=inconclusive，verdictEffect=none）。共 11 条 findings（4 硬编码凭据/i18n 示例与测试脚本、6 疑似跨文件污点/存量脚本与 paper 快照、1 路径穿越/bench 论文绘图 py），**全部位于存量面，无一命中 Project 层新增代码**（focus 复核清单 service/tools/gate/repo/api 全部未命中）。因覆盖不完整，仍**不宣称"安全审计通过"**；可陈述的事实=Project 层新增面在本次扫描中零 findings。
2. Track B（纯开发任务 × 真实 LLM 自主构建）：**2026-11-04 已在隔离实例执行（真 LLM = 本地 omp）**。run6 实证：PR16 取消护栏有效（lead 全程未能自取消 root）+ **成果链全通**（leader 真 LLM 提案计划→owner 批准→派发→lead 自主执行→root COMPLETED→成果 draft→lead 提交→复核→owner 验收批准→完成门禁→项目 completed）。run5 诊断发现并修复真实缺陷：隔离实例会话密钥 <32 字符 → agent-token 路由 500 风暴 → lead 盲执行（PR18 已加 dev fail-loud 告警）。工件文本产出受本地 9B 模型能力限制（详见 track-b/ 记录）。
3. 团队协作为 V1.1 提前实现的最小面（viewer/approver）；共享频道/多项目成员治理仍在计划排期。
4. 周报为数字一页纸（JSON/页面卡片）；PDF/邮件分发未做。

## 通过门禁快照（详见 gates/index.json）

G0 typecheck/lint · G1 schema/迁移 · G2 安全 P0（本地） · G3 核心/派发/leader 工具 · G4 成果/审批/审计事务化/write_intent/line grant/MAST14 · G5 构建+UI smoke 7/7+交互矩阵 28/28 · G6 产线治理 E2E + 项目生产业务 E2E（**64 PASS/0 FAIL**，含 P24 内核面）+ 回滚演练 12/12。

## 2026-11-04 增量（PR16/PR17/PR18，均 CI 绿合并 main）

- **PR16 (#38)**：lead 不可自取消项目 root 取消护栏（Track B run4 实证有效）。
- **PR17 (#39)**：M4 调度内核 = SuperAgent S2/S3/S5/S6/S7/S11 落地（EventIngress 快慢路径 + 双账本 + Watchdog/HealthBoard + Effects outbox；单测 7/7、全量 1092/0、E2E 64/0）。
- **PR18 (#40)**：dev 模式短会话密钥 fail-loud 告警（run5 真因防御）。

## 2026-11-05 增量（PR19/PR20，均 CI 绿合并 main）

- **PR19 (#41)**：派生进度（外部评价 P1）+ 演示脚本度量修复（P0）；单测全量 1099/0。
- **PR20 (#42)**：**Route 派发闭环**（plan v3.0 §2.2「计划批准后 ProjectService 按批准版本派发工作项」的确定性落地）—— selectReadyWorkItems 依赖解析 + runRouteLoop（对账 + await 自动派发，按项目 promise 链串行）；内核 tick(10s)/Reconciler(30s) 双路，完成回调→派发下一就绪项延迟上界 ≈1 对账周期；手动/自动派发事件审计（work.dispatched / work.dispatch_auto）；环境类前置失败 → BLOCKED + work.blocked（SLOW 邮箱）；projects.auto_dispatch 默认 0（owner 显式启用）。验收 R1–R12：单测 7/7、全量 **1104 pass/0 fail**、E2E P25 链式全闭环 **70 PASS/0 FAIL**（gates/G7-route-dispatch-e2e.json）、计划文档 docs/plans/2026-11-05-project-route-dispatch-plan.md（v3.0 两份计划同轮入库）。**边界不变**：无 LLM 调度/自动 replan/自动完成项目；TaskEngine.onTaskChange 亚秒回调留 V1.1。

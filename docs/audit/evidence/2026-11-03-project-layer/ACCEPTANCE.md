# Project 层 V1 最终验收报告（PR1–PR15，全部合入 main）

日期：2026-11-04。状态：**plan v3.0 全部里程碑（含 §7.1 API 面、§7.2 五 tab UI）验收通过；并行审查 P0 全部闭环**。
main HEAD：`4d09817f`（PR#36/#37 合并 + 证据包）。证据根目录：`docs/audit/evidence/2026-11-03-project-layer/`。

---

## 1. 交付追溯（plan v3.0 → PR → 合并状态）

| #36 | **API 面补全（plan §7.1）**：PATCH project/deliverable/work-item + retry/snapshot/trace/审批历史，全 zod | ✅ merged |
| #37 | **UI 五 tab 重构（plan §7.2）**：概览/计划与工作/交付物/审批/决策与事件 + retry/cancel/waive + 受保护徽标 + 成果分组 | ✅ merged |

| PR | 内容 | 状态 |
|---|---|---|
| #22 | P0 安全前置（spawn/workspace/MCP/DTO） | ✅ merged |
| #23 | Schema/9 表/迁移/Repo | ✅ merged |
| #24 | 项目办公室/leader/生命周期 | ✅ merged |
| #25 | 派发/attempt/上下文传播/预算 | ✅ merged |
| #27 | 成果/审批/审计/Reconciler | ✅ merged |
| #28 | 项目页 UI + browser smoke | ✅ merged |
| #29 | plan/complete 门禁 + MAST L1–L14 | ✅ merged |
| #30 | leader 提案工具/执行硬门/write_intent | ✅ merged |
| #31 | 审计事务化（B8）+ line grant 成果过滤（C11） | ✅ merged |
| #32 | 项目成员 viewer/approver + M5 leader 建频道提案 | ✅ merged |
| #33 | 周报 API/UI 导出 + UI 交互矩阵 20 步（P17 收口） | ✅ merged |
| #34 | 回滚演练 + G0–G6 证据归档器 + SIGNOFF（P18b 收口） | ✅ merged |
| **#35** | **并行审查剩余 P0 闭环（PR13）**：计划门/DRAFT 自动对齐、Reconciler 幂等（不再无限审计膨胀）、attempt 闭合（FAILED 可重派）、完成门豁免入口（waive/cancel）、write_intent 堵 submit_task 绕道、自批可达、UI 审批 payload 防盲签 | ✅ merged |

## 1.1 并行审查缺陷闭环对照

并行审查（PR1–PR8 时点）确认 8 项阻断缺陷，现逐项闭环：

| # | 缺陷 | 修复 | 回归 |
|---|---|---|---|
| 1 | Reconciler 把 DRAFT 永久 BLOCKED + 每 30s 无限追加 decision | DRAFT 跳过 + record() 同 type+args 去重 | review-fixes #3 + 全量单测 |
| 2 | 计划门缺失（未批计划可派发） | PLAN_NOT_APPROVED 门 + DRAFT 自动对齐 + 非 DRAFT 重派 STALE | review-fixes #1/#2 + MAST L8 重写 + E2E P7b/P7c |
| 3 | attempt 不闭合 → FAILED 永久 IN_FLIGHT | 终态时 attempts.close | review-fixes #4 |
| 4 | 完成门死锁（无豁免入口） | owner waiveDeliverable/cancelWorkItem | review-fixes #5/#6 |
| 5 | write_intent 可被普通任务绕过 | gate 主体改为 Agent 项目上下文 | review-fixes #7 |
| 6 | 自批检查生产不可达 | owner 提交落 author_user_id | review-fixes #8 + E2E 链改为 lead 提交 |
| 7 | 审计不事务化 | 同事务 + 注入失败回滚（B8） | audit-linegrant（#31） |
| 8 | UI 盲签/harness 不可选 | 审批卡 payload 摘要；创建可选 leader harness | 交互矩阵 I7b（UI 批准） |

---

## 2. 最终门禁（main @ PR13 后，证据 = gates/index.json）

| Gate | 命令 | 结果 |
|---|---|---|
| G0 | typecheck / lint | ✅ PASS |
| G1–G4 | `npm run test:unit` | ✅ **1087 tests / 1085 pass / 0 fail / 2 skipped**（含 MAST 14/14、B8 回滚注入、C11 grant、成员/建频道提案、PR13 八项、**PR14 API 补全 3 项**回归） |
| G5 | `npm run build` | ✅ PASS（host-tools 121） |
| G5 | UI smoke | ✅ **7/7**（U4a 概览 + U4 五 tab 逐区） |
| G5 | UI 交互矩阵 | ✅ **28/28**（新增五 tab 断言 I14a–d、UI 批准计划 I7b、lead 工具提交 I10a） |
| G6 | 产线治理 E2E | ✅ PASS |
| G6 | 项目生产业务 E2E | ✅ **60 PASS / 0 FAIL / 0 BLOCKED**（新增 P23a–g：update/retry/snapshot/trace/审批历史/完成门前终态清理） |
| G6 | 回滚演练 | ✅ **12/12** |

---

## 3. 安全扫描（Mimosa，2026-11-04）

`scan-2026-11-04T06-55-56.203Z-dc53a4c61c32`（normal，seal sha256:20894c73…）：coverage **partial/inconclusive**，verdictEffect=none——**不宣称"安全审计通过"**。11 条 findings 全部位于存量面（i18n 示例/旧脚本/paper 快照/bench py/mes-rest/channel-agent 既有 token 逻辑），**无一命中 Project 层新增代码**。

## 4. 签署

[SIGNOFF.md](./SIGNOFF.md)：开发执行（AI）+ 独立复核（AI）已签；**Project Owner（人）签署栏待用户**。

## 5. 明确豁免/未完成（不因签署变绿）

1. Mimosa 覆盖不完整 → 不宣称安全验收通过（事实：Project 层新增面本次扫描零 findings）。
2. Track B（纯开发任务 × 真实 LLM 自主构建）未执行：隔离验收 home 无 LLM provider 配置。
3. 团队协作为最小面（viewer/approver）；共享频道/多项目成员治理待排期。
4. 周报为数字一页纸（JSON/卡片）；PDF/邮件分发未做。
5. V1.1/V2 项（ProjectSchedulerLoop、Mandate、双 Ledger、effects/outbox、push 订阅）按计划有意推迟。

## 6. 结论

**plan v3.0 的 P0–M5 全部里程碑 = 13 个 PR 已开发、验收并合并进 main（HEAD 3dd260d4）；并行审查确认的全部 8 项阻断缺陷已修复并带回归测试；合并后 main 的 G0–G6 全量门禁在真实产线业务对象上全绿（单测 1082/0 fail、生产业务 E2E 53/0、交互矩阵 22/0、回滚演练 12/0、产线治理 E2E 全绿）。** Project 层按"受控试点可用"定位交付，Owner 签署后生效；完整 V1 剩余边界仅为 §5 明确豁免项。

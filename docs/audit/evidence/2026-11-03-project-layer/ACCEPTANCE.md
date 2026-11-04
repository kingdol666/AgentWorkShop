# Project 层 V1 最终验收报告（PR1–PR12，全部合入 main）

日期：2026-11-04。状态：**V1 已实现范围全量通过；剩余项见 §5 明确豁免**。
main HEAD：`fc31d9a0`+（PR#34 合并 + blocked 占位清理）。证据根目录：`docs/audit/evidence/2026-11-03-project-layer/`。

---

## 1. 交付追溯（plan v3.0 → PR → 合并状态）

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
| #31 | **审计事务化（B8）+ line grant 成果过滤（C11）** | ✅ merged |
| #32 | **项目成员 viewer/approver（团队协作）+ M5 leader 建频道提案** | ✅ merged |
| #33 | **周报 API/UI 导出 + UI 交互矩阵 20 步（P17 收口）** | ✅ merged |
| #34 | **回滚演练 + G0–G6 证据归档器 + SIGNOFF（P18b 收口）** | ✅ merged |

---

## 2. 最终门禁（main 上执行，证据 = gates/index.json + 各 gate evidence.md）

| Gate | 命令 | 结果 |
|---|---|---|
| G0 | typecheck / lint | ✅ PASS |
| G1–G4 | `npm run test:unit` | ✅ **1076 tests / 1074 pass / 0 fail / 2 skipped**（含 MAST 14/14、B8 回滚注入、C11 grant、成员/建频道提案套件） |
| G5 | `npm run build` | ✅ PASS（host-tools 121，13 个 project 工具随产物分发） |
| G5 | UI smoke | ✅ 6/6 |
| G5 | UI 交互矩阵 `projects-interactions.mjs` | ✅ **20/20**（UI 建项目→绑频道→建交付物/工作项→激活→派发→完成对账→成果提交/复核/申请验收→审批批准→leader 提案页面应用→周报渲染/导出→零页面异常） |
| G6 | 产线治理 E2E `e2e-line-governance.mjs` | ✅ PASS（既有 44 断言全绿） |
| G6 | 项目生产业务 E2E `e2e-project-line-acceptance.mjs` | ✅ **51 PASS / 0 FAIL / 0 BLOCKED** |
| G6 | 回滚演练 `e2e-project-rollback.mjs` | ✅ **12/12**（真实文件级 DB 备份/恢复含 WAL：项目消失、频道/产线保留、平台健康；证据 rollback-drill.json） |

生产业务 E2E 51 断言覆盖：隔离实例/真实产线对象 → leader 工具面与执行硬门（P4c/P4d）→ 绑定/交付物/工作项/激活/派发/预算（P5–P9）→ 保护与越权负例（P10–P12c）→ **leader 建频道提案→应用→绑定（P21a–c）** → **成员 viewer 可读（P22a）/成果 line grant 过滤（P22b）** → 成果链 channel lead 工具提交（P13c2/P13d）→ review/验收/批准（P13e–P14c）→ **approver 成员代 owner 决策计划审批→物化（P14e1–e3）** → write_intent 申请/批准（P20a/b）→ 审计/重复决策负例（P16/P14d）→ **周报数字一致（P17a）** → 完成门禁（P14f）。

---

## 3. 安全扫描（Mimosa，2026-11-04）

`scan-2026-11-04T06-55-56.203Z-dc53a4c61c32`（normal 深度，seal sha256:20894c73…，static-only）：
- 覆盖 **partial / runStatus=inconclusive / verdictEffect=none** —— **不宣称"安全审计通过"**。
- 11 条 findings（4 hardcoded-credential：i18n 示例文案与测试脚本；6 疑似跨文件污点：存量脚本/paper 快照/bench/mes-rest/channel-agent.repo 既有 token 逻辑；1 path-traversal：bench 论文绘图 py）**全部位于存量面，无一命中 Project 层新增代码**（focus 清单 service/tools/gate/tool-surface/repo/api 全部未命中）。

## 4. 签署

见 [SIGNOFF.md](./SIGNOFF.md)：开发执行（AI）+ 独立复核（AI，APPROVED）已签；**Project Owner（人）签署栏待用户**。

## 5. 明确豁免/未完成（不因签署变绿）

1. Mimosa 覆盖不完整 → 不宣称安全验收通过（可陈述：Project 层新增面本次扫描零 findings）。
2. Track B（纯开发任务 × 真实 LLM 自主构建）未执行：隔离验收 home 无 LLM provider；生产实例按隔离规则不触碰。
3. 团队协作为最小面（viewer/approver）；共享频道/多项目成员治理待排期。
4. 周报为数字一页纸（JSON/卡片）；PDF/邮件分发未做。
5. V1.1/V2 项（ProjectSchedulerLoop、Mandate、双 Ledger、effects/outbox、push 订阅）按计划有意推迟。

## 6. 结论

**plan v3.0 的 P0–M5 全部里程碑对应的 12 个 PR 已开发、验收并合并进 main；合并后 main 的 G0–G6 全量门禁在真实产线业务对象上全绿（单测 1074/0 fail、生产业务 E2E 51/0、交互矩阵 20/0、回滚演练 12/0、产线治理 E2E 全绿）。** Project 层可按"受控试点可用"定位使用；完整 V1 的剩余边界仅为 §5 明确豁免项，Owner 签署后生效。

# Project 层 V1 分阶段验收报告（PR1–PR8）

日期：2026-11-04。状态：**分阶段验收通过，V1 全量仍未完成**。
被测分支：`pr/08-leader-tools`（stacked on PR1–PR7）。
证据：`docs/audit/evidence/2026-11-03-project-layer/project-line-acceptance.json`、`projects-list.png`、`project-detail.png`。

---

## 1. 验收边界

### 已实现并验收

- P0 安全前置（PR1）：spawn/workspace 策略、MCP 管理/设备面拒绝 agent token、agent DTO 去凭证。
- 数据底座（PR2）：9 张项目表、tasks/channel_agents/audit_log 新列、迁移顺序、旧库 rebuild 保留列与索引。
- Project 核心（PR3）：项目办公室频道、`agent_kind='project_leader'`、生命周期、成员 Channel 绑定、办公室频道保护。
- 派发（PR4）：交付物/工作项、`submitProjectRoot`、项目上下文传播到子任务、项目预算、重复派发拒绝。
- 成果/审批/审计/Reconciler（PR5）：root COMPLETED 自动 draft、submit、review、owner acceptance、审批 CAS/过期/自批拒绝、decisions/events 审计、工作项终态对账。
- 计划/完成门禁/MAST/定时对账（PR7）：`plan_approval`、`project_complete` 门禁、依赖门禁、证据门禁、30s Reconciler、MAST L1–L14 回归。
- **Project Leader 参与（PR8）**：
  - 工具面：`project_get_status` / `project_list_channels` / `project_read_*` / `project_propose_plan` / `project_propose_dispatch` / `project_propose_replan` / `project_review_result` / `project_request_approval`；channel lead 的 `project_submit_result` / `project_request_write_intent`。
  - 注入面：leader 白名单（无 Channel lead 工具/工业写/插件管理）；成员按 channel lead/worker 裁剪；非项目频道 0 个 project 工具。
  - 执行层硬门：leader 调 `dispatch_task` 等 → `PROJECT_TOOL_DENIED` 并写 rejected decision；成员越权调 propose → 拒绝；项目外调 project 工具 → 拒绝。
  - 计划提案：`project_propose_plan` 写 proposed decision + `plan_approval`；owner 批准后物化交付物/工作项（按 name/dedupeKey 幂等，依赖二次回填）。
  - 派发提案：`project_propose_dispatch` 只写 proposed decision；owner 通过 `POST /projects/:id/proposals/:decisionId/apply` 应用为工作项（可选立即派发）。
  - 成果提交/复核：channel lead 提交本频道成果；leader 只能 reviewed/rejected，不能 approve。
  - `write_intent`：channel lead 按 work item/attempt/tool/args digest 申请；owner 批准后执行器一次性消费；tool/args/attempt 不匹配拒绝；项目默认 `mayWrite=false`（`projects.config_json.mayWrite` 显式开启才豁免）。
  - 提示词：`project-leader.md` / `project-member.md` 按 Agent 项目上下文注入。

### 未实现，明确 BLOCKED（不得算通过）

- 完整 Playwright 交互矩阵 / 周报导出（P17）。
- Live 全量 / G0–G6 证据文件夹 / 回滚演练 / 两方签署（P18b）。
- M5 leader 自建/删除 Channel；独立安全扫描/红队。
- 团队协作/共享频道（V1 仍 owner-only、一 Channel 一 active Project）。
- 审计 fail-closed 全覆盖：成果/交付物状态更新与 decisions/events 尚未统一到一个事务。
- line grant 过滤：成果读取已有 `line_id` 快照，但按用户 line grant 的读取过滤未接入。
- V1.1/V2 计划项（ProjectSchedulerLoop、Mandate、双 Ledger、effects/outbox、push 订阅）按计划有意推迟。

---

## 2. 计划 v3.0 落实对照

| 计划项 | 状态 | 证据/说明 |
|---|---|---|
| P0-1/P0-2 spawn + workspace 策略 | ✅ | PR1 单测 + 安全负例 |
| P0-3/P0-4 MCP/DTO 去凭证 | ✅ | PR1 单测 |
| P0-5 scheduler decision 不含 spawn config | ✅ | PR1 单测 |
| M0 9 表/迁移/索引 | ✅ | `project-schema.test.ts`（新库/旧库/双 init/rebuild） |
| M1 办公室频道 + leader 实例 + 生命周期 | ✅ | `project-core.test.ts` + E2E P4–P7 |
| M2 派发/attempt/上下文传播/预算 | ✅ | `project-core`/E2E P8–P9 |
| M3 成果/审批/审计/Reconciler | ✅ | `project-results-approvals.test.ts` + E2E P13–P16 |
| M4 API/UI/计划编辑 | 🟡 部分 | 项目页 5 tab + 提案应用；计划 diff/评论/周报未做 |
| M5 验收/证据/回滚 | 🟡 部分 | 本报告 + MAST；G6 未做 |
| C3 leader 工具快照 | ✅ | PR8 工具面矩阵 + 执行层硬门 |
| C4 channel lead `project_read_*`/submit | ✅ | PR8 单测 + E2E P13c2/P13d |
| C5 非项目 Channel 0 个 project 工具 | ✅ | PR8 单测 |
| C6 项目外/错项目调用 403 | ✅ | PR8 单测 + 执行层 |
| C7 submit 只能本频道/本工作项 | ✅ | PR8 单测 |
| C8 leader 不能 approve | ✅ | PR8 单测 |
| C14 write_intent 申请/批准/一次性消费 | ✅ | PR8 单测 + E2E P20a/P20b |
| 计划批准 → 物化/派发 | ✅（物化） | owner 批准后物化交付物/工作项；**派发保持显式 owner 动作**（安全取舍，见 §5） |
| 完整 Playwright / G6 / M5 / line grant | ❌ | 明确 BLOCKED/未接入 |

---

## 3. 验收标准与结果

运行：

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run build

node scripts/ui/projects-smoke.mjs

AW_PROJECT_ACCEPTANCE_OUT=docs/audit/evidence/2026-11-03-project-layer/project-line-acceptance.json \
  node scripts/e2e-project-line-acceptance.mjs
```

### 3.1 本地门禁

| 项 | 结果 |
|---|---|
| typecheck | ✅ 通过 |
| lint | ✅ 0 error |
| 单测 | ✅ **1067 tests / 1065 pass / 2 skipped / 0 fail** |
| build | ✅ 产物 + prompts 外置资产 |
| UI smoke | ✅ **6/6** |
| 生产业务 E2E | ✅ **45 PASS / 0 FAIL / 2 BLOCKED** |
| MAST L1–L14 | ✅ 14/14 |

### 3.2 生产业务 E2E（真实产线对象）

链路：真实 DCW 产线/模板/节点/产品/配方 → 绑线 Channel（mock lead）→ Project（办公室 + project_leader）→ 交付物/工作项 → 激活/派发 → root 完成 → 成果 draft/submit/review/验收 → 计划提案/批准/物化 → write_intent 申请/批准 → 项目完成。

| ID | 验收项 | 结果 |
|---|---|---|
| P0–P2b | 隔离实例/真实产线对象/业务面可见 | ✅ |
| P3–P4b | 绑线 Channel、Project 办公室、`agent_kind=project_leader` | ✅ |
| P4c/P4d | leader `get_status`；leader 调 `dispatch_task` → `PROJECT_TOOL_DENIED` | ✅ |
| P5–P6b | 绑定成员 Channel、交付物、工作项、非法交付物拒绝 | ✅ |
| P5c | leader `list_channels` 返回成员频道 | ✅ |
| P7–P9 | 激活、派发、项目上下文、60min 预算、重复派发拒绝 | ✅ |
| P10–P12c | 办公室保护、唯一绑定、非 owner/无 grant 拒绝 | ✅ |
| P13a/P13b | 成员 lead token 轮换、完成任务 | ✅ |
| P15/P13c | Reconciler、root COMPLETED 自动 draft（真实 artifact） | ✅ |
| P13c2/P13d | channel lead `read_results` 见 draft；`project_submit_result` 提交 | ✅ |
| P13e/P14/P14b | review、验收审批、owner 批准 | ✅ |
| P13f/P14c | 成果/交付物 approved | ✅ |
| P16/P14d | decisions/events 审计 + trace；重复决策 409 | ✅ |
| P14e1/P14e2/P14e3 | leader 计划提案；同版本审批幂等；批准后 planVersion=1 + 交付物物化 | ✅ |
| P20a/P20b | channel lead 申请 write_intent（digest）；owner 批准 | ✅ |
| P14f | 项目完成门禁 + owner 批准 → completed | ✅ |
| P17 | 项目页完整 Playwright 交互矩阵 / 周报导出 | ⏸ BLOCKED |
| P18b | Live 全量 / G0–G6 / 回滚演练 | ⏸ BLOCKED |

### 3.3 Gate 状态

| Gate | 状态 | 说明 |
|---|---|---|
| G0 基线 | ✅ | typecheck/lint/单测通过 |
| G1 Schema/迁移 | ✅ | 新库/旧库/双 init/rebuild/索引均有测试 |
| G2 安全 P0 | ✅（本地） | P0 单测 + 安全负例；**Mimosa 独立扫描未完成，不宣称安全审计通过** |
| G3 Project 核心 + 派发 | ✅（已测范围） | 办公室/leader/生命周期/绑定/派发/上下文/预算/工具硬门/计划物化；scheduler-skip 直接断言未单独做 |
| G4 成果 + 审批 | ✅（已测范围） | 成果链/审批 CAS/过期/自批/plan_approval/write_intent/Reconciler/decisions/events |
| G5 API/UI | 🟡 | 项目列表/详情渲染、提案应用、成果/审批操作；完整 Playwright 矩阵未做 |
| G6 Live + 审计 + 回滚 | 🟡 PARTIAL | MAST 14/14 + 审计决策/事件；Live 全量/G0–G6/回滚演练未执行 |

---

## 4. 关键实现说明

### 4.1 计划提案与物化

- leader 只写 `project_decisions(state='proposed')` + `plan_approval`；owner 批准是唯一状态迁移入口。
- 批准时 `ProjectService.materializeApprovedPlan` 按 `deliverables[].name` 与 `work_items[].dedupeKey` 幂等创建，依赖二次回填；物化失败不推翻已赢的审批 CAS，写 `plan.apply_failed` 事件等待人工处理。
- **安全取舍**：批准计划只物化工作项，不自动派发 root task；派发仍是显式 owner 动作（避免批准计划即向真实产线自动下发任务）。`dispatch.proposed` 提案由 owner 在项目页点击“应用提案”后创建/派发。

### 4.2 write_intent

- `project_request_write_intent` 写 `project_approvals(kind='write_intent', subject_id=workItemId)`，payload 含 tool/args/attempt/digest。
- 执行器在 `dispatchHostToolInner` 对 `dcw_*`/`recipe_*`/`line_start`/`line_stop` 前复核：项目来源任务 + `mayWrite=false` 时必须匹配 approved/unconsumed/未过期且 tool/args/attempt 一致的审批，然后原子 `consume`。
- 三个失败码：`PROJECT_WRITE_INTENT_REQUIRED` / `PROJECT_WRITE_INTENT_MISMATCH` / `PROJECT_WRITE_INTENT_CONSUMED`。

### 4.3 执行层硬门

- `projects/execution-gate.ts` 在 `dispatchHostToolInner` 最前（scope 检查之后）执行，覆盖插件/工业/任务全部分发路径。
- leader 白名单只含项目工具；channel lead/worker 按矩阵拒绝 propose/submit/write_intent；项目外 Agent 调 project 工具 → `PROJECT_TOOL_DENIED`，并写 rejected decision + 事件。

---

## 5. 已知限制与风险

1. **计划批准不自动派发**（安全取舍）：物化后需 owner 显式派发；与 plan §2.2 “ProjectService 按批准 plan 派发”存在措辞差异，但保留 plan 授权覆盖（工作项 planVersion=批准版本）。
2. **审计 fail-closed 不完整**：decisions/events 已落库并带 trace，但成果/交付物状态更新与审计写入尚未统一到同一事务。
3. **line grant 未接入成果读取/审批**：结果行已有 `line_id` 快照，按用户 line grant 的过滤待补。
4. **UI 仅 smoke + 提案应用**：计划编辑/diff、周报导出、完整 Playwright 交互矩阵未做。
5. **M5 未做**：leader 自建/删除 Channel 未实现；独立安全扫描/红队待补。
6. **G6 未做**：完整 Live 矩阵、G0–G6 证据文件夹、回滚演练、两方签署。
7. **团队/共享频道**：V1 owner-only、一 Channel 一 active Project。
8. **V1.1/V2 项按计划推迟**：ProjectSchedulerLoop、Mandate、双 Ledger、progress ledger、effects/outbox、push 订阅。

---

## 6. 结论

**PR1–PR8 的已实现范围通过验收：单测 1065 pass / 0 fail + 生产业务 E2E 45/45 + UI smoke 6/6 + MAST 14/14，0 失败。**

**V1 全量未通过：P17（完整 Playwright/周报）与 P18b（Live 全量/G0–G6/回滚/签署）BLOCKED；line grant、审计事务化、M5、团队协作未接入。** 当前可宣称“项目办公室 / leader 提案 / 派发 / 成果 / 验收 / write_intent / 审计 / 项目页 / MAST”这一层已可工作，但不能宣称完整 V1 或“安全验收通过”。

独立安全审计（Mimosa）仍未完成，不能宣称“安全验收通过”。

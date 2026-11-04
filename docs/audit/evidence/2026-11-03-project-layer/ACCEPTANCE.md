# Project 层 V1 分阶段验收报告（PR1–PR6）

日期：2026-11-04。状态：**分阶段验收，未完成 V1 全量**。
被测分支：`pr/06-project-ui`（stacked on PR5）。
证据：`docs/audit/evidence/2026-11-03-project-layer/project-line-acceptance.json`、`projects-list.png`、`project-detail.png`。

---

## 1. 验收边界

### 已实现并验收

- P0 安全前置（PR1）：spawn/workspace 策略、MCP 管理/设备面拒绝 agent token、agent DTO 去凭证。
- 数据底座（PR2）：9 张项目表、tasks/channel_agents/audit_log 新列、迁移顺序、旧库 rebuild 保留列与索引。
- Project 核心（PR3）：项目办公室频道、`agent_kind='project_leader'`、生命周期、成员 Channel 绑定、办公室频道保护。
- 派发（PR4）：交付物/工作项、`submitProjectRoot`、项目上下文传播到子任务、项目预算、重复派发拒绝。
- 成果/审批/审计/Reconciler（PR5）：root COMPLETED 自动 draft、submit、review、owner acceptance、审批 CAS/过期/自批拒绝、decisions/events 审计、工作项终态对账。

### 未实现，明确 BLOCKED（不得算通过）

- 项目页 UI / 周报 / 审批历史。
- MAST L1–L14 / Live 全量 / G0–G6 证据。
- Project Leader 的 proposal tools/prompt 接入（当前 leader 尚未调用项目工具）。
- M5 leader 自建/删除 Channel；独立安全扫描/红队待补。

---

## 2. 验收标准与结果

运行：

```bash
npm run typecheck
npm run lint
npm run test:unit

AW_PROJECT_ACCEPTANCE_OUT=docs/audit/evidence/2026-11-03-project-layer/project-line-acceptance.json \
  node scripts/e2e-project-line-acceptance.mjs
```

### 2.1 本地门禁（逐 PR）

| PR | commit | typecheck | lint | 单测 | 远端 quick-gate |
|---|---|---|---|---|---|
| PR1 安全 | `a5c10a09` | ✅ | ✅ | 1023 pass / 0 fail | 已由 PR26 修复；main CI success |
| PR2 Schema | `e85ef7c1` | ✅ | ✅ | 1028 pass / 0 fail | 同上 |
| PR3 核心 | `f2caba9d`（rebase） | ✅ | ✅ | 1031 pass / 0 fail | ✅ success |
| PR4 派发 | `f76f0216`（rebase） | ✅ | ✅ | 1032 pass / 0 fail | ✅ success |

### 2.2 生产业务 E2E（真实产线对象）

结果：**35 PASS / 0 FAIL / 2 BLOCKED**。

| ID | 验收项 | 结果 | 证据 |
|---|---|---|---|
| P0 | 隔离实例启动，workshop ready | ✅ | 临时 `AW_HOME` + `/api/health` |
| P1 | admin 注册/登录 | ✅ | `/api/users/register` |
| P2 | 真实产线/模板/节点/产品/配方创建 | ✅ | DCW API |
| P2b | 产线业务面可见新线/节点/产品/配方 | ✅ | `/api/workshop/dcw` |
| P3 | 绑线 Channel 创建（lead=mock） | ✅ | `/channels` + `lineId` |
| P3b | Channel `lineId` 落库 | ✅ | `GET /channels/:id` |
| P4 | Project 创建（办公室 + leader 指针） | ✅ | `POST /projects` |
| P4b | 办公室 leader `agent_kind=project_leader` + chat 开启 | ✅ | `GET /channels/:officeId` |
| P5 | 用户绑定成员 Channel | ✅ | `POST /projects/:id/channels` |
| P5b | 交付物创建 | ✅ | `POST /projects/:id/deliverables` |
| P6 | 工作项创建（交付物必填） | ✅ | `POST /projects/:id/work-items` |
| P6b | 不存在的交付物 → 404 | ✅ | 负例 |
| P7 | Project 激活（Channel + 必选交付物） | ✅ | `POST /projects/:id/activate` |
| P8 | 工作项派发 root task | ✅ | `POST /projects/:id/work-items/:wid/dispatch` |
| P8b | root task 带 project/source/attempt/trace | ✅ | `GET /channels/:cid/tasks` |
| P8c | 60min 项目预算未被 900s 覆盖 | ✅ | deadline 剩余 >30min |
| P9 | 重复派发 → `WORK_ITEM_IN_FLIGHT` | ✅ | 409 |
| P10 | active 办公室删除 → 409 | ✅ | `PROJECT_OFFICE_PROTECTED` |
| P10b | active 办公室禁用 → 409 | ✅ | `PROJECT_OFFICE_PROTECTED` |
| P11 | 同一 Channel 不能属于两个 active Project | ✅ | `CHANNEL_ALREADY_BOUND` |
| P12 | 非 owner 读取 Project → 403 | ✅ | 第二用户 |
| P12b | 非 owner 绑定 Channel → 403 | ✅ | 第二用户 |
| P12c | 无产线 grant 用户创建绑线 Channel → 403 | ✅ | 第二用户 |
| P13a | 成员 lead token 轮换（完成任务用） | ✅ | `/rotate-token` |
| P13b | 成员 lead 完成任务 | ✅ | `/tasks/:id/complete`（agent token） |
| P15 | Reconciler：root COMPLETED → 工作项 COMPLETED | ✅ | `/projects/:id/reconcile` |
| P13c | root COMPLETED 自动生成成果 draft（真实 artifact 证据） | ✅ | `GET /projects/:id/results` |
| P13d | 成果 submit（owner） | ✅ | `/results/:rid/submit` |
| P13e | 成果 review（owner/leader） | ✅ | `/results/:rid/review` |
| P14 | 成果验收审批 pending | ✅ | `/results/:rid/request-acceptance` |
| P14b | owner 批准成果验收 | ✅ | `/approvals/:aid/decide` |
| P13f | 成果 approved | ✅ | results |
| P14c | 交付物 approved | ✅ | deliverables |
| P14d | 审批重复决策 → 409 | ✅ | 负例 |
| P16 | 审计 decisions/events 落库且带 trace | ✅ | decisions/events |
| P17 | 项目页 UI/周报 | ✅（页面渲染/数据绑定） | UI smoke 5/5 + `projects-list.png` / `project-detail.png`；完整 Playwright 交互矩阵待 PR7 |
| P18 | MAST/Live/G0–G6 | ⏸ BLOCKED | PR7 未执行 |

### 2.3 Gate 状态

| Gate | 状态 | 说明 |
|---|---|---|
| G0 基线 | ✅ | typecheck/lint/单测通过；main CI success |
| G1 Schema/迁移 | ✅ | 新库/旧库/双 init/rebuild/索引均有测试 |
| G2 安全 P0 | ✅（本地） | P0 单测 + 安全负例；**Mimosa 独立扫描未完成，不宣称安全审计通过** |
| G3 Project 核心 + 派发 | ✅（已测范围） | 办公室/leader/生命周期/绑定/派发/上下文/预算；**scheduler-skip 直接断言未单独做** |
| G4 成果 + 审批 | ✅（已测范围） | 成果 draft/submit/review/approve、审批 CAS/过期/自批、Reconciler、decisions/events；**plan_approval/write_intent 未接入** |
| G5 API/UI | ✅（已测范围） | 项目列表/详情渲染、数据绑定、成果/审批操作；完整 Playwright 交互矩阵待 PR7 |
| G6 Live + 审计 + 回滚 | ⏸ BLOCKED | PR7 |

---

## 3. 已知限制与风险

1. **plan_approval / write_intent 未接入**：当前只实现 deliverable_acceptance 的审批闭环；计划审批与工业写意图审批仍待 PR5.1/PR6。
2. **Reconciler 不是自主定时器**：当前通过 `/projects/:id/reconcile` 触发；插件级 30s 定时器未接，频道禁用/lead 移除的自动对账仍不完整。
3. **审计 fail-closed 不完整**：decisions/events 已落库并带 trace，但成果/交付物状态更新与审计写入尚未统一到同一事务；破坏性动作回滚测试待补。
4. **UI 仅 smoke 级**：项目列表/详情渲染与数据绑定已验；计划编辑/diff、周报导出、完整 Playwright 交互矩阵未做。
5. **Project Leader 未真正参与**：V1 的 proposal tools / prompt / 复核尚未实现；当前 leader 只是办公室 lead，未接项目提案。
6. **Scheduler-skip 直接验证缺失**：代码已对 `agent_kind='project_leader'` 跳过 SchedulerLoop，但 E2E 未直接断言 `cr.scheduler===null`。
7. **M5 未做**：leader 自建/删除 Channel 未实现；独立安全扫描/红队待补。
8. **多用户/共享频道**：V1 owner-only、一 Channel 一 active Project，未覆盖团队协作与共享频道。

---

## 4. 下一步验收（PR6–PR7）

PR5 已完成项见 2.2；剩余：

PR6 完成后必须新增：

- 项目页 5 个 tab 的 Playwright 行为断言（不是截图）。
- 计划编辑/diff/评论/批准、成果证据包、审批 inbox。
- 周报数字与 DB 一致。

PR7 完成后：

- G0–G6 全量证据、回滚演练、Live 薄版/完整版、两方签署。
- MAST L1–L14 从"设计表"变为可执行回归。

---

## 5. 结论

**PR1–PR6 的已实现范围通过验收：生产业务 E2E 35/35 + UI smoke 5/5，0 失败。**
**V1 全量未通过：仅 P18（MAST/Live 全量/G0–G6）BLOCKED；另有 Project Leader proposal tools、plan_approval/write_intent、自主 Reconciler 定时器未接入。** 当前可宣称"项目办公室/派发/成果/验收/审计/项目页"这一层已可工作，但不能宣称完整 V1 或"安全验收通过"。

独立安全审计（Mimosa）仍未完成，不能宣称"安全验收通过"。

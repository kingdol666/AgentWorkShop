# Project 层 V1 分阶段验收报告（PR1–PR4）

日期：2026-11-03。状态：**分阶段验收，未完成 V1 全量**。
被测分支：`pr/04-project-dispatch`（已 rebase 到 `main` + PR26 修复）。
证据：`docs/audit/evidence/2026-11-03-project-layer/project-line-acceptance.json`。

---

## 1. 验收边界

### 已实现并验收

- P0 安全前置（PR1）：spawn/workspace 策略、MCP 管理/设备面拒绝 agent token、agent DTO 去凭证。
- 数据底座（PR2）：9 张项目表、tasks/channel_agents/audit_log 新列、迁移顺序、旧库 rebuild 保留列与索引。
- Project 核心（PR3）：项目办公室频道、`agent_kind='project_leader'`、生命周期、成员 Channel 绑定、办公室频道保护。
- 派发（PR4）：交付物/工作项、`submitProjectRoot`、项目上下文传播到子任务、项目预算、重复派发拒绝。

### 未实现，明确 BLOCKED（不得算通过）

- 成果自动 draft / submit / review / approve。
- `project_approvals`（plan/acceptance/complete/write_intent）。
- `ProjectReconciler`（root 终态同步/逾期/阻塞）。
- 审计 fail-closed（decisions/events 同事务）。
- 项目页 UI / 周报 / 审批历史。
- MAST L1–L14 / Live 全量 / G0–G6 证据。

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

结果：**23 PASS / 0 FAIL / 6 BLOCKED**。

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
| P13 | 成果 draft/submit/review/approve | ⏸ BLOCKED | PR5 未实现 |
| P14 | project_approvals | ⏸ BLOCKED | PR5 未实现 |
| P15 | ProjectReconciler | ⏸ BLOCKED | PR5 未实现 |
| P16 | 审计 fail-closed | ⏸ BLOCKED | PR5 未实现 |
| P17 | 项目页 UI/周报 | ⏸ BLOCKED | PR6 未实现 |
| P18 | MAST/Live/G0–G6 | ⏸ BLOCKED | PR7 未执行 |

### 2.3 Gate 状态

| Gate | 状态 | 说明 |
|---|---|---|
| G0 基线 | ✅ | typecheck/lint/单测通过；main CI success |
| G1 Schema/迁移 | ✅ | 新库/旧库/双 init/rebuild/索引均有测试 |
| G2 安全 P0 | ✅（本地） | P0 单测 + 安全负例；**Mimosa 独立扫描未完成，不宣称安全审计通过** |
| G3 Project 核心 + 派发 | ✅（已测范围） | 办公室/leader/生命周期/绑定/派发/上下文/预算；**scheduler-skip 直接断言未单独做** |
| G4 成果 + 审批 | ⏸ BLOCKED | PR5 |
| G5 API/UI | ⏸ BLOCKED | PR6 |
| G6 Live + 审计 + 回滚 | ⏸ BLOCKED | PR7 |

---

## 3. 已知限制与风险

1. **成果/审批未实现**：当前项目只能"建、绑、派发"，不能完成"成果提交→复核→owner 验收"闭环。
2. **Reconciler 未实现**：Channel root task 终态不会自动同步到工作项；工作项会停留 `DISPATCHED`。
3. **审计未闭环**：`project_decisions`/`project_events` repo 已有，但服务层未写入；破坏性动作尚未 fail-closed 审计。
4. **UI 未实现**：项目页/周报/审批历史不可用。
5. **Project Leader 未真正参与**：V1 的 proposal tools / prompt / 复核尚未实现；当前 leader 只是办公室 lead，未接项目提案。
6. **Scheduler-skip 直接验证缺失**：代码已对 `agent_kind='project_leader'` 跳过 SchedulerLoop，但 E2E 未直接断言 `cr.scheduler===null`。
7. **M5 未做**：leader 自建/删除 Channel 未实现；独立安全扫描/红队待补。
8. **多用户/共享频道**：V1 owner-only、一 Channel 一 active Project，未覆盖团队协作与共享频道。

---

## 4. 下一步验收（PR5–PR7）

PR5 完成后必须新增：

- 成果自动 draft → submit → review → owner approve 的 E2E（含证据/版本/越权负例）。
- 审批 CAS/过期/一次性消费/跨项目隔离。
- Reconciler：root 终态同步、逾期、频道禁用、lead 移除。
- 审计 fail-closed：破坏性动作回滚。
- MAST L1–L14：Given/When/Then + 正向控制。

PR6 完成后必须新增：

- 项目页 5 个 tab 的 Playwright 行为断言（不是截图）。
- 计划编辑/diff/评论/批准、成果证据包、审批 inbox。
- 周报数字与 DB 一致。

PR7 完成后：

- G0–G6 全量证据、回滚演练、Live 薄版/完整版、四/两方签署。

---

## 5. 结论

**PR1–PR4 的已实现范围通过验收：23/23 生产业务 E2E 通过，0 失败。**
**V1 全量未通过：6 项 BLOCKED。** 当前不能对外宣称"Project 层功能完成"，只能宣称"项目办公室/生命周期/派发/项目上下文与预算"这一层已可工作。

独立安全审计（Mimosa）仍未完成，不能宣称"安全验收通过"。

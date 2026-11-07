# Project 业务逻辑复核与项目组/派发/继续对话实机验收（2026-11-06）

> 范围：`feat/project-continue-20261106`（uncommitted 工作区）
> 对象：Project 业务层（create / update / members / bindings / deliverables / work items / dispatch / plan gate / L1/L2 / continueProject）
> 实机项目：`a1955fd9-e3ff-45fa-919d-a4fa1b61a576`「值班手册 · 连续验收 kp12h+业务复核」
> 结论：**业务逻辑成立且真实可执行；发现并修复 3 个业务缺口 + 3 个契约/语义加固（reviewer P2 已收口）；仍有运行时/证据打包风险。**

## 0. 结论

| 维度 | 判定 |
|---|---|
| 项目创建/项目组结构 | **PASS**：项目创建时原子创建办公室 Channel + `project_leader`；Channel 绑定、成员角色、项目修改均可用 |
| 项目修改 | **PASS**：name/description/mode/autoDispatch 持久化 + `project.updated`；成员 viewer↔approver；临时 Channel 绑定/解绑；非法 role/办公室绑定/终态写操作均被拒 |
| 任务分发 | **PASS**：plan v3 批准后 `plan.applied` 1+1，`work.dispatch_auto` 派发到生产 Channel；work item/attempt/task 绑定一致 |
| 继续对话推进 | **PASS**：completed→active、同一 Leader、plan v3、新交付物、自动派发、L1/L2、再次 completed；同一 Project 未新建 |
| 代码质量 | **PASS_WITH_NOTES**：service 仍是 3900+ 行大模块；`addMember` 不校验 user 存在；`unbindChannel` 只按 work item 状态防悬空 |
| 运行时/证据 | **CONDITIONAL**：omp 长回合/看门狗仍会拖慢；Channel 的 `complete_task.deliverable` 可能是路径+摘要包装，导致 artifact sha 与 workspace 原文件不一致 |

## 1. 代码设计与真实生效链路

### 1.1 创建与项目组

`ProjectService.create()`：

- 校验 name/objective；
- 创建 `projects` 行（默认 draft、planApprovalRequired、autoDispatch、routingPolicy）；
- `manager.createChannel()` 创建 `«项目名 · 项目办公室»`，lead agent `agent_kind=project_leader`；
- 开启办公室 `chatEnabled=1`；
- 回填 `officeChannelId/leadAgentId`；
- 失败时置 archived，避免半成品。

项目组由三部分组成：

1. `project_members`：viewer / approver（本轮已加白名单）；
2. `project_channels`：生产/评审 Channel，需已有 lead 且属于 owner；
3. 办公室 + Project Leader：唯一，不允许作为普通成员 Channel。

实测：

- `a1955` 在 14:07 由 `POST /api/workshop/projects` 创建（真实 omp Leader；见 `../2026-11-06-project-continue/runbook-project-setup.json`）；
- 生产 Channel `2a12401e…` + 评审 Channel `7cf7c595…` 均 active 绑定；
- 成员 `b0c13b67…` 先 viewer 后 approver，随后移除；
- 额外 mock Channel `8860e67c…` 绑定→解绑成功；
- 办公室 Channel 绑定 → `400 PROJECT_OFFICE_NOT_MEMBER`。

### 1.2 修改

`updateProject()` 支持 name/description/objective/mode/autoDispatch/routeGate/reviewerChannelId，均 owner-only 且写 `project.updated`。

本轮实测（`project-modify-live.json`）：

| 操作 | 结果 |
|---|---|
| PATCH name/description + mode auto + autoDispatch=false | 200；GET 显示 `mode=auto, autoDispatch=false` |
| PATCH mode supervised + autoDispatch=true | 200；GET 显示 `mode=supervised, autoDispatch=true` |
| POST member role=viewer → role=approver | 200；列表显示 approver |
| POST member role=owner（非法） | 400 `BAD_REQUEST`（本轮修复） |
| DELETE member | 200；members=[] |
| 绑定临时 Channel → 解绑 | 200 / 200 |
| 绑定办公室 Channel | 400 `PROJECT_OFFICE_NOT_MEMBER` |
| completed 项目新增工作项 | 409 `PROJECT_STATE_INVALID` |
| completed 项目 PATCH 交付物 | 409（live 证据为 `DELIVERABLE_STATE_INVALID`；当前代码先命中 project-status guard，返回 `PROJECT_STATE_INVALID`） |
| completed 项目 dispatch | 409 `PROJECT_NOT_ACTIVE` |
| reviewerChannelId 设值→空串清除 | 配置键正确删除（本轮显式语义加固；`reviewer-clear-live.json`） |

### 1.3 计划/派发/验收

- `requestPlanApproval` / `agentRequestPlan` → `plan_approvals`；
- owner 批准 → `planVersion`、`plan_versions` approved、`materializeApprovedPlan`：deliverables 按 name 幂等、work items 按 dedupeKey 幂等、依赖回填；
- `dispatchWorkItemAs`：active + plan 门 + live attempt 唯一 + planVersion 对齐 + readiness（technical：上游 reviewed/approved）+ attempt CAS；
- 手动派发 `work.dispatched`、自动派发 `work.dispatch_auto`；
- 任务完成 → `reconcileInternal` → 工作项 COMPLETED + result draft；
- technical L1：`ensureTechnicalReviewRequests` → 独立评审 Channel → `project_technical_reviews`；
- L2：owner/approver 签核；项目完成门要求必选交付物 approved + 工作项终态。

### 1.4 继续对话

`continueProject`：

- owner-only；archived 拒绝、draft 要求先激活；
- completed/paused → active；
- 需求作为办公室群聊发给同一 `leadAgentId`；
- **检查 lead delivery**（非 delivered/consumed → 回滚并报错）；
- 写 `project.followup_requested` / `project.reopened`；
- Leader 的 `project_propose_replan` 只追加，不改已验收交付物；
- owner 批准 → 物化增量 → autoDispatch → L1/L2 → completed。

## 2. 本轮实机链路（v3）

| 时间 | 事件 |
|---|---|
| 16:40 | 项目修改：name/description/mode/autoDispatch；成员 viewer→approver；临时 Channel 绑定/解绑；终态写操作被拒 |
| 16:44 | `POST /continue`（第 3 次）：completed→active，需求投递给同一 Leader `5259f4ce…` |
| 16:56 | Leader 真实提交 plan v3 `271f47fb…`：新增 `5 分钟演练清单` + `followup-runbook-drill-kp12h`，旧 v1/FAQ 保留，含结构化 criteria |
| 17:05 | owner 批准 plan v3；`plan.applied` 1+1；`work.dispatch_auto` 派发 task `01051ec5…` 到同一生产 Channel |
| 17:36 | 生产 Channel 完成 `oncall-drill.md` 5,259B / CJK 1,342；result `7d64eeca…` |
| 18:03 | 独立评审 Channel L1 pass `0cc6efe7…` `channel_lead`（演练 16/5 分钟 5/回滚 16/交接 8 次） |
| 18:06 | 独立 approver L2 `6909dcf3…`；owner 批准 project_complete `625330d9…`；**completed，plan v3** |

最终：3/3 交付物 approved、3/3 工作项 COMPLETED、3/3 成果 approved、3 条 L1 记录。

## 3. 本轮发现与修复

| # | 问题 | 级别 | 处理 |
|---|---|---|---|
| 1 | `addMember` 接收任意 role（`owner` 等），只按字符串写库 | P2 | 增加 `viewer/approver` 白名单 + 单测 |
| 2 | `unbindChannel` 可将仍有未终态工作项的 Channel 解绑，工作项悬空 | P2 | 拒绝 `CHANNEL_HAS_ACTIVE_WORK`；取消后才可解绑；写 `channel.detached` 审计；单测 |
| 3 | `updateProject({reviewerChannelId:''})` 的清除语义依赖 `JSON.stringify` 丢弃 undefined；行为已有但隐式 | P3（语义加固） | 改为显式 `delete` 配置键；单测 + 实机 set/clear；**不声称这是行为缺陷** |
| 4 | `complete_task.deliverable` 可能只放路径+摘要，导致证据 artifact 与 workspace 原文件 sha 不一致 | P2（运行时契约） | `project-member.md` 明确要求 deliverable 必须是文件全文；本轮 drill artifact 为 5,384B 包装（sha 4a4108…），原文件 5,259B（sha **3941f61b04a75101766c2af4742321e9cb3c529deef5e0f67227dfe8b578e70d**）；L1 实际读取原文件 5,259B 通过；payload 的 raw bytes/hash 需按 raw 文件校正，已列为运行时/证据打包问题 |
| 5 | 计划可省略结构化 acceptanceCriteria（v1 曾发生） | P2（计划质量） | 已在 Leader schema/规则中强制要求 criteria 数组 |
| 6 | `continueProject` 只捕获 throw，忽略 deliveries[].status=failed | P2 | 已改为检查 lead delivery 并回滚（前一轮修复，本轮保留测试） |
| 7 | `decideApproval(project_complete)` 决策时未重跑完成门；审批后新增/驳回交付物可绕过 | P2 | 决策时重跑 `assertCompletionGates`；新增“审批后新增必选交付物→拒绝完成”单测 |
| 8 | 重复 `addMember` 未传 role 会把 approver 静默降级为 viewer | P2 | 未传 role 保持原角色；单测覆盖 |

## 4. 代码级风险（未阻塞本轮）

1. `addMember` 未校验 userId 是否真实存在；可写入不存在成员（owner 操作，影响展示/审计，不构成越权）。
2. `updateProject` 改名不会同步项目办公室 Channel 名称（名称仍是旧项目名），属于展示一致性。
3. `materializeApprovedPlan` 对已存在的 dedupeKey 工作项只跳过，不更新 brief/criteria；修改既有工作项需新 dedupeKey，符合当前幂等策略但需在 UI/文档中明确。
4. `unbindChannel` 只检查 work item 状态，不检查独立 root task（理论上项目 root 总挂 work item）。
5. `continueProject` 仅 owner；approver 不能发起继续开发（设计如此，但 UI 需要对 approver 隐藏/禁用）。
6. `ProjectService` 3900+ 行，计划/派发/验收/消息/观测耦合；建议按 `plan/execute/accept/message` 拆模块。
7. 长回合 harness：Leader v3 约 12 分钟、生产/评审出现 watchdog 重启；需要 turn-level watchdog/预热与 artifact 自动收集。
8. 项目级 SSE 仍未实现，项目页 5s 轮询。

## 5. 验收矩阵

| # | 验收点 | 结果 |
|---|---|---|
| B1 | 项目创建 → draft/office/leader/autoDispatch/routingPolicy | PASS（14:07 实机，见 runbook setup） |
| B2 | 项目组 Channel 绑定/解绑/办公室拒绝 | PASS |
| B3 | 成员 viewer/approver/非法 role/移除 | PASS |
| B4 | PATCH 项目字段 + 审计 | PASS |
| B5 | completed 终态写操作拒绝 | PASS |
| B6 | Leader plan v3 + owner 批准 + 物化 1+1 | PASS |
| B7 | 自动派发 + work item/attempt/task 绑定 | PASS |
| B8 | 生产 Channel 真实交付（5,259B） | PASS（artifact 包装问题见 §3#4） |
| B9 | 独立 L1 channel_lead pass | PASS |
| B10 | 独立 L2 approver + owner 完成 | PASS |
| B11 | 同一项目第 3 次继续对话，不新建项目 | PASS |
| B12 | UI 修改后名称/plan v3/6 条对话/无 pageerror/移动端无溢出 | PASS |
| B13 | typecheck/lint/i18n/unit/build | PASS（最终门禁见 §6） |

## 6. 最终门禁

- ESLint（改动文件）✅
- `npm run typecheck` ✅
- `npm run i18n:check` 3255/3255 PARITY OK
- `npm run test:unit` **1146 tests / 1144 pass / 0 fail / 2 skipped**（role/unbind/completion 新增测试后）
- `npm run build` ✅

## 7. 证据

- `project-business-acceptance.json`：项目/交付物/工作项/成果/L1/审批/项目消息/事件/对话
- `project-modify-live.json`：项目修改、成员、绑定、终态拒绝
- `member-remove-dispatch-edge.json`：成员移除、completed dispatch 409
- `member-role-live.json`：viewer→approver→未传 role 保持 approver→移除
- `reviewer-clear-live.json`：reviewerChannelId set/clear
- `plan-v3-approval.json`、`drill-result-submit.json`、`drill-l2-complete.json`
- `oncall-drill.md`：5,259B 实际交付文件；`oncall-drill.raw.json` 记录 raw sha256 `3941f61b…` 与 wrapper artifact 差异
- `ui-acceptance.json` + `project-business-final-desktop/mobile.png`
- 上一轮项目创建/新项目 v1/v2 证据：`../2026-11-06-project-continue/`

## 8. Reviewer 复核

首轮独立 reviewer **REJECTED**，提出 2 个真实 P2：
- 重复 `addMember` 未传 role 会把 approver 降级；
- `decideApproval(project_complete)` 决策时未重跑完成门。

已修复并补测（`member-role-live.json`、`project_complete 决策时重跑完成门` 单测）。另修正报告中对 `reviewerChannelId` 的“缺陷”误称，并补齐 drill raw sha `3941f61b…`。复核 agent 再检后 **APPROVED，remaining=[]**。剩余 P3（runtime criteria 未强制、失败投递消息不回滚、userId 未校验、SSE 未实现）保留为后续项。

## 9. 最终判定

**Project 业务逻辑：PASS_WITH_NOTES。** 项目组创建/修改、成员/Channel、计划物化、任务分发、L1/L2、同一项目继续对话均真实生效；本轮修复了成员角色白名单、Channel 解绑悬空、完成审批决策门三个业务缺口；reviewerChannelId 为显式语义加固，不是行为缺陷。剩余风险主要是 harness 长回合、artifact 打包契约和 ProjectService 体量，不影响当前业务闭环成立。

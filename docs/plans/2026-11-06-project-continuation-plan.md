# Project 持续对话开发计划（2026-11-06）

> 状态：**已实施**（分支 `feat/project-continue-20261106`）
> 上游：`2026-11-05-project-router-v3-plan.md`（P0–P3）、`2026-11-05-project-route-dispatch-plan.md`
> 目标：让 owner 能在**同一个 Project** 内补充需求 / 反馈 bug，由**同一个 Project Leader**
> 读取现状、提出增量计划，owner 批准后继续派发、执行、L1/L2 验收，而不是只能新建项目。

## 0. 结论先行

Router v3 的“Leader 提案 → 确定性执行器派发 → Channel 执行 → 三级验收”链路已经成立；
但项目完成后的**继续开发**存在三个断点：

| 断点 | 代码证据 | 后果 |
|---|---|---|
| completed 项目不能新增交付物/工作项 | `service.createDeliverable/createWorkItem` 对 `completed` 直接 409 | 只能新建项目 |
| Leader 不能对 completed 项目 replan | `assertLeaderProjectMutable` 对 completed/archived 抛 409 | 同一 Leader 无法接手后续增量 |
| 项目页没有项目内对话入口 | `app/pages/projects/[id].vue` 只有 `/workshop` 外链 | 人类无法把 bug/新需求直接交给该 Leader |

本计划把这三处补成闭环，同时保留治理边界：**重开不是绕过审批**，增量仍要 plan 审批、
派发、L1 技术验收、L2 业务签核与 owner 完成门。

## 1. 设计

### 1.1 一条入口：POST /projects/:id/continue

```
owner 在项目页输入补充需求
  → continueProject(owner-only)
      ├─ 校验：archived 拒绝；draft 先激活；office/leader 必须存在
      ├─ completed/paused → active（记录 project.reopened）
      ├─ 把需求作为群聊消息发到项目办公室，服务端打上 @ProjectLeader
      │    （复用既有 chat_messages / delivery 台账 / mailbox 唤醒，不新造通信层）
      └─ 记录 project.followup_requested（消息 id / 是否重开 / 摘要）
  → Leader 收到群聊回合，先读 project_get_status/read_*
  → Leader 调 project_propose_replan（增量交付物 + 新 dedupeKey 工作项）
  → owner 在审批页批准 plan vN+1
  → materializeApprovedPlan 追加交付物/工作项
  → runRouteLoop/autoDispatch 按依赖继续派发
  → 新成果走 L1/L2；项目再次满足完成门后 owner 批准 completed
```

### 1.2 边界（不做）

- 不删除、不改写已验收交付物；增量只追加。
- 不允许 archived 项目“复活”；draft 必须先激活。
- 不允许 Leader 自行改项目状态/自批/自动完成；重开后仍走审批。
- 不新建第二套聊天/消息系统；项目对话复用项目办公室 Channel 的群聊事实层。
- 不绕过 plan_version/dedupeKey 幂等；同一增量计划重复批准不会重复物化。

### 1.3 前端

项目详情页「概览」新增 **Project Leader 对话** 卡片：

- 读取项目办公室最近 100 条群聊，5s 轮询增量；
- 用户消息右侧、Leader/Agent 消息左侧，保留时间与发送者；
- `completed` 时提示“发送补充需求会自动重开项目”，`paused` 提示会恢复 active；
- Ctrl/⌘+Enter 发送；发送后展示重开/投递结果；
- 顶部“继续开发 / 补充需求”按钮跳到对话并聚焦输入框；
- 不改变既有五 tab 与执行工作台。

## 2. 改动面

| 文件 | 改动 |
|---|---|
| `server/services/workshop/projects/service.ts` | 新增 `ProjectContinuationResult` + `continueProject`（owner-only；重开；办公室群聊；审计） |
| `server/api/workshop/projects/[id]/continue.post.ts` | 新增 `POST /projects/:id/continue`（message/clientMessageId） |
| `server/services/workshop/projects/event-ingress.ts` | `project.reopened` 进入 fast path（重开后立即收敛） |
| `.AgentWorkShop/prompts/project-leader.md` | 新增“持续开发”规则：只追加增量、全新 dedupeKey、修复四段式交付 |
| `app/pages/projects/[id].vue` | Leader 对话卡片、重开提示、发送/轮询/聚焦、审计可见 |
| `tests/project-continue.test.ts` | 重开 + 对话 + replan 物化 + 状态/权限边界 |

## 3. 验收标准（C1–C10）

| # | 标准 | 验证 |
|---|---|---|
| C1 | completed 项目 owner 发送补充需求 → status=active，旧交付物/成果不变 | 单测 + API |
| C2 | 补充需求作为项目办公室群聊投递给**同一个** `leadAgentId`，带服务端 `@Leader` | 单测 + 实机 |
| C3 | 审计出现 `project.followup_requested` / `project.reopened`，含 messageId 与摘要 | 单测 + 项目事件页 |
| C4 | Leader 重开后能提出 plan vN+1；owner 批准后物化新增交付物/工作项 | 单测 + 实机 |
| C5 | 增量计划使用新 `dedupeKey`，重复批准不重复物化 | 单测/幂等 |
| C6 | 新工作项按既有 plan/deps/autoDispatch 路径派发，不走旁路 | 集成/实机事件 |
| C7 | 新成果仍走 L1 技术验收 + L2 业务签核，项目完成仍 owner 批准 | 实机 |
| C8 | archived 拒绝、draft 拒绝、非 owner 拒绝 | 单测 |
| C9 | 项目页可读/可发/可轮询；completed 有明确重开提示；无 pageerror | Puppeteer + 截图 |
| C10 | typecheck/lint/unit/build 全绿；既有 Project 测试不回归 | 门禁 |

## 4. 实机验收场景：星际撤离 ARK-7 继续作业

基线项目：`58576fb2-4642-4b65-b636-54c9eb8fa41a`（completed，3 交付物/3 工作项，21,649B 游戏）。
继续开发需求（owner → 同一 Leader）：

1. 移动端/触屏不可操作（无 touch 控制，390×844 下画布仅 219px 高）；
2. 失焦后按键卡住（blur 未清空键盘状态）；
3. 高 DPI 下画面模糊（固定 1280×720 画布未按 devicePixelRatio 缩放）；
4. 生产环境暴露 `window.__game` 调试 API；
5. 回归要求：桌面键盘/鼠标、3 关、计分、暂停/重开、GAME OVER 全部保留，0 pageerror。

验收：新 HTML 工件 ≥8KB；含 `touchstart` / `blur` / `visibilitychange` / `devicePixelRatio` / `<canvas`；
浏览器实测桌面 + 390×844 触屏可操作；项目重新 completed；L1/L2 记录可查。

## 5. 执行顺序

1. 后端 `continueProject` + API + 单测；
2. 项目页对话 UI + typecheck/lint；
3. 全量单测/build；
4. 启动隔离实例（旧游戏 home），用项目页发送补充需求；
5. Leader replan → owner 批准 → 自动派发 → L1/L2 → completed；
6. 浏览器回归新游戏 + 截图/报告。

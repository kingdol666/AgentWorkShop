# Project 任务级多会话适配计划（plan 2026-11-07）

> 状态：**草案 v1 — 含 3 个待用户确认的设计分歧点**
> 前置：Channel 多会话 S1 已落地（PR #65/#66/#67/#68 已合 main：channel_sessions 表+克隆编排器+会话管理视图+认证韧性修复）

---

## 1. 现状核验（代码证据，2026-11-07 @ 93ec2579）

### 1.1 Project 执行拓扑（现状）

```
Project(office_channel + project_leader)
  ├─ bindChannel：绑定既有执行 Channel（唯一索引：一个 Channel 只能 active 绑定一个 Project）
  ├─ plan approval → materializeApprovedPlan → workItems（创建时指定 target channelId）
  ├─ kernel tick(10s) → runRouteLoop → doAutoDispatch（容量闸 perChannel=1/perProject=4/perTick=2）
  │     └─ dispatchWorkItemAs → attempt(no) → submitProjectRoot(channelId, assigneeId=base lead)
  ├─ channel lead 分解子任务 → workers 执行 → root COMPLETED → ensureDraftFromTask → project_results
  └─ L1 技术评审（评审频道）→ L2 业务签核 → deliverable approved
```

### 1.2 关键事实

| # | 事实 | 证据 |
|---|------|------|
| 1 | workItem **创建时指定 channelId**，派发硬编码 `assigneeId=base lead` | tasks.ts L143-208 |
| 2 | attempt 表 `channel_task_id` 唯一索引 → attempt↔channel 任务一一对应 | schema.ts L1412-1437 |
| 隔离载体 | channel_sessions 已有完整 S1 基建（克隆=独立 runtime/mailbox/omp 进程/记忆域） | session-clone.ts |
| 3 | **channel_sessions 与 project 管线零接触**：tasks 表无 session_id 列；dispatchWorkItemAs 不感知 session；session clone 任务路由仅人工 assignee | 全仓 grep |
| 4 | clone 统一降为 worker → project root task 无法 assign 给 clone（root 需要 lead 语义） | session-clone.ts L80-84 |
| 5 | perChannel=1 容量闸按 Channel 计数 → 共享 Channel 上多 session 并行会被闸死 | service.ts L1288 |
| 6 | observability/前端 project 页无 session 维度 | service.ts L2313-2331, [id].vue |
| 7 | blueprint 实例化是「程序化建 Channel」的现成先例 | service.ts L2105-2117 |
| 8 | 办公室 leader 已被 baseMembersOf 排除，session 克隆不会污染项目办公室 | session-clone.ts L46-53 |

---

## 2. 与主流 harness 管理架构对照

| 主流概念（Claude Code / Codex 式） | AgentWorkShop 对应 | 现状 |
|---|---|---|
| 任务 = 隔离的执行上下文（独立历史/进程/工作区） | **session = 克隆实例组**（独立 runtime/mailbox/omp/记忆域） | ✅ S1 已实现 |
| 模板与实例分离（template → spawn） | **Channel = 模板**（成员装配/绑定面），**session = 实例** | ✅ S1 已实现 |
| 会话生命周期随任务（done → archived） | session close（在飞任务 cancelTree + 实例停用） | ✅ S1 已实现 |
| 会话域记忆/历史 | clone 记忆按 agentId 归属；会话消息流 | ✅ S1 已实现 |
| **任务→会话自动绑定**（spawn-on-task） | project workItem → session | ❌ **本 plan 要做的** |
| 任务上下文注入（task brief → 会话首条消息） | attempt 派发消息带 brief | 部分具备 |
| 会话结果回填任务 | attempt→channel_task_id→results | 部分成果链已具备 |

**结论**：S1 已补齐「Channel=模板、session=隔离执行上下文」的主流通用架构；缺的是 **Project 域的 spawn-on-task 自动化与治理打通**。

---

## 3. 三个设计分歧点（待确认）

### D1 隔离载体（最关键）

- **B 案（推荐）**：共享 Channel + **每任务一 session**。任务=克隆实例组（每 clone 独立 runtime/mailbox/omp 进程——这就是"任务特有的实例 runtime 对象"）；Channel 保持项目绑定的共享执行场。改动面：`submitProjectRoot` 增 sessionId 入参 + perChannel 容量闸改按 session 计数 + observability/前端 lane 加 session 维度。复用 S1 全部基建，风险最小。
- **C 案**：每任务 spawn 专属 Channel 宅实例（blueprint 先例）。隔离最强（runtime+文件系统级），但每任务 ≥1 个 lead 进程槽位+独立 workspace 目录+独立 agentIndex/bus；dispatcher 需两阶段派发（建 Channel→等 lead 装配→claim）；Channel 数量线性爆炸，observability 需重构聚合。适合大任务长生命周期场景，不适合高频小任务。
- **B+C 混合**：默认 B，长任务/重隔离需求任务可选 C（任务创建表单加开关）。

### D2 任务→会话的生命周期绑定

- **自动绑定**（推荐）：workItem 派发时若无 live session → 自动 `createChannelSession(channelId, title='任务: <title>')`；**attempt 闭合/任务终态后自动 close**（audit 保留：channel_sessions.status=closed + member_map_json 留档，克隆实例已停用，可追溯）。
- 手动绑定：任务创建表单可选既有 active session；派发时不自动建/关。
- 混合：默认自动 + 表单可选。

### D3 root 任务在 session 内的 assignee 语义

root 任务（attempt 载体）需要 assignee。当前 clone 统一 worker 定位 → root 无法 assign 给 clone。三选一：
- **a) 会话内 lead-clone**（推荐）：session 克隆时保留一个 lead 身份克隆（base lead→lead-clone，base workers→worker-clone），root assign 给 lead-clone，lead-clone 按 brief 分解子任务给 worker-clone；会话内闭环执行。
- b) root 仍 assign base lead，base lead 把子任务派进 session 成员——跨"会话边界"派发，隔离性弱，但 root 语义最稳。
- c) root 直接 assign 某个 worker-clone 直接执行（简单任务单执行者，无分解；复杂任务不适用）。

---

## 4. 实施分期（B 案口径，D2 自动绑定 + D3-a）

### P1 任务会话化派发（核心链路）

| # | 改动 | 文件 | DoD |
|---|------|浏览器|-----|
| P1-1 | schema+repo：`project_work_items.session_id`（nullable）；`channel_sessions` 增加 project/workItem 溯源列（nullable）| schema.ts, channel-session.repo, project.repo | 迁移向后兼容；attempt→session 可查 |
| P1-2 | manager：`createChannelSession` 增 project 溯源入参 + lead-clone 保留（D3-a：base lead→lead-clone role=lead，workers→worker-clone）；`submitProjectRoot` 增 `sessionId`，有 session 时 assignee=lead-clone | admin-agents.ts, tasks.ts, session-clone.ts | project root 落在 session 成员上 |
| P1-3 | 派发编排：dispatchWorkItemAs 派发前 ensure task-session（自动 createChannelSession 写回 workItem.session_id）；attempt 行记录 sessionId；attempt 闭合/task 终态 → closeChannelSession（自动生命周期）| service.ts | 每任务一 session；任务终态 session 自动关闭 |
| P1-4 | 容量闸：doAutoDispatch perChannel=1 → 按「该 channel 上 project root 任务数」计数（session 间并行）| service.ts | 同 Channel 多任务 session 并行不被闸死 |
| P1-实机 | session-ui-live 扩展 project 分支：建项目→plan→任务→派发→**验证 root task 落在 session clone 上**→任务完成→session 自动关闭 | scripts/_audit/ | 9+ 步全 PASS |

### P2 可观测与前端

| # | 放大 | 文件 | DoD |
|able|------|------|-----|
| P2-1 | ChannelObs 增 session 分区（sessions:[{sessionId,title,workItemId,inFlight}]）| service.ts | observability 透出任务级视角 |
| P2-2 | project 页 lane 内 session 分组渲染 + 任务卡跳转会话视图（?view=sessions&session=xx）| projects/[id].vue | 任务→会话可视可达 |
| P2-3 | SessionManageView 会话卡显示溯源徽标（project/workItem 关联）| SessionManageView.vue | 会话与任务互相可见 |

### P3 验收链适配

| # | 改动 | 文件 | session |
|---|------|------|---------|
| P3-1 | ensureDraftFromTask / agentSubmitResult 的频道校验放宽为「本 channel 且属本 workItem 的 session 成员」| service.ts | clone 提交成果合法 |
 clones-|- P3-2 | L1 评审频道读授权对 session clone 消息的可见性 | tool-surface/评审 channel | L1 评审可读 session 内产出 |
| P3-2 | L1  |  |  |

---

## 5. DoD（整体）

1. Project 内新建任务 → 派发时自动创建专属 session（克隆实例组=任务专属 runtime 对象）→ root 任务在 session 内闭环执行 → 任务终态 session 自动关闭（audit 留档）
2. 同 Channel 多任务 session 并行（容量闸按 session 计数）
3. observability/前端可按 session 维度观测与跳转
4. 验收链（成果→L1→L2）对 session 执行不受影响
5. 全量回归 0 fail + 实机 project-session-live 全 PASS

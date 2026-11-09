# Channel 多会话与 Agent 生命周期

> 一个 Channel 是一支团队；一个 **Session** 是一间独立车间。
> 多会话让同一套基础成员（lead + workers）在互不共享 mailbox、执行锁与记忆域的前提下并行作业。

## 三层对象模型

| 层 | 作用 | 关键事实 |
|---|---|---|
| **Channel** | 协作单元 | 成员、工具、节点绑定、任务机、HITL、定时任务都以频道为边界 |
| **Session** | 隔离执行环境 | 从基础成员克隆出独立 agent 实例组；会话内串行、会话间并行 |
| **Agent** | 可克隆对象 | 唯一 `agentId`；创建 / 激活 / 停用 / 删除；记忆按 agentId 归属 |

`Session` 不替代 `Channel`：频道仍是团队身份与授权的来源；会话只是执行面。

## 创建会话

```bash
# 频道必须已有已启用的 lead/worker（基础成员）
curl -X POST http://localhost:3001/api/workshop/channels/<channelId>/sessions \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"title":"批量归因 A"}'
```

返回：

```json
{
  "sessionId": "…",
  "title": "批量归因 A",
  "members": [
    { "baseAgentId": "…", "cloneId": "…", "name": "分析Lead·session·1", "role": "worker" }
  ]
}
```

克隆规则（`server/services/workshop/agents/session-clone.ts`）：

- 基础成员 = 已启用的 `lead` / `worker`，**排除** `project_leader` 与既有 session clone；
- 每个 clone 一个独立 `AgentRuntime`、独立 mailbox / execLock / 引擎进程；
- clone 统一以 `worker` 定位（基础 lead 保持频道协调者身份不变）；
- 复制基础成员的节点绑定面（`daq` 读 / `dcw` 写 / 配方 / 产线配方管理权），写仍受原授权约束；
- clone 名称带 `·session·` 标记，便于识别与防重。

## 隔离边界

| 资源 | 会话内 | 会话间 |
|---|---|---|
| mailbox / 执行锁 | 每 clone 独立 | 不共享 |
| 引擎进程（omp / dsh / …） | 每 clone 独立 | 不共享 |
| 记忆域 | 按 clone agentId 归属 | 隔离 |
| 团队记忆（`__team__`） | 频道级共享 | 共享 |
| 节点绑定 | 从基础成员复制 | 各自独立 |
| 任务 | 会话内串行 | 并行 |

## 会话生命周期

```text
POST   /api/workshop/channels/:id/sessions          创建会话（克隆成员）
GET    /api/workshop/channels/:id/sessions          会话列表
GET    /api/workshop/channels/:id/sessions/:sid     会话详情
GET    /api/workshop/channels/:id/sessions/:sid/brief     简报
GET    /api/workshop/channels/:id/sessions/:sid/history   历史
POST   /api/workshop/channels/:id/sessions/:sid/messages  发消息
POST   /api/workshop/channels/:id/sessions/:sid/close     关闭（幂等）
```

**关闭语义**：

1. 取消该会话在飞任务树；
2. `stopAgentRuntime` 强制摘除 clone（绕过 idle/pending 闸门，防僵尸运行时）；
3. clone 行 `enabled=0`，之后 invoke 被拒；
4. 会话置 `closed`；重复 close 幂等；
5. **会话 A 与基础成员不受影响**，可继续作业。

## Agent 生命周期与对象隔离

- 每个 Agent 的 `agentId` 在创建时生成且跨频道不重复；
- 频道 A 的成员列表不含频道 B 的成员；A 删除 B 的成员 → 非 2xx；
- 无 `@` 的群聊消息 **0 次 Agent 执行**（不回落默认 lead）；
- 停用成员 → invoke 被拒；删除成员 → 列表消失；
- 关闭频道 A → 频道 B 成员仍 `enabled=1`。

这些不是“界面隐藏”，而是服务端对象边界：跨频道查询与删除在 API 层就被拒绝。

## 与 Channel 模板的关系

```text
Channel 模板 ── instantiate ──▶ Channel（场景 + 工具档位 + 成员）
                                   │
                                   └── create session ──▶ 会话 A / 会话 B / …
```

- `POST /api/workshop/channel-templates/:id/instantiate` 实例化整支团队，可带 `scene`、`toolProfile`、`controlPolicy`、`bindLineId` 等；
- 模板实例化得到的是**基础频道**；后续每次多会话从基础成员克隆；
- 模板/频道/会话都是独立对象，关闭会话不删除模板，也不删除频道。

## 任务实例：一个工作项一个执行环境

Project 工作项派发时，内核会为它创建**专属任务实例 Channel + 会话**（`bindingType=task_instance`）：

```
Work item A ──▶ instance channel A (克隆 base lead) ──▶ session A ──▶ root task A
Work item B ──▶ instance channel B (克隆 base lead) ──▶ session B ──▶ root task B
```

- 两个实例的 `channelId / sessionId / taskId` 全部不同，历史上互不可见；
- root 完成并经对账（reconcile）后，实例 Channel 停用、会话归档，基础频道与其它任务不受影响；
- omp 验证：工作项 A 与 B 的 artifact 各自只含自己的 token（`PROJECT-W1-OK` / `PROJECT-W2-OK`），无跨任务污染；
- 单工作项全链用真实 LLM（omp / `ustc/deepseek-flash`）跑通：派发 → 任务实例 → 619 秒交付 → 对账 → L1 → L2 → completed（13/13）。

## 实机验收

| 项 | 结果 |
|---|---|
| Channel 模板多会话（双会话并行、真 LLM、HITL 写、关闭 B 后 A 继续） | **20/20** |
| 多 harness + 对象隔离（mock / omp / dsh / codex / opencode） | **24/24** |
| 双会话真实回执隔离（omp / `ustc/deepseek-flash`；A=`ALPHA-…`、B=`BETA-…`，零串扰） | ✔ |
| 任务实例隔离（不同 Channel / session / task，artifact 不串） | ✔ |
| 证据 | [`channel-multisession.json`](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-08-multisession-opt/channel-multisession.json) · [`harness-isolation.json`](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-08-full-acceptance/harness-isolation.json) · [`2026-11-09-full-acceptance`](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-09-full-acceptance/REPORT.md) |

> 相关阅读：[Harness 控制台](/guide/harness-ui) · [Project 模式](/guide/projects) · [多 Harness Agent 团队](/guide/multi-harness)

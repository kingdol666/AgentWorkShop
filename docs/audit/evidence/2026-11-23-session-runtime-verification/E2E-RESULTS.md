# Session / Runtime 实机实验（2026-11-23）

被测对象：**桌面端从当前工作目录源码启动**（`desktop/` + `.output/` 生产构建，版本 0.18.0），隔离数据目录 `D:/tmp/aw-desktop-e2e-20261123/home`，与用户正在运行的安装版桌面（pid 88792 / 0.18.0）互不影响；共享服务（LM Studio :1234、MQTT、Timescale 等）只复用、未重启。

- 桌面壳：Electron 45.4.1，`desktop/main.mjs` → `desktop/sidecar.mjs` → `node scripts/start.mjs --port <随机>` → `.output/server/index.mjs`
- 隔离 home 设置：`closeToTray=false`（关窗即正常退出并停后端）、`autoCheckUpdates=false`
- 实验脚本：`session-runtime-e2e.mjs`（setup / run / after-restart / lifecycle 四阶段）；原始证据在 `raw/`（token/口令已脱敏）

## 结论

| 阶段 | 结果 |
|---|---|
| setup（建工作区/频道/两个会话） | **9/9 PASS** |
| run（会话隔离、独立实例、元数据与记忆持久化、工具注入） | **23 PASS / 0 FAIL / 3 观测项** |
| after-restart（优雅退出 → 同数据目录重启 → 再激活） | **7/7 PASS** |
| lifecycle（关会话 → 关频道） | **7/7 PASS** |
| 真实模型回合（omp + LM Studio） | **未能执行**：模型服务给该模型只加载 8192 上下文，平台提示词超过后返回 400 `exceed_context_size_error`（见下） |

## 关键证据（`raw/` 内文件名 → 断言）

### 1. 会话 = 克隆成员组 + 会话行
- `reprovision-mock-sessions-create.json`：两次 `POST /sessions` 各克隆 2 名成员（`E2E Lead·session·N` / `E2E Worker·session·N`），返回 base→clone 映射。
- `run-db-snapshot.json`：`channel_sessions` 每个会话一行（`memberMap` 2 项、`status=active`、`generation=0`）；每个 clone 是独立的 `channel_agents` 行，且被且仅被一个会话引用（R13a/R13b）。

### 2. 每个会话的成员是独立 AgentRuntime
- `run-queue-pre-restart.json`：两个会话的 lead-clone 各自 `continuity.leaseId` 不同（`062b169d…` vs `224715e3…`），`continuityMode=persistent`（R03）。
- 同一频道只有一个 `ChannelRuntime`（`GET /api/workshop/runtime` 的 `activeChannels` 只含该频道一次，R03b）。
- 懒激活：会话创建后、未发消息时 `wiredAgents` 不含任何 clone（`reprovision-mock-runtime-before-first-message.json`，S07）；发第一条消息后只装配该会话的目标 clone（R02）。

### 3. 会话隔离
- 跨会话 A2A：`403 SESSION_MEMBER_SCOPE_MISMATCH`（R09a）。
- 同会话 A2A：投递成功，落库行被服务端盖上 `session_id`（R09b）。
- 历史互不串：S2 历史无 S1 暗号、S1 历史无 S2 提问（R08a/R08b，`run-history-S1/S2.json`）。
- Session Context 注入块逐会话：`session_id=<S1>` 且含暗号；S2 块不同且无暗号；两块都带 `Session Boundary` 规则（R14，`run-brief-blocks.json`）。

### 4. 元数据持久化与"按元数据激活"
- `channel_sessions`：`member_map_json`、`memory_policy`、`status`、`generation`、`binding_snapshot_*`、`prefab_snapshot_*`（`DESIGN-REVIEW.md` 第 4 节列了全部列）。
- 重启后：会话 id、`status=active`、`memberMap` 与重启前一致（A02）；`wiredAgents=[]`（A03，运行时对象不持久化，按需重建）。
- 向 S1 发消息 → 运行时被重新装配，`leaseId` 由 `062b169d…` 变为 `838bcd96…`（A05，新实例），会话历史与暗号记忆仍可用（A04/A06）。

### 5. 记忆/经验按 session + Agent 保存与注入
- 通过运行时工具桥写记忆（`agent-tools/invoke` → `save_memory`）：`agent_memories` 行 = `agent=4820d28a…（S1 的 lead clone）` + `session_id=cs-…（S1）` + `scope=session`（R10、R13d）。
- 工具检索按自身元数据限定：S2 clone 的 `search_memory` 看不到 S1 行（R11a）；S1 clone 能看到（R11b）；`scope=session` 检索用 S2 token 查 S1 会话被 `403 SESSION_SCOPE_FORBIDDEN` 拒绝（R12c）；`agent-tools/list` 对该 clone 只列频道策略内的 4 个工具（R12d）。
- 重启后同一会话域仍可检索到该记忆（A06）。

### 6. 生命周期
- 关会话 S1：`status=closed`，S1 的两个 clone `enabled=0`，S1 的两个运行时被卸载，S2 clone 仍在线（L01a/L01b）；再向 S1 发消息 `409 SESSION_CLOSED`（L02）；S2 继续工作（L03）；DB 行 `closed` 持久化（L04）。
- 关频道：`GET /api/workshop/runtime` 中该频道全部运行时消失、`activeChannels` 不含它（L05）；会话消息投递被拒（L06，`502 DELIVERY_FAILED`——频道停用后无可达运行时）。

### 7. 观测项（如实记录，不作为失败）
- R15/R15b：**频道群聊可以 @ 会话克隆**，克隆按自己绑定的会话回答（回显了它看到的上下文），该往返也落进该会话历史。产品口径是"会话对频道成员可见"，因此这是设计内行为；但意味着**频道成员能通过群聊问出某个会话里的内容**。若这不是期望语义，需要单独决策。
- R07b：mock 回合毫秒级完成，"两个 clone 同时 busy"只在部分采样中命中（本轮命中 `bothBusy=true`，早前一次 `false`），结构性证据是两会话各自完成回合且 lease 独立。

## 真实模型回合为何未执行

平台把 `provider/model` 下发给 omp 的 `set_model`。本机 LM Studio 的 `openai/gpt-oss-20b` 以 `loaded_context_length=8192` 加载，而平台单回合提示词（system + 工具清单 + 场景 + Session Context）已超过该窗口：

```
POST /v1/chat/completions → 400
{"error":{"code":400,"message":"request (13413 tokens) exceeds the available context size (8192 tokens), try increasing it",
          "type":"exceed_context_size_error","n_prompt_tokens":13413,"n_ctx":8192}}
```

于是 omp 回合停在等模型，7 分钟后 harness 退出（后端日志 `Harness 重建(PROCESS_EXIT)`），会话没有回执。本机 GPU（16GB，已用 ~14.8GB）不支持在不卸载用户当前模型的前提下把它涨到 ≥16k。按约束没有改动共享模型服务，因此本轮真实模型回合记为**未执行（环境限制）**，并改为用平台自带的确定性 `mock` harness 跑完整机制链路。

顺带修真：平台此前在 `set_model` 失败时**静默吞掉**异常，omp 会沿用全局默认模型（本机是云端 `ustc/deepseek-flash`），表现为"回合卡死 + 日志空白"。已改为 `log.warn` 并指出正确取值方式（`server/services/workshop/agents/omp-agent/client.ts`）。

## 复现步骤

```bash
# 1. 构建（工作目录）
pnpm run build

# 2. 从源码启动桌面（隔离 home，不触碰用户安装版）
AW_DESKTOP_HOME=D:/tmp/aw-desktop-e2e-20261123/home AW_UPDATE_CHECK=0 \
  ./desktop/node_modules/electron/dist/electron.exe ./desktop

# 3. 四阶段（脚本在验收工具目录，不在仓库内）
node session-runtime-e2e.mjs --root D:/tmp/aw-desktop-e2e-20261123 --phase setup
node session-runtime-e2e.mjs --root D:/tmp/aw-desktop-e2e-20261123 --phase run --harness mock
# 优雅关闭窗口后重新启动，再跑：
node session-runtime-e2e.mjs --root D:/tmp/aw-desktop-e2e-20261123 --phase after-restart --harness mock
node session-runtime-e2e.mjs --root D:/tmp/aw-desktop-e2e-20261123 --phase lifecycle --harness mock
```

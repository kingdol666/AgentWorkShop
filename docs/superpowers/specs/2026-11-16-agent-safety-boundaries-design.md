# Agent runtime safety boundaries design

**日期：** 2026-11-16  
**基线：** `main@67d9e356`   
**范围：** HITL 审批等待、运行时中止、消息 claim 生命周期、受保护产线验收夹具。

## 1. 背景

第二轮合并验收已经证明消息 watchdog 的活动窗口修复有效，但代码复核发现三类尚未闭合的边界：

1. 审批等待在共享 runtime watchdog 与 OMP 回合 watchdog 中不是同一个“合法等待”状态；审批超过阈值后，恢复时可能立即误杀。
2. watchdog/runtime/task abort 后，OMP 以 `done` 收口，而 worker 隐式 settlement 仍可把旧 artifact 或短状态文本解释为 COMPLETED/FAILED，覆盖重试语义。
3. 审批卡只绑定 agent/context，不绑定 task assignment generation 和 execution lease；取消或重派后迟到批准仍可能进入 DCW 写路径。
4. runtime stop/re-wire 期间已从 `pending` claim 为 `consuming` 的消息没有同进程归还路径。
5. onboarding V6 将保护线删除、创建和读取错误当作 SKIP/空快照，且只比较新增 anchor，不能证明基线完整性。

这些不是外部 USTC 配额、RAG 内部引擎不稳定或 Mimosa 扫描状态造成的假问题，而是可由本地代码和竞态测试复现的状态边界缺陷。

## 2. 目标与非目标

### 目标

- 将 pending HITL 明确建模为 watchdog 可观察的合法等待；批准/拒绝/过期后从当前时间重新起算活动窗口。
- 对 watchdog、runtime stop 和 task abort 做结构化 abort reason，阻断隐式任务 settlement，保留消息重试与 CAS 语义。
- 将 task execution fence 从可信运行时上下文传到 approval、审计和 DCW driver guard；旧 assignment 不得产生新的控制写入。
- runtime stop/re-wire 只释放自己 claim 的消息；释放是 `consuming → pending` CAS，不增加 attempts。
- V6 只在读取成功且保护夹具前后都不存在时 SKIP；存在时证明 baseline anchor 内容未变且没有新增 anchor；读取/分页不完整均 FAIL closed。
- 每个 PR 有纯函数/竞态/假 API 回归，合并后有静态门禁和隔离模拟验收证据。

### 非目标

- 不把 `ln-d7e0a2a2` 删除保护硬编码进生产 API；它只是 verifier 的受保护验收夹具。
- 不改变既有用户显式取消、拒绝审批、任务终态和安全 grant 的正常业务语义。
- 不把模拟 PLC 或 RAG/IDD 外部服务结果描述为物理 HIL、生产批准或安全通过。
- 不在本轮启用 RSI promotion/actuation，也不绕过 DCW、HITL、范围、步长、节拍和回读闸门。

## 3. 设计不变量

### 3.1 Watchdog 与审批

- `pending approval`、`active harness event` 和 `true idle` 是三个不同状态。
- pending approval 存在时 watchdog 不 fire，并且活动时间被推进/暂停；审批终态确定后活动时间至少从该时刻重新起算。
- 共享 AgentRuntime watchdog 和 OMP turn watchdog 都使用同一可信审批状态；任一层不能因另一层等待审批而发 `TURN_STALLED` 或 `message watchdog`。
- watchdog 触发只表示本回合不可继续，不能把它归一为用户 external cancel，也不能复用普通完成/失败 settlement。

### 3.2 Abort 与 settlement

- 每次 message run 捕获本回合 `AbortSignal` 以及结构化 reason。
- `message watchdog`、`runtime stop`、`task abort` 中止时，跳过 requireReply relay、worker 隐式 COMPLETED、无输出 FAILED 和 outcome harvest。
- watchdog 已安排的 `requeue` 保持其语义；迟到的 `markConsumed` 使用 consuming CAS，不得吞掉新 runtime 的处理。
- 已进入物理 driver 的单笔写无法撤销时，必须记录 in-flight/indeterminate，立即停止后续参数写入，不得声称整批成功。

### 3.3 Approval execution fence

- approval entry 至少保存 `taskId`、`assignmentGeneration`、`executionLeaseId`、agent/runtime scope 和 abort signal 的可信快照。
- fence 只从 message/runtime/task engine 取得，不能从模型提供的普通参数读取。
- 取消、重派、租约撤销或 runtime stop 会取消对应 pending approvals，并清理 expiry/reminder timers。
- decide 恢复、grant/context 异步复核返回后、批量写入前、每个参数 driver write 前都必须复核 task state/assignee/fence/signal。
- stale approval 终止为 denied/stale，driver write count 必须为零。

### 3.4 Message claim

- `releaseClaim(id)` 只允许当前 consuming 行回到 pending，不增加 attempts；不能释放已被其它 runtime 重新处理的行。
- stop 前 claim 但尚未进入 `processMessage` 的消息必须归还；已进入 processMessage 的消息由 abort/finally 完成正常收口。
- channel-wide unload 在第一个 await 前建立所有 stopping tombstones，旧 unload 不得删除新 runtime index。

### 3.5 V6

| pre line | pre journal | post line | post journal | 结果 |
|---|---|---|---|---|
| absent | 成功 | absent | 成功 | SKIP |
| absent | 成功 | present | 任意成功 | FAIL（测试期间创建） |
| present | 空/不完整 | 任意 | 任意 | FAIL |
| present | 成功且有 baseline | absent | 成功 | FAIL（保护线删除） |
| present | 成功且有 baseline | present | 成功 | 逐 anchor canonical 比较；无变化且无新增才 PASS |
| 任意 | HTTP/envelope 错误 | 任意 | 任意 | FAIL closed |
| 任意 | limit 达上限/快照不完整 | 任意 | 任意 | FAIL closed |

## 4. 分 PR 实施方案

### PR1：HITL/watchdog/abort/fence

先改纯 watchdog 判定和 abort reason，再把可信 fence 接到审批和 recipe/DCW。approval timer 清理由单一 helper 负责，所有 terminal path 只允许一次收口。测试覆盖 pending 超阈值恢复、OMP idle 等待、两种 abort settlement、迟到批准零写、timer 清理。

### PR2：claim release/re-wire

先增加 repository CAS，再把 claim owner 生命周期挂到 Mailbox/AgentRuntime，明确 claimed 与 processing 两个阶段。stop/re-wire 做幂等 release；manager channel unload 先写全量 tombstones 后异步等待。测试用人为挂起点锁住 claim/process 边界。

### PR3：V6 fail-closed

新增无副作用的 evaluator，输入 pre/post line/journal snapshot 和 read errors，输出结构化 `PASS|FAIL|SKIP`。`verify-line` 只负责 checked API 采集与展示；V6 不消费未检查的 `data:null`。用 fake API 覆盖创建、删除、基线删除、同 ID 变更、新增、HTTP/envelope 错误和 capped snapshot。

## 5. 验收路径

### 每个 PR

- 受影响 focused unit/integration tests RED→GREEN。
- `pnpm lint`、`pnpm typecheck`、相关单元测试；不改变用户未跟踪 WIP。
- 独立只读审查按照本设计的不变量逐条检查。

### 合并后 main

- `pnpm test:unit`、`pnpm lint`、`pnpm typecheck`、`pnpm build`。
- docs/README/skills/MCP/plugin/SDK/twin 既有门禁保持通过。
- fresh `AW_HOME` + 独立端口（simulator <=4056）完成 sim-twin 7/7、onboard 25/25、smoke 7/7。
- test-only watchdog 60s：审批 pending 超过阈值后批准，不能出现 `TURN_STALLED`、shared watchdog abort、重复投递或重复写入。
- cancel/reassign/abort 后迟到审批：stale/denied，driver write=0，journal 无新 anchor。
- stop claim race：消息 pending、attempts 不变，新 runtime 只消费一次。
- IDD 只跑 optimizer skill 的 init/design/ingest/converge/gate；RAG 分别记录 direct search、index/retrieve 和 kb_agent 的真实成功/分类错误。
- Mimosa 如仍 `inconclusive`，只记录扫描状态和 changed-file 命中，不宣称安全通过。

## 6. 回滚与边界

PR1、PR2、PR3 可独立回滚；每个 PR 不改变数据库既有终态枚举和生产 fixture API。若外部模型预算或 RAG 内部服务不可用，软件层 lifecycle/V6/optimizer contract 测试仍必须运行，外部结果单独标记 BLOCKED/DEGRADED。只有物理 PLC、网络分区、SIS/急停和现场签字完成后，才可进入生产投用评估。

# Channel 任务 CANCELED / CHILD_RETRIES_EXHAUSTED 诊断与修复验收（2026-10-19）

## 1. 原始故障证据

3000 隔离实例（`AW_HOME=D:/tmp/aw-opcua-injection-home`）的失败记录：

| 任务 | 状态 | retry | 说明 |
| --- | --- | ---: | --- |
| `4eae39be…`（root，goal） | CANCELED | 0 | `closeReason=CHILD_RETRIES_EXHAUSTED` |
| `3a23d3df…`（child） | FAILED | 3 | `executionLeaseStartedAt` → `revokedAt` 仅 80ms |

同一 child 的 4 次 assign 投递（generation 0→3）中，日志有 3 次：

```text
[AgentRuntime:…] 丢弃过期任务投递(旧执行代次):task=3a23d3df kind=assign
```

即：worker 还没消费当前 assign，任务已经被下一次重试换发 lease，旧投递全部因栅栏不匹配被丢弃；3 次重试在约 0.4s 内烧完，父任务被规则引擎收口为 `CHILD_RETRIES_EXHAUSTED`。同时 child 的 `history_json` 为空，事后无法从任务记录看出失败原因。

## 2. 根因结论

不是 Channel CRUD/消息/token/任务接口的问题，也不是 omp 永久损坏。实际是三层叠加：

1. **worker 回合失败**：当时的 omp worker/harness 进程未保持可用（监控只看到 lead、0 个 harness），首个 worker 回合没有产出交付物。
2. **重试与投递栅栏竞态（真实缺陷）**：任务 FAILED 后调度器在下一 tick 立即 reassign（间隔约 100ms），worker 还没来得及消费新 assign，下一次重试又换 lease；旧投递被“旧执行代次”丢弃，重试预算在 0.4s 内耗尽。
3. **失败不可观测（真实缺陷）**：worker 回合 error/无交付路径只迁移 FAILED，不写 `history`，根因无法从任务记录追溯。

## 3. 修复

- `server/services/workshop/types/task.ts`：新增 `FAILED_RETRY_BACKOFF_MS = 2000` 与 `failedRetryReady(task, now)`。
- `server/services/workshop/runtime/scheduler-loop/rules.ts` 与 `server/services/workshop/agents/mock-agent.ts`：FAILED 重派前必须过 2s 回退窗，避免 worker 尚未消费新 assign 就再次换 lease。
- `server/services/workshop/runtime/task-engine/transition.ts`：`error` 事件先把 `执行失败(code): message` 写入 task history，再迁移 FAILED。
- `server/services/workshop/runtime/agent-runtime/message.ts`：捕获生成器异常/error 事件原因；无交付 FAILED 路径先把失败原因写入 history，再迁移 FAILED。
- 单测：`tests/task-retry-backoff.test.ts`（回退窗内拒绝、窗外放行、非法时间放行）。

## 4. 验收结果

### 4.1 真实 omp worker（3000 / 3001）

| 场景 | 结果 |
| --- | --- |
| 3000 直发 omp worker（`OMP-WORKER-OK`） | **COMPLETED**，artifact 原文 `OMP-WORKER-OK` |
| 3000 Channel goal（mock lead → omp worker） | **COMPLETED**，10.2s，artifact 含 `CHANNEL-TASK-OK` |
| 3001 直发 omp worker（`HARNESS-WIRING-OK`） | **COMPLETED** |
| 3001 Channel goal（omp lead → omp worker） | **COMPLETED**，child 0 重试 |
| 原 `scripts/channel-interaction-smoke.mjs`（3000，同频道） | **ALL PASS 10/10**（H9 任务生命周期到终态） |

### 4.2 故障注入（3000，两个 omp worker 临时改为不存在的命令）

`node .ui-review/fault-injection-retry.mjs`：

```text
✔ F1 worker 已切换为不存在的 omp 命令 ×2
✔ F2 goal 任务已提交
  0.1s WAITING|FAILED:0:0
  3.2s WAITING|FAILED:1:1
  6.3s WAITING|FAILED:2:2
  9.3s CANCELED|FAILED:3:3
✔ F3 父任务最终 CANCELED / CHILD_RETRIES_EXHAUSTED（预期）
✔ F4 重试耗尽耗时 > 6s（回退窗生效，不再 0.4s 秒烧完）
✔ F5 子任务 history 记录失败原因（含 spawn/ENOENT/执行失败）
✔ F6 子任务 retryCount 达到 3
✔ F7 两个 worker 配置已恢复
结论 PASS(9/9)
```

关键对比：修复前 0.1→0.2→0.3→0.4s 四次尝试全部完成；修复后 0.1→3.2→6.3→9.3s，每次重试都有机会被 worker 消费，失败原因可在任务 history 查到。

### 4.3 回归

| 项 | 结果 |
| --- | --- |
| `pnpm test:unit` | **244/244 PASS** |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| 改动文件 ESLint | 0 error |
| 故障注入后恢复 | 两个 worker 配置已恢复；正常 goal 10.2s COMPLETED |

## 5. 运行态

- 3001 生产实例与 3000 隔离实例均已用新构建重启，健康检查 `workshop=ready`。
- 故障注入只临时修改 3000 测试频道的两个 worker config，脚本 `finally` 已恢复；未修改任何凭据。
- 结论：omp 本体可用；先前的失败是 worker harness 回合失败叠加“重试抢跑 + 失败无 history”的真实缺陷，修复后原 9/10 套件已 10/10。

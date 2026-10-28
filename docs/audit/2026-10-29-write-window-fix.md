# P1 修复：写入「尝试时间」与「成功时间」拆分

- 日期:2026-10-29
- 结论:**是真问题，已修复并双证**。失败写不再占用 60 秒成功间隔；恢复后首次重试即成功（实测 200，不再是 11 次 429/~55 秒）。

## 一、问题确认（不是测试错觉）

原实现把同一个 `lastWriteAt` 当两种语义用：

1. `dcw-runtime.write()` 在**调用驱动之前**就写 `node.lastWriteAt`（失败也会写）；
2. `applyWriteResult()` 无论 `ok` 与否都更新 `lastWriteAt`；
3. `dcw-controller/write.ts` 的 60 秒在线写间隔直接读 `lastWriteAt`。

后果：设备断链失败 → 恢复后首个重写被 429 锁约 60 秒；节点详情里的“最近写入”也会把失败尝试算进去。

修复前真机证据（`2026-10-28-golive-matrix` 首轮）：F3 恢复写连续 **11 次 429 `WRITE_INTERVAL_NOT_ELAPSED`**，约 55 秒后才成功。

## 二、修复

| 文件 | 改动 |
|---|---|
| `dcw-node.ts` | 新增 `lastAttemptAt`（每次尝试恒更新）；`lastWriteAt` 仅在 `ok` 时更新；`toRow/fromRow/toView` 同步；旧快照缺 `lastAttemptAt` 时用旧 `lastWriteAt` 回填 |
| `dcw-runtime.ts` | 写前只记 `lastAttemptAt`，不再碰 `lastWriteAt` |
| `dcw-controller/write.ts` | 60s 间隔只认 **lastWriteAt（成功）**；另加 **5s 失败冷却**（仅当节点仍 error 且最近尝试在 5s 内），防失败轰炸 |
| `shared/dcw-protocol/line.ts` | 视图契约拆分两个时间 |
| `useDcwStream.ts` / `useTownRailData.ts` | WS 事件：尝试时间恒更新、成功/ACK 时间仅 ok；小镇轨道用尝试时间显示活跃度 |

语义：
- **失败写**：只写 `lastAttemptAt` + `state=error`，`value` 不动，60s 窗口不占用；
- **成功写**：`lastAttemptAt=lastWriteAt=lastAckAt`，进入 60s 成功间隔与写保持窗；
- 5s 失败冷却只防“失败后立刻无间隔重试”，不影响恢复。

## 三、验证

1. 单测 `tests/dcw-write-attempt.test.ts`（4 条）：失败只记尝试、成功三时间一致、成功后失败不回退成功时间/不污染值、持久化往返与旧快照兼容。全量单测 **749/749**。
2. 真机回归 `scripts/e2e-golive-matrix.mjs`（新构建）**21/21**；F3 恢复写 `retries=[{status:200,ok:true}]` —— **首次重试即成功**，修复前为 11 次 429。
3. typecheck / lint 全绿。

## 四、残留边界

- 5s 失败冷却在设备恢复后若状态已被周期读复位为 `ok`，不会触发；这符合“失败不占用窗口”的目标，驱动自身 3s 超时仍限制轰炸频率。
- `lastAttemptAt` 只进节点视图/诊断，不参与任何权限或限界判定。

# 单进程部署合同 / Single-Process Deployment Contract

> 适用范围:同一 `AW_HOME`(配置/数据根)只允许一个平台实例。
> Scope: exactly **one** platform instance per `AW_HOME` (config/data root).

## 为什么 / Why

以下三块均为**单进程内存状态**,没有跨进程共享层:
The following components hold **single-process in-memory state** with no cross-process sharing layer:

| 组件 / Component | 锚点 / Anchor | 内存状态 / In-memory state |
|---|---|---|
| WS Hub(AEP 直推) | `server/api/workshop/ws/shared.ts` | `streams` / `peerChannels` Map、per-channel 单调 seq + 5000 环形缓冲(seq 与缓冲重启即失,靠 `channel.snapshot` 全量对齐) |
| ManagerBus(事件总线) | `server/services/workshop/runtime/manager/bus.ts`(注册表见同目录 `state.ts`) | channel/agent 注册表(`Map`)、ChannelBus 事件订阅,进程内 pub/sub |
| Agent task ownership | `server/services/workshop/runtime/manager/` | 任务归属/在飞状态在进程内存,无分布式 lease |

第二实例会把内存态分裂成两份:WS 客户端只看到其一、事件总线互不可见、
同一任务可能被两个进程同时持有。因此**同一 AW_HOME 的第二实例会被
`server/plugins/01-instance-guard.ts` fail-fast 拒绝**(对
`<AW_HOME>/.runtime/data.lock` 独占创建;锁存在且持有 PID 存活 →
`process.exit(1)`;PID 已死视为崩溃残留,清理后接管)。
测试/受控编排豁免:`AW_SKIP_DATA_LOCK=1`(默认禁止)。

A second instance would fork all of the above into two divergent copies: WS
clients would see only one half, event buses would be invisible to each other,
and the same task could be owned by two processes at once. Hence the second
instance on the same `AW_HOME` is **rejected fail-fast by
`server/plugins/01-instance-guard.ts`**: it takes an exclusive
(`O_EXCL`) lock at `<AW_HOME>/.runtime/data.lock`; if the lock exists and its
PID is alive → `process.exit(1)`; a dead PID is treated as crash residue and
the lock is taken over. Test escape hatch: `AW_SKIP_DATA_LOCK=1` (off by default).

## 水平扩展 / Horizontal scaling

未实现前**多副本部署不受支持**。水平扩展必须先立独立 ADR,至少覆盖:
Multi-replica deployment is **unsupported** until then. Horizontal scaling
requires a separate ADR covering at least:

1. 共享 Pub/Sub(替换进程内 ChannelBus,如 Redis/NATS);
   shared Pub/Sub replacing the in-process ChannelBus (e.g. Redis/NATS);
2. 分布式 ownership/lease(task 归属与 WS 会话亲和);
   distributed ownership/leases (task ownership and WS session affinity);
3. 跨实例 seq/环形缓冲一致性与 snapshot 对齐策略;
   cross-instance seq/ring-buffer consistency and snapshot alignment;
4. `data.lock` 单实例守卫的替代或按副本分 `AW_HOME` 的编排约定。
   replacement of the `data.lock` guard, or an orchestration convention of one
   `AW_HOME` per replica.

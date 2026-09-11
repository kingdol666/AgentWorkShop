# Workshop runtime audit — read-only, verified against current source

Scope read COMPLETELY: `server/services/workshop/runtime/{manager,agent-runtime,task-engine,scheduler-loop,channel-runtime,monitor,mailbox,execution-mode,memory,embedding-provider}.ts`.

**Correction to the brief:** `manager.ts` is **3016 lines** (`<path>…/manager.ts</path>` reported "End of file - total 3016 lines"), not ~2836. All line numbers below are from the current file.

Verdicts use exactly two buckets: **BOUNDED** (eviction code shown) or **UNBOUNDED** (*"no eviction found"*).

---

## A. Unbounded in-memory state (P0/P1 leak class)

### A1. `ownerNameCache` — UNBOUNDED (no eviction found)

Decl `manager.ts:229-230`:
```ts
/** 全局用户名解析(带 60s 缓存;owner 归属呈现用,解析失败返回 null) */
const ownerNameCache = new Map<string, { name: string | null, at: number }>()
```
Read `manager.ts:232-233`:
```ts
  const hit = ownerNameCache.get(userId)
  if (hit && Date.now() - hit.at < 60_000) return hit.name
```
Write `manager.ts:241`:
```ts
  ownerNameCache.set(userId, { name, at: Date.now() })
```
Delete/evict sites: **none** (grep of `ownerNameCache` in the whole repo returns only lines 230/232/241). The 60 s TTL is a *freshness* check, not eviction — an expired entry is only ever overwritten if the same `userId` is looked up again. One entry per distinct userId ever resolved, forever. This is exactly what the in-repo design note says, `shared/lru.mjs:7-8`:
```
 *   · `dcw-controller.ts` opsWriteMemo / `manager.ts` reflectCounts / ownerNameCache:
 *     完全无淘汰,长跑单调增长(ownerNameCache 有 TTL 判定但过期项只被覆盖、从不删除);
```
**Verdict: still UNBOUNDED.** (The `LruMap` that would fix it exists at `shared/lru.mjs:14` but its only production use in the repo is `daq-controller.ts:677`.)

### A2. `reflectCounts` — UNBOUNDED (no eviction found)

Decl `manager.ts:326-327`:
```ts
  /** 反思游标:每 agent 上次聚合的当月任务数(月度幂等增量判定) */
  private readonly reflectCounts = new Map<string, number>()
```
Read `manager.ts:475`: `const prev = this.reflectCounts.get(agentId) ?? 0`
Write `manager.ts:489`: `this.reflectCounts.set(agentId, rows.length)`
Delete/evict: **none** (whole-repo grep: only 327/475/489). Keyed by `agentId` from `memories.listMemoryAgentIds()` (`manager.ts:471`); memory rows are deleted by maintenance (`memory.ts:650`, `661`) but the cursor entry is never removed. **Verdict: still UNBOUNDED.**

### A3. `lastToolInvokeAt` — UNBOUNDED (no eviction found)

Decl `manager.ts:328-329`:
```ts
  /** agent 最近一次工具 invoke 时刻(调度器停滞看门狗的活性源;工具调用即健康推进) */
  private readonly lastToolInvokeAt = new Map<string, number>()
```
Read `manager.ts:704`: `toolActivityOf: (agentId: string) => this.lastToolInvokeAt.get(agentId) ?? null,`
Write `manager.ts:2757` (inside `invokeHostTool`, reachable from REST + the stdio MCP bridge + every host-tool call):
```ts
      this.lastToolInvokeAt.set(input.agentId, Date.now())
```
Delete/evict: **none** (whole-repo grep: 329/704/2757). One entry per agentId that ever invoked a tool, forever — including agents whose runtimes were unloaded and members deleted. **Verdict: still UNBOUNDED.** (This one was *not* in the previous audit's four-Map list; the previous list is `PLAN-ARCH-AUDIT.md:88`.)

### A4. Manager runtime indexes — BOUNDED

Decl `manager.ts:316-320`:
```ts
export class AgentChannelManager {
  private channels = new Map<string, ChannelRuntime>()
  /** 键 = runtimeKey(channelId, 实例 id);每个实例一个独立运行时 */
  private agentIndex = new Map<string, AgentRuntime>()
  private buses = new Map<string, ChannelBus>()
```
Eviction:
- `manager.ts:737-741` (`stopAndDetach`): `this.agentIndex.delete(key)` … `this.channels.delete(channelId)` / `this.buses.delete(channelId)`
- `manager.ts:1250-1256` (`unloadChannelAgents`), `manager.ts:1282-1286` (`removeChannel`), `manager.ts:993-995` (`shutdown`: `clear()`)
**Verdict: BOUNDED** (bounded by live channels/agents).

### A5. Idle-sweeper `idleSince` (manager) — UNBOUNDED (no eviction for runtimes removed by other paths)

Decl `manager.ts:767`: `const idleSince = new Map<string, number>()`
Write `manager.ts:781-782`:
```ts
          const since = idleSince.get(key) ?? now
          idleSince.set(key, since)
```
Delete `manager.ts:784` (`idleSince.delete(key)` right before unloading), `manager.ts:791` (`else { idleSince.delete(key) }`).
There is **no** sweep of keys whose runtime has already left `agentIndex` through another path — `unloadChannelAgents` (`manager.ts:1243-1258`), `removeAgentFromChannel`→`stopAndDetach` (`manager.ts:1600`, `723-742`), `terminateRuntimeProcess` (`955-972`) never touch this closure. Such keys are never deleted because the loop that would delete them (`for (const rt of [...this.agentIndex.values()])`, `manager.ts:770`) never sees those runtimes again. Growth is one entry per (channel, agent) ever wired and non-gracefully-removed during the process lifetime. **Verdict: UNBOUNDED (no eviction found)** — low rate, but unbounded.

### A6. ChannelBus listener sets — BOUNDED

Decl `manager.ts:495-500` (`eventListeners`, `taskListeners`, `agentListeners`, `messageListeners`, `memoryListeners`, `memberListeners`), add/remove pairs `513-516`, `527-530`, `541-544`, `555-558`, `569-572`, `583-586`. Every `subscribe*` returns the real unsubscriber (`manager.ts:593-627`), and the whole bus object is dropped with the channel (`739-741`). `monitor.ts:185-191` calls all three unsubscribers on `stop()`. **Verdict: BOUNDED.** (Caveat: a WS consumer that never unsubscribes pins the bus — `ws.ts` was out of scope; ⚠UNVERIFIED there.)

### A7. SchedulerLoop task-keyed maps/sets — BOUNDED (pruned every tick)

Decls `scheduler-loop.ts:75-94`:
```ts
  /** 已催办一次的 WORKING 任务(再次停滞 → cancel) */
  private readonly notified = new Set<string>()
  /** WORKING 任务最近一次 progress 与时间(停滞检测) */
  private readonly lastProgress = new Map<string, { progress: number, at: number }>()
  private readonly progressSeen = new Map<string, { progress: number, at: number }>()
  /** goal 父任务「全部子任务 COMPLETED」首见时刻(宽限后规则引擎兜底收口) */
  private readonly goalAllDoneAt = new Map<string, number>()
  /** 成员空闲起始时间(最久空闲 worker 排序) */
  private readonly idleSince = new Map<string, number>()
  ...
  private readonly loopCompletedTaskIds = new Set<string>()
```
Eviction code, every tick, `scheduler-loop.ts:196-208`:
```ts
    const liveIds = new Set(snapshot.tasks.map(t => t.id))
    for (const map of [this.progressSeen, this.lastProgress, this.goalAllDoneAt]) {
      for (const key of map.keys()) {
        if (!liveIds.has(key)) map.delete(key)
      }
    }
    for (const key of this.notified) {
      if (!liveIds.has(key)) this.notified.delete(key)
    }
    for (const key of this.loopCompletedTaskIds) {
      if (!liveIds.has(key)) this.loopCompletedTaskIds.delete(key)
    }
```
plus `idleSince` pruned against live members in `refreshIdle`, `scheduler-loop.ts:708-720`, and `loopCompletedTaskIds.clear()` in `stop()` (`157`). **Verdict: BOUNDED.**
Note: the comment at `scheduler-loop.ts:195-196` (`progressSeen 全程只增不减`) is **stale/wrong** — `progressSeen` is in the prune list.

### A8. `AgentRuntime.runErrorRetries` — UNBOUNDED (no eviction for ids never re-processed)

Decl `agent-runtime.ts:173-174`:
```ts
  /** 回合失败重投计数(每消息;进程内存,重启由 resetConsuming 重新给机会) */
  private runErrorRetries = new Map<string, number>()
```
Write `agent-runtime.ts:700-703`:
```ts
      if (sawRunError && !taskDone && (this.runErrorRetries.get(msg.messageId) ?? 0) < 2
        && this.deps.mailbox.requeue(msg.messageId)) {
        const attempt = (this.runErrorRetries.get(msg.messageId) ?? 0) + 1
        this.runErrorRetries.set(msg.messageId, attempt)
```
Delete `agent-runtime.ts:719`: `this.runErrorRetries.delete(msg.messageId)` — only in the `else` branch of the *same* `finally`, i.e. only when that messageId reaches this runtime's `finally` again. If the re-queued message is instead claimed by a different owner (`Mailbox.claim` from `injectSteer` `agent-runtime.ts:276`, or `ackMailbox` `manager.ts:2853`) or the runtime stops (`stop()` closes the mailbox `359`; `consumeLoop` then breaks at `512-514`), the entry is never deleted. Keyed by messageId ⇒ grows with every failed-then-otherwise-consumed message. **Verdict: UNBOUNDED (no eviction found)** — small per-entry (string+int) but monotonic.

### A9. `Mailbox.arrivalCbs` — BOUNDED

Decl `mailbox.ts:45-46`:
```ts
  /** 到信回调注册(poll_messages 长轮询即时唤醒;注册方自带注销句柄) */
  private arrivalCbs = new Set<() => void>()
```
Add `mailbox.ts:85` (`this.arrivalCbs.add(cb)`), delete `mailbox.ts:86-88` (`return () => { this.arrivalCbs.delete(cb) }`); the only caller releases in a `finally`, `agent-runtime.ts:333-338`:
```ts
        const off = this.deps.mailbox.onArrival(() => resolve(undefined))
        const timer = setTimeout(() => resolve(undefined), 250)
        await promise
        clearTimeout(timer)
        off()
```
**Verdict: BOUNDED.**

### A10. `monitor.ts` `events[]` — append-only, no cap (NOT production-reachable today)

Decl `monitor.ts:82-84`:
```ts
  const events: MonitorEvent[] = []
  const listeners = new Set<(e: MonitorEvent) => void>()
```
Write `monitor.ts:90-92`:
```ts
  const push = (e: MonitorEventInput): void => {
    const full = { ...e, seq: (seq += 1), at: new Date().toISOString() } as MonitorEvent
    events.push(full)
```
Delete/trim: **none** — the array is append-only for the monitor's lifetime; `stop()` (`185-192`) only unsubscribes sources and does not clear `events`. Unbounded per monitor instance. **Verdict: UNBOUNDED (no eviction found)** — but whole-repo grep shows `monitorChannel(` is called only from `scripts/` (demo/e2e harnesses), never from `server/` production code, so this is a test-harness leak today. `listeners` is BOUNDED (unsubscriber at `139-142`).

### A11. Arrays written at runtime in the other 9 files

All remaining arrays/maps in the audited files are **per-call locals** that die with the call, or bounded-by-construction:
- `task-engine.ts:146-148` `queued`/`completed` locals; `task-engine.ts:412` `const history = [...task.history, event.status.message]` is a copy, and history is capped: `task-engine.ts:77-78` `/** 任务执行历史上限(applyEvent 整列重写模型下的写放大有界化) */ const TASK_HISTORY_CAP = 200` enforced at `413` (`history.splice(0, history.length - TASK_HISTORY_CAP)`) and `manager.ts:2294` (`.slice(-200)`).
- `memory.ts:182` `rrf`, `210` `distByRowid`, `227` `hits`, `281-282` `lines`/`touched`, `306` `selectedTokens` — all function-local. Instance state is only `private sessionSeq = 0` (`memory.ts:455`, a number).
- `channel-runtime.ts:28` `private agents = new Map<string, AgentRuntimeLike>()` — BOUNDED: deleted at `149` (`removeAgent`) and `154-156` (`detachAgent`).
- `scheduler-loop.ts:383` `childrenByParent` local; `channel-runtime.ts:71`, `manager.ts:1703/1853`, `execution-mode.ts:92`, `memory.ts:102-103/464/493` — locals.
- `manager.ts:227` `const KNOWN_HARNESSES = new Set(knownHarnesses())` — module-level but write-once.
- `manager.ts:844/845/897/910/2320/2420/2624/2845/2904/2917`, `scheduler-loop.ts:197/322/444/637/708` — function-local projections.

### A12. `metricStates` / `twinPushAt` (previous audit's other two) — moved to delete-on-lifecycle, still not LRU

Both live outside the 10 audited files (`server/services/workshop/daq/daq-controller.ts`):
- `daq-controller.ts:136` `private metricStates = new Map<string, 'ok' | 'warn' | 'alarm'>()`, write `433` `this.metricStates.set(key, level)`; **delete added** at `daq-controller.ts:1027-1030`:
  ```ts
      const prefix = `${id}::`
      for (const key of this.metricStates.keys()) {
        if (key.startsWith(prefix)) this.metricStates.delete(key)
      }
  ```
  (inside `remove(id)` — DAQ node deletion, `1020`). So it is bounded by *node deletions happening*; it is **not** LRU-bounded, and an installation that creates nodes/metrics but never deletes them grows monotonically.
- `daq-controller.ts:718` `private twinPushAt = new Map<string, number>()`, write `723`; **delete added** at `daq-controller.ts:1101-1102` inside `unbindDevice`: `this.twinPushAt.delete(deviceId)`.
- Contrast: `daq-controller.ts:677` `private siblingsCache = new LruMap<string, { at: number, list: DaqNode[] }>(500)` — the only real LRU in production.
**Verdict for the two:** delete-on-entity-removal added ⇒ *not* "completely unbounded" as the old audit (`PLAN-ARCH-AUDIT.md:88`) stated, but still not LRU-bounded. `reflectCounts`/`ownerNameCache` (+ `lastToolInvokeAt`) remain **UNBOUNDED**.

---

## B. Full-table scans / N+1 / absurd limits

### B1. Absurd `limit` values (biggest first)

| value | site | evidence |
|---|---|---|
| `1_000_000` | `manager.ts:1489` | `const row = this.deps.repos.memories.listByAgentChannel(channelId, TEAM_AGENT_ID, 1_000_000).find(r => r.id === memoryId)` — pulls the entire team-memory table into JS to find one id |
| `1_000_000` | `memory.ts:669` | `expireAndEvict(repo.listByAgentWithRowid(agentId, 1_000_000).filter(r => r.kind.startsWith('episodic')))` |
| `1_000_000` | `memory.ts:673` | `expireAndEvict(repo.listByAgentWithRowid(TEAM_AGENT_ID, 1_000_000).filter(r => r.kind === 'episodic-team-task'))` |
| `10_000` | `manager.ts:1552` | `const row = this.deps.repos.memories.listByAgent(targetAgentId, 10_000).find(r => r.id === memoryId && ...)` |
| `1000` ×3 | `server/api/workshop/aml/index.get.ts:16-18` | `datasets: rt.repo.dataset.list({ limit: 1000 }).length,` / `models: rt.repo.model.list({ limit: 1000 }).length,` / `productions: rt.repo.model.list({ stage: 'production', limit: 1000 }).length,` — three full-ish table pulls whose only use is `.length` |
| `5000` | `db/retention.ts:19,40` | `const BATCH = 5000` / ``DELETE FROM ${t.table} WHERE rowid IN (SELECT rowid FROM ${t.table} WHERE ${t.column} < ? LIMIT ${BATCH})`` |
| `5000` | `db/channel-event.repo.ts:98`, `daq/storage/sqlite.adapter.ts:94` | `'DELETE FROM channel_events WHERE rowid IN (SELECT rowid FROM channel_events WHERE at < ? LIMIT 5000)'` |
| `Number.POSITIVE_INFINITY` | `execution-mode.ts:69`, `scheduler-loop.ts:777` | `config.maxIterations = maxMatch ? parseInt(maxMatch[1]!, 10) : Number.POSITIVE_INFINITY` / `const maxIterations = modeInfo.config.maxIterations ?? Number.POSITIVE_INFINITY` |
| 500 / 1000 | `ops-logs/index.get.ts:27` (`Math.min(500, …)`), `channels/[id]/events.get.ts:18` (`.max(1000)`) | request-surface caps, fine |
| 500 / 300000 | `dcw/recipe-rollback-manager.ts:190,522,621`; `agents/dsh-agent.ts:64,150` (`contextWindow ?? 1_000_000`) | large but bounded |

The former `limit=1_000_000` in the reflection path is **fixed**; the fix is documented in the code itself, `manager.ts:472-474`:
```ts
      // 条件下推到 SQL:原先拉 limit=1_000_000 全量再 JS filter,代价随记忆总量无上限增长。
      // 这里按 (agent, kind, 当月) 精确取行 —— 返回量与实际增量同阶,且内存不随历史膨胀。
      const rows = memories.listByAgentKindMonth(agentId, 'episodic-task', month)
```
(`listByAgentKindMonth` exists at `db/memory.repo.ts:210`.)

### B2. Repository/DB queries issued INSIDE a loop

1. `manager.ts:1708-1728` — per-orphan loop calls `pickReceiverWorker`, which issues one `queueViewOf` **per candidate member per task**:
```ts
    for (const task of orphans) {
      if (task.state === 'SUBMITTED' || task.state === 'ASSIGNED') {
        const receiver = this.pickReceiverWorker(channelId, agentId)
```
`manager.ts:1750-1756`:
```ts
    for (const m of candidates) {
      const len = this.getTaskEngine().queueViewOf(channelId, m.id).queued.length
```
`queueViewOf` is a real query — `task-engine.ts:145` `const rows = this.repos.tasks.listByChannelAssigneeMeta(channelId, agentId)`. The same loop also calls `transition` (`manager.ts:1723`, `1725`), and `transition` itself queries, `task-engine.ts:347-350`:
```ts
    if (state === 'WORKING' && current !== 'WORKING') {
      const clash = this.repos.tasks
        .listByChannelAssignee(row.channelId, row.assigneeId)
        .find(r => r.id !== taskId && r.state === 'WORKING')
```
2. `manager.ts:1854-1861` — per-team-member loop with a write+queries inside:
```ts
    for (const m of members) {
      const inst = await this.addAgentToChannel({
        channelId: input.channelId,
        agentId: m.templateId,
        role: m.role === 'lead' ? 'lead' : 'worker',
      })
```
3. `manager.ts:1880-1882` — one `agents.findById` per team member, and `teamDetailOf` is itself called per team row by `listTeams`/`listTeamsVisibleTo` (`1773`, `1786`):
```ts
      members: members.map((m) => {
        const tpl = this.deps.repos.agents.findById(m.templateId)
```
4. `manager.ts:2625-2643` — per-other-channel full task fetch + team-memory count:
```ts
    return this.otherSameOwnerChannels(channelId).map((c) => {
      const tasks = this.deps.repos.tasks.listByChannel(c.id)
      const leadRow = c.leadAgentId ? this.deps.repos.channelAgents.findById(c.leadAgentId) : undefined
      ...
        sharedMemories: this.deps.repos.memories.countTeamShared(c.id),
```
5. `manager.ts:817-830` — `monitorRuntime`: `listByChannel(...).length` per wired channel (`822`) and `findByChannelAgent` per wired agent (`830`).
6. `manager.ts:910-927` — `monitorRuntimeForUser`: `this.deps.repos.channels.list()` runs **twice** (`912`, `916`), `listByChannel(row.id).length` runs inside the second loop (`921`), and `!channels.some(c => c.channelId === row.id)` (`917`) is an O(N²) scan:
```ts
    for (const row of this.deps.repos.channels.list()) {
      if (visibleChannels.has(row.id) && !channels.some(c => c.channelId === row.id)) {
        channels.push({
          ...
          memberCount: this.deps.repos.channelAgents.listByChannel(row.id).length,
```
7. `manager.ts:2421-2427` — `queueOverview`: `queueViewOf` per member (the un-wired branch):
```ts
    return this.deps.repos.channelAgents.listByChannel(channelId)
      .filter(m => m.enabled === 1)
      .map((m) => {
        const runtime = wired.get(m.id)
        if (runtime) return runtime.getStatus()
        const view = this.getTaskEngine().queueViewOf(channelId, m.id)
```
8. `memory.ts:668-674` — maintenance loop, one 1M-row pull per agent:
```ts
  for (const agentId of repo.listMemoryAgentIds()) {
    expireAndEvict(repo.listByAgentWithRowid(agentId, 1_000_000)
      .filter(r => r.kind.startsWith('episodic')))
  }
```
9. `scheduler-loop.ts:227-235` — per-decision `execute()` issues a channel-member query inside the decision loop (`578`, `601`):
```ts
    const decisions = await this.decide(snapshot)
    for (const decision of decisions) {
      try {
        this.execute(decision)
```
```ts
        const target = this.channelRuntime.listChannelAgents().find(a => a.agentId === decision.assigneeId)
```
and `ChannelRuntime.listChannelAgents` queries (`channel-runtime.ts:46`) `this.deps.channelAgents.listByChannel(this.channelId)`.
10. `manager.ts:425` + `433-438` — `refreshChronicle` runs a **full channel task list with artifacts/history JSON parsing** on every terminal task event (the hook is registered for every bus at `manager.ts:391`):
```ts
      const terminal = this.getTaskEngine().list(channelId)
        .filter(t => TERMINAL_TASK_STATES[t.state])
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, 12)
```
(`TaskEngine.list` = `task-engine.ts:438-440` `this.repos.tasks.listByChannel(channelId).map(rowToTask)` — `rowToTask` parses both JSON columns.)

### B3. Full table fetched, then filtered in JS where the repo could filter

- `manager.ts:1489` and `manager.ts:1552` (quoted in B1) — `.find(r => r.id === memoryId)` after pulling 1M / 10k rows.
- `manager.ts:2075-2077` (`submitChannelTask` hot path) — whole channel task list with JSON parsing to look for a duplicate title:
```ts
    const duplicate = this.getTaskEngine().list(input.channelId).find(t =>
      t.title === input.title
      && t.state !== 'COMPLETED' && t.state !== 'FAILED' && t.state !== 'CANCELED')
```
- `manager.ts:2155-2161` (`dispatchTask`) — same, per child dispatch, duplicating the cheaper check that `TaskEngine.dispatch` already does via an indexed child query (`task-engine.ts:297-300` `listChildrenMeta(parent.channelId, parent.id)`):
```ts
      const siblings = this.getTaskEngine().list(channelId).filter(t => t.parentId === input.parentTaskId)
```
- `task-engine.ts:453-455` (`complete`) — full channel scan + JS filter:
```ts
    const children = this.repos.tasks
      .listByChannel(task.channelId)
      .filter(t => t.parentId === task.id)
```
- `manager.ts:2874-2880` (`listChannelMail`) — filter by participant in JS after a limited fetch:
```ts
    const mails = this.deps.repos.messages
      .listRecentByChannel(channelId, limit)
      .map(rowToChannelMail)
    if (opts.agentId) {
      return mails.filter(m => m.fromAgentId === opts.agentId || m.toAgentId === opts.agentId)
```
- `manager.ts:2254` `const members = this.deps.repos.channelAgents.listByChannel(channelId).filter(m => m.enabled === 1)`
- `manager.ts:1704-1707` `listByChannelAssignee(channelId, agentId).map(rowToTask).filter(t => !TERMINAL_TASK_STATES[t.state])`
- `manager.ts:2836-2839` `pollMailbox` — **no** SQL limit, then JS slice:
```ts
    return this.deps.repos.messages
      .listPendingByChannelAgent(channelId, callerAgentId)
      .slice(0, limit)
```
- `manager.ts:2846-2848` `ackMailbox` — same unlimited pull: `this.deps.repos.messages.listPendingByChannelAgent(channelId, callerAgentId).map(r => r.id)`
- `channel-runtime.ts:46-49` `this.deps.channelAgents.listByChannel(this.channelId).filter(m => m.enabled === 1)`
- `channel-runtime.ts:184-187` `subscriptionRepo.listByTarget(...).map(s => s.agentId).filter(id => this.ensureAgent(id) !== undefined)` (filter forces lazy wiring per id)
- `scheduler-loop.ts:278-285` — O(N²) nested scan, executed from `shouldSupervise` every tick:
```ts
    return snapshot.tasks.some((t) => {
      if (t.state !== 'WAITING') return false
      const children = snapshot.tasks.filter(c => c.parentId === t.id)
```
- `memory.ts:489-492` `updateBrief` — two limited pulls + JS filter, on every task completion (`memory.ts:424`):
```ts
    const own = this.repo.listByAgentChannel(this.opts.channelId, this.opts.agentId, 40)
      .filter(r => r.kind === 'episodic-task')
    const shared = this.repo.listByAgentChannel(this.opts.channelId, TEAM_AGENT_ID, 40)
      .filter(r => r.kind === 'semantic')
```

---

## C. Read-path writes

### C1. `GET /api/workshop/channels/:id` boots runtimes and mutates the DB → **WRITE**

`server/api/workshop/channels/[id]/index.get.ts:14-17`:
```ts
  const channel = await manager.getChannel(channelId)
  // 兜底:详情请求时确保 lead 的调度循环已装配(如启动恢复遗漏)
  ensureLeadSchedulerLoop(manager, channelId)
  return channel
```
`server/plugins/workshop.ts:68-74`:
```ts
export function ensureLeadSchedulerLoop(
  manager: AgentChannelManager,
  channelId: string,
  options?: { tickMs?: number, stallMs?: number },
): void {
  manager.ensureChannelActive(channelId, options)
}
```
`manager.ts:694-720` then wires and **starts** the lead: `const lead = this.ensureAgentRuntime(channelId, channel.leadAgentId)` (`699`), `runtime.start()` (`675`), `loop.start()` (`719`). Consequences of a pure GET: (a) an `implFactory` + `AgentRuntime.consumeLoop()` is started, which immediately dequeues and **claims** rows — `mailbox.ts:102` `if (!this.messageRepo.claim(row.id)) continue` → `message.repo.ts:39-41`,`110-112` `UPDATE messages SET state = 'consuming' WHERE id = ? AND state = 'pending'`; (b) the turn ends with `this.deps.mailbox.markConsumed(msg.messageId)` (`agent-runtime.ts:720`) → `message.repo.ts:42-44` `UPDATE messages SET state = 'consumed', consumed_at = ?`; (c) `processMessage` may `transition` the task (`agent-runtime.ts:549` → `task-engine.ts:355` `UPDATE`); (d) harness processes can be spawned. **A GET is a mutation endpoint.**

### C2. `GET /api/system/monitor` sweeps process/terminal registries → in-memory mutation

`server/api/system/monitor.get.ts:12` `return getWorkshopManager().monitorRuntimeForUser(user)`; `manager.ts:894-895` `const snap = this.monitorRuntime()`; `manager.ts:814-816`:
```ts
  monitorRuntime(): RuntimeMonitorSnapshot {
    sweepHarnessProcesses()
    sweepTerminalSessions()
```
Both delete entries: `agents/harness-process.ts:92-98` `if (!e.alive && e.exitedAt !== null && now - e.exitedAt > retentionMs) { registry.delete(pid) }`; `agents/harness-terminal.ts:469-478` `sessions.delete(pid)`. In-memory only — no DB/disk write — but it is a read endpoint performing state repair (and it also mutates the response objects it returns: `manager.ts:863-870` assigns `ownerUserId` onto the views).

### C3. `GET /api/workshop/workspaces` deletes rows → **DB WRITE**

`server/api/workshop/workspaces/index.get.ts:10` `return getWorkshopManager().listWorkspaces(user.id)`; `manager.ts:1119-1131`:
```ts
  listWorkspaces(userId: string): Array<WorkspaceRow & { channelIds: string[] }> {
    return this.deps.repos.users.listWorkspaces(userId).map(ws => ({
      ...ws,
      // 挂载引用自愈:channel 删除(removeChannel)不级联清理 workspace_channels,
      // 死引用会让前端订阅永不到达(左栏"幽灵频道"+ 右栏空数据假象)——
      // 读取时过滤并顺手删除挂载行,历史脏数据随读取收敛
      channelIds: this.deps.repos.users.listMountedChannels(ws.id).filter((id) => {
        if (this.deps.repos.channels.findById(id)) return true
        this.deps.repos.users.unmountChannel(ws.id, id)
        return false
      }),
```
`db/user.repo.ts:93-95`:
```ts
    unmountChannel(workspaceId: string, channelId: string): void {
      deleteMount.run(workspaceId, channelId)
    },
```
A `DELETE` executed inside a `.filter()` callback of a GET.

### C4. `GET /api/workshop/users/me` reaches the same write

`server/api/workshop/users/me.get.ts:20` `workspaces: manager.listWorkspaces(user.id).length,` → C3 path.

### C5. Read-shaped methods that write (`touch` = `UPDATE`)

- `memory.ts:342-343` inside `recall()`: `for (const id of touched) this.repo.touch(id)`
- `memory.ts:360` inside `recallRows()`: `for (const s of scored) this.repo.touch(s.row.id)`
- `manager.ts:2670-2671` inside `recallOtherTeamsMemory` (surfaced by the `search_other_teams_memory` tool bridge `manager.ts:2719` and by REST):
```ts
    // 触摸命中行(access_count/last_accessed_at):与 recallRows 同信号,强化后续召回排序
    for (const r of rows) this.deps.repos.memories.touch(r.id)
```
`db/memory.repo.ts:78-80` `UPDATE agent_memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`.
So `manager.searchAgentMemories` (`1433-1447`), `listMemories`… and everything behind `recall*` are read paths that write. (`recall`'s `touch:false` escape hatch exists — `agent-runtime.ts:458` — and `supervise` uses it.)

### C6. GET paths verified **purely read-only**

- `server/api/workshop/runtime.get.ts:10` `return getWorkshopManager().runtimeStatus()` → `manager.ts:803-808` returns two derived arrays. Read-only.
- `server/api/workshop/agents/index.get.ts:11` (`listAgentsVisibleTo`), `agents/[id].get.ts:14-18` (`getAgent` + `requireTemplateReadable`). Read-only.
- `server/api/workshop/channels.get.ts:10` (`listChannelsForUser`). Read-only.
- `server/api/workshop/channels/[id]/agents/index.get.ts:24-26` (`listChannels()` + `listChannelAgents`) — read-only (note: full `listChannels()` scan to find one id).
- `server/api/workshop/channels/[id]/queue.get.ts:23` → `manager.ts:2417-2441` `queueOverview`; `requireMember` + reads. Read-only.
- `server/api/workshop/channels/[id]/messages/index.get.ts:41` `listRecentByChannel(channelId, query.limit ?? 50)` — read-only.
- `server/api/workshop/mailbox.get.ts:13` → `manager.ts:2834-2839` `pollMailbox` — the repo call is a pure `SELECT` (`db/message.repo.ts:91-98`); no claim/consume (deliberate: the file comment at `mailbox.get.ts:3` says `不改状态,消费由 AgentRuntime 循环完成`). Read-only.
- `server/api/workshop/mailbox/all.get.ts:15` → `listChannelMail` (read-only).
- `server/api/workshop/channels/[id]/tasks/index.get.ts:23` → `TaskEngine.list` — read-only (no limit; parses artifacts/history JSON for every task).
- `server/api/workshop/channels/[id]/events.get.ts:37-43` (`listRecent`/`listBefore`/`count`/`maxSeq`) — read-only.
- `server/api/workshop/channels/[id]/terminals.get.ts:20` (`listTerminalSessions`) — read-only in-memory.
- `server/api/workshop/hitl/pending.get.ts:23-27` (`listChannelsForUser` + `getHitlRegistry().snapshot()`) — read-only.
- `channels/[id]/memories/index.get.ts:27` (`listTeamMemories`), `channels/[id]/agents/[agentId]/memories/index.get.ts:28` (`listMemories`) — read-only (no touch).
- `teams/*.get.ts`, `channel-templates/*.get.ts`, `permissions/index.get.ts`, `ops-logs/index.get.ts`, `dcw/*.get.ts` (verified `recipe-rollback-manager.ts:627-649 ledger()` and `652-654 journal()` are pure reads), `aml/*.get.ts`, `assets/*`, `daq/*.get.ts`, `device-twins/index.get.ts`, `agent-tools/*.get.ts`, `harnesses*.get.ts`, `plugins/*.get.ts` — no write verb found by grep of all `*.get.ts` under `server/api` for `update|delete|remove|insert|save|flush|prune|purge|gc|truncate|reset|migrate|reindex|refresh`, `.touch(|.upsert(|.claim(|markConsumed|.create(|.close(|writeFile|appendFile`; the only hits were the ones in C1–C4 plus in-memory `push`/`set` on locals.

**Summary:** the GET surface contains exactly **one** DB-mutating endpoint (`channels/[id]/index.get.ts` → runtimes + message/task rows), **one** in-memory state-repair endpoint (`system/monitor.get.ts` → sweeps), and **two** DB-deleting endpoints (`workspaces/index.get.ts`, `users/me.get.ts` → `unmountChannel`).

---

## D. `manager.ts` responsibility map (3016 lines) + extraction seams

### D1. Section inventory (exact ranges)

| lines | responsibility |
|---|---|
| 1-54 | file docblock + imports (logger, fs, crypto, sqlite, 15 repos, mailbox/runtime factories, harness registry, plugins, memory, settings) |
| 55 | `const log = createLogger('workshop.manager')` |
| 57-79 | DI contracts: `AllRepos` (12 repos), `ManagerDeps` |
| 81-104 | auth principal `ActingUser` + `AgentTemplateDetail` DTO |
| 106-145 | DTOs `AgentTeamDetail`, `ChannelTemplateDetail` |
| 147-206 | row→DTO mappers: `instanceToAgentInfo`, `rowToTask`, `rowToChannelMail`, `buildMessage` |
| 208-224 | `parseChannelLlm`, `runtimeKey` |
| 226-243 | `KNOWN_HARNESSES`, module-level `ownerNameCache` + `resolveOwnerName` |
| 245-314 | monitor view DTOs (`RuntimeChannelView`, `RuntimeAgentView`, `RuntimeProcessView`, `RuntimeMonitorSnapshot`) |
| 316-330 | class fields (runtime indexes, timers, embedder, `reflectCounts`, `lastToolInvokeAt`) |
| 331-349 | ctor: memory-maintenance interval + idle reflection timer |
| 351-373 | `getTaskEngine` (lazy singleton + onTaskChange wiring) |
| 375-394 | `ensureChannelRuntime` (creates ChannelRuntime + bus + team-task hook) |
| 396-458 | team-history sinking: `recordTeamTaskTerminal`, `refreshChronicle` |
| 460-492 | sleep-time reflection: `reflectIdleMemories` |
| 494-591 | `buildBus` (6 typed listener registries + dispatchers) |
| 593-627 | public subscription façade (agent status / events / tasks / messages / memory / member) |
| 629-639 | private `notifyTask` / `notifyMember` |
| 641-691 | runtime wiring: `wireMember`, `ensureAgentRuntime`, `runtimeOf` |
| 693-720 | `ensureChannelActive` (lead wire + SchedulerLoop + loop-resubmit callback) |
| 722-801 | lifecycle: `stopAndDetach`, `unloadAgent`, `unloadIdleAgents`, `startIdleSweeper` |
| 803-808 | `runtimeStatus` |
| 810-946 | monitoring: `monitorRuntime`, `monitorRuntimeForUser` |
| 948-996 | process control: `terminateRuntimeProcess`, `killHarnessProcessByPid`, `shutdown` |
| 998-1044 | `buildWorkspace` (the 25-method agent capability surface) |
| 1046-1115 | user/auth surface: `registerUser`, `getUserByToken`, `requireOwned`, `requireWritable`, `requireTemplateReadable`, `getChannelForUser`, `listChannelsForUser` |
| 1117-1163 | Workspace CRUD + mount/unmount |
| 1165-1291 | Channel lifecycle: `createChannel`, `getChannel`, `updateChannel`, `unloadChannelAgents`, `updateChannelWorkspace`, `ensureWorkspaceDir`, `channelWorkspace`, `listChannels`, `removeChannel` |
| 1293-1365 | Agent-template CRUD + `templateDetailOf` |
| 1367-1418 | Channel-instance CRUD: `addAgentToChannel`, `listChannelAgents` |
| 1420-1447 | memory read surface: `listMemories`, `searchAgentMemories` |
| 1449-1497 | team shared-memory domain: `listTeamMemories`, `addTeamMemory`, `deleteTeamMemory`, `runMemoryMaintenanceNow` |
| 1499-1556 | per-agent memory curation: `addAgentMemory`, `deleteAgentMemory` |
| 1558-1616 | instance detail/update/remove: `getChannelAgent`, `updateChannelAgent`, `removeAgentFromChannel` |
| 1618-1758 | lead self-service team mgmt: `createTeamMember`, `updateTeamMember`, `removeTeamMember`, `pickReceiverWorker` |
| 1760-1893 | AgentTeam CRUD + `deployTeamToChannel` + `teamDetailOf` |
| 1895-2041 | ChannelTemplate CRUD + `instantiateChannelTemplate` + `assertHarness` + `channelTemplateDetailOf` |
| 2043-2120 | `submitChannelTask` (HITL task ingress) |
| 2122-2204 | `dispatchTask` |
| 2206-2270 | `refuseTask` |
| 2272-2300 | `reportTask` |
| 2302-2335 | `completeTask` |
| 2337-2353 | `cancelTask` |
| 2355-2378 | `stopAgentRuntime` (HITL) |
| 2380-2399 | `retryTask` |
| 2401-2414 | `listTasks`, `getTask`, `myQueue` |
| 2416-2441 | `queueOverview` |
| 2443-2476 | `updateTask`, `reassignTask` |
| 2478-2498 | `sendA2A` |
| 2500-2531 | `sendImmediateMessage` |
| 2533-2605 | `sendCrossChannelMessage` |
| 2607-2644 | `listOtherTeamsOverview` |
| 2646-2689 | `recallOtherTeamsMemory` + `otherSameOwnerChannels` |
| 2691-2738 | `invokeAgentWorkspaceTool` (collaboration tool bridge) |
| 2740-2789 | `invokeHostTool` (plugin/impl/fallback dispatch + `lastToolInvokeAt`) |
| 2791-2823 | `resolveAgentByToken`, `hostToolDefsFor`, `respondHarnessHitl` |
| 2825-2893 | mailbox/mail REST surface: `waitMailbox`, `pollMailbox`, `ackMailbox`, `listChannelMail`, `subscribe`, `findByToken` |
| 2895-2936 | `restore()` (crash recovery / redelivery) |
| 2938-2999 | internal helpers: `route`, `wakeAgent`, `resolveMemberRef`, `resolveChannelMember`, `requireMember`, `requireTaskInScope` |
| 3000-3016 | factory `createAgentChannelManager` + module singleton `initWorkshopManager`/`getWorkshopManagerOrNull` |

### D2. Proposed extraction seams (file → line range)

1. **`runtime/manager-dto.ts`** ← 57-314. `AllRepos`, `ManagerDeps`, `ActingUser`, all 4 detail DTOs + 4 monitor DTOs. Zero behaviour; pure types. Also move the mappers 147-224 here (or to `manager-mappers.ts`).
2. **`runtime/manager-auth.ts`** ← 1046-1115. `registerUser`, `getUserByToken`, `requireOwned`, `requireWritable`, `requireTemplateReadable`, `getChannelForUser`, `listChannelsForUser`. Pure guards; export a small `AuthService` taking `{ users, channels }`.
3. **`runtime/user-name-cache.ts`** ← 226-243. `ownerNameCache` + `resolveOwnerName` — and this is where the LRU fix (`shared/lru.mjs`) lands. Extracting it makes the leak a one-file change.
4. **`runtime/channel-lifecycle.ts`** ← 375-394 + 693-801 + 1165-1291 + 948-996. Everything that creates/stops/wires/unloads runtimes and channels (`ensureChannelRuntime`, `wireMember`, `ensureAgentRuntime`, `runtimeOf`, `ensureChannelActive`, `stopAndDetach`, `unloadAgent`, `unloadIdleAgents`, `startIdleSweeper`, `createChannel`…`removeChannel`, `terminateRuntimeProcess`, `killHarnessProcessByPid`, `shutdown`). This is the cluster that owns the `channels`/`agentIndex`/`buses` maps (317-320) — the maps must move with it.
5. **`runtime/channel-bus.ts`** ← 494-639. `buildBus` + subscription façade + private notify helpers. Self-contained (6 Sets, 1 dependency on `ChannelRuntime`).
6. **`runtime/runtime-monitor.ts`** ← 245-314 DTO part is in (1); move 803-946 here: `runtimeStatus`, `monitorRuntime`, `monitorRuntimeForUser`, plus the harness/terminal sweep calls (815-816). This also isolates the read-path mutation found in C2.
7. **`runtime/workspace-service.ts`** ← 1117-1163 (`listWorkspaces`…`unmountChannelFromWorkspace`), which also isolates the C3/C4 read-path DELETE.
8. **`runtime/agent-templates.ts`** ← 1293-1365 + 1367-1418 (`createAgent`…`removeAgent`, `templateDetailOf`, `addAgentToChannel`, `listChannelAgents`).
9. **`runtime/team-templates.ts`** ← 1760-1893 (`createTeam`…`deployTeamToChannel`, `teamDetailOf`) — the N+1 in D/B2-3 lives here.
10. **`runtime/channel-templates.ts`** ← 1895-2041 (`listChannelTemplatesVisibleTo`…`channelTemplateDetailOf`, `assertHarness`).
11. **`runtime/task-service.ts`** ← 2043-2476 (`submitChannelTask`…`reassignTask`), i.e. the whole agent-facing task作业面 + HITL stop/retry.
12. **`runtime/messaging.ts`** ← 2478-2689 (`sendA2A`, `sendImmediateMessage`, `sendCrossChannelMessage`, `listOtherTeamsOverview`, `recallOtherTeamsMemory`, `otherSameOwnerChannels`) + 2825-2893 (`waitMailbox`…`findByToken`) + `route`/`wakeAgent` (2938-2948).
13. **`runtime/memory-curation.ts`** ← 1420-1556 (`listMemories`…`deleteAgentMemory`, `runMemoryMaintenanceNow`) + 396-492 (`recordTeamTaskTerminal`, `refreshChronicle`, `reflectIdleMemories`) — the latter carries the `reflectCounts` leak, so it moves with the map.
14. **`runtime/host-tool-dispatch.ts`** ← 2691-2823 (`invokeAgentWorkspaceTool`, `invokeHostTool`, `resolveAgentByToken`, `hostToolDefsFor`, `respondHarnessHitl`) + 2791-2797; carries `lastToolInvokeAt` (2757).
15. **`runtime/member-resolution.ts`** ← 2938-2999 (`resolveMemberRef`, `resolveChannelMember`, `requireMember`, `requireTaskInScope`).
16. **`runtime/restore.ts`** ← 2895-2936 (`restore`) — depends on most of the above, so extract last.
17. Left in `manager.ts`: 1-55, 316-373 (class shell, fields, ctor timers, `getTaskEngine`), 998-1044 (`buildWorkspace` façade delegating to the extracted services), 3000-3016 (factory/singleton). Target size ≈ 250-350 lines.

Ordering constraint: extract (1)(3)(5)(15) first (leaf, no behaviour), then (4)(6)(7)(8)(9)(10)(11)(12)(13)(14) behind the manager façade, then (2)(16). Nothing outside `server/`/`scripts/` imports internals except `server/api/workshop/channels/[id]/tasks/index.get.ts:15` and `[id]/messages/index.get.ts:27` and `a2a/[agentId]/rpc/index.post.ts:207` which reach through `manager as unknown as {...}` casts — those casts must be replaced by the new services' public methods.

---

## E. Correctness

### E1. Ids/names captured once and used after a reload/rename

**E1a — rename/reconfigure while busy leaves a stale runtime (confirmed).**
`manager.ts:1579-1581`:
```ts
    const updated = this.deps.repos.channelAgents.update(instanceId, patch)
    if (!updated) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${instanceId}`)
    await this.unloadAgent(updated.channelId, instanceId)
```
`manager.ts:745-756` returns early unless the runtime is idle with an empty mailbox:
```ts
  async unloadAgent(channelId: string, agentId: string): Promise<void> {
    const runtime = this.runtimeOf(channelId, agentId)
    if (!runtime) return
    if (runtime.getState() !== 'idle') return
    if (this.deps.repos.messages.listPendingByChannelAgent(channelId, agentId).length > 0) return
```
But `AgentRuntime` froze identity at construction — `agent-runtime.ts:196-200`:
```ts
    this.agentId = agent.id
    this.role = agent.role
    this.channelId = agent.channelId
    this.name = agent.name
```
and `name` is what `getStatus()` reports (`agent-runtime.ts:220`) and what the scheduler counts (`channel-runtime.ts:48`). So a **busy** member renamed via `PATCH` keeps the old name in every status frame until it happens to go idle; a member disabled (`enabled: 0`) while busy keeps running and keeps consuming its mailbox — `AgentRuntime` has no `enabled` re-check anywhere in `consumeLoop`/`processMessage` (there is none at `agent-runtime.ts:511-523` or `525-725`), so a "disabled" worker can still complete tasks. `removeAgentFromChannel` is different: it uses the forced path (`manager.ts:1600` `await this.stopAndDetach(channelId, instanceId)`).
Also `config` (harness/model/cwd/scenarioPrompt) is baked into the impl at wire time — `manager.ts:653-666` — so a config patch without a successful unload never reaches the running harness.

**E1b — `LoopController` replays a frozen title/description (confirmed).**
`execution-mode.ts:119-126`:
```ts
  constructor(
    private readonly channelId: string,
    private readonly taskTitle: string,
    private readonly taskDescription: string,
    private readonly intervalMs: number,
    private readonly maxIterations: number,
    private readonly onResubmit: (title: string, description: string) => void,
  ) {}
```
constructed from the *current* task at `scheduler-loop.ts:779-786` and replayed verbatim at `execution-mode.ts:134` `this.onResubmit(this.taskTitle, this.taskDescription)`. After `updateTask` (task-engine.ts:164-193) renames the loop task, every subsequent iteration recreates the OLD title. Worse: `submitChannelTask`'s duplicate guard (`manager.ts:2075-2080`, `409 TASK_DUPLICATE`) can reject the replay, and the callback only logs — `manager.ts:710-717`:
```ts
    loop.setLoopResubmitCallback((title, description) => {
      this.submitChannelTask({ channelId, title, description }).catch((err) => {
        // 清理竞态:channel 已删除/lead 已卸载时的到期重放 → 静默(NOT_FOUND 为预期)
        const code = (err as { code?: string }).code
        if (code === 'NOT_FOUND' || code === 'NO_LEAD_AGENT') return
        log.error(`[AgentChannelManager:${channelId}] loop 重新提交失败:`, err)
```
`TASK_DUPLICATE` is not in the silent list ⇒ error log only; and because `LoopController.onTaskCompleted()` already incremented `iterations` and armed the timer (`execution-mode.ts:129-136`), no further completion event can re-arm it — the loop dies silently with no UI signal.

**E1c — lead reference:** `scheduler-loop.ts:100-109` captures `private readonly lead: AgentRuntime`; correctly torn down for the lead in `manager.ts:728-731` (`if (runtime.role === 'lead' && cr) { cr.scheduler?.stop(); cr.scheduler = null }`). OK.

**E1d — `Mailbox` files rows under `message.contextId`, not under its own channel (latent).**
`mailbox.ts:60-72`:
```ts
  enqueue(message: A2AMessage): void {
    if (this.closed) return
    this.messageRepo.create({
      // 保留发送方 messageId 作为落库 id:API 返回的 messageId 才能与历史/状态一致关联
      id: message.messageId,
      channelId: message.contextId,
```
while dequeue can only ever see its own channel — `mailbox.ts:98` `const row = this.messageRepo.firstPendingByChannelAgent(this.channelId, this.agentId)`. Any caller that routes a message whose `contextId` ≠ the target channel silently writes an unreachable pending row (the channel guard `channel-runtime.ts:98-123` does not check `contextId`). All in-file call sites build the message with the routed channel (`manager.ts:2109`, `2190`, `2486`, `2525`, `2585`; `scheduler-loop.ts:653-662`), so this is latent, not observed. ⚠

**E1e — mitigations that exist:** `resolveMemberRef` (`manager.ts:2956-2976`) resolves stale/renamed references by instance id → template id → case-insensitive name → unique substring, and on failure returns the whole roster in the error so the LLM can self-correct. `taskIdOf` (`agent-runtime.ts:785-787`) accepts `msg.taskId ?? metadata['x-aw-task-id']`. `channel-runtime.ts:164` re-resolves the target through `ensureAgent` on every route (so a deleted target fails loudly instead of silently).

**E1f — fan-out shares one messageId as a PRIMARY KEY (latent).** `channel-runtime.ts:71-80`:
```ts
    const delivered: string[] = []
    for (const agentId of this.resolveRecipients(message)) {
      const agent = this.ensureAgent(agentId)
      if (!agent) continue
      agent.enqueue(message)
```
with `mailbox.ts:64` `id: message.messageId` and `db/database.ts:63-64` `CREATE TABLE IF NOT EXISTS messages ( id TEXT PRIMARY KEY,`. `resolveRecipients` returns more than one id only in its broadcast/subscription branches — `channel-runtime.ts:180-187`:
```ts
    if (sender == null) {
      // 广播仅覆盖已装配的成员(不触发全量懒加载,避免广播唤醒整个 channel)
      return [...this.agents.keys()]
    }
    return this.deps.subscriptionRepo
      .listByTarget(this.channelId, sender as string)
      .map(s => s.agentId)
```
Every `route()` caller in the repo sets `x-aw-target-agent` or `x-aw-task-kind` (grep of `route(`: `manager.ts:2111/2196/2266/2493/2526/2595`, `scheduler-loop.ts:663`, `channel-runtime.ts:65`), and the `broadcast_message` tool deliberately loops with a fresh message per recipient (`host-tool-bridge.ts:462-470`). **⚠UNVERIFIED reachability: no current caller reaches the multi-recipient branch**, so this is a latent UNIQUE-constraint failure, not an observed one.

### E2. Message ordering / races

- **FIFO is real and deterministic:** `db/message.repo.ts:31-38` orders by `createdAt ASC, rowid ASC` with a `LIMIT 1` head query, and the atomic claim (`110-112`) is a single conditional UPDATE, so two consumers cannot both take the head (`mailbox.ts:100-103`).
- **Gate race handled explicitly** — `mailbox.ts:95-104` takes the gate reference *before* the query, with a 15 s self-healing fallback (`105-109`).
- **Scheduler tick vs. lead message arrival: serialized.** `scheduler-loop.ts:170` `await this.lead.withExecLock(() => this.tickRound())` and `agent-runtime.ts:517` `await this.withExecLock(() => this.processMessage(msg))` share the same promise-chain lock (`agent-runtime.ts:493-508`), so a scheduler round and a lead turn cannot interleave. Wake-ups during a round are coalesced, not lost (`scheduler-loop.ts:124-132`, `176-186`).
- **Race 1 (ordering):** `injectSteer` claims a message that need not be the queue head and pushes it into the *running* turn — `agent-runtime.ts:276` `if (!this.deps.mailbox.claim(message.messageId)) return`, then `294` `this.impl.steer(...)`. A later-arriving immediate human message can therefore be seen before earlier pending peer messages. Narrowed deliberately to human urgent sends only (`268-274`).
- **Race 2 (double delivery):** `peek`/`waitPending` never claim — `mailbox.ts:119-121` `return this.messageRepo.listPendingByChannelAgent(...).map(rowToMessage)`; `agent-runtime.ts:331` `const msgs = await this.deps.mailbox.peek(limit)`; the ack is deferred to the tool (`host-tool-bridge.ts:404-408`) or `manager.ts:2853`. In the window between peeking and acking, `Mailbox.dequeue` can claim the same row (`mailbox.ts:102`), so the agent processes it as a run *in addition to* having received it as a poll result. The later `ackMailbox` claim then fails (`manager.ts:2853` guards on `claim`) so it is not consumed twice at the DB level, but read/processed ordering is not guaranteed.
- **Race 3 (TOCTOU on the snapshot):** `tickRound` collects the snapshot at `scheduler-loop.ts:193` and executes decisions at `228-235` against that stale view. Guards exist per decision kind — dispatch/reassign re-verify the target (`578-582`, `601-605`), complete is idempotent (`624-627`) — and residual `AppError`s are swallowed by the per-decision `catch` at `229-234` (`log.error(... 执行决策失败 ...)`).
- **Race 4 (cancel vs. just-finished turn):** `scheduler-loop.ts:610-618` cancels then aborts the assignee (`if (assignee && assignee.getState() === 'busy') assignee.abortCurrent()`), which can abort a turn that just produced its deliverable; mitigated at the event level by the terminal-state guard `task-engine.ts:369-371` and at the task level by `agent-runtime.ts:625` (`after.state === 'WORKING'` re-check).
- **Recovery ordering:** `restore()` resets `consuming → pending` first (`manager.ts:2902`), then computes parent ids from all tasks of active channels (`2917-2922`) before re-delivering leaf assigns (`2923-2928`) and waking pending targets (`2933-2935`). Consistent.

### E3. Timeout / retry logic

- **No timeout in the runtime core for a task turn.** `agent-runtime.ts:580` consumes the stream with no deadline: `for await (const event of this.impl.run(request, ctx)) {`.
- **Timeouts that do exist, all impl-level:**
  - omp turn idle watchdog default 600 s — `agents/omp-agent.ts:834-838`: `// 停滞看门狗:整轮无任何 omp 事件(挂死的 LLM 调用/子进程僵死)时中止回合` / `const idleTimeoutMs = this.config.promptTimeoutMs ?? 600_000`.
  - supervise turn timeout 150 s — `agents/omp-agent.ts:575-576`: `const timeoutMs = this.config.superviseTimeoutMs ?? 150_000`.
  - a2a RPC task wait 30 s — `a2a/[agentId]/rpc/index.post.ts:229-238` (`waitTerminal(..., timeoutMs = 30_000)`).
  - embeddings: 10 s request timeout, 3 failures → 10 min breaker — `embedding-provider.ts:16-18`.
  - `poll_messages` wait clamped to 180 s — `host-tool-bridge.ts:395` `const waitSec = Math.min(180, Math.max(0, Number(args.wait_seconds ?? 0) || 0))`.
- **Retry ladder:** per-message re-queue ≤ 2 (`agent-runtime.ts:700-708`); task-level reassign while `retryCount < 3` (`scheduler-loop.ts:415-433`); `mailbox.dequeue` re-check every 15 s (`mailbox.ts:105-109`); `waitPending` re-check every 250 ms (`agent-runtime.ts:335`).
- **Loop mode has no global iteration cap:** `scheduler-loop.ts:776-777`:
```ts
    const intervalMs = Math.min(86_400_000, Math.max(100, Math.floor(modeInfo.config.intervalMs ?? 60_000)))
    const maxIterations = modeInfo.config.maxIterations ?? Number.POSITIVE_INFINITY
```
(`[max:N]` is only emitted when explicitly present, `execution-mode.ts:96-99`, clamped to ≤10 000.)
- **Watchdog cannot reclaim a busy agent.** `scheduler-loop.ts:459-478` only sends one notification, with the rationale in `441-443`: `是否 cancel 由 lead(supervise)判断,规则引擎对 busy 不强制取消 —— 只留可见信号,不做破坏性动作。` If `lead.supervise === null` (`scheduler-loop.ts:260` `if (this.lead.supervise === null) return false`), nothing ever cancels a busy task: the WORKING task and its runtime persist indefinitely (an unbounded resource hold by design).
- **Watchdog grace windows:** `stallMs` default `300000` (`scheduler-loop.ts:106`), goal close-out `goalGraceMs = 45_000` (`85`), close-out supervise cooldown 30 s (`266`), idle backoff cap `IDLE_TICK_CAP_MS = 8000` (`60`).

### E4. Error propagation to the UI — swallowed catches (verbatim)

- `scheduler-loop.ts:644` `void this.lead.recordTaskMemory(completed).catch(() => {})` — terminal memory harvest failure is invisible.
- `agent-runtime.ts:764-772` (`maybePostSettle`) ends with `.catch(() => {})` (`771`) — compaction failures never surface.
- `manager.ts:1478`, `manager.ts:1521`, `manager.ts:1540` — three `.catch(() => {})` on `vectorizeMemory` / shared-memory saves; the memory may silently stay FTS-only.
- `memory.ts:223` `catch { /* 向量不可用退化为 FTS */ }`; `memory.ts:612` `catch { /* 向量化失败留 FTS */ }`; `memory.ts:679` `catch { /* vec 未启用 */ }`.
- `mailbox.ts:74-79`:
```ts
    for (const cb of this.arrivalCbs) {
      try {
        cb()
      }
      catch { /* 回调异常不阻断投递 */ }
    }
```
- `manager.ts:213-219` (`parseChannelLlm`) and `manager.ts:235-240` (`resolveOwnerName`) are bare `catch { … return null }` — a corrupted `llm_json` silently degrades to "no channel default model", with no log at all.
- **Fire-and-forget member management** — the lead's own team-management decisions never report failure back to the lead or the UI; `scheduler-loop.ts:668-698`:
```ts
        void ws.createTeamMember({ ... }).catch((err) => {
          log.error(`[SchedulerLoop:${this.lead.agentId}] spawn_agent 决策执行失败:`, err)
        })
```
(same shape at `688-690` for `update_agent`, `695-697` for `remove_agent`). Contrast: errors on the `route()`/task paths *are* surfaced — e.g. `manager.ts:2494-2496` throws `502 DELIVERY_FAILED`, and turn failures emit a user-visible status event at `agent-runtime.ts:704-716` (`消息 … 回合失败,已重投信箱待重试(第 N 次)`).
- `manager.ts:785-787` — idle-sweeper unload failures only `log.error` (no event, no UI).

### E5. Concurrent session limits — **none for agent runtime**

There is no cap on the number of wired `AgentRuntime`s, hence none on concurrent agent turns or harness processes:
- `manager.ts:666-676` (`wireMember`) creates and starts unconditionally:
```ts
    const runtime = new AgentRuntime(agent, this.deps.implFactory(agentWithCtx), { ... })
    cr.addAgent(runtime)
    this.agentIndex.set(runtimeKey(m.channelId, agent.id), runtime)
    runtime.start()
```
- `manager.ts:679-687` (`ensureAgentRuntime`) wires on demand with no ceiling, and `createTeamMember` explicitly wires a new member at creation time (`manager.ts:1662` `this.ensureAgentRuntime(channelId, member.id)`).
- The only reclamation is the idle sweeper (`manager.ts:764-801`) with defaults `intervalMs ?? 60_000`, `graceMs ?? 120_000` (`765-766`), driven by settings at `plugins/workshop.ts:163-165`; and it refuses to unload anything busy or with pending mail (`745-754`).
- Per runtime, turns are serialized by `execLock` (`agent-runtime.ts:493-508`) and the single-consumer loop (`511-523`) — so the concurrency equals *the number of wired agents across all channels*, unbounded.
- The only concurrency limiter in the whole server is for AML jobs, not agents: `settings.ts:228` `maxConcurrent: Number(get('job.maxConcurrent', 2)),`, enforced at `aml/job-orchestrator.ts:257` `if (st.running.size >= Math.max(1, s.job.maxConcurrent)) return`. Nothing analogous exists for `AgentChannelManager`.

---

## Verification gaps (explicit)

- `⚠UNVERIFIED` — whether `implFactory` (`manager.ts:666`) spawns an OS process eagerly at wire time or only on the first `run`; the implementations are outside the audited file set.
- `⚠UNVERIFIED` — whether any WebSocket consumer (`server/api/workshop/ws.ts`, out of scope) can leak bus listeners; the audit only established that `manager.subscribe*` returns genuine unsubscribers (`manager.ts:593-627`).
- `⚠UNVERIFIED` — reachability of the multi-recipient `route()` branch that would collide on `messages.id PRIMARY KEY` (E1f). Structural only.
- `⚠UNVERIFIED` — behaviour of `dcw`/`daq`/`aml` GET endpoints beyond the grep evidence quoted in C6; they were not read line-by-line.

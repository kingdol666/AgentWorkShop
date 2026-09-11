# Audit — Agent runtime integration + node-binding access control

**Project**: AgentWorkShop (`D:\codes\ABO\AgentWorkShop`), Node.js / Nuxt 4
**Scope**: `server/services/workshop/agents/**`, `server/services/workshop/runtime/**`,
`server/services/workshop/permissions.ts`, `server/api/workshop/agents|agent-tools|dcw|daq/**`,
`server/api/workshop/runtime.get.ts`, `server/api/system/monitor.get.ts`, related repos.
**Mode**: read-only. I created/modified only `docs/audit/**` and `scripts/_audit/**` — no file under `server/` was written
by this session. Note that the working tree is **not** clean independent of this audit: at audit time
`git status --porcelain` reported **54 modified and 73 untracked files** on branch `main` (HEAD `b325d52`), including
files this report cites (`server/api/workshop/agent-tools/invoke.post.ts`,
`server/services/workshop/agents/industrial-tools.ts`, `server/services/workshop/runtime/manager.ts`,
`server/services/workshop/dcw/recipe-rollback-manager.ts`). Every `file:line` citation below describes that uncommitted
working-tree state, not HEAD. Sibling audits (`docs/audit/audit-daq.md:5`, `audit-dcw.md:5`) also assert "no source file
modified"; that assertion is about those audits, and it is consistent with this observation — the tree already carried
uncommitted changes when they ran.
**Method**: every finding below was read from the current working tree; code excerpts are quoted verbatim.
Claims I did not personally verify are marked `⚠UNVERIFIED` with the reason.

Severity: **P0** = authorization hole / unsafe mutation / leak · **P1** = correctness or performance ·
**P2** = duplication / hygiene.

---

## Executive summary

| # | Sev | Finding | Anchor |
|---|---|---|---|
| 1 | **P0** | `dcw_rollback(node_id=…)` writes **any** DCW node — no binding check, no HITL | `industrial-tools.ts:401-420`, `recipe-rollback-manager.ts:253-279` |
| 2 | **P0** | Manual-mode binding promise ("每次执行需用户批准") is bypassed by the rollback write path | `industrial-tools.ts:128-146`, `recipe-rollback-manager.ts:389-393` |
| 3 | **P0** | Tool bridge lets **any authenticated user act as any agent** (no agent-token header ⇒ token check skipped) | `agent-tools/invoke.post.ts:16-26`, `manager.ts:2746-2752` |
| 4 | **P0** | Stale-record takeover lets an unbound agent judge/roll back a node it was never granted | `industrial-tools.ts:381-383,413-416`, `recipe-rollback-manager.ts:198-201` |
| 5 | **P0** | `PATCH`/`DELETE /agent-tools/bindings/:id` let any user flip **any** binding to `auto` (strip HITL) or cancel another agent's pending approval | `bindings/[id].patch.ts:9-14`, `bindings/[id].delete.ts:10-20` |
| 6 | **P0** | `GET /agent-tools/bindings` (no `agentId`) returns the whole global grant table — enumeration primitive for #5 | `bindings/index.get.ts:12-13` |
| 7 | **P0** | `qwen`/`opencode` `supervise()` throw on every call (unimported identifiers / `.then` on an AsyncGenerator) — lead scheduling silently dies | `qwen-agent.ts:205-235`, `opencode-agent.ts:301-323` |
| 8 | **P0** | `opencode` session id is always `''` (`await` + ternary precedence) — first session leaked, ≥2.5 s penalty per start | `opencode-agent.ts:805-808` |
| 9 | **P0** | `omp` CLI `args` object has a duplicate key ⇒ **`--thinking` is never passed**; same bug in `goose` | `omp-agent.ts:1112-1113`, `goose-agent.ts:44-45` |
| 10 | P1 | `opencode-agent.ts:252` references an undefined `p` ⇒ HITL response throws *after* answering the engine, leaking the pending entry | `opencode-agent.ts:252-254` |
| 11 | P1 | `opencode` stdout and `harness-models` stderr are never drained ⇒ pipe-buffer deadlock | `opencode-agent.ts:745-748`, `harness-models.ts:55-58` |
| 12 | P1 | NDJSON partial-line handling missing in the loop shared by 13 harnesses (assistant text silently lost) | `one-shot-cli-agent.ts:406-428` |
| 13 | P1 | 6 of 9 adapters do **not** kill the child on turn timeout; only `killProcess()` uses the tree-killer, `dispose()` does not | `codex-agent.ts:463-469` etc., `stdio-jsonrpc.ts:205` |
| 14 | P1 | 13 timers are created and never cleared/unref'd; `omp-agent.ts:620`'s late fire aborts an **unrelated** live turn | `omp-agent.ts:620-629` |
| 15 | P1 | `omp-rpc-client.ts:269` adds an event listener per `start()`, never removed | `omp-rpc-client.ts:269` |
| 16 | P1 | 12 shadow `private` declarations override `BaseAgentImpl` privates — TypeScript rejects 3 classes outright | `codex-agent.ts:77`, `opencode-agent.ts:110` (TS2415) |
| 17 | P1 | `GET /api/workshop/channels/:id` boots runtimes and mutates the `messages` table | `channels/[id]/index.get.ts:16`, `manager.ts:694-720` |
| 18 | P1 | `GET /api/workshop/workspaces` and `/users/me` **DELETE** rows from inside a `.filter()` callback | `manager.ts:1125-1129` |
| 19 | P1 | `GET /api/workshop/daq` inserts node rows and starts the 250 ms acquisition timer | `daq/index.get.ts:20-22`, `daq-controller.ts:1146-1163` |
| 20 | P1 | Scheduler tick loads the channel's entire task history, every tick, forever | `task-engine.ts:137-139`, `task.repo.ts:80` |
| 21 | P1 | `runMemoryMaintenance` still does `limit=1_000_000` + JS-filter per agent | `runtime/memory.ts:668-674` |
| 22 | P1 | `limit: 1_000_000` / `10_000` used to fetch a single memory row by id | `manager.ts:1489`, `:1552` |
| 23 | P1 | `pickReceiverWorker` issues one task query per candidate (N+1) | `manager.ts:1744-1757` |
| 24 | P1 | `reflectCounts` / `lastToolInvokeAt` / `ownerNameCache` / `nameCache` / `probeCache` / `runErrorRetries` / `idleSince` are unbounded | §Q3 |
| 25 | P1 | Renaming or disabling a **busy** team member silently has no effect — a disabled worker keeps working | `manager.ts:1571-1581`, `:745-749` |
| 26 | P1 | No cap on concurrent agent child processes or team size | §Q7 |
| 27 | P1 | `Mailbox.dequeue` leaks a 15 s timer per idle poll | `mailbox.ts:106-109` |
| 28 | P2 | ≈1 500 duplicated lines across the 13 adapters (48 distinct duplication sites) | §Q8 |
| 29 | P2 | `manager.ts` is **3016** lines holding 16 unrelated subsystems | §Q9 |
| 30 | P2 | `harness-models.opencodeCatalog` leaks temp dirs containing copied provider credentials | `harness-models.ts:133,143` |

**Additional authz gaps reported by a delegated API sweep and only partly re-read by me — treat as `⚠UNVERIFIED` pending
confirmation**: ~40 `server/api/workshop/dcw/**` and `daq/**` handlers authenticate (`resolveUser`) but never call
`requireLineMode`/`requireRole` on the target resource, including `dcw/[id]/read.post.ts:12-17` (real driver read on any
node), `dcw/[id].patch.ts`, `dcw/lines/[id].delete.ts` (`?purge=1` cascade), `daq/[id].delete.ts`,
`daq/infra/reconnect.post.ts` (triggers `docker compose up -d`), the `test-driver` connect primitives
(caller-supplied driver config → outbound connections), and the analytics list endpoints
`dcw/recipes/index.get.ts`, `dcw/journal/index.get.ts`, `dcw/optimizations/*`, `daq/alarms.get.ts`
(the last two I did verify — see finding 31 below).

---

# P0 findings

### [P0] `dcw_rollback` writes any DCW node without any node-binding check

- **Where**: `server/services/workshop/agents/industrial-tools.ts:401-420` (the tool),
  `server/services/workshop/dcw/recipe-rollback-manager.ts:253-279` (`rollbackNode`),
  `server/services/workshop/dcw/recipe-rollback-manager.ts:403-410` (the only agent guard),
  `server/services/workshop/dcw/recipe-rollback-manager.ts:389-393` (the write).

- **Evidence**: the tool reads `node_id` and calls `rollbackNode` without ever consulting the binding repo:

```ts
// industrial-tools.ts:401-420
export async function toolDcwRollback(agentId: string, args: { record_id?: string, node_id?: string, to?: string }): Promise<{ text: string, isError?: boolean }> {
  const rb = getRecipeRollBackManager()
  const recordId = String(args.record_id ?? '').trim()
  const nodeId = String(args.node_id ?? '').trim()
  const to = String(args.to ?? '').trim() || undefined
  ...
    const fresh = await rb.rollbackNode(nodeId, agentId, 'agent', to, { actorName: agentBadgeLabel(agentId) })
```

`rollbackNode` validates existence, anchor presence, and cooldown — nothing else:

```ts
// recipe-rollback-manager.ts:253-279
async rollbackNode(nodeId: string, actor: string, by: 'agent' | 'user' | 'system', toAnchorId?: string, opts?: { actorName?: string }): Promise<OptimizationRecord> {
  const node = getDcwNodeRepo().byId(nodeId)
  if (!node)
    throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${nodeId}`)
  const anchor = toAnchorId ? this.repo.anchorById(toAnchorId) : this.repo.lastStableAnchor(nodeId)
  if (!anchor)
    throw new AppError(409, ErrorCodes.CONFLICT, `节点「${node.name}」无可回退锚(账本无 prevValue≠newValue 的历史)`)
  if (anchor.prevValue == null)
    throw new AppError(409, ErrorCodes.CONFLICT, '目标锚无基线值(首写锚),无法回退')
  if (by === 'agent')
    this.checkRollbackAllowed(nodeId)
  return this.executeRollbackWrite(
```

and the only agent guard is a cooldown:

```ts
// recipe-rollback-manager.ts:402-410
/** Agent 回退护栏:冷却(用户/系统兜底不受链限) */
private checkRollbackAllowed(nodeId: string): void {
  const rb = this.repo.lastRollbackAnchor(nodeId)
  if (rb) {
    const elapsed = Date.now() - Date.parse(rb.at)
    if (elapsed < COOLDOWN_MS())
      throw new AppError(409, ErrorCodes.CONFLICT, `回退冷却中:节点 ${Math.ceil((COOLDOWN_MS() - elapsed) / 1000)}s 内禁止再次回退`)
  }
}
```

Contrast the read/write tools, which all gate on the binding — e.g. `industrial-tools.ts:99-109`:

```ts
const repo = getAgentNodeBindingRepo()
const binding: AgentNodeBinding | undefined = nodeId ? repo.find(agentId, nodeId, 'dcw') : undefined
if (!binding) {
  const mine = repo.byAgent(agentId).filter(b => b.kind === 'dcw')
  return {
    text: mine.length
      ? `无权操作节点 ${nodeId || '(空)'}。你有权控制的数控节点:${mine.map(b => b.nodeId).join(', ')}(可用 my_industrial_nodes 查看物理含义)。`
      : '你尚未绑定任何数控节点,无权下发控制指令。请在数字孪生界面绑定数控节点。',
    isError: true,
  }
}
```

Exhaustive check: the only `.write(` call sites reachable from agent tools are `industrial-tools.ts:157` (gated) and
`recipe-rollback-manager.ts:296,320,352` (not gated by binding). `repo.find(agentId, nodeId, 'dcw')` appears in
`toolDcwControl`, `toolDcwRead`, and `toolRecipeUpdate` — never in `toolDcwRollback`.

- **Impact**: any agent, including one with **zero** bindings, can move a physical actuator. The target value comes from
  `lastStableAnchor(nodeId)` — an arbitrary historical setpoint — so the agent cannot choose the number, but it can still
  force an unrequested setpoint change on a line it was never granted, repeatedly (one rollback per `COOLDOWN_MS()`).
  `DcwController.write` still enforces range ∩ active-recipe-window (`dcw-controller.ts:519-531`), which bounds the
  *value* but not the *permission*: an in-window rollback succeeds silently. A compromised or merely confused worker can
  therefore perturb an unrelated or competitor line.

- **Fix**: in `toolDcwRollback`, add the same guard `toolDcwControl` uses, before both branches:

```ts
const repo = getAgentNodeBindingRepo()
if (recordId) { /* use record.nodeId */ }
else if (!repo.find(agentId, nodeId, 'dcw'))
  return { text: `无权回退节点 ${nodeId || '(空)'}…`, isError: true }
```

Better: enforce once inside `RecipeRollBackManager.rollbackNode` / `rollbackRecord` when `by === 'agent'` — a single
choke point that also covers future callers.

- **Verification**: create an agent with no bindings, then
  `POST /api/workshop/agent-tools/invoke {"agentId":"<that agent>","tool":"dcw_rollback","args":{"node_id":"<a dcw node bound only to another agent>"}}`
  → expect `isError:true 无权回退`; today it returns `回退已执行`. Static proof:
  `rg -n "repo.find\(agentId, nodeId, 'dcw'\)" server/services/workshop/agents/industrial-tools.ts` → 4 hits, none in
  `toolDcwRollback`.

---

### [P0] Manual-mode bindings do not gate the rollback write path

- **Where**: `server/services/workshop/agents/industrial-tools.ts:128-146` (the only HITL gate),
  `server/services/workshop/dcw/recipe-rollback-manager.ts:389-399`,
  `server/services/workshop/dcw/recipe-rollback-manager.ts:679-687`.

- **Evidence**: HITL approval exists **only** inside `toolDcwControl`:

```ts
// industrial-tools.ts:126-146
// 手动确认模式:挂起等待用户批准(备注会回给 Agent)
// 同 Agent 同节点的挂起审批去重:防止审批面板堆积(前一条未决,拒绝新的)
if (binding.mode === 'manual') {
  const approvals = getToolApprovals()
  if (approvals.hasPendingFor(agentId, nodeId)) {
    return { text: `你对该节点已有一条待审批的下发指令,请等待用户处理后再发新指令(避免审批堆积)。`, isError: true }
  }
  ...
  const ap = await approvals.request(agentId, nodeId, 'dcw', detail)
  if (!ap.approved) {
    return { text: `指令未执行:用户${ap.comment.includes('超时') ? '未在时限内批准(超时)' : `拒绝了本次下发`}。用户备注:${ap.comment || '(无)'}` }
  }
  // 审批期间节点可能被解绑/删除(权限在批准时失效):二次校验
  if (!repo.find(agentId, nodeId, 'dcw')) {
    return { text: '指令未执行:审批通过时你的该节点绑定已被解除(权限在批准时失效)。', isError: true }
  }
}
```

The rollback write routes straight to the controller:

```ts
// recipe-rollback-manager.ts:389-399
private async writeViaController(nodeId: string, eng: number, meta: DcwWriteMeta & { rollbackOf?: string }, approvalId?: string, toAnchorId?: string): Promise<void> {
  const { getDcwController } = await import('./dcw-controller')
  const outcome = await getDcwController().write(nodeId, eng, null, meta)
  if (outcome.ok === false)
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `回退下发未通过回读校验: ${outcome.message}`)
  if (toAnchorId || approvalId) {
```

`approvalId` is only recorded when the **caller** supplies it; `toolDcwRollback` never does. `resolvePolicy` reads the
binding's mode but is consulted only by the **system** sweeper:

```ts
// recipe-rollback-manager.ts:679-687
private resolvePolicy(nodeId: string, actor: string): 'auto_rollback' | 'approve_rollback' | 'observe_only' {
  if (actor && actor !== 'system') {
    const binding = getAgentNodeBindingRepo().byAgent(actor).find(b => b.kind === 'dcw' && b.nodeId === nodeId)
    if (binding)
      return binding.mode === 'manual' ? 'approve_rollback' : 'auto_rollback'
  }
  const anyBinding = getAgentNodeBindingRepo().byNode(nodeId).find(b => b.kind === 'dcw')
  return anyBinding ? (anyBinding.mode === 'manual' ? 'approve_rollback' : 'auto_rollback') : 'observe_only'
}
```

- **Impact**: the documented contract is false for rollbacks. `node-bindings.repo.ts:6` states
  `'manual' = 每次执行需用户批准(可附备注)`; the agent-facing manual at `industrial-tools.ts:203` says
  `手动确认模式的节点,下发前必须说明理由并等待用户批准`; `README.md:317` tells operators that
  `manual`-mode bindings "suspend the write for user approval … permission is re-checked when you click approve", and
  `README.md:64` claims DCW writes flow through `optional HITL approval`. An agent on a `manual` binding can execute an
  unapproved actuator write. Operators relying on manual mode as the human-in-the-loop stop for a line are not protected
  on this path.

- **Fix**: gate `toolDcwRollback` on `binding.mode === 'manual'` and route through `getToolApprovals().request(...)`, or
  centralise: have `executeRollbackWrite` request approval whenever `by === 'agent'` and
  `resolvePolicy(nodeId, actor) === 'approve_rollback'`.

- **Verification**: bind an agent `dcw` + `manual` to a node that has a stable anchor, invoke
  `dcw_rollback {node_id}` → expect a row in `GET /api/workshop/agent-tools/approvals` and **no** PLC write; today the
  write lands and the tool returns `回退已执行`.

---

### [P0] Tool bridge lets any dashboard user act as any agent (`agentId` is client-supplied and unbound from the caller)

- **Where**: `server/api/workshop/agent-tools/invoke.post.ts:16-26`,
  `server/services/workshop/runtime/manager.ts:2746-2752`.

- **Evidence**: the handler calls `resolveUser` but **discards** the result, then forwards the body's `agentId`:

```ts
// invoke.post.ts:16-26
export default defineApiHandler(async (event) => {
  const agentToken = getHeader(event, 'x-aw-agent-token')
  if (!agentToken) resolveUser(event) // 桥路径免用户鉴权,由 token 校验兜底
  const body = await readBody<{ agentId?: string, tool?: string, args?: Record<string, unknown> }>(event) ?? {}
  const agentId = String(body.agentId ?? '')
  const tool = String(body.tool ?? '')
  const args = body.args ?? {}
  if (!agentId) throw createError({ statusCode: 400, statusMessage: 'agentId required' })
  if (!tool) throw createError({ statusCode: 400, statusMessage: 'tool required' })
  const result = await getWorkshopManager().invokeHostTool({ agentId, tool, args, token: agentToken || undefined })
  return { result }
})
```

and the manager **skips** the token comparison when no token was supplied:

```ts
// manager.ts:2746-2752
async invokeHostTool(input: { agentId: string, token?: string, tool: string, args?: Record<string, unknown> }): Promise<{ text: string, isError?: boolean }> {
  const row = this.deps.repos.channelAgents.findById(input.agentId)
  if (!row || row.enabled !== 1) throw new AppError(404, 'NOT_FOUND', `agent 不存在或已停用: ${input.agentId}`)
  // token 鉴权(MCP 桥路径必带;缺省视为服务端内部调用,走 REST 已有用户鉴权)
  if (input.token !== undefined && input.token !== row.token) {
    throw new AppError(401, 'UNAUTHORIZED', 'agent token 校验失败')
  }
```

Because `invoke.post.ts` passes `token: agentToken || undefined`, a request **without** the `x-aw-agent-token` header
arrives with `token === undefined`, the comparison is skipped, and `identity.agentId` (used by every downstream binding
check in `host-tool-bridge.ts:162-211`) becomes the attacker-chosen agent.

Exact reachability matrix:
- **(a) valid user token + no `x-aw-agent-token`** → check skipped → **any tool as any `agentId`**. Vulnerable.
- **(b) no `Authorization` header at all** → `invoke.post.ts:18` calls `resolveUser`, which throws
  `AppError(401,'USER_UNAUTHORIZED')` (`caller.ts:71-79`) → blocked. Not anonymously reachable.
- **(c) someone else's agent token in the header** → `input.token !== row.token` → 401 → blocked.

The sibling endpoint gets it right, which highlights the asymmetry:

```ts
// agent-tools/list.get.ts:17-22
if (agentToken) {
  const resolved = getWorkshopManager().resolveAgentByToken(String(agentToken))
  if (!resolved || resolved.agentId !== agentId) {
    throw createError({ statusCode: 401, statusMessage: 'agent token 校验失败' })
  }
}
```

Note also that `invokeHostTool` applies **no** role filtering — it never consults `LEAD_ONLY_TOOL_NAMES`
(`host-tool-bridge.ts:33-43`); the `case` labels at `host-tool-bridge.ts:288-627` are unconditional.

- **Impact**: cross-agent and cross-channel privilege escalation by any authenticated user of any role, with no line
  grant required. Reachable by naming an agent id (enumerable — see the bindings-enumeration finding):
  `dcw_control` (real PLC write; HITL only when the *impersonated* agent's binding is `manual`), `recipe_update`,
  `recipe_rollback`, `dcw_judge`, `dcw_rollback`, `dispatch_task`, `create_team_agent`, `remove_team_agent`,
  `read_channel_mail`, `send_cross_channel_message`, `cancel_task`, `aml_dataset_build`, `aml_job_cancel`.
  `aml_model_promote` is lead-only but the check reads the DB role of the **supplied** `agentId`
  (`industrial-tools.ts:1291-1294`), so naming a lead passes it.
  Plugin tools receive the impersonated identity with no independent check (`manager.ts:2769-2775`).
  Two mitigations bound the blast radius: the request still needs a valid user token (case b), and a wrong agent token is
  rejected (case c). The hole is specifically *valid user token + arbitrary body `agentId` + no agent-token header*.

- **Fix**: mirror `list.get.ts` in `invoke.post.ts`: when `agentToken` is present, assert
  `resolveAgentByToken(agentToken)?.agentId === agentId`; otherwise resolve the user and assert it may act for that agent
  (channel ownership). Minimal hardening: in `manager.ts:2750` change to `if (input.token !== row.token)` and thread the
  authenticated principal through the REST fallback instead of `undefined`.

- **Verification**: log in as a plain `role:'user'` with no grants, then
  `POST /api/workshop/agent-tools/invoke {"agentId":"<another user's agent>","tool":"my_industrial_nodes"}` with **no**
  `x-aw-agent-token` header → today it returns that agent's bound nodes instead of 401/403.
  Static: `rg -n "input.token !== undefined" server/services/workshop/runtime/manager.ts` → 1 hit at line 2750.

---

### [P0] Stale-record takeover lets an unbound agent judge and roll back a node it was never granted

- **Where**: `server/services/workshop/agents/industrial-tools.ts:381-383` and `:413-416`,
  `server/services/workshop/dcw/recipe-rollback-manager.ts:198-201`.

- **Evidence**: ownership is checked against the *record's* `agentId`, but a stale record is treated as ownerless:

```ts
// industrial-tools.ts:381-383 (toolDcwJudge)
const takeover = record.agentId !== agentId && rb.isStale(record)
if (record.agentId !== agentId && !takeover)
  return { text: `记录 ${recordId} 不是你发起的优化(发起者:${record.agentId ?? '用户'}),Agent 仅可判定自己的记录;他人记录请请用户在界面判定。`, isError: true }
```

```ts
// industrial-tools.ts:409-417 (toolDcwRollback)
if (recordId) {
  const record = rb.recordById(recordId)
  if (!record)
    return { text: `优化记录 ${recordId} 不存在。`, isError: true }
  const takeover = record.agentId !== agentId && rb.isStale(record)
  if (record.agentId !== agentId && !takeover)
    return { text: `记录 ${recordId} 不是你发起的优化(发起者:${record.agentId ?? '用户'}),回退他人记录请请用户在数采中心/产线详情执行;若原属主已消失(超时未判定),可先 dcw_judge 接管后再回退。`, isError: true }
  const fresh = await rb.rollbackRecord(recordId, agentId, 'agent', undefined, { actorName: agentBadgeLabel(agentId) })
```

```ts
// recipe-rollback-manager.ts:198-201
/** 孤儿判定:open 记录超时未判定(属主可能已消失)→ 可被后续 Agent 接管 */
isStale(record: OptimizationRecord): boolean {
  return record.status === 'open' && Date.now() - Date.parse(record.setAt) > OPEN_RECORD_STALE_MS()
}
```

Neither takeover branch re-checks `repo.find(agentId, record.nodeId, 'dcw')`.

- **Impact**: after the staleness window of inactivity on **any** node in the plant, any agent in any channel can take
  over that node's open optimisation record and execute a rollback write on it — reusing the missing guard from the first
  finding. `dcw_journal` without `node_id` is scoped (`industrial-tools.ts:434-437`), but `recipe_id` is not
  (`:438`), and the takeover itself needs only a stale open record somewhere.

- **Fix**: add the binding predicate to both takeover branches:
  `const bound = getAgentNodeBindingRepo().find(agentId, record.nodeId, 'dcw'); const takeover = record.agentId !== agentId && rb.isStale(record) && !!bound`.

- **Verification**: seed an open record older than `OPEN_RECORD_STALE_MS` on node A owned by agent X, bind nobody to node
  A, then call `dcw_rollback {record_id}` as agent Y → expect refusal.
  `rg -n "OPEN_RECORD_STALE_MS" server/services/workshop/settings.ts` for the threshold to use in the test.

---

### [P0] `PATCH`/`DELETE /api/workshop/agent-tools/bindings/:id` let any user strip HITL from any agent's binding

- **Where**: `server/api/workshop/agent-tools/bindings/[id].patch.ts:9-14`,
  `server/api/workshop/agent-tools/bindings/[id].delete.ts:10-20`.

- **Evidence**: the PATCH authenticates and then mutates **by row id** with no ownership, line, or role check — no
  `lineMode`, no verification that the binding belongs to a channel the caller can see:

```ts
// bindings/[id].patch.ts:9-14
export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ mode?: 'auto' | 'manual' }>(event) ?? {}
  return { binding: getAgentNodeBindingRepo().setMode(id, body.mode ?? 'auto') }
})
```

The DELETE is the same shape and additionally force-denies the target agent's in-flight approval:

```ts
// bindings/[id].delete.ts:10-20
export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const repo = getAgentNodeBindingRepo()
  const all = repo.all()
  const binding = all.find(b => b.id === id)
  if (!binding) throw createError({ statusCode: 404, statusMessage: 'binding not found' })
  if (!repo.unbind(id)) throw createError({ statusCode: 404, statusMessage: 'binding not found' })
  // 解绑即失效:该 Agent 对该节点的挂起审批按拒绝收敛(tool result 注明原因)
  getToolApprovals().cancelPendingFor(binding.agentId, binding.nodeId)
  return { ok: true }
})
```

Note the contrast with the **create** path, which does check the line grant:

```ts
// bindings/index.post.ts:28-32
const mode = lineMode(user, lineId)
const needOperate = kind === 'dcw'
if (mode === 'none' || (needOperate && mode !== 'operate')) {
  throw new AppError(403, 'LINE_FORBIDDEN', `无该产线权限:绑定${kind === 'daq' ? '数采' : '写控'}节点需对产线「${lineId}」拥有${needOperate ? '可操控' : '仅查看'}及以上权限`)
}
```

(That create path has its own gap: it never resolves or authorizes `body.agentId` — `bind()` at
`node-bindings.repo.ts:73-78` only checks non-empty — and `bind()` silently re-modes an existing binding at `:78-83`
`if (prev) { prev.mode = mode; … }`. So a user with `operate` on one line can hand control to **any** agentId.)

- **Impact**: the manual-approval safety model is one PATCH away from being disabled. Any authenticated user who learns a
  binding id can flip a `dcw` binding from `manual` to `auto`, permanently removing human approval for that agent/node
  pair — the tool then evaluates `binding.mode === 'manual'` at `industrial-tools.ts:128` as false and writes immediately
  at `:157`. The DELETE variant is worse in effect: it unbinds a **victim's** agent and cancels that agent's pending
  approvals (`cancelPendingFor` → `tool-approvals.ts:112-127` resolves them as `denied` with `'绑定已解除,审批失效'`), so an
  attacker can silently veto a write an operator was about to authorise, and the audit trail blames a binding change.

- **Fix**: in both handlers, resolve the binding first, derive its node, and enforce
  `requireLineMode(user, nodeLine, 'operate')` (the same predicate as `bindings/index.post.ts:28-32`); additionally assert
  the caller owns or can read the agent's channel. Minimal PATCH version:
  `const b = repo.all().find(x => x.id === id); requireLineMode(user, lineOf(b), 'operate')`.

- **Verification**: as a `role:'user'` with `readonly` (or no) grant on the target line,
  `PATCH /api/workshop/agent-tools/bindings/<id> {"mode":"auto"}` → expect 403; today it returns 200 and
  `GET …/bindings?agentId=<victim>` shows `mode: "auto"`. Static:
  `rg -n "lineMode|requireLineMode|requireRole" server/api/workshop/agent-tools/bindings/\[id\].patch.ts` → 0 hits.

---

### [P0] `GET /api/workshop/agent-tools/bindings` enumerates every agent's node grants to any user

- **Where**: `server/api/workshop/agent-tools/bindings/index.get.ts:9-13`.

- **Evidence**:

```ts
// bindings/index.get.ts:12-13
const agentId = typeof q.agentId === 'string' ? q.agentId : ''
return { bindings: agentId ? getAgentNodeBindingRepo().byAgent(agentId) : getAgentNodeBindingRepo().all() }
```

`.all()` returns the entire global binding table — `agentId`, `nodeId`, `kind`, `mode`, `id`
(`node-bindings.repo.ts:22-29,48-50`) — for every agent in every channel, to any authenticated user, with no line or
ownership filter. Omitting `agentId` is the leak; supplying one is a targeted lookup.

- **Impact**: this is the enumeration primitive that makes the previous finding trivially exploitable — it hands the
  attacker the exact binding `id` needed by `[id].patch`/`[id].delete`, plus which agents control which physical nodes.
  It also discloses the plant's agent↔actuator map: which `nodeId` values are `kind:'dcw'` (writable) and which are
  `manual` (approval-gated) versus `auto`.

- **Fix**: require `agentId`, filter the result through `filterByLine(user, …)` on the node's line (or the agent's channel
  ownership), and allow the unfiltered form only for `admin`/`editor` — mirroring `agents/index.get.ts:11`'s
  `listAgentsVisibleTo(user)` pattern.

- **Verification**: as a `role:'user'` with no grants, `GET /api/workshop/agent-tools/bindings` (no query) → today returns
  every binding; after the fix expect 400 or an empty/filtered list. Static:
  `rg -n "filterByLine|lineMode|visibleLineIds" server/api/workshop/agent-tools/bindings/index.get.ts` → 0 hits.

---

### [P0] `qwen`/`opencode` `supervise()` throw on every call — lead scheduling silently dies

- **Where**: `server/services/workshop/agents/qwen-agent.ts:205-235`,
  `server/services/workshop/agents/opencode-agent.ts:301-323`,
  swallowed by `server/services/workshop/runtime/scheduler-loop.ts:309-312`.

- **Evidence**: `QwenAgentImpl.supervise` references three identifiers that are not imported and one method that does not
  exist. The file imports only four helpers:

```ts
// qwen-agent.ts:30
import { peerPrompt, systemManual, toolArgsPreview, workerPrompt } from './prompt-builder'
```

but the override uses `supervisePrompt`, `collectTurn`, `extractJsonArray`, and the base's `private supervising`.
`OpenCodeAgentImpl.supervise` calls `.then()` on an `AsyncGenerator`:

```ts
// opencode-agent.ts:301-323 (abridged)
return await this.runTurn(...).then((events) => { ... })
```

while `runTurn` is declared as an async generator (`opencode-agent.ts:396-402`
`protected async *runTurn(...): AsyncGenerator<AgentEvent, void, unknown>`).

**I reproduced both with the TypeScript compiler** (`npx tsc --noEmit --skipLibCheck --target esnext --module esnext
--moduleResolution bundler <files>`, module-internal errors only, alias-independent):

```
qwen-agent.ts(208,14): error TS2341: Property 'supervising' is private and only accessible within class 'BaseAgentImpl'.
qwen-agent.ts(209,20): error TS2304: Cannot find name 'supervisePrompt'.
qwen-agent.ts(217,10): error TS2341: Property 'supervising' is private and only accessible within class 'BaseAgentImpl'.
qwen-agent.ts(219,33): error TS2339: Property 'collectTurn' does not exist on type 'QwenAgentImpl'.
qwen-agent.ts(226,22): error TS2304: Cannot find name 'extractJsonArray'.
qwen-agent.ts(233,12): error TS2341: Property 'supervising' is private and only accessible within class 'BaseAgentImpl'.
opencode-agent.ts(310,8): error TS2339: Property 'then' does not exist on type 'AsyncGenerator<AgentEvent, void, unknown>'.
```

The failure is invisible because the scheduler swallows it:

```ts
// scheduler-loop.ts:309-312 (per the delegated runtime audit; the cycle is log-and-fall-back)
```

`BaseAgentImpl.supervise` itself (`base-agent.ts:137-166`) ends with `catch { return [] }` (`:160-162`), and
`opencode-agent.ts:320-323` has `}).catch(() => { this.supervising = false; return [] })`.

- **Impact**: for `qwen` and `opencode` leads, LLM-driven team scheduling never runs. Every tick falls back to the built-in
  rule engine, and the operator sees no error — only a team that never routes work the way its lead prompt describes.
  `opencode` additionally fails `collectTurnEvents` (see
  `opencode-agent.ts(110,14): error TS2515 Non-abstract class 'OpenCodeAgentImpl' does not implement inherited abstract
  member collectTurnEvents from class 'BaseAgentImpl'`), so its base `supervise` path is unusable too.

- **Fix**: `qwen-agent.ts:205-235` — either delete the override (inherit `BaseAgentImpl.supervise`) or import
  `supervisePrompt`/`extractJsonArray` from `./prompt-builder` and call `collectTurnEvents`; make `supervising` a
  `protected` member of `BaseAgentImpl` (`base-agent.ts:135`). `opencode-agent.ts:301-323` — replace
  `.then(...)` with a `for await` collection loop (or inherit the base), and implement `collectTurnEvents`.

- **Verification**: the four `tsc` commands above must produce zero errors for these files. Behavioural: configure a
  `qwen` (or `opencode`) lead, submit a goal, and assert `SchedulerLoop` logs a `supervise` result rather than the
  rule-engine fallback — or unit-test `lead.supervise(snapshot)` directly and assert it does not throw.

---

### [P0] `opencode` session id is always empty (`await` + ternary precedence) — first session leaked, ≥2.5 s start penalty

- **Where**: `server/services/workshop/agents/opencode-agent.ts:805-815`.

- **Evidence**:

```ts
// opencode-agent.ts:805-808
const created = await (this.config.permission ?? DEFAULT_PERMISSION)
  ? createWith({ permission: this.config.permission ?? DEFAULT_PERMISSION }).catch(() => createWith(undefined))
  : createWith(undefined)
this.sessionId = String(created?.id ?? '')
```

`await` binds tighter than `?:`, so the expression parses as
`(await (this.config.permission ?? DEFAULT_PERMISSION)) ? createWith(...) : createWith(undefined)` — `created` is a
**Promise**, not the session object. Compiler confirmation:

```
opencode-agent.ts(808,38): error TS2339: Property 'id' does not exist on type 'Promise<Record<string, unknown>>'.
```

Two secondary defects in the same expression: the ternary condition `this.config.permission ?? DEFAULT_PERMISSION` can
never be falsy (`DEFAULT_PERMISSION` is a non-empty array literal at `:82-86`), so the `:807` branch is dead; and the first
`createWith(...)` really does create a session server-side, which is then abandoned.

- **Impact**: `this.sessionId` is always `''`, so execution falls through to the 3× retry loop at `:811-815`
  (`await sleep(2500)`) on every `startServer()` — a guaranteed ≥2.5 s penalty, plus one orphaned opencode session per
  start. Any code keyed on `sessionId` (resume, event correlation) is silently operating on an empty id.

- **Fix**: parenthesise the whole value: `const created = await (cond ? createWith({permission}) : createWith(undefined)).catch(...)`,
  or simply `const created = await createWith({ permission: this.config.permission ?? DEFAULT_PERMISSION }).catch(() => createWith(undefined))`
  and drop the dead branch.

- **Verification**: `rg -n "const created = await \(" server/services/workshop/agents/opencode-agent.ts`, then the `tsc`
  command above must produce no `TS2339` at `:808`. Behavioural: start an opencode agent and assert
  `sessionId !== ''` after `startServer()`.

---

### [P0] Duplicate object keys mean `--thinking` is never passed to `omp` (and `goose` has the same defect)

- **Where**: `server/services/workshop/agents/omp-agent.ts:1112-1113`,
  `server/services/workshop/agents/goose-agent.ts:44-45`.

- **Evidence**:

```ts
// omp-agent.ts:1112-1113
args: [...(this.config.thinkingLevel ? ['--thinking', this.config.thinkingLevel] : [])],
args: this.config.args,
```

The second `args` key overwrites the first, so the deliberately constructed `--thinking <level>` argv is discarded and
only `config.args` survives. Compiler confirmation:

```
omp-agent.ts(1113,9): error TS1117: An object literal cannot have multiple properties with the same name.
goose-agent.ts(45,3): error TS1117: An object literal cannot have multiple properties with the same name.
```

- **Impact**: a configured reasoning/thinking level is silently ignored for every `omp` agent — the platform's default
  and recommended engine. Users see a configured-but-ineffective setting with no error. ⚠UNVERIFIED: the delegated
  adapter audit reports the same wrong argv is repeated at the monitoring registration (`omp-agent.ts:1131`); I verified
  the two lines above but not `:1131`.
  `goose-agent.ts:44-45` duplicates `promptDelivery: 'arg'` — same class of bug, currently harmless because both values
  are equal, but it hides any future divergence.

- **Fix**: merge rather than shadow — `args: [...(this.config.thinkingLevel ? ['--thinking', this.config.thinkingLevel] : []), ...(Array.isArray(this.config.args) ? this.config.args : [])]`;
  delete the duplicate key in `goose-agent.ts:45`.

- **Verification**: the `tsc` invocation above must report no `TS1117` in either file. Behavioural: set
  `config.thinkingLevel` on an omp agent and assert `--thinking` appears in the spawned argv (it is observable in
  `registerHarnessProcess(pid, { harness, command, args })` → `listHarnessProcesses()`).

---

# P1 findings

### [P1] `opencode` HITL response throws on an undefined `p`, leaking the pending entry

- **Where**: `server/services/workshop/agents/opencode-agent.ts:252-254`, surfaced through
  `manager.ts:2810-2824` and `server/api/workshop/hitl/respond.post.ts`.

- **Evidence**: `p` is not in scope at this point (the `p` loop variables live in other functions):

```ts
// opencode-agent.ts:252-254
if (pending.timer) clearTimeout(p.timer)
this.pendingHitl.delete(id)
getHitlRegistry().resolve('opencode-dialog', id, 'answered')
```

Compiler confirmation: `opencode-agent.ts(252,37): error TS2304: Cannot find name 'p'.`
The statement order matters: the engine has already been answered by `:241-249`, so the throw happens **after** the
engine acts but **before** `pendingHitl.delete(id)` and `getHitlRegistry().resolve(...)`. The exception propagates to
`manager.respondHarnessHitl` (`manager.ts:2810-2824`) and out to the REST caller.

- **Impact**: every HITL approval for an opencode agent (a) returns HTTP 500 to the operator even though the engine
  accepted the decision, and (b) leaves the entry in `this.pendingHitl` and in the global `HitlRegistry.items`
  (`hitl-registry.ts:50`, only deleted at `:107-108`) forever — so the approvals panel keeps showing an already-answered
  request, and the fail-closed timer that was supposed to clean it up has already been cleared by the same `if`
  condition.

- **Fix**: `if (pending.timer) clearTimeout(pending.timer)` — i.e. reference the same object the surrounding code uses.

- **Verification**: `tsc` must show no `TS2304` at `opencode-agent.ts:252`. Behavioural: register an opencode HITL
  request, call `POST /api/workshop/hitl/respond`, assert HTTP 2xx and that
  `GET /api/workshop/hitl/pending` no longer contains the id.

---

### [P1] `opencode` stdout and `harness-models` stderr are never drained — pipe-buffer deadlock

- **Where**: `server/services/workshop/agents/opencode-agent.ts:745-748`,
  `server/services/workshop/agents/harness-models.ts:55-58`.

- **Evidence**: the spawn site reads only `stderr`, and `child.stdout` is never referenced anywhere in the file, although
  `opencode serve` is long-lived:

```ts
// opencode-agent.ts:734 (spawn) … :745-748 (only stderr is consumed)
```

`harness-models.ts:55-58` is the mirror image: only stdout is consumed, and the 45-60 s timeout is the only escape.
By contrast the correctly written consumers attach handlers to both streams and cap the tail, e.g.
`one-shot-cli-agent.ts:429-432` (`stderrTail = (stderrTail + chunk).slice(-8000)`).

- **Impact**: a Node child process whose stdout pipe fills (typically 64 KiB on Windows) blocks on write. For the
  long-lived `opencode serve` process, any burst of engine output beyond the pipe buffer stalls the engine mid-turn with
  no error surfaced; the turn then dies on the 600 s stall timer (`opencode-agent.ts:349,391` `?? 600_000`).
  `harness-models.ts` (`omp models list`, `opencode models`) has the same failure mode on stderr and will time out
  instead of reporting why.

- **Fix**: attach a consuming handler for the missing stream in both places —
  `child.stdout?.setEncoding('utf-8'); child.stdout?.on('data', …)` in `opencode-agent.ts` (feed the existing event
  mapper or discard), and `child.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-8000) })` in
  `harness-models.ts`.

- **Verification**: `rg -n "child\.stdout" server/services/workshop/agents/opencode-agent.ts` → 0 hits today.
  Behavioural: drive an opencode turn that produces >128 KiB of stdout and assert the turn completes.

---

### [P1] NDJSON partial-line handling missing in the loop shared by 13 harnesses

- **Where**: `server/services/workshop/agents/adapters/one-shot-cli-agent.ts:406-428`.

- **Evidence**: parse-per-chunk with no carry-over of a trailing partial line:

```ts
// one-shot-cli-agent.ts:404-419
child.stdout?.setEncoding('utf-8')
let stdoutAll = ''
child.stdout?.on('data', (chunk: string) => {
  if (this.spec.wholeJsonAtExit === true) {
    stdoutAll += chunk
    return
  }
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const json = tryParse(line)
    if (json === null) {
      // 无结构化输出面的引擎:stdout 纯文本行即回复增量;其余(横幅/告警)忽略
      if (this.spec.plainTextStdout === true) sink.delta(line)
      continue
    }
```

The two consumers that got it right keep a buffer and pop the incomplete tail:

```ts
// adapters/stdio-jsonrpc.ts:234-238
private onStdout(data: string): void {
  this.stdoutBuf += data
  if (this.stdoutBuf.length > 8 * 1024 * 1024) this.stdoutBuf = ''
  const lines = this.stdoutBuf.split('\n')
  this.stdoutBuf = lines.pop() ?? ''
```

```ts
// adapters/omp-rpc-client.ts:404-411
private onStdout(data: string): void {
  this.stdoutBuf += data
  if (this.stdoutBuf.length > STDOUT_LINE_CAP) {
    // 半行缓冲异常膨胀(对端异常流):丢弃已积累部分,防内存无界增长
    this.stdoutBuf = ''
  }
  const lines = this.stdoutBuf.split('\n')
  this.stdoutBuf = lines.pop() ?? ''
```

- **Impact**: when a JSON event frame straddles a pipe read boundary, the fragment fails `JSON.parse`, is silently
  dropped by `continue`, and the remainder is unparseable too — one lost event per split, i.e. lost assistant text and
  lost tool status for every `OneShotCliAgentImpl` subclass without `plainTextStdout`: `gemini`, `copilot`, `cursor`,
  `goose`, `pi`. `crush` sets `plainTextStdout: true` (`crush-agent.ts:67`) and survives but every fragment is
  `.trim()`-ed. Trigger: any single event larger than one pipe read (long assistant message, large tool result).
  A delegated audit executed a repro (`scripts/_audit/ndjson-partial-line-repro.mjs`) feeding the two chunks
  `{"type":"message","role":"assistant","content":"hello wor` + `ld"}\n{"type":"result",…}` and observed
  `frames=1 ["result"] drops=2` with `assistantText=""` — the entire message lost. ⚠UNVERIFIED: I read the code and
  confirmed the missing buffer; I did not re-run that repro script.

- **Fix**: hoist `let stdoutBuf = ''` next to `stdoutAll` (`one-shot-cli-agent.ts:405`) and change the loop to

```ts
stdoutBuf += chunk
const lines = stdoutBuf.split(/\r?\n/)
stdoutBuf = lines.pop() ?? ''
for (const rawLine of lines) { … }
```

- **Verification**: `rg -n "stdoutBuf" server/services/workshop/agents/adapters/one-shot-cli-agent.ts` → 0 hits today.
  `node scripts/_audit/ndjson-partial-line-repro.mjs` should report 0 dropped frames for the one-shot loop.

---

### [P1] Timeout paths in 6 of 9 adapters do not kill the child; `dispose()` uses single-process kill

- **Where**: `codex-agent.ts:463-469`, `claude-agent.ts:391-397`, `dsh-agent.ts:417-423`, `hermes-agent.ts:379-385`,
  `qwen-agent.ts:407-413`, `opencode-agent.ts:505-516` (timeouts); `adapters/stdio-jsonrpc.ts:192,205`,
  `adapters/omp-rpc-client.ts:237,382`, `adapters/one-shot-cli-agent.ts:263`, `harness-models.ts:61` (kills).

- **Evidence**: the only tree-killer in the codebase is `harness-process.ts:125-157`:

```ts
// harness-process.ts:129-151
if (process.platform === 'win32') {
  const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  ...
}
else {
  try {
    process.kill(-pid, 'SIGKILL')
```

`killProcess()` on each adapter uses it (e.g. `codex-agent.ts:134-138`), but `dispose()` on the same classes goes through
`stdio-jsonrpc.ts`, which kills only the direct child:

```ts
// adapters/stdio-jsonrpc.ts:199-207 (abridged)
this.child?.stdin?.end()
… 3 s timer …
this.child?.kill('SIGKILL')
```

and on timeout six adapters only send an engine-side interrupt/cancel, never killing the process.
`one-shot-cli-agent.ts:496` and `omp-agent.ts:915-928` do kill correctly.

- **Impact**: grandchildren of a killed harness (MCP bridge, spawned tool processes) survive; on POSIX they are
  reparented and become unreachable because the pid registry is process-local
  (`harness-process.ts:36 const registry = new Map<number, HarnessProcessEntry>()`). On timeout, a "cancelled" turn keeps
  burning tokens and holding file handles while the platform believes the turn ended. The asymmetry also means
  `/monitor`'s "kill process" button and the idle sweeper behave differently for the same agent.

- **Fix**: add `killTree(pid, child)` to `harness-process.ts` and route `stdio-jsonrpc.ts:205`, `omp-rpc-client.ts:382`,
  `one-shot-cli-agent.ts:263`, and `harness-models.ts:61` through it; on the six timeout paths call
  `this.killProcess()` after emitting the error event.

- **Verification**: `rg -n "kill\('SIGKILL'\)|killHarnessProcess" server/services/workshop/agents` → the single-process
  `kill('SIGKILL')` sites today. Behavioural: make a harness spawn a child, time out the turn, then assert
  `listHarnessProcesses()` / `tasklist` shows no surviving grandchild.

---

### [P1] 13 timers created and never cleared or unref'd; one can abort an unrelated live turn

- **Where**: `server/services/workshop/agents/omp-agent.ts:620-629` (the damaging one), plus
  `adapters/omp-rpc-client.ts:294`, `one-shot-cli-agent.ts:506-509`, `codex-agent.ts:431-433,473-476`,
  `claude-agent.ts:380-382,401-404`, `dsh-agent.ts:381-383,427-430`, `qwen-agent.ts:380-382,417-420`,
  `hermes-agent.ts:345-347,389-392`, `opencode-agent.ts:477`, `harness-models.ts:60-63`,
  `harness-terminal.ts:387-393`.

- **Evidence**: `omp-agent.ts:620` stores the handle but the early-return path above it does not clear it:

```ts
// omp-agent.ts:620
const timer = setTimeout(abortTurn, timeoutMs)
// omp-agent.ts:625-629 (early return — timer survives)
if (opts.signal.aborted) {
  unsub()
  resolve([])
  return
}
```

The timer's body sends an abort to the **shared** omp subprocess (`omp-agent.ts:596`
`void this.client?.send({ type: 'abort' }).catch(() => {})`), so it can cancel whatever turn is live when it fires.
`adapters/omp-rpc-client.ts:294` creates a 10 s ready-timeout with no stored handle, so it keeps the event loop
referenced for 10 s after every successful start. Only three `unref()` calls exist in the whole tree
(`tool-approvals.ts:83`, `harness-terminal.ts:301`, `opencode-agent.ts:92`), so no per-turn, stall-poll, or abort-fallback
timer is unref'd. The stall-poll timers in the six adapters are created without a variable at all
(`codex-agent.ts:473-476` etc.).

- **Impact**: (a) the `omp-agent.ts:620` late fire is a genuine correctness bug — an unrelated, healthy turn gets
  aborted, which the operator sees as a random failure; (b) the uncleared timers extend the event loop and add wakeup
  noise during shutdown, and `stdio-jsonrpc.ts:208`'s `once('exit')` handler also survives the timeout branch that
  resolved first; (c) memory: each uncleared stall-poll closure retains its round's state.

- **Fix**: store and clear every timer (`const timer = setTimeout(...)` + `clearTimeout(timer)` on all exits, including
  early returns), `unref?.()` the fire-and-forget ones, and in `stdio-jsonrpc.ts` remove the `once('exit')` listener in
  the timeout branch.

- **Verification**: `rg -n "setTimeout\(" server/services/workshop/agents | wc -l` and compare against
  `rg -n "clearTimeout\(" …`; the delta should be 0 for per-turn timers. Runtime:
  `process.getActiveResourcesInfo().filter(x => x === 'Timeout').length` must not grow across idle turns.

---

### [P1] `omp-rpc-client.ts:269` adds an event listener per `start()`, never removed

- **Where**: `server/services/workshop/agents/adapters/omp-rpc-client.ts:269` (+clear at `:397-399`).

- **Evidence**: each `start()` pushes a new closure into the listener set; only `dispose()` clears the set:

```ts
// omp-rpc-client.ts:269
this.eventListeners.add(onReady as (event: AgentSessionEvent) => void)
```

```ts
// omp-rpc-client.ts:397-399 (dispose)
this.rawFrameListeners.clear()
```

Each added closure also captures the resolve/reject of the *previous*, already-settled readiness promise.

- **Impact**: a client that is started more than once (restart after crash, reconcile-then-restart) accumulates
  listeners; every subsequent event fans out to N stale closures holding dead promises. Bounded by restart count rather
  than by event count, so it is a slow leak, but it also means a remount can resolve the wrong readiness promise.

- **Fix**: remove the previous `onReady` before adding a new one (keep the handle in a field), or clear
  `eventListeners` at the top of `start()`.

- **Verification**: `rg -n "eventListeners" server/services/workshop/agents/adapters/omp-rpc-client.ts` → 1 add, 1 clear
  (in dispose). Unit test: call `start()` twice and assert `eventListeners.size === 1`.

---

### [P1] 12 shadow `private` declarations override `BaseAgentImpl` privates — TypeScript rejects 3 classes outright

- **Where**: `server/services/workshop/agents/codex-agent.ts:71-77`, `opencode-agent.ts:110-119`, `dsh-agent.ts:82-88`,
  `qwen-agent.ts:111-114`, `hermes-agent.ts:64-67`, `omp-agent.ts:129,208`; base declarations at
  `base-agent.ts:49,54,135`.

- **Evidence**: the compiler reports the inheritance conflict:

```
omp-agent.ts(129,14):      error TS2415: Class 'OmpRpcAgentImpl' incorrectly extends base class 'BaseAgentImpl'.
opencode-agent.ts(110,14): error TS2415: Class 'OpenCodeAgentImpl' incorrectly extends base class 'BaseAgentImpl'.
qwen-agent.ts(111,14):     error TS2415: Class 'QwenAgentImpl' incorrectly extends base class 'BaseAgentImpl'.
opencode-agent.ts(110,14): error TS2515: Non-abstract class 'OpenCodeAgentImpl' does not implement inherited abstract member collectTurnEvents from class 'BaseAgentImpl'.
opencode-agent.ts(158,5):  error TS2322: Type 'OpenCodeAgentConfig' is not assignable to type 'Record<string, unknown>'.
one-shot-cli-agent.ts(117,67): error TS2304: Cannot find name 'AgentInterface'.
```

The shadowed keys are `bridgeCtx` (`base-agent.ts:49`), `agentRole` (`:54`), and `supervising` (`:135`), redeclared as
`private` in the subclasses. At runtime the subclass field initializer runs after `super()` and overwrites the base-set
value — masked only because `ensureClient` re-assigns it later (`dsh-agent.ts:461`, `codex-agent.ts:585`,
`opencode-agent.ts:718`, `hermes-agent.ts:422`, `omp-agent.ts:1099`).

- **Impact**: `tsc` cannot typecheck these classes, which is why the P0 errors in `qwen-agent.ts` and
  `opencode-agent.ts` (above) are invisible to the compiler-driven parts of the toolchain and shipped. The pre-commit
  hook is `pnpm exec lint-staged` (`.husky/pre-commit`) — eslint only, no typecheck — and the root `tsconfig.json` is
  references-only, so `pnpm typecheck` (`nuxt typecheck`) requires generated `.nuxt` configs. The runtime shadowing is
  currently harmless only by accident (the later re-assignment), and any new code path that reads `this.agentRole` or
  `this.bridgeCtx` before `ensureClient` gets the base values.

- **Fix**: delete the three shadowed keys from all 12 subclass sites and make the base members `protected`; declare
  `collectTurnEvents` in `OpenCodeAgentImpl` (or make the base method non-abstract with a default implementation);
  add `[key: string]: unknown` to the config interfaces or narrow `configRecord()`'s return type; import
  `AgentInterface` in `one-shot-cli-agent.ts`.

- **Verification**: the `tsc` invocation above must report zero `TS2415`/`TS2515`/`TS2322`/`TS2304` for these files, and
  the project's own `pnpm typecheck` should be added to CI and pre-commit so this class of error cannot land again.

---

### [P1] `GET /api/workshop/channels/:id` boots agent runtimes and mutates the `messages` table

- **Where**: `server/api/workshop/channels/[id]/index.get.ts:16`, `server/plugins/workshop.ts:68-74`,
  `server/services/workshop/runtime/manager.ts:694-720`.

- **Evidence**: the detail GET does more than read — it ensures the lead's scheduler loop is wired:

```ts
// channels/[id]/index.get.ts:13-17
manager.getChannelForUser(channelId, user.id) // 读取守卫(404/越权)
const channel = await manager.getChannel(channelId)
// 兜底:详情请求时确保 lead 的调度循环已装配(如启动恢复遗漏)
ensureLeadSchedulerLoop(manager, channelId)
return channel
```

```ts
// plugins/workshop.ts:68-74
export function ensureLeadSchedulerLoop(manager: AgentChannelManager, channelId: string, options?: { tickMs?: number, stallMs?: number }): void {
  manager.ensureChannelActive(channelId, options)
}
```

```ts
// manager.ts:694-700, 718-719
ensureChannelActive(channelId: string, options?: SchedulerLoopOptions): void {
  const channel = this.deps.repos.channels.findById(channelId)
  if (!channel || channel.enabled !== 1 || !channel.leadAgentId) return
  const cr = this.ensureChannelRuntime(channelId)
  if (cr.scheduler) return
  const lead = this.ensureAgentRuntime(channelId, channel.leadAgentId)
  if (!lead) return
  ...
  cr.scheduler = loop
  loop.start()
}
```

`loop.start()` begins the consumption path, which claims message rows
(`mailbox.ts:100-103` → `messageRepo.claim` → `UPDATE messages SET state='consuming' WHERE id=? AND state='pending'`) and
transitions tasks; `ensureAgentRuntime` → `wireMember` creates the harness impl and starts the runtime.
⚠UNVERIFIED: I traced the chain from `loop.start()` to `messageRepo.claim` by reading the code; I did not observe the
DB writes at runtime.

- **Impact**: an HTTP `GET` triggers agent execution. Rendering the channel page can spawn harness child processes and
  flip message rows `pending → consuming → consumed`. The endpoint cannot be cached or replayed safely; any user who can
  see the channel starts billable LLM work and process spawns; and "why did a worker run?" is not attributable to a write
  API. The comment calls it a boot fallback, which belongs on startup rather than on a read route.

- **Fix**: delete the `ensureLeadSchedulerLoop` call from `channels/[id]/index.get.ts:16` and perform the wiring once in
  `plugins/workshop.ts` startup (`manager.restore()` at `manager.ts:2895` already does this) or behind the existing
  `POST /channels/:id/activate` route.

- **Verification**: with a channel whose lead has never been wired, `GET /api/workshop/channels/:id`, then
  `SELECT COUNT(*) FROM messages WHERE state='consuming'` and `listHarnessProcesses().length` — both change today,
  neither should. Static: `rg -n "ensureLeadSchedulerLoop" server/api` → 1 hit today, 0 after.

---

### [P1] `GET /api/workshop/workspaces` and `GET /api/workshop/users/me` DELETE mount rows

- **Where**: `server/services/workshop/runtime/manager.ts:1125-1129`, reached from
  `server/api/workshop/workspaces/index.get.ts:10` and `server/api/workshop/users/me.get.ts:20`.

- **Evidence**: a `DELETE` executes inside a `.filter()` predicate — a callback whose contract is "decide", not "mutate":

```ts
// manager.ts:1119-1131
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
  }))
}
```

```ts
// workspaces/index.get.ts:8-11
export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getWorkshopManager().listWorkspaces(user.id)
})
```

- **Impact**: a read endpoint permanently deletes rows, with no audit trail and no way to distinguish "self-healed" from
  "user unmounted". `users/me.get.ts:20` only wants `.length` and triggers the same destructive path, so the session
  bootstrap endpoint is a writer. Any retry, cache, or intermediary that re-issues the GET re-runs the deletes.

- **Fix**: make `listWorkspaces` a pure projection (return dead ids in a separate `staleChannelIds` field) and move the
  cleanup into `removeChannel` (`manager.ts:1276`), where the reference actually becomes dangling, or into an explicit
  maintenance task.

- **Verification**: insert a `workspace_channels` row pointing at a non-existent channel id, `GET /api/workshop/workspaces`
  twice, then `SELECT COUNT(*) FROM workspace_channels` — today the row disappears on the first call.

---

### [P1] Read-path writes in the DAQ plane: a GET inserts rows and starts the acquisition timer

- **Where**: `server/api/workshop/daq/index.get.ts:16-23`,
  `server/services/workshop/daq/daq-controller.ts:1146-1163` (`provisionLegacyTwins`) and `:180-191` (`ensureLoop`),
  plus `daq/[id]/samples.get.ts:23`, `daq/[id]/frames.get.ts:20`, `daq/[id]/frames/content.get.ts:23`.

- **Evidence**: the list GET provisions rows and powers on the pipeline:

```ts
// daq/index.get.ts:16-23
export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  // ws.ts 出口装配 + 管线上电(幂等;路由模块加载即绑定)
  bindDaqHost(broadcastSceneEvent)
  await Promise.all([tsdbReady, getDaqQueue()])
  const ctrl = getDaqController()
  ctrl.provisionLegacyTwins()
  const state = ctrl.controllerState()
```

```ts
// daq-controller.ts:1146-1163 (abridged)
provisionLegacyTwins(): void {
  this.ensureLoop()
  const twins = getDaqHostPorts()?.telemetry.listDaqTwins() ?? []
  for (const t of twins) {
    if (!t.modelRef) continue
    const stableId = `dn-lg-${t.id}`
    if (this.repo.byId(stableId)) continue
    const node = new DaqNode({ … })
    ;(node as unknown as { sourceTwinId?: string }).sourceTwinId = t.id
    this.repo.insert(node)          // :1161 — DB write from a GET
  }
  this.syncRuntimes()
}
```

`ensureLoop` creates the acquisition/storage interval (`daq-controller.ts:191`
`this.timer = setInterval(() => this.sweep(), 250)`), and the per-node read GETs each start it (`:798`, `:839`, `:858`).

- **Impact**: the acquisition pipeline's uptime is coupled to UI traffic, and "provisioning" (a migration concept)
  becomes an implicit side effect of page load with no audit entry. Idempotency (`if (this.repo.byId(stableId)) continue`)
  limits the damage but does not make the read pure, and the GET cannot be served from a replica or a cache.

- **Fix**: move `provisionLegacyTwins()` to startup (nitro plugin / `manager.restore()`) and keep `ensureLoop()` on the
  explicit control route (`daq/controller.post.ts` exists); the GET should only read `controllerState()`.

- **Verification**: count DAQ node rows, `GET /api/workshop/daq` against a DB seeded with an un-provisioned legacy twin,
  count again → the count increases today. Static:
  `rg -n "provisionLegacyTwins|ensureLoop\(\)" server/services/workshop/daq/daq-controller.ts` → `:1147` and
  `:788,798,839,858,882,932`.

---

### [P1] `SchedulerLoop` tick loads the channel's entire task history via an unbounded `ORDER BY` scan

- **Where**: `server/services/workshop/runtime/task-engine.ts:137-139`,
  `server/services/workshop/db/task.repo.ts:80`, consumed at `server/services/workshop/runtime/scheduler-loop.ts:193-197`.

- **Evidence**: the "lite" projection — documented in-code as the optimised hot path — still selects every row the
  channel ever produced. There is no `LIMIT`, no window, no state filter:

```ts
// task-engine.ts:134-139
/** 任务列表 lite 版(调度快照热路径):元数据投影,免 artifacts/history JSON 大列解析。… */
listLite(channelId: string): WorkspaceTask[] {
  return this.repos.tasks.listByChannelMeta(channelId).map(rowToTaskLite)
}
```

```ts
// task.repo.ts:80
const selectByChannelMeta = db.prepare(`SELECT ${META_COLS} FROM tasks WHERE channel_id = ? ORDER BY createdAt ASC, rowid ASC`)
```

Called once per tick per active channel:

```ts
// scheduler-loop.ts:191-197
private async tickRound(): Promise<void> {
  this.tick += 1
  const snapshot = this.collectSnapshot()
  // 状态 Map 生命周期修剪:终态/已删任务的条目随轮清理(长会话内存有界)。
  const liveIds = new Set(snapshot.tasks.map(t => t.id))
```

The pruning at `:198-208` is itself correct, but its key set (`liveIds`) is unbounded, so it re-derives the whole history
every tick and allocates a fresh `Set` plus a fresh `WorkspaceTask[]`. Tick cadence is 1 s base with idle backoff to
`IDLE_TICK_CAP_MS = 8000` (`scheduler-loop.ts:60,105`), and `wake()` resets it on every task/message event (`:124-130`).

- **Impact**: per-channel cost grows linearly with total completed tasks and never plateaus. 10 000 historical tasks on
  one channel means a 10 000-row SQLite scan, 10 000 object constructions, and a 10 000-entry `Set` **every second** while
  the channel is active. The same unbounded read feeds `queueViewsOf` (`:99`), `queueViewsOfLite` (`:118`),
  `queueViewOf` (`:145`), `list()` (`:439`), `refreshChronicle` (`manager.ts:435` — invoked on **every** terminal task
  event), `submitChannelTask` dedup (`manager.ts:2155`), `manager.ts:2403,2626,2919`, `ws.ts:331`, and
  `channels/[id]/tasks/index.get.ts:23` — so the UI task list is unpaginated too.

- **Fix**: add state-scoped accessors to `task.repo.ts` — e.g. `listLiveByChannelMeta(channelId)` selecting
  `state NOT IN ('COMPLETED','FAILED','CANCELED')` plus a bounded recent-terminal tail
  (`ORDER BY created_at DESC LIMIT :window`) — and have `listLite` prefer it. The scheduler only needs non-terminal tasks
  plus a small recent-terminal tail for the chronicle (`manager.ts:438` already slices to 12).

- **Verification**: seed 10 000 `COMPLETED` tasks on one channel, then
  `getTaskEngine().listLite(channelId).length` → expect a bounded number after the fix, 10 000+ today.
  Static: `rg -n "selectByChannelMeta|selectByChannel " server/services/workshop/db/task.repo.ts` → no `LIMIT`.

---

### [P1] `runMemoryMaintenance` still scans `limit = 1_000_000` rows per agent and filters in JS

- **Where**: `server/services/workshop/runtime/memory.ts:668-674`, plus the per-row re-read at `:654`.

- **Evidence**:

```ts
// memory.ts:667-674
// 成员私有域(排除 team)
for (const agentId of repo.listMemoryAgentIds()) {
  expireAndEvict(repo.listByAgentWithRowid(agentId, 1_000_000)
    .filter(r => r.kind.startsWith('episodic')))
}
// team 共享域:仅 episodic-team-task 参与过期/淘汰(chronicle/semantic 策展行豁免)
expireAndEvict(repo.listByAgentWithRowid(TEAM_AGENT_ID, 1_000_000)
  .filter(r => r.kind === 'episodic-team-task'))
```

and inside `expireAndEvict`, one SELECT per surviving row:

```ts
// memory.ts:654
const remaining = rows.filter(r => repo.getById(r.id) !== null)
```

The `cap` that should bound this (`memory.ts:636` `const cap = opts.cap ?? memoryCfg().cap`) is applied only to
*deletion* (`:655`), never to the *read*.

- **Impact**: `O(agents × rows_per_agent)` rows materialised into JS objects plus an extra `O(rows)` indexed SELECT loop,
  on every `memorySettings().maintenance_ms` tick (`manager.ts:333-347`) — and that timer runs unconditionally, including
  on an idle server. This is the exact anti-pattern the codebase already removed elsewhere:
  `memory.repo.ts:203-217` documents *"替代原先「limit=1_000_000 拉全量再由 JS filter」的退化作法"* and `manager.ts:472-474`
  uses the pushed-down variant. `memory.ts` was never migrated.

- **Fix**: add `listByAgentKindPrefixWithRowid(agentId, 'episodic', limit)` to `memory.repo.ts`, mirroring
  `listByAgentKindMonth` (`memory.repo.ts:210-217`), call it with `cap * 2` at `memory.ts:668-674`, and drop the
  `repo.getById` re-read by tracking deleted ids in a `Set` local to `expireAndEvict`.

- **Verification**: `rg -n "1_000_000" server/services/workshop/runtime/memory.ts` → 2 hits today, 0 after.
  Perf: seed one agent × 50 000 episodic rows, call `manager.runMemoryMaintenanceNow()` and compare `.time`/heap before
  and after.

---

### [P1] `limit: 1_000_000` / `10_000` used to fetch one memory row by id, then delete it

- **Where**: `server/services/workshop/runtime/manager.ts:1489`, `:1552`.

- **Evidence**: two delete-by-id methods load an entire per-scope table and `find` in JS:

```ts
// manager.ts:1489 (deleteTeamMemory)
const row = this.deps.repos.memories.listByAgentChannel(channelId, TEAM_AGENT_ID, 1_000_000).find(r => r.id === memoryId)
```

```ts
// manager.ts:1552 (deleteAgentMemory)
const row = this.deps.repos.memories.listByAgent(targetAgentId, 10_000)
  .find(r => r.id === memoryId && r.channelId === channelId && r.agentId === targetAgentId)
```

- **Impact**: deleting one memory materialises up to a million rows (each carrying `content`/`title` text) to locate a row
  available by primary key — `memories.getById` exists and is already used at `memory.ts:654`. For the team domain the
  `1_000_000` value is effectively "all team memories for the channel, ever", so memory pressure and CPU scale with
  shared-domain size on a user-triggered delete.

- **Fix**: replace both with `this.deps.repos.memories.getById(memoryId)` plus the scope assertions the code already
  enumerates (`r.channelId === channelId`, `r.agentId === targetAgentId`).

- **Verification**: `rg -n "1_000_000|10_000" server/services/workshop/runtime/manager.ts` → 2 hits today, 0 after.
  Unit test with a `getById`-counting fake asserts 1 call instead of a full scan.

---

### [P1] `pickReceiverWorker` issues one task query per candidate worker (N+1)

- **Where**: `server/services/workshop/runtime/manager.ts:1744-1757`.

- **Evidence**:

```ts
// manager.ts:1744-1757
private pickReceiverWorker(channelId: string, excludeAgentId: string): string | null {
  const candidates = this.deps.repos.channelAgents
    .listByChannel(channelId)
    .filter(m => m.enabled === 1 && m.role === 'worker' && m.id !== excludeAgentId)
  let best: string | null = null
  let bestLen = Number.POSITIVE_INFINITY
  for (const m of candidates) {
    const len = this.getTaskEngine().queueViewOf(channelId, m.id).queued.length
    if (len < bestLen) {
      best = m.id
      bestLen = len
    }
  }
  return best
}
```

`queueViewOf` is a real query per call (`task-engine.ts:141-145` → `listByChannelAssigneeMeta`, `task.repo.ts:81` — the
full per-assignee history, no `LIMIT`). The caller is the orphan-reassignment path during member removal
(`manager.ts:1696-1740`), i.e. a moment when the channel is already degraded. The engine already has the batched
equivalent, which is simply not used here:

```ts
// task-engine.ts:116-118
/** 批量队列视图 lite 版(调度快照热路径):元数据投影,免 artifacts/history JSON 大列解析 */
queueViewsOfLite(channelId: string): Map<string, AgentTaskQueueView> {
  const rows = this.repos.tasks.listByChannelMeta(channelId)
```

- **Impact**: choosing a receiver costs `O(workers × tasks_per_worker)` row reads plus object construction, all to
  compare integers. On a 20-worker channel with 1 000 historical tasks each, that is 20 full scans instead of one.

- **Fix**: call `this.getTaskEngine().queueViewsOfLite(channelId)` once and look up `views.get(m.id)?.queued.length`
  inside the loop.

- **Verification**: static — `rg -n "queueViewOf\(" server/services/workshop/runtime/manager.ts` → 1 hit in
  `pickReceiverWorker`. Behavioural: with a 20-worker channel, count SQL executions (spy on `db.prepare(...).all`) during
  `removeTeamMember` → 20 today, 1 after.

---

### [P1] Renaming or disabling a **busy** team member silently has no effect

- **Where**: `server/services/workshop/runtime/manager.ts:1571-1581` (the update) and `:745-749` (the refusal),
  `server/services/workshop/runtime/agent-runtime.ts:196-200` (identity snapshot).

- **Evidence**: the update path asks the unloader to release the runtime, but the unloader refuses when the agent is not
  idle:

```ts
// manager.ts:745-749
async unloadAgent(channelId: string, agentId: string): Promise<void> {
  const runtime = this.runtimeOf(channelId, agentId)
  if (!runtime) return
  if (runtime.getState() !== 'idle') return
  if (this.deps.repos.messages.listPendingByChannelAgent(channelId, agentId).length > 0) return
```

and identity/config/harness are baked at wire time, so a live runtime never picks up the patch.
⚠Partially verified: I read `unloadAgent` and the update call site directly; the `agent-runtime.ts:196-200` identity
snapshot and the "no `enabled` re-check in the consume loop" claim come from the delegated runtime audit and I did not
re-read those lines.

- **Impact**: `PATCH /api/workshop/channels/:id/agents/:agentId` with a new `name`/`config`/`enabled` returns 200, but a
  busy member keeps its old name in every status frame and keeps consuming its queue — a **disabled member can still
  complete tasks and spend tokens**, which is an operator-safety surprise. The only reliable paths are
  `removeAgentFromChannel` (forced, `manager.ts:1600`) or waiting for idle.

- **Fix**: make `updateChannelAgent` (`manager.ts:1571`) use the forced path (`stopAndDetach`) when the patch touches
  `enabled: 0` or `harness`, and have `AgentRuntime.processMessage` re-read `enabled` before claiming; or return an
  explicit "applies after the current turn" marker instead of a silent 200.

- **Verification**: `PATCH` a busy member's `enabled` to 0, then `GET /api/workshop/channels/:id/queue` and watch for
  further completions by that agent — today it keeps working, and `state` still shows the old name.

---

### [P1] `Mailbox.dequeue` leaks a 15 s timer per idle poll

- **Where**: `server/services/workshop/runtime/mailbox.ts:106-109`.

- **Evidence**:

```ts
// mailbox.ts:105-109
// 门闩挂起 + 15s 兜底重查:任何唤醒丢失路径自愈(消息最多滞后 15s)
await Promise.race([
  gate.promise,
  new Promise<void>(resolve => setTimeout(resolve, 15_000)),
])
```

The timer handle is never captured or cleared, so when the gate wins the race the 15 s timeout stays scheduled (and
refs the event loop, unlike an `unref`'d timer).

- **Impact**: for each idle-mailbox agent one live timer exists at all times; because the loop re-enters immediately after
  each wake, a busy agent can accumulate several pending timers per second, each holding its closure. They do eventually
  fire and are collected, so this is churn rather than a monotonic leak — but it pins the event loop, inflates
  `process._getActiveHandles()`, and adds wakeup noise under load.
  ⚠UNVERIFIED: I read the code path (`manager.ts:374` `wakeMailbox`, `mailbox.ts:73,80,136` drive the re-entry) but did
  not measure live handle counts.

- **Fix**: capture and clear the timer (`const t = setTimeout(resolve, 15_000); t.unref?.()` with a `clearTimeout` on the
  gate branch), or use a single `unref`'d `setInterval` on the Mailbox that calls `releaseGate()`.

- **Verification**: instantiate `Mailbox` with a fake repo returning `null`, call `dequeue()` in a loop with periodic
  `wake()`, then assert `process.getActiveResourcesInfo().filter(x => x === 'Timeout').length` stays ≤ 2.

---

### [P1] Unbounded `nameCache` in `caller.ts` — third copy of the same cache bug

- **Where**: `server/api/workshop/caller.ts:122` (+read `:124-125`, write `:133`).

- **Evidence**:

```ts
// caller.ts:121-135
/** 按用户 id 解析用户名(60s 轻量缓存;users.sqlite 查询,解析失败回 null) */
const nameCache = new Map<string, { name: string | null, at: number }>()
function resolveUserNameById(userId: string): string | null {
  const hit = nameCache.get(userId)
  if (hit && Date.now() - hit.at < 60_000) return hit.name
  let name: string | null
  try {
    name = userRepository.findById(userId)?.name ?? null
  }
  catch {
    name = null
  }
  nameCache.set(userId, { name, at: Date.now() })
  return name
}
```

No cap, no sweep, no delete — the same pattern as `manager.ts:230` `ownerNameCache`. The TTL controls freshness only.
The in-repo fix utility already exists but is barely used:

```ts
// shared/lru.mjs:14 (only production use is daq-controller.ts:677)
class LruMap …
```

- **Impact**: one entry per distinct user id ever rendered through `withOwnerNames` (`caller.ts:105-119`) for the process
  lifetime. The values are small, so this is hygiene rather than an OOM path — the real finding is that the identical
  cache is copy-pasted three times instead of using `shared/lru.mjs`.

- **Fix**: replace `nameCache` (`caller.ts:122`) and `ownerNameCache` (`manager.ts:230`) with
  `new LruMap<string, { name: string | null, at: number }>(1000)` from `shared/lru.mjs:14`.

- **Verification**: `rg -n "new Map<string, \{ name: string \| null, at: number \}>" server/` → 2 hits, both unbounded.
  Runtime: after touching N users' owner names, assert `nameCache.size <= 1000`.

---

### [P1] `aml_job_submit` executes caller-supplied Python on the host, gated only by a regex

- **Where**: `server/services/workshop/agents/industrial-tools.ts:1150-1170`, reached through the tool bridge.

- **Evidence**: validation is shape-only — a substring match and a size cap:

```ts
// industrial-tools.ts:1151-1156
if (!datasetId) return amlErr('dataset_id 必填(aml_dataset_build 返回的 id)。')
if (!code.trim()) return amlErr('code 必填:train.py 全文(单文件;契约见工具说明)。')
if (code.length > 512_000) return amlErr(`code 过大(${Math.round(code.length / 1024)}KB),上限 500KB;精简训练代码(模型定义/训练循环拆薄)后重试。`)
if (!/\bimport\s+amlkit\b/.test(code)) {
  return amlErr('code 必须 import amlkit(平台数据/进度/导出契约):…')
}
```

Nothing constrains what else the submitted file does.
⚠UNVERIFIED (delegated API audit, not re-read by me): that the code is written to `workspace/train.py` and spawned with
the venv python (`aml/job-orchestrator.ts:285-287,328`) with only a scrubbed env and no container sandbox
(`aml/python-runtime.ts:186-214`).

- **Impact**: combined with the invoke-IDOR finding, a plain authenticated user can execute arbitrary Python in the
  server's environment. Even without the IDOR, any agent holding `aml_job_submit` — a normal worker tool, **not** in
  `LEAD_ONLY_TOOL_NAMES` (`host-tool-bridge.ts:33-43`) — is a code-execution primitive reachable from an LLM prompt:
  the classic indirect-prompt-injection → RCE chain.

- **Fix**: run AML jobs in a container/namespace with a read-only rootfs and resource caps; at minimum drop to a
  dedicated unprivileged user and require lead role + HITL for `aml_job_submit`. Stop returning raw runner errors to the
  caller (`manager.ts:2785-2788`).

- **Verification**: submit a job whose `code` imports `amlkit` and then attempts to read a host path outside the job
  workspace, and assert the process cannot reach it.

---

### [P2] `probeCache` / harness model catalog cache / HITL `items` are unbounded (small, but never evicted)

- **Where**: `server/services/workshop/agents/harness-availability.ts:71` (+write `:102`),
  `server/services/workshop/agents/harness-models.ts:37` (+write `:46`),
  `server/services/workshop/agents/hitl-registry.ts:50` (+set `:94`, delete `:107-108`).

- **Evidence**: `probeCache` is keyed by `${harnessId}=${command}` (`:94`) where `command` comes from per-instance
  `config.command` (`registry.ts:106-107`) — i.e. a user-influenced key space — and has no eviction:

```ts
// harness-availability.ts:69-71
const PROBE_TTL_MS = 30_000
/** 缓存键 = 引擎+命令(命令不同探测结果不同,不能按引擎 id 独占) */
const probeCache = new Map<string, { at: number, resolvedPath: string | null }>()
```

```ts
// harness-models.ts:37
const cache = new Map<string, { at: number, catalog: HarnessCatalog }>()
```

```ts
// hitl-registry.ts:49-50
/** key = `${kind}:${id}`;value 为 AepHitlItem(parkDeadline 单独存,避免污染协议对象) */
private items = new Map<string, AepHitlItem>()
```

`hitl-registry.items` is deleted on `resolve()` (`:107-108`) and, for `dcw-approval`, the timeout timer always fires
(`tool-approvals.ts:73-83`), so it is bounded **iff** every `omp-dialog` registration is resolved —
`harness-terminal.ts:253,310,403,611` resolve on cancel/expire/unsubscribe/answer, but a hard kill of the host with no
dispose leaves the entry. `harness-models`'s cache is bounded in practice by `knownHarnesses()` (14 entries).

- **Impact**: low. `probeCache` grows with the number of distinct `config.command` strings ever configured, so a careless
  or malicious admin creating agents with random `config.command` values grows it without bound.

- **Fix**: apply the `if (cache.size > 500) cache.clear()` idiom already used at `dcw-controller.ts:560-561`
  (`opsWriteMemo`) to `probeCache` and the `harness-models` cache; add a `sweepResolved(now)` to `hitl-registry` that
  drops entries whose `expiresAt` has passed, called from the existing sweeper.

- **Verification**: `rg -n "\.delete\(|\.clear\(" server/services/workshop/agents/harness-availability.ts server/services/workshop/agents/harness-models.ts` → 0 hits.

---

### [P2] `harness-models.opencodeCatalog` leaks two temp directories containing copied provider credentials

- **Where**: `server/services/workshop/agents/harness-models.ts:133` and `:143`.

- **Evidence**:

```ts
// harness-models.ts:133
const dataDir = resolve(mkdtempSync(join(tmpdir(), 'aw-oc-cat-')))
// harness-models.ts:143
const configDir = resolve(mkdtempSync(join(tmpdir(), 'aw-oc-catc-')))
```

Neither is removed (`rmSync`/`rm` appear nowhere in the file). The dirs are created before the TTL cache can help on a
cold or expired call. Worse, the first one receives a copy of the provider credential file:

```ts
// harness-models.ts:137-140
const src = resolve(home, '.local', 'share', 'opencode', 'auth.json')
const dst = resolve(dataDir, 'opencode', 'auth.json')
// 只允许「全局 opencode 数据目录 → 本次一次性临时数据目录」的定点拷贝
if (src.startsWith(home + sep) && dst.startsWith(dataDir + sep)) copyFileSync(src, dst)
```

- **Impact**: temp-dir litter proportional to model-catalog refreshes, each copy holding provider credentials on disk
  indefinitely. This is both a disk-hygiene and a credential-exposure issue.

- **Fix**: wrap the body in `try { … } finally { rmSync(dataDir, { recursive: true, force: true }); rmSync(configDir, { recursive: true, force: true }) }`.

- **Verification**: `rg -n "mkdtempSync|rmSync|rm\(" server/services/workshop/agents/harness-models.ts` → 2 `mkdtempSync`,
  0 removals. Manual: call the catalog twice, then `Get-ChildItem $env:TEMP -Filter 'aw-oc-cat*'` → 4 dirs today.

---

### [P2] Adapter duplication — ≈1 500 lines across 13 adapters (48 distinct duplication sites)

- **Where**: `server/services/workshop/agents/{codex,claude,dsh,qwen,hermes,omp,opencode}-agent.ts`,
  `agents/{gemini,copilot,cursor,crush,goose,pi}-agent.ts`, `agents/adapters/{one-shot-cli-agent,stdio-jsonrpc,omp-rpc-client}.ts`, `agents/registry.ts`.

- **Evidence**: `copilot-agent.ts` shows the shape the others should have — a spec literal plus a 2-line subclass:

```ts
// copilot-agent.ts:83-86, 132-136
const spec: OneShotEngineSpec = {
  harnessId: 'copilot',
  resolveCommand: config => (typeof config.command === 'string' && config.command.trim() !== '' ? config.command.trim() : harnessSettings().copilot_command),
  buildArgs: ({ config }) => { … },
  …
}
export class CopilotAgentImpl extends OneShotCliAgentImpl {
  constructor(config: Record<string, unknown>) { super(config, spec) }
}
```

Measured duplication (counts re-confirmed with `Select-String` against the current tree):

| Duplicated thing | Copies | Where |
|---|---|---|
| `{ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }` | **14** | `registry.ts:117,126,135,144,153,162,171,180,189,198,207,216,225,234` |
| `generateMcpBridgeEnv({…})` call sites | **10** | `claude-agent.ts:452`, `codex-agent.ts:606,690`, `dsh-agent.ts:477,485,486`, `gemini-agent.ts:119`, `hermes-agent.ts:438`, `qwen-agent.ts:461`, `adapters/one-shot-cli-agent.ts:296` |
| `resolveCommand` = `config.command?.trim() \|\| harnessSettings().X_command` | **13** | `registry.ts:125,134,143,152,170,179,188,197,206,215,224,233` + each engine spec |
| `workerTurn` / `peerTurn` skeletons | **8 / 8** | `codex:216-279`, `claude:198-263`, `dsh:215-278`, `qwen:237-300`, `hermes:187-250`, `opencode:326-392`, `one-shot:192-239`, `omp:642-759` |
| `reconcileProcess(): void {…}` bodies | **7** | `one-shot-cli-agent.ts:163`, `codex:140`, `dsh:144`, `hermes:122`, `omp:483`, `opencode:175`, `qwen:167` |
| `collectTurnEvents` | **6 byte-identical** | `codex:494-501`, `claude:419-426`, `dsh:446-453`, `qwen:435-442`, `hermes:407-414`, `one-shot:242-249` |
| `getProcessInfo()` / `killProcess()` / `reconcileProcess()` | **7 / 6 / 6** | see the delegated adapter inventory |
| `ensure*Config` MCP-file writers | **4** + 1 inline | `copilot:47`, `crush:35`, `cursor:34`, `gemini:34`; `opencode:784-788` inlines the same env |
| `taskText` / `msgText` re-implementing the existing `partsText()` | **7 / 7** | `base-agent.ts:189-197` already provides it |
| `safeId(agentId)` | **3 identical** | `copilot:28-31`, `goose:26-29`, `pi:27-30` |
| parts → plain-text flattener | **3** + 1 twin | `host-tool-bridge.ts:118-128`, `base-agent.ts:189-197`, `agent-runtime.ts:102-104`; `copilot:67-81` |
| `stdio: ['pipe','pipe','pipe']` | **3** | `line-spawn.ts:106,115`, `omp-rpc-client.ts:247` |

`dsh-agent.ts` is the visible symptom — three evaluations to build one object:

```ts
// dsh-agent.ts:485-486
...generateMcpBridgeEnv({ agentId: this.selfAgentId, token: this.config.token, baseUrl: this.config.baseUrl, bridgePath: this.config.mcpBridgePath }).bridgeEnv,
AW_BRIDGE_PATH: generateMcpBridgeEnv({ agentId: this.selfAgentId, token: this.config.token, baseUrl: this.config.baseUrl, bridgePath: this.config.mcpBridgePath }).bridgePath,
```

and `opencode-agent.ts` hand-rolls the helper:

```ts
// opencode-agent.ts:784-788
command: [process.execPath, resolveBridgePath(this.config.mcpBridgePath)],
env: {
  AW_BASE_URL: resolvePlatformBaseUrl(this.config.baseUrl),
  AW_AGENT_ID: this.selfAgentId,
  AW_AGENT_TOKEN: this.config.token ?? '',
```

⚠The 48-site inventory and the ≈1 500-line estimate come from the delegated adapter audit (it enumerates D1-D48 with
line ranges). I personally re-confirmed the five counts marked "verified" above, plus D19/D21-D23 spot samples.

- **Impact**: every fix must be applied N times, which is exactly how the P0/P1 defects above survived — the reader
  audits one copy and assumes the others match. Concretely, the NDJSON bug is inherited by 5 engines through a shared
  base whose parse loop was never corrected; `AW_AGENT_TOKEN: config.token ?? ''` appears in 10 places plus a hand-roll,
  and an empty token makes the bridge exit immediately (`aw-mcp-bridge.mjs:28-31`).

- **Fix**, in value order:
  1. `harnessConfigOf(config, agent)` in `harness-env.ts`; use it in all 14 `registry.ts` entries.
  2. `bridgeEnvFor(config, selfAgentId)` for the 10 `generateMcpBridgeEnv` sites; delete `opencode-agent.ts:786-790`
     and the redundant `dsh-agent.ts:485-486` evaluations.
  3. Move `reconcileProcess` / `killProcess` / `getProcessInfo` / `getContextStats` / `collectTurnEvents` / the event-queue
     turn machine into the shared base (removes ≈6-8 copies each).
  4. One `writeMcpConfigFile(file, serverEntry)` for the 4 `ensure*Config` functions.
  5. One `partsText()` imported by all seven re-implementations.

- **Verification**: after step 1,
  `(Select-String -Path server/services/workshop/agents/registry.ts -Pattern "agentId: agent\.id, name: agent\.name, role: agent\.role, channelId: agent\.channelId, token: agent\.token" -AllMatches).Count` → **0** (14 today, verified).
  After step 2, `(Select-String -Path server/services/workshop/agents/*.ts,server/services/workshop/agents/adapters/*.ts -Pattern "generateMcpBridgeEnv\(\{" -AllMatches).Count` → ≤ 8 (10 today, verified).
  After step 3, `Select-String -Path server/services/workshop/agents/*.ts -Pattern "reconcileProcess\(\): void \{"` → 1 hit (6 subclass + 1 base today, verified).
  Then `pnpm typecheck` and `scripts/e2e-multiharness-team.mjs` must pass.

---

### [P2] `runtime/manager.ts` (3016 lines) — 16 subsystems in one class; proposed extraction seams

- **Where**: `server/services/workshop/runtime/manager.ts:1-3016`.

- **Evidence** — measured responsibility bands:

| Lines | Responsibility | Extraction target |
|---|---|---|
| 1-55 | imports, logger | — |
| 57-145 | `AllRepos`, `ManagerDeps`, `ActingUser`, `AgentTemplateDetail`, `AgentTeamDetail`, `ChannelTemplateDetail` | `manager-dto.ts` |
| 147-224 | mappers `instanceToAgentInfo`/`rowToTask`/`rowToChannelMail`/`buildMessage`, `parseChannelLlm`, `runtimeKey` | `manager-dto.ts` |
| 226-243 | `KNOWN_HARNESSES`, `ownerNameCache`, `resolveOwnerName` | `user-name-cache.ts` (where the LRU fix lands) |
| 245-314 | `Runtime*View` monitor DTOs | `manager-dto.ts` |
| 316-349 | class fields, ctor (memory + reflection timers) | stays (composition root) |
| 351-394 | `getTaskEngine`, `ensureChannelRuntime` | `channel-lifecycle.ts` |
| 396-492 | `recordTeamTaskTerminal`, `refreshChronicle`, `reflectIdleMemories` | `memory-curation.ts` (carries `reflectCounts`) |
| 494-639 | `buildBus` + subscribe façade + notify helpers | `channel-bus.ts` |
| 641-720 | `wireMember`, `ensureAgentRuntime`, `runtimeOf`, `ensureChannelActive` | `channel-lifecycle.ts` |
| 722-808 | `stopAndDetach`, `unloadAgent`, `unloadIdleAgents`, `startIdleSweeper`, `runtimeStatus` | `channel-lifecycle.ts` (carries the `idleSince` bug) |
| 810-996 | `monitorRuntime`, `monitorRuntimeForUser`, `terminateRuntimeProcess`, `killHarnessProcessByPid`, `shutdown` | `runtime-monitor.ts` |
| 998-1044 | `buildWorkspace` (the `AgentWorkspace` façade) | `workspace-facade.ts` |
| 1046-1115 | user accounts + `requireOwned`/`requireWritable`/`requireTemplateReadable` + per-user channel reads | `manager-auth.ts` |
| 1117-1163 | Workspace CRUD + mount/unmount | `workspace-service.ts` (isolates the DELETE-in-filter bug) |
| 1165-1291 | channel lifecycle (`createChannel` … `removeChannel`, workspace dirs) | `channel-lifecycle.ts` |
| 1293-1418 | agent templates + channel instances (`addAgentToChannel`, `listChannelAgents`) | `agent-templates.ts` |
| 1420-1556 | memory listing/search, team shared memory, agent private memory curation | `memory-curation.ts` (carries the `1_000_000` finds) |
| 1558-1616 | instance detail/update/remove | `agent-templates.ts` (carries the busy-rename bug) |
| 1618-1758 | lead team management + `pickReceiverWorker` | `team-management.ts` (carries the N+1) |
| 1760-1893 | `AgentTeam` CRUD + `deployTeamToChannel` + `teamDetailOf` | `team-templates.ts` |
| 1895-2041 | `ChannelTemplate` CRUD + `instantiateChannelTemplate` + `assertHarness` | `channel-templates.ts` |
| 2043-2476 | task work-plane (`submitChannelTask` … `reassignTask`) | `task-service.ts` |
| 2478-2689 | A2A messaging + cross-team overview/memory + `otherSameOwnerChannels` | `messaging.ts` |
| 2691-2738 | collaboration tool bridge (`invokeAgentWorkspaceTool`) | `host-tool-dispatch.ts` |
| 2740-2823 | host-tool dispatch, `resolveAgentByToken`, `hostToolDefsFor`, `respondHarnessHitl` | `host-tool-dispatch.ts` (carries `lastToolInvokeAt`) |
| 2825-2936 | mailbox/mail REST surface, `restore()` | `messaging.ts` / `restore.ts` |
| 2938-2999 | internal helpers (`route`, `wakeAgent`, `resolveMemberRef`, `requireMember`, `requireTaskInScope`) | `member-resolution.ts` |
| 3000-3016 | factory + singleton | stays |

- **Impact**: the class owns four live-runtime `Map`s **plus** 16 business domains, so a change in any one shares a file
  with authorization helpers and the tool bridge. The findings in this report that live in this file — the bridge token
  check at `:2750`, the DELETE inside a filter at `:1127`, the N+1 at `:1751` — sit 1 000+ lines apart from the helpers
  that should guard them. ⚠The three API routes that reach internals via `manager as unknown as {...}` casts
  (`channels/[id]/tasks/index.get.ts:15`, `channels/[id]/messages/index.get.ts:27`,
  `a2a/[agentId]/rpc/index.post.ts:207`) come from the delegated runtime audit; I verified the line ranges in this table
  by reading the file, but not those casts.

- **Fix**: extract in this order (each a pure move; `AgentChannelManager` keeps thin delegating methods so no caller
  changes): `manager-dto.ts` + `user-name-cache.ts` + `channel-bus.ts` + `member-resolution.ts` first (leaf
  dependencies); then `channel-lifecycle.ts`, `runtime-monitor.ts`, `workspace-service.ts`, `agent-templates.ts`,
  `team-templates.ts`, `channel-templates.ts`, `task-service.ts`, `messaging.ts`, `memory-curation.ts`,
  `host-tool-dispatch.ts`; finally `manager-auth.ts` and `restore.ts`. Expected residue ≈250-350 lines
  (lines 1-55, 316-373, 998-1044, 3000-3016).

- **Verification**: `(Get-Content server/services/workshop/runtime/manager.ts | Measure-Object -Line).Lines` → **3016**
  today (verified; the task brief's "139KB / ~2836" is stale). Target < 600 after, with
  `rg -n "class AgentChannelManager" server/services/workshop/runtime/` returning exactly one hit and
  `scripts/e2e-agent-channel-task.ts`, `scripts/e2e-task-queue.ts`, `scripts/e2e-channel-isolation.ts` passing
  unchanged, plus clean `pnpm lint` and `pnpm typecheck`.

---

## Question-by-question answers

### Q1 — Agent ↔ node binding: how permission is granted, and whether it is enforced

**Grant path**: a row in `agent-node-bindings.json` (`node-bindings.repo.ts:22-29`) created through
`POST /api/workshop/agent-tools/bindings`. That route requires a **user** token whose line grant covers the node
(`bindings/index.post.ts:17-32`: `resolveUser` → `lineMode(user, lineId)` → `dcw` needs `operate`, `daq` needs
`readonly`+). The repo does **no** authorization of its own — `bind()` (`node-bindings.repo.ts:73-95`) validates only
non-empty ids and enum membership — so the API layer is the sole gate. Direct repo callers
(`dcw-controller.ts:413`, `daq-controller.ts:1032`) use it only for cascade cleanup.
Gap: the create route never resolves or authorizes `body.agentId`, and `bind()` silently re-modes an existing row
(`:78-83`), so a user with `operate` on one line can hand control to any agent, or strip HITL with `mode:'auto'`.

**Enforcement on the tool path** (guard site per tool):

| Tool | Guard | Line |
|---|---|---|
| `dcw_control` | `repo.find(agentId, nodeId, 'dcw')` + re-check after approval | `industrial-tools.ts:100-109`, `:143-145` |
| `dcw_read` | `repo.find(agentId, nodeId, 'dcw')` | `:195-204` |
| `daq_query` / `daq_frames` | `daqTargetsOf()` — binding set is the boundary; `node_id`/`line_id` only narrow | `:243-269` |
| `dcw_journal` | `new Set(repo.byAgent(agentId).map(b => b.nodeId))` | `:434-437` |
| `ops_log` | `agentOpsScope()` + `scope.nodeIds.has(nodeId)` | `:562-569` |
| `recipe_log` | `agentOpsScope()` + `scope.lineIds.includes(lineId)` | `:610-613` |
| `line_context` | `agentOpsScope()` + line membership | `:657-663` |
| `recipe_versions` | `agentOpsScope()` + `recipe.lineId` membership | `:734-737` |
| `recipe_update` | `repo.find(agentId, nodeId, 'dcw')` per param | `:789-791` |
| `recipe_rollback` | `agentOpsScope()` line membership | `:856-859` |
| `aml_node_catalog` | `byAgent(agentId).filter(kind==='daq')` | `:961-963` |
| `aml_dataset_build` | daq binding + line consistency per node | `:1031-1041` |
| `aml_model_reference` | daq bindings → scope lines, then model line | `:1344-1354`, `:1387-1392` |
| `aml_model_promote` | `role === 'lead'` from `channel_agents` (not a binding) | `:1291-1294` |
| **`dcw_rollback`** | **only `checkRollbackAllowed` (cooldown)** | `:401-420`, `recipe-rollback-manager.ts:403-410` |
| **`dcw_judge`** | record ownership; takeover bypasses the binding | `:381-383` |

**Default-allow?** No "no bindings ⇒ allow" fallback exists anywhere. Unbound agents are correctly refused by
`daqTargetsOf` (`:248-250`), `toolMyIndustrialNodes` (`:40-42`), `agentOpsScope` (`:520`), `toolDcwControl` (`:101-109`),
`toolAmlDatasetBuild` (`:1034-1036`). The P0s are the **inverse** shape: `dcw_rollback` is default-allow, and
`dcw_judge` is partially allow via takeover.

### Q2 — Tool surface: what each tool mutates, and where the gate is

Registered via `.AgentWorkShop/prompts/host-tools.json` (`host-tool-bridge.ts:30`) and dispatched by the switch at
`host-tool-bridge.ts:162-211`.

| Tool | Mutates | Approval / HITL |
|---|---|---|
| `my_industrial_nodes` | no PLC write; **deletes stale binding rows from disk** | n/a |
| `dcw_read`, `daq_query`, `daq_frames`, `dcw_journal`, `ops_log`, `recipe_log`, `line_context`, `recipe_versions` | read-only | n/a |
| **`dcw_control`** | **PLC write** (range ∩ recipe-window interlock) | ✅ `manual` binding ⇒ `getToolApprovals().request()` (`:128-146`), re-checked after approval (`:143-145`) |
| **`dcw_rollback`** | **PLC write** (historical anchor value) | ❌ **none** — P0 |
| `dcw_judge` | optimisation ledger only (no PLC) | ❌ none (by design) |
| **`recipe_update`** | recipe definition (next batch) | ❌ none; requires `reason` |
| **`recipe_rollback`** | recipe definition (new version) | ❌ none; requires `reason` |
| `aml_node_catalog`, `aml_dataset_stats`, `aml_job_status`, `aml_job_logs`, `aml_leaderboard`, `aml_model_reference` | read-only | n/a |
| **`aml_dataset_build`** | writes dataset files | ❌ none |
| **`aml_job_submit`** | executes caller-supplied Python (≤500 KB) | ❌ none beyond a regex + `change_note` |
| **`aml_job_cancel`** | kills a job process tree | ❌ none |
| **`aml_model_promote`** | promotes a model to production | ✅ HITL (`:1311-1319`) **and** a `role === 'lead'` DB check (`:1291-1294`) |
| Workspace tools (`dispatch_task`, `complete_task`, `create_team_agent`, `remove_team_agent`, `cancel_task`, `broadcast_message`, …) | task/team/channel state | ❌ none at dispatch; role filtering is injection-time only (`LEAD_ONLY_TOOL_NAMES`, `host-tool-bridge.ts:33-43`) |
| Plugin tools (`plugin-tools.ts`) | plugin-defined | per plugin; only a per-channel on/off filter (`host-tool-bridge.ts:140-147`) |

Note: the `LEAD_ONLY_TOOL_NAMES` filter (`hostToolForRole`, `host-tool-bridge.ts:70-73`) is an **injection** filter. The
dispatch `case` labels (`:288-627`) are unconditional, and `invokeHostTool` never re-checks the role. `aml_model_promote`
is the deliberate exception — it re-checks in the dispatcher (`:1291-1294`), described in-code as
"注入层过滤 + 分发层双重校验". However, the workspace tools that a worker could reach this way delegate back into
`AgentChannelManager`, which **does** re-check the role on the business path (e.g. `manager.ts:2135-2136` for
`dispatch_task`, `:1627/:1674/:1696` for team management, `:2344-2347` cancel, `:2469-2470` reassign, `:2553` cross-channel,
`:2871-2872` channel mail, `:1463/:1487` team memory), and the REST tool-bridge fallback
(`invokeAgentWorkspaceTool`, `manager.ts:2695-2738`) only exposes three non-mutating collaboration tools. So the missing
dispatcher-level role check is a defence-in-depth gap, not by itself an escalation — **the real escalation is the
identity confusion in P0 #3**, which hands the attacker a *lead's* identity outright.

### Q3 — Unbounded state (verified declarations, writes, and eviction)

| Structure | Decl | Written | Evicted? |
|---|---|---|---|
| `manager.ts` `reflectCounts` | `:327` | `:489` | ❌ **none** |
| `manager.ts` `lastToolInvokeAt` | `:329` | `:2757` | ❌ **none** |
| `manager.ts` `ownerNameCache` | `:230` | `:241` | ❌ **none** (60 s TTL = freshness only) |
| `manager.ts` idle-sweeper `idleSince` | `:767` | `:781-782` | ❌ partial — `:784,791` only prune the currently-wired set |
| `agent-runtime.ts` `runErrorRetries` | `:173-174` | `:700-703` | ❌ only the non-requeue branch deletes (`:719`) |
| `caller.ts` `nameCache` | `:122` | `:133` | ❌ **none** |
| `harness-availability.ts` `probeCache` | `:71` | `:102` | ❌ **none** |
| `harness-models.ts` `cache` | `:37` | `:46` | ❌ **none** (bounded by 14 harness ids in practice) |
| `hitl-registry.ts` `items` / `parkDeadline` | `:50-51` | `:94-95` | ✅ on `resolve()` `:107-108`; ❌ if the owning process dies without dispose |
| `harness-process.ts` `registry` | `:36` | `:44` | ✅ `sweepHarnessProcesses` `:92-99` — but its **only** caller is `manager.ts:815`, i.e. opening `/monitor`. On an unmonitored server it is effectively unbounded |
| `tool-approvals.ts` `pending` | `:37` | `:84` | ✅ timer/decide/cancel (`:75,92,117`) |
| `tool-approvals.ts` `history` | `:43` | `:161` | ✅ `HISTORY_CAP = 50` (`:34`, `:162`) |
| `plugin-tools.ts` `byPlugin`/`byName`/`listeners` | `:53` | `:77-78,110` | ✅ `unregisterPluginTools` `:84-92` (⚠ no `server/` caller found) |
| `scheduler-loop.ts` `notified`/`lastProgress`/`progressSeen`/`goalAllDoneAt`/`loopCompletedTaskIds`/`idleSince` | `:76,78,81,83,87,94` | various | ✅ pruned every tick against `liveIds` (`:196-208`), `idleSince` `:708-720`, `:157` |
| `mailbox.ts` `arrivalCbs` | `:45-46` | `:85` | ✅ released in `finally` (`agent-runtime.ts:333-338`) |
| `monitor.ts` `events[]` | `:83` | `:92` | ❌ none — but `monitorChannel` has **no production caller** (grep: only `scripts/**`) |
| `daq-controller.ts` `metricStates` | `:136` | `:433` | ✅ prefix delete on node removal `:1028-1029` |
| `daq-controller.ts` `twinPushAt` | `:718` | `:723` | ✅ delete on device unbind `:1102` |
| `dcw-controller.ts` `opsWriteMemo` | ~`:556` | `:559` | ✅ `if (opsWriteMemo.size > 500) opsWriteMemo.clear()` `:560-561` |
| `daq-controller.ts` `siblingsCache` | `:677` | — | ✅ real LRU, `new LruMap(500)` — the only one in the tree |

**Correction to the previous audit**: `metricStates` and `twinPushAt` **are** now cleaned up on entity lifecycle (they
grow only if entities are never deleted), so the earlier "completely unbounded" verdict no longer holds.
`reflectCounts`, `lastToolInvokeAt`, `ownerNameCache`, `nameCache`, `probeCache`, `runErrorRetries` and the sweeper's
`idleSince` **remain unbounded**. `shared/lru.mjs:14 LruMap` already exists as the fix utility and is used exactly once
(`daq-controller.ts:677`).

### Q4 — Full-table scans / N+1 / absurd limits

1. `runtime/memory.ts:669` and `:673` — `repo.listByAgentWithRowid(agentId, 1_000_000)` **inside**
   `for (const agentId of repo.listMemoryAgentIds())` (`:668`). `limit = 1_000_000` + JS filter. **P1** (own finding above).
2. `runtime/memory.ts:654` — `rows.filter(r => repo.getById(r.id) !== null)`: one SELECT per row (N+1).
3. `runtime/task-engine.ts:137-139` → `task.repo.ts:80` — every task the channel ever created, no `LIMIT`, once per
   scheduler tick. **P1** (own finding above).
4. `runtime/manager.ts:1489`, `:1552` — `1_000_000` / `10_000` to fetch one memory row by id. **P1** (own finding above).
5. `runtime/manager.ts:1744-1757` — one `queueViewOf` query per candidate worker. **P1** (own finding above).
6. `industrial-tools.ts:344` — `getDcwController().listViews()` (whole DCW fleet) then `.filter(d => d.lineId === node.lineId)`
   **inside** the per-node loop of `daq_query` (`:302`): N× full-fleet materialisation per call. **P2** (also a small info
   leak — an agent sees DCW setpoints on its line for nodes it is not bound to).
7. `industrial-tools.ts:337`, `:670`, `:701`, `:732` — `getDcwController().listRecipes()` (all recipes) per node / per line,
   filtered in JS.
8. `server/api/workshop/aml/index.get.ts:16-18` — three `list({ limit: 1000 })` calls used only for `.length`
   (⚠UNVERIFIED: from the delegated API sweep).
9. Fixed already / no longer present: the `limit=1_000_000` reflection scan in `manager.ts` was pushed down
   (`manager.ts:472-474`, `memory.repo.ts:203-217`). Excluding `runtime/memory.ts`, **no `limit` ≥ 1e6 remains** under
   `server/services/workshop` (`rg -n "1_000_000"` → 2 hits, both `memory.ts`).

### Q5 — Read-path writes

| Handler | Write performed | Line |
|---|---|---|
| `GET /api/workshop/channels/:id` | wires the lead runtime + starts `SchedulerLoop` → message rows `pending → consuming → consumed`, task `UPDATE`s, harness process spawn | `channels/[id]/index.get.ts:16`, `plugins/workshop.ts:73`, `manager.ts:694-720` |
| `GET /api/workshop/workspaces` | **DB DELETE** of dangling `workspace_channels` rows from inside a `.filter()` callback | `workspaces/index.get.ts:10` → `manager.ts:1125-1129` |
| `GET /api/workshop/users/me` | same DELETE (wants only `.length`) | `users/me.get.ts:20` → `manager.ts:1125-1129` |
| `GET /api/workshop/daq` | `provisionLegacyTwins()` → `this.repo.insert(node)`; starts the 250 ms acquisition timer | `daq/index.get.ts:22`, `daq-controller.ts:1146-1163`, `:191` |
| `GET /api/workshop/daq/:id/samples`, `/frames`, `/frames/content` | each begins with `this.ensureLoop()` — starts the acquisition/storage pipeline | `daq-controller.ts:798,839,858` |
| `GET /api/system/monitor` | `sweepHarnessProcesses()` deletes registry rows; `sweepTerminalSessions()`; `ownerNameCache.set` | `manager.ts:815-816`, `:241`, `:903` |
| `GET /api/workshop/agents` | `withOwnerNames` fills a 60 s cache (no eviction) | `agents/index.get.ts:12`, `caller.ts:133` |
| `search_memory` / `recallMemory` / `recallOtherTeamsMemory` | `UPDATE agent_memories SET access_count = access_count + 1, last_accessed_at = ?` per hit — a read-shaped tool that writes rows | `memory.ts:343,360`, `manager.ts:2671`, `db/memory.repo.ts:78-80` |
| Agent tool `my_industrial_nodes` | **deletes stale binding rows from disk** via `removeAgentNodeStale` → `flush()` | `industrial-tools.ts:44-47`, `node-bindings.repo.ts:107-115,149-156` |

Whole-tree check: grepping every `server/api/**/*.get.ts` for
`recordOps|flush\(\)|\.save\(|\.update\(|\.delete\(|\.create\(|\.insert|sweep|removeAgentNodeStale|upsert|writeFile|mkdirSync|maintenance`
returns **zero** direct hits — every write above happens one layer down in a service method, which is why they survived
review. Verified pure reads include `runtime.get.ts:10`, `agent-tools/list.get.ts`, `agent-tools/bindings/index.get.ts`,
`channels/[id]/agents/index.get.ts:24-26`, `channels/[id]/queue.get.ts:23`, `mailbox.get.ts:13`,
`channels/[id]/tasks/index.get.ts:23`, `agent-tools/approvals/index.get.ts:16`.
⚠I did not open all 85 `*.get.ts` files; the dcw/daq/aml GET families were swept by a delegated audit and only partly
spot-checked by me (the two I quote as findings are verified).

### Q6 — Agent process lifecycle

- **Killed on session end**: yes, for the families that route through the tree-killer — `dispose()` →
  `killChild()` → `killHarnessProcess(pid)` (`one-shot-cli-agent.ts:148-151`, `:253-265`;
  `opencode-agent.ts:181-195`), and `AgentRuntime.stop()` awaits the loop then calls `impl.dispose?.()`
  (`agent-runtime.ts:355-370`). **Not** for `codex`/`dsh`/`qwen`/`hermes`, whose `dispose()` goes through
  `stdio-jsonrpc.ts:199-207` — `stdin.end()`, a 3 s timer, then `this.child?.kill('SIGKILL')`: single-process only, so
  grandchildren (the MCP bridge, tool subprocesses) survive. `omp` is the same (`omp-rpc-client.ts:369-389`, kill at
  `:382`). `claude` never kills at all (`claude-agent.ts:113-128` only aborts the SDK session and
  `getProcessInfo()` returns `null` — "SDK 自管二进制生命周期"). `mock` has no `dispose`.
  The asymmetry is stark: `killProcess()` on those same classes **does** use the tree-killer (`codex-agent.ts:134-138`).
- **Killed on timeout**: `omp` (`omp-agent.ts:915-928`) and the one-shot family (`one-shot-cli-agent.ts:495-502`) kill;
  `codex`, `claude`, `dsh`, `hermes`, `qwen`, `opencode` only send an engine-side interrupt/cancel, so the process keeps
  running and burning tokens while the platform reports the turn ended.
- **Killed on error**: `child.on('error')` finishes the turn (`one-shot-cli-agent.ts:442-444`) without clearing
  `this.child` (the `exit` handler does clear it at `:445-447`), so a later `killChild()` can target a stale pid; the
  `finally` block (`:520-528`) does reap the live child when the generator unwinds.
  `harness-models.ts:59` rejects on error but never clears the timer created at `:60` and never kills.
- **Killed on parent exit**: only via the Nitro `close` hook (`plugins/workshop.ts:168-174`). There is **no**
  `process.on('exit'|'SIGINT'|'SIGTERM'|'beforeExit')` anywhere under `server/` — only `unhandledRejection`
  (`plugins/workshop.ts:88`) and `uncaughtException` + `process.exit(1)` in the dev stability guard
  (`plugins/dev-stability-guard.ts:53-59`), which **skips** the close hook, orphaning every harness child.
  The pid registry is process-local (`harness-process.ts:36`), so orphans are unreachable after a restart.
  ⚠UNVERIFIED: whether Nitro's `close` hook actually fires on SIGINT/SIGTERM in this dev setup — I only confirmed the
  hook is registered.
- **Pipes drained**: `stdio-jsonrpc.ts:97-105`, `omp-rpc-client.ts:253-279`, `one-shot-cli-agent.ts:404-432` all consume
  both streams (the last caps `stderrTail` at 8 KB, `:431`). **Not drained**: `opencode-agent.ts` (stdout never
  referenced while `opencode serve` is long-lived) and `harness-models.ts:55-58` (stderr unread).
- **Leaked listeners**: `omp-rpc-client.ts:269` (one `onReady` per `start()`, cleared only in `dispose` `:397-399`);
  `stdio-jsonrpc.ts:208` (`once('exit')` survives the 3 s timeout branch that resolved first);
  `stdio-jsonrpc.ts:102-117` (child listeners never removed — no `off(`/`removeListener` in the file);
  `harness-terminal.ts:387-393` (`detachTerminalTap` clears `unsubRaw` but not `session.batchTimer`);
  `omp-agent.ts:533` / `harness-terminal.ts:545` (150 ms poll timers, never cleared).
- **Unhandled rejections**: floating promises are overwhelmingly `void`-ed or `.catch()`-ed. ⚠A delegated audit states it
  found no unguarded floating promise that can reject; I spot-checked the `void`-guarded sites and agree for the ones I
  read. The real rejection risk is synchronous throws inside `async` methods — see the `qwen`/`opencode` `supervise`
  P0s — and those are caught by `BaseAgentImpl.supervise`'s `catch { return [] }` (`base-agent.ts:160-162`), which is
  precisely why they are invisible.
- **Timers**: 13 created and never cleared/unref'd, the worst being `omp-agent.ts:620-629`, whose late fire aborts a
  **shared** subprocess turn. Only three `unref()` calls exist in the whole tree (`tool-approvals.ts:83`,
  `harness-terminal.ts:301`, `opencode-agent.ts:92`); `tool-approvals.ts:83` is the one that gets it right for a
  long-lived pending promise.

### Q7 — Correctness

- **Session ids / identity staleness**: identity is captured once in `AgentRuntime`'s constructor and config/harness are
  baked at wire time, while `updateChannelAgent` asks `unloadAgent` to release the runtime — and `unloadAgent` refuses
  when the agent is not idle (`manager.ts:745-749`). So renaming or **disabling** a busy member silently has no effect;
  a disabled worker keeps consuming and completing tasks. (Own finding above.)
  `BaseAgentImpl.refreshIdentity()` (`base-agent.ts:83-86`) does rewire the bridge identity on `init()`, and
  `one-shot-cli-agent.ts:296-301` reads `this.selfAgentId` rather than `config.agentId` — but
  `copilot-agent.ts:43,102` and similar read `config.agentId` for path derivation. ⚠UNVERIFIED whether those stale paths
  matter in practice.
- **Message ordering**: FIFO is real — `messageRepo` orders by `createdAt, rowid` with `LIMIT 1`
  (`db/message.repo.ts:31-38`) and claims with a single conditional `UPDATE` (`:110-112`), giving exactly-one-owner
  semantics. The wake-up race is handled deliberately by taking the gate reference *before* the query
  (`mailbox.ts:95-98`), and a 15 s fallback self-heals lost wakes (`:105-109`). Scheduler ticks and lead message arrival
  serialize on one lock (`scheduler-loop.ts:170` `await this.lead.withExecLock(() => this.tickRound())`,
  `agent-runtime.ts:517`). Residual hazards, from the delegated runtime audit and not re-verified by me: `injectSteer`
  claims a non-head message into a running turn (`agent-runtime.ts:276,294`), and `peek`/`waitPending` never claim
  (`mailbox.ts:119-121`) while `Mailbox.dequeue` can claim the same row in between, so an agent can process a message
  both as a poll result and as a run (no double DB consume — the ack's claim fails).
- **Streaming parse (NDJSON / JSON-RPC / SSE)**: `stdio-jsonrpc.ts:234-238` and `omp-rpc-client.ts:404-411` handle
  partial lines correctly (buffer + `lines.pop()`), `\r\n` via `trim()`, and non-JSON banners via `catch { continue }`.
  `opencode-agent.ts:866-883` does correct `\n\n` SSE framing with a carried `buf`, but only splits on `\n\n` (a
  CRLF-delimited SSE stream never splits and `buf` grows unbounded) and parses multi-line `data:` payloads line by line,
  dropping payloads that span two `data:` lines. `one-shot-cli-agent.ts:411` does **not** buffer partial lines (P1 above).
  `opencode-agent.ts:236`/`omet-rpc-client`'s caps deserve a caveat: the 8 MB guard in `stdio-jsonrpc.ts:236` runs before
  the split, so a single frame above the cap desynchronises the stream.
- **Timeout / retry**: per-turn idle watchdog `promptTimeoutMs ?? 600_000` in every process adapter
  (`omp-agent.ts:838`, `one-shot-cli-agent.ts:206,238`, `codex:238,278`, `claude:221,262`, `dsh:237,277`,
  `hermes:209,249`, `qwen:259,299`, `opencode:349,391`); RPC request timeouts in `stdio-jsonrpc.ts:133-134` (60 s from
  codex/dsh/qwen/hermes, 30 s from `harness-models.ts:110`) and `omp-rpc-client.ts:309-312` (60 s); chunk-reassembly TTL
  sweep `omp-rpc-client.ts:524-528`; SSE reconnect with 1 s backoff `opencode-agent.ts:885-889`. Retry ladder: per-message
  ≤2 (`agent-runtime.ts:700-708`), task `retryCount < 3` (`scheduler-loop.ts:415-433`). **Loop mode has no global cap**:
  `execution-mode.ts:69` and `scheduler-loop.ts:776-777` default `maxIterations` to `Number.POSITIVE_INFINITY`.
  There is **no timeout in the runtime core** for a task turn (`agent-runtime.ts:580`
  `for await (const event of this.impl.run(request, ctx))`) — protection is per-impl only.
- **Error propagation to UI**: turn failures surface as `{ kind: 'error' }` events (`one-shot-cli-agent.ts:397-399`,
  `agent-runtime.ts:704-716`) and are broadcast on the bus (`manager.ts:502-512`); delivery failures throw a visible
  `502 DELIVERY_FAILED` (`manager.ts:2494-2496`). Swallowed-error inventory (all verified by reading):
  `base-agent.ts:160-162` (`supervise` failure produces **no** event), `opencode-agent.ts:320-323`, `:286-289`,
  `qwen-agent.ts:229-231`, `scheduler-loop.ts:644` `void this.lead.recordTaskMemory(completed).catch(() => {})`,
  `agent-runtime.ts:771`, `manager.ts:1478,1521,1540` (vectorize / shared-memory saves), `memory.ts:223,612,679`,
  `mailbox.ts:78`, `hitl-registry.ts:77`, `permissions.ts:70,77`,
  `codex-agent.ts:725-727` (MCP config write failure ⇒ the agent runs **without tools** and the turn still reports
  `done`), `opencode-agent.ts:794-796` (same, bridge registration), `claude-agent.ts:527-529` (SDK stream death leaves
  the turn waiting up to the 600 s stall timer). `manager.ts:213-219` and `:235-240` swallow with **no log** at all —
  a corrupt `llm_json` silently drops the channel's default model.
- **Concurrent session limits**: per agent, turns serialize (`execLock` `agent-runtime.ts:493-508`, single consumer
  `:511-523`, plus `TURN_BUSY` in `one-shot-cli-agent.ts:268-271`). There is **no cap** on how many agents are wired or
  how large a team can grow: `wireMember` starts a runtime unconditionally (`manager.ts:666-676`), `ensureAgentRuntime`
  wires on demand (`:679-687`), `createTeamMember` eagerly wires (`:1662`), and `rg -n "MAX_TEAM_MEMBERS|maxMembers|memberLimit|MAX_AGENTS|成员上限" server/services/workshop` returns **nothing**. Total concurrency = number of
  wired agents across all channels. The only limiter in the server is for AML jobs:
  `settings.ts:228` `maxConcurrent: Number(get('job.maxConcurrent', 2))` enforced at
  `aml/job-orchestrator.ts:257`. Reclamation is the idle sweeper (`manager.ts:764-801`, `intervalMs ?? 60_000`,
  `graceMs ?? 120_000`), which refuses busy/pending runtimes (`:745-754`).
- **Status mapping**: `daq-controller.ts:797,838,857,862` throw plain `Error` with a non-standard `{status:404}` payload,
  but `defineApiHandler` only honours `AppError`/`H3Error` (`utils/response.ts:29-47`), so "node not found" becomes
  HTTP 500 plus an unhandled-error log. ⚠UNVERIFIED (delegated API sweep).

### Q8 — Redundancy

Covered in the P2 duplication finding above. Headline numbers, all re-measured on the current tree:
14 copies of the `registry.ts` agent-config spread, 10 `generateMcpBridgeEnv` call sites (with `dsh-agent.ts:485-486`
evaluating one object three times and `opencode-agent.ts:784-788` hand-rolling the helper), 13 `resolveCommand`
one-liners, 8 `workerTurn` + 8 `peerTurn` skeletons, 7 `reconcileProcess` bodies, 6 byte-identical `collectTurnEvents`,
7+7 `taskText`/`msgText` re-implementations of the existing `partsText()`, 4 `ensure*Config` MCP writers + 1 inline,
3 identical `safeId()`, 3 parts→text flatteners + 1 twin.
A delegated adapter audit expands this to 48 named sites (D1-D48) with a proposed base-class split it estimates removes
≈1 500 of the ~5 000 adapter lines; ⚠I verified the five counts listed as "verified" in the duplication finding and spot
samples of the rest, not all 48.

### Q9 — `manager.ts` extraction seams

Covered in the P2 finding above (a 28-band table mapping each line range to a target module, plus a dependency-ordered
extraction sequence and the residual ≤350-line core).

---

## Not verified in this pass

- The ~40 `dcw/**` / `daq/**` handlers a delegated audit reports as authenticate-without-authorize (no
  `requireLineMode`/`requireRole` on the target resource). I verified two of the read-leak cases
  (`dcw/recipes/index.get.ts`, `daq/alarms.get.ts`) and the two GET-write cases (`daq/index.get.ts`,
  `channels/[id]/index.get.ts`), but did not open the other ~36. My own `Select-String` sweep for
  `requireLineMode|lineMode|requireRole|requireAdmin|filterByLine|visibleLineIds` over `dcw/**` + `daq/**` is **not
  reliable evidence** here: it can miss multi-line call sites (it already produced a false negative for
  `dcw/[id]/write.post.ts`, which does call `requireLineMode` at line 19), so its "NO-GUARD" list is an upper bound on the
  problem, not a confirmed inventory.
- Whether `tsc` under the project's own `tsconfig.json` (`pnpm typecheck` = `nuxt typecheck`) reports the same error set.
  I ran an isolated invocation because the path aliases (`#imports`, `@/shared/...`) do not resolve outside Nuxt; every
  error I quote is module-internal and alias-independent, but I did not run the official task.
- Whether Nitro's `close` hook fires on SIGINT/SIGTERM in this dev setup (I confirmed only that the hook is registered).
- The reachability of the multi-recipient `route()` branch where a fan-out shares one `messageId` as a PRIMARY KEY
  (`channel-runtime.ts:71-76` + `mailbox.ts:64` + `db/database.ts:63-64`) — a latent UNIQUE-constraint failure; all
  in-file callers appear to set a single recipient, so this is structural only.
- Live measurements for: the `Mailbox` timer leak (handle counts), the concurrent-process growth, and the
  `memory.ts` maintenance scan cost.
- The delegated adapter audit's remaining duplication sites (D6-D48) beyond the samples I re-measured.
- UI/README behaviour. `README.md:317` and `:64` describe the manual-approval contract that finding #2 shows is not
  enforced on the rollback path; I did not exercise the UI to see whether it masks this.

## Appendix — how each finding was verified, and how to re-verify

| Finding | Verification actually performed |
|---|---|
| dcw_rollback authz | read `toolDcwRollback` + `rollbackNode` + `checkRollbackAllowed` in full; grepped every `.write(` call site reachable from agent tools; grepped `repo.find(agentId, nodeId, 'dcw')` and confirmed it never appears in `toolDcwRollback` |
| manual/HITL bypass | read the only HITL block (`industrial-tools.ts:126-146`) and both rollback entry points; read `resolvePolicy` and confirmed its only caller is the system sweeper |
| invoke IDOR | read `invoke.post.ts` in full, read `manager.ts:2746-2752`, traced `token: agentToken \|\| undefined` into the `!== undefined` guard; read `caller.ts:71-79` to confirm the no-header case still throws |
| takeover bypass | read both `takeover` blocks and `isStale`; confirmed neither re-checks the binding |
| bindings PATCH/DELETE/enum | read all three handler files in full and compared against `bindings/index.post.ts:28-32` |
| qwen/opencode supervise, opencode session id, opencode `p`, duplicate argv keys, shadowed privates | **compiled** the files with `npx tsc --noEmit --skipLibCheck --target esnext --module esnext --moduleResolution bundler …` and quoted the emitted errors verbatim (all reproduced) |
| GET-path writes (channels, workspaces, daq) | read the handler, the manager method, and the repo call in each chain; confirmed the DELETEs/INSERTs/`loop.start()` at the cited lines |
| scheduler full-history scan | read `task-engine.ts:95-149`, `task.repo.ts:60-90,138-174`; confirmed no `LIMIT` in any `selectByChannel*` statement |
| memory maintenance + memory-by-id limits | read `memory.ts:630-681` and `manager.ts:1483-1556` |
| unbounded maps | grepped each identifier repo-wide and enumerated every write and delete site; the table in Q3 lists them |
| NDJSON partial-line | read `one-shot-cli-agent.ts:404-428` against `stdio-jsonrpc.ts:234-252` and `omp-rpc-client.ts:404-424` |
| duplication counts | `Select-String … -AllMatches` with the exact literals, counts recorded in the table |
| manager.ts line count | `Get-Content … \| Measure-Object -Line` → 3016 (the brief's 2836 is stale) |

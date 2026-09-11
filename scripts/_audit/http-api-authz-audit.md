# HTTP API authz / read-path / perf audit — agents + runtime + industrial nodes

Read-only audit. Every claim cites `file:line` with verbatim code. No source file was modified.

Scope read in full: `server/api/workshop/agent-tools/**`, `agents/**`, `channels/**`, `dcw/**`, `daq/**`,
`runtime.get.ts`, `tasks.get.ts`, `mailbox.get.ts`, `caller.ts`, `server/services/workshop/scene-events.ts`,
`server/services/workshop/agents/agent-badge.ts`, plus the guards they delegate to
(`permissions.ts`, `runtime/manager.ts`, `agents/tool-approvals.ts`, `agents/node-bindings.repo.ts`,
`agents/host-tool-bridge.ts`, `agents/industrial-tools.ts`, `dcw/dcw-controller.ts`, `daq/daq-controller.ts`,
`aml/job-orchestrator.ts`, `aml/python-runtime.ts`).

---

## 1. AUTHZ AUDIT

### 0. Global facts

* No global auth middleware exists. The only middleware is `server/middleware/request-log.ts:7` — logging only.
* Unmatched `/api/workshop/**` paths hit `server/api/workshop/[...path].ts:12` → static 404.
* Auth primitives (`server/api/workshop/caller.ts`):
  * `resolveUser` (`:71-79`) — Bearer **user** token, else 401.
  * `resolveCaller` (`:16-24`) — Bearer **agent instance** token, else 401.
  * `resolveAgentOrUser` (`:45-54`) — either domain.
  * `requireAdmin` (`:82-88`), `requireRole` (`:91-97`).
* Line-grant model (`server/services/workshop/permissions.ts`): `isPrivilegedRole` (`:26-28`),
  `lineMode` (`:31-36`), `visibleLineIds` (`:39-42`), `filterByLine` (`:45-52`),
  `requireLineMode` (`:55-62`). admin/editor bypass everything.

### 1.1 [P0] `agent-tools/invoke.post.ts` — user token + client-supplied `agentId` = full agent impersonation

The whole handler (27 lines):

```ts
// server/api/workshop/agent-tools/invoke.post.ts:16-27
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

Note `invoke.post.ts:18`: `resolveUser(event)`'s **return value is discarded** — the authenticated user is never
passed downstream. `agentId` comes only from the request body (`:20`).

The guard it delegates to:

```ts
// server/services/workshop/runtime/manager.ts:2746-2752
async invokeHostTool(input: { agentId: string, token?: string, tool: string, args?: Record<string, unknown> }): Promise<{ text: string, isError?: boolean }> {
    const row = this.deps.repos.channelAgents.findById(input.agentId)
    if (!row || row.enabled !== 1) throw new AppError(404, 'NOT_FOUND', `agent 不存在或已停用: ${input.agentId}`)
    // token 鉴权(MCP 桥路径必带;缺省视为服务端内部调用,走 REST 已有用户鉴权)
    if (input.token !== undefined && input.token !== row.token) {
      throw new AppError(401, 'UNAUTHORIZED', 'agent token 校验失败')
    }
```

`invoke.post.ts:25` passes `token: agentToken || undefined`. **Consequences, exactly:**

| Request | `agentToken` | `input.token` | `manager.ts:2750` | Result |
|---|---|---|---|---|
| valid **user** Bearer, **no** `x-aw-agent-token`, `agentId` = any other agent | undefined | `undefined` | `input.token !== undefined` is **false** → check **skipped** | **Executes any tool as that agent** |
| **no** `Authorization` at all, no `x-aw-agent-token` | undefined | — never reached | — | `resolveUser` at `invoke.post.ts:18` throws `AppError(401,'USER_UNAUTHORIZED')` (`caller.ts:76`) → **blocked** |
| own agent token in `x-aw-agent-token`, `agentId` = another agent | own token | own token | `!== row.token` → true | 401 — **blocked** |
| valid agent token, matching `agentId` | token | `=== row.token` | passes | legitimate |

So the hole is exactly: **valid user token + arbitrary body `agentId` + absent `x-aw-agent-token`.** No ownership,
membership or role check exists anywhere on this path. The authenticated `ResolvedUser` never reaches `manager`.

After the guard, the impersonated identity drives every downstream authorization:

```ts
// server/services/workshop/runtime/manager.ts:2769-2775
        const identity = {
          agentId: row.id,
          channelId: row.channelId,
          role: (row.role === 'lead' ? 'lead' : 'worker') as 'lead' | 'worker',
          name: row.name,
        }
        return await pluginTool.handler(input.args ?? {}, identity)
```

```ts
// server/services/workshop/runtime/manager.ts:2777-2783
      const runtime = this.ensureAgentRuntime(row.channelId, input.agentId)
      if (runtime) {
        const viaImpl = await runtime.dispatchHostTool(input.tool, input.args ?? {})
        if (viaImpl) return viaImpl
      }
      // 回退:impl 未实现工具面(如 mock)→ 协作工具族直调
      return await this.invokeAgentWorkspaceTool(input.agentId, input.tool, input.args ?? {})
```

`invokeHostTool` also applies **no role/tool filtering** — unlike `hostToolsForRole`
(`host-tool-bridge.ts:70-87`) it never consults `LEAD_ONLY_TOOL_NAMES` (`host-tool-bridge.ts:33-43`).
Every tool is dispatchable for any named agent that exists and is enabled.

**Which tool classes are reachable, by whom**

Reachable by *any* authenticated user token of *any* role (including a plain `user` with zero line grants):
pick any lead/worker agent id.

* **Read-only** (dispatch table `host-tool-bridge.ts:162-211` + `:219+`):
  `my_industrial_nodes`, `aml_node_catalog`, `aml_dataset_stats`, `aml_job_status`, `aml_job_logs`,
  `aml_leaderboard`, `aml_model_reference`, `dcw_read`, `daq_query`, `daq_frames`, `dcw_journal`, `ops_log`,
  `recipe_log`, `recipe_versions`, `line_context`, `list_other_teams`, `search_other_teams_memory`,
  mailbox/list-mail/memory tools.
* **Mutating / control-plane**:
  * `dcw_control` — real PLC write. Its only authz is the *impersonated agent's* binding:
    ```ts
    // server/services/workshop/agents/industrial-tools.ts:99-108
      const repo = getAgentNodeBindingRepo()
      const binding: AgentNodeBinding | undefined = nodeId ? repo.find(agentId, nodeId, 'dcw') : undefined
      if (!binding) {
    ```
    HITL applies only when `binding.mode === 'manual'` (`industrial-tools.ts:128`); with `mode:'auto'`
    the write executes immediately (`industrial-tools.ts:157`).
  * `recipe_update` (`host-tool-bridge.ts:207-208`), `recipe_rollback` (`:209-210`), `dcw_judge` (`:193-194`),
    `dcw_rollback` (`:195-196`), `aml_dataset_build` (`:167-168`), `aml_job_cancel` (`:177-178`),
    `send_cross_channel_message` (`manager.ts:2725-2734`), `dispatch_task`, `create_team_agent`,
    `update_team_agent`, `remove_team_agent`, `complete_task`, `report_progress`.
  * `aml_model_promote` — nominally lead-only; its check is against the **DB role of the supplied agentId**:
    ```ts
    // server/services/workshop/agents/industrial-tools.ts:1290-1294
      // 治理硬守卫:晋升仅限 lead 实例(注入层过滤 + 分发层双重校验,HTTP 直调不可绕过)
      const roleRow = getAmlRuntime().db.prepare('SELECT role FROM channel_agents WHERE id = ? AND enabled = 1').get(agentId) as { role?: string } | undefined
      if (roleRow?.role !== 'lead') {
        return amlErr(`aml_model_promote 为 lead 专属工具:实例 ${agentId}(role=${roleRow?.role ?? '未知'})无权晋升模型。请由团队 lead 发起,晋升需人工 HITL 批准。`)
      }
    ```
    Naming a lead's `agentId` satisfies it (then HITL approval at `industrial-tools.ts:1316`).
  * `aml_job_submit` — **arbitrary Python execution on the server host.** The tool takes up to 500 KB of code:
    ```ts
    // server/services/workshop/agents/industrial-tools.ts:1152-1156
      if (!code.trim()) return amlErr('code 必填:train.py 全文(单文件;契约见工具说明)。')
      if (code.length > 512_000) return amlErr(`code 过大(${Math.round(code.length / 1024)}KB),上限 500KB;精简训练代码(模型定义/训练循环拆薄)后重试。`)
      if (!/\bimport\s+amlkit\b/.test(code)) {
    ```
    It is written to disk and executed:
    ```ts
    // server/services/workshop/aml/job-orchestrator.ts:285-287
        if (typeof inline === 'string' && inline.length > 0 && inline.length <= 512_000) {
          writeFileSync(join(workspace, 'train.py'), inline)
          trainFile = 'train.py'
    ```
    ```ts
    // server/services/workshop/aml/job-orchestrator.ts:328
        const exit1 = await runPython(run, vpy, [join(workspace, trainFile)], workspace)
    ```
    No container/OS sandbox; the only mitigation is a scrubbed env
    (`aml/python-runtime.ts:186-214`, `jobEnv` whitelist, "服务器 secrets … 一律不可见").
    The `import amlkit` requirement is a regex (`industrial-tools.ts:1154`), trivially satisfied.
  * Plugin tools: identity is the impersonated agent (`manager.ts:2769-2775`), no independent check —
    e.g. `diag_run` (`server/plugins-builtin/diag-bridge/index.mjs:449-450`) exports line DAQ snapshots,
    `kb_store`/`kb_index` (`server/plugins-builtin/rag-bridge/index.mjs:199,259`) mutate the knowledge base.

**Contrast with the sibling endpoint, which does it right:**

```ts
// server/api/workshop/agent-tools/list.get.ts:17-22
  if (agentToken) {
    const resolved = getWorkshopManager().resolveAgentByToken(String(agentToken))
    if (!resolved || resolved.agentId !== agentId) {
      throw createError({ statusCode: 401, statusMessage: 'agent token 校验失败' })
    }
  }
```

**Enumeration is trivial**, so no guessing is needed: `agent-tools/bindings/index.get.ts:13` returns
`{ bindings: agentId ? getAgentNodeBindingRepo().byAgent(agentId) : getAgentNodeBindingRepo().all() }` — with no
`agentId` query param, **every** binding of every agent (agentId + nodeId + kind + mode) is returned to any
authenticated user.

⚠UNVERIFIED: I did not execute a live exploit; the conclusion is from the code paths above (all read directly).
Corroboration: the same finding is already written up at `docs/audit/audit-agents.md:186-249` ("the manager's
token check is **skipped entirely** when no token is supplied … Minimal hardening: in `invokeHostTool` change the
token check to `if (input.token !== row.token)`") — and the code is **unchanged**, i.e. unfixed.

### 1.2 `bindings/index.post.ts` — permission check quoted; **target agent ownership NOT verified**

```ts
// server/api/workshop/agent-tools/bindings/index.post.ts:16-39
export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ agentId?: string, nodeId?: string, kind?: 'dcw' | 'daq', mode?: 'auto' | 'manual' }>(event) ?? {}
  const kind = body.kind ?? 'dcw'
  const nodeId = String(body.nodeId ?? '')
  // 绑定前置:节点必须存在,且用户对其所属产线有足额权限
  const lineId = kind === 'daq'
    ? getDaqController().byId(nodeId)?.lineId
    : getDcwController().byId(nodeId)?.lineId
  if (!lineId) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, `${kind === 'daq' ? '数采' : '写控'}节点不存在: ${nodeId}`)
  }
  const mode = lineMode(user, lineId)
  const needOperate = kind === 'dcw'
  if (mode === 'none' || (needOperate && mode !== 'operate')) {
    throw new AppError(403, 'LINE_FORBIDDEN', `无该产线权限:绑定${kind === 'daq' ? '数采' : '写控'}节点需对产线「${lineId}」拥有${needOperate ? '可操控' : '仅查看'}及以上权限`)
  }
  const binding = getAgentNodeBindingRepo().bind(
    String(body.agentId ?? ''),
    nodeId,
    kind,
    body.mode ?? 'auto',
  )
  return { binding }
})
```

The check at `:28-32` covers **the node's line only**. `body.agentId` is never resolved, never checked for
existence, never checked for ownership/membership:

```ts
// server/services/workshop/agents/node-bindings.repo.ts:73-78
  bind(agentId: string, nodeId: string, kind: AgentNodeBindingKind, mode: AgentNodeBindingMode): AgentNodeBinding {
    if (!agentId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'agentId 必填')
    if (!nodeId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'nodeId 必填')
    if (kind !== 'dcw' && kind !== 'daq') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `未知节点类型: ${kind}`)
    if (mode !== 'auto' && mode !== 'manual') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `未知控制模式: ${mode}`)
```

Effect: **any** authenticated user with `operate` on one line can grant that control right to **any** agent id —
their own, another user's agent, or a lead in an unrelated channel — or re-bind an existing agent with
`"mode":"auto"` to strip HITL, because `bind()` updates the mode of an existing row
(`node-bindings.repo.ts:79-83`: `if (prev) { prev.mode = mode; this.flush(); return prev }`).
The granting user need not own, belong to, or even know anything about that agent.

### 1.3 Handlers that authenticate but never authorize the resource (IDOR)

All of these call `resolveUser` and **discard the result** or use it only for logging — no ownership/role/line check:

| Handler | Auth | Missing check | Impact |
|---|---|---|---|
| `agent-tools/bindings/[id].patch.ts:10-13` | `resolveUser(event)` (`:10`) | owner / role / line | Any user flips **any** binding's mode: `getAgentNodeBindingRepo().setMode(id, body.mode ?? 'auto')` → `"auto"` **disables HITL** for another team's writes (`node-bindings.repo.ts:97-104`) |
| `agent-tools/bindings/[id].delete.ts:11-17` | `resolveUser(event)` (`:11`) | owner / role / line | Any user unbinds any agent↔node pair (`:17 !repo.unbind(id)`), also cancels that agent's pending approvals (`:19 getToolApprovals().cancelPendingFor(...)`) |
| `agent-tools/bindings/index.get.ts:10-13` | `resolveUser(event)` (`:10`) | any scope filter | Full cross-tenant binding dump (see 1.1) |
| `agent-tools/approvals/index.get.ts:11-16` | `resolveUser(event)` (`:11`) | ownership of `agentId` | Any user lists pending approvals of any agent: `getToolApprovals().listPending(agentId)`; history via `scope=history` |
| `agent-tools/list.get.ts:13-23` | user token path (`:13`) | `agentId` ownership | Tool-schema disclosure for any agent |
| `dcw/[id]/read.post.ts:13-16` | `resolveUser(event)` (`:13`) | **`requireLineMode` absent** | Any user triggers a real driver read on **any** dcw node id: `await getDcwController().readNow(id)` (`:16`) — cross-line data read |
| `dcw/[id].patch.ts:12-16` | `resolveUser(event)` (`:12`) | role / line | Any user patches **any** dcw node: name/driver/range/enabled/position — `getDcwController().patch(id, body)` (`:16`). Widening `min/max` weakens the write interlock that `dcw_control` depends on |
| `dcw/index.post.ts:13-16` | `resolveUser(event)` (`:13`) | role / line | Any user creates a write-control node (the comment at `:17` calls it "获得直写物理设备能力的入口") |
| `dcw/lines/[id].delete.ts:15-21` | `resolveUser(event)` (`:15`) | role / line | Any user deletes **any** line; `?purge=1` cascades nodes/products/recipes (`:19-21`). The sibling create is admin/editor-gated (`dcw/lines/index.post.ts:14`) |
| `dcw/lines/[id].patch.ts:11-14` | `resolveUser(event)` (`:11`) | role / line | Any user renames/recolors any line |
| `dcw/recipes/[id].delete.ts:10-12` | `resolveUser(event)` (`:10`) | role | Any user deletes any recipe |
| `dcw/recipes/index.post.ts:11-13` | `resolveUser(event)` (`:11`) | role | Any user creates recipes |
| `dcw/recipes/[id]/index.patch.ts:12` , `[id]/revert.post.ts:12` | `resolveUser` | role | Any user edits/rewrites any recipe version history |
| `dcw/products/[id].delete.ts:11-14`, `[id].patch.ts:12-16` | `resolveUser` | role | Any user deletes/edits any product (create requires admin/editor, `products/index.post.ts:12`) |
| `dcw/runs/[id]/close.post.ts:11-14` | `resolveUser(event)` (`:11`) | role | Any user closes any production run window |
| `dcw/templates/index.post.ts:11-13`, `[key].patch.ts:11-14`, `[key].delete.ts:10-12` | `resolveUser` | role | Any user mutates control templates (driver configs) |
| `dcw/test-driver.post.ts:12-15` | `resolveUser(event)` (`:12`) | role | Any user makes the server open outbound connections with a caller-supplied `driverConfig`: `getDcwController().testDriver(body.driver ?? 'mock', body.driverConfig ?? {})` |
| `daq/test-driver.post.ts:17-21` | `resolveUser(event)` (`:17`) | role | Same SSRF-ish connect primitive for DAQ protocols |
| `daq/[id]/test.post.ts:12-15` | `resolveUser(event)` (`:12`) | **`requireLineMode` absent** | Any user triggers a real connection test on any DAQ node (`:15 testNode(id)`); the dcw twin requires `operate` (`dcw/[id]/test.post.ts:16`) |
| `daq/[id].delete.ts:13-17` | `resolveUser(event)` (`:13`) | **`requireLineMode` absent** | Any user deletes any DAQ node; the patch twin requires `operate` (`daq/[id].patch.ts:19`) |
| `daq/infra/reconnect.post.ts:9-15` | `resolveUser(event)` (`:9`) | role | Any user triggers infra bring-up: `await apply(daqInfraConfig())` → `__daqApplyInfra` runs `docker compose -f … up -d …` (`server/services/workshop/daq/infra.ts:85`) |
| `daq/alarms.get.ts:11-15` | `resolveUser(event)` (`:11`) | line filter | Any user reads **all** alarms of **all** lines (`:15 listAlarms(scope, limit)`); `daq/index.get.ts:27` filters by line, this one does not |
| `daq/templates/*` (`index.post.ts:12`, `[key].patch.ts:12`, `[key].delete.ts:12`) | `resolveUser` | role | Any user mutates signal templates |
| `dcw/journal/index.get.ts:11-19` | `resolveUser(event)` (`:11`) | line scope | Any user reads the full parameter ledger for any `lineId`/`nodeId` supplied in the query |
| `dcw/[id]/param-ledger.get.ts:11-13` | `resolveUser(event)` (`:11`) | **`requireLineMode` absent** | Any user reads any node's setpoints/targets/last-good values |
| `dcw/optimizations/index.get.ts:11-21`, `[id].get.ts:11-16`, `[id]/series.get.ts:12-17` | `resolveUser` | line scope | Any user reads any line's optimization records + raw DAQ series |
| `dcw/recipes/index.get.ts:9-11` | `resolveUser(event)` (`:9`) | line scope | Returns `repo.list()`/`listRuns()` with **no** `visibleLineIds` filter (contrast `dcw/index.get.ts:29-30`, `dcw/runs/index.get.ts:12`) |
| `dcw/recipes/[id]/versions.get.ts:11-13` | `resolveUser` | line scope | Any user reads any recipe's full parameter version history |
| `server/api/workshop/runtime.get.ts:9-10` | `resolveUser(event)` (`:9`) | role | Any user enumerates wired harness agent ids + active channels |
| `server/api/workshop/daq/infra.get.ts:9` | `resolveUser` | role | Infra status disclosure (low) |

### 1.4 Handlers that ARE correctly guarded (control set)

* `agents/[id].get.ts:16-17` → `manager.requireTemplateReadable`; `agents/[id].patch.ts:28`, `[id].delete.ts:17` → `requireWritable` (`manager.ts:1083-1090`).
* `channels/[id].delete.ts:14-15`, `index.patch.ts:35-36`, `agents/index.post.ts:32-33`, `agents/[agentId].delete.ts:17-18`, `[agentId].patch.ts:18-19`, `model.patch.ts:20-21`, `position.patch.ts:19-20`, `range.patch.ts:19-20`, `stop.post.ts:18-19` → `getChannelForUser` + `requireWritable` + membership check (`manager.ts:1103-1110`, `:1067-1074`).
* `channels/[id]/messages/index.post.ts:38-39`, `tasks/index.post.ts:67-68`, `tasks/index.get.ts:22`, `queue.get.ts:17`, `events.get.ts:28`, `terminals.get.ts:19`, `messages/index.get.ts:21`, `channels/[id]/index.get.ts:13` → `getChannelForUser` (owner-or-legacy-public read).
* Memory planes: `channels/[id]/memories/**` and `channels/[id]/agents/[agentId]/memories/**` → `resolveAgentOrUser` + same-channel or `getChannelForUser`+`requireOwned`, and the manager re-checks role: `manager.ts:1508` (`仅本人或 lead 可策展 Agent 记忆`), `:1463` (`仅 lead 可写团队记忆`), `:1487`, `:1548`.
  ⚠ Note (by design, not a bug): `manager.searchAgentMemories` (`manager.ts:1441-1446`) only calls `requireMember(channelId, callerAgentId)` — **any teammate agent in the channel can search another agent's private memory** by passing that agent's id in the URL with `scope:'private'`.
* `agents/subscribe.post.ts:17-19` → `resolveCaller` + `manager.subscribe` → `requireMember` + same-channel target check (`manager.ts:2884-2893`).
* `tasks.get.ts:11-12` / `mailbox.get.ts:10-13` → `resolveCaller`, scope forced to `caller.channelId`/`caller.id`.
* Role-gated: `dcw/controller.post.ts:15`, `dcw/[id].delete.ts:14`, `dcw/lines/index.post.ts:14`, `dcw/journal/node/[nodeId]/rollback.post.ts:15`, `dcw/optimizations/[id]/judge.post.ts:15`, `[id]/rollback.post.ts:17`, `dcw/products/index.post.ts:12`, `dcw/recipes/[id]/apply.post.ts:15`, `[id]/mark-good.post.ts:13`, `[id]/rollback-good.post.ts:13`, `dcw/runs/[id]/rollback.post.ts:14`, `daq/controller.post.ts:29,49`, `daq/index.post.ts:16` (all `requireRole`/`gateDangerous`).
* `agent-tools/approvals/[id]/decide.post.ts:12-19` — `resolveUser` **used** (decider recorded + `audit`).

### 1.5 `requireLineMode` / `lineMode` audit for daq/dcw handlers

**Called (correct):**

| Handler | Line | Quote |
|---|---|---|
| `dcw/[id]/write.post.ts` | `:19` | `requireLineMode(user, getDcwController().byId(id)?.lineId, 'operate')` |
| `dcw/[id]/test.post.ts` | `:16` | `requireLineMode(user, getDcwController().byId(id)?.lineId, 'operate')` |
| `dcw/[id]/bind.post.ts` | `:16` | `requireLineMode(user, getDcwController().byId(id)?.lineId, 'operate')` |
| `dcw/[id]/bindings.put.ts` | `:17` | `requireLineMode(user, getDcwController().byId(id)?.lineId, 'operate')` |
| `dcw/lines/[id]/start.post.ts` | `:20` | `requireLineMode(user, id, 'operate')` |
| `dcw/lines/[id]/stop.post.ts` | `:20` | `requireLineMode(user, id, 'operate')` |
| `dcw/runs/[id]/data.get.ts` | `:18` | `requireLineMode(user, run?.lineId, 'readonly')` |
| `daq/[id].patch.ts` | `:19` | `requireLineMode(user, getDaqController().byId(id)?.lineId, 'operate')` |
| `daq/[id]/bind.post.ts` | `:18`, `daq/[id]/bindings.put.ts:18` | `requireLineMode(user, getDaqController().byId(id)?.lineId, 'operate')` |
| `daq/[id]/samples.get.ts` | `:16`, `daq/[id]/frames.get.ts:16`, `daq/[id]/frames/content.get.ts:17` | `requireLineMode(user, getDaqController().byId(id)?.lineId, 'readonly')` |
| `daq/alarms/[id]/ack.post.ts` | `:17` | `requireLineMode(user, alarmNodeId ? getDaqController().byId(alarmNodeId)?.lineId : undefined, 'operate')` |
| `dcw/index.get.ts` | `:18-36` | `visibleLineIds` + `filterByLine` (+ per-line `.filter`) |
| `dcw/lines/index.get.ts` | `:15-18`, `dcw/line/query.get.ts:18-21`, `dcw/runs/index.get.ts:12`, `daq/index.get.ts:27` | `visibleLineIds`/`filterByLine`; `dcw/line/query.get.ts:19-21` throws `403 LINE_FORBIDDEN` when `lineId` is outside the visible set |
| `agent-tools/bindings/index.post.ts` | `:28-32` | `lineMode(user, lineId)` (node line only — see 1.2) |

**NOT called, where a line-scoped resource is addressed** (all cited in §1.3 with their guards):
`dcw/[id]/read.post.ts` (no line check on a real driver read — worst of these),
`dcw/[id].patch.ts`, `dcw/[id]/param-ledger.get.ts`, `dcw/journal/index.get.ts`,
`dcw/optimizations/index.get.ts`, `dcw/optimizations/[id].get.ts`, `dcw/optimizations/[id]/series.get.ts`,
`dcw/recipes/index.get.ts`, `dcw/recipes/[id]/versions.get.ts`, `dcw/recipes/[id].delete.ts`,
`dcw/recipes/[id]/index.patch.ts`, `dcw/recipes/[id]/revert.post.ts`, `dcw/products/[id].patch.ts`,
`dcw/products/[id].delete.ts`, `dcw/runs/[id]/close.post.ts`, `dcw/lines/[id].patch.ts`,
`dcw/lines/[id].delete.ts`, `dcw/index.post.ts`, `dcw/templates/*`,
`daq/[id].delete.ts`, `daq/[id]/test.post.ts`, `daq/alarms.get.ts`, `daq/templates/*`,
`daq/test-driver.post.ts`, `dcw/test-driver.post.ts`.

---

## 2. READ-PATH WRITES (`*.get.ts` that mutate)

| GET handler | Write / side effect | Quote |
|---|---|---|
| `server/api/workshop/daq/index.get.ts:22` | **DB insert + runtime creation + 250 ms timer**: `provisionLegacyTwins()` → `this.repo.insert(node)` | `ctrl.provisionLegacyTwins()` (`index.get.ts:22`); `daq-controller.ts:1142-1159`: `provisionLegacyTwins(): void {` … `this.repo.insert(node)` (`:1157`) … `this.syncRuntimes()` (`:1159`); `ensureLoop()` at `:1143` starts `this.timer = setInterval(() => this.sweep(), 250)` (`:191`) |
| `server/api/workshop/daq/index.get.ts:20` | Pipeline power-on: queue consumer + TSDB init | `await Promise.all([tsdbReady, getDaqQueue()])` (`:20`); comment `:18` `// ws.ts 出口装配 + 管线上电(幂等;路由模块加载即绑定)` |
| `server/api/workshop/daq/[id]/samples.get.ts:23` (via `:16` guard) | **Starts acquisition**: `samples()` → `ensureLoop()` | route `:23 const points = await getDaqController().samples(id, {...})`; `daq-controller.ts:793-795`: `async samples(id, opts) {` / `this.ensureLoop()` / `await tsdbReady` |
| `server/api/workshop/daq/[id]/frames.get.ts:20` | same | route `:20 const frames = await getDaqController().frames(id, {...})`; `daq-controller.ts:835 this.ensureLoop()` |
| `server/api/workshop/daq/[id]/frames/content.get.ts:23` | same | route `:23 const { data, mime } = await getDaqController().frameContent(...)`; `daq-controller.ts:854 this.ensureLoop()` |
| `server/api/workshop/channels/[id]/index.get.ts:16` | **Assembles lead runtime + starts SchedulerLoop (timer + loop resubmit callback)** | `ensureLeadSchedulerLoop(manager, channelId)` (`:16`), comment `:15` `// 兜底:详情请求时确保 lead 的调度循环已装配(如启动恢复遗漏)`; → `plugins/workshop.ts:73 manager.ensureChannelActive(channelId, options)` → `manager.ts:697-719` `const cr = this.ensureChannelRuntime(channelId)` … `cr.scheduler = loop` / `loop.start()` ⚠(whether `wireMember` immediately spawns a harness subprocess was not traced) |
| `server/api/workshop/dcw/index.get.ts:13`, `dcw/lines/index.get.ts:12`, `dcw/line/query.get.ts:15`, `dcw/runs/[id]/data.get.ts:14` | Global binding mutation: repoints the controller's broadcast sink each request | `bindDcwBroadcast(broadcastSceneEvent)` → `dcw-controller.ts` `setBroadcast(fn)`; `daq/index.get.ts:19`, `dcw/[id]/read.post.ts:14` etc. use `bindDaqHost(broadcastSceneEvent)` |
| `server/api/workshop/dcw/index.get.ts:32` | Over-fetch then JS trim (not a write, but a read amplification) | `ctrl.listHistory(400).filter(h => inLine(nodeLine(h.nodeId))).slice(0, 60)` |

**Purely read-only GETs (verified line by line):** `agent-tools/list.get.ts`, `agent-tools/approvals/index.get.ts`,
`agent-tools/bindings/index.get.ts`, `agents/index.get.ts`, `agents/[id].get.ts`,
`channels/[id]/events.get.ts`, `channels/[id]/queue.get.ts`, `channels/[id]/tasks/index.get.ts`,
`channels/[id]/terminals.get.ts` (`harness-terminal.ts:451-466` pure map over a Map),
`channels/[id]/messages/index.get.ts`, `channels/[id]/agents/index.get.ts`,
`channels/[id]/memories/index.get.ts`, `channels/[id]/agents/[agentId]/memories/index.get.ts`,
`channels/[id]/plugins/index.get.ts`, `dcw/index.get.ts` (only the binding call above),
`dcw/lines/index.get.ts`, `dcw/line/query.get.ts`, `dcw/recipes/index.get.ts`, `dcw/recipes/[id]/versions.get.ts`,
`dcw/runs/index.get.ts`, `dcw/runs/[id]/data.get.ts` (`dcw-controller.ts:964-999` queries only),
`dcw/journal/index.get.ts` (`recipe-rollback-manager.ts:652-654`), `dcw/[id]/param-ledger.get.ts` (`:627-649`),
`dcw/optimizations/index.get.ts` (`:656-658`), `dcw/optimizations/[id].get.ts`,
`dcw/optimizations/[id]/series.get.ts` (`:602-623` read-only), `daq/alarms.get.ts` (`daq-controller.ts:600-604`),
`daq/infra.get.ts`, `runtime.get.ts` (`manager.ts:803-808`), `tasks.get.ts`, `mailbox.get.ts`
(`manager.ts:2834-2840`; the query has no LIMIT — see §3).

Note the memory list GET `channels/[id]/agents/[agentId]/memories/index.get.ts:28` calls `manager.listMemories`
which is a pure read (`manager.ts:1421-1426`).

---

## 3. UNBOUNDED STATE + PERF

### 3.1 Module-level maps/sets/arrays in scope

1. **`server/api/workshop/caller.ts:122` — unbounded, no eviction.**
   ```ts
   const nameCache = new Map<string, { name: string | null, at: number }>()
   ```
   Writes (all writes in the file):
   ```ts
   // caller.ts:124-134
     const hit = nameCache.get(userId)
     if (hit && Date.now() - hit.at < 60_000) return hit.name
     ...
     nameCache.set(userId, { name, at: Date.now() })
   ```
   The 60 s TTL is consulted only when the **same** key is read again; there is **no eviction found** (no sweep,
   no size cap, no `delete`). Every distinct `ownerUserId` ever rendered by `withOwnerNames` stays for the process
   lifetime. `withOwnerNames` (`caller.ts:105-119`) creates a per-call `Map` (`:106`) which is request-scoped (fine).
2. **`server/services/workshop/scene-events.ts:20-27` — unbounded, no cap.**
   ```ts
   const g = globalThis as typeof globalThis & {
     __sceneEventPeers?: Set<WsPeer>
   }

   /** 在线 peer 注册表(ws 路由 sub 成功时登记,断开/退订移除) */
   function peers(): Set<WsPeer> {
     return g.__sceneEventPeers ??= new Set()
   }
   ```
   Write: `scene-events.ts:50-52 export function registerScenePeer(peer: WsPeer): void { peers().add(peer) }`.
   Full analysis in §5.
3. **`server/services/workshop/runtime/manager.ts:329` — in the invoke path, unbounded, no eviction.**
   ```ts
   private readonly lastToolInvokeAt = new Map<string, number>()
   ```
   Writes: `manager.ts:2757 this.lastToolInvokeAt.set(input.agentId, Date.now())` (every `invokeHostTool` call);
   reads: `manager.ts:704 toolActivityOf: (agentId: string) => this.lastToolInvokeAt.get(agentId) ?? null`.
   No `delete`/cap → one entry per distinct agentId ever invoked, forever (small, but unbounded and attacker-reachable
   via §1.1, e.g. spraying `agentId` values that exist).
4. **`server/services/workshop/agents/tool-approvals.ts:37-43` — bounded.**
   ```ts
   private pending = new Map<string, { approval: ToolApproval, resolve: ..., timer: NodeJS.Timeout }>()
   ...
   private history: ToolApproval[] = []
   ```
   Eviction exists: timeout deletes (`:75 this.pending.delete(approval.id)`), decide deletes (`:92`),
   cancel deletes (`:117`), history capped (`:162 if (this.history.length > HISTORY_CAP) this.history.splice(HISTORY_CAP)`).
5. `scene-events.ts` per-peer visible-lines is stashed on the peer object (`:35`), no separate collection.
6. Request-scoped only (not leaks): `harnesses.get.ts:18`, `channels/[id]/plugins/index.put.ts:30`,
   `channels.post.ts:51`, `daq/alarms/[id]/ack.post.ts` (no map), `ws.ts:188 peerBudget = new WeakMap(...)` (GC-safe).
   `harness-terminal.ts` `sessions` Map has a sweep — `harness-terminal.ts:469-479 sweepTerminalSessions(...)`
   (`sessions.delete(pid)`), invoked from `manager.ts:816`.

### 3.2 Full-table fetch + JS filtering

* `server/api/workshop/dcw/index.get.ts:29-36` — five full arrays filtered in JS:
  `recipes: visible ? ctrl.listRecipes().filter(r => inLine(r.lineId)) : ctrl.listRecipes()`, likewise `runs`,
  `products`, `lines`, `lineStates`.
* `server/api/workshop/dcw/index.get.ts:31-33` — **N+1 in JS**: `ctrl.listHistory(400).filter(h => inLine(nodeLine(h.nodeId))).slice(0, 60)`
  where `nodeLine = (nodeId: string): string | undefined => ctrl.byId(nodeId)?.lineId` (`:22`) and
  `byId` is a linear scan: `dcw-node.repo.ts:40-42 byId(id: string): DcwNode | undefined { return this.list.find(n => n.id === id) }`
  → up to 400 × nodeCount comparisons per request.
* `server/api/workshop/agent-tools/bindings/index.get.ts:13` — `getAgentNodeBindingRepo().all()` returns the whole JSON list (`node-bindings.repo.ts:48-50`).
* `server/api/workshop/dcw/recipes/index.get.ts:11` — `{ recipes: repo.list(), runs: repo.listRuns() }`, no filter/limit.
* `server/api/workshop/channels/[id]/tasks/index.get.ts:23` — `taskEngineOf(manager).list(channelId)` →
  `task.repo.ts:67 SELECT ${COLS} FROM tasks WHERE channel_id = ? ORDER BY createdAt ASC, rowid ASC` — **no LIMIT**; every task row of the channel is returned.
* `server/api/workshop/mailbox.get.ts:12-13` — client `limit` (uncapped) then fetch-all-and-slice:
  `manager.ts:2834-2839 pollMailbox(...) { this.requireMember(...); return this.deps.repos.messages.listPendingByChannelAgent(channelId, callerAgentId).slice(0, limit).map(rowToMessage) }` — the repo query at that call site passes no limit (`message.repo.ts:91-95` has a `LIMIT ?` variant, unused here).
* `manager.ts:1552 listByAgent(targetAgentId, 10_000)` (delete memory path) and
  `manager.ts:1489 listByAgentChannel(channelId, TEAM_AGENT_ID, 1_000_000)` (delete team memory) — huge limits.
* Member lookups fetch the whole roster then search: `channels/[id]/agents/[agentId].patch.ts:20-21`,
  `[agentId].delete.ts:19-20`, `[agentId]/stop.post.ts:20-21`, `model.patch.ts:22-23`, `position.patch.ts:21-22`,
  `range.patch.ts:21-22` all do `const members = await manager.listChannelAgents(channelId)` + `.some(...)`/`.find(...)`.
* `dcw/line/query.get.ts:26` → `dcw-controller.ts:888 getDaqNodeRepo().all().filter(...)`, then one TSDB round trip.
* `dcw/runs/[id]/data.get.ts:19` → `dcw-controller.ts:979-986`: `getDaqNodeRepo().all().filter(...)` then
  `await Promise.all(lineNodes.map(async (node) => ... getTsdb().query(node.id, ...)))` — one TSDB query **per node**
  (documented as intentional at `:977`).
* `channels/[id]/agents/[agentId]/model.patch.ts:34` — `for (const a of repo.listAll())` full asset list per request.
* `agents/index.get.ts:12` → `withOwnerNames(templates)` does one user lookup per template, 60 s-cached, never evicted (`caller.ts:105-135`).

### 3.3 Limits

Huge / unbounded as passed from the route:

* `mailbox.get.ts:12-13` — no upper bound: `const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10)` … `limit > 0 ? limit : 50`.
* `channels/[id]/tasks/index.get.ts:23` — no limit parameter at all.
* `dcw/index.get.ts:32` — `listHistory(400)` (then slices to 60).
* `dcw/line/query.get.ts:35`, `dcw/[id]/param-ledger.get.ts` (`limit: 30`/`20` internal), `dcw/[id]/samples`:
  `limit: num(q.limit)` passed raw, clamped only downstream at the adapter:
  `timescale.adapter.ts:109 const limit = Math.min(opts.limit ?? 500, 5000)` / `:157 Math.min(q.limit ?? 2000, 10_000)`;
  `sqlite.adapter.ts:128`, `:182` identical.
* Properly capped: `audit.get.ts:15 Math.min(500, Math.max(1, Number(q.limit) || 100))`,
  `dcw/journal/index.get.ts:18 Math.min(limit, 500)`, `dcw/optimizations/index.get.ts:20`, `events.get.ts:18 limit: z.coerce.number().int().min(1).max(1000)`,
  `messages/index.get.ts:13 max(500)`, `daq/alarms.get.ts:14 Math.min(500, ...)`, `daq/[id]/frames` clamp at
  `daq-controller.ts:849 Math.min(Math.max(opts.limit ?? 100, 1), 1000)`, `manager.listChannelMail` `Math.min(500, ...)` (`manager.ts:2874`).

---

## 4. ERROR PROPAGATION

### 4.1 Swallowed errors that hide failures

* `server/api/workshop/caller.ts:127-132` — user-name resolution failure is invisible:
  ```ts
    try {
      name = userRepository.findById(userId)?.name ?? null
    }
    catch {
      name = null
    }
  ```
  `withOwnerNames` then renders `ownerName: null` (`caller.ts:113-118`) with no log — a broken `users.sqlite`
  looks like "no owner" in every list that uses it (`agents/index.get.ts:12`).
* `server/api/workshop/caller.ts:28-33` — `resolveCallerOrNull` swallows every error including 401:
  ```ts
    try {
      return resolveCaller(event)
    }
    catch {
      return null
    }
  ```
  Consumed at `channels/[id]/agents/index.get.ts:20-23`, where a genuine failure of the user path is silently
  downgraded to the agent-token path.
* `server/api/workshop/audit.get.ts:24-29` — corrupt audit detail is silently replaced by `{}`:
  ```ts
      try {
        detail = JSON.parse(String(r.detailJson ?? '{}'))
      }
      catch {
        detail = {}
      }
  ```
* `server/api/workshop/dcw/[id].delete.ts:18` — `const body = await readBody<{ approvalId?: string }>(event).catch(() => ({})) ?? {}` (deliberate, DELETE-with-empty-body).
* Sanctioned-but-opaque fire-and-forget in the memory write paths: `manager.ts:1478`,
  `manager.ts:1515-1521`, `manager.ts:1540` — `void vectorizeMemory(...).catch(() => {})` and
  `.then(...).catch(() => {})` (vectorization failures never surface).
* `server/services/workshop/permissions.ts:70` and `:76` — `}).catch(() => {})` on both broadcast paths
  (`broadcastSceneEvent('permissions.changed')`, `emitPluginEvent('permissions:changed')`): a failed permission-change
  broadcast means clients keep stale grants with no log.
* `server/services/workshop/scene-events.ts:74-79` — send failures delete the peer silently (see §5).
* `server/services/workshop/daq/daq-controller.ts:1189` — `.catch(() => {})` on queue start;
  `dcw-controller.ts:836` — `.catch(() => {})` on `markLineOffline`.

### 4.2 Internal error messages returned to the client (info leak)

* `server/services/workshop/runtime/manager.ts:2785-2788` — raw internal `Error.message` is returned to the HTTP
  caller as tool output (this is the endpoint of §1.1):
  ```ts
    catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { text: `工具「${input.tool}」调用失败: ${reason}`, isError: true }
    }
  ```
  e.g. SQLite constraint text, filesystem paths from `saveJsonFileAtomic`, driver/Modbus errors.
* `server/api/workshop/ws.ts:739` — `message: error instanceof Error ? error.message : 'workshop 未初始化'` is sent
  to the client in an `error` control frame.
* Generic 500 path is clean: `server/utils/response.ts:44-46` logs the error and returns
  `{ code: 'INTERNAL_ERROR', message: '服务器内部错误' }` — no stack, no message.

### 4.3 Status-code mis-mapping (failures reported as 500)

`server/api/workshop/daq/[id]/samples.get.ts` / `frames.get.ts` / `frames/content.get.ts` call controller methods
that throw a **plain** `Error` carrying a non-standard `status` property:

```ts
// server/services/workshop/daq/daq-controller.ts:797
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
```
```ts
// server/services/workshop/daq/daq-controller.ts:857, :862
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
    ...
    if (!row || row.kind !== 'image') throw Object.assign(new Error(`帧不存在: ${id}@${tsMs}`), { status: 404 })
```

`defineApiHandler` only honors `AppError` (`response.ts:30-33`) and `H3Error` (`:34-43`); a plain `Error` falls to
`console.error('[api] unhandled error:', error)` + HTTP 500 (`response.ts:44-46`). So "node not found" surfaces to
the UI as a 500, and the internal process is logged as an unhandled error.

---

## 5. SCENE EVENTS (`server/services/workshop/scene-events.ts`)

**Subscriber tracking** — a `globalThis`-backed `Set` of duck-typed peers:

```ts
// scene-events.ts:14-18
interface WsPeer {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}
```
```ts
// scene-events.ts:20-27
const g = globalThis as typeof globalThis & {
  __sceneEventPeers?: Set<WsPeer>
}

/** 在线 peer 注册表(ws 路由 sub 成功时登记,断开/退订移除) */
function peers(): Set<WsPeer> {
  return g.__sceneEventPeers ??= new Set()
}
```

**Subscribe path** (only after user auth; a per-peer line-visibility set is stamped on the peer object):

```ts
// server/api/workshop/ws.ts:174-177
function attachScenePeer(peer: WsPeer, user: { id: string, role: string }): void {
  setPeerVisibleLines(peer, visibleLineIds(user))
  registerScenePeer(peer)
}
```
```ts
// scene-events.ts:34-36
export function setPeerVisibleLines(peer: WsPeer, visible: Set<string> | null): void {
  (peer as WsPeer & { __awVisibleLines?: Set<string> | null }).__awVisibleLines = visible
}
```
```ts
// scene-events.ts:50-52
export function registerScenePeer(peer: WsPeer): void {
  peers().add(peer)
}
```
Call sites: `ws.ts:176` only (grep: `registerScenePeer` appears in `scene-events.ts:50` and `ws.ts:176`).

**Unsubscribe path — exists, on socket close and error:**

```ts
// server/api/workshop/ws.ts:753-762
  close(peer) {
    unsubscribePeer(peer)
    unregisterScenePeer(peer)
  },

  error(peer, error) {
    console.error('[workshop-ws] connection error:', error)
    unsubscribePeer(peer)
    unregisterScenePeer(peer)
  },
```
```ts
// scene-events.ts:54-56
export function unregisterScenePeer(peer: WsPeer): void {
  peers().delete(peer)
}
```

**Max subscriber count: NONE.** There is no cap anywhere — grep for `__sceneEventPeers` yields only `scene-events.ts:21,26`;
`registerScenePeer` (`:50-52`) performs an unconditional `add` with no size check, and `sceneEventPeerCount()`
(`:58-60`) is exported but never called by any handler (grep: only its own declaration).

**Dead-subscriber removal (two mechanisms, both partial):**

1. Close/error hooks above.
2. Lazy removal when a send throws:
```ts
// scene-events.ts:72-80
  for (const peer of peers()) {
    if (lineId !== undefined && !peerSeesLine(peer, lineId)) continue
    try {
      peer.send(frame)
    }
    catch {
      peers().delete(peer)
    }
  }
```
   same pattern in `broadcastPeerEvent` (`:92-99`).

**Can a subscriber leak? Yes — with the caveat that the primary paths are covered.**
* The removal depends entirely on the ws route's `close`/`error` hooks firing (`ws.ts:753-762`). There is **no
  heartbeat/liveness timeout and no size cap** in the scene-peer set itself: a peer whose `send()` never throws
  (e.g. half-open TCP where the write lands in the kernel buffer) and whose close hook never fires stays registered
  for the process lifetime. The slow-consumer guard at `ws.ts:199-206` (`peer.close(1013, 'slow consumer')` +
  `stream.peers.delete(peer)`) exists but only bounds *stream* fan-out, and relies on that same close hook to reach
  `unregisterScenePeer`.
* The registry lives on `globalThis` (`scene-events.ts:20-22`) while peers are created per module instance, so any
  module re-evaluation (dev HMR / nitro re-import) keeps the old peer objects in the same Set until their close hook
  fires; nothing prunes stale entries.
* Broadcast cost is unbounded per frame: `broadcastSceneEvent` (`:66-81`) serializes once (`:71`) then loops all
  peers and `send`s synchronously — with N pages open, every scene event costs N sends (by design per the comment at
  `:62-65`), so a subscriber-count leak degrades CPU linearly with no ceiling.

---

## Priority summary

1. **P0** `agent-tools/invoke.post.ts:18+25` + `manager.ts:2750` — any user token + arbitrary `agentId` ⇒ act as any
   agent (PLC writes, recipe writes, model promotion, arbitrary training Python). Unfixed; previously documented at
   `docs/audit/audit-agents.md:186-249`.
2. **P0** `bindings/[id].patch.ts` — any user can flip any binding to `mode:'auto'`, silently removing HITL from
   another team's control path.
3. **P1** `dcw/[id]/read.post.ts`, `dcw/[id].patch.ts`, `dcw/index.post.ts`, `dcw/lines/[id].delete.ts`,
   `daq/[id].delete.ts`, `daq/[id]/test.post.ts`, `daq/alarms.get.ts`, `dcw/journal/*`, `dcw/optimizations/*`,
   `dcw/recipes/index.get.ts`, `dcw/recipes/[id]/versions.get.ts`, `dcw/[id]/param-ledger.get.ts` — authenticated
   but unscoped access to industrial data/control.
4. **P1** `bindings/index.post.ts:33-38` — binds any `agentId` without resolving or authorizing it.
5. **P2** GET handlers that start acquisition/pipelines and insert rows (`daq/index.get.ts:20-22`,
   `daq/[id]/samples.get.ts`→`daq-controller.ts:794`, `channels/[id]/index.get.ts:16`).
6. **P2** `daq/test-driver.post.ts` / `dcw/test-driver.post.ts` — caller-controlled outbound connect primitive.
7. **P3** `caller.ts:122` uncapped `nameCache`; `manager.ts:329` uncapped `lastToolInvokeAt`; no scene-peer cap.
8. **P3** `daq` 404s surface as 500 (`daq-controller.ts:797,838,857,862` vs `response.ts:29-47`).
9. **P3** swaggered error text: `manager.ts:2787` returns raw `err.message` to callers.

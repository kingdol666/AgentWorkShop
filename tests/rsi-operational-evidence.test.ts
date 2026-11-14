/**
 * PR-C 回归(2026-11-14):RSI 只读运行证据。
 *  ① DAQ latest/history/tagged/frames 走注入的既有 DAQ 读取端口;
 *  ② DCW ACK/回读/干预台账写审计走既有权威;
 *  ③ 跨线/跨节点请求 fail-closed;
 *  ④ 显式时间窗、来源版本/hash、readOnly/writeCount=0(无写面);
 *  ⑤ 插件路由 POST /evidence/operational 的授权与 capability 接线。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ContextAdapter, ContextAdapterOperationRequest } from '../server/services/workshop/context/contracts'
import { createIndustrialReadAdapter } from '../server/services/workshop/context/adapters/industrial-read'
import { ContextAdapterRegistry } from '../server/services/workshop/context/registry'
import { canonicalHash } from '../shared/context/hash'
import plugin from '../.AgentWorkShop/plugins/rsi-interface-beta/index.mjs'

const capturedAt = '2026-11-14T10:00:00.000Z'
const nowMs = Date.parse(capturedAt)
const authorization = {
  scope: { workspaceId: 'ws-1', channelId: 'ch-1', workerId: 'worker-1' },
  principal: { id: 'operator', role: 'user' },
  metadata: { boundLineIds: ['line-a'] },
  industrial: true,
}

const lineA = { id: 'line-a', name: 'Line A', description: '', controlMode: 'manual', simulated: true, createdAt: capturedAt }
const lineB = { id: 'line-b', name: 'Line B', description: '', controlMode: 'manual', simulated: true, createdAt: capturedAt }
const daqFresh = {
  id: 'daq-a', lineId: 'line-a', name: 'Temperature', templateRef: 'daq.temp', driver: 'mock', enabled: true,
  unit: 'C', value: 42.5, lastAt: '2026-11-14T09:59:30.000Z', min: 0, max: 100,
}
const daqStale = {
  id: 'daq-b', lineId: 'line-a', name: 'Pressure', templateRef: 'daq.press', driver: 'mock', enabled: true,
  unit: 'bar', value: 3.2, lastAt: '2026-11-14T09:00:00.000Z', min: 0, max: 10,
}
const daqForeign = {
  id: 'daq-x', lineId: 'line-b', name: 'Foreign', templateRef: 'daq.temp', driver: 'mock', enabled: true,
  unit: 'C', value: 1, lastAt: null, min: 0, max: 10,
}
const dcwNode = {
  id: 'dcw-a', lineId: 'line-a', name: 'Setpoint', templateRef: 'dcw.temp', driver: 'mock', enabled: true,
  unit: 'C', value: 50, readValue: 48, lastAckAt: '2026-11-14T09:59:40.000Z', lastWriteAt: '2026-11-14T09:59:40.000Z',
  state: 'ok', lastError: null, stepLimit: 2, min: 0, max: 100,
}

const services = {
  lines: { all: () => [lineA, lineB], byId: (id: string) => [lineA, lineB].find(line => line.id === id) },
  products: { all: () => [], byId: () => undefined },
  recipes: { list: () => [], byId: () => undefined, listRuns: () => [], runById: () => undefined },
  dcwNodes: { all: () => [dcwNode] },
  daqNodes: { all: () => [daqFresh, daqStale, daqForeign] },
  bindings: { all: () => [] },
  twins: { listAll: () => [], findById: () => undefined },
}

const writeAuditRow = {
  id: 'evt-1', ts: '2026-11-14T09:59:40.000Z', lineId: 'line-a', nodeId: 'dcw-a', nodeName: 'Setpoint',
  fromValue: 50, toValue: 52, actualValue: 51.9, ack: 'ACK-OK', path: 'agent', actor: 'agent-1', actorName: 'Agent',
  channelId: 'ch-1', approvalId: 'approval-1', recipeRunId: null, hypothesis: 'sensitive hypothesis text',
  targetNodeId: null, criterion: null, settleMs: null, verdict: 'pending' as const, effect: null,
  ciLow: null, ciHigh: null, mde: null, verdictDetail: null, createdAt: capturedAt, updatedAt: capturedAt,
}

function makeAdapter() {
  const calls = { latest: [] as string[], history: [] as string[], tagged: 0, frames: [] as string[], audit: [] as string[] }
  const adapter = createIndustrialReadAdapter({
    services: services as never,
    authorize: () => authorization,
    now: () => capturedAt,
    operational: {
      now: () => nowMs,
      latest: async (nodeId) => {
        calls.latest.push(nodeId)
        if (nodeId === 'daq-a') return [{ at: nowMs - 30_000, value: 42.5 }]
        if (nodeId === 'daq-b') return [{ at: nowMs - 3_600_000, value: 3.2 }]
        return []
      },
      history: async (nodeId, q) => {
        calls.history.push(nodeId)
        return {
          points: [{ at: q.fromMs + 1000, value: 1 }, { at: q.toMs - 1000, value: 2 }],
          resolution: 'raw' as const,
          coverage: {
            requestedFromMs: q.fromMs,
            requestedToMs: q.toMs,
            availableFromMs: q.fromMs,
            rawFromMs: q.fromMs,
            truncated: false,
            note: 'fixture window',
          },
        }
      },
      tagged: async () => {
        calls.tagged += 1
        return new Map([['daq-a', [{ at: nowMs - 30_000, value: 42.5 }]]])
      },
      frames: async (nodeId) => {
        calls.frames.push(nodeId)
        return [{
          at: nowMs - 60_000,
          kind: 'vector' as const,
          points: Array.from({ length: 300 }, (_, index) => index),
          metrics: { avg: 149.5 },
          meta: { source: 'fixture' },
          productId: 'product-1',
          recipeId: 'recipe-1',
          runId: 'run-1',
        }]
      },
      writeAudit: async (filter) => {
        calls.audit.push(String(filter.nodeId))
        return [writeAuditRow]
      },
    },
  })
  return { adapter, calls }
}

function request(payload: Record<string, unknown>, withAuthorization = true): ContextAdapterOperationRequest {
  return {
    adapterId: 'industrial-read',
    apiVersion: 'context-adapter.v1',
    version: '1.0.0',
    generation: 1,
    capability: 'observe',
    payload,
    idempotencyKey: 'operational-test-key',
    timeoutMs: 5000,
    ...(withAuthorization ? { authorization } : {}),
  } as ContextAdapterOperationRequest
}

test('observe reads DAQ freshness and DCW ACK/readback/write-audit without any write path', async () => {
  const { adapter } = makeAdapter()
  assert.equal(adapter.capabilities.observe, true)
  const before = JSON.stringify({ daqFresh, daqStale, dcwNode })
  const result = await adapter.observe!(request({ lineId: 'line-a' })) as Record<string, unknown>
  assert.equal(result.readOnly, true)
  assert.equal(result.writeCount, 0)
  assert.equal(JSON.stringify({ daqFresh, daqStale, dcwNode }), before, '读取不得修改节点状态')
  const daq = result.daq as Array<Record<string, unknown>>
  assert.equal(daq.length, 2, '仅返回绑定线上的 DAQ 节点')
  const fresh = daq.find(node => node.nodeId === 'daq-a')!
  assert.equal((fresh.latest as Record<string, unknown>).value, 42.5)
  assert.equal((fresh.latest as Record<string, unknown>).freshness, 'fresh')
  assert.equal((fresh.latest as Record<string, unknown>).ageMs, 30_000)
  const stale = daq.find(node => node.nodeId === 'daq-b')!
  assert.equal((stale.latest as Record<string, unknown>).freshness, 'stale')
  const dcw = (result.dcw as Array<Record<string, unknown>>)[0]!
  assert.equal(dcw.readValue, 48)
  assert.equal(dcw.ackFresh, true)
  assert.equal(dcw.stepLimit, 2)
  const audit = dcw.writeAudit as Array<Record<string, unknown>>
  assert.equal(audit[0]?.ack, 'ACK-OK')
  assert.equal(audit[0]?.actualValue, 51.9)
  assert.equal(audit[0]?.approvalId, 'approval-1')
  assert.equal('hypothesis' in (audit[0] ?? {}), false, '写审计不得外泄假设文本')
  assert.equal((result.source as Record<string, unknown>).sourceRevision, String((result.source as Record<string, unknown>).contentHash).slice(0, 16))
})

test('history/tagged/frames require an explicit window and read through the DAQ ports', async () => {
  const { adapter, calls } = makeAdapter()
  await assert.rejects(
    () => adapter.observe!(request({ lineId: 'line-a', history: true })) as Promise<unknown>,
    /explicit fromMs < toMs window/,
  )
  await assert.rejects(
    () => adapter.observe!(request({ lineId: 'line-a', window: { fromMs: nowMs, toMs: nowMs - 1 } })) as Promise<unknown>,
    /fromMs < toMs/,
  )
  const window = { fromMs: nowMs - 3_600_000, toMs: nowMs, bucketMs: 60_000, limit: 10 }
  const result = await adapter.observe!(request({ lineId: 'line-a', window, history: true, tagged: true, frames: true })) as Record<string, unknown>
  const daq = result.daq as Array<Record<string, unknown>>
  const fresh = daq.find(node => node.nodeId === 'daq-a')!
  const history = fresh.history as Record<string, unknown>
  assert.equal(history.resolution, 'raw')
  assert.equal((history.points as unknown[]).length, 2)
  assert.deepEqual((fresh.tagged as unknown[]).length, 1)
  const frames = fresh.frames as Array<Record<string, unknown>>
  assert.equal(frames[0]?.kind, 'vector')
  assert.equal(frames[0]?.pointCount, 300)
  assert.equal((frames[0]?.points as unknown[]).length, 256, '向量预览截断到 256 点')
  assert.equal(calls.tagged, 1)
  assert.deepEqual(calls.frames.sort(), ['daq-a', 'daq-b'])
  const counts = (result.source as Record<string, unknown>).counts as Record<string, number>
  assert.equal(counts.historyPoints, 4)
  assert.equal(counts.frames, 2)
})

test('cross-line lines and nodes fail closed, including explicit foreign node ids', async () => {
  const { adapter } = makeAdapter()
  await assert.rejects(
    () => adapter.observe!(request({ lineId: 'line-b' })) as Promise<unknown>,
    /operational line is outside authorized bindings/,
  )
  await assert.rejects(
    () => adapter.observe!(request({ lineIds: ['line-a', 'line-b'] })) as Promise<unknown>,
    /operational line is outside authorized bindings/,
  )
  await assert.rejects(
    () => adapter.observe!(request({ lineId: 'line-a', daqNodeIds: ['daq-x'] })) as Promise<unknown>,
    /DAQ node is outside authorized line bindings/,
  )
  await assert.rejects(
    () => adapter.observe!(request({ lineId: 'line-a', dcwNodeIds: ['missing-node'] })) as Promise<unknown>,
    /DCW node is outside authorized line bindings/,
  )
  await assert.rejects(
    () => adapter.observe!(request({ lineId: 'line-a' }, false)) as Promise<unknown>,
    /requires authorized line bindings/,
  )
})

test('source revision is a stable content hash over the returned evidence', async () => {
  const { adapter } = makeAdapter()
  const first = await adapter.observe!(request({ lineId: 'line-a' })) as Record<string, unknown>
  const second = await adapter.observe!(request({ lineId: 'line-a' })) as Record<string, unknown>
  assert.equal((first.source as Record<string, unknown>).contentHash, (second.source as Record<string, unknown>).contentHash)
  const recomputed = canonicalHash({
    lineIds: (first.source as Record<string, unknown>).lineIds,
    daq: first.daq,
    dcw: first.dcw,
  })
  assert.equal((first.source as Record<string, unknown>).contentHash, recomputed)
})

test('plugin exposes POST /evidence/operational and forwards an authorized, read-only observe invocation', async () => {
  const names = ['AW_RSI_BETA_ENABLED', 'AW_RSI_BETA_RESEARCH_ENABLED', 'AW_RSI_BETA_UI_ENABLED']
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]))
  for (const name of names) process.env[name] = '1'
  try {
    const scope = { workspaceId: 'ws-1', channelId: 'ch-1', workerId: 'worker-1' }
    // 真实部署不预置 kv scope:宿主推导(live binding)必须单独支撑 metadata/操作面。
    const store: Record<string, unknown> = {}
    const routes = new Map<string, (event?: unknown) => unknown>()
    const registry = new ContextAdapterRegistry()
    const invocations: Array<{ capability: string, payload: Record<string, unknown> }> = []
    const adapter: ContextAdapter = {
      adapterId: 'rsi-interface-beta',
      apiVersion: 'context-adapter.v1',
      version: '0.1.0',
      generation: 1,
      capabilities: { discover: false, snapshot: false, observe: true, query: false, simulate: false, replay: false, verify: false, export: false },
      sideEffect: 'none',
      health: { status: 'healthy' },
      timeout: { defaultMs: 5000, maxMs: 30_000 },
      owner: { ownerId: 'rsi-interface-beta', dispose: async () => undefined },
      requiresAuthorization: true,
      authorize: ({ principal, scope: requested }) => {
        const value = requested as Record<string, unknown> | undefined
        if (principal?.id !== 'operator' || !value) return false
        if (value.workspaceId !== 'ws-1' || value.channelId !== 'ch-1' || value.workerId !== 'worker-1') return false
        return { scope: value as never, principal: { id: 'operator', role: 'user' }, metadata: { boundLineIds: ['line-a'] }, industrial: true }
      },
      observe: async (invocation) => {
        invocations.push({ capability: invocation.capability, payload: invocation.payload as Record<string, unknown> })
        return {
          ok: true as const,
          payload: {
            adapterId: 'rsi-interface-beta',
            readOnly: true,
            writeCount: 0,
            daq: [{ nodeId: 'daq-a', latest: { value: 42.5, freshness: 'fresh' } }],
            dcw: [{ nodeId: 'dcw-a', readValue: 48, ackFresh: true }],
          },
        }
      },
      drain: async () => undefined,
      retire: async () => undefined,
    }
    const runtime = {
      registry,
      registerOne: (registered: ContextAdapter) => registry.registerOne(registered),
      createIndustrialReadAdapter: () => adapter,
      authorizeScope: ({ scope: requested }: { scope?: Record<string, unknown> }) => requested ? { ok: true as const, scope: requested } : { ok: false as const, code: 'SCOPE_FORBIDDEN' as const },
      resolveScopeBinding: ({ principal, scope: requested }: { principal?: { id?: string } | null, scope?: Record<string, unknown> }) => principal?.id === 'operator' && requested
        ? { ok: true as const, scope: requested, boundLineIds: ['line-a'], channelLineId: 'line-a' }
        : { ok: false as const, code: 'SCOPE_FORBIDDEN' as const },
    }
    const context = {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      config: { get: () => undefined },
      kv: {
        get: (key: string) => store[key],
        all: () => ({ ...store }),
        set: (key: string, value: unknown) => {
          store[key] = value
          return value
        },
      },
      services: {
        async get(name: string) {
          if (name === 'context.runtime') return runtime
          if (name === 'context.adapterRegistry') return registry
          throw new Error(`unknown service ${name}`)
        },
      },
      route: (method: string, path: string, handler: (event?: unknown) => unknown) => {
        routes.set(`${method} ${path}`, handler)
        return true
      },
      onDispose: () => () => {},
    }
    await plugin.setup(context as never)
    assert.equal(routes.has('POST /evidence/operational'), true)
    const event = {
      awUser: { id: 'operator', role: 'user' },
      awBody: { lineId: 'line-a', window: { fromMs: nowMs - 60_000, toMs: nowMs }, history: true },
      query: { ...scope },
    }
    const response = await routes.get('POST /evidence/operational')!(event) as Record<string, unknown>
    assert.equal(response.ok, true, JSON.stringify(response))
    assert.equal(response.readOnly, true)
    assert.equal((response.evidence as Record<string, unknown>).writeCount, 0)
    assert.equal(invocations.length, 1)
    assert.equal(invocations[0]?.capability, 'observe')
    assert.equal(invocations[0]?.payload.lineId, 'line-a')
    assert.equal(invocations[0]?.payload.history, true)

    const denied = await routes.get('POST /evidence/operational')!({
      awUser: { id: 'intruder', role: 'user' },
      awBody: {},
      query: { ...scope },
    }) as Record<string, unknown>
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'SCOPE_FORBIDDEN')
    assert.equal(invocations.length, 1, '拒绝路径不得触达 adapter')

    const metadataUnbound = routes.get('GET /metadata')!({ awUser: { id: 'operator', role: 'user' }, query: {} }) as Record<string, unknown>
    assert.equal(metadataUnbound.visible, true, '无 kv 预置时面板仍可见(不再是永久 default-deny)')
    assert.equal(metadataUnbound.code, 'SCOPE_UNBOUND')
    assert.equal(metadataUnbound.scopeState, 'unbound')
    assert.equal(metadataUnbound.available, false)
    const metadataScoped = routes.get('GET /metadata')!({ awUser: { id: 'operator', role: 'user' }, query: { ...scope } }) as Record<string, unknown>
    assert.equal(metadataScoped.status, 'ready')
    assert.deepEqual(metadataScoped.scope, scope)
  }
  finally {
    for (const name of names) {
      if (before[name] === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = before[name]
    }
  }
})

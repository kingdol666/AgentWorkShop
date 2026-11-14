import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ContextAdapterRegistry } from '../server/services/workshop/context/registry'
import type { ContextAdapter } from '../server/services/workshop/context/contracts'
import plugin from '../.AgentWorkShop/plugins/rsi-interface-beta/index.mjs'
import { API_VERSION, SCOPE_STATE_KEY } from '../.AgentWorkShop/plugins/rsi-interface-beta/scope.mjs'

const scope = { workspaceId: 'ws-1', channelId: 'ch-1', workerId: 'worker-1' }
const activeState = {
  ...scope,
  enabled: true,
  templateId: 'rsi-interface-beta',
  updatedAt: new Date().toISOString(),
}

function readAdapter(authorizationCalls: unknown[] = []): ContextAdapter {
  const operation = async (request) => {
    authorizationCalls.push(request.authorization)
    return { ok: true as const, payload: { capability: request.capability, value: 1 } }
  }
  return {
    adapterId: 'rsi-interface-beta',
    apiVersion: 'context-adapter.v1',
    version: '0.1.0',
    generation: 1,
    capabilities: { discover: true, snapshot: true, observe: true, query: true, simulate: false, replay: false, verify: false, export: false },
    sideEffect: 'none',
    health: { status: 'healthy' },
    timeout: { defaultMs: 1000, maxMs: 5000 },
    owner: { ownerId: 'rsi-interface-beta', dispose: async () => undefined },
    requiresAuthorization: true,
    authorize: ({ principal, scope: requested }) => {
      // Beta always marks industrial projection; the host authorizer normalizes scope
      // back to the three deployment keys before returning authorization.
      const value = requested as Record<string, unknown> | undefined
      const normalized = value ? { workspaceId: value.workspaceId, channelId: value.channelId, workerId: value.workerId } : undefined
      return principal?.id === 'operator' && JSON.stringify(normalized) === JSON.stringify(scope)
        ? { scope: normalized as typeof scope, principal: { id: 'operator', role: 'user' }, lineIds: ['line-authorized'] }
        : false
    },
    discover: operation,
    snapshot: operation,
    observe: operation,
    query: operation,
    drain: async () => undefined,
    retire: async () => undefined,
  }
}

function makeContext(store: Record<string, unknown>, options: { deny?: boolean, failSet?: boolean, authorizationCalls?: unknown[] } = {}) {
  const routes = new Map<string, (event?: unknown) => unknown>()
  const disposables: Array<() => unknown> = []
  const registry = new ContextAdapterRegistry()
  const runtime = {
    registry,
    registerOne(adapter: ContextAdapter) {
      // The production runtime creates the implemented industrial-read adapter.
      // This fixture supplies its same read-only contract to keep the test hermetic.
      return registry.registerOne(adapter)
    },
    createIndustrialReadAdapter() {
      return readAdapter(options.authorizationCalls)
    },
    authorizeScope({ principal, scope: requested }: { principal?: { id?: string } | null, scope?: typeof scope }) {
      if (options.deny || principal?.id !== 'operator' || !requested || Object.entries(scope).some(([key, value]) => requested[key] !== value)) return { ok: false as const, code: 'SCOPE_FORBIDDEN' as const }
      return { ok: true as const, scope: requested }
    },
    resolveScopeBinding({ principal, scope: requested }: { principal?: { id?: string } | null, scope?: typeof scope }) {
      if (options.deny || principal?.id !== 'operator' || !requested || Object.entries(scope).some(([key, value]) => requested[key] !== value)) return { ok: false as const, code: 'SCOPE_FORBIDDEN' as const }
      return { ok: true as const, scope: requested, boundLineIds: ['line-authorized'], channelLineId: null }
    },
    authorizeAdapterRequest({ principal, scope: requested }: { principal?: { id?: string }, scope?: unknown }) {
      return principal?.id === 'operator' && JSON.stringify(requested) === JSON.stringify(scope)
        ? { scope: requested, principal: { id: 'operator', role: 'user' }, lineIds: ['line-authorized'] }
        : false
    },
  }
  const context = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    config: { get: () => undefined },
    principal: { id: 'operator', role: 'user' },
    kv: {
      get: (key: string) => store[key],
      all: () => ({ ...store }),
      set: (key: string, value: unknown) => {
        if (options.failSet) throw new Error('kv write failed')
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
    onDispose: (fn: () => unknown) => {
      disposables.push(fn)
      return fn
    },
  }
  return { context, routes, disposables, registry }
}

function enabledEnvironment(fn: () => Promise<void> | void) {
  const names = ['AW_RSI_BETA_ENABLED', 'AW_RSI_BETA_RESEARCH_ENABLED', 'AW_RSI_BETA_UI_ENABLED']
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]))
  for (const name of names) process.env[name] = '1'
  return Promise.resolve(fn()).finally(() => {
    for (const name of names) {
      if (before[name] === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = before[name]
    }
  })
}

function event(body: Record<string, unknown> = {}, actor: Record<string, unknown> = { id: 'operator', role: 'user' }) {
  return { awUser: actor, awBody: body, query: { ...scope } }
}

test('enabled plugin exposes bounded research/evidence routes and uniform scope denial', async () => {
  await enabledEnvironment(async () => {
    const store: Record<string, unknown> = { [SCOPE_STATE_KEY]: activeState }
    const { context, routes } = makeContext(store)
    await plugin.setup(context as never)
    assert.equal(routes.has('GET /research'), true)
    assert.equal(routes.has('POST /research/run'), true)
    assert.equal(routes.has('POST /research/cancel'), true)
    assert.equal(routes.has('GET /evidence'), true)

    const denied = await routes.get('GET /research')!({ awUser: { id: 'intruder' }, query: scope })
    assert.equal((denied as Record<string, unknown>).code, 'SCOPE_FORBIDDEN')

    const created = await routes.get('POST /research/run')!(event({
      id: 'run-route-1',
      idempotencyKey: 'route-key-1',
      objective: 'read',
      question: 'what is observed?',
      subjectRefs: [{ namespace: 'fixture.subject', id: 'subject-1' }],
      plan: { id: 'plan-route-1', steps: [{ id: 'step-1', adapterId: 'rsi-interface-beta', capability: 'query', payload: {}, sourceRef: 'fixture:query' }] },
      execute: true,
    })) as Record<string, unknown>
    assert.equal(created.ok, true)
    assert.equal((created.run as Record<string, unknown>).state, 'completed')
    assert.equal((created.run as Record<string, unknown>).evidenceIds instanceof Array, true)

    const evidence = await routes.get('GET /evidence')!(event()) as Record<string, unknown>
    assert.equal(evidence.ok, true)
    assert.equal((evidence.evidence as unknown[]).length, 1)
    assert.equal((evidence.evidence as Array<Record<string, unknown>>)[0]?.candidateOnly, true)
    assert.equal((evidence.evidence as Array<Record<string, unknown>>)[0]?.claimLevel, 'candidate')
  })
})

test('research and candidate evidence survive plugin restart through ctx.kv', async () => {
  await enabledEnvironment(async () => {
    const store: Record<string, unknown> = { [SCOPE_STATE_KEY]: activeState }
    const first = makeContext(store)
    await plugin.setup(first.context as never)
    const created = await first.routes.get('POST /research/run')!(event({
      id: 'run-restart-1',
      idempotencyKey: 'restart-key-1',
      objective: 'read',
      question: 'restart?',
      subjectRefs: [{ namespace: 'fixture.subject', id: 'subject-1' }],
      plan: { id: 'plan-restart-1', steps: [{ id: 'step-1', adapterId: 'rsi-interface-beta', capability: 'observe', payload: {}, sourceRef: 'fixture:observe' }] },
      execute: true,
    })) as Record<string, unknown>
    assert.equal(created.ok, true)
    assert.ok(store['rsi.beta.research.state'])
    for (const dispose of first.disposables) await dispose()

    const second = makeContext(store)
    await plugin.setup(second.context as never)
    const listed = await second.routes.get('GET /research')!(event()) as Record<string, unknown>
    assert.equal(listed.ok, true)
    assert.equal((listed.runs as unknown[]).length, 1)
    assert.equal((listed.runs as Array<Record<string, unknown>>)[0]?.id, 'run-restart-1')
    const evidence = await second.routes.get('GET /evidence')!(event()) as Record<string, unknown>
    assert.equal(evidence.ok, true)
    assert.equal((evidence.evidence as unknown[]).length, 1)
  })
})

test('metadata authorization uses the request event principal', async () => {
  await enabledEnvironment(async () => {
    const store: Record<string, unknown> = { [SCOPE_STATE_KEY]: activeState }
    const { context, routes } = makeContext(store)
    await plugin.setup(context as never)
    const denied = routes.get('GET /metadata')!({ awUser: { id: 'intruder', role: 'user' } }) as Record<string, unknown>
    assert.equal(denied.visible, false)
    assert.equal(denied.code, 'SCOPE_FORBIDDEN')
    const allowed = routes.get('GET /metadata')!(event()) as Record<string, unknown>
    assert.equal(allowed.visible, true)
    assert.deepEqual(allowed.scope, scope)
  })
})

test('research execution forwards principal and authorized scope into adapter invocation', async () => {
  await enabledEnvironment(async () => {
    const store: Record<string, unknown> = { [SCOPE_STATE_KEY]: activeState }
    const authorizationCalls: unknown[] = []
    const { context, routes } = makeContext(store, { authorizationCalls })
    await plugin.setup(context as never)
    const created = await routes.get('POST /research/run')!(event({
      id: 'run-auth-forward-1',
      idempotencyKey: 'auth-forward-key-1',
      objective: 'read',
      question: 'authorized?',
      subjectRefs: [{ namespace: 'fixture.subject', id: 'subject-1' }],
      plan: { id: 'plan-auth-forward-1', steps: [{ id: 'step-1', adapterId: 'rsi-interface-beta', capability: 'query', payload: {}, sourceRef: 'fixture:query' }] },
      execute: true,
    })) as Record<string, unknown>
    assert.equal(created.ok, true)
    assert.equal(authorizationCalls.length, 1)
    assert.deepEqual(authorizationCalls[0], {
      scope,
      principal: { id: 'operator', role: 'user' },
      lineIds: ['line-authorized'],
    })
  })
})

test('research route denies persistence failure instead of returning success', async () => {
  await enabledEnvironment(async () => {
    const store: Record<string, unknown> = { [SCOPE_STATE_KEY]: activeState }
    const { context, routes } = makeContext(store, { failSet: true })
    await plugin.setup(context as never)
    const response = await routes.get('POST /research/run')!(event({
      id: 'run-persist-fail',
      idempotencyKey: 'persist-fail-key',
      objective: 'read',
      question: 'must fail closed',
      subjectRefs: [{ namespace: 'fixture.subject', id: 'subject-1' }],
    })) as Record<string, unknown>
    assert.equal(response.ok, false)
    assert.equal(response.code, 'PERSISTENCE_UNAVAILABLE')
  })
})

assert.equal(API_VERSION, 'rsi-interface-beta.v1')

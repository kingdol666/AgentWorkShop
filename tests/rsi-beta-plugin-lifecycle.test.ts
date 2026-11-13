import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../.AgentWorkShop/plugins/rsi-interface-beta/index.mjs'
import {
  API_VERSION,
  DEFAULT_SCOPE_MAX_AGE_MS,
  REQUIRED_SCOPE_KEYS,
  adapterDescriptor,
  evaluateBetaScope,
  intersectScope,
  readBetaFlags,
  SCOPE_STATE_KEY,
} from '../.AgentWorkShop/plugins/rsi-interface-beta/scope.mjs'

const scope = { workspaceId: 'ws-1', channelId: 'ch-1', workerId: 'worker-1' }
const activeState = {
  ...scope,
  enabled: true,
  templateId: 'rsi-interface-beta',
  updatedAt: '2026-11-13T14:00:00.000Z',
}
const enabledFlags = readBetaFlags({
  AW_RSI_BETA_ENABLED: '1',
  AW_RSI_BETA_RESEARCH_ENABLED: '1',
})
const persistence = { ok: true }

function expectDenied(result: { ok: boolean, code: string }, code: string) {
  assert.equal(result.ok, false)
  assert.equal(result.code, code)
}

function makeContext({ kv = {}, registry = null, config = {} } = {}) {
  const routes = new Map<string, (event?: unknown) => unknown>()
  const disposables: Array<() => unknown> = []
  const calls = { omp: 0, daq: 0, dcw: 0, hooks: 0, route: 0 }
  const context = {
    name: 'rsi-interface-beta',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    config: { get: (key: string) => config[key], onChange() {} },
    kv: {
      get: (key: string) => {
        if (kv instanceof Error) throw kv
        return (kv as Record<string, unknown>)[key]
      },
      all: () => {
        if (kv instanceof Error) throw kv
        return { ...(kv as Record<string, unknown>) }
      },
      set: (key: string, value: unknown) => {
        if (kv instanceof Error) throw kv
        ;(kv as Record<string, unknown>)[key] = value
        return value
      },
    },
    services: {
      get(name: string) {
        if (name === 'context.adapterRegistry') {
          if (!registry) throw new Error('missing optional registry')
          return registry
        }
        throw new Error(`unknown service ${name}`)
      },
    },
    route: (method: string, path: string, handler: (event?: unknown) => unknown) => {
      calls.route++
      routes.set(`${method} ${path}`, handler)
      return true
    },
    onDispose: (fn: () => unknown) => {
      disposables.push(fn)
      return fn
    },
    // These counters make the no-bypass surface explicit in the test fixture.
    get omp() {
      calls.omp++
      return undefined
    },
    get daq() {
      calls.daq++
      return undefined
    },
    get dcw() {
      calls.dcw++
      return undefined
    },
    get hooks() {
      calls.hooks++
      return undefined
    },
  }
  return { context, routes, disposables, calls }
}

function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const names = [
    'AW_RSI_BETA_ENABLED',
    'AW_RSI_BETA_RESEARCH_ENABLED',
    'AW_RSI_BETA_SIMULATOR_ENABLED',
    'AW_RSI_BETA_PHYSICAL_HIL_ENABLED',
    'AW_RSI_BETA_ACTUATION_ENABLED',
    'AW_RSI_BETA_PROMOTION_ENABLED',
  ]
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]))
  for (const name of names) {
    const value = values[name]
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name)
    }
    else {
      process.env[name] = value
    }
  }
  return Promise.resolve(fn()).finally(() => {
    for (const name of names) {
      const value = before[name]
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name)
      }
      else {
        process.env[name] = value
      }
    }
  })
}

test('manifest is explicit, read-only, and does not expose prohibited host surfaces', () => {
  assert.equal(plugin.name, 'rsi-interface-beta')
  assert.equal(plugin.apiVersion, API_VERSION)
  assert.equal(plugin.auth, 'user')
  assert.equal(plugin.config.defaultOff, true)
  assert.equal(plugin.config.readOnly, true)
  assert.equal(plugin.config.actuation, false)
  assert.equal(plugin.config.promotion, false)
  assert.deepEqual(plugin.config.requiredScope, REQUIRED_SCOPE_KEYS)
  assert.equal('omp' in plugin, false)
  assert.equal('daq' in plugin, false)
  assert.equal('dcw' in plugin, false)
  assert.equal('scheduler' in plugin, false)
})

test('flags are strict default-off gates and hard deny actuation/promotion', () => {
  const off = readBetaFlags({})
  assert.equal(off.globallyEnabled, false)
  assert.equal(off.explicitlyEnabled, false)
  assert.equal(readBetaFlags({ AW_RSI_BETA_ENABLED: 'true', AW_RSI_BETA_RESEARCH_ENABLED: '1' }).globallyEnabled, false)
  assert.equal(readBetaFlags({ AW_RSI_BETA_ENABLED: '1', AW_RSI_BETA_RESEARCH_ENABLED: '1', AW_RSI_BETA_ACTUATION_ENABLED: '1' }).globallyEnabled, false)
  assert.equal(readBetaFlags({ AW_RSI_BETA_ENABLED: '1', AW_RSI_BETA_RESEARCH_ENABLED: '1', AW_RSI_BETA_PROMOTION_ENABLED: '1' }).hardDenied, true)
})

test('scope intersection requires all IDs and rejects foreign, template, disabled, and stale state', () => {
  expectDenied(intersectScope({}, activeState, { now: Date.parse('2026-11-13T14:01:00.000Z') }), 'SCOPE_MISSING')
  expectDenied(intersectScope({ ...scope, workerId: 'other' }, activeState, { now: Date.parse('2026-11-13T14:01:00.000Z') }), 'SCOPE_FOREIGN')
  expectDenied(intersectScope(scope, { ...activeState, templateId: 'foreign-template' }, { now: Date.parse('2026-11-13T14:01:00.000Z') }), 'SCOPE_TEMPLATE_FOREIGN')
  expectDenied(intersectScope(scope, { ...activeState, templateEnabled: false }, { now: Date.parse('2026-11-13T14:01:00.000Z') }), 'SCOPE_TEMPLATE_DISABLED')
  expectDenied(intersectScope(scope, { ...activeState, enabled: false }, { now: Date.parse('2026-11-13T14:01:00.000Z') }), 'SCOPE_DISABLED')
  expectDenied(intersectScope(scope, activeState, { now: Date.parse('2026-11-13T14:06:00.001Z'), maxAgeMs: 5 * 60 * 1000 }), 'SCOPE_STALE')
})

test('valid scope is an exact intersection and capability mismatch fails closed', () => {
  const valid = intersectScope(scope, activeState, { now: Date.parse('2026-11-13T14:01:00.000Z') })
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.scope, scope)
  expectDenied(evaluateBetaScope({ flags: enabledFlags, persistence, requested: scope, persisted: activeState, capability: 'actuate', now: Date.parse('2026-11-13T14:01:00.000Z') }), 'CAPABILITY_FORBIDDEN')
  expectDenied(evaluateBetaScope({ flags: enabledFlags, persistence, requested: scope, persisted: activeState, capability: 'unknown', now: Date.parse('2026-11-13T14:01:00.000Z') }), 'CAPABILITY_UNSUPPORTED')
  expectDenied(evaluateBetaScope({ flags: enabledFlags, persistence, requested: scope, persisted: activeState, capability: 'simulate', now: Date.parse('2026-11-13T14:01:00.000Z') }), 'FLAG_SIMULATOR_DISABLED')
})

test('setup keeps authenticated status routes available while globally disabled', async () => {
  await withEnv({}, async () => {
    const state = { rsi: { ...activeState } }
    const { context, routes, disposables, calls } = makeContext({ kv: state })
    await plugin.setup(context as never)
    assert.equal(calls.route, 4)
    const response = routes.get('GET /status')!({ query: scope }) as Record<string, unknown>
    assert.equal(response.ok, false)
    assert.equal(response.code, 'BETA_DISABLED')
    assert.equal((response.flags as Record<string, unknown>).globallyEnabled, false)
    assert.equal(calls.omp + calls.daq + calls.dcw + calls.hooks, 0)
    for (const dispose of disposables) await dispose()
  })
})

test('enabled setup uses the optional registry seam and disposes on reload/disable', async () => {
  await withEnv({ AW_RSI_BETA_ENABLED: '1', AW_RSI_BETA_RESEARCH_ENABLED: '1' }, async () => {
    const state = {
      [SCOPE_STATE_KEY]: {
        ...activeState,
        updatedAt: new Date().toISOString(),
      },
    }
    let registered: unknown = null
    let disposed = 0
    const registry = {
      registerAdapter(adapter: unknown) {
        registered = adapter
        return {
          dispose: () => {
            disposed++
            registered = null
          },
        }
      },
    }
    const { context, routes, disposables } = makeContext({ kv: state, registry })
    await plugin.setup(context as never)
    assert.equal(registered != null, true)
    assert.equal((registered as typeof adapterDescriptor).apiVersion, API_VERSION)
    assert.deepEqual((registered as typeof adapterDescriptor).capabilities, adapterDescriptor.capabilities)
    const response = routes.get('GET /status')!({ query: scope }) as Record<string, unknown>
    assert.equal(response.ok, true)
    assert.equal(response.code, 'READY')
    assert.deepEqual(response.scope, scope)
    assert.equal((response.adapter as Record<string, unknown>).ok, true)
    for (const dispose of disposables) await dispose()
    assert.equal(disposed, 1)
    assert.equal(registered, null)
  })
})

test('persistence failure remains default-deny and cannot produce an empty success', async () => {
  await withEnv({ AW_RSI_BETA_ENABLED: '1', AW_RSI_BETA_RESEARCH_ENABLED: '1' }, async () => {
    const { context, routes, disposables } = makeContext({ kv: new Error('kv unavailable') })
    await plugin.setup(context as never)
    const response = routes.get('GET /status')!({ query: scope }) as Record<string, unknown>
    assert.equal(response.ok, false)
    assert.equal(response.code, 'PERSISTENCE_UNAVAILABLE')
    assert.deepEqual(response.persistence, { ok: false, code: 'PERSISTENCE_UNAVAILABLE' })
    for (const dispose of disposables) await dispose()
  })
})

test('adapter descriptor remains read-only even when optional registration is absent', () => {
  assert.equal(adapterDescriptor.readOnly, true)
  assert.equal(adapterDescriptor.actuation, false)
  assert.equal(adapterDescriptor.promotion, false)
  assert.ok(DEFAULT_SCOPE_MAX_AGE_MS > 0)
})

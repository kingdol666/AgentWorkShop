import {
  ADAPTER_ID,
  ADAPTER_VERSION,
  API_VERSION,
  DEFAULT_SCOPE_MAX_AGE_MS,
  LIFECYCLE_STATE_KEY,
  PERSISTENCE_STATE_KEY,
  PLUGIN_CONFIG,
  PLUGIN_NAME,
  REQUIRED_SCOPE_KEYS,
  SCOPE_STATE_KEY,
  adapterDescriptor,
  evaluateBetaScope,
  publicFlags,
  readBetaFlags,
  requestedScopeFromEvent,
  resolveAdapterRegistry,
} from './scope.mjs'

const statusPath = '/status'
const healthPath = '/health'
const scopePath = '/scope'
const adapterPath = '/adapter'

function noOpLogger() {}

function safeCall(fn, fallback) {
  try {
    return fn()
  }
  catch {
    return fallback
  }
}

function readPersistence(ctx) {
  try {
    if (typeof ctx?.kv?.get !== 'function' || typeof ctx?.kv?.all !== 'function') {
      return { ok: false, code: 'PERSISTENCE_UNAVAILABLE', reason: 'ctx.kv is incomplete' }
    }
    const all = ctx.kv.all()
    if (!all || typeof all !== 'object' || Array.isArray(all)) {
      return { ok: false, code: 'PERSISTENCE_UNAVAILABLE', reason: 'ctx.kv did not return a state object' }
    }
    const marker = ctx.kv.get(PERSISTENCE_STATE_KEY)
    if (marker && typeof marker === 'object' && marker.ok === false) {
      return { ok: false, code: 'PERSISTENCE_UNAVAILABLE', reason: 'persisted state is marked unavailable' }
    }
    return { ok: true, scope: ctx.kv.get(SCOPE_STATE_KEY), marker: marker ?? null }
  }
  catch (error) {
    return { ok: false, code: 'PERSISTENCE_UNAVAILABLE', reason: error?.message ?? 'ctx.kv read failed' }
  }
}

function publicPersistence(persistence) {
  if (!persistence?.ok) return { ok: false, code: persistence?.code ?? 'PERSISTENCE_UNAVAILABLE' }
  return { ok: true }
}

function publicAdapterStatus(status) {
  return {
    ok: status?.ok === true,
    code: status?.ok === true ? 'REGISTERED' : (status?.code ?? 'ADAPTER_UNAVAILABLE'),
    service: status?.service ?? null,
  }
}

function persistLifecycle(ctx, state) {
  try {
    if (typeof ctx?.kv?.set !== 'function') return false
    ctx.kv.set(LIFECYCLE_STATE_KEY, state)
    return true
  }
  catch {
    return false
  }
}

function createReadOnlyAdapter(getState) {
  const denied = (capability, input) => {
    const state = getState()
    const result = evaluateBetaScope({
      flags: state.flags,
      persistence: state.persistence,
      requested: input?.scope ?? input,
      persisted: state.persistence?.scope,
      capability,
      maxAgeMs: state.maxAgeMs,
    })
    if (!result.ok) return { ok: false, ...result }
    return {
      ok: false,
      code: 'ADAPTER_OPERATION_UNAVAILABLE',
      reason: 'the Beta interface exposes no domain adapter implementation',
      capability,
      scope: result.scope,
    }
  }

  return Object.freeze({
    ...adapterDescriptor,
    manifest: adapterDescriptor,
    canRead(scope) {
      const state = getState()
      return evaluateBetaScope({
        flags: state.flags,
        persistence: state.persistence,
        requested: scope,
        persisted: state.persistence?.scope,
        capability: 'observe',
        maxAgeMs: state.maxAgeMs,
      }).ok
    },
    discover: input => denied('discover', input),
    observe: input => denied('observe', input),
    query: input => denied('query', input),
    simulate: input => denied('simulate', input),
    replay: input => denied('replay', input),
    verify: input => denied('verify', input),
    actuate: () => ({ ok: false, code: 'CAPABILITY_FORBIDDEN', reason: 'actuate is outside the Beta read-only boundary' }),
    promote: () => ({ ok: false, code: 'CAPABILITY_FORBIDDEN', reason: 'promote is outside the Beta boundary' }),
  })
}

async function registerAdapter(ctx, adapter, logger) {
  const resolved = await resolveAdapterRegistry(ctx)
  if (!resolved.registry) return { ok: false, code: resolved.reason }

  const registry = resolved.registry
  const register = registry.registerAdapter ?? registry.register
  if (typeof register !== 'function') return { ok: false, code: 'ADAPTER_REGISTRY_UNSUPPORTED' }

  let registration
  try {
    registration = await register.call(registry, adapter)
  }
  catch (error) {
    logger.warn(`adapter registry registration denied: ${error?.message ?? error}`)
    return { ok: false, code: 'ADAPTER_REGISTRATION_FAILED' }
  }

  const unregister = registry.unregisterAdapter ?? registry.unregister
  const cleanup = async () => {
    try {
      if (typeof registration?.dispose === 'function') await registration.dispose()
      else if (typeof unregister === 'function') await unregister.call(registry, ADAPTER_ID, ADAPTER_VERSION)
    }
    catch (error) {
      logger.warn(`adapter registry cleanup failed: ${error?.message ?? error}`)
    }
  }
  ctx.onDispose(cleanup)
  return { ok: true, service: resolved.service, registration: registration ?? null, cleanup }
}

function routeResult(state, event, capability) {
  const flags = readBetaFlags()
  const persistence = state.persistenceReady ? readPersistence(state.ctx) : { ok: false, code: 'PERSISTENCE_UNAVAILABLE', reason: 'plugin state persistence failed' }
  const requested = requestedScopeFromEvent(event)
  const result = evaluateBetaScope({
    flags,
    persistence,
    requested,
    persisted: persistence.scope,
    capability,
    maxAgeMs: state.maxAgeMs,
  })
  return {
    apiVersion: API_VERSION,
    plugin: PLUGIN_NAME,
    ok: result.ok,
    available: result.ok,
    code: result.ok ? 'READY' : result.code,
    reason: result.ok ? undefined : result.reason,
    capability: result.capability ?? capability ?? null,
    scope: result.ok ? result.scope : undefined,
    flags: publicFlags(flags),
    persistence: publicPersistence(persistence),
    adapter: publicAdapterStatus(state.adapterStatus),
  }
}

export default {
  name: PLUGIN_NAME,
  version: ADAPTER_VERSION,
  description: 'Default-deny, read-only RSI Beta adapter/plugin interface',
  apiVersion: API_VERSION,
  auth: 'user',
  config: PLUGIN_CONFIG,
  settings: [
    {
      key: 'scope_max_age_ms',
      type: 'number',
      default: DEFAULT_SCOPE_MAX_AGE_MS,
      min: 1,
      max: 86_400_000,
      label: 'Beta scope maximum age (ms)',
      description: 'Stale scope state is denied; this setting never widens scope.',
    },
  ],
  async setup(ctx) {
    const logger = ctx?.logger ?? { info: noOpLogger, warn: noOpLogger, error: noOpLogger }
    const state = {
      ctx,
      maxAgeMs: Number(ctx?.config?.get?.(`plugins.${PLUGIN_NAME}.scope_max_age_ms`)) || DEFAULT_SCOPE_MAX_AGE_MS,
      adapterStatus: { ok: false, code: 'BETA_DISABLED' },
      persistenceReady: false,
    }

    // Read-only status is intentionally still loadable while flags are off.
    // It gives authenticated operators a truthful default-deny explanation.
    const initialFlags = readBetaFlags()
    const initialPersistence = readPersistence(ctx)
    state.persistenceReady = initialPersistence.ok
    if (!initialPersistence.ok) logger.warn(`persistence unavailable; Beta remains default-deny: ${initialPersistence.reason}`)

    if (initialFlags.globallyEnabled && initialPersistence.ok) {
      const adapter = createReadOnlyAdapter(() => ({
        flags: readBetaFlags(),
        persistence: readPersistence(ctx),
        maxAgeMs: state.maxAgeMs,
      }))
      state.adapterStatus = await registerAdapter(ctx, adapter, logger)
    }

    ctx.onDispose(() => {
      state.adapterStatus = { ok: false, code: 'DISPOSED' }
    })

    const statusHandler = event => routeResult(state, event, null)
    const healthHandler = event => routeResult(state, event, 'observe')
    const scopeHandler = event => routeResult(state, event, 'query')
    const adapterHandler = event => ({
      ...routeResult(state, event, null),
      adapterDescriptor,
      requiredScope: REQUIRED_SCOPE_KEYS,
      registered: state.adapterStatus.ok === true,
      readOnly: true,
      actuation: false,
      promotion: false,
    })

    ctx.route('GET', statusPath, statusHandler)
    ctx.route('GET', healthPath, healthHandler)
    ctx.route('GET', scopePath, scopeHandler)
    ctx.route('GET', adapterPath, adapterHandler)

    // The route table is owned by the host and removed on dispose. Keep a
    // small lifecycle marker only in memory; no prompt, scheduler, DB, or raw
    // hook is touched by this plugin.
    safeCall(() => logger.info(`ready apiVersion=${API_VERSION} flags=${initialFlags.globallyEnabled ? 'enabled' : 'default-deny'}`), undefined)
    state.persistenceReady = persistLifecycle(ctx, { state: 'ready', apiVersion: API_VERSION, at: new Date().toISOString() })
  },
}

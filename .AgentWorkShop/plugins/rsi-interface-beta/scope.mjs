export const PLUGIN_NAME = 'rsi-interface-beta'
export const API_VERSION = 'rsi-interface-beta.v1'
export const ADAPTER_ID = 'rsi-interface-beta'
export const ADAPTER_VERSION = '0.1.0'
export const TEMPLATE_ID = 'rsi-interface-beta'

export const REQUIRED_SCOPE_KEYS = Object.freeze(['workspaceId', 'channelId', 'workerId'])
// 2026-11-14 P1:capability 真相 —— snapshot 是生产 industrial adapter 的真实
// 能力(adapter capabilities={discover,snapshot,query:true});此前 ALLOWED 漏了
// snapshot,合法研究计划在建卡时被误拒。observe/simulate/replay/verify 仍保留
// 在 ALLOWED(兼容既有 scope 语义),但对外的可见能力一律以注册 adapter 实况为准。
export const ALLOWED_CAPABILITIES = Object.freeze([
  'discover',
  'snapshot',
  'observe',
  'query',
  'simulate',
  'replay',
  'verify',
])
export const REQUIRED_FLAGS = Object.freeze([
  'AW_RSI_BETA_ENABLED',
  'AW_RSI_BETA_RESEARCH_ENABLED',
])
export const RESERVED_DENY_FLAGS = Object.freeze([
  'AW_RSI_BETA_ACTUATION_ENABLED',
  'AW_RSI_BETA_PROMOTION_ENABLED',
])
export const SCOPE_STATE_KEY = 'rsi.beta.scope'
export const PERSISTENCE_STATE_KEY = 'rsi.beta.persistence'
export const LIFECYCLE_STATE_KEY = 'rsi.beta.lifecycle'
export const DEFAULT_SCOPE_MAX_AGE_MS = 5 * 60 * 1000

export const PLUGIN_CONFIG = Object.freeze({
  apiVersion: API_VERSION,
  defaultOff: true,
  readOnly: true,
  requiredFlags: REQUIRED_FLAGS,
  requiredScope: REQUIRED_SCOPE_KEYS,
  allowedCapabilities: ALLOWED_CAPABILITIES,
  actuation: false,
  promotion: false,
  persistence: 'ctx.kv',
})

const FLAG_NAMES = Object.freeze([
  'AW_RSI_BETA_ENABLED',
  'AW_RSI_BETA_RESEARCH_ENABLED',
  'AW_RSI_BETA_UI_ENABLED',
  'AW_RSI_BETA_SIMULATOR_ENABLED',
  'AW_RSI_BETA_PHYSICAL_HIL_ENABLED',
  'AW_RSI_BETA_ACTUATION_ENABLED',
  'AW_RSI_BETA_PROMOTION_ENABLED',
])

const text = value => typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

function strictEnvFlag(value) {
  return value === '1'
}

/**
 * Beta flags are deliberately strict: only the documented environment value
 * "1" enables a flag. Missing, malformed, and human-friendly values are off.
 */
export function readBetaFlags(env = globalThis.process?.env ?? {}) {
  const configured = Object.fromEntries(FLAG_NAMES.map(name => [name, strictEnvFlag(env?.[name])]))
  const malformed = FLAG_NAMES.filter(name => env?.[name] != null && env[name] !== '0' && env[name] !== '1')
  const hardDenied = configured.AW_RSI_BETA_ACTUATION_ENABLED || configured.AW_RSI_BETA_PROMOTION_ENABLED
  const explicitlyEnabled = configured.AW_RSI_BETA_ENABLED && configured.AW_RSI_BETA_RESEARCH_ENABLED
  return Object.freeze({
    ...configured,
    malformed,
    hardDenied,
    explicitlyEnabled,
    globallyEnabled: explicitlyEnabled && !hardDenied,
    simulatorEnabled: explicitlyEnabled && configured.AW_RSI_BETA_SIMULATOR_ENABLED && !hardDenied,
    physicalHilEnabled: explicitlyEnabled && configured.AW_RSI_BETA_PHYSICAL_HIL_ENABLED && !hardDenied,
    uiEnabled: configured.AW_RSI_BETA_UI_ENABLED === true,
  })
}

function scopeValue(input) {
  const source = input?.scope && typeof input.scope === 'object' ? input.scope : input
  if (!source || typeof source !== 'object') return null
  return Object.fromEntries(REQUIRED_SCOPE_KEYS.map(key => [key, text(source[key])]))
}

function missingScopeKeys(scope) {
  return REQUIRED_SCOPE_KEYS.filter(key => !text(scope?.[key]))
}

function stateScope(input) {
  if (!input || typeof input !== 'object') return null
  if (input.scope && typeof input.scope === 'object') return scopeValue(input.scope)
  if (input.binding && typeof input.binding === 'object') return scopeValue(input.binding)
  return scopeValue(input)
}

function sameScope(left, right) {
  return REQUIRED_SCOPE_KEYS.every(key => left[key] === right[key])
}

function staleState(state, now, maxAgeMs) {
  if (state.stale === true || state.isStale === true) return true
  for (const key of ['staleAt', 'expiresAt']) {
    const timestamp = Date.parse(String(state[key] ?? ''))
    if (Number.isFinite(timestamp) && timestamp <= now) return true
  }
  const updatedAt = Date.parse(String(state.updatedAt ?? state.refreshedAt ?? ''))
  if (!Number.isFinite(updatedAt)) return true
  return now - updatedAt > maxAgeMs
}

function templateState(state, expectedTemplateId) {
  const template = state.template && typeof state.template === 'object' ? state.template : null
  const actualId = text(state.templateId) ?? text(template?.id) ?? text(state.template)
  if (!actualId) return { ok: false, code: 'SCOPE_TEMPLATE_MISSING', reason: 'active template state is required' }
  if (actualId !== expectedTemplateId) return { ok: false, code: 'SCOPE_TEMPLATE_FOREIGN', reason: 'scope belongs to a different template' }
  if (state.templateEnabled === false || template?.enabled === false || state.templateStatus === 'disabled' || template?.status === 'disabled') {
    return { ok: false, code: 'SCOPE_TEMPLATE_DISABLED', reason: 'template is disabled' }
  }
  return { ok: true, templateId: actualId }
}

/**
 * Intersect a caller scope with the persisted beta binding. No parent or
 * partial scope inheritance is accepted. The persisted binding is treated as
 * untrusted input and must be active, templated, enabled, and fresh.
 */
export function intersectScope(requestedInput, persistedInput, options = {}) {
  const requested = scopeValue(requestedInput)
  const persisted = stateScope(persistedInput)
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : DEFAULT_SCOPE_MAX_AGE_MS
  const expectedTemplateId = text(options.templateId) ?? TEMPLATE_ID

  if (!requested) return { ok: false, code: 'SCOPE_MISSING', reason: 'scope is required' }
  const missingRequested = missingScopeKeys(requested)
  if (missingRequested.length) return { ok: false, code: 'SCOPE_MISSING', reason: `missing scope: ${missingRequested.join(',')}`, missing: missingRequested }
  if (!persisted) return { ok: false, code: 'SCOPE_STATE_MISSING', reason: 'persisted scope state is unavailable' }
  const missingPersisted = missingScopeKeys(persisted)
  if (missingPersisted.length) return { ok: false, code: 'SCOPE_STATE_MISSING', reason: `persisted scope is incomplete: ${missingPersisted.join(',')}`, missing: missingPersisted }
  if (!sameScope(requested, persisted)) return { ok: false, code: 'SCOPE_FOREIGN', reason: 'requested scope is outside the persisted worker binding' }

  const template = templateState(persistedInput, expectedTemplateId)
  if (!template.ok) return template
  if (persistedInput.enabled !== true || persistedInput.disabled === true || persistedInput.status === 'disabled' || persistedInput.status === 'retired') {
    return { ok: false, code: 'SCOPE_DISABLED', reason: 'persisted scope state is disabled' }
  }
  if (staleState(persistedInput, now, maxAgeMs)) return { ok: false, code: 'SCOPE_STALE', reason: 'persisted scope state is stale' }

  return {
    ok: true,
    scope: Object.freeze({ ...requested }),
    templateId: template.templateId,
  }
}

function capabilityDecision(capability, flags) {
  const requested = text(capability)
  if (!requested) return { ok: true, capability: null }
  if (requested === 'actuate' || requested === 'promote') {
    return { ok: false, code: 'CAPABILITY_FORBIDDEN', reason: `${requested} is outside the Beta read-only boundary` }
  }
  if (!ALLOWED_CAPABILITIES.includes(requested)) {
    return { ok: false, code: 'CAPABILITY_UNSUPPORTED', reason: `unsupported capability: ${requested}` }
  }
  if (requested === 'simulate' && !flags.simulatorEnabled) {
    return { ok: false, code: 'FLAG_SIMULATOR_DISABLED', reason: 'simulator flag is not explicitly enabled' }
  }
  if (requested === 'replay' && !flags.simulatorEnabled && !flags.physicalHilEnabled) {
    return { ok: false, code: 'FLAG_REPLAY_DISABLED', reason: 'replay requires an explicitly enabled evidence mode' }
  }
  return { ok: true, capability: requested }
}

export function evaluateBetaScope({ flags, persistence, requested, persisted, capability, now, maxAgeMs, templateId } = {}) {
  if (!flags?.globallyEnabled) {
    return { ok: false, code: flags?.hardDenied ? 'BETA_HARD_DENY' : 'BETA_DISABLED', reason: flags?.hardDenied ? 'actuation or promotion flags are forbidden' : 'Beta flags are not explicitly enabled' }
  }
  if (!persistence?.ok) return { ok: false, code: 'PERSISTENCE_UNAVAILABLE', reason: 'scope persistence is unavailable' }
  const capabilityResult = capabilityDecision(capability, flags)
  if (!capabilityResult.ok) return capabilityResult
  const scopeResult = intersectScope(requested, persisted, { now, maxAgeMs, templateId })
  if (!scopeResult.ok) return scopeResult
  return { ...scopeResult, capability: capabilityResult.capability }
}

/** 能力判定(独立于 scope 相交):actuate/promote 恒拒;simulate/replay 需显式 flag。 */
export function evaluateCapability({ flags, capability } = {}) {
  return capabilityDecision(capability, flags)
}

export function publicFlags(flags) {
  if (!flags) return { globallyEnabled: false, explicitlyEnabled: false, AW_RSI_BETA_UI_ENABLED: false, uiEnabled: false }
  return {
    AW_RSI_BETA_ENABLED: flags.AW_RSI_BETA_ENABLED === true,
    AW_RSI_BETA_RESEARCH_ENABLED: flags.AW_RSI_BETA_RESEARCH_ENABLED === true,
    AW_RSI_BETA_UI_ENABLED: flags.AW_RSI_BETA_UI_ENABLED === true,
    AW_RSI_BETA_SIMULATOR_ENABLED: flags.AW_RSI_BETA_SIMULATOR_ENABLED === true,
    AW_RSI_BETA_PHYSICAL_HIL_ENABLED: flags.AW_RSI_BETA_PHYSICAL_HIL_ENABLED === true,
    AW_RSI_BETA_ACTUATION_ENABLED: flags.AW_RSI_BETA_ACTUATION_ENABLED === true,
    AW_RSI_BETA_PROMOTION_ENABLED: flags.AW_RSI_BETA_PROMOTION_ENABLED === true,
    globallyEnabled: flags.globallyEnabled === true,
    explicitlyEnabled: flags.explicitlyEnabled === true,
    simulatorEnabled: flags.simulatorEnabled === true,
    physicalHilEnabled: flags.physicalHilEnabled === true,
    uiEnabled: flags.uiEnabled === true,
    hardDenied: flags.hardDenied === true,
    malformed: [...(flags.malformed ?? [])],
  }
}

export async function resolveAdapterRuntime(ctx) {
  const get = ctx?.services?.get
  if (typeof get !== 'function') return { runtime: null, reason: 'CONTEXT_RUNTIME_UNAVAILABLE' }
  try {
    const runtime = await get('context.runtime')
    if (runtime && typeof runtime === 'object') return { runtime, reason: null, service: 'context.runtime' }
  }
  catch {
    // Fail closed: the host runtime is required for real Beta integration.
  }
  return { runtime: null, reason: 'CONTEXT_RUNTIME_UNAVAILABLE' }
}

export async function resolveAdapterRegistry(ctx) {
  const get = ctx?.services?.get
  if (typeof get !== 'function') return { registry: null, reason: 'ADAPTER_REGISTRY_UNAVAILABLE' }
  try {
    const registry = await get('context.adapterRegistry')
    if (registry && typeof registry === 'object') return { registry, reason: null, service: 'context.adapterRegistry' }
  }
  catch {
    // Fail closed: the host runtime is required for real Beta integration.
  }
  return { registry: null, reason: 'ADAPTER_REGISTRY_UNAVAILABLE' }
}

export const adapterDescriptor = Object.freeze({
  adapterId: ADAPTER_ID,
  version: ADAPTER_VERSION,
  apiVersion: API_VERSION,
  capabilities: ALLOWED_CAPABILITIES,
  readOnly: true,
  actuation: false,
  promotion: false,
})

export function queryScopeFromEvent(event) {
  const query = event?.query ?? event?.context?.query
  if (query && typeof query === 'object') return query
  const rawUrl = event?.url ?? event?.node?.req?.url
  if (!rawUrl) return {}
  try {
    const url = new URL(String(rawUrl), 'http://rsi-interface-beta.invalid')
    return Object.fromEntries(url.searchParams.entries())
  }
  catch {
    return {}
  }
}

export function requestedScopeFromEvent(event) {
  const query = queryScopeFromEvent(event)
  const raw = query.scope
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed
    }
    catch {
      return { workspaceId: null, channelId: null, workerId: null }
    }
  }
  return {
    workspaceId: query.workspaceId,
    channelId: query.channelId,
    workerId: query.workerId,
  }
}

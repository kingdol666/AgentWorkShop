import {
  CONTEXT_ADAPTER_API_VERSION,
  CONTEXT_ADAPTER_CAPABILITIES,
  type ContextAdapter,
  type ContextAdapterCapabilities,
  type ContextAdapterHealth,
  type ContextAdapterHealthStatus,
  type ContextAdapterTimeoutPolicy,
  type ContextAdapterOperation,
  type ContextAdapterAuthorizer,
  type ContextAdapterResult,
  type StructuredAdapterError,
  type MaybePromise,
  type NormalizedContextAdapter,
} from './contracts'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TIMEOUT_MS = 120_000
const MAX_STRING_LENGTH = 1000
const HEALTH_STATUSES: readonly ContextAdapterHealthStatus[] = ['healthy', 'degraded', 'unhealthy', 'unknown']
const ERROR_CATEGORIES: readonly StructuredAdapterError['category'][] = [
  'validation',
  'capability',
  'generation',
  'lifecycle',
  'timeout',
  'cancellation',
  'unavailable',
  'conflict',
  'internal',
]

export type AdapterNormalizationOptions = {
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
}

export class ContextAdapterValidationError extends Error {
  readonly code = 'CONTEXT_ADAPTER_INVALID'
  readonly path: string
  readonly issues: readonly string[]

  constructor(message: string, path = '$', issues: readonly string[] = [message]) {
    super(message)
    this.name = 'ContextAdapterValidationError'
    this.path = path
    this.issues = issues
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_STRING_LENGTH) {
    throw new ContextAdapterValidationError(`${path} must be a non-empty string`, path)
  }
  return value.trim()
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new ContextAdapterValidationError(`${path} must be a positive integer`, path)
  }
  return Number(value)
}

function finitePositiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > 2_147_483_647) {
    throw new ContextAdapterValidationError(`${path} must be a positive timeout in milliseconds`, path)
  }
  return Number(value)
}

/** Reject undefined, functions, symbols, bigint, non-finite numbers, and cycles. */
export function assertJsonPayload(value: unknown, path = 'payload'): void {
  const seen = new WeakSet<object>()
  const visit = (current: unknown, currentPath: string): void => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new ContextAdapterValidationError(`${currentPath} must contain finite numbers`, currentPath)
      return
    }
    if (typeof current !== 'object') throw new ContextAdapterValidationError(`${currentPath} is not a JSON-safe value`, currentPath)
    if (seen.has(current)) throw new ContextAdapterValidationError(`${currentPath} contains a cycle`, currentPath)
    seen.add(current)
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}.${index}`))
    }
    else {
      for (const [key, item] of Object.entries(current)) visit(item, `${currentPath}.${key}`)
    }
    seen.delete(current)
  }
  visit(value, path)
}

function normalizeTimeout(value: unknown, options: AdapterNormalizationOptions): ContextAdapterTimeoutPolicy {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS
  const configured = typeof value === 'number'
    ? { defaultMs: value, maxMs: value }
    : isRecord(value)
      ? { defaultMs: value.defaultMs, maxMs: value.maxMs }
      : { defaultMs: defaultTimeoutMs, maxMs: maxTimeoutMs }

  const defaultMs = finitePositiveInteger(configured.defaultMs, 'timeout.defaultMs')
  const maxMs = finitePositiveInteger(configured.maxMs, 'timeout.maxMs')
  if (defaultMs > maxMs) throw new ContextAdapterValidationError('timeout.defaultMs must not exceed timeout.maxMs', 'timeout')
  return { defaultMs, maxMs }
}

export function normalizeAdapterHealth(value: unknown, path = 'health'): ContextAdapterHealth {
  if (!isRecord(value)) throw new ContextAdapterValidationError(`${path} must be a health object`, path)
  if (!HEALTH_STATUSES.includes(value.status as ContextAdapterHealthStatus)) {
    throw new ContextAdapterValidationError(`${path}.status is unsupported`, `${path}.status`)
  }
  if (value.checkedAt !== undefined) text(value.checkedAt, `${path}.checkedAt`)
  if (value.message !== undefined) text(value.message, `${path}.message`)
  if (value.latencyMs !== undefined && (!Number.isFinite(value.latencyMs) || Number(value.latencyMs) < 0)) {
    throw new ContextAdapterValidationError(`${path}.latencyMs must be a non-negative number`, `${path}.latencyMs`)
  }
  if (value.details !== undefined) assertJsonPayload(value.details, `${path}.details`)
  return {
    status: value.status as ContextAdapterHealthStatus,
    ...(value.checkedAt === undefined ? {} : { checkedAt: value.checkedAt as string }),
    ...(value.message === undefined ? {} : { message: value.message as string }),
    ...(value.latencyMs === undefined ? {} : { latencyMs: Number(value.latencyMs) }),
    ...(value.details === undefined ? {} : { details: value.details as Record<string, unknown> }),
  }
}

function normalizeCapabilities(value: unknown, adapter: Record<string, unknown>): ContextAdapterCapabilities {
  if (!isRecord(value)) throw new ContextAdapterValidationError('capabilities must be an object', 'capabilities')
  const capabilities = {} as ContextAdapterCapabilities
  for (const capability of CONTEXT_ADAPTER_CAPABILITIES) {
    if (typeof value[capability] !== 'boolean') {
      throw new ContextAdapterValidationError(`capabilities.${capability} must be a boolean`, `capabilities.${capability}`)
    }
    const operation = adapter[capability]
    if (value[capability] && typeof operation !== 'function') {
      throw new ContextAdapterValidationError(`capability ${capability} requires a matching operation`, capability)
    }
    if (!value[capability] && operation !== undefined) {
      throw new ContextAdapterValidationError(`operation ${capability} is present but capability is disabled`, capability)
    }
    capabilities[capability] = value[capability] as boolean
  }
  return capabilities
}

function normalizeError(value: unknown, path = 'error'): StructuredAdapterError {
  if (!isRecord(value)) throw new ContextAdapterValidationError(`${path} must be a structured error`, path)
  const code = text(value.code, `${path}.code`)
  const category = value.category
  if (!ERROR_CATEGORIES.includes(category as StructuredAdapterError['category'])) {
    throw new ContextAdapterValidationError(`${path}.category is unsupported`, `${path}.category`)
  }
  if (typeof value.retryable !== 'boolean') throw new ContextAdapterValidationError(`${path}.retryable must be boolean`, `${path}.retryable`)
  if (value.details !== undefined) assertJsonPayload(value.details, `${path}.details`)
  return {
    code,
    category: category as StructuredAdapterError['category'],
    message: text(value.message, `${path}.message`),
    retryable: value.retryable,
    ...(value.details === undefined ? {} : { details: value.details as Record<string, unknown> }),
  }
}

export function normalizeAdapterResult(value: unknown): ContextAdapterResult {
  if (isRecord(value) && value.ok === false) return { ok: false, error: normalizeError(value.error) }
  if (isRecord(value) && value.ok === true) {
    if (!Object.prototype.hasOwnProperty.call(value, 'payload')) throw new ContextAdapterValidationError('successful adapter result requires payload', 'payload')
    assertJsonPayload(value.payload)
    if (value.metadata !== undefined) assertJsonPayload(value.metadata, 'metadata')
    return {
      ok: true,
      payload: value.payload,
      ...(value.metadata === undefined ? {} : { metadata: value.metadata as Record<string, unknown> }),
    }
  }
  assertJsonPayload(value)
  return { ok: true, payload: value }
}

function lifecycleMethod(adapter: Record<string, unknown>, name: 'drain' | 'retire'): (context: Parameters<NonNullable<ContextAdapter['drain']>>[0]) => MaybePromise<void> {
  if (typeof adapter[name] !== 'function') throw new ContextAdapterValidationError(`${name} must be a function`, name)
  return adapter[name] as (context: Parameters<NonNullable<ContextAdapter['drain']>>[0]) => MaybePromise<void>
}

export function normalizeContextAdapter(value: unknown, options: AdapterNormalizationOptions = {}): NormalizedContextAdapter {
  if (!isRecord(value)) throw new ContextAdapterValidationError('adapter must be an object')
  const adapterId = text(value.adapterId, 'adapterId')
  const apiVersion = text(value.apiVersion, 'apiVersion')
  if (apiVersion !== CONTEXT_ADAPTER_API_VERSION) throw new ContextAdapterValidationError(`unsupported apiVersion ${apiVersion}`, 'apiVersion')
  const version = text(value.version, 'version')
  const sideEffect = value.sideEffect
  if (sideEffect !== 'none' && sideEffect !== 'candidate-only') throw new ContextAdapterValidationError('sideEffect must be none or candidate-only', 'sideEffect')
  const generation = positiveInteger(value.generation, 'generation')
  const capabilities = normalizeCapabilities(value.capabilities, value)
  const owner = value.owner
  if (!isRecord(owner) || typeof owner.dispose !== 'function') throw new ContextAdapterValidationError('owner.dispose must be a function', 'owner')
  const ownerId = text(owner.ownerId, 'owner.ownerId')
  const health = typeof value.health === 'function' ? value.health as ContextAdapter['health'] : normalizeAdapterHealth(value.health, 'health')
  if (value.timeout === undefined) throw new ContextAdapterValidationError('timeout is required', 'timeout')
  const timeout = normalizeTimeout(value.timeout, options)
  const normalized: NormalizedContextAdapter = {
    adapterId,
    apiVersion,
    version,
    capabilities,
    sideEffect,
    generation,
    health,
    timeout,
    owner: { ownerId, dispose: owner.dispose as ContextAdapter['owner']['dispose'] },
    ...(value.requiresAuthorization === true ? { requiresAuthorization: true } : {}),
    ...(typeof value.authorize === 'function' ? { authorize: value.authorize as ContextAdapterAuthorizer } : {}),
    drain: lifecycleMethod(value, 'drain'),
    retire: lifecycleMethod(value, 'retire'),
  }
  for (const capability of CONTEXT_ADAPTER_CAPABILITIES) {
    if (capabilities[capability]) normalized[capability] = value[capability] as ContextAdapterOperation
  }
  return normalized
}

export function isAdapterResult(value: unknown): value is ContextAdapterResult {
  try {
    normalizeAdapterResult(value)
    return true
  }
  catch {
    return false
  }
}

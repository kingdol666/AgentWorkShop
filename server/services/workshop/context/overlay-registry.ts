import { canonicalHash, canonicalJson } from '@/shared/context/hash'
import { contextScopeSchema, refKey, type ContextScope } from '@/shared/context/refs'
import type { MaybePromise } from './contracts'

export const CONTEXT_OVERLAY_API_VERSION = 'context-overlay.v1' as const

export const CONTEXT_OVERLAY_ERROR_CODES = {
  INVALID_PROVIDER: 'CONTEXT_OVERLAY_INVALID_PROVIDER',
  DUPLICATE: 'CONTEXT_OVERLAY_DUPLICATE',
  CONFLICT: 'CONTEXT_OVERLAY_CONFLICT',
  NOT_FOUND: 'CONTEXT_OVERLAY_NOT_FOUND',
  GENERATION_STALE: 'CONTEXT_OVERLAY_GENERATION_STALE',
  NOT_READY: 'CONTEXT_OVERLAY_NOT_READY',
  DISPOSED: 'CONTEXT_OVERLAY_DISPOSED',
  OWNER_DISPOSE_FAILED: 'CONTEXT_OVERLAY_OWNER_DISPOSE_FAILED',
} as const

export type ContextOverlayRegistryErrorCode = typeof CONTEXT_OVERLAY_ERROR_CODES[keyof typeof CONTEXT_OVERLAY_ERROR_CODES]

export class ContextOverlayRegistryError extends Error {
  readonly code: ContextOverlayRegistryErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: ContextOverlayRegistryErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ContextOverlayRegistryError'
    this.code = code
    this.details = details
  }
}

/**
 * The overlay is deliberately a data-only result. It is not prompt text and it
 * contains no tool, routing, model, or write authority fields.
 */
export interface ContextOverlayItem {
  readonly id: string
  readonly source: {
    readonly id: string
    readonly label: string
    readonly revision?: string
    readonly generation: number
  }
  readonly untrusted: true
  readonly data: unknown
  readonly dataHash: string
}

export interface ContextOverlay {
  readonly kind: 'shadow'
  readonly untrusted: true
  readonly items: readonly ContextOverlayItem[]
  readonly contentHash: string
}

const EMPTY_ITEMS: readonly ContextOverlayItem[] = Object.freeze([])
const EMPTY_CONTEXT_OVERLAY: ContextOverlay = Object.freeze({
  kind: 'shadow',
  untrusted: true,
  items: EMPTY_ITEMS,
  contentHash: canonicalHash(EMPTY_ITEMS),
})

export function createEmptyContextOverlay(): ContextOverlay {
  return EMPTY_CONTEXT_OVERLAY
}

export const emptyContextOverlay = createEmptyContextOverlay

export interface ContextOverlayFlags {
  /** Explicit availability from the host flag provider. */
  available?: boolean
  /** Generic enabled spelling for tests and small hosts. */
  enabled?: boolean
  /** Preferred flag name for this seam. */
  shadowOverlayEnabled?: boolean
  /** Host-prefixed spelling for an eventual integration. */
  contextOverlayEnabled?: boolean
  /** Alternate host-prefixed spelling retained for compatibility. */
  contextOverlay?: boolean
}

export type ContextOverlayFlagSource = ContextOverlayFlags | (() => ContextOverlayFlags | boolean | undefined | null)

export interface ContextOverlaySource {
  readonly id: string
  readonly label: string
  readonly revision?: string
}

export interface ContextOverlayCandidate {
  readonly id?: string
  readonly data: unknown
}

export interface ContextOverlayReadRequest {
  readonly apiVersion: typeof CONTEXT_OVERLAY_API_VERSION
  readonly overlayId: string
  readonly version: string
  readonly generation: number
  readonly scope: ContextScope
  readonly signal: AbortSignal
}

export type ContextOverlayReader = (request: ContextOverlayReadRequest) => MaybePromise<readonly ContextOverlayCandidate[] | ContextOverlayCandidate | unknown>

export interface ContextOverlayOwner {
  readonly ownerId: string
  dispose(context: ContextOverlayLifecycleContext): MaybePromise<void>
}

export interface ContextOverlayLifecycleContext {
  readonly overlayId: string
  readonly version: string
  readonly generation: number
  readonly reason: 'replaced' | 'unregistered' | 'owner-disposed' | 'registry-disposed'
  readonly inFlight: number
  readonly signal: AbortSignal
}

export interface ContextOverlayProvider {
  readonly overlayId: string
  readonly version: string
  readonly generation: number
  readonly source: ContextOverlaySource
  readonly scope: ContextScope
  readonly owner: ContextOverlayOwner
  readonly read: ContextOverlayReader
  drain(context: ContextOverlayLifecycleContext): MaybePromise<void>
  retire(context: ContextOverlayLifecycleContext): MaybePromise<void>
}

export interface ContextOverlayLimits {
  readonly maxProviders: number
  readonly maxItems: number
  readonly maxDataBytes: number
  readonly maxOverlayBytes: number
  readonly maxDepth: number
  readonly maxKeys: number
  readonly maxArrayItems: number
  readonly maxStringChars: number
}

export const CONTEXT_OVERLAY_LIMITS: ContextOverlayLimits = Object.freeze({
  maxProviders: 16,
  maxItems: 32,
  maxDataBytes: 4_096,
  maxOverlayBytes: 16_384,
  maxDepth: 4,
  maxKeys: 32,
  maxArrayItems: 32,
  maxStringChars: 512,
})

export interface ContextOverlayRegistryOptions {
  readonly flags?: ContextOverlayFlagSource
  readonly limits?: Partial<ContextOverlayLimits>
}

export interface ContextOverlayRegistrationResult {
  readonly ok: true
  readonly overlayId: string
  readonly version: string
  readonly generation: number
  readonly state: 'ready'
  readonly idempotent?: boolean
  readonly drainedGenerations: readonly number[]
}

export interface ContextOverlayDrainResult {
  readonly ok: true
  readonly overlayId: string
  readonly generation: number
  readonly state: 'ready' | 'draining' | 'retired' | 'failed'
  readonly inFlight: number
  readonly retired: boolean
}

export interface ContextOverlaySummary {
  readonly overlayId: string
  readonly version: string
  readonly generation: number
  readonly source: ContextOverlaySource
  readonly scope: ContextScope
  readonly ownerId: string
  readonly state: ContextOverlayDrainResult['state']
  readonly inFlight: number
  readonly errors: readonly string[]
}

type OverlayState = ContextOverlayDrainResult['state']

type ProviderRecord = {
  readonly provider: ContextOverlayProvider
  state: OverlayState
  inFlight: number
  errors: string[]
  drainingReason?: ContextOverlayLifecycleContext['reason']
  lifecycleStarted: boolean
}

type SanitizerState = { nodes: number }

const AUTHORITY_KEY = /^(?:prompt|system(?:prompt)?|instruction|instructions|tool|tools|tool[_-]?calls?|route|routing|router|write|writes|write[_-]?intent|command|commands|dispatch|model|authority|capability|capabilities)$/i
const MAX_PROVIDER_TEXT = 160
const MAX_ID_TEXT = 120

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyText(value: unknown, path: string, max = MAX_PROVIDER_TEXT): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.INVALID_PROVIDER, `${path} must be a non-empty string of at most ${max} characters`)
  }
  return value.trim()
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.INVALID_PROVIDER, `${path} must be a positive integer`)
  }
  return Number(value)
}

function normalizeScope(value: unknown, path: string): ContextScope {
  const parsed = contextScopeSchema.safeParse(value ?? {})
  if (!parsed.success) {
    throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.INVALID_PROVIDER, `${path} is not a valid context scope`, { issues: parsed.error.issues })
  }
  return parsed.data
}

function normalizeSource(value: unknown): ContextOverlaySource {
  if (!isRecord(value)) throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.INVALID_PROVIDER, 'source is required')
  const id = nonEmptyText(value.id, 'source.id')
  const label = nonEmptyText(value.label, 'source.label')
  const revision = value.revision === undefined ? undefined : nonEmptyText(value.revision, 'source.revision')
  return Object.freeze({ id, label, ...(revision ? { revision } : {}) })
}

function normalizeLimits(input: Partial<ContextOverlayLimits> | undefined): ContextOverlayLimits {
  const out = { ...CONTEXT_OVERLAY_LIMITS }
  for (const key of Object.keys(out) as Array<keyof ContextOverlayLimits>) {
    const value = input?.[key]
    if (value === undefined) continue
    if (!Number.isInteger(value) || value <= 0) throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.INVALID_PROVIDER, `limits.${key} must be a positive integer`)
    out[key] = Math.min(value, CONTEXT_OVERLAY_LIMITS[key])
  }
  return Object.freeze(out)
}

function sanitizeText(value: string, maxChars: number): string {
  const chars = [...value].filter((char) => {
    const code = char.charCodeAt(0)
    return code >= 0x20 && code !== 0x7f
  })
  return chars.join('').replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

function sanitizeKey(value: string): string | undefined {
  const key = sanitizeText(value, 120)
  if (!key || AUTHORITY_KEY.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined
  return key
}

/** Convert arbitrary provider output into bounded JSON-like, non-authoritative data. */
function sanitizeData(value: unknown, limits: ContextOverlayLimits, depth: number, state: SanitizerState): unknown {
  if (state.nodes >= limits.maxKeys * limits.maxArrayItems) return null
  state.nodes += 1
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return sanitizeText(value, limits.maxStringChars)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object' || depth >= limits.maxDepth) return null
  if (Array.isArray(value)) {
    return value.slice(0, limits.maxArrayItems).map(item => sanitizeData(item, limits, depth + 1, state))
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [rawKey, nested] of Object.entries(value).slice(0, limits.maxKeys)) {
    const key = sanitizeKey(rawKey)
    if (!key) continue
    output[key] = sanitizeData(nested, limits, depth + 1, state)
  }
  return output
}

function boundedData(value: unknown, limits: ContextOverlayLimits): unknown {
  const sanitized = sanitizeData(value, limits, 0, { nodes: 0 })
  try {
    if (Buffer.byteLength(canonicalJson(sanitized), 'utf8') <= limits.maxDataBytes) return sanitized
  }
  catch {
    // Fall through to the smallest safe data representation.
  }
  return Object.freeze(Object.create(null))
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value
  seen.add(value as object)
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen)
  return Object.freeze(value)
}

function sourceScopeContains(container: ContextScope, requested: ContextScope): boolean {
  const scalarKeys: Array<keyof Pick<ContextScope, 'tenantId' | 'workspaceId'>> = ['tenantId', 'workspaceId']
  for (const key of scalarKeys) if (container[key] !== requested[key]) return false

  const refKeys: Array<keyof Pick<ContextScope, 'subjectRefs' | 'objectRefs' | 'attributeRefs' | 'materialAssignmentRefs'>> = [
    'subjectRefs', 'objectRefs', 'attributeRefs', 'materialAssignmentRefs',
  ]
  for (const key of refKeys) {
    const expected = container[key]
    const actual = requested[key]
    if (expected === undefined) {
      if (actual !== undefined) return false
      continue
    }
    if (actual === undefined) return false
    const actualKeys = new Set(actual.map(refKey))
    if (expected.some(ref => !actualKeys.has(refKey(ref)))) return false
  }

  if (container.tags !== undefined) {
    if (requested.tags === undefined || container.tags.some(tag => !requested.tags!.includes(tag))) return false
  }
  if (container.timeWindow !== undefined) {
    if (requested.timeWindow === undefined) return false
    if (Date.parse(container.timeWindow.from) > Date.parse(requested.timeWindow.from)) return false
    if (Date.parse(container.timeWindow.to) < Date.parse(requested.timeWindow.to)) return false
  }
  return true
}

function flagEnabled(source: ContextOverlayFlagSource | undefined): boolean {
  if (source === undefined) return false
  let flags: ContextOverlayFlags | boolean | undefined | null
  try {
    flags = typeof source === 'function' ? source() : source
  }
  catch {
    return false
  }
  if (flags === true) return true
  if (!isRecord(flags)) return false
  if (flags.available === false) return false
  const enabled = flags.enabled === true
    || flags.shadowOverlayEnabled === true
    || flags.contextOverlayEnabled === true
    || flags.contextOverlay === true
  if (!enabled) return false
  return flags.available === true || Object.keys(flags).some(key => key !== 'available')
}

function overlayKey(overlayId: string, version: string): string {
  return `${overlayId}\u0000${version}`
}

function candidateValues(value: unknown): readonly ContextOverlayCandidate[] {
  const values = Array.isArray(value) ? value : [value]
  return values.map((item) => {
    if (isRecord(item) && Object.prototype.hasOwnProperty.call(item, 'data')) {
      return { id: typeof item.id === 'string' ? item.id : undefined, data: item.data }
    }
    return { data: item }
  })
}

function candidateId(value: string | undefined, source: ContextOverlaySource, dataHash: string): string {
  const id = value ? sanitizeText(value, MAX_ID_TEXT) : ''
  return id || `${source.id}-${dataHash.slice(0, 16)}`
}

export class ContextOverlayRegistry {
  private readonly records = new Map<string, ProviderRecord>()
  private readonly active = new Map<string, string>()
  private readonly flags?: ContextOverlayFlagSource
  private readonly limits: ContextOverlayLimits
  private disposed = false

  constructor(options: ContextOverlayRegistryOptions = {}) {
    this.flags = options.flags
    this.limits = normalizeLimits(options.limits)
  }

  register(provider: ContextOverlayProvider): ContextOverlayRegistrationResult {
    this.ensureOpen()
    const normalized = this.normalizeProvider(provider)
    const key = overlayKey(normalized.overlayId, normalized.version)
    const existing = this.records.get(key)
    if (existing && existing.provider.generation === normalized.generation) {
      if (existing.provider.owner.ownerId !== normalized.owner.ownerId) {
        throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.CONFLICT, `overlay ${normalized.overlayId}@${normalized.version} is owned by another owner`)
      }
      return { ok: true, overlayId: normalized.overlayId, version: normalized.version, generation: normalized.generation, state: 'ready', idempotent: true, drainedGenerations: [] }
    }
    if (existing && existing.provider.generation > normalized.generation) {
      throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.GENERATION_STALE, `overlay generation ${normalized.generation} is older than registered generation ${existing.provider.generation}`)
    }
    const activeKey = this.active.get(normalized.overlayId)
    const active = activeKey ? this.records.get(activeKey) : undefined
    if (active && active.provider.generation > normalized.generation) {
      throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.GENERATION_STALE, `overlay generation ${normalized.generation} is older than active generation ${active.provider.generation}`)
    }

    const retired: ProviderRecord[] = []
    if (active && active.provider.generation < normalized.generation && active.state === 'ready') {
      active.state = 'draining'
      active.drainingReason = 'replaced'
      retired.push(active)
    }
    this.records.set(key, { provider: normalized, state: 'ready', inFlight: 0, errors: [], lifecycleStarted: false })
    this.active.set(normalized.overlayId, key)
    for (const record of retired) void this.finalizeDrain(record)
    return {
      ok: true,
      overlayId: normalized.overlayId,
      version: normalized.version,
      generation: normalized.generation,
      state: 'ready',
      drainedGenerations: retired.map(record => record.provider.generation),
    }
  }

  registerOne(provider: ContextOverlayProvider): ContextOverlayRegistrationResult {
    return this.register(provider)
  }

  async registerMany(providers: readonly ContextOverlayProvider[]): Promise<readonly ContextOverlayRegistrationResult[]> {
    return providers.map(provider => this.register(provider))
  }

  async resolve(scope: ContextScope = {}, signal?: AbortSignal): Promise<ContextOverlay> {
    this.ensureOpen()
    if (!flagEnabled(this.flags) || signal?.aborted) return EMPTY_CONTEXT_OVERLAY
    if (!contextScopeSchema.safeParse(scope).success) return EMPTY_CONTEXT_OVERLAY

    const records: ProviderRecord[] = []
    for (const key of this.active.values()) {
      const record = this.records.get(key)
      if (record && record.state === 'ready' && sourceScopeContains(record.provider.scope, scope)) records.push(record)
      if (records.length >= this.limits.maxProviders) break
    }
    if (records.length === 0) return EMPTY_CONTEXT_OVERLAY

    const items: ContextOverlayItem[] = []
    for (const record of records) {
      if (signal?.aborted) break
      const controller = new AbortController()
      const onAbort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      record.inFlight += 1
      try {
        const result = await record.provider.read({
          apiVersion: CONTEXT_OVERLAY_API_VERSION,
          overlayId: record.provider.overlayId,
          version: record.provider.version,
          generation: record.provider.generation,
          scope,
          signal: controller.signal,
        })
        if (!controller.signal.aborted && !signal?.aborted) {
          for (const candidate of candidateValues(result)) {
            if (items.length >= this.limits.maxItems) break
            const data = boundedData(candidate.data, this.limits)
            const dataHash = canonicalHash(data)
            const item: ContextOverlayItem = {
              id: candidateId(candidate.id, record.provider.source, dataHash),
              source: Object.freeze({
                id: record.provider.source.id,
                label: record.provider.source.label,
                ...(record.provider.source.revision ? { revision: record.provider.source.revision } : {}),
                generation: record.provider.generation,
              }),
              untrusted: true,
              data,
              dataHash,
            }
            items.push(deepFreeze(item))
          }
        }
      }
      catch (error) {
        record.errors.push(error instanceof Error ? error.message.slice(0, MAX_PROVIDER_TEXT) : 'overlay provider failed')
      }
      finally {
        record.inFlight -= 1
        signal?.removeEventListener('abort', onAbort)
        if (record.inFlight === 0 && record.state === 'draining') void this.finalizeDrain(record)
      }
    }

    let boundedItems = items
    try {
      while (boundedItems.length > 0 && Buffer.byteLength(canonicalJson(boundedItems), 'utf8') > this.limits.maxOverlayBytes) boundedItems = boundedItems.slice(0, -1)
    }
    catch {
      boundedItems = []
    }
    if (boundedItems.length === 0) return EMPTY_CONTEXT_OVERLAY
    return deepFreeze({ kind: 'shadow', untrusted: true, items: boundedItems, contentHash: canonicalHash(boundedItems) })
  }

  read(scope: ContextScope = {}, signal?: AbortSignal): Promise<ContextOverlay> {
    return this.resolve(scope, signal)
  }

  unregister(overlayId: string, version?: string): readonly ContextOverlayDrainResult[] {
    this.ensureOpen()
    const records = [...this.records.values()].filter(record => record.provider.overlayId === overlayId && (version === undefined || record.provider.version === version))
    if (records.length === 0) throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.NOT_FOUND, `overlay ${overlayId}${version ? `@${version}` : ''} is not registered`)
    for (const record of records) {
      if (record.state === 'ready') {
        record.state = 'draining'
        record.drainingReason = 'unregistered'
      }
      void this.finalizeDrain(record)
    }
    return records.map(record => this.drainResult(record))
  }

  drain(overlayId: string, generation?: number): ContextOverlayDrainResult {
    this.ensureOpen()
    const activeKey = this.active.get(overlayId)
    const record = activeKey ? this.records.get(activeKey) : undefined
    if (!record || (generation !== undefined && generation !== record.provider.generation)) {
      throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.NOT_FOUND, `overlay ${overlayId} is not active`)
    }
    if (record.state === 'ready') {
      record.state = 'draining'
      record.drainingReason = 'unregistered'
    }
    void this.finalizeDrain(record)
    return this.drainResult(record)
  }

  list(options: { includeDraining?: boolean, includeRetired?: boolean, includeFailed?: boolean } = {}): readonly ContextOverlaySummary[] {
    return [...this.records.values()]
      .filter(record => record.state === 'ready'
        || (record.state === 'draining' && options.includeDraining)
        || (record.state === 'retired' && options.includeRetired)
        || (record.state === 'failed' && options.includeFailed))
      .map(record => ({
        overlayId: record.provider.overlayId,
        version: record.provider.version,
        generation: record.provider.generation,
        source: record.provider.source,
        scope: record.provider.scope,
        ownerId: record.provider.owner.ownerId,
        state: record.state,
        inFlight: record.inFlight,
        errors: Object.freeze([...record.errors]),
      }))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const records = [...this.records.values()]
    for (const record of records) {
      if (record.state === 'ready') record.state = 'draining'
      record.drainingReason = 'registry-disposed'
    }
    await Promise.all(records.map(record => this.finalizeDrain(record)))
  }

  private normalizeProvider(provider: ContextOverlayProvider): ContextOverlayProvider {
    if (!isRecord(provider)) throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.INVALID_PROVIDER, 'provider is required')
    const overlayId = nonEmptyText(provider.overlayId, 'overlayId')
    const version = nonEmptyText(provider.version, 'version')
    const generation = positiveInteger(provider.generation, 'generation')
    const source = normalizeSource(provider.source)
    const scope = normalizeScope(provider.scope, 'scope')
    if (typeof provider.read !== 'function') throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.INVALID_PROVIDER, 'read must be a function')
    if (!isRecord(provider.owner) || typeof provider.owner.dispose !== 'function') throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.INVALID_PROVIDER, 'owner.dispose must be a function')
    const ownerId = nonEmptyText(provider.owner.ownerId, 'owner.ownerId')
    if (typeof provider.drain !== 'function' || typeof provider.retire !== 'function') throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.INVALID_PROVIDER, 'drain and retire must be functions')
    return {
      overlayId,
      version,
      generation,
      source,
      scope,
      owner: { ownerId, dispose: provider.owner.dispose },
      read: provider.read,
      drain: provider.drain,
      retire: provider.retire,
    }
  }

  private async finalizeDrain(record: ProviderRecord): Promise<void> {
    if (record.lifecycleStarted || record.inFlight > 0) return
    record.lifecycleStarted = true
    const provider = record.provider
    const context = {
      overlayId: provider.overlayId,
      version: provider.version,
      generation: provider.generation,
      reason: record.drainingReason ?? (this.disposed ? 'registry-disposed' : 'unregistered'),
      inFlight: record.inFlight,
      signal: new AbortController().signal,
    } as const
    try {
      await provider.drain(context)
      await provider.retire(context)
      await provider.owner.dispose({ ...context, reason: 'owner-disposed' })
      record.state = 'retired'
      if (this.active.get(provider.overlayId) === overlayKey(provider.overlayId, provider.version)) this.active.delete(provider.overlayId)
    }
    catch (error) {
      record.state = 'failed'
      record.errors.push(error instanceof Error ? error.message.slice(0, MAX_PROVIDER_TEXT) : CONTEXT_OVERLAY_ERROR_CODES.OWNER_DISPOSE_FAILED)
    }
  }

  private drainResult(record: ProviderRecord): ContextOverlayDrainResult {
    return { ok: true, overlayId: record.provider.overlayId, generation: record.provider.generation, state: record.state, inFlight: record.inFlight, retired: record.state === 'retired' }
  }

  private ensureOpen(): void {
    if (this.disposed) throw new ContextOverlayRegistryError(CONTEXT_OVERLAY_ERROR_CODES.DISPOSED, 'context overlay registry is disposed')
  }
}

export function createContextOverlayRegistry(options: ContextOverlayRegistryOptions = {}): ContextOverlayRegistry {
  return new ContextOverlayRegistry(options)
}

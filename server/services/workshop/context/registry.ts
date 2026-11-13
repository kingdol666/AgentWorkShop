import {
  CONTEXT_ADAPTER_CAPABILITIES,
  type ContextAdapter,
  type ContextAdapterCapability,
  type ContextAdapterDrainResult,
  type ContextAdapterHealth,
  type ContextAdapterInvokeOptions,
  type ContextAdapterRegistrationResult,
  type ContextAdapterResult,
  type ContextAdapterRetireResult,
  type ContextAdapterSummary,
  type NormalizedContextAdapter,
  type StructuredAdapterError,
} from './contracts'
import { normalizeAdapterHealth, normalizeAdapterResult, normalizeContextAdapter, ContextAdapterValidationError } from './normalizer'

export const CONTEXT_ADAPTER_ERROR_CODES = {
  INVALID_ADAPTER: 'CONTEXT_ADAPTER_INVALID',
  DUPLICATE: 'CONTEXT_ADAPTER_DUPLICATE',
  CONFLICT: 'CONTEXT_ADAPTER_CONFLICT',
  NOT_FOUND: 'CONTEXT_ADAPTER_NOT_FOUND',
  CAPABILITY_UNSUPPORTED: 'CONTEXT_ADAPTER_CAPABILITY_UNSUPPORTED',
  GENERATION_STALE: 'CONTEXT_ADAPTER_GENERATION_STALE',
  GENERATION_INVALID: 'CONTEXT_ADAPTER_GENERATION_INVALID',
  NOT_READY: 'CONTEXT_ADAPTER_NOT_READY',
  ABORTED: 'CONTEXT_ADAPTER_ABORTED',
  TIMEOUT: 'CONTEXT_ADAPTER_TIMEOUT',
  MALFORMED_RESULT: 'CONTEXT_ADAPTER_MALFORMED_RESULT',
  HEALTH_UNAVAILABLE: 'CONTEXT_ADAPTER_HEALTH_UNAVAILABLE',
  OWNER_DISPOSE_FAILED: 'CONTEXT_ADAPTER_OWNER_DISPOSE_FAILED',
  DRAIN_TIMEOUT: 'CONTEXT_ADAPTER_DRAIN_TIMEOUT',
} as const

export type ContextAdapterRegistryErrorCode = typeof CONTEXT_ADAPTER_ERROR_CODES[keyof typeof CONTEXT_ADAPTER_ERROR_CODES]

export class ContextAdapterRegistryError extends Error {
  readonly code: ContextAdapterRegistryErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: ContextAdapterRegistryErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ContextAdapterRegistryError'
    this.code = code
    this.details = details
  }
}

type AdapterRecord = {
  adapter: NormalizedContextAdapter
  state: ContextAdapterSummary['state']
  inFlight: number
  operations: Set<InFlightOperation>
  registeredAt: string
  drainingAt?: string
  drainingReason?: 'replaced' | 'unregistered' | 'registry-disposed'
  retiredAt?: string
  errors: StructuredAdapterError[]
  drainPromise?: Promise<boolean>
  drainWaiters: Set<() => void>
}

type InFlightOperation = {
  controller: AbortController
  reject: (error: unknown) => void
}

type StagedRegistration = {
  adapter: NormalizedContextAdapter
  key: string
}

const DRAIN_TIMEOUT_MS = 1_000

function key(adapterId: string, version: string): string {
  return `${adapterId}\u0000${version}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function now(): string {
  return new Date().toISOString()
}

function errorFromUnknown(error: unknown, fallback: StructuredAdapterError): StructuredAdapterError {
  if (isRecord(error) && typeof error.code === 'string' && typeof error.category === 'string' && typeof error.message === 'string' && typeof error.retryable === 'boolean') {
    return {
      code: error.code,
      category: error.category as StructuredAdapterError['category'],
      message: error.message,
      retryable: error.retryable,
      ...(isRecord(error.details) ? { details: error.details } : {}),
    }
  }
  return fallback
}

function abortError(message = 'adapter operation was cancelled'): ContextAdapterRegistryError {
  return new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.ABORTED, message)
}

export class ContextAdapterRegistry {
  private readonly records = new Map<string, AdapterRecord>()
  private readonly active = new Map<string, string>()
  private disposed = false

  /** Validate the complete batch before publishing any adapter. */
  register(adapters: readonly ContextAdapter[]): ContextAdapterRegistrationResult[] {
    this.ensureOpen()
    const staged: StagedRegistration[] = []
    const batchKeys = new Set<string>()
    for (const candidate of adapters) {
      let adapter: NormalizedContextAdapter
      try {
        adapter = normalizeContextAdapter(candidate)
      }
      catch (error) {
        if (error instanceof ContextAdapterValidationError) {
          throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.INVALID_ADAPTER, error.message, { path: error.path, issues: error.issues })
        }
        throw error
      }
      const registrationKey = key(adapter.adapterId, adapter.version)
      if (batchKeys.has(registrationKey)) throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.DUPLICATE, `duplicate adapter ${adapter.adapterId}@${adapter.version}`)
      batchKeys.add(registrationKey)
      const existing = this.records.get(registrationKey)
      if (existing && existing.adapter.generation === adapter.generation) {
        if (existing.adapter.owner.ownerId !== adapter.owner.ownerId) throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.CONFLICT, `adapter ${adapter.adapterId}@${adapter.version} is already registered by another owner`)
        staged.push({ adapter, key: registrationKey })
        continue
      }
      if (existing && existing.adapter.generation > adapter.generation) {
        throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.GENERATION_STALE, `adapter ${adapter.adapterId}@${adapter.version} generation ${adapter.generation} is older than registered generation ${existing.adapter.generation}`)
      }
      const activeKey = this.active.get(adapter.adapterId)
      const active = activeKey ? this.records.get(activeKey) : undefined
      if (active && adapter.generation < active.adapter.generation) {
        throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.GENERATION_STALE, `adapter ${adapter.adapterId} generation ${adapter.generation} is older than active generation ${active.adapter.generation}`)
      }
      staged.push({ adapter, key: registrationKey })
    }

    const results: ContextAdapterRegistrationResult[] = []
    const retired: AdapterRecord[] = []
    for (const item of staged) {
      const existing = this.records.get(item.key)
      if (existing && existing.adapter.generation === item.adapter.generation) {
        results.push({ ok: true, adapterId: item.adapter.adapterId, version: item.adapter.version, generation: item.adapter.generation, state: 'ready', idempotent: true, drainedGenerations: [] })
        continue
      }
      const activeKey = this.active.get(item.adapter.adapterId)
      const active = activeKey ? this.records.get(activeKey) : undefined
      if (active && active.adapter.generation < item.adapter.generation && active.state === 'ready') {
        active.state = 'draining'
        active.drainingAt = now()
        active.drainingReason = 'replaced'
        retired.push(active)
      }
      const record: AdapterRecord = { adapter: item.adapter, state: 'ready', inFlight: 0, operations: new Set(), registeredAt: now(), errors: [], drainWaiters: new Set() }
      this.records.set(item.key, record)
      this.active.set(item.adapter.adapterId, item.key)
      results.push({ ok: true, adapterId: item.adapter.adapterId, version: item.adapter.version, generation: item.adapter.generation, state: 'ready', drainedGenerations: retired.filter(value => value.adapter.adapterId === item.adapter.adapterId).map(value => value.adapter.generation) })
    }
    for (const record of retired) void this.finalizeDrain(record, 'replaced')
    return results
  }

  registerOne(adapter: ContextAdapter): ContextAdapterRegistrationResult {
    return this.register([adapter])[0]!
  }

  unregister(adapterId: string, version?: string): ContextAdapterDrainResult[] {
    this.ensureOpen()
    const records = this.findRecords(adapterId, version)
    if (records.length === 0) throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.NOT_FOUND, `adapter ${adapterId}${version ? `@${version}` : ''} is not registered`)
    for (const record of records) {
      if (record.state === 'ready') {
        record.state = 'draining'
        record.drainingAt = now()
        record.drainingReason = 'unregistered'
      }
      void this.finalizeDrain(record, 'unregistered')
    }
    return records.map(record => this.drainResult(record))
  }

  async invoke<TPayload = unknown>(adapterId: string, capability: ContextAdapterCapability, payload: TPayload, options: ContextAdapterInvokeOptions): Promise<ContextAdapterResult> {
    this.ensureOpen()
    if (!CONTEXT_ADAPTER_CAPABILITIES.includes(capability)) throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.CAPABILITY_UNSUPPORTED, `unsupported capability ${capability}`)
    const record = this.resolve(adapterId, options.generation)
    if (!record.adapter.capabilities[capability] || typeof record.adapter[capability] !== 'function') {
      throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.CAPABILITY_UNSUPPORTED, `${adapterId} does not declare capability ${capability}`)
    }
    const expectedGeneration = options.generation ?? record.adapter.generation
    if (expectedGeneration !== record.adapter.generation) throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.GENERATION_STALE, `requested generation ${expectedGeneration} is not current for ${adapterId}`)
    if (record.state !== 'ready') throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.NOT_READY, `${adapterId} is ${record.state}`)
    if (!options.idempotencyKey || options.idempotencyKey.trim().length === 0) throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.INVALID_ADAPTER, 'idempotencyKey is required')
    const operation = record.adapter[capability]
    if (typeof operation !== 'function') throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.CAPABILITY_UNSUPPORTED, `${adapterId} operation ${capability} is unavailable`)
    const callerSignal = options.signal
    if (callerSignal?.aborted) throw abortError()
    const timeoutMs = options.timeoutMs ?? record.adapter.timeout.defaultMs
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > record.adapter.timeout.maxMs) throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.TIMEOUT, `timeoutMs must be between 1 and ${record.adapter.timeout.maxMs}`)
    const controller = new AbortController()
    let rejectCancellation: ((error: unknown) => void) | undefined
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const inFlightOperation: InFlightOperation = {
      controller,
      reject: error => rejectCancellation?.(error),
    }
    const onAbort = () => {
      controller.abort(callerSignal?.reason)
      rejectCancellation?.(abortError())
    }
    callerSignal?.addEventListener('abort', onAbort, { once: true })
    record.inFlight += 1
    record.operations.add(inFlightOperation)
    const operationPromise = Promise.resolve().then(() => operation({ adapterId, apiVersion: record.adapter.apiVersion, version: record.adapter.version, generation: record.adapter.generation, capability, payload, idempotencyKey: options.idempotencyKey, timeoutMs, signal: controller.signal }))
    const cancellationPromise = new Promise<never>((_, reject) => {
      rejectCancellation = reject
    })
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort(new Error('adapter timeout'))
        reject(new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.TIMEOUT, `adapter ${adapterId} exceeded ${timeoutMs}ms`))
      }, timeoutMs)
    })
    try {
      const result = await Promise.race([operationPromise, cancellationPromise, timeoutPromise])
      try {
        return normalizeAdapterResult(result)
      }
      catch (error) {
        const structured = errorFromUnknown(error, { code: CONTEXT_ADAPTER_ERROR_CODES.MALFORMED_RESULT, category: 'validation', message: error instanceof Error ? error.message : 'adapter returned malformed payload', retryable: false })
        record.errors.push(structured)
        throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.MALFORMED_RESULT, structured.message, structured.details)
      }
    }
    catch (error) {
      if (error instanceof ContextAdapterRegistryError) throw error
      if (callerSignal?.aborted) throw abortError()
      if (controller.signal.aborted) throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.TIMEOUT, `adapter ${adapterId} exceeded ${timeoutMs}ms`)
      const structured = errorFromUnknown(error, { code: 'CONTEXT_ADAPTER_OPERATION_FAILED', category: 'internal', message: error instanceof Error ? error.message : String(error), retryable: true })
      record.errors.push(structured)
      throw new ContextAdapterRegistryError(structured.code as ContextAdapterRegistryErrorCode, structured.message, structured.details)
    }
    finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      callerSignal?.removeEventListener('abort', onAbort)
      record.operations.delete(inFlightOperation)
      record.inFlight -= 1
      if (record.inFlight === 0) {
        for (const resolve of record.drainWaiters) resolve()
        record.drainWaiters.clear()
        if (record.state === ('draining' as AdapterRecord['state']) && !record.drainPromise) void this.finalizeDrain(record, record.drainingReason ?? 'unregistered')
      }
    }
  }

  async health(adapterId: string, generation?: number): Promise<ContextAdapterHealth> {
    const record = this.resolve(adapterId, generation)
    try {
      const result = typeof record.adapter.health === 'function' ? await record.adapter.health() : record.adapter.health
      const health = normalizeAdapterHealth(result)
      record.adapter.health = health
      if (health.status === 'unhealthy') record.state = 'failed'
      return health
    }
    catch (error) {
      const health: ContextAdapterHealth = { status: 'unhealthy', checkedAt: now(), message: error instanceof Error ? error.message : String(error) }
      record.adapter.health = health
      record.state = 'failed'
      throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.HEALTH_UNAVAILABLE, health.message!, { adapterId })
    }
  }

  async drain(adapterId: string, generation?: number): Promise<ContextAdapterDrainResult> {
    const record = this.resolve(adapterId, generation)
    if (record.state === 'ready') {
      record.state = 'draining'
      record.drainingAt = now()
    }
    await this.finalizeDrain(record, 'unregistered')
    if (record.state === 'failed' && record.errors.some(error => error.code === CONTEXT_ADAPTER_ERROR_CODES.DRAIN_TIMEOUT)) {
      throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.DRAIN_TIMEOUT, `adapter ${adapterId} drain exceeded ${DRAIN_TIMEOUT_MS}ms`)
    }
    return this.drainResult(record)
  }

  retire(adapterId: string, version?: string): ContextAdapterRetireResult[] {
    const records = this.findRecords(adapterId, version)
    if (records.length === 0) throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.NOT_FOUND, `adapter ${adapterId} is not registered`)
    return records.map((record) => {
      if (record.state === 'ready') {
        record.state = 'draining'
        record.drainingAt = now()
        record.drainingReason = 'unregistered'
      }
      void this.finalizeDrain(record, 'unregistered')
      return { ok: true, adapterId, generation: record.adapter.generation, state: record.state, inFlight: record.inFlight, retired: record.state === 'retired' }
    })
  }

  list(options: { includeDraining?: boolean, includeRetired?: boolean, includeFailed?: boolean } = {}): ContextAdapterSummary[] {
    return [...this.records.values()]
      .filter(record => record.state === 'ready' || (record.state === 'draining' && options.includeDraining) || (record.state === 'retired' && options.includeRetired) || (record.state === 'failed' && options.includeFailed))
      .map(record => this.summary(record))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const records = [...this.records.values()]
    for (const record of records) {
      record.state = 'draining'
      record.drainingAt ??= now()
    }
    await Promise.all(records.map(record => this.finalizeDrain(record, 'registry-disposed')))
    const timedOut = records.find(record => record.errors.some(error => error.code === CONTEXT_ADAPTER_ERROR_CODES.DRAIN_TIMEOUT))
    if (timedOut) throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.DRAIN_TIMEOUT, `adapter ${timedOut.adapter.adapterId} drain exceeded ${DRAIN_TIMEOUT_MS}ms`)
  }

  private resolve(adapterId: string, generation?: number): AdapterRecord {
    const activeKey = this.active.get(adapterId)
    const record = activeKey ? this.records.get(activeKey) : undefined
    if (!record) throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.NOT_FOUND, `adapter ${adapterId} is not registered`)
    if (generation !== undefined && generation !== record.adapter.generation) throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.GENERATION_STALE, `adapter ${adapterId} generation ${generation} is not active`)
    return record
  }

  private findRecords(adapterId: string, version?: string): AdapterRecord[] {
    return [...this.records.values()].filter(record => record.adapter.adapterId === adapterId && (version === undefined || record.adapter.version === version))
  }

  private async finalizeDrain(record: AdapterRecord, reason: 'replaced' | 'unregistered' | 'registry-disposed'): Promise<void> {
    if (record.drainPromise) {
      await record.drainPromise
      return
    }
    record.drainPromise = (async () => {
      if (record.inFlight > 0) {
        const completed = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)
          record.drainWaiters.add(() => {
            clearTimeout(timer)
            resolve(true)
          })
        })
        if (!completed) {
          for (const operation of record.operations) {
            operation.controller.abort(new Error('adapter drain timeout'))
            operation.reject(new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.DRAIN_TIMEOUT, `adapter ${record.adapter.adapterId} drain exceeded ${DRAIN_TIMEOUT_MS}ms`))
          }
          record.state = 'failed'
          record.errors.push({ code: CONTEXT_ADAPTER_ERROR_CODES.DRAIN_TIMEOUT, category: 'lifecycle', message: `adapter ${record.adapter.adapterId} drain exceeded ${DRAIN_TIMEOUT_MS}ms`, retryable: false })
          return false
        }
      }
      const context = { adapterId: record.adapter.adapterId, version: record.adapter.version, generation: record.adapter.generation, reason, inFlight: record.inFlight, signal: new AbortController().signal } as const
      try {
        await record.adapter.drain(context)
        await record.adapter.retire(context)
        await record.adapter.owner.dispose({ ...context, reason: 'owner-disposed' })
        record.state = 'retired'
        record.retiredAt = now()
        const activeKey = this.active.get(record.adapter.adapterId)
        const activeRecord = activeKey ? this.records.get(activeKey) : undefined
        if (activeRecord === record) this.active.delete(record.adapter.adapterId)
        return true
      }
      catch (error) {
        record.state = 'failed'
        record.errors.push(errorFromUnknown(error, { code: CONTEXT_ADAPTER_ERROR_CODES.OWNER_DISPOSE_FAILED, category: 'lifecycle', message: error instanceof Error ? error.message : String(error), retryable: false }))
        return false
      }
    })()
    await record.drainPromise
  }

  private drainResult(record: AdapterRecord): ContextAdapterDrainResult {
    return { ok: true, adapterId: record.adapter.adapterId, generation: record.adapter.generation, state: record.state, inFlight: record.inFlight, retired: record.state === 'retired' }
  }

  private summary(record: AdapterRecord): ContextAdapterSummary {
    const health = typeof record.adapter.health === 'function' ? { status: 'unknown' as const } : record.adapter.health
    return { adapterId: record.adapter.adapterId, apiVersion: record.adapter.apiVersion, version: record.adapter.version, generation: record.adapter.generation, capabilities: record.adapter.capabilities, sideEffect: record.adapter.sideEffect, health, timeout: record.adapter.timeout, ownerId: record.adapter.owner.ownerId, state: record.state, inFlight: record.inFlight, registeredAt: record.registeredAt, ...(record.drainingAt ? { drainingAt: record.drainingAt } : {}), ...(record.retiredAt ? { retiredAt: record.retiredAt } : {}), errors: record.errors }
  }

  private ensureOpen(): void {
    if (this.disposed) throw new ContextAdapterRegistryError(CONTEXT_ADAPTER_ERROR_CODES.NOT_READY, 'adapter registry is disposed')
  }
}

export function createContextAdapterRegistry(): ContextAdapterRegistry {
  return new ContextAdapterRegistry()
}

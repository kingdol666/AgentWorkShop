import type { ContextRef, ContextScope, ProvenanceRef } from '@/shared/context/contracts'
import { canonicalHash } from '@/shared/context/hash'
import { refKey } from '@/shared/context/refs'

export const RSI_READ_ADAPTER_API_VERSION = 'rsi-read-adapter.v1' as const
export const RSI_READ_ADAPTER_CAPABILITY = 'read' as const

export type RsiSourceType = 'memory' | 'experience' | 'project' | 'ontology' | 'analysis'
export type RsiSourceStatus = 'active' | 'candidate' | 'validated' | 'contested' | 'published' | 'draft' | 'retired' | 'revoked' | 'stale' | 'rejected' | 'conflicted'

export const RSI_SOURCE_STATUSES: readonly RsiSourceStatus[] = [
  'active', 'candidate', 'validated', 'contested', 'published', 'draft',
  'retired', 'revoked', 'stale', 'rejected', 'conflicted',
]

export interface RsiSourceMetadata {
  sourceType: RsiSourceType
  sourceId: string
  sourceVersion: string
  scope: ContextScope
  provenance: readonly ProvenanceRef[]
  status: RsiSourceStatus
  capturedAt: string
  /** Optional freshness boundary. A source is stale when now >= staleAt. */
  staleAt?: string
  /** Source revision that this read was derived from. */
  sourceRevision?: string
  /** Stable content digest supplied by the source reader. */
  contentHash?: string
}

export interface RsiSourceRecord<TSource = unknown> {
  metadata: RsiSourceMetadata
  payload: TSource
}

export interface RsiReadRecord<TPayload = unknown> {
  metadata: RsiSourceMetadata
  payload: TPayload
}

export interface RsiReadRequest {
  scope: ContextScope
  refs?: readonly ContextRef[]
  now?: string
  limit?: number
}

export interface RsiReadFailure {
  code:
    | 'RSI_READ_INVALID_REQUEST'
    | 'RSI_READ_SCOPE_MISMATCH'
    | 'RSI_READ_MISSING_METADATA'
    | 'RSI_READ_STALE'
    | 'RSI_READ_REVOKED'
    | 'RSI_READ_CONFLICT'
    | 'RSI_READ_INVALID_PROVENANCE'
    | 'RSI_READ_INVALID_VERSION'
    | 'RSI_READ_SOURCE_UNAVAILABLE'
  sourceType: RsiSourceType
  sourceId?: string
  message: string
}

export class RsiReadAdapterError extends Error {
  readonly failure: RsiReadFailure

  constructor(failure: RsiReadFailure) {
    super(failure.message)
    this.name = 'RsiReadAdapterError'
    this.failure = failure
  }
}

export type RsiReadResult<TPayload>
  = | { ok: true, records: readonly RsiReadRecord<TPayload>[] }
    | { ok: false, error: RsiReadFailure }

export type RsiReaderFunction<TSource> = (request: RsiReadRequest) => TSource | readonly TSource[] | Promise<TSource | readonly TSource[]>

export interface RsiSourceReader<TSource> {
  read(request: RsiReadRequest): TSource | readonly TSource[] | Promise<TSource | readonly TSource[]>
}

export interface RsiReadAdapter<TSource = unknown, TPayload = TSource> {
  readonly apiVersion: typeof RSI_READ_ADAPTER_API_VERSION
  readonly sourceType: RsiSourceType
  readonly version: string
  read(request: RsiReadRequest): Promise<RsiReadResult<TPayload>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function sameScopeValue(expected: string | undefined, actual: string | undefined): boolean {
  return expected === actual
}

function sameRefSet(expected: readonly ContextRef[] | undefined, actual: readonly ContextRef[] | undefined): boolean {
  if (expected === undefined) return true
  if (actual === undefined) return false
  const actualKeys = new Set(actual.map(refKey))
  return expected.every(ref => actualKeys.has(refKey(ref)))
}

function scopeRefs(scope: ContextScope): readonly ContextRef[] {
  return [
    ...(scope.subjectRefs ?? []),
    ...(scope.objectRefs ?? []),
    ...(scope.attributeRefs ?? []),
    ...(scope.materialAssignmentRefs ?? []),
  ]
}

export function scopeContains(container: ContextScope, requested: ContextScope, requestedRefs: readonly ContextRef[] = []): boolean {
  if (!sameScopeValue(container.tenantId, requested.tenantId)) return false
  if (!sameScopeValue(container.workspaceId, requested.workspaceId)) return false
  if (!sameRefSet(container.subjectRefs, requested.subjectRefs)) return false
  if (!sameRefSet(container.objectRefs, requested.objectRefs)) return false
  if (!sameRefSet(container.attributeRefs, requested.attributeRefs)) return false
  if (!sameRefSet(container.materialAssignmentRefs, requested.materialAssignmentRefs)) return false
  const availableRefs = new Set(scopeRefs(container).map(refKey))
  if (requestedRefs.some(ref => !availableRefs.has(refKey(ref)))) return false
  if (requested.tags !== undefined) {
    const tags = new Set(container.tags ?? [])
    if (!requested.tags.every(tag => tags.has(tag))) return false
  }
  if (requested.timeWindow) {
    if (!container.timeWindow) return false
    if (Date.parse(container.timeWindow.from) > Date.parse(requested.timeWindow.from)) return false
    if (Date.parse(container.timeWindow.to) < Date.parse(requested.timeWindow.to)) return false
  }
  return true
}

export function normalizeReadRequest(request: RsiReadRequest, sourceType: RsiSourceType): Required<Pick<RsiReadRequest, 'scope' | 'now' | 'limit'>> & Pick<RsiReadRequest, 'refs'> {
  if (!isRecord(request) || !isRecord(request.scope)) {
    throw new RsiReadAdapterError({ code: 'RSI_READ_INVALID_REQUEST', sourceType, message: 'read request scope is required' })
  }
  const now = request.now ?? new Date().toISOString()
  if (!nonEmpty(now) || !Number.isFinite(Date.parse(now))) {
    throw new RsiReadAdapterError({ code: 'RSI_READ_INVALID_REQUEST', sourceType, message: 'read request now must be an ISO timestamp' })
  }
  const limit = request.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RsiReadAdapterError({ code: 'RSI_READ_INVALID_REQUEST', sourceType, message: 'read request limit must be an integer between 1 and 500' })
  }
  return { scope: request.scope, refs: request.refs, now, limit }
}

export function validateSourceMetadata(metadata: unknown, expectedType: RsiSourceType, request: RsiReadRequest): RsiSourceMetadata {
  if (!isRecord(metadata)) {
    throw new RsiReadAdapterError({ code: 'RSI_READ_MISSING_METADATA', sourceType: expectedType, message: 'source metadata is required' })
  }
  if (metadata.sourceType !== expectedType) {
    throw new RsiReadAdapterError({ code: 'RSI_READ_CONFLICT', sourceType: expectedType, sourceId: nonEmpty(metadata.sourceId) ? metadata.sourceId : undefined, message: `source type conflict: expected ${expectedType}` })
  }
  if (!nonEmpty(metadata.sourceId) || !nonEmpty(metadata.sourceVersion)) {
    throw new RsiReadAdapterError({ code: 'RSI_READ_MISSING_METADATA', sourceType: expectedType, message: 'sourceId and sourceVersion are required' })
  }
  if (!RsiSourceStatusGuard(metadata.status)) {
    throw new RsiReadAdapterError({ code: 'RSI_READ_INVALID_VERSION', sourceType: expectedType, sourceId: metadata.sourceId, message: 'source status is unsupported' })
  }
  if (!isRecord(metadata.scope) || !scopeContains(metadata.scope as ContextScope, request.scope, request.refs ?? [])) {
    throw new RsiReadAdapterError({ code: 'RSI_READ_SCOPE_MISMATCH', sourceType: expectedType, sourceId: metadata.sourceId, message: 'source scope does not contain requested scope' })
  }
  if (!Array.isArray(metadata.provenance) || metadata.provenance.length === 0 || metadata.provenance.some(item => !isRecord(item) || !nonEmpty(item.adapterId) || !nonEmpty(item.sourceRef))) {
    throw new RsiReadAdapterError({ code: 'RSI_READ_INVALID_PROVENANCE', sourceType: expectedType, sourceId: metadata.sourceId, message: 'source provenance must include adapterId and sourceRef' })
  }
  if (!nonEmpty(metadata.capturedAt) || !Number.isFinite(Date.parse(metadata.capturedAt))) {
    throw new RsiReadAdapterError({ code: 'RSI_READ_MISSING_METADATA', sourceType: expectedType, sourceId: metadata.sourceId, message: 'capturedAt is required' })
  }
  if (metadata.contentHash !== undefined && (!nonEmpty(metadata.contentHash) || !/^[a-f0-9]{64}$/i.test(metadata.contentHash))) {
    throw new RsiReadAdapterError({ code: 'RSI_READ_INVALID_VERSION', sourceType: expectedType, sourceId: metadata.sourceId, message: 'contentHash must be a SHA-256 digest' })
  }
  if (metadata.status === 'revoked') {
    throw new RsiReadAdapterError({ code: 'RSI_READ_REVOKED', sourceType: expectedType, sourceId: metadata.sourceId, message: 'revoked source cannot be read' })
  }
  if (metadata.status === 'conflicted') {
    throw new RsiReadAdapterError({ code: 'RSI_READ_CONFLICT', sourceType: expectedType, sourceId: metadata.sourceId, message: 'conflicted source cannot be read' })
  }
  if (metadata.status === 'stale' || (nonEmpty(metadata.staleAt) && Date.parse(metadata.staleAt) <= Date.parse(request.now ?? new Date().toISOString()))) {
    throw new RsiReadAdapterError({ code: 'RSI_READ_STALE', sourceType: expectedType, sourceId: metadata.sourceId, message: 'stale source cannot be read' })
  }
  return metadata as unknown as RsiSourceMetadata
}

function RsiSourceStatusGuard(value: unknown): value is RsiSourceStatus {
  return typeof value === 'string' && RSI_SOURCE_STATUSES.includes(value as RsiSourceStatus)
}

function assertNoConflictingRecords<TSource>(records: readonly RsiSourceRecord<TSource>[], sourceType: RsiSourceType): void {
  const seen = new Map<string, { revision: string, payloadHash: string, contentHash?: string }>()
  for (const record of records) {
    const key = `${record.metadata.sourceId}\u0000${record.metadata.sourceVersion}`
    const value = {
      revision: record.metadata.sourceRevision ?? '',
      payloadHash: canonicalHash(record.payload),
      contentHash: record.metadata.contentHash,
    }
    const previous = seen.get(key)
    if (previous && (previous.revision !== value.revision || previous.payloadHash !== value.payloadHash || previous.contentHash !== value.contentHash)) {
      throw new RsiReadAdapterError({ code: 'RSI_READ_CONFLICT', sourceType, sourceId: record.metadata.sourceId, message: 'reader returned conflicting records for the same source version' })
    }
    seen.set(key, value)
  }
}

export function toReadResult<TSource, TPayload>(sourceType: RsiSourceType, request: RsiReadRequest, values: unknown, mapPayload: (value: TSource) => TPayload): RsiReadResult<TPayload> {
  try {
    const normalized = normalizeReadRequest(request, sourceType)
    const candidates = (Array.isArray(values) ? values : [values]) as unknown[]
    const sourceRecords = candidates.map((value) => {
      if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'metadata') || !Object.prototype.hasOwnProperty.call(value, 'payload')) {
        throw new RsiReadAdapterError({ code: 'RSI_READ_MISSING_METADATA', sourceType, message: 'reader returned a record without metadata or payload' })
      }
      const metadata = validateSourceMetadata(value.metadata, sourceType, normalized)
      return { metadata, payload: value.payload as TSource }
    })
    assertNoConflictingRecords(sourceRecords, sourceType)
    return { ok: true, records: sourceRecords.slice(0, normalized.limit).map(record => ({ metadata: record.metadata, payload: mapPayload(record.payload) })) }
  }
  catch (error) {
    if (error instanceof RsiReadAdapterError) return { ok: false, error: error.failure }
    return { ok: false, error: { code: 'RSI_READ_SOURCE_UNAVAILABLE', sourceType, message: error instanceof Error ? error.message : String(error) } }
  }
}

export function asReaderFunction<TSource>(reader: RsiSourceReader<TSource> | RsiReaderFunction<TSource>): RsiReaderFunction<TSource> {
  return typeof reader === 'function' ? reader : request => reader.read(request)
}

export function createReadOnlyAdapter<TSource, TPayload = TSource>(options: {
  sourceType: RsiSourceType
  version: string
  reader: RsiSourceReader<RsiSourceRecord<TSource>> | RsiReaderFunction<RsiSourceRecord<TSource>>
  mapPayload?: (source: TSource) => TPayload
}): RsiReadAdapter<TSource, TPayload> {
  const readSource = asReaderFunction(options.reader)
  const mapPayload = options.mapPayload ?? ((source: TSource) => source as unknown as TPayload)
  return {
    apiVersion: RSI_READ_ADAPTER_API_VERSION,
    sourceType: options.sourceType,
    version: options.version,
    async read(request): Promise<RsiReadResult<TPayload>> {
      try {
        const values = await readSource(request)
        return toReadResult(options.sourceType, request, values, mapPayload)
      }
      catch (error) {
        return {
          ok: false,
          error: {
            code: 'RSI_READ_SOURCE_UNAVAILABLE',
            sourceType: options.sourceType,
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    },
  }
}

export function assertReadOnlyAdapter(adapter: RsiReadAdapter): void {
  if (adapter.apiVersion !== RSI_READ_ADAPTER_API_VERSION) throw new Error('unsupported RSI read adapter API version')
}

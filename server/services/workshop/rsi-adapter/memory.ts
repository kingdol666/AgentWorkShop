import type { MemoryRow } from '../db/database'
import {
  createReadOnlyAdapter,
  type RsiReadAdapter,
  type RsiReaderFunction,
  type RsiSourceReader,
  type RsiSourceRecord,
} from './contracts'

export type MemorySourceRecord = RsiSourceRecord<MemoryRow>
export type MemoryReader = RsiSourceReader<MemorySourceRecord> | RsiReaderFunction<MemorySourceRecord>

export interface MemoryReadPayload {
  id: string
  kind: MemoryRow['kind']
  title: string
  content: string
  importance: number
  createdAt: string
  taskId: string | null
  sessionId: string
  outcome?: MemoryRow['outcome']
  evidenceJson?: string
  scopeKind?: MemoryRow['scopeKind']
  scopeKey?: string
  status?: MemoryRow['status']
  expiresAt?: string | null
}

function toMemoryPayload(row: MemoryRow): MemoryReadPayload {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    importance: row.importance,
    createdAt: row.createdAt,
    taskId: row.taskId,
    sessionId: row.sessionId,
    ...(row.outcome === undefined ? {} : { outcome: row.outcome }),
    ...(row.evidenceJson === undefined ? {} : { evidenceJson: row.evidenceJson }),
    ...(row.scopeKind === undefined ? {} : { scopeKind: row.scopeKind }),
    ...(row.scopeKey === undefined ? {} : { scopeKey: row.scopeKey }),
    ...(row.status === undefined ? {} : { status: row.status }),
    ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
  }
}

export function createMemoryReadAdapter(options: {
  reader: MemoryReader
  version?: string
}): RsiReadAdapter<MemoryRow, MemoryReadPayload> {
  return createReadOnlyAdapter({
    sourceType: 'memory',
    version: options.version ?? '1.0.0',
    reader: options.reader,
    mapPayload: toMemoryPayload,
  })
}

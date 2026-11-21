import type { MemoryRow } from '../db/database'
import { createMemoryReadAdapter, type MemoryReader } from './memory'

export function createExperienceReadAdapter(options: {
  reader: MemoryReader
  version?: string
}) {
  return createMemoryReadAdapter({
    reader: async (request) => {
      const values = await (typeof options.reader === 'function' ? options.reader(request) : options.reader.read(request))
      const rows = Array.isArray(values) ? values : [values]
      return rows.filter(record => record.payload.kind === 'experience')
    },
    version: options.version ?? '1.0.0',
  })
}

export type ExperienceSourceRecord = { metadata: unknown, payload: MemoryRow }

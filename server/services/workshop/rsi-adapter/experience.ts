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
      // Task 4:RSI 经验读取面只暴露已验证条目;候选与 legacy-unverified 仅供人审(review),
      // 不获得读用许可。部署状态由记忆读取面的作用域闸判定。
      return rows.filter(record => record.payload.kind === 'experience' && record.payload.status === 'validated')
    },
    version: options.version ?? '1.0.0',
  })
}

export type ExperienceSourceRecord = { metadata: unknown, payload: MemoryRow }

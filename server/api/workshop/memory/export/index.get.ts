/**
 * GET /api/workshop/memory/export?channelId=&sessionId= —— 按 scope 导出 JSONL（批次 L）。
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { exportMemoryJsonl } from '@/server/services/workshop/memory/export'
import { requireMemoryUser } from '@/server/services/workshop/memory/memory-access'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const q = getQuery(event)
  const channelId = typeof q.channelId === 'string' ? q.channelId : ''
  if (!channelId) throw new AppError(422, 'CHANNEL_REQUIRED', 'channelId 必填')
  if (user.role !== 'admin') {
    const row = getAmlRuntime().db.prepare('SELECT owner_user_id AS owner FROM channels WHERE id = ?').get(channelId) as { owner?: string | null } | undefined
    if (!row || row.owner !== user.id) throw new AppError(403, 'FORBIDDEN', '仅频道 owner/管理员可导出')
  }
  const jsonl = exportMemoryJsonl(getAmlRuntime().db, {
    channelId,
    sessionId: typeof q.sessionId === 'string' ? q.sessionId : null,
    includeDeleted: q.includeDeleted === '1',
  })
  return { jsonl, bytes: Buffer.byteLength(jsonl, 'utf8') }
})

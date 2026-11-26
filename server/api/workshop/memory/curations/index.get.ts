/**
 * GET /api/workshop/memory/curations —— Curator 知识手册列表（批次 E，只读）。
 * 权限：admin 全部；其他用户仅自己 owner 的频道（与 /memory 列表同口径）。
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { listCurations } from '@/server/services/workshop/memory/curator'
import { requireMemoryUser } from '@/server/services/workshop/memory/memory-access'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const q = getQuery(event)
  const db = getAmlRuntime().db
  let channelIds: string[] | undefined
  if (user.role !== 'admin') {
    const rows = db.prepare('SELECT id FROM channels WHERE owner_user_id = ?').all(user.id) as Array<{ id: string }>
    channelIds = rows.map(r => r.id)
  }
  return {
    items: listCurations(db, {
      channelIds,
      limit: Number(q.limit ?? 50),
    }),
  }
})

/**
 * GET /api/workshop/memory/curations —— Curator 知识手册列表（批次 E，只读）。
 * 注：Nuxt 扫描器在 curations/ 目录同时存在 [id].get.ts 与 [id]/ 时不会产出
 * curations/index.get 路由，因此这里用同级 curations.get.ts 承担列表入口。
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

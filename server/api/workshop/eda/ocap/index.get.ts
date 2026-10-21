/**
 * GET /api/workshop/eda/ocap?status=open —— OCAP 处置单清单(开单走 index.post.ts)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { listOcap } from '@/server/services/workshop/eda/ocap'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  return { records: listOcap(user, { status: q.status ? String(q.status) : undefined, limit: Number(q.limit) || 100 }) }
})

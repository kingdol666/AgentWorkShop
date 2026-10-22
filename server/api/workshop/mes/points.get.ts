/**
 * GET /api/workshop/mes/points —— MES 调试台点位目录(用户面)。
 * 可见性 = 可读产线(readonly+)上的 mes-rest 节点;跨线与孤儿点位不可见。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { visibleMesNodesForUser } from '@/server/services/workshop/eda/mes-console'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const points = visibleMesNodesForUser(user)
  return { points, count: points.length }
})

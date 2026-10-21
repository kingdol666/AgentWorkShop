/**
 * GET /api/workshop/eda/golden —— golden 参考轨迹清单(query: recipe_id?)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { listGolden } from '@/server/services/workshop/eda/golden'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  const all = listGolden(q.recipe_id ? String(q.recipe_id) : undefined)
  // 摘要面:profile 体积大,列表只回元数据+指纹(画像走单条 GET?——前端叠加时经 recipe+node 取单条)
  return {
    golden: all.map(g => ({
      id: g.id, recipeId: g.recipeId, nodeId: g.nodeId, sourceRunId: g.sourceRunId,
      nBins: g.nBins, fingerprint: g.fingerprint, createdBy: g.createdBy, createdAt: g.createdAt,
    })),
    count: all.length,
  }
})

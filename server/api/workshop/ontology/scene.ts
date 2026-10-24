/**
 * GET /api/workshop/ontology/scene?lineId= — 运行时语义子图(绑定面实体 + 关系 + 规则决策 + 守卫)
 * GET /api/workshop/ontology/scene?lineId=&guards=1&values=... — 附运行时守卫求值
 *
 * 这是 Agent 上下文与 MCP 只读工具的共同数据面;只读、只回已发布版本。
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { sceneSubgraph } from '@/server/services/workshop/ontology/ontology.service'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const query = getQuery(event)
  const lineId = typeof query.lineId === 'string' ? query.lineId : ''
  if (!lineId) throw new AppError(422, 'LINE_REQUIRED', 'lineId 必填')
  const graph = sceneSubgraph(lineId, { limit: query.limit !== undefined ? Math.min(500, Math.max(1, Number(query.limit))) : 200 })
  if (!graph) return { lineId, active: false, graph: null }
  return { lineId, active: true, graph }
})

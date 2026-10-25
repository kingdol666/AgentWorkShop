/**
 * GET /api/workshop/ontology/scene?lineId= — 运行时语义子图(绑定面实体 + 关系 + 规则决策 + 守卫)
 * GET /api/workshop/ontology/scene?lineId=&entity=&hops=&direction=&kinds=&limit= — 以实体为中心的邻接/多跳子图
 *
 * 这是 Agent 上下文与 MCP 只读工具的共同数据面;只读、只回已发布版本。
 * 两个模式互不干扰:未给 entity 时行为与历史完全一致(全图);给了 entity 才走子图并校验新参数。
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { sceneSubgraph } from '@/server/services/workshop/ontology/ontology.service'
import { parseSubgraphOptions } from '@/server/services/workshop/ontology/subgraph.core'
import { requireEntityKey, subgraphAroundForLine } from '@/server/services/workshop/ontology/subgraph.service'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const query = getQuery(event)
  const lineId = typeof query.lineId === 'string' ? query.lineId : ''
  if (!lineId) throw new AppError(422, 'LINE_REQUIRED', 'lineId 必填')

  // 子图模式:仅显式给出 entity 时启用,旧调用零漂移
  if (query.entity !== undefined) {
    const entityKey = requireEntityKey(query.entity)
    const opts = parseSubgraphOptions(query)
    const subgraph = subgraphAroundForLine(lineId, entityKey, opts)
    if (!subgraph) return { lineId, active: false, subgraph: null }
    return { lineId, active: true, subgraph }
  }

  const graph = sceneSubgraph(lineId, { limit: query.limit !== undefined ? Math.min(500, Math.max(1, Number(query.limit))) : 200 })
  if (!graph) return { lineId, active: false, graph: null }
  return { lineId, active: true, graph }
})

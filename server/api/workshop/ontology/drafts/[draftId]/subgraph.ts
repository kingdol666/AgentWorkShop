/**
 * GET /api/workshop/ontology/drafts/:draftId/subgraph?entity=&hops=&direction=&kinds=&limit=
 *
 * 草稿子图(供 /ontology 页面:图、表格与抽屉同源,不会出现「图画草稿、抽屉查已发布」的错位)。
 * 只读;沿用草稿的属主/管理员访问规则(getDraftDetail 内部裁决)。
 */
import { getQuery, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { actorFromUser, getDraftDetail } from '@/server/services/workshop/ontology/ontology.service'
import { parseSubgraphOptions } from '@/server/services/workshop/ontology/subgraph.core'
import { requireEntityKey, subgraphAroundDoc } from '@/server/services/workshop/ontology/subgraph.service'

export default defineApiHandler(async (event) => {
  const draftId = getRouterParam(event, 'draftId') ?? ''
  if (!draftId) throw new AppError(422, 'DRAFT_ID_REQUIRED', 'draftId 缺失')
  const user = resolveUser(event)
  const query = getQuery(event)
  const entityKey = requireEntityKey(query.entity)
  const opts = parseSubgraphOptions(query)
  const detail = getDraftDetail(draftId, actorFromUser(user))
  return { draftId, subgraph: subgraphAroundDoc(detail.doc, entityKey, opts) }
})

/**
 * GET /api/workshop/harnesses/[id]/providers —— 该 harness 已配置的 LLM provider/model 目录。
 * 数据源:各引擎官方目录面(omp models list / codex model/list / opencode models /
 * dsh 内置目录 + settings.yaml),5 分钟缓存。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { harnessModelCatalog } from '@/server/services/workshop/agents/harness-models'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const catalog = await harnessModelCatalog(id)
  return { catalog }
})

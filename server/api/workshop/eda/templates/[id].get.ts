/**
 * GET /api/workshop/eda/templates/:id —— 模板详情(owner/admin)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { templateById } from '@/server/services/workshop/eda/template-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = String(getRouterParam(event, 'id') ?? '')
  const template = templateById(user, id)
  if (!template) return { template: null }
  return { template }
})

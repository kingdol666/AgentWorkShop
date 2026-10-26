/**
 * DELETE /api/workshop/eda/templates/:id —— 删除模板(owner/admin)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { deleteTemplate } from '@/server/services/workshop/eda/template-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = String(getRouterParam(event, 'id') ?? '')
  deleteTemplate(user, id)
  return { deleted: id }
})

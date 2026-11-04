/**
 * GET /api/workshop/projects —— owner/admin 可见项目列表。
 */
import { defineApiHandler } from '../../../utils/response'
import { resolveUser } from '../caller'
import { getProjectService } from '../../../services/workshop/projects/service'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getProjectService().list(user)
})

/** DELETE /api/workshop/optimization/bindings/:id —— 撤权(立即生效,执行侧旧调用即拒)。 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { revokeBindingForUser } from '@/server/services/workshop/optimization/rest-auth'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const id = getRouterParam(event, 'id') ?? ''
  revokeBindingForUser(user, id)
  return { revoked: true }
})

import { getRouterParam } from 'h3'
import { resolveUserPrincipal } from '../../../utils/user-principal'
import { userService } from '../../../services/user.service'
import { defineApiHandler } from '../../../utils/response'

/** DELETE /api/users/tokens/:id —— 吊销当前用户某 token */
export default defineApiHandler((event) => {
  const { user } = resolveUserPrincipal(event)
  const id = getRouterParam(event, 'id') ?? ''
  return userService.revokeToken(user.id, id)
})

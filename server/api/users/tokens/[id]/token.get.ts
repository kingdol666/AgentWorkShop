import { getRouterParam } from 'h3'
import { resolveUserPrincipal } from '../../../../utils/user-principal'
import { userService } from '../../../../services/user.service'
import { defineApiHandler } from '../../../../utils/response'

/** GET /api/users/tokens/:id/token —— 查看当前用户某 token 的存档明文 */
export default defineApiHandler((event) => {
  const { user } = resolveUserPrincipal(event)
  const id = getRouterParam(event, 'id') ?? ''
  return { token: userService.revealToken(user.id, id) }
})

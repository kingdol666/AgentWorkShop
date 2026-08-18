import { getRouterParam } from 'h3'
import { extractBearerToken } from '../../../utils/auth'
import { userService } from '../../../services/user.service'
import { defineApiHandler } from '../../../utils/response'

/** DELETE /api/users/tokens/:id —— 吊销当前用户某 token */
export default defineApiHandler((event) => {
  const token = extractBearerToken(event)
  const id = getRouterParam(event, 'id') ?? ''
  return userService.revokeToken(userService.me(token).id, id)
})

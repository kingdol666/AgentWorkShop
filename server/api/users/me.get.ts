import { extractBearerToken } from '../../utils/auth'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'

/** GET /api/users/me —— 当前用户信息（Bearer token） */
export default defineApiHandler((event) => {
  const token = extractBearerToken(event)
  return userService.me(token)
})

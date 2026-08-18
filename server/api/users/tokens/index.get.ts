import { extractBearerToken } from '../../../utils/auth'
import { userService } from '../../../services/user.service'
import { defineApiHandler } from '../../../utils/response'

/** GET /api/users/tokens —— 当前用户 token 列表（仅元数据，不含明文） */
export default defineApiHandler((event) => {
  const token = extractBearerToken(event)
  return userService.listTokens(userService.me(token).id)
})

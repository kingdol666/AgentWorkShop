import { extractBearerToken } from '../../utils/auth'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'

/** POST /api/users/logout —— 吊销当前使用的 token（仅该 token 失效） */
export default defineApiHandler((event) => {
  const token = extractBearerToken(event)
  return userService.logout(token)
})

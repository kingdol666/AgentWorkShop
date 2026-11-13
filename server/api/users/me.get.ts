import { getRequestHeader } from 'h3'
import { resolveBrowserSessionFromEvent } from '../../services/auth/browser-session'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'
import { AppError } from '../../utils/errors'

/** GET /api/users/me —— 当前用户信息（Bearer 或 HttpOnly 浏览器会话） */
export default defineApiHandler((event) => {
  const auth = getRequestHeader(event, 'authorization')
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (bearer) return userService.me(bearer)
  const session = resolveBrowserSessionFromEvent(event)
  if (!session) throw new AppError(401, 'UNAUTHORIZED', '用户会话无效或已过期')
  return userService.browserSessionUser(session.id)
})

import { defineApiHandler } from '../../utils/response'
import { userService } from '../../services/user.service'
import { resolveBrowserSessionFromEvent } from '../../services/auth/browser-session'

/** GET /api/users/session —— 恢复 HttpOnly 浏览器会话，不返回任何 Bearer token。 */
export default defineApiHandler((event) => {
  const session = resolveBrowserSessionFromEvent(event)
  return { user: session ? userService.browserSessionUser(session.id) : null }
})

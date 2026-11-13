import { getCookie, deleteCookie } from 'h3'
import { defineApiHandler } from '../../utils/response'
import { resolveUserPrincipal } from '../../utils/user-principal'
import { revokeBrowserSession, sessionCookieName } from '../../services/auth/browser-session'
import { userService } from '../../services/user.service'

/** POST /api/users/logout —— 吊销当前浏览器会话；Bearer 兼容客户端继续吊销 token。 */
export default defineApiHandler((event) => {
  const credential = getCookie(event, sessionCookieName())
  if (credential) {
    revokeBrowserSession(credential)
    deleteCookie(event, sessionCookieName(), { path: '/' })
    return { ok: true }
  }
  const { bearer } = resolveUserPrincipal(event)
  return bearer ? userService.logout(bearer) : { ok: true }
})

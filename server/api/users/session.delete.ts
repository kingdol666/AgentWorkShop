import { deleteCookie, getCookie } from 'h3'
import { defineApiHandler } from '../../utils/response'
import { revokeBrowserSession, sessionCookieName } from '../../services/auth/browser-session'

/** DELETE /api/users/session —— 吊销当前浏览器会话并清除 cookie。 */
export default defineApiHandler((event) => {
  const credential = getCookie(event, sessionCookieName())
  if (credential) revokeBrowserSession(credential)
  deleteCookie(event, sessionCookieName(), { path: '/' })
  return { ok: true }
})

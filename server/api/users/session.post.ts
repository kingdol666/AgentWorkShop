import { setCookie, type H3Event } from 'h3'
import { defineApiHandler } from '../../utils/response'
import { resolveUserByToken, userService } from '../../services/user.service'
import { issueBrowserSession, sessionCookieName, sessionCookieOptions } from '../../services/auth/browser-session'
import { AppError } from '../../utils/errors'
import { extractBearerToken } from '../../utils/auth'

function secureCookie(event: H3Event): boolean {
  const forwarded = event.node?.req?.headers['x-forwarded-proto']
  return forwarded === 'https'
}

/** POST /api/users/session —— 将现有 Bearer 登录态换为 HttpOnly 浏览器会话。 */
export default defineApiHandler((event) => {
  const bearer = (() => {
    try {
      return extractBearerToken(event)
    }
    catch {
      return ''
    }
  })()
  const user = bearer ? resolveUserByToken(bearer) : null
  if (!user) throw new AppError(401, 'UNAUTHORIZED', '需要有效的用户 token 才能建立浏览器会话')
  const { credential, session } = issueBrowserSession(user.id)
  setCookie(event, sessionCookieName(), credential, sessionCookieOptions(secureCookie(event)))
  return { user: userService.browserSessionUser(user.id), expiresAt: session.expiresAt }
})

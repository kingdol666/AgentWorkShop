import { readValidatedBody, setCookie, type H3Event } from 'h3'
import { userLoginSchema, type UserLogin } from '../../schemas/user.schema'
import { userService, resolveUserByToken } from '../../services/user.service'
import { clientIp } from '../../utils/request-ip'
import { defineApiHandler } from '../../utils/response'
import { issueBrowserSession, sessionCookieName, sessionCookieOptions } from '../../services/auth/browser-session'
import { zValidator } from '../../utils/validate'

function secureCookie(event: H3Event): boolean {
  return event.node?.req?.headers['x-forwarded-proto'] === 'https'
}

/** POST /api/users/login —— 公开登录（email + password），同时建立 HttpOnly 浏览器会话。 */
export default defineApiHandler(async (event) => {
  const body = await readValidatedBody(event, zValidator(userLoginSchema)) as UserLogin
  const result = await userService.login(body, { ip: clientIp(event) })
  const isBrowser = event.node?.req?.headers['x-aw-browser'] === '1'
  const user = resolveUserByToken(result.token)
  if (isBrowser && user) {
    const { credential } = issueBrowserSession(user.id)
    setCookie(event, sessionCookieName(), credential, sessionCookieOptions(secureCookie(event)))
    userService.logout(result.token)
    return { user: result.user, token: '' }
  }
  return result
})

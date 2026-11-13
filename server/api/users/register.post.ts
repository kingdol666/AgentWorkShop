import { readValidatedBody, setCookie, type H3Event } from 'h3'
import { userRegisterSchema, type UserRegister } from '../../schemas/user.schema'
import { userService, resolveUserByToken } from '../../services/user.service'
import { userRepository } from '../../repositories/user.repository'
import { settingOf } from '../../services/workshop/settings'
import { AppError } from '../../utils/errors'
import { defineApiHandler } from '../../utils/response'
import { issueBrowserSession, sessionCookieName, sessionCookieOptions } from '../../services/auth/browser-session'
import { zValidator } from '../../utils/validate'

function secureCookie(event: H3Event): boolean {
  return event.node?.req?.headers['x-forwarded-proto'] === 'https'
}

/**
 * POST /api/users/register —— 公开注册，并建立 HttpOnly 浏览器会话。
 * 公网部署闸门:security.allowRegistration(默认 **false**,见 shared/config/schema.json)
 * 为 false 且首管理员已就位时关闭自助注册;首 admin 引导不受此门限制。
 * 需要开放自助注册的部署请显式置 true(设置页 / AW_SECURITY_ALLOWREGISTRATION=1)。
 */
export default defineApiHandler(async (event) => {
  if (settingOf('security.allowRegistration') === false && userRepository.hasActiveAdmin()) {
    throw new AppError(403, 'REGISTRATION_CLOSED', '自助注册已关闭(security.allowRegistration=false),请联系管理员开通账号')
  }
  const body = await readValidatedBody(event, zValidator(userRegisterSchema)) as UserRegister
  const result = userService.register(body)
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

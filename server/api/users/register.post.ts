import { readValidatedBody } from 'h3'
import { userRegisterSchema, type UserRegister } from '../../schemas/user.schema'
import { userService } from '../../services/user.service'
import { userRepository } from '../../repositories/user.repository'
import { settingOf } from '../../services/workshop/settings'
import { AppError } from '../../utils/errors'
import { defineApiHandler } from '../../utils/response'
import { zValidator } from '../../utils/validate'

/**
 * POST /api/users/register —— 公开注册（name + email + password），签发首个 token。
 * 公网部署闸门:security.allowRegistration(默认 **false**,见 shared/config/schema.json)
 * 为 false 且首管理员已就位时关闭自助注册;首 admin 引导不受此门限制。
 * 需要开放自助注册的部署请显式置 true(设置页 / AW_SECURITY_ALLOWREGISTRATION=1)。
 */
export default defineApiHandler(async (event) => {
  if (settingOf('security.allowRegistration') === false && userRepository.hasActiveAdmin()) {
    throw new AppError(403, 'REGISTRATION_CLOSED', '自助注册已关闭(security.allowRegistration=false),请联系管理员开通账号')
  }
  const body = await readValidatedBody(event, zValidator(userRegisterSchema)) as UserRegister
  return userService.register(body)
})

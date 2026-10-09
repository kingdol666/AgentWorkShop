import { extractBearerToken } from '../../utils/auth'
import { userChangePasswordSchema, type UserChangePassword } from '../../schemas/user.schema'
import { resolveUserByToken, userService } from '../../services/user.service'
import { AppError } from '../../utils/errors'
import { defineApiHandler } from '../../utils/response'
import { zValidator } from '../../utils/validate'
import { readValidatedBody } from 'h3'

/** POST /api/users/change-password —— 本人修改密码（当前密码验证；首登强制改密同一入口） */
export default defineApiHandler(async (event) => {
  const token = extractBearerToken(event)
  const me = resolveUserByToken(token)
  if (!me) {
    throw new AppError(401, 'USER_UNAUTHORIZED', '未登录或 token 已失效')
  }
  const body = await readValidatedBody(event, zValidator(userChangePasswordSchema)) as UserChangePassword
  return userService.changePassword(me.id, body.currentPassword, body.newPassword)
})

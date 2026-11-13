import { resolveUserPrincipal } from '../../utils/user-principal'
import { userChangePasswordSchema, type UserChangePassword } from '../../schemas/user.schema'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'
import { zValidator } from '../../utils/validate'
import { readValidatedBody } from 'h3'

/** POST /api/users/change-password —— 本人修改密码（当前密码验证；首登强制改密同一入口） */
export default defineApiHandler(async (event) => {
  const { user } = resolveUserPrincipal(event)
  const body = await readValidatedBody(event, zValidator(userChangePasswordSchema)) as UserChangePassword
  return userService.changePassword(user.id, body.currentPassword, body.newPassword)
})

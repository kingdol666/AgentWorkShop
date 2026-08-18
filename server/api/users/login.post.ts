import { readValidatedBody } from 'h3'
import { userLoginSchema, type UserLogin } from '../../schemas/user.schema'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'
import { zValidator } from '../../utils/validate'

/** POST /api/users/login —— 公开登录（email + password），签发新会话 token */
export default defineApiHandler(async (event) => {
  const body = await readValidatedBody(event, zValidator(userLoginSchema)) as UserLogin
  return userService.login(body)
})

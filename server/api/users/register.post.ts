import { readValidatedBody } from 'h3'
import { userRegisterSchema, type UserRegister } from '../../schemas/user.schema'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'
import { zValidator } from '../../utils/validate'

/** POST /api/users/register —— 公开注册（name + email + password），签发首个 token */
export default defineApiHandler(async (event) => {
  const body = await readValidatedBody(event, zValidator(userRegisterSchema)) as UserRegister
  return userService.register(body)
})

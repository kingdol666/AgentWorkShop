import { readValidatedBody } from 'h3'
import { userTokenCreateSchema, type UserTokenCreate } from '../../../schemas/user.schema'
import { extractBearerToken } from '../../../utils/auth'
import { userService } from '../../../services/user.service'
import { defineApiHandler } from '../../../utils/response'
import { zValidator } from '../../../utils/validate'

/** POST /api/users/tokens —— 为当前用户创建新 token（明文仅此一次返回） */
export default defineApiHandler(async (event) => {
  const token = extractBearerToken(event)
  const body = await readValidatedBody(event, zValidator(userTokenCreateSchema)) as UserTokenCreate
  return userService.createToken(userService.me(token).id, body.label)
})

import { readValidatedBody } from 'h3'
import { userCreateSchema, type UserCreate } from '../../schemas/user.schema'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'
import { zValidator } from '../../utils/validate'

/** POST /api/users —— 创建用户 */
export default defineApiHandler(async (event) => {
  const body = await readValidatedBody(event, zValidator(userCreateSchema)) as UserCreate
  return userService.create(body)
})

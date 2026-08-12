import { getRouterParam, readValidatedBody } from 'h3'
import { userUpdateSchema, type UserUpdate } from '../../schemas/user.schema'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'
import { zValidator } from '../../utils/validate'

/** PUT /api/users/:id —— 更新用户（部分字段） */
export default defineApiHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readValidatedBody(event, zValidator(userUpdateSchema)) as UserUpdate
  return userService.update(id, body)
})

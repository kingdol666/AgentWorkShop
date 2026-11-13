import { getRouterParam, readValidatedBody } from 'h3'
import { userTokenUpdateSchema, type UserTokenUpdate } from '../../../schemas/user.schema'
import { resolveUserPrincipal } from '../../../utils/user-principal'
import { userService } from '../../../services/user.service'
import { defineApiHandler } from '../../../utils/response'
import { zValidator } from '../../../utils/validate'

/** PATCH /api/users/tokens/:id —— 更新当前用户某 token 的标签 */
export default defineApiHandler(async (event) => {
  const { user } = resolveUserPrincipal(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readValidatedBody(event, zValidator(userTokenUpdateSchema)) as UserTokenUpdate
  return userService.updateToken(user.id, id, body.label)
})

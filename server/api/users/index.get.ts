import { getValidatedQuery } from 'h3'
import { userListQuerySchema, type UserListQueryInput } from '../../schemas/user.schema'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'
import { zValidator } from '../../utils/validate'
import { requireAdmin } from '../workshop/caller'

/** GET /api/users —— 分页查询用户（pageSize 缺省时由 config.yml 驱动；仅 admin） */
export default defineApiHandler(async (event) => {
  requireAdmin(event)
  const query = await getValidatedQuery(event, zValidator(userListQuerySchema)) as UserListQueryInput
  return userService.list(query)
})

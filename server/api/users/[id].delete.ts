import { getRouterParam } from 'h3'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'

/** DELETE /api/users/:id —— 删除用户 */
export default defineApiHandler((event) => {
  const id = getRouterParam(event, 'id') ?? ''
  return userService.remove(id)
})

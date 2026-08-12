import { getRouterParam } from 'h3'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'

/** GET /api/users/:id —— 用户详情 */
export default defineApiHandler((event) => {
  const id = getRouterParam(event, 'id') ?? ''
  return userService.getById(id)
})

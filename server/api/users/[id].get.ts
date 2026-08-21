import { getRouterParam } from 'h3'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'
import { requireAdmin } from '../workshop/caller'

/** GET /api/users/:id —— 用户详情(仅 admin) */
export default defineApiHandler((event) => {
  requireAdmin(event)
  const id = getRouterParam(event, 'id') ?? ''
  return userService.getById(id)
})

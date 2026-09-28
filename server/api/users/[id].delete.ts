import { getRouterParam } from 'h3'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'
import { requireAdmin } from '../workshop/caller'
import { recordOps } from '../../services/workshop/ops/ops'

/** DELETE /api/users/:id —— 删除用户(仅 admin) */
export default defineApiHandler((event) => {
  const admin = requireAdmin(event)
  const id = getRouterParam(event, 'id') ?? ''
  const res = userService.remove(id)
  recordOps({
    actor: admin.id, actorName: admin.name, actorKind: 'user',
    action: 'user.delete', kind: 'system', targetKind: 'user', targetId: id,
    summary: `删除用户 ${id}`,
  })
  return res
})

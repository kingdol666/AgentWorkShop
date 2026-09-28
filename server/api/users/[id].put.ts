import { getRouterParam, readValidatedBody } from 'h3'
import { userUpdateSchema, type UserUpdate } from '../../schemas/user.schema'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'
import { zValidator } from '../../utils/validate'
import { requireAdmin } from '../workshop/caller'
import { recordOps } from '../../services/workshop/ops/ops'

/** PUT /api/users/:id —— 更新用户（部分字段） */
export default defineApiHandler(async (event) => {
  const admin = requireAdmin(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readValidatedBody(event, zValidator(userUpdateSchema)) as UserUpdate
  const user = userService.update(id, body)
  recordOps({
    actor: admin.id, actorName: admin.name, actorKind: 'user',
    action: 'user.update', kind: 'system', targetKind: 'user', targetId: id,
    summary: `更新用户 ${id}(字段:${Object.keys(body).join(', ')})`,
  })
  return user
})

import { readValidatedBody } from 'h3'
import { userCreateSchema, type UserCreate } from '../../schemas/user.schema'
import { userService } from '../../services/user.service'
import { defineApiHandler } from '../../utils/response'
import { zValidator } from '../../utils/validate'
import { requireAdmin } from '../workshop/caller'
import { recordOps } from '../../services/workshop/ops/ops'

/** POST /api/users —— 创建用户 */
export default defineApiHandler(async (event) => {
  const admin = requireAdmin(event)
  const body = await readValidatedBody(event, zValidator(userCreateSchema)) as UserCreate
  const user = userService.create(body)
  recordOps({
    actor: admin.id, actorName: admin.name, actorKind: 'user',
    action: 'user.create', kind: 'system', targetKind: 'user', targetId: user.id,
    summary: `创建用户 ${user.name}(${user.role})`,
  })
  return user
})

/**
 * POST /api/workshop/workspaces —— 创建 workspace(归属当前用户)。
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'
import { resolveUser } from '../caller'

const schema = z.object({ name: z.string().min(1, 'name 必填').max(64) })

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getWorkshopManager().createWorkspace(user.id, body.name)
})

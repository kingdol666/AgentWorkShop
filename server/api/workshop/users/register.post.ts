/**
 * POST /api/workshop/users/register —— 注册用户(name 唯一)。
 * 公开端点;返回 { id, name, token }——token 仅此一次完整返回,请妥善保存。
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

const schema = z.object({
  name: z.string().min(1, 'name 必填').max(64, 'name 过长'),
})

export default defineApiHandler(async (event) => {
  const body = await readValidatedBody(event, zValidator(schema))
  return getWorkshopManager().registerUser(body.name)
})

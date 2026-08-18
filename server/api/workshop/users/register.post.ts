/**
 * POST /api/workshop/users/register —— 注册用户（name 唯一），经全局用户系统签发。
 * 兼容旧契约：仅传 name 时自动补全局账号（email 由 name 派生、随机密码），
 * 返回 { id, name, token }——token 仅此一次完整返回，请妥善保存。
 * 全局用户系统承载身份，workshop 本地不再维护独立用户表。
 */
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { userService } from '../../../services/user.service'

const schema = z.object({
  name: z.string().trim().min(1, 'name 必填').max(64, 'name 过长'),
})

export default defineApiHandler(async (event) => {
  const body = await readValidatedBody(event, zValidator(schema))
  const name = body.name.trim()
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}@workshop.local`
  const result = userService.register({ name, email, password: randomLegacyPassword() })
  return { id: result.user.id, name: result.user.name, token: result.token }
})

/** 20 位随机口令（老版仅 name 注册的账号密码不对外；后续可经管理面重置） */
function randomLegacyPassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = randomBytes(20)
  let out = ''
  for (const b of bytes) out += chars[b % chars.length]
  return out
}

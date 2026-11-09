/**
 * PUT /api/workshop/permissions —— 批量设置某用户的产线授权(admin 专用)。
 * body: { userId, grants: [{ lineId, mode: 'readonly' | 'operate' | null }] }(null = 撤销)
 * 写后广播 permissions.changed(scene-events)与 permissions:changed(插件钩子)。
 */
import { readValidatedBody } from 'h3'
import { z } from 'zod'
import { resolveUser, requireAdmin } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { userRepository } from '@/server/repositories/user.repository'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { notifyGrantsChanged } from '@/server/services/workshop/permissions'

// mode 是权限模型 v3 的封闭枚举(readonly/operate/撤销=null)。
// 过去 mode 被 as string 透传进 setGrant,任意字符串都会落库 —— 形状收紧到契约本身;
// lineId 为空的行保持既有语义(跳过),故这里不强制 min(1)。
const schema = z.object({
  userId: z.string().trim().min(1, 'userId 必填'),
  grants: z.array(z.object({
    lineId: z.string().optional(),
    mode: z.enum(['readonly', 'operate']).nullable().optional(),
  })).optional(),
})

export default defineApiHandler(async (event) => {
  const admin = resolveUser(event)
  requireAdmin(event)
  const { userId, grants } = await readValidatedBody(event, zValidator(schema))
  if (!userRepository.findById(userId)) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, `用户不存在: ${userId}`)
  }
  for (const g of grants ?? []) {
    const lineId = String(g.lineId ?? '').trim()
    if (!lineId) continue
    userRepository.setGrant(userId, lineId, g.mode ?? null, admin.id)
  }
  notifyGrantsChanged(userId)
  return { userId, grants: userRepository.listGrants(userId) }
})

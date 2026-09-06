/**
 * PUT /api/workshop/permissions —— 批量设置某用户的产线授权(admin 专用)。
 * body: { userId, grants: [{ lineId, mode: 'readonly' | 'operate' | null }] }(null = 撤销)
 * 写后广播 permissions.changed(scene-events)与 permissions:changed(插件钩子)。
 */
import { readBody } from 'h3'
import { resolveUser, requireAdmin } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { userRepository } from '@/server/repositories/user.repository'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { notifyGrantsChanged } from '@/server/services/workshop/permissions'

export default defineApiHandler(async (event) => {
  const admin = resolveUser(event)
  requireAdmin(event)
  const body = await readBody<{ userId?: string, grants?: Array<{ lineId?: string, mode?: string | null }> }>(event) ?? {}
  const userId = String(body.userId ?? '')
  if (!userId || !userRepository.findById(userId)) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, `用户不存在: ${userId || '?'}`)
  }
  const grants = Array.isArray(body.grants) ? body.grants : []
  for (const g of grants) {
    const lineId = String(g?.lineId ?? '')
    if (!lineId) continue
    userRepository.setGrant(userId, lineId, (g?.mode ?? null) as string | null, admin.id)
  }
  notifyGrantsChanged(userId)
  return { userId, grants: userRepository.listGrants(userId) }
})

/**
 * GET /api/workshop/hitl/history?channelId=&limit= —— HITL 历史（含终态）。
 *
 * 为什么需要它(2026-11-10):`hitl_requests` 是 v17 的持久化事实源（登记 pending →
 * 决策 finalize 终态，永不删除），但此前只有 `GET /hitl/pending`（只读内存快照）——
 * 「解析后是否留行」没有任何读面可验收，现场因此只能去 audit_log 里翻（而
 * audit_log 只保留 90 天，与 hitl_requests 长期保留的设计相反）。
 *
 * 鉴权:
 *  - admin:不限 channel,缺省返回全局最近 N 条;
 *  - 其他用户:必须给 channelId 且通过 getChannelForUser(频道可见性);再按产线
 *    grant 过滤(与该频道绑线且用户对该线无授权 → 隐藏)。
 */
import { getQuery } from 'h3'
import { z } from 'zod'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { zValidator } from '@/server/utils/validate'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { lineMode } from '@/server/services/workshop/permissions'

const querySchema = z.object({
  channelId: z.string().trim().optional(),
  limit: z.string().optional().refine(
    v => v === undefined || v.trim() === '' || Number.isFinite(Number(v)),
    { message: '必须是数值' },
  ),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event) as Record<string, string | undefined>
  const { channelId, limit } = zValidator(querySchema)(q)
  const take = Math.min(500, Math.max(1, Number(limit ?? 100) || 100))
  const manager = getWorkshopManager()
  const repo = manager.groupChat.hitl

  if (!channelId) {
    if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '非管理员查询 HITL 历史必须指定 channelId')
    return { rows: repo.listRecent(take), scope: 'all' as const }
  }

  // 频道可见性(与 pending 同源):不可见按 404 处理,不泄露存在性
  manager.getChannelForUser(channelId, user.id)
  const rows = repo.listByChannel(channelId, take)
  // 产线 grant:频道绑线且用户对该线无授权 → 隐藏(admin 恒可见)
  const line = manager.deps.repos.channels.findById(channelId)?.lineId
  const visible = user.role === 'admin' || !line || lineMode(user, line) !== 'none'
  return { rows: visible ? rows : [], scope: 'channel' as const }
})

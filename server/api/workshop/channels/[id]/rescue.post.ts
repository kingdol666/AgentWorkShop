/**
 * POST /api/workshop/channels/:id/rescue —— 立即触发一次 D1 救援扫（受权运维入口，WP11）。
 *
 * 语义：与 idle sweeper 的周期救捞同一路径（滞留 SUBMITTED 根 → 卸载并重组 lead 运行时
 * + 刷新执行预算 + 投递 assign 领取消息），只是按需立即执行、限定该 Channel。
 * 鉴权：频道可写（owner/admin）。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { AppError } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')
  if (!channelId) throw new AppError(400, 'BAD_REQUEST', '缺少频道 id')
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  if (!ch) throw new AppError(404, 'NOT_FOUND', `Channel 不存在或不可见: ${channelId}`)
  if (user.role !== 'admin' && ch.ownerUserId !== user.id) {
    throw new AppError(403, 'SCOPE_VIOLATION', '只有频道属主或管理员可以触发救援')
  }
  await manager.rescueChannelNow(channelId)
  return { ok: true, channelId }
})

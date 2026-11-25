/**
 * POST /api/workshop/channels/:id/sessions/:sid/archive —— 归档手工会话。
 * active/closing 会话会先执行既有 close 级联（取消在飞任务 + 停用 clone）；
 * 归档后从所有会话清单隐藏，仅设置页「归档对话」可见。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  return getWorkshopManager().archiveChannelSession({
    channelId,
    sessionId,
    actor: { id: user.id, role: user.role },
  })
})

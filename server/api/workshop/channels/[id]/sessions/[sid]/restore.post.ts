/**
 * POST /api/workshop/channels/:id/sessions/:sid/restore —— 恢复已归档会话。
 * 只清除归档标记；会话保持 closed，回到普通清单（不自动重开运行时）。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  return getWorkshopManager().restoreChannelSession({
    channelId,
    sessionId,
    actor: { id: user.id, role: user.role },
  })
})

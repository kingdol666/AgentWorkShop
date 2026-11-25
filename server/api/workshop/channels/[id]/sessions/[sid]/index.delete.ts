/**
 * DELETE /api/workshop/channels/:id/sessions/:sid —— 永久删除已归档会话。
 * 不可恢复：级联清理会话行、clone 成员、消息/群聊/任务/记忆与节点绑定持久层。
 * 只接受「已归档 + 已关闭 + 手工会话」；其余 409。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  return getWorkshopManager().purgeChannelSession({
    channelId,
    sessionId,
    actor: { id: user.id, role: user.role },
  })
})

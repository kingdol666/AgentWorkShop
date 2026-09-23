/**
 * GET /api/workshop/channels/:id/chat/permissions —— 当前用户在该 Channel 的群聊能力视图。
 *
 * 单一事实源在服务端(前端按钮可用性据此渲染,不做本地推断)。
 * 非成员也可调用(返回 canJoin 等公开信息);Channel 不存在 → channel=null。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const channel = manager.deps.repos.channels.findById(channelId)
  if (!channel) {
    return { channelId, channel: null, permissions: null }
  }
  return {
    channelId,
    channel: {
      id: channel.id,
      name: channel.name,
      description: channel.description,
      visibility: channel.visibility,
      joinPolicy: channel.joinPolicy,
      approvalPolicy: channel.approvalPolicy,
      chatEnabled: channel.chatEnabled,
      version: channel.version,
      legacy: channel.ownerUserId === null,
    },
    permissions: manager.channelPermissionsOf(channelId, user),
  }
})

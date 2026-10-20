/**
 * GET /api/workshop/channels/:id/tools —— Channel 工具透明化视图。
 * 返回全部注册工具 + 硬规则资格(lead/worker)+ 本 Channel 选择 + 统计。
 * 鉴权:Channel 属主或 admin;遗留公共 Channel(owner null)需 admin。
 */
import { resolveUser, requireAdmin } from '../../../../workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { buildChannelToolView } from '@/server/services/workshop/tools/catalog-view'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = String(event.context.params?.id ?? '')
  const channel = getWorkshopManager().getChannelForUser(id, user.id)
  if (channel.ownerUserId === null) requireAdmin(event)
  return buildChannelToolView(id)
})

/**
 * POST /api/workshop/channels/:id/tools/reset —— 清除 Channel 工具策略,恢复默认全启用。
 * 鉴权:Channel 属主或 admin;遗留公共 Channel 需 admin。
 */
import { resolveUser, requireAdmin } from '../../../../workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getToolRegistryRepo } from '@/server/services/workshop/db/tool-registry.repo'
import { buildChannelToolView } from '@/server/services/workshop/tools/catalog-view'
import { notifyToolChange } from '@/server/services/workshop/agents/plugin-tools'
import { recordOps } from '@/server/services/workshop/ops/ops'
import { AppError } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = String(event.context.params?.id ?? '')
  const channel = getWorkshopManager().getChannelForUser(id, user.id)
  if (channel.ownerUserId === null) requireAdmin(event)

  try {
    getToolRegistryRepo().resetPolicy(id)
  }
  catch (err) {
    throw new AppError(503, 'TOOL_REGISTRY_UNAVAILABLE', `工具策略重置失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  notifyToolChange()
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'tool_policy.reset',
    targetKind: 'channel',
    targetId: id,
    kind: 'system',
    scope: 'system',
    summary: 'Channel 工具策略已重置为默认(全部合格工具启用)',
  })
  return buildChannelToolView(id)
})

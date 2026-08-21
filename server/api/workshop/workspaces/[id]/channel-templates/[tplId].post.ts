/**
 * POST /api/workshop/workspaces/:id/channel-templates/:tplId —— 从 Channel 模板实例化并挂载到 workspace。
 * 一步完成:实例化(属主 = 操作者)+ mount;替代原「挂载已有 Channel」入口。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../utils/validate'
import { defineApiHandler } from '../../../../../utils/response'
import { resolveUser } from '../../../caller'
import { getWorkshopManager, ensureLeadSchedulerLoop } from '../../../../../plugins/workshop'

const mountSchema = z.object({
  name: z.string().min(1).optional(),
})

export default defineApiHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const templateId = getRouterParam(event, 'tplId')!
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(mountSchema))
  const manager = getWorkshopManager()
  const result = await manager.instantiateChannelTemplate(templateId, user, body.name)
  manager.mountChannelToWorkspace(user.id, workspaceId, result.channelId)
  if (result.leadAgentId) {
    ensureLeadSchedulerLoop(manager, result.channelId)
  }
  return result
})

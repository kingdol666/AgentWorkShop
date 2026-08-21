/**
 * POST /api/workshop/channel-templates/:id/instantiate —— 实例化 Channel 模板 → 新建 channel(属主 = 操作者)。
 * 可见性:属主 / public(含内置)/ admin 可实例化;他人 private → 403。
 * body.name 可选(缺省用模板名)。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../utils/validate'
import { defineApiHandler } from '../../../../utils/response'
import { resolveUser } from '../../caller'
import { getWorkshopManager, ensureLeadSchedulerLoop } from '../../../../plugins/workshop'

const instantiateSchema = z.object({
  name: z.string().min(1).optional(),
})

export default defineApiHandler(async (event) => {
  const templateId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(instantiateSchema))
  const manager = getWorkshopManager()
  const result = await manager.instantiateChannelTemplate(templateId, user, body.name)
  // 模板含 lead 时直接启动调度循环(可提交任务)
  if (result.leadAgentId) {
    ensureLeadSchedulerLoop(manager, result.channelId)
  }
  return result
})

/**
 * POST /api/workshop/channels/:id/agents —— 在 channel 内放置 Agent 实例。
 * - 提供 agentId:把该 Agent 模板克隆为独立身份 id 的新实例
 * - 否则:一步创建 Agent 模板并克隆进 channel
 * - role=lead 且已有 lead → 409 LEAD_EXISTS
 */
import { z } from 'zod'

import { resolveUser } from '../../../caller'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../utils/validate'
import { defineApiHandler } from '../../../../../utils/response'
import { AppError } from '../../../../../utils/errors'
import { getWorkshopManager, ensureLeadSchedulerLoop } from '../../../../../plugins/workshop'

const createAgentSchema = z.object({
  agentId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
  role: z.enum(['lead', 'worker']).default('worker'),
  config: z.record(z.string(), z.unknown()).optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, zValidator(createAgentSchema))
  const manager = getWorkshopManager()
  const channel = (await manager.listChannels()).find(c => c.id === channelId)
  if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)

  const user = resolveUser(event)
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  const role = body.role ?? 'worker'
  // 克隆模板时校验模板可读(本人或遗留公共;他人模板 → 403)
  if (body.agentId) {
    const tpl = manager.getAgent(body.agentId)
    if (tpl && tpl.config && (tpl as { ownerUserId?: string | null }).ownerUserId !== null && (tpl as { ownerUserId?: string | null }).ownerUserId !== user.id) {
      throw new (await import('../../../../../utils/errors')).AppError(403, 'SCOPE_VIOLATION', 'Agent 模板不属于当前用户')
    }
  }
  const agent = body.agentId
    ? await manager.addAgentToChannel({
        channelId,
        agentId: body.agentId,
        role,
        // 克隆模板时允许覆盖 config(如注入/覆盖 systemPromptPrefix 场景提示词)
        configOverride: body.config && Object.keys(body.config).length > 0 ? body.config : undefined,
      })
    : await (async () => {
        if (!body.name || !body.harness) {
          throw new AppError(400, 'BAD_REQUEST', '需提供 name+harness(新建模板)或 agentId(克隆已有模板)')
        }
        const tpl = await manager.createAgent({ name: body.name, harness: body.harness, config: body.config })
        return manager.addAgentToChannel({ channelId, agentId: tpl.id, role })
      })()

  if (role === 'lead') {
    ensureLeadSchedulerLoop(manager, channelId)
  }
  return agent
})

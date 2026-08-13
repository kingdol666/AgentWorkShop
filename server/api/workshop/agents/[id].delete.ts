/**
 * DELETE /api/workshop/agents/:id —— 删除 Agent(lead 被删后 channel 失去主理人)(设计文档 §6.2)。
 * Agent 不存在 → 404 NOT_FOUND(公开 API 无 findAgent,按 channel 扫描)。
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../utils/errors'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const agentId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  let found = false
  for (const channel of await manager.listChannels()) {
    const agents = await manager.listAgents(channel.id)
    if (agents.some(a => a.id === agentId)) {
      found = true
      break
    }
  }
  if (!found) throw new AppError(404, 'NOT_FOUND', `Agent 不存在: ${agentId}`)
  await manager.removeAgent(agentId)
  return { ok: true }
})

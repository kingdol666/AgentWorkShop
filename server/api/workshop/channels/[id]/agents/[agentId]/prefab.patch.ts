/**
 * PATCH /api/workshop/channels/:id/agents/:agentId/prefab — 绑定/解绑 AgentPrefab。
 *
 * body:
 *  - { prefabId, revision, slotValues } → 固定 revision 的 binding
 *  - { clear: true } 或 { prefabBinding: null } → 显式解绑
 * 请求只保存 binding JSON；凭据/秘密不进入成员配置。变更后成员运行时卸载，下次装配生效。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '../../../../../../utils/response'
import { resolveUser } from '../../../../caller'
import { getWorkshopManager } from '../../../../../../plugins/workshop'
import { AppError } from '../../../../../../utils/errors'
import { createAgentPrefabService } from '../../../../../../services/workshop/agent-prefabs/service'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id') ?? ''
  const agentId = getRouterParam(event, 'agentId') ?? ''
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireWritable(channel.ownerUserId, user, 'channel')
  const members = await manager.listChannelAgents(channelId)
  if (!members.some(a => a.id === agentId)) throw new AppError(404, 'NOT_FOUND', `成员不存在: ${agentId}`)

  const body = (await readBody<Record<string, unknown>>(event)) ?? {}
  const clear = body.clear === true || body.prefabBinding === null
  const service = createAgentPrefabService(manager.deps.db)
  let prefabBindingJson = ''
  if (!clear) {
    const prefabId = typeof body.prefabId === 'string' ? body.prefabId : ''
    const revision = Number(body.revision)
    if (!prefabId || !Number.isInteger(revision)) throw new AppError(400, 'VALIDATION_ERROR', 'prefabId/revision 必填')
    const binding = service.buildBinding({ id: user.id, role: user.role }, prefabId, revision, body.slotValues)
    prefabBindingJson = JSON.stringify(binding)
  }
  const agent = await manager.updateChannelAgent(agentId, { prefabBindingJson }, {
    channelId,
    by: 'user',
    reason: clear ? 'prefab-unbind' : 'prefab-bind',
    actor: user,
  })
  return { agentId: agent.id, prefabBinding: prefabBindingJson ? JSON.parse(prefabBindingJson) : null }
})

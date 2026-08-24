/**
 * PATCH /api/workshop/channels/:id/agents/:agentId/model —— 绑定角色模型(换装)。
 * - Bearer 用户 token;body: { modelRef }(assetId;'' 清除)
 * - 更新 agent 的 config.modelRef(经 manager.updateChannelAgent 持久化)+ 注册表 appliedTo 反向索引
 * - 返回 { agentId, modelRef }
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getCharacterAssetRepo } from '@/server/services/workshop/assets/character-asset.repo'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const body = await readBody<{ modelRef?: string | null }>(event)
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireWritable(channel.ownerUserId, user, 'channel')
  const members = await manager.listChannelAgents(channelId)
  if (!members.some(a => a.id === agentId)) throw new AppError(404, 'NOT_FOUND', `成员不存在: ${agentId}`)

  const modelRef = typeof body?.modelRef === 'string' ? body.modelRef.trim() : ''
  // 与既有 config 合并(保留 homeX/homeZ 等布局字段),经既有 updateChannelAgent 持久化,
  // 随后 AEP agent.member 回流前端
  const current = (members.find(a => a.id === agentId)?.config ?? {}) as Record<string, unknown>
  await manager.updateChannelAgent(agentId, { config: { ...current, modelRef } }, { channelId, by: 'user', reason: 'bind-model' })

  // 更新注册表反向索引:新模型 bind;旧模型 unbind(重算所有绑定该 agent 的模型)
  const repo = getCharacterAssetRepo()
  if (modelRef) repo.bind(modelRef, agentId)
  for (const a of repo.listAll()) {
    if (a.id !== modelRef && a.appliedTo.includes(agentId)) repo.unbind(a.id, agentId)
  }

  return { agentId, modelRef }
})

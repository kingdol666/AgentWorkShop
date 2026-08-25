/**
 * PATCH /api/workshop/channels/:id/agents/:agentId/range —— 管理员布局:保存 Agent 独立活动范围。
 * - Bearer 用户 token;body: { range?: { x, z, radiusX, radiusZ, shape?, rotationY? } | null }
 * - 写入 config.range(config 合并,不覆盖 modelRef/homeX 等既有字段);range 缺省/null → 清除(回退频道边界);
 * - 经既有 updateChannelAgent 持久化并 AEP agent.member(op=updated) 回流前端(town 重建即按新范围落位)。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const body = await readBody<{ range?: unknown }>(event)
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireWritable(channel.ownerUserId, user, 'channel')
  const members = await manager.listChannelAgents(channelId)
  const agent = members.find(a => a.id === agentId)
  if (!agent) throw new AppError(404, 'NOT_FOUND', `成员不存在: ${agentId}`)

  // 合并写入,保留 modelRef/homeX 等既有 config;range 缺省/null/非法 → 清除对应活动范围
  const config = { ...(agent.config ?? {}) }
  const raw = body?.range
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const x = num(r.x)
    const z = num(r.z)
    const radiusX = num(r.radiusX)
    const radiusZ = num(r.radiusZ)
    if (x !== undefined && z !== undefined && radiusX !== undefined && radiusZ !== undefined) {
      config.range = {
        x: Math.round(x * 10) / 10,
        z: Math.round(z * 10) / 10,
        radiusX: Math.max(30, Math.round(radiusX * 10) / 10),
        radiusZ: Math.max(30, Math.round(radiusZ * 10) / 10),
        shape: r.shape === 'rect' ? 'rect' : 'ellipse',
        rotationY: Math.round((num(r.rotationY) ?? 0) * 10) / 10,
      }
    }
    else {
      delete config.range
    }
  }
  else {
    delete config.range
  }
  await manager.updateChannelAgent(agentId, { config }, { channelId, by: 'user', reason: 'range' })
  return { agentId, name: agent.name, config }
})

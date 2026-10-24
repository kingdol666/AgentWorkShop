/**
 * GET /api/workshop/optimization/bindings?channelId=&agentInstanceId= —— 绑定列表
 * POST —— 创建绑定(实例身份校验;模板 id 拒绝)
 */
import { getQuery, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { getBindingRepo } from '@/server/services/workshop/optimization/binding.repo'
import { createBinding } from '@/server/services/workshop/optimization/binding.service'
import { assertAgentAccess } from '@/server/services/workshop/optimization/rest-auth'
import { recordConfigAction } from '@/server/services/workshop/optimization/access'
import { AppError } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const method = event.method?.toUpperCase() ?? 'GET'
  if (method === 'GET') {
    const q = getQuery(event)
    if (typeof q.agentInstanceId === 'string') {
      assertAgentAccess(user, q.agentInstanceId)
      return { bindings: getBindingRepo().listByAgent(q.agentInstanceId) }
    }
    // 全局列表仅 admin(否则会枚举他人 Channel 的绑定)
    if (user.role !== 'admin') throw new AppError(403, 'SCOPE_VIOLATION', '全局绑定列表仅管理员可读;请按 agentInstanceId 查询')
    return { bindings: getBindingRepo().listAll(200) }
  }
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const agentInstanceId = String(body.agentInstanceId ?? '')
  if (!agentInstanceId) throw new AppError(422, 'AGENT_REQUIRED', 'agentInstanceId 必填')
  // 创建/更换绑定 = Channel 管理权(manage),普通成员只可调用不可改绑
  assertAgentAccess(user, agentInstanceId, { manage: true })
  const binding = createBinding({
    workspaceId: String(body.workspaceId ?? ''),
    channelId: String(body.channelId ?? ''),
    agentInstanceId,
    profileId: String(body.profileId ?? ''),
    profileVersion: Number(body.profileVersion ?? 1),
    capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
    mode: body.mode === 'shadow' ? 'shadow' : 'recommendation',
    validTo: typeof body.validTo === 'string' ? body.validTo : null,
    createdBy: user.id,
  })
  recordConfigAction(user, 'optimizer.binding.create', { kind: 'optimizer_binding', id: binding.id },
    `创建优化器绑定 ${binding.id}(agent=${agentInstanceId},profile=${binding.profileId}@${binding.profileVersion})`,
    { agentInstanceId, profileId: binding.profileId, mode: binding.mode })
  return { binding }
})

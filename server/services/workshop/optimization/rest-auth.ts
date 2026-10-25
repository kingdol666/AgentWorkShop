/**
 * Optimizer REST 授权:登录 + 角色只是入口,必须再核验"该用户可支配该 Agent 实例"。
 * 口径与 agent-tools/invoke 一致:admin 放行;其余必须是该 Channel 的成员/owner。
 *
 * 直接读 globalThis.__workshopManager(插件启动时装配):避免静态 import plugins/workshop
 * 把 Nitro `#imports` 拖进本模块,便于单测注入假管理器。
 */
import { AppError } from '../../../utils/errors'
import { getAmlRuntime } from '../aml/runtime'
import type { ResolvedUser } from '../../../api/workshop/caller'
import { getBindingRepo } from './binding.repo'
import { revokeBinding } from './binding.service'
import { getRunRepo } from './run.repo'

interface ManagerLike {
  deps: { repos: { channelAgents: { findById(id: string): { channelId: string } | undefined } } }
  channelPermissionsOf(channelId: string, user: ResolvedUser): { isMember: boolean, canManage?: boolean }
}

export function assertAgentAccess(user: ResolvedUser, agentInstanceId: string, options: { manage?: boolean } = {}): { channelId: string } {
  const manager = (globalThis as { __workshopManager?: ManagerLike }).__workshopManager
  if (!manager) throw new AppError(503, 'WORKSHOP_NOT_READY', 'workshop 未就绪')
  const row = manager.deps.repos.channelAgents.findById(agentInstanceId)
  if (!row) {
    // 模板 id(channel_agents 之外、agents 表内)给出可行动的具体错误,
    // 而不是笼统的 404 —— 调用方需要知道"改用实例 id"。
    let template: unknown
    try {
      template = getAmlRuntime().db.prepare('SELECT id FROM agents WHERE id = ?').get(agentInstanceId)
    }
    catch {
      // AML 未初始化(单测/插件未启动)→ 保持既有 404 语义
      template = undefined
    }
    if (template) {
      throw new AppError(422, 'AGENT_TEMPLATE_ID_NOT_ALLOWED',
        `传入的是 Agent 模板 id(${agentInstanceId});必须使用 Channel 实例 id(channel_agents.id)`)
    }
    throw new AppError(404, 'AGENT_NOT_FOUND', `Agent 实例 ${agentInstanceId} 不存在`)
  }
  if (user.role === 'admin') return { channelId: row.channelId }
  const permissions = manager.channelPermissionsOf(row.channelId, user)
  if (!permissions.isMember) {
    throw new AppError(403, 'SCOPE_VIOLATION', '该 Agent 不属于当前用户所在 Channel,无权读取/代调用其优化器')
  }
  if (options.manage && !permissions.canManage) {
    throw new AppError(403, 'SCOPE_VIOLATION', '无权管理该 Agent 所属 Channel 的优化器绑定')
  }
  return { channelId: row.channelId }
}

/** 管理授权通过后才撤权,避免拒绝请求使他人的建议失效。 */
export function revokeBindingForUser(user: ResolvedUser, bindingId: string): void {
  const binding = getBindingRepo().get(bindingId)
  if (!binding) throw new AppError(404, 'BINDING_NOT_FOUND', `绑定 ${bindingId} 不存在`)
  assertAgentAccess(user, binding.channelAgentId, { manage: true })
  getRunRepo().expireWhere({ bindingId })
  if (!revokeBinding(bindingId, user.id, user.name)) {
    throw new AppError(404, 'BINDING_NOT_FOUND', `绑定 ${bindingId} 不存在`)
  }
}

/**
 * node-delegation —— lead → worker 节点权限委派(核心校验面,宿主工具与 REST 共用)。
 *
 * 语义:lead 把**自己已绑定**的 DAQ/DCW 节点授权给同 Channel 的 worker:
 *   - 节点必须是 leader 本人已有绑定的节点(权限不可超越授予者,hard rule);
 *   - 目标必须是同 Channel 的启用 worker(不能授给 lead 自己/其他频道成员);
 *   - 绑定逐 (nodeId, kind) 复制 leader 的 kind/tuning;mode 缺省随 leader,
 *     显式传 mode 可覆盖(auto↔manual 均允许 —— mode 只决定是否走 HITL,不放大节点面);
 *   - 委派产生的绑定带 grantedByAgentId/grantedAt 溯源;撤销时 leader 只能撤
 *     「自己授予的」或「自己也持有的」绑定。
 * 校验全部 fail-closed:任何节点不满足 → 整单拒绝并列出明细,不做部分授予。
 */
import { AppError, ErrorCodes } from '../../../utils/errors'
import { getAgentNodeBindingRepo, type AgentNodeBinding, type AgentNodeBindingMode } from './node-bindings.repo'

export interface DelegationMember {
  id: string
  role: 'lead' | 'worker'
  enabled?: number
}

export interface DelegationGrantInput {
  leaderAgentId: string
  channelId: string
  targetAgentId: string
  nodeIds: string[]
  members: DelegationMember[]
  mode?: AgentNodeBindingMode
}

export interface DelegationPlanItem {
  nodeId: string
  kind: 'dcw' | 'daq'
  mode: AgentNodeBindingMode
  tuning?: AgentNodeBinding['tuning']
}

export interface DelegationPlan {
  targetAgentId: string
  grants: DelegationPlanItem[]
}

/** 前置校验 + 逐节点计划(fail-closed;不落库 —— 落库由调用方按计划执行) */
export function planDelegation(input: DelegationGrantInput): DelegationPlan {
  const leaderAgentId = String(input.leaderAgentId ?? '')
  const targetAgentId = String(input.targetAgentId ?? '')
  const nodeIds = (Array.isArray(input.nodeIds) ? input.nodeIds : []).map(x => String(x ?? '').trim()).filter(Boolean)
  if (!leaderAgentId || !targetAgentId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'leaderAgentId 与 targetAgentId 必填')
  if (!nodeIds.length) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'node_ids 必填(要授予的节点 id 列表)')

  const members = Array.isArray(input.members) ? input.members : []
  const leader = members.find(m => m.id === leaderAgentId)
  if (!leader || leader.role !== 'lead') {
    throw new AppError(403, 'DELEGATION_NOT_LEAD', '只有频道 lead 可以分发节点权限')
  }
  const target = members.find(m => m.id === targetAgentId)
  if (!target) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, `目标成员不在本频道: ${targetAgentId}(需传频道成员实例 id,可经 GET /api/workshop/channels/:id/agents 获取)`)
  }
  if (target.id === leaderAgentId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '不能把节点权限授予 lead 自己(绑定面在 lead 名下已存在)')
  }
  if (target.role !== 'worker') {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '只能向 worker 分发节点权限')
  }
  if (target.enabled === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `目标成员已被停用: ${targetAgentId}`)
  }

  const repo = getAgentNodeBindingRepo()
  const leaderBindings = repo.byAgent(leaderAgentId)
  const missing: string[] = []
  const grants: DelegationPlanItem[] = []
  const seen = new Set<string>()
  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) continue
    seen.add(nodeId)
    const held = leaderBindings.filter(b => b.nodeId === nodeId)
    if (!held.length) {
      missing.push(nodeId)
      continue
    }
    for (const h of held) {
      grants.push({
        nodeId,
        kind: h.kind,
        mode: input.mode ?? h.mode,
        tuning: h.tuning ? { ...h.tuning } : undefined,
      })
    }
  }
  if (missing.length) {
    throw new AppError(403, 'DELEGATION_NOT_OWNED', `以下节点不在 lead 的绑定面内,拒绝授予(权限不可超越授予者):${missing.join('、')}`)
  }
  return { targetAgentId, grants }
}

/** 执行授予:按计划逐条落库(已存在的绑定更新 mode/溯源,不重复建行) */
export function applyDelegation(plan: DelegationPlan, leaderAgentId: string): AgentNodeBinding[] {
  const repo = getAgentNodeBindingRepo()
  return plan.grants.map((g) => {
    const binding = repo.bind(plan.targetAgentId, g.nodeId, g.kind, g.mode, g.tuning, { grantedByAgentId: leaderAgentId })
    return binding
  })
}

export interface DelegationRevokeInput {
  leaderAgentId: string
  targetAgentId: string
  nodeIds: string[]
  members: DelegationMember[]
}

/** 撤销授予:可撤「自己授予的」或「自己也持有的」绑定;两者都不是 → 拒绝该节点 */
export function revokeDelegation(input: DelegationRevokeInput): Array<{ nodeId: string, kind: 'dcw' | 'daq', revoked: boolean }> {
  const leaderAgentId = String(input.leaderAgentId ?? '')
  const targetAgentId = String(input.targetAgentId ?? '')
  const nodeIds = (Array.isArray(input.nodeIds) ? input.nodeIds : []).map(x => String(x ?? '').trim()).filter(Boolean)
  if (!leaderAgentId || !targetAgentId || !nodeIds.length) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'leaderAgentId / targetAgentId / node_ids 必填')
  }
  const members = Array.isArray(input.members) ? input.members : []
  const leader = members.find(m => m.id === leaderAgentId)
  if (!leader || leader.role !== 'lead') {
    throw new AppError(403, 'DELEGATION_NOT_LEAD', '只有频道 lead 可以撤销节点权限')
  }
  if (!members.some(m => m.id === targetAgentId)) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, `目标成员不在本频道: ${targetAgentId}`)
  }

  const repo = getAgentNodeBindingRepo()
  const leaderNodes = new Set(repo.byAgent(leaderAgentId).map(b => b.nodeId))
  const out: Array<{ nodeId: string, kind: 'dcw' | 'daq', revoked: boolean }> = []
  for (const nodeId of nodeIds) {
    const workerBindings = repo.byAgent(targetAgentId).filter(b => b.nodeId === nodeId)
    if (!workerBindings.length) {
      for (const kind of ['dcw', 'daq'] as const) out.push({ nodeId, kind, revoked: false })
      continue
    }
    for (const b of workerBindings) {
      const allowed = b.grantedByAgentId === leaderAgentId || leaderNodes.has(nodeId)
      if (!allowed) {
        out.push({ nodeId, kind: b.kind, revoked: false })
        continue
      }
      out.push({ nodeId, kind: b.kind, revoked: repo.unbind(b.id) })
    }
  }
  return out
}

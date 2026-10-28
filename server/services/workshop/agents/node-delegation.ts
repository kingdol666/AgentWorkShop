/**
 * node-delegation —— lead → worker 节点权限委派(核心校验面,宿主工具与 REST 共用)。
 *
 * 语义:lead 把**自己已绑定**的 DAQ/DCW 节点授权给同 Channel 的 worker:
 *   - 节点必须是 leader 本人已有绑定的节点(权限不可超越授予者,hard rule);
 *   - 目标必须是同 Channel 的启用 worker(不能授给 lead 自己/其他频道成员);
 *   - 绑定逐 (nodeId, kind) 复制 leader 的 kind/tuning;mode 缺省 **manual**
 *     (不继承 leader 的 auto);显式 mode=auto 等于摘掉该 worker 的逐次人工审批闸门,
 *     必须同时携带 confirm:true,并落审计(2026-10-28 审查 B-P1-3:此前委派可无
 *     confirm/无审计把 manual 抬成 auto,与 REST 面刻意的不变式矛盾);
 *   - 委派产生的绑定带 grantedByAgentId/grantedAt 溯源;撤销时 leader 只能撤
 *     「自己授予的」或「自己也持有的」绑定。
 * 校验全部 fail-closed:任何节点不满足 → 整单拒绝并列出明细,不做部分授予。
 */
import { AppError, ErrorCodes } from '../../../utils/errors'
import { getAgentNodeBindingRepo, type AgentNodeBinding, type AgentNodeBindingMode, type AgentNodeBindingKind } from './node-bindings.repo'
import { getToolApprovals } from './tool-approvals'
import { recordOps } from '../ops/ops'

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
  /** mode=auto 的风险确认(严格 === true;与 REST bindings PATCH 同语义) */
  confirm?: unknown
}

export interface DelegationPlanItem {
  nodeId: string
  kind: AgentNodeBindingKind
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
  const repoForExisting = getAgentNodeBindingRepo()
  const autoWithoutConfirm: string[] = []
  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) continue
    seen.add(nodeId)
    const held = leaderBindings.filter(b => b.nodeId === nodeId)
    if (!held.length) {
      missing.push(nodeId)
      continue
    }
    for (const h of held) {
      // mode 缺省 = manual(安全侧)。旧实现 `input.mode ?? h.mode` 会让 lead 的 auto
      // 静默下放给 worker,且没有 confirm 与审计 —— 委派面成了摘闸门的旁路。
      const targetMode: AgentNodeBindingMode = input.mode ?? 'manual'
      const existing = repoForExisting.find(targetAgentId, nodeId, h.kind)
      if (targetMode === 'auto' && existing?.mode !== 'auto') {
        if (input.confirm !== true) {
          autoWithoutConfirm.push(nodeId)
          continue
        }
      }
      grants.push({
        nodeId,
        kind: h.kind,
        mode: targetMode,
        tuning: h.tuning ? { ...h.tuning } : undefined,
      })
    }
  }
  if (missing.length) {
    throw new AppError(403, 'DELEGATION_NOT_OWNED', `以下节点不在 lead 的绑定面内,拒绝授予(权限不可超越授予者):${missing.join('、')}`)
  }
  if (autoWithoutConfirm.length) {
    throw new AppError(400, 'DELEGATION_MODE_CONFIRM_REQUIRED',
      `授予 auto 模式将摘除 worker 对这些节点的逐次人工审批闸门,需显式风险确认:`
      + `请在参数中携带 confirm: true(布尔)。涉及节点:${autoWithoutConfirm.join('、')}。`
      + `未做任何授权变更;如需保留人工审批,请改用 mode=manual(缺省值)。`)
  }
  return { targetAgentId, grants }
}

/** 执行授予:按计划逐条落库(已存在的绑定更新 mode/溯源,不重复建行) */
export function applyDelegation(plan: DelegationPlan, leaderAgentId: string): AgentNodeBinding[] {
  const repo = getAgentNodeBindingRepo()
  const out = plan.grants.map((g) => {
    const binding = repo.bind(plan.targetAgentId, g.nodeId, g.kind, g.mode, g.tuning, { grantedByAgentId: leaderAgentId })
    return binding
  })
  // B-P1-3:auto 授予必须留痕(与 REST bindings PATCH 的 binding.mode 审计同口径)
  const autoGrants = out.filter(b => b.mode === 'auto')
  if (autoGrants.length > 0) {
    recordOps({
      actor: leaderAgentId,
      actorName: `lead(${leaderAgentId})`,
      actorKind: 'agent',
      action: 'binding.mode',
      kind: 'system',
      summary: `委派授予 auto 控制模式:${autoGrants.map(b => `${b.kind}:${b.nodeId}`).join('、')}`,
      targetKind: 'agent_node_binding',
      targetId: autoGrants[0]!.id,
      detail: {
        targetAgentId: plan.targetAgentId,
        grantedByAgentId: leaderAgentId,
        grants: autoGrants.map(b => ({ bindingId: b.id, nodeId: b.nodeId, kind: b.kind, mode: b.mode })),
        confirm: true,
        source: 'team_grant_nodes',
      },
    })
  }
  return out
}

export interface DelegationRevokeInput {
  leaderAgentId: string
  targetAgentId: string
  nodeIds: string[]
  members: DelegationMember[]
}

/** 撤销授予:可撤「自己授予的」或「自己也持有的」绑定;两者都不是 → 拒绝该节点 */
export function revokeDelegation(input: DelegationRevokeInput): Array<{ nodeId: string, kind: AgentNodeBindingKind, revoked: boolean }> {
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
  const out: Array<{ nodeId: string, kind: AgentNodeBindingKind, revoked: boolean }> = []
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
      const revoked = repo.unbind(b.id)
      if (revoked) {
        // 收回即失活:挂起审批按拒绝收敛(配方绑定连带 recipe:/参数节点审批单)
        try {
          getToolApprovals().cancelPendingForBinding(targetAgentId, b)
        }
        catch { /* 审批服务未接线时不影响收权 */ }
      }
      out.push({ nodeId, kind: b.kind, revoked })
    }
  }
  return out
}

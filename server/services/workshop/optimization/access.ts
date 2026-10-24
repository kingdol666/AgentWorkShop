/**
 * Optimizer / Process-Model 统一操作授权(D16)。
 *
 * 口径:登录 + 角色只是入口;每一次资源读/写前必须经此函数判定"该主体能否触达该资源"。
 * 三类资源三种归属:
 *   - Profile:用户私有(owner_user_id;admin 全读) —— 配置管理权
 *   - 规格/数据集/资格/试验/训练:产线可见性(requireLineMode readonly) —— 产线配置权
 *   - 绑定/运行/建议/互校/下发/能力:Channel 成员(agent 实例归属) —— 成员调用权
 *
 * 授权性拒绝(403)统一写 1 条 `tool.call.denied` 审计(resource/op/actor/reason),
 * 与 grant-guard 同口径;/logs 可追溯越权尝试。404/422(资源不存在/形状非法)不算授权失败,不审计。
 *
 * 直接经 rest-auth 读 globalThis.__workshopManager:避免静态 import plugins/workshop,
 * 便于单测注入假管理器(与 rest-auth 同约束)。
 */
import { AppError } from '../../../utils/errors'
import type { ResolvedUser } from '../../../api/workshop/caller'
import { lineMode } from '../permissions'
import { recordOps } from '../ops/ops'
import { getProfileRepo } from './profile.repo'
import { getProcessModelSpecRepo } from '../process-model/spec.repo'
import { getAmlRuntime } from '../aml/runtime'
import { getBindingRepo } from './binding.repo'
import { getRunRepo } from './run.repo'
import { assertAgentAccess } from './rest-auth'

export type OptimizationOperation
  = | 'read' | 'write' | 'publish' | 'evaluate' | 'solve' | 'crosscheck' | 'dispatch' | 'cancel'

export type OptimizationResource
  = | { kind: 'profile', id: string, version?: number }
    | { kind: 'spec', id: string, version?: number }
    | { kind: 'dataset', id: string }
    | { kind: 'eligibility', specId: string }
    | { kind: 'experiment', lineId?: string }
    | { kind: 'train', lineId: string }
    | { kind: 'binding' | 'capabilities', agentInstanceId: string }
    | { kind: 'run' | 'recommendation' | 'crosscheck' | 'dispatch', runId?: string, agentInstanceId?: string }

export interface OptimizationAccessContext {
  lineId?: string
  agentInstanceId?: string
  channelId?: string
}

/** 授权性拒绝:先落审计再抛 403(审计失败不影响拒绝语义,与 grant-guard 同) */
function deny(user: ResolvedUser, resource: OptimizationResource, operation: OptimizationOperation, reason: string): never {
  try {
    recordOps({
      actor: user.id,
      actorName: user.name,
      actorKind: 'user',
      action: 'tool.call.denied',
      kind: 'system',
      level: 'warn',
      targetKind: 'optimizer',
      targetId: `${resource.kind}:${'id' in resource ? String(resource.id) : 'agentInstanceId' in resource ? String(resource.agentInstanceId) : 'runId' in resource ? String(resource.runId ?? '') : 'specId' in resource ? String(resource.specId) : ''}`,
      summary: `Optimizer 访问被拒(${resource.kind}/${operation}):${reason}`,
      detail: { resource: resource.kind, operation, reason, userId: user.id },
    })
  }
  catch { /* 审计失败不影响拒绝语义 */ }
  throw new AppError(403, 'AUTHZ_DENIED', reason)
}

/** Profile 可见性:owner 或 admin(列表过滤同口径,静默过滤不审计) */
export function canSeeProfile(user: ResolvedUser, row: { ownerUserId?: string, owner_user_id?: string } | undefined): boolean {
  if (!row) return false
  if (user.role === 'admin') return true
  const owner = row.ownerUserId ?? row.owner_user_id ?? ''
  return owner === user.id
}

function resolveSpecLineId(specId: string, version?: number): { lineId: string, ownerId: string } {
  const row = getProcessModelSpecRepo().get(specId, version)
  if (!row) throw new AppError(404, 'SPEC_NOT_FOUND', `ProcessModelSpec ${specId} 不存在`)
  return { lineId: row.lineId, ownerId: row.ownerUserId ?? '' }
}

function resolveDatasetLineId(datasetId: string): { lineId: string, ownerId: string } {
  let row: { lineId?: string, createdBy?: string } | undefined
  try {
    row = getAmlRuntime().repo.dataset.get(datasetId)
  }
  catch {
    // AML 未初始化(单测/插件未启动)→ 按不存在处理
    row = undefined
  }
  if (!row) throw new AppError(404, 'DATASET_NOT_FOUND', `数据集 ${datasetId} 不存在`)
  return { lineId: row.lineId ?? '', ownerId: row.createdBy ?? '' }
}

function resolveRunAgent(runId: string | undefined, agentInstanceId: string | undefined): string {
  if (agentInstanceId) return agentInstanceId
  if (!runId) throw new AppError(422, 'RUN_REF_REQUIRED', '必须提供 runId 或 agentInstanceId 以定位归属')
  const run = getRunRepo().getRun(runId)
  if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `运行 ${runId} 不存在`)
  const binding = getBindingRepo().get(run.bindingId)
  if (!binding) throw new AppError(404, 'BINDING_NOT_FOUND', `运行 ${runId} 的绑定 ${run.bindingId} 不存在`)
  return binding.channelAgentId
}

/**
 * 统一入口:返回解析后的资源上下文(行 lineId / agentInstanceId / channelId),
 * 供内层闸序(dispatch D10)消费,不得用另一套规则重算归属。
 */
export function assertOptimizationAccess(
  user: ResolvedUser,
  operation: OptimizationOperation,
  resource: OptimizationResource,
): OptimizationAccessContext {
  switch (resource.kind) {
    case 'profile': {
      const row = getProfileRepo().get(resource.id, resource.version)
      if (!row) throw new AppError(404, 'PROFILE_NOT_FOUND', `Profile ${resource.id} 不存在`)
      if (!canSeeProfile(user, row)) deny(user, resource, operation, `Profile ${resource.id} 不属于当前用户(仅 owner 或 admin 可访问)`)
      return { agentInstanceId: undefined }
    }
    case 'spec': {
      const { lineId } = resolveSpecLineId(resource.id, resource.version)
      try {
        lineMode(user, lineId)
      }
      catch (err) {
        deny(user, resource, operation, err instanceof AppError ? err.message : `无产线 ${lineId} 权限`)
      }
      return { lineId }
    }
    case 'dataset': {
      const { lineId } = resolveDatasetLineId(resource.id)
      try {
        lineMode(user, lineId)
      }
      catch (err) {
        deny(user, resource, operation, err instanceof AppError ? err.message : `无产线 ${lineId} 权限`)
      }
      return { lineId }
    }
    case 'eligibility': {
      const { lineId } = resolveSpecLineId(resource.specId)
      try {
        lineMode(user, lineId)
      }
      catch (err) {
        deny(user, resource, operation, err instanceof AppError ? err.message : `无产线 ${lineId} 权限`)
      }
      return { lineId }
    }
    case 'experiment': {
      const lineId = resource.lineId
      if (!lineId) throw new AppError(422, 'LINE_REQUIRED', 'lineId 必填(试验按产线归属授权)')
      try {
        lineMode(user, lineId)
      }
      catch (err) {
        deny(user, resource, operation, err instanceof AppError ? err.message : `无产线 ${lineId} 权限`)
      }
      return { lineId }
    }
    case 'train': {
      try {
        lineMode(user, resource.lineId)
      }
      catch (err) {
        deny(user, resource, operation, err instanceof AppError ? err.message : `无产线 ${resource.lineId} 权限`)
      }
      return { lineId: resource.lineId }
    }
    case 'binding':
    case 'capabilities': {
      const { channelId } = assertAgentAccess(user, resource.agentInstanceId, { manage: operation === 'write' })
      return { agentInstanceId: resource.agentInstanceId, channelId }
    }
    case 'run':
    case 'recommendation':
    case 'crosscheck':
    case 'dispatch': {
      const agentInstanceId = resolveRunAgent(resource.runId, resource.agentInstanceId)
      const { channelId } = assertAgentAccess(user, agentInstanceId)
      return { agentInstanceId, channelId }
    }
  }
}

/** 配置动作审计(SW1.6):每次成功变更恰 1 条,actor 恒为发起用户 */
export function recordConfigAction(
  user: ResolvedUser,
  action: string,
  target: { kind: string, id: string },
  summary: string,
  detail: Record<string, unknown> = {},
  lineId?: string,
): void {
  try {
    recordOps({
      actor: user.id,
      actorName: user.name,
      actorKind: 'user',
      action,
      kind: 'line',
      level: 'info',
      targetKind: target.kind,
      targetId: target.id,
      lineId: lineId ?? '',
      summary,
      detail: { ...detail, userId: user.id },
    })
  }
  catch { /* 审计失败不阻断业务 */ }
}

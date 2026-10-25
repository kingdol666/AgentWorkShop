/**
 * 绑定服务(G4.1/G4.2):
 *  - 实例身份纪律:只接受 channel_agents.id;传 templates(agents.id)明确拒绝;
 *  - 作用域校验:channel 必须属于 workspace,agent 必须属于该 channel;
 *  - 多绑定:solve 未带 bindingId → BINDING_AMBIGUOUS;带他人 binding → BINDING_NOT_OWNED;
 *  - 逐次重校验:有效期/profile 状态/模型阶段/成员存在 → BINDING_STALE。
 */
import { AppError } from '../../../utils/errors'
import { getAmlRuntime } from '../aml/runtime'
import type { BindingMode } from './contracts'
import { BINDING_ERRORS, OPTIMIZER_CAPABILITIES } from './contracts'
import { getBindingRepo, type BindingRow } from './binding.repo'
import { getProfileRepo } from './profile.repo'
import { acquireModelLease, type ModelLease } from '../aml/model-references'

export interface CreateBindingInput {
  workspaceId: string
  channelId: string
  /** channel_agents.id(实例);传 agents.id(模板)会被拒绝 */
  agentInstanceId: string
  profileId: string
  profileVersion: number
  capabilities?: string[]
  mode?: BindingMode
  validTo?: string | null
  createdBy?: string
}

export interface ResolvedBinding {
  binding: BindingRow
  profileId: string
  profileVersion: number
  lease: ModelLease
}

function db() {
  return getAmlRuntime().db
}

/** 实例身份解析:拒绝模板 id;返回 channel_agents 行。 */
export function requireAgentInstance(agentId: string): { id: string, channelId: string, name: string } {
  const row = db().prepare('SELECT id, channel_id AS channelId, name FROM channel_agents WHERE id = ?').get(agentId) as { id: string, channelId: string, name: string } | undefined
  if (row) return row
  const template = db().prepare('SELECT id FROM agents WHERE id = ?').get(agentId) as { id: string } | undefined
  if (template) {
    throw new AppError(422, BINDING_ERRORS.TEMPLATE_ID,
      `传入的是 Agent 模板 id(${agentId});绑定必须使用 Channel 实例 id(channel_agents.id)。可用:SELECT id, name FROM channel_agents WHERE channel_id = ?`)
  }
  throw new AppError(404, BINDING_ERRORS.NOT_FOUND, `Agent 实例 ${agentId} 不存在`)
}

export function createBinding(input: CreateBindingInput): BindingRow {
  const instance = requireAgentInstance(input.agentInstanceId)
  if (instance.channelId !== input.channelId) {
    throw new AppError(422, BINDING_ERRORS.CHANNEL_MISMATCH, `Agent 实例属于 Channel ${instance.channelId},与绑定 Channel ${input.channelId} 不一致`)
  }
  const wsChannel = db().prepare('SELECT 1 AS ok FROM workspace_channels WHERE workspace_id = ? AND channel_id = ?').get(input.workspaceId, input.channelId)
  if (!wsChannel) {
    throw new AppError(422, BINDING_ERRORS.WORKSPACE_MISMATCH, `Channel ${input.channelId} 不属于 workspace ${input.workspaceId}`)
  }
  const profile = getProfileRepo().get(input.profileId, input.profileVersion)
  if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND', `Profile ${input.profileId}@${input.profileVersion} 不存在`)
  if (profile.status !== 'published') throw new AppError(409, 'PROFILE_NOT_PUBLISHED', `Profile ${input.profileId}@${input.profileVersion} 状态为 ${profile.status};绑定只接受 published`)
  const capabilities = input.capabilities?.length ? input.capabilities : [...OPTIMIZER_CAPABILITIES]
  const invalid = capabilities.filter(c => !(OPTIMIZER_CAPABILITIES as readonly string[]).includes(c))
  if (invalid.length) throw new AppError(422, 'BINDING_CAPABILITY_INVALID', `未知能力:${invalid.join(', ')}`)
  const id = `ob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  return getBindingRepo().insert({
    id, workspaceId: input.workspaceId, channelId: input.channelId, channelAgentId: input.agentInstanceId,
    profileId: input.profileId, profileVersion: input.profileVersion, capabilities,
    mode: input.mode ?? 'recommendation', validTo: input.validTo ?? null, createdBy: input.createdBy ?? '',
  })
}

export function listBindingsForAgent(agentId: string): BindingRow[] {
  return getBindingRepo().listByAgent(agentId)
}

/**
 * 解析本次调用的绑定:
 *  - 无 bindingId 且仅 1 个 → 默认;多个 → BINDING_AMBIGUOUS;
 *  - bindingId 不属于该实例 → BINDING_NOT_OWNED;
 *  - 过期/profile 退役/模型阶段不合格 → BINDING_STALE。
 * 返回的 lease 必须由调用方 release(阻止工件 GC)。
 */
export function resolveBinding(agentId: string, bindingId?: string): ResolvedBinding {
  const bindings = listBindingsForAgent(agentId)
  if (!bindings.length) throw new AppError(409, BINDING_ERRORS.NOT_FOUND, '该 Agent 未绑定任何优化器 Profile;先在 Channel 设置里绑定')
  const selected: BindingRow | undefined = bindingId
    ? bindings.find(b => b.id === bindingId)
    : bindings.length === 1 ? bindings[0] : undefined
  if (!selected) {
    if (bindingId) throw new AppError(403, BINDING_ERRORS.NOT_OWNED, `binding ${bindingId} 不属于当前 Agent(${agentId})`)
    throw new AppError(409, BINDING_ERRORS.AMBIGUOUS, `该 Agent 有 ${bindings.length} 个绑定;调用必须显式传 binding_id(${bindings.map(b => b.id).join(', ')})`)
  }
  const binding: BindingRow = selected

  const now = Date.now()
  if (binding.validFrom && Date.parse(binding.validFrom) > now) {
    throw new AppError(409, BINDING_ERRORS.STALE, `binding ${binding.id} 尚未生效(validFrom=${binding.validFrom})`)
  }
  if (binding.validTo && Date.parse(binding.validTo) <= now) {
    throw new AppError(409, BINDING_ERRORS.STALE, `binding ${binding.id} 已过有效期(validTo=${binding.validTo})`)
  }
  const profile = getProfileRepo().get(binding.profileId, binding.profileVersionNumber)
  if (!profile || profile.status === 'retired') {
    throw new AppError(409, BINDING_ERRORS.STALE, `binding ${binding.id} 引用的 Profile 已退役或不存在`)
  }
  const model = db().prepare('SELECT stage FROM aml_models WHERE id = ?').get(profile.modelRef) as { stage: string } | undefined
  if (!model || model.stage === 'retired') {
    throw new AppError(409, BINDING_ERRORS.STALE, `binding ${binding.id} 引用的模型 ${profile.modelRef} 不存在或已退役`)
  }
  const instance = db().prepare('SELECT 1 AS ok FROM channel_agents WHERE id = ?').get(agentId)
  if (!instance) throw new AppError(409, BINDING_ERRORS.STALE, '当前 Agent 实例已被删除')
  const lease = acquireModelLease(profile.modelRef, `binding:${binding.id}`)
  return { binding, profileId: binding.profileId, profileVersion: binding.profileVersionNumber, lease }
}

export function revokeBinding(bindingId: string, actor: string, actorName = actor): boolean {
  const row = getBindingRepo().get(bindingId)
  if (!row) return false
  getBindingRepo().remove(bindingId)
  void import('../ops/ops').then(({ recordOps }) => recordOps({
    actor, actorName, actorKind: 'user', action: 'optimizer.binding.revoke', kind: 'write',
    summary: `撤销优化器绑定 ${bindingId}(profile ${row.profileVersion})`, targetKind: 'optimizer_binding', targetId: bindingId,
  })).catch(() => {})
  return true
}

/**
 * 运行时解析：从持久化成员 + 发布 revision + 平台 registry 计算一份有效能力。
 * 所有调用方（prompt、catalog、dispatch、Skill 激活）共享同一结果；dispatch 仍会在
 * 执行瞬间重新解析，以撤销/停用/成员状态变化即时生效。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ChannelAgentRow } from '../db/database'
import { createChannelAgentRepo } from '../db/channel-agent.repo'
import { createAgentPrefabService, parseAgentPrefabBinding } from './service'
import { buildCapabilityRegistry } from './registry'
import { resolveAgentCapabilitySet } from './resolution'
import { getPolicySnapshot } from '../tools/policy'
import type { AgentCapabilityResolution, AgentPrefabBinding, AgentPrefabDraft } from './types'

export interface ResolvedAgentRuntime {
  member: ChannelAgentRow
  binding: AgentPrefabBinding | null
  resolution: AgentCapabilityResolution
  draft: AgentPrefabDraft | null
  bindingError?: string
}

function emptyPrefabResolution(reason: string): AgentCapabilityResolution {
  return {
    mode: 'prefab',
    bindingHash: null,
    toolIds: [],
    skillIds: [],
    active: [],
    disabled: [],
    missing: [],
    denied: [],
    unsupported: [],
    reasons: { __prefab__: reason },
    prompt: { role: '', scenario: '', slots: [] },
    slotErrors: [],
    requiredMissing: ['__prefab__'],
  }
}

export function resolveRuntimeForAgent(db: DatabaseSync, agentId: string): ResolvedAgentRuntime | null {
  const memberRow = createChannelAgentRepo(db).findById(agentId)
  if (!memberRow) return null

  let binding: AgentPrefabBinding | null = null
  let bindingError: string | undefined
  try {
    binding = parseAgentPrefabBinding(memberRow.prefabBindingJson)
  }
  catch (err) {
    bindingError = err instanceof Error ? err.message : String(err)
  }
  if (bindingError) {
    return { member: memberRow, binding: null, resolution: emptyPrefabResolution(bindingError), draft: null, bindingError }
  }

  const service = createAgentPrefabService(db)
  const loaded = binding ? service.loadRevision(binding.prefabId, binding.revision) : null
  const bundle = buildCapabilityRegistry(memberRow.channelId)
  const policy = getPolicySnapshot(memberRow.channelId)
  const channelPolicy = {
    mode: policy.mode,
    enabledToolIds: policy.mode === 'selected'
      ? [...policy.settings.entries()].filter(([, enabled]) => enabled === true).map(([name]) => name)
      : null,
    disabledToolIds: [...policy.settings.entries()].filter(([, enabled]) => enabled === false).map(([name]) => name),
  }
  const resolution = resolveAgentCapabilitySet({
    binding,
    member: {
      id: memberRow.id,
      channelId: memberRow.channelId,
      role: memberRow.role === 'lead' ? 'lead' : 'worker',
      harness: memberRow.harness,
    },
    channelPolicy,
    projectScope: null,
    harness: { managedToolIds: bundle.managedToolIds, managedSkillIds: bundle.managedSkillIds },
    registry: bundle.registry,
    prefab: loaded?.draft ?? null,
    slotValues: binding?.slotValues,
  })
  return { member: memberRow, binding, resolution, draft: loaded?.draft ?? null }
}

/** 供 host-tool 目录/dispatch 使用的全局入口（manager 尚未初始化时返回 null）。 */
export function resolveRuntimeForAgentGlobal(agentId: string): ResolvedAgentRuntime | null {
  const db = (globalThis as { __workshopManager?: { deps?: { db?: DatabaseSync } } }).__workshopManager?.deps?.db
  return db ? resolveRuntimeForAgent(db, agentId) : null
}

/** legacy 模式 = 不限制；prefab 模式只允许解析出的 toolIds */
export function prefabAllowsTool(resolution: AgentCapabilityResolution, toolName: string): boolean {
  if (resolution.mode === 'legacy') return true
  return resolution.toolIds.includes(toolName)
}

/** 需要阻断新作业的条件（required 缺失 / slot 必填缺失 / revision 缺失） */
export function prefabBlockedReason(resolution: AgentCapabilityResolution): string | null {
  if (resolution.mode !== 'prefab') return null
  if (resolution.requiredMissing.length === 0 && resolution.slotErrors.length === 0) return null
  return `AgentPrefab 必需能力/插槽不可用：${[...resolution.requiredMissing, ...resolution.slotErrors].join('; ')}`
}

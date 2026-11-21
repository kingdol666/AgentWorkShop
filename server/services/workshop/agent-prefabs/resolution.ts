/**
 * AgentPrefab 有效能力解析（纯函数，无 I/O）。
 *
 * 规则：
 *  - 无 binding → legacy，不改变现有工具面；
 *  - 有 binding 但 revision/快照缺失 → prefab 模式且 requiredMissing 含 __prefab__，由 runtime fail closed；
 *  - 能力 = prefab 选择 ∩ 系统 registry enabled/reviewed ∩ Channel/Project 策略 ∩ 当前 harness 受管能力；
 *  - 平台基础协作/任务工具始终保留（但仍受 Channel/Project 策略约束）；
 *  - slot 只按发布定义校验/限长，不允许覆盖系统指令或授权。
 */
import { LEAD_ONLY_TOOL_NAMES } from '../agents/tool-classes'
import { BindingSlotError, validateBindingSlots } from './service'
import type {
  AgentCapabilityInput,
  AgentCapabilityResolution,
  CapabilityState,
  PrefabCapabilityRef,
  PrefabCapabilityRegistryEntry,
} from './types'

/** 平台基础协作/任务面（与 host-tool-bridge 的 OBSERVER_COLLAB_TOOL_NAMES 同源；测试锁定一致性） */
export const PREFAB_BASELINE_TOOL_IDS = [
  'send_message_to_agent',
  'broadcast_message',
  'poll_messages',
  'read_channel_mail',
  'list_other_teams',
  'save_memory',
  'search_memory',
  'search_other_teams_memory',
  'send_cross_channel_message',
  'submit_task',
  'complete_task',
  'supersede_task',
  'report_progress',
  'refuse_task',
  'cancel_task',
  'get_my_task_queue',
  'get_task_details',
  'list_channel_tasks',
  'list_team_agents',
  'activate_skill',
]

const TOOL_KINDS = new Set(['tool', 'plugin-tool', 'mcp-tool'])

function state(ref: PrefabCapabilityRef, reason?: string): CapabilityState {
  return { kind: ref.kind, id: ref.id, label: ref.label, reason }
}

function registryKey(kind: string, id: string): string {
  return `${kind}:${id}`
}

function channelAllows(input: AgentCapabilityInput, id: string): boolean {
  if (Array.isArray(input.channelPolicy.disabledToolIds) && input.channelPolicy.disabledToolIds.includes(id)) return false
  if (input.channelPolicy.mode !== 'selected') return true
  return Array.isArray(input.channelPolicy.enabledToolIds)
    ? input.channelPolicy.enabledToolIds.includes(id)
    : false
}

function projectAllows(input: AgentCapabilityInput, id: string): boolean {
  const allowed = input.projectScope?.allowedToolIds
  if (allowed === undefined || allowed === null) return true
  return allowed.includes(id)
}

function harnessSupports(input: AgentCapabilityInput, ref: PrefabCapabilityRef): boolean {
  if (ref.kind === 'skill') {
    return input.harness.managedSkillIds !== null && input.harness.managedSkillIds.includes(ref.id)
  }
  return input.harness.managedToolIds !== null && input.harness.managedToolIds.includes(ref.id)
}

function roleAllows(input: AgentCapabilityInput, id: string, entry?: PrefabCapabilityRegistryEntry): boolean {
  const { role } = input.member
  return (role === 'lead' || !LEAD_ONLY_TOOL_NAMES.has(id)) && (entry?.roles?.includes(role) ?? true)
}

export function resolveAgentCapabilitySet(input: AgentCapabilityInput): AgentCapabilityResolution {
  const empty: AgentCapabilityResolution = {
    mode: 'legacy',
    bindingHash: null,
    toolIds: [],
    skillIds: [],
    active: [],
    disabled: [],
    missing: [],
    denied: [],
    unsupported: [],
    reasons: {},
    prompt: { role: '', scenario: '', slots: [] },
    slotErrors: [],
    requiredMissing: [],
  }
  if (!input.binding) return empty

  const bindingHash = input.binding.contentHash
  if (!input.prefab) {
    return {
      ...empty,
      mode: 'prefab',
      bindingHash,
      reasons: { __prefab__: 'prefab revision 快照缺失或已撤销' },
      requiredMissing: ['__prefab__'],
    }
  }

  const prefab = input.prefab
  let slotValues: Record<string, string>
  try {
    slotValues = validateBindingSlots(prefab, input.slotValues ?? input.binding.slotValues, true)
  }
  catch (err) {
    const required = err instanceof BindingSlotError && prefab.prompt.slots.some(slot => slot.key === err.slotKey && slot.required)
    return {
      ...empty,
      mode: 'prefab',
      bindingHash,
      slotErrors: [err instanceof Error ? err.message : String(err)],
      requiredMissing: required ? [`slot:${err.slotKey}`] : [],
    }
  }

  const active: CapabilityState[] = []
  const disabled: CapabilityState[] = []
  const missing: CapabilityState[] = []
  const denied: CapabilityState[] = []
  const unsupported: CapabilityState[] = []
  const reasons: Record<string, string> = {}
  const requiredMissing: string[] = []
  const toolIds = new Set<string>()
  const skillIds = new Set<string>()

  for (const ref of input.prefab.capabilities) {
    const key = registryKey(ref.kind, ref.id)
    const entry = input.registry[key]
    if (!entry) {
      missing.push(state(ref, 'registry 中不存在'))
      reasons[key] = 'registry 中不存在'
    }
    else if (ref.version !== undefined && ref.version !== entry.version) {
      missing.push(state(ref, 'registry 能力版本不匹配'))
      reasons[key] = 'registry 能力版本不匹配'
    }
    else if (!entry.enabled) {
      disabled.push(state(ref, '系统已停用'))
      reasons[key] = '系统已停用'
    }
    else if (entry.reviewStatus && entry.reviewStatus !== 'approved') {
      disabled.push(state(ref, `审阅状态 ${entry.reviewStatus}`))
      reasons[key] = `审阅状态 ${entry.reviewStatus}`
    }
    else if (TOOL_KINDS.has(ref.kind) && (!roleAllows(input, ref.id, entry) || !roleAllows(input, entry.id))) {
      denied.push(state(ref, '成员角色不允许'))
      reasons[key] = '成员角色不允许'
    }
    else if (TOOL_KINDS.has(ref.kind) && !channelAllows(input, ref.id)) {
      denied.push(state(ref, 'Channel 工具策略不允许'))
      reasons[key] = 'Channel 工具策略不允许'
    }
    else if (TOOL_KINDS.has(ref.kind) && !projectAllows(input, ref.id)) {
      denied.push(state(ref, 'Project 作用域不允许'))
      reasons[key] = 'Project 作用域不允许'
    }
    else if (!harnessSupports(input, ref)) {
      unsupported.push(state(ref, '当前 harness 未声明受管支持'))
      reasons[key] = '当前 harness 未声明受管支持'
    }
    else {
      active.push(state(ref))
      if (ref.kind === 'skill') skillIds.add(ref.id)
      else toolIds.add(ref.id)
      continue
    }
    if (ref.required) requiredMissing.push(key)
  }

  // 基础协作工具不占选择名额，但显式引用失败时不借 baseline 回退。
  for (const id of PREFAB_BASELINE_TOOL_IDS) {
    if (prefab.capabilities.some(ref => TOOL_KINDS.has(ref.kind) && (ref.id === id || input.registry[registryKey(ref.kind, ref.id)]?.id === id))) continue
    if (!roleAllows(input, id, input.registry[registryKey('tool', id)]) || !channelAllows(input, id) || !projectAllows(input, id)) continue
    toolIds.add(id)
  }
  // 预置 Skill 才暴露激活工具；无 Skill 时不额外暴露
  if (skillIds.size === 0) toolIds.delete('activate_skill')

  return {
    mode: 'prefab',
    bindingHash,
    toolIds: [...toolIds].sort(),
    skillIds: [...skillIds].sort(),
    active,
    disabled,
    missing,
    denied,
    unsupported,
    reasons,
    prompt: {
      role: prefab.prompt.role ?? '',
      scenario: prefab.prompt.scenario ?? '',
      slots: prefab.prompt.slots.map(slot => ({
        key: slot.key,
        label: slot.label,
        text: Object.hasOwn(slotValues, slot.key) ? slotValues[slot.key]! : '',
      })),
    },
    slotErrors: [],
    requiredMissing: [...new Set(requiredMissing)].sort(),
  }
}

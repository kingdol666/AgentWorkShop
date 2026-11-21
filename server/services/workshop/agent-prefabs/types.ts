/**
 * AgentPrefab 领域类型：草稿、不可变 revision、成员绑定与运行时能力解析契约。
 * prefab 只缩小能力，不授予平台/工业权限；凭据、命令行与任意代码不允许进入快照。
 */

export type PrefabVisibility = 'private' | 'public'
export type PrefabCapabilityKind = 'tool' | 'plugin-tool' | 'skill' | 'mcp-tool'

export interface PrefabPromptSlot {
  /** 稳定 key（发布后不可改语义；成员绑定按 key 取值） */
  key: string
  label: string
  description?: string
  defaultValue?: string
  required?: boolean
  allowMemberOverride?: boolean
  /** 默认 4000；上限 20000 */
  maxLength?: number
}

export interface PrefabPrompt {
  /** 角色提示（低信任业务指导） */
  role?: string
  /** 场景提示 */
  scenario?: string
  slots: PrefabPromptSlot[]
}

/** 仅允许成员当前 harness 支持的可校验运行时字段 */
export interface PrefabRuntimeProfile {
  provider?: string
  model?: string
  effort?: string
  /** 标量设置白名单；禁止 command/args/env/cwd/extension 等启动面 */
  settings?: Record<string, string | number | boolean>
}

export interface PrefabCapabilityRef {
  kind: PrefabCapabilityKind
  /** tool/plugin-tool 为注册名；skill 为受管 revision id/name；mcp-tool 为 exposedName */
  id: string
  /** skill: 完整 content hash；mcp-tool: schema hash；tool: 可选定义 hash */
  version?: string
  required?: boolean
  label?: string
}

export interface AgentPrefabDraft {
  name: string
  description: string
  visibility: PrefabVisibility
  prompt: PrefabPrompt
  profile: PrefabRuntimeProfile
  capabilities: PrefabCapabilityRef[]
}

export interface AgentPrefabRevisionSnapshot {
  schemaVersion: 1
  draft: AgentPrefabDraft
}

export interface AgentPrefabRow {
  id: string
  name: string
  description: string
  visibility: PrefabVisibility
  ownerUserId: string | null
  draftJson: string
  headRevision: number
  createdAt: string
  updatedAt: string
}

export interface AgentPrefabRevisionRow {
  prefabId: string
  revision: number
  snapshotJson: string
  contentHash: string
  createdAt: string
  createdBy: string
}

/** 请求只选择已发布版本；哈希由服务端生成，不接受客户端提供的 binding。 */
export interface AgentPrefabSelector {
  prefabId: string
  revision: number
  slotValues?: Record<string, string>
}

/** 成员绑定：固定 revision + 成员 slot 值 + 发布内容 hash */
export interface AgentPrefabBinding {
  prefabId: string
  revision: number
  slotValues: Record<string, string>
  contentHash: string
}

/** 运行时能力解析输入（全部来自可信服务端上下文） */
export interface PrefabCapabilityRegistryEntry {
  kind: PrefabCapabilityKind
  id: string
  enabled: boolean
  /** 权威版本：Skill content hash / MCP schema hash；未提供版本的条目不能匹配固定版本引用 */
  version?: string
  roles?: readonly AgentCapabilityInput['member']['role'][]
  /** MCP/Skill 需 approved；普通工具可省略 */
  reviewStatus?: 'approved' | 'pending' | 'rejected'
  label?: string
}

export interface AgentCapabilityInput {
  binding: AgentPrefabBinding | null
  member: { id: string, channelId: string, role: 'lead' | 'worker', harness: string }
  channelPolicy: { mode: 'all' | 'selected', enabledToolIds?: string[] | null, disabledToolIds?: string[] | null }
  projectScope: { allowedToolIds?: string[] | null, leader?: boolean } | null
  harness: { managedToolIds: string[] | null, managedSkillIds: string[] | null }
  registry: Record<string, PrefabCapabilityRegistryEntry>
  /** binding 对应的已发布草稿（由可信仓储加载） */
  prefab: AgentPrefabDraft | null
  slotValues?: Record<string, string>
}

export interface CapabilityState {
  kind: PrefabCapabilityKind
  id: string
  label?: string
  reason?: string
}

export interface AgentCapabilityResolution {
  mode: 'legacy' | 'prefab'
  bindingHash: string | null
  /** 生效的工具名（含平台基础协作工具；仅 prefab 模式有约束） */
  toolIds: string[]
  /** 生效的 Skill revision id */
  skillIds: string[]
  active: CapabilityState[]
  disabled: CapabilityState[]
  missing: CapabilityState[]
  denied: CapabilityState[]
  unsupported: CapabilityState[]
  reasons: Record<string, string>
  prompt: { role: string, scenario: string, slots: Array<{ key: string, label: string, text: string }> }
  slotErrors: string[]
  requiredMissing: string[]
}

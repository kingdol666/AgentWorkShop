/**
 * AgentPrefab 服务：草稿校验、可见性/编辑权限、发布、成员绑定快照。
 *
 * 所有输入先经结构校验（名称/插槽/能力引用/profile 白名单），
 * 发布快照不含 secret/命令/任意代码；binding 固定 revision + contentHash。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createAgentPrefabRepo, prefabSnapshotHash, type AgentPrefabRepo } from '../db/agent-prefab.repo'
import type {
  AgentPrefabBinding,
  AgentPrefabDraft,
  AgentPrefabRevisionRow,
  AgentPrefabRow,
  PrefabCapabilityKind,
  PrefabCapabilityRef,
  PrefabPromptSlot,
  PrefabRuntimeProfile,
} from './types'
import { AppError } from '../../../utils/errors'

const SLOT_KEY_RE = /^[a-z][a-z0-9_-]{1,31}$/
const SETTING_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{1,63}$/
const FORBIDDEN_SETTING_KEYS = /^(command|args|env|cwd|extension|shell|exec|token|secret|password|apikey|api_key)$/i
const CAPABILITY_KINDS = new Set<PrefabCapabilityKind>(['tool', 'plugin-tool', 'skill', 'mcp-tool'])

export interface PrefabActor { id: string, role?: string }

/** Bind-only principal derived from the channel row after checking the current lead. */
export interface ChannelLeadPrefabUse { kind: 'channel-lead', channelOwnerUserId: string | null }

function isAdmin(actor: PrefabActor): boolean {
  return actor.role === 'admin'
}

function assertVisible(row: AgentPrefabRow, actor: PrefabActor): void {
  if (isAdmin(actor) || row.visibility === 'public' || row.ownerUserId === actor.id) return
  throw new AppError(403, 'PREFAB_FORBIDDEN', '无权访问该 AgentPrefab')
}

export function canEditAgentPrefab(row: AgentPrefabRow, actor: PrefabActor): boolean {
  return !row.archivedAt && (isAdmin(actor) || row.ownerUserId === actor.id)
}

function assertActive(row: AgentPrefabRow): void {
  if (row.archivedAt) throw new AppError(409, 'PREFAB_ARCHIVED', 'AgentPrefab 已归档，不能编辑、发布或用于新的绑定')
}

function assertEditable(row: AgentPrefabRow, actor: PrefabActor): void {
  if (!isAdmin(actor) && row.ownerUserId !== actor.id) {
    throw new AppError(403, 'PREFAB_OWNER_REQUIRED', '仅所有者或管理员可编辑 AgentPrefab')
  }
  assertActive(row)
}

function asString(value: unknown, field: string, max: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new AppError(400, 'VALIDATION_ERROR', `${field} 必填`)
    return ''
  }
  if (typeof value !== 'string') throw new AppError(400, 'VALIDATION_ERROR', `${field} 必须是字符串`)
  const text = value.trim()
  if (required && !text) throw new AppError(400, 'VALIDATION_ERROR', `${field} 必填`)
  if (text.length > max) throw new AppError(400, 'VALIDATION_ERROR', `${field} 最多 ${max} 字符`)
  return text
}

function validateSlots(raw: unknown): PrefabPromptSlot[] {
  if (!Array.isArray(raw)) throw new AppError(400, 'VALIDATION_ERROR', 'prompt.slots 必须是数组')
  if (raw.length > 20) throw new AppError(400, 'VALIDATION_ERROR', 'prompt.slots 最多 20 个')
  const keys = new Set<string>()
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError(400, 'VALIDATION_ERROR', `slots[${index}] 必须是对象`)
    const slot = item as Record<string, unknown>
    const key = asString(slot.key, `slots[${index}].key`, 32, true)
    if (!SLOT_KEY_RE.test(key)) throw new AppError(400, 'VALIDATION_ERROR', `slots[${index}].key 必须为小写字母/数字/下划线/连字符`)
    if (keys.has(key)) throw new AppError(400, 'VALIDATION_ERROR', `slot key 重复：${key}`)
    keys.add(key)
    const maxLength = slot.maxLength === undefined ? 4000 : Number(slot.maxLength)
    if (!Number.isFinite(maxLength) || maxLength < 1 || maxLength > 20_000) {
      throw new AppError(400, 'VALIDATION_ERROR', `slots[${index}].maxLength 必须在 1-20000`)
    }
    const defaultValue = asString(slot.defaultValue, `slots[${index}].defaultValue`, Math.floor(maxLength))
    return {
      key,
      label: asString(slot.label, `slots[${index}].label`, 80, true),
      description: asString(slot.description, `slots[${index}].description`, 500),
      defaultValue,
      required: slot.required === true,
      allowMemberOverride: slot.allowMemberOverride !== false,
      maxLength: Math.floor(maxLength),
    }
  })
}

function validateProfile(raw: unknown): PrefabRuntimeProfile {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'VALIDATION_ERROR', 'profile 必须是对象')
  const input = raw as Record<string, unknown>
  const out: PrefabRuntimeProfile = {}
  for (const key of ['provider', 'model', 'effort'] as const) {
    if (input[key] !== undefined) out[key] = asString(input[key], `profile.${key}`, 200)
  }
  if (input.settings !== undefined) {
    if (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'profile.settings 必须是标量映射')
    }
    const entries = Object.entries(input.settings as Record<string, unknown>)
    if (entries.length > 30) throw new AppError(400, 'VALIDATION_ERROR', 'profile.settings 最多 30 项')
    const settings: Record<string, string | number | boolean> = {}
    for (const [key, value] of entries) {
      if (!SETTING_KEY_RE.test(key) || FORBIDDEN_SETTING_KEYS.test(key)) {
        throw new AppError(400, 'VALIDATION_ERROR', `profile.settings 键不允许：${key}`)
      }
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new AppError(400, 'VALIDATION_ERROR', `profile.settings.${key} 必须是标量`)
      }
      if (typeof value === 'string' && value.length > 500) throw new AppError(400, 'VALIDATION_ERROR', `profile.settings.${key} 过长`)
      settings[key] = value
    }
    out.settings = settings
  }
  return out
}

function validateCapabilities(raw: unknown): PrefabCapabilityRef[] {
  if (!Array.isArray(raw)) throw new AppError(400, 'VALIDATION_ERROR', 'capabilities 必须是数组')
  if (raw.length > 100) throw new AppError(400, 'VALIDATION_ERROR', 'capabilities 最多 100 项')
  const seen = new Set<string>()
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError(400, 'VALIDATION_ERROR', `capabilities[${index}] 必须是对象`)
    const ref = item as Record<string, unknown>
    const kind = ref.kind as PrefabCapabilityKind
    if (!CAPABILITY_KINDS.has(kind)) throw new AppError(400, 'VALIDATION_ERROR', `capabilities[${index}].kind 非法`)
    const id = asString(ref.id, `capabilities[${index}].id`, 200, true)
    const key = `${kind}:${id}`
    if (seen.has(key)) throw new AppError(400, 'VALIDATION_ERROR', `能力重复：${key}`)
    seen.add(key)
    return {
      kind,
      id,
      version: ref.version === undefined ? undefined : asString(ref.version, `capabilities[${index}].version`, 128),
      required: ref.required === true,
      label: ref.label === undefined ? undefined : asString(ref.label, `capabilities[${index}].label`, 80),
    }
  })
}

export function validatePrefabDraft(raw: unknown): AgentPrefabDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'VALIDATION_ERROR', 'draft 必须是对象')
  const input = raw as Record<string, unknown>
  const visibility = input.visibility === 'public' ? 'public' : 'private'
  const prompt = input.prompt && typeof input.prompt === 'object' && !Array.isArray(input.prompt)
    ? input.prompt as Record<string, unknown>
    : {}
  return {
    name: asString(input.name, 'name', 80, true),
    description: asString(input.description, 'description', 2000),
    visibility,
    prompt: {
      role: asString(prompt.role, 'prompt.role', 20_000),
      scenario: asString(prompt.scenario, 'prompt.scenario', 20_000),
      slots: validateSlots(prompt.slots ?? []),
    },
    profile: validateProfile(input.profile),
    capabilities: validateCapabilities(input.capabilities ?? []),
  }
}

function parseDraft(row: AgentPrefabRow): AgentPrefabDraft {
  try {
    return validatePrefabDraft(JSON.parse(row.draftJson))
  }
  catch (err) {
    throw new AppError(500, 'PREFAB_DRAFT_CORRUPT', `AgentPrefab 草稿损坏：${err instanceof Error ? err.message : String(err)}`)
  }
}

export class BindingSlotError extends AppError {
  constructor(readonly slotKey: string, message: string) {
    super(400, 'VALIDATION_ERROR', message)
  }
}

/** 绑定 slot 值：只允许声明 key，required 必须非空，限长；返回规范值 */
export function validateBindingSlots(draft: AgentPrefabDraft, raw: unknown, persisted = false): Record<string, string> {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'VALIDATION_ERROR', 'slotValues 必须是对象')
  const values = raw as Record<string, unknown>
  const declared = new Map(draft.prompt.slots.map(s => [s.key, s]))
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) throw new BindingSlotError(key, `未声明的 slot：${key}`)
  }
  const out: Record<string, string> = {}
  for (const slot of draft.prompt.slots) {
    const provided = Object.hasOwn(values, slot.key) ? values[slot.key] : undefined
    if (provided !== undefined && typeof provided !== 'string') throw new BindingSlotError(slot.key, `slotValues.${slot.key} 必须是字符串`)
    // 旧 binding 持久化了展开后的默认值；只接受与发布快照完全相等的锁定值。
    if (provided !== undefined && slot.allowMemberOverride === false && !(persisted && provided === slot.defaultValue)) {
      throw new BindingSlotError(slot.key, `slot ${slot.key} 不允许成员覆盖`)
    }
    const text = (provided as string | undefined) ?? slot.defaultValue ?? ''
    if (text.length > (slot.maxLength ?? 4000)) throw new BindingSlotError(slot.key, `slot ${slot.key} 超过长度限制`)
    if (slot.required && !text.trim()) throw new BindingSlotError(slot.key, `slot ${slot.key} 必填`)
    if (text || provided !== undefined) out[slot.key] = text
  }
  return out
}

export function parseAgentPrefabBinding(raw: string | undefined | null): AgentPrefabBinding | null {
  if (raw === undefined || raw === null || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as Partial<AgentPrefabBinding>
    if (!parsed || typeof parsed.prefabId !== 'string' || !parsed.prefabId.trim() || !Number.isSafeInteger(parsed.revision) || (parsed.revision ?? 0) < 1
      || typeof parsed.contentHash !== 'string' || !parsed.contentHash
      || !parsed.slotValues || typeof parsed.slotValues !== 'object' || Array.isArray(parsed.slotValues)) {
      throw new Error('shape')
    }
    const slotValues = Object.fromEntries(Object.entries(parsed.slotValues))
    if (Object.values(slotValues).some(value => typeof value !== 'string')) throw new Error('slot value')
    return { prefabId: parsed.prefabId, revision: parsed.revision!, slotValues, contentHash: parsed.contentHash }
  }
  catch {
    throw new AppError(400, 'PREFAB_BINDING_INVALID', 'AgentPrefab 绑定格式非法')
  }
}

export function createAgentPrefabService(db: DatabaseSync) {
  const repo: AgentPrefabRepo = createAgentPrefabRepo(db)

  function list(actor: PrefabActor): AgentPrefabRow[] {
    return isAdmin(actor) ? repo.listAll() : repo.listVisible(actor.id)
  }

  function get(actor: PrefabActor, id: string): AgentPrefabRow {
    const row = repo.findById(id)
    if (!row) throw new AppError(404, 'NOT_FOUND', `AgentPrefab 不存在：${id}`)
    assertVisible(row, actor)
    return row
  }

  function create(actor: PrefabActor, rawDraft: unknown): AgentPrefabRow {
    const draft = validatePrefabDraft(rawDraft)
    return repo.create({ name: draft.name, description: draft.description, visibility: draft.visibility, ownerUserId: actor.id, draft })
  }

  function update(actor: PrefabActor, id: string, expectedUpdatedAt: string, rawDraft: unknown): AgentPrefabRow {
    const row = repo.findById(id)
    if (!row) throw new AppError(404, 'NOT_FOUND', `AgentPrefab 不存在：${id}`)
    assertEditable(row, actor)
    const draft = validatePrefabDraft(rawDraft)
    return repo.updateDraft(id, expectedUpdatedAt, { name: draft.name, description: draft.description, visibility: draft.visibility, draft })
  }

  function remove(actor: PrefabActor, id: string, expectedUpdatedAt: string): { id: string, archived: boolean } {
    const row = repo.findById(id)
    if (!row) throw new AppError(404, 'NOT_FOUND', `AgentPrefab 不存在：${id}`)
    assertEditable(row, actor)
    return repo.remove(id, expectedUpdatedAt)
  }

  function publish(actor: PrefabActor, id: string, expectedHead: number, expectedUpdatedAt?: string): AgentPrefabRevisionRow {
    const row = repo.findById(id)
    if (!row) throw new AppError(404, 'NOT_FOUND', `AgentPrefab 不存在：${id}`)
    assertEditable(row, actor)
    const draft = parseDraft(row)
    return repo.publish(id, expectedHead, draft, actor.id, expectedUpdatedAt ?? row.updatedAt)
  }

  function loadRevision(prefabId: string, revision: number): { row: AgentPrefabRow, revision: AgentPrefabRevisionRow, draft: AgentPrefabDraft } | null {
    const row = repo.findById(prefabId)
    const rev = row ? repo.findRevision(prefabId, revision) : undefined
    if (!row || !rev) return null
    try {
      const parsed = JSON.parse(rev.snapshotJson) as { schemaVersion?: number, draft?: unknown }
      if (parsed.schemaVersion !== 1) return null
      const draft = validatePrefabDraft(parsed.draft)
      if (prefabSnapshotHash(draft) !== rev.contentHash) return null
      return { row, revision: rev, draft }
    }
    catch {
      return null
    }
  }

  /** 绑定前校验权限/插槽；返回可持久化的 binding */
  function buildBinding(actor: PrefabActor | ChannelLeadPrefabUse, prefabId: string, revision: number, rawSlots: unknown): AgentPrefabBinding {
    const row = repo.findById(prefabId)
    if (row) {
      if ('kind' in actor) {
        if (row.visibility !== 'public' && (!actor.channelOwnerUserId || row.ownerUserId !== actor.channelOwnerUserId)) {
          throw new AppError(403, 'PREFAB_FORBIDDEN', '仅可使用频道所有者的或公开的 AgentPrefab')
        }
      }
      else {
        assertVisible(row, actor)
      }
      assertActive(row)
    }
    const loaded = loadRevision(prefabId, revision)
    if (!loaded) throw new AppError(404, 'PREFAB_REVISION_NOT_FOUND', `AgentPrefab revision 不存在：${prefabId}@${revision}`)
    const slotValues = validateBindingSlots(loaded.draft, rawSlots)
    return { prefabId, revision, slotValues, contentHash: loaded.revision.contentHash }
  }

  return {
    repo,
    list,
    get,
    create,
    update,
    remove,
    publish,
    loadRevision,
    buildBinding,
    findDraft: (id: string): AgentPrefabDraft | null => {
      const row = repo.findById(id)
      return row ? parseDraft(row) : null
    },
  }
}

export type AgentPrefabService = ReturnType<typeof createAgentPrefabService>

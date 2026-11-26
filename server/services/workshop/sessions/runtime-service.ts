/**
 * SessionRuntimeService —— 会话级 runtime 元数据读写（manual session 专属）。
 *
 * runtime 对象 id = channel_agents.id（session.member_map_json 的 value）。
 * 只持久化 owner/admin 的覆盖；clone 行、基础成员、频道模板与创建快照都不变。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import { parseJson } from '../db/database'
import { createChannelAgentRepo, prefabBindingVersionOf } from '../db/channel-agent.repo'
import { createChannelRepo } from '../db/channel.repo'
import { createChannelSessionRepo, type ChannelSessionRow } from '../db/channel-session.repo'
import { createSessionRuntimeOverrideRepo } from '../db/session-runtime.repo'
import { withTransaction } from '../db/transaction'
import { createAgentPrefabService, parseAgentPrefabBinding, type PrefabActor } from '../agent-prefabs/service'
import { applyPrefabProfile, profileSupportOf, type HarnessProfileSupport } from '../agent-prefabs/profile'
import type { AgentPrefabBinding } from '../agent-prefabs/types'
import { resolveRuntimeForMember, prefabBlockedReason } from '../agent-prefabs/runtime'
import { harnessModelCatalog, type HarnessCatalog } from '../agents/harness-models'
import { resolveTrustedSessionBinding } from '../agents/session-snapshot'
import { getDcwRecipeRepo } from '../dcw/dcw-recipe.repo'
import {
  applySessionRuntimeOverrides,
  parseSessionRuntimeOverrides,
  serializeSessionRuntimeOverrides,
  SESSION_RUNTIME_OVERRIDE_KEYS,
  type SessionRuntimeOverrides,
} from './runtime-overrides'

export interface SessionRuntimePrefabView {
  prefabId: string
  revision: number
  slotValues: Record<string, string>
  bindingVersion: string
  contentHash: string
  name: string | null
}

export interface SessionRuntimeEffective {
  provider?: string
  model?: string
  effort?: string
  runtimePrompt?: string
  prefab: SessionRuntimePrefabView | null
}

/** 持久化的覆盖值（用于 UI 精确区分“继承/不指定/覆盖”三态）。 */
export interface SessionRuntimeOverrideView {
  harness?: string
  provider?: string
  model?: string
  effort?: string
  runtimePrompt?: string
  prefabBinding?: { prefabId: string, revision: number }
}

export interface SessionRuntimeView {
  runtimeObjectId: string
  sessionId: string
  baseAgentId: string
  agentId: string
  name: string
  role: string
  /** 有效 harness（会话覆盖优先） */
  harness: string
  /** clone 行原始 harness（用于展示“覆盖自 …”） */
  baseHarness: string
  enabled: number
  revision: number
  customized: boolean
  effective: SessionRuntimeEffective
  /** 已持久化的覆盖值；无键 = 继承。空串 = 显式不指定。 */
  overrides: SessionRuntimeOverrideView
  /** 该 harness 原生支持的 provider/model/effort 控件 */
  profileSupport: HarnessProfileSupport
  channelMode: 'generic' | 'production_line_integrated'
  warnings: Array<{ code: string, message: string }>
  updatedAt: string | null
  updatedBy: string | null
  /** manual session 才可编辑；task/project 只读 */
  manageable: boolean
  active: boolean
  editableFields: string[]
}

export interface SessionRuntimeUpdateInput {
  channelId: string
  sessionId: string
  agentId: string
  expectedRevision: number
  reset?: boolean
  overrides?: unknown
  actor: PrefabActor
}

export interface SessionRuntimeServiceOptions {
  /** 测试注入；默认走 harness 目录（5 分钟缓存） */
  catalog?: (harness: string) => Promise<HarnessCatalog>
  /** 测试注入；默认动态加载 assertHarnessUsable（避免 registry 静态环） */
  harnessUsable?: (harness: string, config: Record<string, unknown>) => void | Promise<void>
  /** 工业会话的工具面告警（manager 注入 registry 的 harnessToolSurface） */
  toolSurface?: (harness: string) => 'bridge' | 'manual' | 'none'
}

const EDITABLE_FIELDS = ['harness', 'provider', 'model', 'effort', 'runtimePrompt', 'prefab']

function overridesEmpty(overrides: SessionRuntimeOverrides): boolean {
  return Object.keys(overrides).length === 0
}

function requireManualActiveSession(session: ChannelSessionRow | undefined, channelId: string, sessionId: string): ChannelSessionRow {
  if (!session || session.channelId !== channelId) {
    throw new AppError(404, 'NOT_FOUND', `会话不存在: ${sessionId}`)
  }
  if (session.instanceKind !== 'manual') {
    throw new AppError(409, 'SESSION_MANAGED', '仅手工会话可编辑 runtime 元数据')
  }
  if (session.status !== 'active') {
    throw new AppError(409, 'SESSION_NOT_ACTIVE', '会话已关闭，不能修改 runtime 元数据')
  }
  return session
}

function memberMapOf(session: ChannelSessionRow): Record<string, string> {
  const parsed = parseJson<unknown>(session.memberMapJson, {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function baseAgentIdOf(session: ChannelSessionRow, agentId: string): string | null {
  const map = memberMapOf(session)
  for (const [baseId, cloneId] of Object.entries(map)) {
    if (cloneId === agentId) return baseId
  }
  return null
}

function prefabView(
  db: DatabaseSync,
  binding: AgentPrefabBinding | null,
): SessionRuntimePrefabView | null {
  if (!binding) return null
  let name: string | null
  try {
    name = createAgentPrefabService(db).loadRevision(binding.prefabId, binding.revision)?.row.name ?? null
  }
  catch {
    name = null
  }
  return {
    prefabId: binding.prefabId,
    revision: binding.revision,
    slotValues: { ...binding.slotValues },
    bindingVersion: prefabBindingVersionOf(JSON.stringify(binding)) ?? '',
    contentHash: binding.contentHash,
    name,
  }
}

function parseBindings(raw: string | undefined): AgentPrefabBinding | null {
  try {
    return parseAgentPrefabBinding(raw)
  }
  catch {
    return null
  }
}

function effectiveView(
  db: DatabaseSync,
  member: { harness: string, channelId: string, configJson: string, prefabBindingJson?: string },
  overrides: SessionRuntimeOverrides,
): SessionRuntimeEffective {
  const base = baseConfigWithChannelLlm(db, member.channelId, member.configJson)
  const config: Record<string, unknown> = { ...base }
  const baseBinding = parseBindings(member.prefabBindingJson)
  const candidateBinding = overrides.prefabBinding ?? baseBinding
  const candidateMember = {
    ...member,
    prefabBindingJson: candidateBinding ? JSON.stringify(candidateBinding) : '',
  }
  const harness = overrides.harness ?? member.harness
  try {
    const resolved = resolveRuntimeForMember(db, candidateMember as never, { ignoreStoredOverrides: true })
    if (resolved?.draft) applyPrefabProfile(config, harness, resolved.draft.profile)
  }
  catch {
    // 读面不因既有坏绑定/不支持 profile 阻断列表；编辑写路径会 fail-fast 给出具体 4xx。
  }
  try {
    applySessionRuntimeOverrides(config, harness, overrides)
  }
  catch {
    // 同上：展示尽可能多的有效字段，具体错误由写路径返回。
  }
  return {
    provider: typeof config.provider === 'string' ? config.provider : undefined,
    model: typeof config.model === 'string' ? config.model : undefined,
    effort: typeof config.effort === 'string' ? config.effort : undefined,
    runtimePrompt: overrides.runtimePrompt,
    prefab: prefabView(db, candidateBinding),
  }
}

function viewOne(
  db: DatabaseSync,
  session: ChannelSessionRow,
  baseAgentId: string,
  agentId: string,
  opts: SessionRuntimeServiceOptions = {},
): SessionRuntimeView {
  const member = createChannelAgentRepo(db).findByChannelAgent(session.channelId, agentId)
  if (!member) throw new AppError(404, 'NOT_FOUND', `会话 runtime 不存在: ${agentId}`)
  const row = createSessionRuntimeOverrideRepo(db).get(session.id, agentId)
  const overrides = row ? parseSessionRuntimeOverrides(row.overridesJson) : {}
  const harness = overrides.harness ?? member.harness
  const integrated = session.channelMode === 'production_line_integrated'
    && Boolean(resolveTrustedSessionBinding(db, session, { recipeLookup: id => getDcwRecipeRepo().byId(id) }))
  const warnings: Array<{ code: string, message: string }> = []
  if (integrated && opts.toolSurface && opts.toolSurface(harness) !== 'bridge') {
    warnings.push({
      code: 'HARNESS_TOOL_SURFACE_WEAK',
      message: `harness ${harness} 不是自动桥接工具面；集成产线会话可能拿不到平台/工业工具（需人工确认接入）。`,
    })
  }
  return {
    runtimeObjectId: agentId,
    sessionId: session.id,
    baseAgentId,
    agentId,
    name: member.name,
    role: member.role,
    harness,
    baseHarness: member.harness,
    enabled: member.enabled,
    revision: row?.revision ?? 0,
    customized: !overridesEmpty(overrides),
    effective: effectiveView(db, member, overrides),
    overrides: {
      ...(overrides.harness ? { harness: overrides.harness } : {}),
      ...(overrides.provider !== undefined ? { provider: overrides.provider } : {}),
      ...(overrides.model !== undefined ? { model: overrides.model } : {}),
      ...(overrides.effort !== undefined ? { effort: overrides.effort } : {}),
      ...(overrides.runtimePrompt ? { runtimePrompt: overrides.runtimePrompt } : {}),
      ...(overrides.prefabBinding
        ? { prefabBinding: { prefabId: overrides.prefabBinding.prefabId, revision: overrides.prefabBinding.revision } }
        : {}),
    },
    profileSupport: profileSupportOf(harness),
    channelMode: integrated ? 'production_line_integrated' : 'generic',
    warnings,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
    manageable: session.instanceKind === 'manual',
    active: session.status === 'active',
    editableFields: EDITABLE_FIELDS,
  }
}

function normalizePrefabInput(db: DatabaseSync, actor: PrefabActor, raw: unknown): AgentPrefabBinding {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError(400, 'RUNTIME_FIELD_FORBIDDEN', 'prefab 必须是对象或 null')
  }
  const input = raw as Record<string, unknown>
  const allowed = new Set(['prefabId', 'revision', 'slotValues'])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new AppError(400, 'RUNTIME_FIELD_FORBIDDEN', `prefab.${key} 不允许修改`)
  }
  if (typeof input.prefabId !== 'string' || !input.prefabId.trim()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'prefab.prefabId 必填')
  }
  const revision = Number(input.revision)
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new AppError(400, 'VALIDATION_ERROR', 'prefab.revision 必须是正整数')
  }
  const slotValues = input.slotValues === undefined ? {} : input.slotValues
  if (!slotValues || typeof slotValues !== 'object' || Array.isArray(slotValues)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'prefab.slotValues 必须是对象')
  }
  for (const [key, value] of Object.entries(slotValues as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new AppError(400, 'VALIDATION_ERROR', `prefab.slotValues.${key} 必须是字符串`)
  }
  return createAgentPrefabService(db).buildBinding(actor, input.prefabId.trim(), revision, slotValues)
}

function mergeOverrides(
  db: DatabaseSync,
  actor: PrefabActor,
  base: SessionRuntimeOverrides,
  raw: unknown,
): SessionRuntimeOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'overrides 必须是对象')
  }
  const patch = raw as Record<string, unknown>
  const allowed = new Set<string>(SESSION_RUNTIME_OVERRIDE_KEYS)
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new AppError(400, 'RUNTIME_FIELD_FORBIDDEN', `字段不允许修改: ${key}`)
  }
  const next: SessionRuntimeOverrides = { ...base }
  if (Object.hasOwn(patch, 'harness')) {
    const value = patch.harness
    if (value === null) Reflect.deleteProperty(next, 'harness')
    else {
      if (typeof value !== 'string') throw new AppError(400, 'VALIDATION_ERROR', 'harness 必须是字符串或 null')
      const text = value.trim()
      if (!text) throw new AppError(400, 'VALIDATION_ERROR', 'harness 不能为空（清除覆盖请传 null）')
      if (text.length > 64) throw new AppError(400, 'VALIDATION_ERROR', 'harness 最多 64 字符')
      next.harness = text
    }
  }
  for (const key of ['provider', 'model', 'effort', 'runtimePrompt'] as const) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    if (value === null) {
      Reflect.deleteProperty(next, key)
      continue
    }
    if (typeof value !== 'string') throw new AppError(400, 'VALIDATION_ERROR', `${key} 必须是字符串或 null`)
    // 空串对 provider/model/effort = 显式抑制继承；对 runtimePrompt = 清除覆盖。
    if (key !== 'runtimePrompt' && value === '') {
      next[key] = ''
      continue
    }
    const text = value.trim()
    if (!text) {
      Reflect.deleteProperty(next, key)
      continue
    }
    const limit = key === 'runtimePrompt' ? 4000 : key === 'effort' ? 64 : 200
    if (text.length > limit) throw new AppError(400, 'VALIDATION_ERROR', `${key} 最多 ${limit} 字符`)
    next[key] = text
  }
  if (Object.hasOwn(patch, 'prefabBinding')) {
    const value = patch.prefabBinding
    if (value === null) Reflect.deleteProperty(next, 'prefabBinding')
    else {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'prefabBinding 必须是对象或 null')
      }
      next.prefabBinding = normalizePrefabInput(db, actor, value)
    }
  }
  return next
}

function catalogModel(
  catalog: HarnessCatalog,
  providerId: string | undefined,
  modelId: string,
) {
  const providers = providerId
    ? catalog.providers.filter(p => p.id === providerId)
    : catalog.providers
  for (const provider of providers) {
    const model = provider.models.find(m => m.id === modelId)
    if (model) return { provider, model }
  }
  return null
}

function textOfConfig(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * 与 wireMember 相同的继承顺序：clone config 优先，缺省时取频道默认 LLM。
 * 写前校验/读面都必须看到频道默认值，否则会在下一回合把不兼容的默认值送进新引擎。
 */
function baseConfigWithChannelLlm(db: DatabaseSync, channelId: string, configJson: string): Record<string, unknown> {
  const out = { ...parseJson<Record<string, unknown>>(configJson, {}) }
  try {
    const llm = parseJson<Record<string, unknown>>(createChannelRepo(db).findById(channelId)?.llmJson, {})
    if (!out.provider && textOfConfig(llm.provider)) out.provider = llm.provider
    if (!out.model && textOfConfig(llm.model)) out.model = llm.model
    if (!out.effort && textOfConfig(llm.effort)) out.effort = llm.effort
  }
  catch {
    // 频道仓储未就绪等异常：退回 clone config（读面不阻断）。
  }
  return out
}

/**
 * 校验候选 profile：目标 harness（可能是覆盖后的）必须支持有效 provider/model/effort，
 * 且显式选择必须在目标 harness 的原生目录里。继承值同样参与校验 —— 切换 harness 时
 * 旧引擎的 provider/model 不能静默流进新引擎。
 */
async function validateProfileSelection(
  db: DatabaseSync,
  member: { harness: string, channelId: string, configJson: string },
  overrides: SessionRuntimeOverrides,
  catalogOf: (harness: string) => Promise<HarnessCatalog>,
  harnessUsable: (harness: string, config: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
  const targetHarness = overrides.harness ?? member.harness
  const harnessChanged = Boolean(overrides.harness && overrides.harness !== member.harness)
  const explicitSelector = overrides.provider !== undefined || overrides.model !== undefined || overrides.effort !== undefined
  // clone → 频道默认 LLM：与 wireMember 的继承顺序一致。
  const base = baseConfigWithChannelLlm(db, member.channelId, member.configJson)
  if (harnessChanged) await harnessUsable(targetHarness, base)
  if (!harnessChanged && !explicitSelector) return

  // 空串 = 抑制继承；缺省 = 继承 clone 值。
  const provider = overrides.provider !== undefined ? (overrides.provider || undefined) : textOfConfig(base.provider)
  const model = overrides.model !== undefined ? (overrides.model || undefined) : textOfConfig(base.model)
  const effort = overrides.effort !== undefined ? (overrides.effort || undefined) : textOfConfig(base.effort)

  // 先走 harness 支持矩阵（provider 是否被该引擎接受、opencode 限定名等）。
  applyPrefabProfile({ ...base }, targetHarness, { provider, model, effort }, {
    unsupported: 'RUNTIME_PROFILE_UNSUPPORTED',
    conflict: 'RUNTIME_PROFILE_CONFLICT',
    subject: 'Session runtime',
  })

  let catalog: HarnessCatalog
  try {
    catalog = await catalogOf(targetHarness)
  }
  catch {
    throw new AppError(503, 'HARNESS_CATALOG_UNAVAILABLE', `无法读取 ${targetHarness} 的模型目录`)
  }
  if (!catalog || !Array.isArray(catalog.providers)) {
    throw new AppError(503, 'HARNESS_CATALOG_UNAVAILABLE', `无法读取 ${targetHarness} 的模型目录`)
  }
  // 空目录：unsupported 模式才是真正的“无目录面”（mock）；levels/freetext 的空目录
  // 更可能是探测失败，必须 fail-closed，不能把成员校验静默跳过。
  if (catalog.providers.length === 0) {
    if (catalog.effortMode === 'unsupported') return
    throw new AppError(503, 'HARNESS_CATALOG_UNAVAILABLE', `${targetHarness} 的模型目录为空（可能是探测失败）；请稍后重试或改用显式自定义值并检查引擎配置`)
  }
  if (provider && !catalog.providers.some(p => p.id === provider)) {
    throw new AppError(409, 'RUNTIME_PROFILE_UNSUPPORTED', `provider 不在 ${targetHarness} 的模型目录: ${provider}`)
  }
  if (model && !catalogModel(catalog, provider, model)) {
    throw new AppError(409, 'RUNTIME_PROFILE_UNSUPPORTED', `model 不在 ${targetHarness} 的模型目录: ${model}`)
  }
  if (effort) {
    if (catalog.effortMode === 'unsupported') {
      throw new AppError(409, 'RUNTIME_PROFILE_UNSUPPORTED', `${targetHarness} 不支持 effort`)
    }
    const hit = model ? catalogModel(catalog, provider, model) : null
    if (hit && hit.model.efforts.length === 0) {
      throw new AppError(409, 'RUNTIME_PROFILE_UNSUPPORTED', `${model} 不支持 reasoning effort`)
    }
    if (hit && !hit.model.efforts.includes(effort)) {
      throw new AppError(409, 'RUNTIME_PROFILE_UNSUPPORTED', `effort 不在 ${model} 的支持列表: ${effort}`)
    }
    // 没有 model 信息时交给 applyPrefabProfile 的 harness 值域校验（opencode 自由串等）。
  }
}

function validateCandidate(
  db: DatabaseSync,
  member: { harness: string, configJson: string, prefabBindingJson?: string },
  overrides: SessionRuntimeOverrides,
): void {
  const harness = overrides.harness ?? member.harness
  const base = parseJson<Record<string, unknown>>(member.configJson, {})
  const binding = overrides.prefabBinding ?? parseBindings(member.prefabBindingJson)
  const candidate = { ...member, harness, prefabBindingJson: binding ? JSON.stringify(binding) : '' }
  let resolved
  try {
    resolved = resolveRuntimeForMember(db, candidate as never, { ignoreStoredOverrides: true })
  }
  catch (err) {
    throw new AppError(500, 'PREFAB_RESOLUTION_FAILED', `runtime 预检失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (resolved?.bindingError) {
    throw new AppError(400, 'PREFAB_BINDING_INVALID', resolved.bindingError)
  }
  const blocked = resolved ? prefabBlockedReason(resolved.resolution) : null
  if (blocked) throw new AppError(409, 'PREFAB_REQUIRED_CAPABILITY_MISSING', blocked)
  const config = { ...base }
  if (resolved?.draft) applyPrefabProfile(config, harness, resolved.draft.profile)
  applySessionRuntimeOverrides(config, harness, overrides)
}

export function createSessionRuntimeService(db: DatabaseSync, options: SessionRuntimeServiceOptions = {}) {
  const catalogOf = options.catalog ?? (harnessModelCatalog as (harness: string) => Promise<HarnessCatalog>)
  const harnessUsable = options.harnessUsable ?? (async (harness: string, config: Record<string, unknown>) => {
    // 动态加载：harness-availability → registry 会拉起全部引擎实现，静态 import 会与
    // agent-prefabs/runtime 形成初始化环（曾出现 HARNESS_REGISTRY before initialization）。
    const { assertHarnessUsable } = await import('../agents/harness-availability')
    assertHarnessUsable(harness, config)
  })
  const viewOpts: SessionRuntimeServiceOptions = { toolSurface: options.toolSurface }
  const sessions = createChannelSessionRepo(db)
  const members = createChannelAgentRepo(db)
  const overridesRepo = createSessionRuntimeOverrideRepo(db)

  function findSession(channelId: string, sessionId: string): ChannelSessionRow {
    const session = sessions.findById(sessionId)
    if (!session || session.channelId !== channelId) throw new AppError(404, 'NOT_FOUND', `会话不存在: ${sessionId}`)
    return session
  }

  function list(channelId: string, sessionId: string): SessionRuntimeView[] {
    const session = findSession(channelId, sessionId)
    const map = memberMapOf(session)
    const views: SessionRuntimeView[] = []
    for (const [baseAgentId, agentId] of Object.entries(map)) {
      try {
        views.push(viewOne(db, session, baseAgentId, agentId, viewOpts))
      }
      catch {
        // 历史 clone 被删/损坏：不阻断其余 runtime 列表。
      }
    }
    return views.sort((a, b) => a.name.localeCompare(b.name))
  }

  function get(channelId: string, sessionId: string, agentId: string): SessionRuntimeView {
    const session = findSession(channelId, sessionId)
    const baseAgentId = baseAgentIdOf(session, agentId)
    if (!baseAgentId) throw new AppError(404, 'NOT_FOUND', `会话 runtime 不存在: ${agentId}`)
    return viewOne(db, session, baseAgentId, agentId, viewOpts)
  }

  async function update(input: SessionRuntimeUpdateInput): Promise<SessionRuntimeView> {
    const session = requireManualActiveSession(sessions.findById(input.sessionId), input.channelId, input.sessionId)
    const baseAgentId = baseAgentIdOf(session, input.agentId)
    if (!baseAgentId) throw new AppError(404, 'NOT_FOUND', `会话 runtime 不存在: ${input.agentId}`)
    const member = members.findByChannelAgent(input.channelId, input.agentId)
    if (!member) throw new AppError(404, 'NOT_FOUND', `会话 runtime 不存在: ${input.agentId}`)
    if (member.role !== 'worker') throw new AppError(409, 'SESSION_RUNTIME_FORBIDDEN', '仅会话 worker 实例可编辑 runtime 元数据')
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'expectedRevision 必须是非负整数')
    }
    if (input.reset === true && input.overrides !== undefined) {
      throw new AppError(400, 'VALIDATION_ERROR', 'reset 与 overrides 不能同时提交')
    }
    if (input.reset !== true && input.overrides === undefined) {
      throw new AppError(400, 'VALIDATION_ERROR', '需要 overrides 或 reset')
    }
    const row = overridesRepo.get(input.sessionId, input.agentId)
    if (row && row.revision !== input.expectedRevision) {
      throw new AppError(409, 'RUNTIME_REVISION_CONFLICT', `runtime revision 已变化（当前 ${row.revision}）`)
    }
    if (!row && input.expectedRevision !== 0) {
      throw new AppError(409, 'RUNTIME_REVISION_CONFLICT', 'runtime revision 已变化（当前 0）')
    }
    const base = row ? parseSessionRuntimeOverrides(row.overridesJson) : {}
    let next: SessionRuntimeOverrides
    if (input.reset === true) {
      next = {}
    }
    else {
      if (!input.overrides || typeof input.overrides !== 'object' || Array.isArray(input.overrides)
        || Object.keys(input.overrides as Record<string, unknown>).length === 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'overrides 不能为空')
      }
      next = mergeOverrides(db, input.actor, base, input.overrides)
    }
    // 与 clone 相同的 harness 不算覆盖（保留其它 key）；避免无意义热切换。
    if (next.harness && next.harness === member.harness) Reflect.deleteProperty(next, 'harness')
    // 只改 runtimePrompt/Prefab 时不要重新探测模型目录：既避免无谓 503，也让
    // “覆盖已存在但本次未动 profile”的编辑保持可用。
    const profileChanged = ['harness', 'provider', 'model', 'effort']
      .some(key => (next as Record<string, unknown>)[key] !== (base as Record<string, unknown>)[key])
    if (profileChanged) await validateProfileSelection(db, member, next, catalogOf, harnessUsable)
    validateCandidate(db, member, next)
    const ok = withTransaction(db, () => overridesRepo.save({
      sessionId: input.sessionId,
      agentId: input.agentId,
      expectedRevision: input.expectedRevision,
      overridesJson: serializeSessionRuntimeOverrides(next),
      updatedBy: input.actor.id,
    }))
    if (!ok) {
      const current = overridesRepo.get(input.sessionId, input.agentId)?.revision ?? 0
      throw new AppError(409, 'RUNTIME_REVISION_CONFLICT', `runtime revision 已变化（当前 ${current}）`)
    }
    return viewOne(db, session, baseAgentId, input.agentId, viewOpts)
  }

  return { list, get, update }
}

export type SessionRuntimeService = ReturnType<typeof createSessionRuntimeService>

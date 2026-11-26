/**
 * Agent / session runtime profile 应用。
 *
 * 同一套 harness 能力矩阵同时服务两个来源：
 *  - AgentPrefab 发布 profile（不可变绑定）；
 *  - 会话级 runtime 覆盖（owner/admin 显式编辑，低信任业务面）。
 * 只写 provider/model/effort 与各 harness 原生 effort 别名，绝不触碰
 * command/args/cwd/env/rpcMode/settings 等启动面。
 */
import { AppError } from '../../../utils/errors'
import type { PrefabRuntimeProfile } from './types'

// Only adapters that consume these model selectors may receive them from a Prefab.
const PROVIDER_HARNESSES = new Set(['omp', 'opencode', 'dsh', 'goose', 'pi', 'hermes'])
const MODEL_HARNESSES = new Set([...PROVIDER_HARNESSES, 'codex', 'claude', 'gemini', 'copilot', 'cursor', 'crush', 'qwen'])
const EFFORT_SETTINGS = new Map([['omp', 'thinkingLevel'], ['opencode', 'variant'], ['pi', 'thinking']])
const EFFORT_HARNESSES = new Set([...EFFORT_SETTINGS.keys(), 'codex'])
const SETTING_ID = /^[a-z0-9][a-z0-9_.-]*$/i
const MODEL_ID = /^[a-z0-9_@][a-z0-9_.:@+/-]*$/i
const OMP_EFFORT_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'])

export interface ProfileErrorCodes {
  /** 字段/值不受 harness 支持时使用的 409 业务码 */
  unsupported?: string
  /** OpenCode provider/model 冲突时使用的 409 业务码 */
  conflict?: string
  /** 错误消息中的来源名（默认 AgentPrefab，会话 runtime 用 session runtime） */
  subject?: string
}

/** 某 harness 原生支持的运行 profile 选择面（前端据此显示/隐藏 provider/model/effort 控件）。 */
export interface HarnessProfileSupport {
  provider: boolean
  model: boolean
  effort: boolean
}

export function profileSupportOf(harness: string): HarnessProfileSupport {
  return {
    provider: PROVIDER_HARNESSES.has(harness),
    model: MODEL_HARNESSES.has(harness),
    effort: EFFORT_HARNESSES.has(harness),
  }
}

/** effort 在各引擎里的原生配置键（omp thinkingLevel / opencode variant / pi thinking）。 */
export function effortSettingKeyOf(harness: string): string | undefined {
  return EFFORT_SETTINGS.get(harness)
}

/**
 * 创建期结构校验 + 原生别名归一：把 provider/model/effort 按目标 harness 的
 * 读取方式写回（omp thinkingLevel / opencode variant + 限定 model / pi thinking），
 * 同时 fail-closed 拒绝目标引擎读不了的字段。
 */
export function applyProfileToConfig(harness: string, config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config }
  const provider = typeof next.provider === 'string' && next.provider ? next.provider : undefined
  const model = typeof next.model === 'string' && next.model ? next.model : undefined
  const alias = effortSettingKeyOf(harness)
  const aliasValue = alias && typeof next[alias] === 'string' && next[alias] ? next[alias] as string : undefined
  const effort = typeof next.effort === 'string' && next.effort ? next.effort : aliasValue
  applyPrefabProfile(next, harness, {
    provider,
    model,
    effort,
    ...(alias && aliasValue ? { settings: { [alias]: aliasValue } } : {}),
  }, {
    unsupported: 'HARNESS_PROFILE_UNSUPPORTED',
    conflict: 'HARNESS_PROFILE_CONFLICT',
    subject: 'Agent profile',
  })
  return next
}

/** 只校验不落库（保留旧导出面）。 */
export function assertProfileStructurallyValid(harness: string, config: Record<string, unknown>): void {
  applyProfileToConfig(harness, config)
}

const PROFILE_SELECTOR_KEYS = ['provider', 'model', 'effort', 'thinkingLevel', 'variant', 'thinking'] as const

/** 非 profile 字段的普通 config 编辑不应触发 profile 归一/校验（避免旧模板被误伤）。 */
export function profileSelectionChanged(current: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return PROFILE_SELECTOR_KEYS.some(key => current[key] !== next[key])
}

/** 按 harness 支持矩阵应用 provider/model/effort；失败 fail-closed，不静默丢弃。 */
export function applyPrefabProfile(
  config: Record<string, unknown>,
  harness: string,
  profile: PrefabRuntimeProfile,
  codes: ProfileErrorCodes = {},
): void {
  const { provider, model } = profile
  const effortSetting = EFFORT_SETTINGS.get(harness)
  const unsupportedCode = codes.unsupported ?? 'PREFAB_PROFILE_UNSUPPORTED'
  const conflictCode = codes.conflict ?? 'PREFAB_PROFILE_CONFLICT'
  const subject = codes.subject ?? 'AgentPrefab'
  const unsupported = (field: string) => new AppError(409, unsupportedCode, `${subject} profile.${field} 不受 ${harness} 支持或值无效`)
  const validEffort = (value: unknown): value is string => typeof value === 'string'
    && (harness === 'omp' ? OMP_EFFORT_LEVELS.has(value) : SETTING_ID.test(value))
  for (const [key, value] of Object.entries(profile.settings ?? {})) {
    if (key !== effortSetting || !validEffort(value)) throw unsupported(`settings.${key}`)
  }
  if (provider && (!PROVIDER_HARNESSES.has(harness) || !SETTING_ID.test(provider))) throw unsupported('provider')
  if (model && (!MODEL_HARNESSES.has(harness) || !MODEL_ID.test(model))) throw unsupported('model')
  if (profile.effort && (!EFFORT_HARNESSES.has(harness) || !validEffort(profile.effort))) throw unsupported('effort')

  // 逐字段优先级：调用方按 base → Prefab → session override 的顺序调用本函数。
  if (harness === 'opencode' && (provider || model)) {
    // OpenCode reads provider from its qualified model. Keep that selector in sync.
    const fallbackModel = typeof config.model === 'string' ? config.model : ''
    const fallbackSlash = fallbackModel.indexOf('/')
    const selectedModel = model || fallbackModel.slice(fallbackSlash + 1)
    const slash = selectedModel.indexOf('/')
    const modelProvider = model && slash >= 0 ? model.slice(0, slash) : undefined
    const modelId = modelProvider !== undefined ? selectedModel.slice(slash + 1) : selectedModel
    const fallbackProvider = fallbackSlash >= 0 ? fallbackModel.slice(0, fallbackSlash) : config.provider
    const selectedProvider = provider || modelProvider || fallbackProvider
    if (!modelId || (modelProvider !== undefined && (!SETTING_ID.test(modelProvider) || (provider && provider !== modelProvider)))) {
      throw new AppError(409, conflictCode, `${subject} OpenCode profile 需要有效且一致的 provider/model`)
    }
    config.model = typeof selectedProvider === 'string' && selectedProvider ? `${selectedProvider}/${modelId}` : modelId
    if (provider || modelProvider) config.provider = selectedProvider
  }
  else {
    if (provider) config.provider = provider
    if (model) config.model = model
  }
  // effort 与 adapter 原生别名是同一设置：同一 profile 中顶层 effort 优先。
  const effort = profile.effort || (effortSetting ? profile.settings?.[effortSetting] : undefined)
  if (effort) {
    config.effort = effort
    if (effortSetting) config[effortSetting] = effort
  }
}

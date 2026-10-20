/**
 * Channel 级工具策略:选择模式 / 逐工具开关 / 执行闸门。
 *
 * 硬边界:本模块只负责“在已合格工具集合里做减法”。角色、Channel profile、写守卫、
 * 插件总开关仍由 host-tool-bridge/catalog 与 dispatch 的既有规则决定;Channel 选择
 * 不能把被硬规则排除的工具打开。
 *
 * 无策略行(默认)= mode='all' + 全部合格工具启用,保证存量 Channel 行为不变。
 */
import { getToolRegistryRepo, type ChannelToolPolicySnapshot, type ToolPolicyMode } from '../db/tool-registry.repo'
import { createLogger } from '../logger'

const log = createLogger('workshop.tool-policy')

let warnedAt = 0

/** 读取策略;DB 故障时降级为默认(全部合格工具启用)并限频告警。 */
export function getPolicySnapshot(channelId: string): ChannelToolPolicySnapshot {
  const fallback: ChannelToolPolicySnapshot = {
    channelId,
    mode: 'all',
    source: 'default',
    updatedBy: '',
    updatedAt: null,
    settings: new Map(),
  }
  if (!channelId) return fallback
  try {
    return getToolRegistryRepo().snapshot(channelId)
  }
  catch (err) {
    if (Date.now() - warnedAt > 60_000) {
      warnedAt = Date.now()
      log.warn(`读取 Channel 工具策略失败,降级为默认全启用: ${err instanceof Error ? err.message : String(err)}`)
    }
    return fallback
  }
}

/** 该 Channel 是否启用某工具(不考虑角色/profile/写守卫)。 */
export function isChannelToolEnabled(policy: ChannelToolPolicySnapshot, name: string): boolean {
  if (policy.mode === 'selected') return policy.settings.get(name) === true
  return policy.settings.get(name) !== false
}

/** 在已合格工具集合上应用 Channel 选择。无 channelId = 不裁剪(兼容旧调用)。 */
export function applyChannelToolPolicy<T extends { name: string }>(tools: T[], channelId?: string): T[] {
  if (!channelId) return tools
  const policy = getPolicySnapshot(channelId)
  if (policy.source === 'default') return tools
  return tools.filter(t => isChannelToolEnabled(policy, t.name))
}

export type ToolGateReason = 'CHANNEL_TOOL_DISABLED' | 'UNAVAILABLE'

export interface ToolGateResult {
  blocked: boolean
  reason?: ToolGateReason
  message?: string
}

/**
 * 执行面闸门:
 *  - 未知工具不在这里拦截(保持既有“未知工具”错误语义);
 *  - 目录中存在但当前未注册(unavailable)→ 拒绝;
 *  - 本 Channel 显式停用 → 拒绝。
 */
export function channelToolGate(channelId: string, toolName: string): ToolGateResult {
  if (!channelId) return { blocked: false }
  let row: ReturnType<ReturnType<typeof getToolRegistryRepo>['get']>
  try {
    row = getToolRegistryRepo().get(toolName)
  }
  catch {
    // 目录不可读时不阻断执行(硬安全规则仍在);与策略读取同一 fail-open 口径
    return { blocked: false }
  }
  if (!row) return { blocked: false }
  if (!row.available) {
    return {
      blocked: true,
      reason: 'UNAVAILABLE',
      message: `工具「${toolName}」当前未注册(来源插件未安装或加载失败),不可调用。请让管理员在插件管理中启用对应插件后重试。`,
    }
  }
  const policy = getPolicySnapshot(channelId)
  if (!isChannelToolEnabled(policy, toolName)) {
    return {
      blocked: true,
      reason: 'CHANNEL_TOOL_DISABLED',
      message: `本 Channel 已在「设置 → 工具」中停用「${toolName}」。请让 Channel 属主在工具管理中启用后重试;硬规则排除的工具不能通过开关绕过。`,
    }
  }
  return { blocked: false }
}

/** API 写入前的模式校验 */
export function normalizeMode(value: unknown): ToolPolicyMode {
  return value === 'selected' ? 'selected' : 'all'
}

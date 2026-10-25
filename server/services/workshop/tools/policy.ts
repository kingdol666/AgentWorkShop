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
import { HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES } from '../agents/tool-classes'
import { createLogger } from '../logger'

const log = createLogger('workshop.tool-policy')

let warnedAt = 0

/**
 * WP7 分级降级:
 *  - 读取成功 → 更新「最近已知快照」缓存;
 *  - 读取失败但有缓存(≤5min)→ 用缓存 + stale 标记(读面继续可用,写面由闸门按族拒);
 *  - 读取失败且无缓存 → selected + 空集(=全拒;比"降级全启用"更安全);
 *  - env AW_POLICY_DEGRADE=open 回到旧的 fail-open(灰度观察期用,启动期 audit warn)。
 */
const lastGood = new Map<string, { snapshot: ChannelToolPolicySnapshot, at: number }>()
const STALE_MS = 5 * 60_000
let degradeWarned = false

/** 写族:策略/目录不可判定时这些工具一律拒绝(物理安全优先) */
const POLICY_WRITE_TOOL_NAMES = new Set<string>([...HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES, 'line_start', 'line_stop'])
export function isPolicyWriteTool(name: string): boolean {
  return POLICY_WRITE_TOOL_NAMES.has(name)
}

function failOpenMode(): boolean {
  if (process.env.AW_POLICY_DEGRADE !== 'open') return false
  if (!degradeWarned) {
    degradeWarned = true
    log.warn('AW_POLICY_DEGRADE=open:策略读取失败将降级为全启用(fail-open);安全开关打开态请尽快关闭')
  }
  return true
}

/** 读取策略;DB 故障时按 WP7 分级降级(缓存→stale;无缓存→全拒;fail-open 仅显式开关) */
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
    const snapshot = getToolRegistryRepo().snapshot(channelId)
    lastGood.set(channelId, { snapshot, at: Date.now() })
    return snapshot
  }
  catch (err) {
    const cached = lastGood.get(channelId)
    if (cached && Date.now() - cached.at <= STALE_MS) {
      if (Date.now() - warnedAt > 60_000) {
        warnedAt = Date.now()
        log.warn(`读取 Channel 工具策略失败,使用最近已知快照(${Math.round((Date.now() - cached.at) / 1000)}s 前): ${err instanceof Error ? err.message : String(err)}`)
      }
      return { ...cached.snapshot, source: 'cached', stale: true, ageMs: Date.now() - cached.at }
    }
    if (failOpenMode()) return fallback
    if (Date.now() - warnedAt > 60_000) {
      warnedAt = Date.now()
      log.warn(`读取 Channel 工具策略失败且无可用快照,降级为全拒(selected+空集): ${err instanceof Error ? err.message : String(err)}`)
    }
    return { ...fallback, mode: 'selected', source: 'degraded', stale: true }
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

export type ToolGateReason = 'CHANNEL_TOOL_DISABLED' | 'UNAVAILABLE' | 'POLICY_UNAVAILABLE'

export interface ToolGateResult {
  blocked: boolean
  reason?: ToolGateReason
  message?: string
  /** WP7:策略读取降级(读面放行但带降级标记;写面不会带此标记——已被拒) */
  degraded?: boolean
}

/**
 * 执行面闸门:
 *  - 未知工具不在这里拦截(保持既有“未知工具”错误语义);
 *  - 目录中存在但当前未注册(unavailable)→ 拒绝;
 *  - 本 Channel 显式停用 → 拒绝;
 *  - WP7:目录读取失败时,写族 fail-closed(物理安全优先),读族放行并带 degraded 标记。
 */
export function channelToolGate(channelId: string, toolName: string): ToolGateResult {
  if (!channelId) return { blocked: false }
  let row: ReturnType<ReturnType<typeof getToolRegistryRepo>['get']>
  try {
    row = getToolRegistryRepo().get(toolName)
  }
  catch {
    // 目录不可读:写族必须拒(策略不可判定时不得放行物理写);读族降级可用
    if (isPolicyWriteTool(toolName)) {
      return {
        blocked: true,
        reason: 'POLICY_UNAVAILABLE',
        message: `工具「${toolName}」属写族,当前工具目录不可读(策略无法判定),已按安全默认拒绝。请稍后重试;若持续出现请联系管理员。`,
      }
    }
    return { blocked: false, degraded: true }
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
      message: policy.stale
        ? `本 Channel 已在「设置 → 工具」中停用「${toolName}」(策略为最近已知快照,数据库暂不可读)。请稍后重试或联系 Channel 属主。`
        : `本 Channel 已在「设置 → 工具」中停用「${toolName}」。请让 Channel 属主在工具管理中启用后重试;硬规则排除的工具不能通过开关绕过。`,
    }
  }
  return { blocked: false, ...(policy.stale ? { degraded: true } : {}) }
}

/** API 写入前的模式校验 */
export function normalizeMode(value: unknown): ToolPolicyMode {
  return value === 'selected' ? 'selected' : 'all'
}

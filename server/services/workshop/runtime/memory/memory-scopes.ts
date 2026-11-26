/**
 * 记忆分区规则表（唯一口径）+ 两个编译器。
 *
 * 为什么不是"一个函数"：SQL 侧的预过滤客观存在（FTS/索引/LIMIT 前），
 * 因此真实约束是「一张声明式规则表 + SQL 编译器 + JS 求值器 + 差分测试」。
 * 两侧必须共用同一份 `SCOPE_RULES`，任何一方单独改动都会被 tests/memory-scopes.test.ts 抓出。
 *
 * 关键语义（2026-11-26 plan v5）：
 *  - `owner` = strict：只匹配 `owner_user_id = ctx.ownerUserId`；
 *    NULL owner 行**不**参与 workspace/line/product（与 a2a.ts 的"无主频道不参与跨团队检索"一致）。
 *  - `scopeKindIn` 是防泄漏的关键：`save_memory` 默认给 global 经验打 sessionId，
 *    若 private/session 档不限制 scope_kind，候选经验会从会话档漏进自动注入。
 *  - `kindPolicy`：自动注入下，**所有**档位的 experience 行都必须是 validated + 已部署；
 *    line/product/global 还要求工业模式。
 *  - `crossChannelAware`：line/product 在自动注入且开关关闭时追加 channelEq（默认仍同频道）。
 */
import type { MemoryRow, MemoryScopeKind, MemoryStatus } from '../../db/database'

export type ScopeTier = 'private' | 'shared' | 'session' | 'workspace' | 'line' | 'product' | 'auto' | 'all'

export interface MemoryCtx {
  /** 来自 channels.owner_user_id；NULL = 无主（不参与跨频道档） */
  ownerUserId: string | null
  channelId: string
  sessionId: string | null
  agentId: string
  lineIds: string[]
  productIds: string[]
  industrial: boolean
  /** true = 自动注入（experience 需 validated + 已部署）；false = 显式检索（宽松，只排除 retired） */
  automatic: boolean
  /** line/product 是否允许跨频道（默认 false；开关记忆：memory_cross_channel_scope_inject） */
  crossChannel: boolean
}

export type ScopeKindSel = 'any' | 'sessionOrChannel' | 'global' | 'line' | 'product'
export type KindPolicy = 'none' | 'experienceValidatedDeployedIndustrial'

export interface ScopeRule {
  channelEq: boolean
  owner: 'none' | 'strict'
  agentIn: 'self' | 'selfOrTeam' | 'team' | 'any'
  sessionEq: boolean
  scopeKindIn: ScopeKindSel
  scopeKeyIn: 'none' | 'line' | 'product'
  kindPolicy: KindPolicy
  crossChannelAware: boolean
}

export const TEAM_SENTINEL = '__team__'

export const SCOPE_RULES: Record<Exclude<ScopeTier, 'all'>, ScopeRule> = {
  private: {
    channelEq: true,
    owner: 'none',
    agentIn: 'self',
    sessionEq: false,
    scopeKindIn: 'sessionOrChannel',
    scopeKeyIn: 'none',
    kindPolicy: 'none',
    crossChannelAware: false,
  },
  shared: {
    channelEq: true,
    owner: 'none',
    agentIn: 'team',
    sessionEq: false,
    scopeKindIn: 'sessionOrChannel',
    scopeKeyIn: 'none',
    kindPolicy: 'none',
    crossChannelAware: false,
  },
  session: {
    channelEq: true,
    owner: 'none',
    agentIn: 'selfOrTeam',
    sessionEq: true,
    scopeKindIn: 'sessionOrChannel',
    scopeKeyIn: 'none',
    kindPolicy: 'none',
    crossChannelAware: false,
  },
  workspace: {
    channelEq: false,
    owner: 'strict',
    agentIn: 'any',
    sessionEq: false,
    scopeKindIn: 'global',
    scopeKeyIn: 'none',
    kindPolicy: 'experienceValidatedDeployedIndustrial',
    crossChannelAware: false,
  },
  line: {
    channelEq: false,
    owner: 'strict',
    agentIn: 'any',
    sessionEq: false,
    scopeKindIn: 'line',
    scopeKeyIn: 'line',
    kindPolicy: 'experienceValidatedDeployedIndustrial',
    crossChannelAware: true,
  },
  product: {
    channelEq: false,
    owner: 'strict',
    agentIn: 'any',
    sessionEq: false,
    scopeKindIn: 'product',
    scopeKeyIn: 'product',
    kindPolicy: 'experienceValidatedDeployedIndustrial',
    crossChannelAware: true,
  },
  auto: {
    channelEq: true,
    owner: 'none',
    agentIn: 'selfOrTeam',
    sessionEq: false,
    scopeKindIn: 'sessionOrChannel',
    scopeKeyIn: 'none',
    kindPolicy: 'none',
    crossChannelAware: false,
  },
}

const SCOPE_KIND_VALUES: Record<ScopeKindSel, MemoryScopeKind[] | null> = {
  any: null,
  sessionOrChannel: ['session', 'channel'],
  global: ['global'],
  line: ['line'],
  product: ['product'],
}

/** 自动注入下的 experience 门槛（部署值来自版本表；无版本头 = none，fail-closed） */
export function experienceGateSql(alias = 'm'): string {
  return `(${alias}.kind != 'experience' OR (
    ${alias}.status = 'validated'
    AND COALESCE((
      SELECT v.deployment FROM experience_heads h JOIN experience_versions v ON v.version_id = h.version_id
       WHERE h.experience_id = ${alias}.id
    ), 'none') IN ('active', 'canary')
  ))`
}

export interface CompiledScope {
  sql: string
  params: Array<string | number>
}

/**
 * 单个 tier 的 WHERE 片段（不含 FTS MATCH）。
 * 返回片段可直接与其他条件用 AND 拼接；空 ctx 维度会退化为恒假（fail-closed）。
 */
export function compileScopeWhere(tier: ScopeTier, ctx: MemoryCtx, alias = 'm'): CompiledScope {
  if (tier === 'all' || tier === 'auto') {
    // auto = 本频道私有/团队（原有语义）+（工业模式下）本频道 line/product 经验；
    // all = auto + 共享区（owner 级）+ line/product（是否跨频道由 crossChannel 决定）
    const parts: CompiledScope[] = []
    const tiers: Array<Exclude<ScopeTier, 'all'>> = tier === 'auto'
      ? (ctx.industrial ? ['auto', 'line', 'product'] : ['auto'])
      : ['private', 'shared', 'workspace', 'line', 'product']
    for (const t of tiers) {
      const p = compileBaseTier(t, ctx, alias)
      if (p.sql !== '(1=0)') parts.push(p)
    }
    if (parts.length === 0) return { sql: '(1=0)', params: [] }
    return {
      sql: `(${parts.map(p => p.sql).join(' OR ')})`,
      params: parts.flatMap(p => p.params),
    }
  }
  return compileBaseTier(tier, ctx, alias)
}

function compileBaseTier(tier: Exclude<ScopeTier, 'all'>, ctx: MemoryCtx, alias: string): CompiledScope {
  const rule = SCOPE_RULES[tier]
  const where: string[] = [`${alias}.deleted_at IS NULL`]
  const params: Array<string | number> = []

  if (rule.channelEq) {
    where.push(`${alias}.channel_id = ?`)
    params.push(ctx.channelId)
  }
  if (rule.owner === 'strict') {
    // 严格 owner：跨频道档必须有 owner 且相等；频道内档在 owner 为 NULL（遗留库/无主频道）时
    // 允许匹配 NULL 行（否则既有无主部署的 line/product 经验会整体消失）。
    const crossChannelScope = tier === 'workspace' || (rule.crossChannelAware && ctx.crossChannel)
    if (!ctx.ownerUserId) {
      if (crossChannelScope) return { sql: '(1=0)', params: [] }
      where.push(`${alias}.owner_user_id IS NULL`)
    }
    else {
      where.push(`${alias}.owner_user_id = ?`)
      params.push(ctx.ownerUserId)
    }
  }
  if (rule.agentIn === 'self') {
    where.push(`${alias}.agent_id = ?`)
    params.push(ctx.agentId)
  }
  else if (rule.agentIn === 'selfOrTeam') {
    where.push(`${alias}.agent_id IN (?, ?)`)
    params.push(ctx.agentId, TEAM_SENTINEL)
  }
  else if (rule.agentIn === 'team') {
    where.push(`${alias}.agent_id = ?`)
    params.push(TEAM_SENTINEL)
  }
  if (rule.sessionEq) {
    if (!ctx.sessionId) return { sql: '(1=0)', params: [] }
    where.push(`${alias}.session_id = ?`)
    params.push(ctx.sessionId)
  }
  const kinds = SCOPE_KIND_VALUES[rule.scopeKindIn]
  if (kinds) {
    where.push(`${alias}.scope_kind IN (${kinds.map(() => '?').join(', ')})`)
    params.push(...kinds)
  }
  if (rule.scopeKeyIn === 'line') {
    if (ctx.lineIds.length === 0) return { sql: '(1=0)', params: [] }
    where.push(`${alias}.scope_key IN (SELECT value FROM json_each(?))`)
    params.push(JSON.stringify(ctx.lineIds))
  }
  else if (rule.scopeKeyIn === 'product') {
    if (ctx.productIds.length === 0) return { sql: '(1=0)', params: [] }
    where.push(`${alias}.scope_key IN (SELECT value FROM json_each(?))`)
    params.push(JSON.stringify(ctx.productIds))
  }
  if (rule.crossChannelAware && !ctx.crossChannel) {
    where.push(`${alias}.channel_id = ?`)
    params.push(ctx.channelId)
  }
  if (ctx.automatic) {
    // 自动注入：所有档位的 experience 都必须是 validated + 已部署（显式检索保持宽松）
    where.push(experienceGateSql(alias))
  }
  // 非工业频道：line/product/global 经验一律不可见（不论自动还是显式；承接 state.ts:48-49）
  if (!ctx.industrial) {
    where.push(`NOT (${alias}.kind = 'experience' AND ${alias}.scope_kind IN ('line', 'product', 'global'))`)
  }
  return { sql: `(${where.join(' AND ')})`, params }
}

/**
 * JS 求值器（与 compileScopeWhere 严格等价；差分测试逐条对比）。
 * 注意：部署状态无法从行本身判断（在版本表里），由调用方通过 `deploymentOf` 注入。
 */
export function rowMatchesTier(
  row: Pick<MemoryRow, 'channelId' | 'agentId' | 'sessionId' | 'scopeKind' | 'scopeKey' | 'kind' | 'status' | 'deletedAt' | 'ownerUserId'>,
  ctx: MemoryCtx,
  tier: ScopeTier,
  deploymentOf?: (rowId: string) => string | null,
): boolean {
  if (row.deletedAt) return false
  if (tier === 'all') {
    return (['private', 'shared', 'workspace', 'line', 'product'] as const)
      .some(t => rowMatchesTier(row, ctx, t, deploymentOf))
  }
  if (tier === 'auto') {
    // auto = 本频道私有/团队（+ 工业模式下本频道 line/product 经验）
    const tiers = ctx.industrial
      ? (['auto', 'line', 'product'] as const)
      : (['auto'] as const)
    return tiers.some((t) => {
      const r = SCOPE_RULES[t]
      // auto 分支只含 auto/line/product；workspace 只在 all 档出现
      const crossChannelScope = r.crossChannelAware && ctx.crossChannel
      return matchRule(r, row, ctx, deploymentOf, crossChannelScope)
    })
  }
  const rule = SCOPE_RULES[tier]
  const crossChannelScope = tier === 'workspace' || (rule.crossChannelAware && ctx.crossChannel)
  return matchRule(rule, row, ctx, deploymentOf, crossChannelScope)
}

function matchRule(
  rule: ScopeRule,
  row: Pick<MemoryRow, 'channelId' | 'agentId' | 'sessionId' | 'scopeKind' | 'scopeKey' | 'kind' | 'status' | 'ownerUserId'>,
  ctx: MemoryCtx,
  deploymentOf: ((rowId: string) => string | null) | undefined,
  crossChannelScope: boolean,
): boolean {
  if (rule.channelEq && row.channelId !== ctx.channelId) return false
  if (rule.owner === 'strict') {
    if (ctx.ownerUserId) {
      if ((row.ownerUserId ?? null) !== ctx.ownerUserId) return false
    }
    else {
      if (crossChannelScope) return false
      if ((row.ownerUserId ?? null) !== null) return false
    }
  }
  if (rule.agentIn === 'self' && row.agentId !== ctx.agentId) return false
  if (rule.agentIn === 'selfOrTeam' && row.agentId !== ctx.agentId && row.agentId !== TEAM_SENTINEL) return false
  if (rule.agentIn === 'team' && row.agentId !== TEAM_SENTINEL) return false
  if (rule.sessionEq && (!ctx.sessionId || row.sessionId !== ctx.sessionId)) return false
  const kinds = SCOPE_KIND_VALUES[rule.scopeKindIn]
  if (kinds && !kinds.includes((row.scopeKind ?? 'session') as MemoryScopeKind)) return false
  if (rule.scopeKeyIn === 'line') {
    if (ctx.lineIds.length === 0 || !ctx.lineIds.includes(row.scopeKey ?? '')) return false
  }
  else if (rule.scopeKeyIn === 'product') {
    if (ctx.productIds.length === 0 || !ctx.productIds.includes(row.scopeKey ?? '')) return false
  }
  if (rule.crossChannelAware && !ctx.crossChannel && row.channelId !== ctx.channelId) return false
  if (ctx.automatic) {
    // 自动注入：所有档位的 experience 都必须是 validated + 已部署（显式检索保持宽松）
    if (row.kind === 'experience') {
      if ((row.status ?? 'active') !== 'validated') return false
      const dep = deploymentOf?.(String((row as { id?: string }).id ?? '')) ?? 'none'
      if (dep !== 'active' && dep !== 'canary') return false
    }
  }
  // 非工业频道：line/product/global 经验一律不可见（不论自动还是显式）
  if (!ctx.industrial && row.kind === 'experience'
    && (row.scopeKind === 'line' || row.scopeKind === 'product' || row.scopeKind === 'global')) return false
  return true
}

/** retired 一律不可见（任何档位/任何路径） */
export function statusVisible(status: MemoryStatus | undefined): boolean {
  return status !== 'retired'
}

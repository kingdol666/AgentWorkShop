/**
 * AgentMemoryState —— 构造与向量索引 / 作用域判定
 * (拆分层,承 AgentMemoryContracts;方法体与原文件逐行一致)
 */
import { AgentMemoryContracts } from './contracts'
import type { AgentMemoryOptions, MemoryScope, ScopeContext } from './types'
import type { EmbeddingProvider } from '../embedding-provider'
import type { MemoryRepo } from '../../db/memory.repo'
import type { MemoryRow } from '../../db/database'
import { TEAM_AGENT_ID } from '../../db/memory.repo'

export abstract class AgentMemoryState extends AgentMemoryContracts {
  protected embedder: EmbeddingProvider | null

  protected trustedScopeContext: ScopeContext

  constructor(
    protected repo: MemoryRepo,
    protected opts: AgentMemoryOptions,
  ) {
    super()
    this.embedder = opts.embedder ?? null
    const channelScope = repo.channelScope(opts.channelId)
    this.trustedScopeContext = {
      lineId: opts.lineId ?? channelScope.lineId,
      productId: opts.productId ?? channelScope.productId,
    }
  }

  /** 向量层惰性初始化(vecReady 后 no-op;建表失败一次性禁用 embedder) */
  protected ensureVec(): void {
    if (this.repo.vecReady) return
    const dims = this.embedder?.dims()
    if (dims && !this.repo.vecInit(dims)) this.embedder = null
  }

  /**
   * scope 过滤：private 仅本人行；shared 仅本 channel 的 team 行；session 仅当前会话行；auto 双域。
   *
   * 说明（2026-11-26）：`memory-scopes.ts` 的规则表 + 双编译器是**新增档位（workspace/line/product/all）**
   * 与管理面列表的唯一口径；本方法保留原有四档的逐条语义（差分测试覆盖二者在四档上的等价性）。
   * 之所以不直接把此处换成表驱动：`private` 档历史上还要包含"可信 product/line 经验"
   * （见 tests/memory-private-channel-isolation），而表中该档限定 scopeKind=session|channel。
   */
  protected inScope(row: MemoryRow, scope: MemoryScope, sessionId?: string | null, scopeContext?: ScopeContext, automatic = false, asOf?: string | null): boolean {
    // RSI(WP-A3):retired 经验不参与任何档位检索/注入(过期或劣化回滚后的行只保留审计价值)
    if (row.status === 'retired') return false
    // 批次 K：时序有效性（失效不删除；默认排除失效，asOf 回看历史）
    const at = asOf ? Date.parse(asOf) : Date.now()
    if (row.validFrom && Date.parse(row.validFrom) > at) return false
    if (row.validTo && Date.parse(row.validTo) <= at) return false
    // Memory Fabric 策略（批次 I）：disabled 不读；isolated 不读 workspace/line/product
    const accessMode = this.repo.memoryAccessMode(this.opts.channelId, sessionId ?? this.opts.sessionId)
    if (accessMode === 'disabled') return false
    if (accessMode === 'isolated' && row.scopeKind && ['line', 'product', 'global'].includes(row.scopeKind)) return false
    // 软删行：检索/注入/统计一律不可见（FTS 触发器对任意 UPDATE 都会重建索引，
    // 因此删除不能依赖物理清理，必须由读侧统一过滤）
    if (row.deletedAt) return false
    // Task 4:自动注入只认 validated + 已获准部署(canary/active)。candidate、shadow、
    // legacy-unverified(旧行回填)一律不进提示,堵住「未验证内容有资格入词」。
    if (automatic && row.kind === 'experience') {
      if (row.status !== 'validated') return false
      const deployment = this.repo.experienceDeployment(row.id)
      if (deployment !== 'active' && deployment !== 'canary') return false
    }
    if (row.kind === 'experience' && this.opts.industrialScopeEnabled !== true
      && (row.scopeKind === 'line' || row.scopeKind === 'product' || row.scopeKind === 'global')) return false
    if (row.kind === 'experience' && (row.scopeKind === 'line' || row.scopeKind === 'product')) {
      const trustedId = row.scopeKind === 'line' ? this.opts.lineId : this.opts.productId
      if (!trustedId || row.scopeKey !== trustedId) return false
      if (!automatic) {
        const requestedId = row.scopeKind === 'line' ? scopeContext?.lineId : scopeContext?.productId
        if (requestedId && requestedId !== trustedId) return false
      }
    }
    const isTeam = row.agentId === TEAM_AGENT_ID
    if (row.channelId !== this.opts.channelId) return false
    if (scope === 'session') {
      if (!sessionId) return false
      if (row.sessionId !== sessionId) return false
      return isTeam || row.agentId === this.opts.agentId
    }
    // 批次 A：自动注入按会话隔离（当前会话 + 无会话归属的频道级行；显式检索不拦）
    if (automatic && scope === 'auto') {
      const sid = row.sessionId ?? ''
      if (sessionId ? (sid !== sessionId && sid !== '') : sid !== '') return false
    }
    return scope === 'auto'
      ? (isTeam || row.agentId === this.opts.agentId)
      : scope === 'shared'
        ? isTeam
        : row.agentId === this.opts.agentId
  }
}

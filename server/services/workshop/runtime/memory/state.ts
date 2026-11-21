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

  /** scope 过滤:private 仅本人行;shared 仅本 channel 的 team 行;session 仅本人/本 channel 的当前会话行;auto 双域 */
  protected inScope(row: MemoryRow, scope: MemoryScope, sessionId?: string | null, scopeContext?: ScopeContext, automatic = false): boolean {
    // RSI(WP-A3):retired 经验不参与任何档位检索/注入(过期或劣化回滚后的行只保留审计价值)
    if (row.status === 'retired') return false
    if (automatic && row.kind === 'experience' && row.status === 'candidate') return false
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
    return scope === 'auto'
      ? (isTeam || row.agentId === this.opts.agentId)
      : scope === 'shared'
        ? isTeam
        : row.agentId === this.opts.agentId
  }
}

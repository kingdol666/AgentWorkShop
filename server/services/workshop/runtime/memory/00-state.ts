/**
 * AgentMemoryLayer00 —— 构造与向量索引 / 作用域判定
 * (分层 1/5,承 AgentMemoryContracts;方法体与原文件逐行一致)
 */
import { AgentMemoryContracts } from './contracts'
import type { AgentMemoryOptions, MemoryScope } from './types'
import type { EmbeddingProvider } from '../embedding-provider'
import type { MemoryRepo } from '../../db/memory.repo'
import type { MemoryRow } from '../../db/database'
import { TEAM_AGENT_ID } from '../../db/memory.repo'

export abstract class AgentMemoryLayer00 extends AgentMemoryContracts {
  protected embedder: EmbeddingProvider | null

  constructor(
    protected repo: MemoryRepo,
    protected opts: AgentMemoryOptions,
  ) {
    super()
    this.embedder = opts.embedder ?? null
  }

  /** 向量层惰性初始化(vecReady 后 no-op;建表失败一次性禁用 embedder) */
  protected ensureVec(): void {
    if (this.repo.vecReady) return
    const dims = this.embedder?.dims()
    if (dims && !this.repo.vecInit(dims)) this.embedder = null
  }

  /** scope 过滤:private 仅本人行;shared 仅本 channel 的 team 行;auto 双域 */
  protected inScope(row: MemoryRow, scope: MemoryScope): boolean {
    const isTeam = row.agentId === TEAM_AGENT_ID
    if (isTeam && row.channelId !== this.opts.channelId) return false
    return scope === 'auto'
      ? (isTeam || row.agentId === this.opts.agentId)
      : scope === 'shared'
        ? isTeam
        : row.agentId === this.opts.agentId
  }
}

/**
 * OmpRpcAgentImplLayer01 —— 上下文治理(70% 无中断压缩环)与构造
 * (分层 2/6,承 OmpRpcAgentImplLayer00;方法体与原文件逐行一致)
 */
import { OmpRpcAgentImplLayer00 } from './00-core'
import type { AgentContextStats } from '../../types/task'
import type { CompactionResult, OmpRpcClient } from '../adapters/omp-rpc-client'
import { log } from './helpers'
import { ompSettings } from '../../settings'
import { renderPrompt } from '../../prompts/loader'

export abstract class OmpRpcAgentImplLayer01 extends OmpRpcAgentImplLayer00 {
  /** 压缩进行中(平台 gate 与 omp 原生压缩共用互斥位) */
  protected compacting = false
  protected lastCompactAt = 0
  /** omp 不支持 compact 命令(旧版)→ 永久停用平台压缩;原生 auto-compaction 兜底,harvest 照常 */
  protected compactLegacy = false
  /** 模型上下文窗口(get_state/get_session_stats 探测;null = 未知,percent 不可算) */
  protected contextWindow: number | null = null
  protected sessionId: string | null = null
  /** harvest 双路去重(compact 响应与 compaction_end 事件可能双达) */
  protected lastHarvestKey = ''
  protected lastHarvestAt = 0

  /** 总开关(omp.compact_enabled;env AW_OMP_COMPACT_ENABLED=0 显式关闭兼容) */
  protected compactEnabled(): boolean {
    return ompSettings().compact_enabled
  }

  protected compactThreshold(): number {
    return ompSettings().compact_threshold
  }

  protected compactMinIntervalMs(): number {
    return ompSettings().compact_min_interval_ms
  }

  protected compactWaitMs(): number {
    return ompSettings().compact_wait_ms
  }

  /** 被动上下文用量快照(无探测 RPC;getStatus 透出用) */
  getContextStats(): AgentContextStats | null {
    const usage = this.client?.getContextUsage() ?? null
    const window = this.contextWindow ?? usage?.contextWindow ?? null
    if (!usage && window === null) return null
    const usedTokens = usage?.tokens ?? 0
    return {
      usedTokens,
      contextWindow: window,
      percent: window && window > 0 ? Math.min(1, usedTokens / window) : null,
      compacting: this.compacting,
    }
  }

  /**
   * 上下文用量探测:get_session_stats 权威值;不可用退化为被动 usage + 已探测窗口。
   * percent 归一化到 0-1(omp 可能返回 0-100)。
   */
  protected async probeUsage(client: OmpRpcClient): Promise<{ tokens: number, contextWindow: number | null, percent: number | null } | null> {
    try {
      const resp = await client.send({ type: 'get_session_stats' })
      const cu = ((resp.data ?? {}) as Record<string, unknown>).contextUsage as
        | { tokens?: number, contextWindow?: number, percent?: number }
        | undefined
      if (cu && typeof cu.tokens === 'number' && cu.tokens > 0) {
        if (typeof cu.contextWindow === 'number' && cu.contextWindow > 0) {
          this.contextWindow = cu.contextWindow
          client.setContextWindow(cu.contextWindow)
        }
        const window = this.contextWindow ?? cu.contextWindow ?? null
        const rawPercent = typeof cu.percent === 'number' ? (cu.percent > 1 ? cu.percent / 100 : cu.percent) : null
        const percent = rawPercent ?? (window && window > 0 ? Math.min(1, cu.tokens / window) : null)
        return { tokens: cu.tokens, contextWindow: window, percent }
      }
    }
    catch { /* get_session_stats 不可用 → 被动跟踪 */ }
    return client.getContextUsage()
  }

  /**
   * 上下文治理门控:三条 prompt 路径(worker/peer/supervise)在回合间隙统一调用;
   * post-settle 经 onTurnSettled 复用同一守卫。任何失败路径都放行——压缩晚一轮
   * 永远好过中断作业。三重防线:仅回合间隙发起 → get_state 复查 isStreaming/
   * isCompacting → compacting 互斥位 + 最小间隔防振荡。
   */
  protected async contextGate(reason: string): Promise<void> {
    if (!this.compactEnabled() || this.compactLegacy || this.compacting) return
    const client = this.client
    if (!client || !client.alive) return
    try {
      const usage = await this.probeUsage(client)
      if (!usage || usage.percent === null || usage.percent < this.compactThreshold()) return
      if (Date.now() - this.lastCompactAt < this.compactMinIntervalMs()) return
      // 回合间隙硬校验:流式中/压缩中绝不发起(不中断执行的硬约束)
      const st = await client.send({ type: 'get_state' })
      const s = (st.data ?? {}) as Record<string, unknown>
      if (s.isStreaming === true || s.isCompacting === true) return
      if (typeof s.sessionId === 'string' && s.sessionId) this.sessionId = s.sessionId
      this.compacting = true
      this.lastCompactAt = Date.now()
      try {
        const result = await this.runCompaction(client)
        if (result?.summary) {
          await this.harvestCompaction(
            result.summary,
            result.tokensBefore,
            result.tokensAfter ?? result.estimatedTokensAfter,
            reason,
          )
        }
      }
      finally {
        this.compacting = false
      }
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/compact/i.test(msg) && /unknown|unsupported|invalid|无效|未知|不支持/i.test(msg)) this.compactLegacy = true
      log.warn(`[OmpRpcAgent:${this.selfAgentId}] contextGate(${reason}) 失败,放行: ${msg}`)
    }
  }

  /**
   * 发起 compact 并等待 compaction_end(响应内含 result 则立即收口;
   * 超时放行——压缩在 harness 内后台继续,isCompacting 防后续双发)。
   */
  protected runCompaction(client: OmpRpcClient): Promise<CompactionResult | null> {
    return new Promise<CompactionResult | null>((resolve) => {
      let settled = false
      const finish = (r: CompactionResult | null): void => {
        if (settled) return
        settled = true
        off()
        clearTimeout(timer)
        resolve(r)
      }
      const off = client.onEvent((event) => {
        if (event.type === 'compaction_end') {
          finish((event as { result?: CompactionResult }).result ?? null)
        }
        else if (event.type === '__process_exit__') {
          finish(null)
        }
      })
      const timer = setTimeout(() => {
        log.warn(`[OmpRpcAgent:${this.selfAgentId}] compact 等待超时(${this.compactWaitMs()}ms)→ 放行(压缩后台继续)`)
        finish(null)
      }, this.compactWaitMs())
      void client.send({ type: 'compact', customInstructions: this.compactionHints() })
        .then((resp) => {
          const result = (resp.data as { result?: CompactionResult } | undefined)?.result
          if (result?.summary) finish(result)
          // 响应无 result:等 compaction_end 事件(协议权威语义)
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err)
          if (/compact/i.test(msg)) this.compactLegacy = true
          log.warn(`[OmpRpcAgent:${this.selfAgentId}] compact 发起失败: ${msg}`)
          finish(null)
        })
    })
  }

  /** 压缩摘要指令(外置 prompts;缺失时省略,omp 用默认策略) */
  protected compactionHints(): string | undefined {
    try {
      return renderPrompt('compaction-hints')
    }
    catch {
      return undefined
    }
  }

  /**
   * 压缩摘要 harvest(三路统一:平台主动 compact / omp 阈值自动 / overflow):
   * 经 workspace.recordSessionMemory 落库为本人 episodic-session 记忆。
   * 双路去重:同摘要 60s 内只入库一次。
   */
  protected async harvestCompaction(summary: string, tokensBefore?: number, tokensAfter?: number, reason?: string): Promise<void> {
    const key = summary.slice(0, 120)
    if (key === this.lastHarvestKey && Date.now() - this.lastHarvestAt < 60_000) return
    this.lastHarvestKey = key
    this.lastHarvestAt = Date.now()
    try {
      await this.workspace?.recordSessionMemory?.({ summary, tokensBefore, tokensAfter, reason })
      log.info(`[OmpRpcAgent:${this.selfAgentId}] 压缩摘要已入记忆(${summary.length} 字,reason=${reason ?? 'auto'})`)
    }
    catch (err) {
      log.warn(`[OmpRpcAgent:${this.selfAgentId}] 压缩摘要入库失败(不影响会话):`, err instanceof Error ? err.message : err)
    }
  }

  /** 回合落定钩子(AgentRuntime 在信箱空时调用):后台压缩检查,自守卫不抛错 */
  async onTurnSettled(): Promise<void> {
    await this.contextGate('post-settle')
  }
}

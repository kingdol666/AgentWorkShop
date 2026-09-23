/**
 * 启动对账(恢复悬挂的待审批)
 * (由 server/services/workshop/agents/hitl-decision.ts 按职责拆出;内容逐行原文搬运)
 */
import { log } from './shared'
import { resolveHitlRuntime } from '../hitl-registry'

// ============================================================================
// 启动对账(重启不自动批准)
// ============================================================================

export const g = globalThis as typeof globalThis & { __hitlReconciledAt?: string }

/**
 * 本进程启动水位:启动对账只处理**早于本进程**创建的条目。
 * 理由:原生会话随进程消亡,只有上一进程遗留的待办才"必然不可应答";
 * 本进程内新建的 pending 是 live 条目,绝不能被一次惰性对账误杀。
 */
export const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString()

/**
 * 启动对账:把随上一进程消亡的原生会话条目(非终态)全部置 failed,**绝不自动批准**。
 * - 默认只处理 `createdAt < PROCESS_STARTED_AT` 的条目(重启遗留);`force` 则处理全部非终态
 *   (运维/测试显式语义:视同重启);
 * - 纯重启场景(全部非终态都早于本进程)走仓储 `failAllNonTerminalOnRestart`;
 *   混合场景(含本进程 live 条目)逐条 finalize('failed'),live 条目保持 pending;
 * - 幂等:同进程只跑一次(force 可重跑);无持久化层 → 返回空清单(纯内存脚手架)。
 */
export function reconcileHitlOnStartup(opts: { force?: boolean, error?: string, before?: string } = {}): {
  failed: number
  entries: Array<{ kind: string, id: string, status: string, channelId: string, nativeConfirmed: boolean }>
} {
  const manager = resolveHitlRuntime()
  const repo = manager?.groupChat?.hitl
  if (!manager || !repo) return { failed: 0, entries: [] }
  if (g.__hitlReconciledAt && !opts.force && !opts.before) {
    return { failed: 0, entries: [] }
  }
  g.__hitlReconciledAt = new Date().toISOString()
  try {
    const all = repo.listNonTerminal()
    const watermark = opts.before ?? PROCESS_STARTED_AT
    const stale = opts.force ? all : all.filter(r => r.createdAt < watermark)
    if (stale.length === 0) return { failed: 0, entries: [] }
    const sample = stale.slice(0, 10).map(r => `${r.kind}:${r.id}`).join(', ')
    const error = opts.error
      ?? `服务重启:原生会话已随上一进程失效,待办不可再应答(未自动批准);受影响 ${stale.length} 条:${sample}`
    let failed: number
    if (stale.length === all.length) {
      // 纯重启:整表非终态都是上一进程遗留 → 仓储级启动恢复入口(绝不自动批准)
      failed = repo.failAllNonTerminalOnRestart(error)
    }
    else {
      // 混合:只收敛确属上一进程的条目,本进程 live 待办保持 pending
      failed = 0
      for (const r of stale) {
        if (repo.finalize(r.id, 'failed', { nativeConfirmed: false, error })) failed += 1
      }
    }
    log.warn(`[hitl] 启动对账:${failed} 条非终态待办置 failed(绝不自动批准)`)
    return {
      failed,
      entries: stale.map(r => ({ kind: r.kind, id: r.id, status: r.status, channelId: r.channelId, nativeConfirmed: false })),
    }
  }
  catch (err) {
    log.error('[hitl] 启动对账失败:', err instanceof Error ? err.message : err)
    return { failed: 0, entries: [] }
  }
}

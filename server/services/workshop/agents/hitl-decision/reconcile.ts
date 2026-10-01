/**
 * 启动对账(恢复悬挂的待审批)
 * (由 server/services/workshop/agents/hitl-decision.ts 按职责拆出;内容逐行原文搬运)
 */
import { log } from './shared'
import { resolveHitlRuntime } from '../hitl-registry'
import { sendHitlNote } from '../../runtime/platform-notice'
import { getOps } from '../../ops/ops'

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
    // 审批历史同步收敛:request 即落库的 pending 行(tool-approvals 出生留痕)随对账
    // 一并置 failed——重启后"审批历史"与"HITL 待办面"口径一致, forensic 不留半态。
    try {
      const hist = getOps()?.approvalHistory
      if (hist) {
        const now = new Date().toISOString()
        for (const row of hist.list(500)) {
          if (row.status !== 'pending' || row.createdAt >= watermark) continue
          hist.upsert({
            id: row.id,
            agentId: row.agentId,
            nodeId: row.nodeId,
            kind: row.kind,
            detail: row.detail,
            status: 'failed',
            comment: error,
            decidedAt: now,
            createdAt: row.createdAt,
            payloadJson: row.payloadJson ?? '',
            choice: row.choice ?? null,
          })
        }
      }
    }
    catch { /* 历史同步失败不影响对账主流程 */ }
    // Agent 侧补送:受影响的审批等待方(其回合随上一进程消亡)必须知道"发生过审批、
    // 未执行、未自动批准",否则人类面对过的决议对 Agent 而言凭空蒸发(人机断话)。
    // 直接落 messages 表(此时 runtime 未装配也持久),Agent 下次装配即从信箱看到。
    try {
      const byAgent = new Map<string, { channelId?: string, titles: string[] }>()
      for (const r of stale) {
        if (!r.agentId) continue
        const agg = byAgent.get(r.agentId) ?? { channelId: r.channelId || undefined, titles: [] }
        agg.titles.push(`${r.kind}:${r.title || r.id}`)
        byAgent.set(r.agentId, agg)
      }
      for (const [agentId, agg] of byAgent) {
        sendHitlNote({
          agentId,
          ...(agg.channelId ? { channelId: agg.channelId } : {}),
          title: '服务重启,挂起审批已失效',
          summary: `服务重启对账:你有 ${agg.titles.length} 条挂起审批随上一进程失效(未执行、未自动批准):\n- ${agg.titles.join('\n- ')}\n如仍需执行请重新发起,新审批单会实时回流人类的决议与附言。`,
        })
      }
    }
    catch (err) {
      log.warn(`[hitl] 启动对账补送失败(不影响对账结果): ${err instanceof Error ? err.message : err}`)
    }
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

/**
 * RecipeRollBackManagerLayer04 —— 系统兜底评估(按 sweep 节拍)
 * (分层 5/7,承 RecipeRollBackManagerLayer03;方法体与原文件逐行一致)
 */
import { RecipeRollBackManagerLayer03 } from './03-rollback'
import type { OptimizationRecord } from '../../../../../shared/dcw-protocol'
import { BREACH_THRESHOLD, MAX_AUTO_ROLLBACKS, MIN_WINDOW_MS, RECHECK_MS } from './helpers'
import { recordOps } from '../../ops/ops'

export abstract class RecipeRollBackManagerLayer04 extends RecipeRollBackManagerLayer03 {
  evaluateOpenRecords(now: number): void {
    // 走 open 索引(O(open))而非 listRecords 的「全量倒序 + limit 500」:
    // 后者在 open 记录 >500 时会**静默漏评估**,且每次 sweep 都对全量 records 做一次拷贝。
    for (const record of this.repo.listOpenRecords()) {
      if (record.policy === 'observe_only')
        continue
      const setMs = Date.parse(record.setAt)
      if (now - setMs < MIN_WINDOW_MS())
        continue
      if (record.evaluatedAt && now - Date.parse(record.evaluatedAt) < RECHECK_MS)
        continue
      record.evaluatedAt = new Date(now).toISOString()
      void this.evaluateOnce(record)
    }
  }

  protected async evaluateOnce(record: OptimizationRecord): Promise<void> {
    try {
      const from = Date.parse(record.setAt)
      const agg = await this.captureMetrics(record.nodeId, record.lineId, record.recipeId, from, Date.now())
      const totalBreaches = agg.channels.reduce((sum, c) => sum + Math.max(0, c.breaches), 0)
      if (totalBreaches < BREACH_THRESHOLD) {
        this.repo.updateRecord(record.id, { evaluatedAt: record.evaluatedAt, windowAgg: record.windowAgg ?? agg })
        return
      }
      const reason = `观察窗内数采越配方监控窗累计 ${totalBreaches} 采样(阈值 ${BREACH_THRESHOLD}),系统兜底判定回退`
      if (record.policy === 'auto_rollback' && this.repo.chainRollbackCount(record.nodeId) < MAX_AUTO_ROLLBACKS) {
        record.judge = { by: 'system', actor: 'system', verdict: 'rollback', reason, at: new Date().toISOString() }
        this.repo.updateRecord(record.id, { judge: record.judge, evaluatedAt: record.evaluatedAt })
        this.emit('judged', record)
        recordOps({
          actor: 'system',
          actorName: 'system',
          actorKind: 'system',
          action: 'optimization.judge',
          kind: 'rollback',
          targetKind: 'optimization',
          targetId: record.id,
          summary: `系统兜底判定回退:窗口内累计越限 ${totalBreaches} 采样,自动恢复基线`,
          lineId: record.lineId ?? '',
          recipeId: record.recipeId ?? '',
          detail: { breaches: totalBreaches, policy: record.policy },
        })
        await this.rollbackRecord(record.id, 'system', 'system')
      }
      else {
        // approve_rollback 或自动回退链达上限:提议人工确认(判定入册,执行等 REST/工具)
        record.judge = {
          by: 'system',
          actor: 'system',
          verdict: 'rollback',
          reason: `${reason};${record.policy === 'approve_rollback' ? '等待人工确认' : '自动回退链达上限,升级人工'}`,
          at: new Date().toISOString(),
        }
        this.repo.updateRecord(record.id, { judge: record.judge, evaluatedAt: record.evaluatedAt })
        this.emit('judged', record)
      }
    }
    catch (err) {
      console.error('[recipe-rollback] 兜底评估失败:', record.id, err)
    }
  }

  // ================================================================
  // 数据面:窗口聚合 / 台账 / 序列(全部复用 lineQuery 参数化查询)
  // ================================================================
}

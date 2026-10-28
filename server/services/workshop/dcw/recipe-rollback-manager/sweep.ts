/**
 * RecipeRollBackManagerSweep —— 系统兜底评估(按 sweep 节拍)
 * (拆分层,承 RecipeRollBackManagerRollback;方法体与原文件逐行一致)
 */
import { RecipeRollBackManagerRollback } from './rollback'
import type { OptimizationRecord } from '../../../../../shared/dcw-protocol'
import { BREACH_THRESHOLD, MAX_AUTO_ROLLBACKS, MIN_WINDOW_MS, RECHECK_MS } from './helpers'
import { recordOps } from '../../ops/ops'

export abstract class RecipeRollBackManagerSweep extends RecipeRollBackManagerRollback {
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
      // 2026-10-28:回退写产生的记录不再参与自动兜底 —— 否则"回退的回退"会写回问题值。
      if (record.rollbackOf) return
      const from = Date.parse(record.setAt)
      const agg = await this.captureMetrics(record.nodeId, record.lineId, record.recipeId, from, Date.now())
      // B-P1-1(2026-10-28 审查):captureMetrics 是跨 await 的长查询 —— 期间世界已变。
      // 判定/执行前必须重验"这条记录还是不是当前该行动的那条",否则会:
      //  ① 覆盖人工已下的 uncertain/判词(推翻人的裁决);
      //  ② 记录已被关闭/被执行(重复物理写);
      //  ③ 同节点已有更新的写意图接管(按旧值回退,把最新意图冲掉)。
      // 三者任一发生都只补记聚合(windowAgg)并返回,绝不产生任何写入。
      const latest = this.repo.byId(record.id)
      if (!latest || latest.status !== 'open' || latest.judge) {
        if (latest?.status === 'open') {
          this.repo.updateRecord(latest.id, { evaluatedAt: latest.evaluatedAt, windowAgg: latest.windowAgg ?? agg })
        }
        return
      }
      const current = this.repo.openRecordOf(record.nodeId)
      if (!current || current.id !== record.id) {
        this.repo.updateRecord(latest.id, { evaluatedAt: latest.evaluatedAt, windowAgg: latest.windowAgg ?? agg })
        return
      }
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

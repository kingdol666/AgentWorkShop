/**
 * RecipeRollBackManagerJudge —— 判定:Agent / 系统 / 用户 三路
 * (拆分层,承 RecipeRollBackManagerLock;方法体与原文件逐行一致)
 */
import { RecipeRollBackManagerLock } from './lock'
import type { OptimizationRecord, OptimizationVerdict } from '../../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { OPEN_RECORD_STALE_MS } from './helpers'
import { recordOps } from '../../ops/ops'

export abstract class RecipeRollBackManagerJudge extends RecipeRollBackManagerLock {
  /** 孤儿判定:open 记录超时未判定(属主可能已消失)→ 可被后续 Agent 接管 */
  isStale(record: OptimizationRecord): boolean {
    return record.status === 'open' && Date.now() - Date.parse(record.setAt) > OPEN_RECORD_STALE_MS()
  }

  judge(recordId: string, verdict: OptimizationVerdict, reason: string, by: 'agent' | 'system' | 'user', actor: string, opts?: { takeover?: boolean, actorName?: string }): OptimizationRecord {
    const record = this.repo.byId(recordId)
    if (!record)
      throw new AppError(404, ErrorCodes.NOT_FOUND, `优化记录不存在: ${recordId}`)
    if (record.status !== 'open')
      throw new AppError(409, ErrorCodes.CONFLICT, `记录 ${recordId} 已关闭(closedBy=${record.closedBy ?? '?'}),判定仅对进行中的记录有效`)
    record.judge = { by, actor, verdict, reason, at: new Date().toISOString() }
    if (verdict === 'keep') {
      this.closeRecord(record, 'judged', record.judge)
      record.status = 'judged-keep'
      if (!opts?.takeover)
        this.markGoodFromRecord(record)
    }
    // rollback:只落判定,不执行;uncertain:落判定,记录保持 open(判定与执行分离)
    this.repo.updateRecord(recordId, { judge: record.judge, status: record.status, closedAt: record.closedAt, closedBy: record.closedBy, windowAgg: record.windowAgg })
    this.emit('judged', record)
    recordOps({
      actor,
      actorName: opts?.actorName ?? actor,
      actorKind: by,
      action: 'optimization.judge',
      kind: 'rollback',
      targetKind: 'optimization',
      targetId: recordId,
      summary: `${by === 'agent' ? 'Agent' : by === 'user' ? '人工' : '系统'}判定 ${record.nodeName ?? record.nodeId} → ${verdict}:${reason.slice(0, 80)}`,
      lineId: record.lineId ?? '',
      recipeId: record.recipeId ?? '',
      detail: { verdict, reason, takeover: opts?.takeover ?? false },
    })
    return record
  }

  // ================================================================
  // 分级回退(全部经 controller.write 单点;动态 import 防循环)
  // ================================================================
}

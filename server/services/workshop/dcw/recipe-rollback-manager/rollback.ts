/**
 * RecipeRollBackManagerRollback —— 分级回退(全部经 controller.write 单点)
 * (拆分层,承 RecipeRollBackManagerJudge;方法体与原文件逐行一致)
 */
import { RecipeRollBackManagerJudge } from './judge'
import type { DcwWriteMeta, OptimizationRecord } from '../../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { COOLDOWN_MS } from './helpers'
import { getDcwNodeRepo } from '../dcw-node.repo'
import { getDcwRecipeRepo } from '../dcw-recipe.repo'
import { recordOps } from '../../ops/ops'

export abstract class RecipeRollBackManagerRollback extends RecipeRollBackManagerJudge {
  /** 回退一条优化记录:目标 = 该记录的 from 值(设定前基线) */
  async rollbackRecord(recordId: string, actor: string, by: 'agent' | 'user' | 'system', approvalId?: string, opts?: { actorName?: string }): Promise<OptimizationRecord> {
    const record = this.repo.byId(recordId)
    if (!record)
      throw new AppError(404, ErrorCodes.NOT_FOUND, `优化记录不存在: ${recordId}`)
    const from = record.params[0]?.from
    if (from == null)
      throw new AppError(409, ErrorCodes.CONFLICT, `记录 ${recordId} 无基线值(首写无 prevValue),无法回退`)
    if (by === 'agent')
      this.checkRollbackAllowed(record.nodeId)
    return this.executeRollbackWrite(record, from, actor, approvalId, undefined, by, opts?.actorName)
  }

  /** 节点级单步回退:目标 = 最近稳定锚的 prevValue(撤销栈栈顶) */
  async rollbackNode(nodeId: string, actor: string, by: 'agent' | 'user' | 'system', toAnchorId?: string, opts?: { actorName?: string }): Promise<OptimizationRecord> {
    const node = getDcwNodeRepo().byId(nodeId)
    if (!node)
      throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${nodeId}`)
    const anchor = toAnchorId ? this.repo.anchorById(toAnchorId) : this.repo.lastStableAnchor(nodeId)
    if (!anchor)
      throw new AppError(409, ErrorCodes.CONFLICT, `节点「${node.name}」无可回退锚(账本无 prevValue≠newValue 的历史)`)
    if (anchor.prevValue == null)
      throw new AppError(409, ErrorCodes.CONFLICT, '目标锚无基线值(首写锚),无法回退')
    if (by === 'agent')
      this.checkRollbackAllowed(nodeId)
    return this.executeRollbackWrite(
      {
        id: `node:${nodeId}`,
        nodeId,
        nodeName: node.name,
        lineId: node.lineId,
        params: [{ nodeId, templateRef: node.templateRef, from: anchor.prevValue, to: anchor.newValue }],
      } as unknown as OptimizationRecord,
      anchor.prevValue,
      actor,
      undefined,
      toAnchorId,
      by,
      opts?.actorName,
    )
  }

  /** 批次级回退:恢复该 run 涉及节点在 run.startedAt 之前的值(撤销这次实验) */
  async rollbackRun(runId: string, actor: string): Promise<Array<{ nodeId: string, ok: boolean, message: string }>> {
    const run = getDcwRecipeRepo().runById(runId)
    if (!run)
      throw new AppError(404, ErrorCodes.NOT_FOUND, `批次不存在: ${runId}`)
    const startedMs = Date.parse(run.startedAt)
    const nodeIds = [...new Set(run.results.map(r => r.nodeId).filter((v): v is string => !!v))]
    const outcomes: Array<{ nodeId: string, ok: boolean, message: string }> = []
    for (const nodeId of nodeIds) {
      const anchor = this.repo.lastStableBefore(nodeId, startedMs)
      if (!anchor || anchor.prevValue == null) {
        outcomes.push({ nodeId, ok: false, message: '无批次前基线锚,跳过' })
        continue
      }
      try {
        await this.writeViaController(nodeId, anchor.prevValue, { source: 'rollback', actor, hypothesis: `批次 ${runId} 撤销:恢复 ${anchor.prevValue}` })
        outcomes.push({ nodeId, ok: true, message: `已恢复 ${anchor.prevValue}` })
      }
      catch (err) {
        outcomes.push({ nodeId, ok: false, message: err instanceof Error ? err.message : String(err) })
      }
    }
    return outcomes
  }

  /** 基准恢复:重新下发 lastGood 批次冻结的参数集 */
  async rollbackRecipeGood(recipeId: string, actor: string): Promise<Array<{ nodeId: string, ok: boolean, message: string }>> {
    const recipe = getDcwRecipeRepo().byId(recipeId)
    if (!recipe)
      throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${recipeId}`)
    if (!recipe.lastGoodRunId)
      throw new AppError(409, ErrorCodes.CONFLICT, `配方「${recipe.name}」未标记已知良好批次(先 mark-good)`)
    const run = getDcwRecipeRepo().runById(recipe.lastGoodRunId)
    const snapshot = run?.paramsSnapshot
    if (!snapshot || snapshot.length === 0)
      throw new AppError(409, ErrorCodes.CONFLICT, '良好批次无参数快照(建批早于版本化),无法基准恢复')
    const outcomes: Array<{ nodeId: string, ok: boolean, message: string }> = []
    for (const p of snapshot) {
      try {
        await this.writeViaController(p.nodeId, p.value, { source: 'rollback', actor, hypothesis: `基准恢复 ${recipe.name}(良好批次 ${recipe.lastGoodRunId})` })
        outcomes.push({ nodeId: p.nodeId, ok: true, message: `已恢复 ${p.value}` })
      }
      catch (err) {
        outcomes.push({ nodeId: p.nodeId, ok: false, message: err instanceof Error ? err.message : String(err) })
      }
    }
    return outcomes
  }

  /** 判定回退的执行入口:关闭原记录(rolled-back)+ 反向下发产生新回退记录。
   *  状态语义:'rolled-back' 只在回读校验通过后落定;下发期间先置 'judged'(防 afterWrite 误 supersede),
   *  下发失败则如实停在 'judged' 并把失败原因写进 judge.reason。 */
  protected async executeRollbackWrite(
    record: Pick<OptimizationRecord, 'id' | 'nodeId' | 'nodeName' | 'lineId' | 'params'>,
    target: number,
    actor: string,
    approvalId?: string,
    toAnchorId?: string,
    by: 'agent' | 'user' | 'system' = 'system',
    actorName?: string,
  ): Promise<OptimizationRecord> {
    // 先关原记录(防回退写自身的 afterWrite 把它当 open supersede)
    const orig = this.repo.byId(record.id)
    const wasOpen = orig?.status === 'open'
    if (orig && wasOpen) {
      orig.judge ??= { by: 'system', actor, verdict: 'rollback', reason: '执行回退', at: new Date().toISOString() }
      this.closeRecord(orig, 'judged')
      orig.status = 'judged'
      this.repo.updateRecord(orig.id, { status: 'judged', judge: orig.judge, closedAt: orig.closedAt, closedBy: orig.closedBy, windowAgg: orig.windowAgg })
    }
    try {
      await this.writeViaController(record.nodeId, target, {
        source: 'rollback',
        actor,
        hypothesis: `回退 ${record.id}:恢复 ${target}`,
        rollbackOf: record.id.startsWith('node:') ? undefined : record.id,
      }, approvalId, toAnchorId)
    }
    catch (err) {
      if (orig && wasOpen) {
        const reason = err instanceof Error ? err.message : String(err)
        orig.judge = { ...orig.judge!, reason: `${orig.judge!.reason};回退下发失败:${reason}`, at: orig.judge!.at }
        this.repo.updateRecord(orig.id, { judge: orig.judge })
      }
      throw err
    }
    if (orig && wasOpen) {
      orig.status = 'rolled-back'
      this.repo.updateRecord(orig.id, { status: 'rolled-back' })
      this.emit('rolled-back', orig)
      recordOps({
        actor,
        actorName: actorName ?? actor,
        actorKind: by === 'agent' ? 'agent' : by === 'user' ? 'user' : 'system',
        action: 'optimization.rollback',
        kind: 'rollback',
        targetKind: 'optimization',
        targetId: record.id,
        summary: `回退完成:「${record.nodeName ?? record.nodeId}」已恢复 ${target}${record.id.startsWith('node:') ? '' : `(记录 ${record.id})`}`,
        lineId: record.lineId ?? '',
        recipeId: (record as { recipeId?: string }).recipeId ?? '',
        detail: { recordId: record.id, target },
      })
    }
    const fresh = this.repo.listRecords({ nodeId: record.nodeId, limit: 1 })[0]
    return fresh!
  }

  protected async writeViaController(nodeId: string, eng: number, meta: DcwWriteMeta & { rollbackOf?: string }, approvalId?: string, toAnchorId?: string): Promise<void> {
    const { getDcwController } = await import('../dcw-controller')
    const outcome = await getDcwController().write(nodeId, eng, null, meta)
    if (outcome.ok === false)
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `回退下发未通过回读校验: ${outcome.message}`)
    if (toAnchorId || approvalId) {
      const anchor = toAnchorId ? this.repo.anchorById(toAnchorId) : undefined
      if (anchor && approvalId)
        anchor.approvalId = approvalId
      this.repo.flushNow()
    }
  }

  /** Agent 回退护栏:冷却(用户/系统兜底不受链限) */
  protected checkRollbackAllowed(nodeId: string): void {
    const rb = this.repo.lastRollbackAnchor(nodeId)
    if (rb) {
      const elapsed = Date.now() - Date.parse(rb.at)
      if (elapsed < COOLDOWN_MS())
        throw new AppError(409, ErrorCodes.CONFLICT, `回退冷却中:节点 ${Math.ceil((COOLDOWN_MS() - elapsed) / 1000)}s 内禁止再次回退`)
    }
  }

  // ================================================================
  // 系统兜底评估(挂 sweep() 节拍;F1)
  // ================================================================
}

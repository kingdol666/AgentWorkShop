/**
 * RecipeRollBackManagerLayer01 —— 写路径挂锁(open 记录 / 互斥 / 冷却方向性)
 * (分层 2/7,承 RecipeRollBackManagerLayer00;方法体与原文件逐行一致)
 */
import { RecipeRollBackManagerLayer00 } from './00-state'
import type { DcwWriteMeta } from '../../../../../shared/dcw-protocol'
import { ANCHOR_DEDUP_MS, BASELINE_MS, COOLDOWN_MS } from './helpers'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { getActiveLineRun } from '../line-run'
import { recordOps } from '../../ops/ops'

export abstract class RecipeRollBackManagerLayer01 extends RecipeRollBackManagerLayer00 {
  /** 写前护栏:Agent 互斥(open 记录他人持有)+ 回退冷却方向性检查。manual/recipe 不受限。
   *  孤儿治理:被阻塞的 open 记录若已超时未判定(属主 Agent 已消失/挂起),自动关闭后放行。 */
  beforeWrite(node: { id: string, name: string }, eng: number, meta?: DcwWriteMeta): void {
    if (!meta || meta.source !== 'agent')
      return
    const open = this.repo.openRecordOf(node.id)
    if (open && open.agentId && open.agentId !== meta.actor) {
      if (this.isStale(open)) {
        this.closeRecord(open, 'superseded')
        open.judge = { by: 'system', actor: 'system', verdict: 'uncertain', reason: `孤儿记录接管:${meta.actor} 于超时后顶替(原属主 ${open.agentId} 未判定)`, at: new Date().toISOString() }
        this.repo.updateRecord(open.id, { judge: open.judge })
        this.emit('closed', open)
      }
      else {
        throw new AppError(409, ErrorCodes.CONFLICT, `节点「${node.name}」正在优化试验中(${open.id},由 ${open.agentId} 发起):请先 dcw_judge 判定该记录或等待其关闭`)
      }
    }
    const rb = this.repo.lastRollbackAnchor(node.id)
    if (rb && rb.prevValue != null) {
      const elapsed = Date.now() - Date.parse(rb.at)
      if (elapsed < COOLDOWN_MS()) {
        const restored = rb.newValue
        const wrong = rb.prevValue
        // 同向判定:偏离恢复值的方向与原错误方向一致(往回改不受限)
        if (eng !== restored && Math.sign(eng - restored) === Math.sign(wrong - restored)) {
          throw new AppError(409, ErrorCodes.CONFLICT, `回退冷却中:节点「${node.name}」${Math.ceil((COOLDOWN_MS() - elapsed) / 1000)}s 内禁止同向重写(刚从 ${wrong} 回退到 ${restored});如确需调整请先 dcw_judge 复盘或反向操作`)
        }
      }
    }
  }

  /**
   * 写后入册(同步部分:锚 + 开/关记录;窗口聚合异步回填 F2)。
   * 返回 anchorId/recordId 供工具回包;内部异常不外抛(记账失败不影响写结果)。
   */
  afterWrite(
    // unit 参与入册摘要(下方 `node.unit ?? ''`);调用方传的是 DcwNode 实例(unit: string),
    // 原先这里漏声明该字段,导致实现读到了参数类型之外的属性
    node: { id: string, name: string, lineId: string, templateRef: string, unit?: string | null },
    eng: number,
    prevValue: number | null,
    meta: DcwWriteMeta & { rollbackOf?: string },
    recipeRunId: string | null,
  ): { anchorId: string, recordId?: string } | null {
    try {
      // 5s 去重(保写心跳重下发防噪)
      const last = this.repo.lastAnchorOf(node.id)
      if (last && last.newValue === eng && Date.now() - Date.parse(last.at) < ANCHOR_DEDUP_MS)
        return null
      // 关闭同节点既有 open 记录(任何来源的后续写都会关闭;F4/F8)
      const open = this.repo.openRecordOf(node.id)
      if (open)
        this.closeRecord(open, meta.source === 'manual' ? 'superseded-manual' : 'superseded')
      // 首写之外,值未变化不记锚
      if (prevValue != null && prevValue === eng)
        return null
      const anchor = this.repo.appendAnchor({
        lineId: node.lineId,
        nodeId: node.id,
        prevValue,
        newValue: eng,
        source: meta.source,
        actor: meta.actor,
        recipeRunId,
        taskId: meta.taskId,
      })
      let recordId: string | undefined
      if (meta.source === 'agent' || meta.source === 'rollback') {
        const run = node.lineId ? getActiveLineRun(node.lineId) : null
        const record = this.repo.insertRecord({
          lineId: node.lineId,
          nodeId: node.id,
          nodeName: node.name,
          recipeId: run?.recipeId ?? null,
          agentId: meta.source === 'agent' ? meta.actor : undefined,
          taskId: meta.taskId,
          hypothesis: meta.hypothesis ?? '',
          params: [{ nodeId: node.id, templateRef: node.templateRef, from: prevValue, to: eng }],
          setAt: anchor.at,
          status: 'open',
          judge: null,
          anchorId: anchor.id,
          rollbackOf: meta.rollbackOf,
          policy: this.resolvePolicy(node.id, meta.actor),
        })
        anchor.recordId = record.id
        this.repo.flushNow()
        void this.fillMetrics(record, 'baseline', Date.parse(record.setAt) - BASELINE_MS(), Date.parse(record.setAt))
        this.emit('opened', record)
        recordOps({
          actor: meta.actor,
          actorName: meta.actorName ?? meta.actor,
          actorKind: meta.source === 'agent' ? 'agent' : 'system',
          action: 'optimization.open',
          kind: 'rollback',
          targetKind: 'optimization',
          targetId: record.id,
          summary: meta.source === 'agent'
            ? `Agent 开优化记录:「${node.name}」→ ${eng}${node.unit ?? ''}${meta.hypothesis ? `(假设:${meta.hypothesis})` : ''}`
            : `回退下发恢复「${node.name}」→ ${eng}${node.unit ?? ''}`,
          lineId: node.lineId ?? '',
          productId: run?.productId ?? '',
          recipeId: run?.recipeId ?? '',
          detail: { recordId: record.id, eng, prevValue, hypothesis: meta.hypothesis ?? '' },
        })
        recordId = record.id
      }
      return { anchorId: anchor.id, recordId }
    }
    catch (err) {
      console.error('[recipe-rollback] afterWrite 记账失败:', err)
      return null
    }
  }

  /** 停线封窗:关闭该产线全部 open 记录(lineStop 调用;防跨批次污染) */
  closeForLine(lineId: string): void {
    for (const r of this.repo.listRecords({ lineId, status: 'open', limit: 500 }))
      this.closeRecord(r, 'line-stop')
  }

  // ================================================================
  // 判定(Agent / 系统 / 用户 三路;judge 只对 open 记录)
  // ================================================================
}

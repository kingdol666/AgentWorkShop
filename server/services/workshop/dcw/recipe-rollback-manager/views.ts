/**
 * RecipeRollBackManagerViews —— 数据面:窗口聚合 / 台账 / 序列
 * (拆分层,承 RecipeRollBackManagerSweep;方法体与原文件逐行一致)
 */
import { RecipeRollBackManagerSweep } from './sweep'
import type { DcwJournalAnchor, OptimizationChannelMetrics, OptimizationMetrics, OptimizationRecord, OptimizationVerdict } from '../../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { clampMs } from './helpers'
import { getActiveLineRun } from '../line-run'
import { getDaqNodeRepo } from '../../daq/daq-node.repo'
import { getDcwNodeRepo } from '../dcw-node.repo'
import { getDcwRecipeRepo } from '../dcw-recipe.repo'

export abstract class RecipeRollBackManagerViews extends RecipeRollBackManagerSweep {
  /** 通道选择:同设备绑定优先,无则同产线(AC1.6 口径) */
  protected selectDaqChannels(dcwNodeId: string, lineId: string) {
    const all = getDaqNodeRepo().all()
    const node = getDcwNodeRepo().byId(dcwNodeId)
    if (node?.deviceBindingId) {
      const sameDev = all.filter(d => d.deviceBindingId === node.deviceBindingId)
      if (sameDev.length > 0)
        return sameDev
    }
    if (lineId)
      return all.filter(d => d.lineId === lineId)
    return []
  }

  /** 经 lineQuery(queryTagged)拉窗口内逐通道序列;聚合 + 越窗计数在本方法内纯计算 */
  protected async captureMetrics(nodeId: string, lineId: string, recipeId: string | null | undefined, fromMs: number, toMs: number): Promise<OptimizationMetrics> {
    const daqNodes = this.selectDaqChannels(nodeId, lineId)
    const channels: OptimizationChannelMetrics[] = daqNodes.map(d => ({
      daqNodeId: d.id,
      ch: d.templateKey ?? d.id,
      unit: d.unit ?? '',
      latest: null,
      avg: null,
      min: null,
      max: null,
      cnt: 0,
      breaches: -1,
    }))
    if (daqNodes.length === 0)
      return { at: new Date().toISOString(), fromMs, toMs, channels, degraded: true }
    const { getDcwController } = await import('../dcw-controller')
    const span = toMs - fromMs
    const bucketMs = clampMs(span > 60_000 ? Math.max(1000, Math.round(span / 200)) : undefined)
    const result = await getDcwController().lineQuery({
      lineId: lineId || undefined,
      nodeId: daqNodes.map(d => d.id).join(','),
      fromMs,
      toMs,
      bucketMs,
      limit: 800,
    })
    const byId = new Map(result.channels.map(c => [c.nodeId, c]))
    const recipe = recipeId ? getDcwRecipeRepo().byId(recipeId) : undefined
    for (const ch of channels) {
      const series = byId.get(ch.daqNodeId)
      if (!series || series.points.length === 0)
        continue
      const values: number[] = []
      for (const p of series.points) {
        const v = p.value ?? p.avg
        if (v == null || !Number.isFinite(v))
          continue
        values.push(v)
      }
      const win = recipe?.daqWindows?.find(w => w.nodeId === ch.daqNodeId)
      // 「有窗口且设了边界」才计越界:原实现用 breaches=-1 + 循环首拍 break 短路,
      // 等价于整段跳过(循环体在 -1 时没有任何副作用)。把这条不变量显式上移,
      // win 在循环内即可被收窄(不再需要断言/非空断言)。
      const windowed = win != null && (win.min != null || win.max != null)
      let breaches = windowed ? 0 : -1
      if (win && windowed) {
        for (const v of values) {
          if ((win.min != null && v < win.min) || (win.max != null && v > win.max))
            breaches++
        }
      }
      ch.latest = values.length ? values[values.length - 1]! : null
      ch.avg = values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : null
      ch.min = values.length ? Number(Math.min(...values).toFixed(2)) : null
      ch.max = values.length ? Number(Math.max(...values).toFixed(2)) : null
      ch.cnt = values.length
      ch.breaches = breaches
    }
    return { at: new Date().toISOString(), fromMs, toMs, channels }
  }

  /** 关闭记录(同步)+ 异步补窗口聚合(F2) */
  protected closeRecord(record: OptimizationRecord, closedBy: NonNullable<OptimizationRecord['closedBy']>, judge?: OptimizationRecord['judge']): void {
    if (record.status !== 'open')
      return
    record.closedAt = new Date().toISOString()
    record.closedBy = closedBy
    if (judge)
      record.judge = judge
    record.status = closedBy === 'superseded-manual'
      ? 'superseded-manual'
      : closedBy === 'superseded'
        ? 'superseded'
        : closedBy === 'line-stop' ? 'closed-line-stop' : record.status
    record.aggPending = true
    this.repo.updateRecord(record.id, { closedAt: record.closedAt, closedBy: record.closedBy, status: record.status, judge: record.judge, aggPending: true })
    void this.fillMetrics(record, 'windowAgg', Date.parse(record.setAt), Date.parse(record.closedAt))
  }

  /** 异步聚合回填(baseline / windowAgg 共用;防重入) */
  protected async fillMetrics(record: OptimizationRecord, slot: 'baseline' | 'windowAgg', fromMs: number, toMs: number): Promise<void> {
    const key = `${record.id}:${slot}`
    if (this.capturing.has(key))
      return
    this.capturing.add(key)
    try {
      const agg = await this.captureMetrics(record.nodeId, record.lineId, record.recipeId, fromMs, toMs)
      const patch: Partial<OptimizationRecord> = { [slot]: agg }
      if (slot === 'windowAgg')
        patch.aggPending = false
      this.repo.updateRecord(record.id, patch)
      this.emit('closed', record)
    }
    catch (err) {
      console.error('[recipe-rollback] 聚合回填失败:', key, err)
      if (slot === 'windowAgg') {
        this.repo.updateRecord(record.id, {
          windowAgg: { at: new Date().toISOString(), fromMs, toMs, channels: [], degraded: true },
          aggPending: false,
        })
      }
    }
    finally {
      this.capturing.delete(key)
    }
  }

  /** 记录窗口序列(数采中心查看;经 lineQuery 参数化查询) */
  async series(recordId: string, windowMs?: number) {
    const record = this.repo.byId(recordId)
    if (!record)
      throw new AppError(404, ErrorCodes.NOT_FOUND, `优化记录不存在: ${recordId}`)
    const from = Date.parse(record.setAt)
    let to = record.closedAt ? Date.parse(record.closedAt) : Date.now()
    const win = clampMs(windowMs)
    if (win && to - from > win)
      to = from + win
    const daqNodes = this.selectDaqChannels(record.nodeId, record.lineId)
    const span = to - from
    const bucketMs = clampMs(span > 60_000 ? Math.max(1000, Math.round(span / 200)) : undefined)
    const { getDcwController } = await import('../dcw-controller')
    const result = await getDcwController().lineQuery({
      lineId: record.lineId || undefined,
      nodeId: daqNodes.map(d => d.id).join(','),
      fromMs: from,
      toMs: to,
      bucketMs,
      limit: 500,
    })
    return { record, from, to, channels: result.channels }
  }

  /** 节点参数台账(三值对照 + 在册历史;AC1.6) */
  ledger(nodeId: string) {
    const node = getDcwNodeRepo().byId(nodeId)
    if (!node)
      throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${nodeId}`)
    const run = node.lineId ? getActiveLineRun(node.lineId) : null
    const recipe = run ? getDcwRecipeRepo().byId(run.recipeId) : undefined
    const recipeTarget = recipe?.params.find(p => p.nodeId === nodeId)?.value ?? null
    let lastGood: number | null = null
    const goodRunId = recipe?.lastGoodRunId ?? null
    if (goodRunId) {
      const goodRun = getDcwRecipeRepo().runById(goodRunId)
      lastGood = goodRun?.paramsSnapshot?.find(p => p.nodeId === nodeId)?.value ?? null
    }
    return {
      nodeId,
      nodeName: node.name,
      current: typeof node.value === 'number' ? node.value : null,
      recipeTarget,
      lastGood,
      journal: this.repo.listAnchors({ nodeId, limit: 30 }),
      records: this.repo.listRecords({ nodeId, limit: 20 }),
    }
  }

  /** 在册历史查询 */
  journal(filter: { nodeId?: string, lineId?: string, source?: string, limit?: number }): DcwJournalAnchor[] {
    return this.repo.listAnchors(filter)
  }

  records(filter: { lineId?: string, recipeId?: string, nodeId?: string, status?: string, agentId?: string, limit?: number }): OptimizationRecord[] {
    return this.repo.listRecords(filter)
  }

  recordById(id: string): OptimizationRecord | undefined {
    return this.repo.byId(id)
  }

  /** 节点洞察(my_industrial_nodes 语义卡增量:open 记录 / lastGood / 最近判定) */
  nodeInsight(nodeId: string): { openRecord: OptimizationRecord | null, lastGood: number | null, recentJudges: Array<{ at: string, verdict: OptimizationVerdict, by: string, reason: string }> } {
    const led = this.ledger(nodeId)
    const openRecord = led.records.find(r => r.status === 'open') ?? null
    const recentJudges = led.records
      .filter(r => r.judge)
      .slice(0, 3)
      .map(r => ({ at: r.judge!.at, verdict: r.judge!.verdict, by: r.judge!.by, reason: r.judge!.reason }))
    return { openRecord, lastGood: led.lastGood, recentJudges }
  }

  // ================================================================
  // 内部
  // ================================================================
}

/**
 * RecipeRollBackManager —— 调控闭环编排核心(参数账本 + Agent 优化记录 + 分级回退)。
 *
 * 职责边界:
 *  - 持久化一律走 RecipeRollBackRepo(本类不碰 JSON);
 *  - 回退一律经 DcwController.write() 单点(动态 import 防循环依赖),
 *    量程/配方窗口/联锁/暂停门控自动继承,回退本身同样入册;
 *  - 系统兜底判定挂 DcwController.sweep() 节拍(不建新定时器);
 *  - windowAgg 异步补齐(F2):关闭记录在写热路径上,聚合查询不得阻塞 PLC 下发;
 *  - 数采序列/聚合全部复用 DcwController.lineQuery(queryTagged 参数化接口,
 *    配方/产线打标隔离语义与全站一致),本类零直接 tsdb 触达。
 *
 * 判定与执行分离:dcw_judge 只落 judge 字段;真正改 PLC 必须显式 rollback
 * (系统 auto_rollback 的越限兜底除外)。
 */

import type {
  DcwJournalAnchor,
  DcwWriteMeta,
  OptimizationChannelMetrics,
  OptimizationMetrics,
  OptimizationRecord,
  OptimizationVerdict,
} from '../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { getAgentNodeBindingRepo } from '../agents/node-bindings.repo'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { getDcwRecipeRepo } from './dcw-recipe.repo'
import { getDcwNodeRepo } from './dcw-node.repo'
import { getActiveLineRun } from './line-run'
import { getRecipeRollBackRepo, type RecipeRollBackRepo } from './recipe-rollback.repo'

/** 回退后同向重写冷却 */
const COOLDOWN_MS = Number(process.env.DCW_ROLLBACK_COOLDOWN_MS ?? 300_000)
/** 系统兜底评估的最小观察窗 */
const MIN_WINDOW_MS = Number(process.env.DCW_ROLLBACK_MIN_WINDOW_MS ?? 120_000)
/** 兜底评估复查间隔(未触发时) */
const RECHECK_MS = 30_000
/** 每节点链自动回退上限(超出升级人工) */
const MAX_AUTO_ROLLBACKS = 2
/** 越限采样数阈值(窗口内) */
const BREACH_THRESHOLD = 3
/** 锚去重窗口(保写心跳防噪) */
const ANCHOR_DEDUP_MS = 5_000
/** 基线回看窗 */
const BASELINE_MS = Number(process.env.DCW_ROLLBACK_BASELINE_MS ?? 600_000)
/** open 记录孤儿判定:属主超时未判定 → 后续 Agent 可接管(判定/回退/顶替) */
const OPEN_RECORD_STALE_MS = Number(process.env.DCW_ROLLBACK_STALE_MS ?? 1_800_000)

/** 数值入参钳制(时间/桶宽:有限正整数,防越界透传) */
function clampMs(v: number | undefined): number | undefined {
  if (v == null)
    return undefined
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n <= 0)
    return undefined
  return Math.min(n, 2_147_483_647)
}

export class RecipeRollBackManager {
  private repo: RecipeRollBackRepo = getRecipeRollBackRepo()
  private broadcast: ((type: string, payload: unknown) => void) | null = null
  private capturing = new Set<string>()

  setBroadcast(fn: ((type: string, payload: unknown) => void) | null): void {
    this.broadcast = fn
  }

  // ================================================================
  // 写路径挂钩(DcwController.write 调用)
  // ================================================================

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
      if (elapsed < COOLDOWN_MS) {
        const restored = rb.newValue
        const wrong = rb.prevValue
        // 同向判定:偏离恢复值的方向与原错误方向一致(往回改不受限)
        if (eng !== restored && Math.sign(eng - restored) === Math.sign(wrong - restored)) {
          throw new AppError(409, ErrorCodes.CONFLICT, `回退冷却中:节点「${node.name}」${Math.ceil((COOLDOWN_MS - elapsed) / 1000)}s 内禁止同向重写(刚从 ${wrong} 回退到 ${restored});如确需调整请先 dcw_judge 复盘或反向操作`)
        }
      }
    }
  }

  /**
   * 写后入册(同步部分:锚 + 开/关记录;窗口聚合异步回填 F2)。
   * 返回 anchorId/recordId 供工具回包;内部异常不外抛(记账失败不影响写结果)。
   */
  afterWrite(
    node: { id: string, name: string, lineId: string, templateRef: string },
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
        void this.fillMetrics(record, 'baseline', Date.parse(record.setAt) - BASELINE_MS, Date.parse(record.setAt))
        this.emit('opened', record)
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

  /** 孤儿判定:open 记录超时未判定(属主可能已消失)→ 可被后续 Agent 接管 */
  isStale(record: OptimizationRecord): boolean {
    return record.status === 'open' && Date.now() - Date.parse(record.setAt) > OPEN_RECORD_STALE_MS
  }

  judge(recordId: string, verdict: OptimizationVerdict, reason: string, by: 'agent' | 'system' | 'user', actor: string, opts?: { takeover?: boolean }): OptimizationRecord {
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
    return record
  }

  // ================================================================
  // 分级回退(全部经 controller.write 单点;动态 import 防循环)
  // ================================================================

  /** 回退一条优化记录:目标 = 该记录的 from 值(设定前基线) */
  async rollbackRecord(recordId: string, actor: string, by: 'agent' | 'user' | 'system', approvalId?: string): Promise<OptimizationRecord> {
    const record = this.repo.byId(recordId)
    if (!record)
      throw new AppError(404, ErrorCodes.NOT_FOUND, `优化记录不存在: ${recordId}`)
    const from = record.params[0]?.from
    if (from == null)
      throw new AppError(409, ErrorCodes.CONFLICT, `记录 ${recordId} 无基线值(首写无 prevValue),无法回退`)
    if (by === 'agent')
      this.checkRollbackAllowed(record.nodeId)
    return this.executeRollbackWrite(record, from, actor, approvalId)
  }

  /** 节点级单步回退:目标 = 最近稳定锚的 prevValue(撤销栈栈顶) */
  async rollbackNode(nodeId: string, actor: string, by: 'agent' | 'user' | 'system', toAnchorId?: string): Promise<OptimizationRecord> {
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
  private async executeRollbackWrite(
    record: Pick<OptimizationRecord, 'id' | 'nodeId' | 'nodeName' | 'lineId' | 'params'>,
    target: number,
    actor: string,
    approvalId?: string,
    toAnchorId?: string,
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
    }
    const fresh = this.repo.listRecords({ nodeId: record.nodeId, limit: 1 })[0]
    return fresh!
  }

  private async writeViaController(nodeId: string, eng: number, meta: DcwWriteMeta & { rollbackOf?: string }, approvalId?: string, toAnchorId?: string): Promise<void> {
    const { getDcwController } = await import('./dcw-controller')
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
  private checkRollbackAllowed(nodeId: string): void {
    const rb = this.repo.lastRollbackAnchor(nodeId)
    if (rb) {
      const elapsed = Date.now() - Date.parse(rb.at)
      if (elapsed < COOLDOWN_MS)
        throw new AppError(409, ErrorCodes.CONFLICT, `回退冷却中:节点 ${Math.ceil((COOLDOWN_MS - elapsed) / 1000)}s 内禁止再次回退`)
    }
  }

  // ================================================================
  // 系统兜底评估(挂 sweep() 节拍;F1)
  // ================================================================

  evaluateOpenRecords(now: number): void {
    for (const record of this.repo.listRecords({ status: 'open', limit: 500 })) {
      if (record.policy === 'observe_only')
        continue
      const setMs = Date.parse(record.setAt)
      if (now - setMs < MIN_WINDOW_MS)
        continue
      if (record.evaluatedAt && now - Date.parse(record.evaluatedAt) < RECHECK_MS)
        continue
      record.evaluatedAt = new Date(now).toISOString()
      void this.evaluateOnce(record)
    }
  }

  private async evaluateOnce(record: OptimizationRecord): Promise<void> {
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

  /** 通道选择:同设备绑定优先,无则同产线(AC1.6 口径) */
  private selectDaqChannels(dcwNodeId: string, lineId: string) {
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
  private async captureMetrics(nodeId: string, lineId: string, recipeId: string | null | undefined, fromMs: number, toMs: number): Promise<OptimizationMetrics> {
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
    const { getDcwController } = await import('./dcw-controller')
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
      let breaches = win && (win.min != null || win.max != null) ? 0 : -1
      for (const v of values) {
        if (breaches === -1)
          break
        if ((win.min != null && v < win.min) || (win.max != null && v > win.max))
          breaches++
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
  private closeRecord(record: OptimizationRecord, closedBy: NonNullable<OptimizationRecord['closedBy']>, judge?: OptimizationRecord['judge']): void {
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
  private async fillMetrics(record: OptimizationRecord, slot: 'baseline' | 'windowAgg', fromMs: number, toMs: number): Promise<void> {
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
    const { getDcwController } = await import('./dcw-controller')
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

  private resolvePolicy(nodeId: string, actor: string): 'auto_rollback' | 'approve_rollback' | 'observe_only' {
    if (actor && actor !== 'system') {
      const binding = getAgentNodeBindingRepo().byAgent(actor).find(b => b.kind === 'dcw' && b.nodeId === nodeId)
      if (binding)
        return binding.mode === 'manual' ? 'approve_rollback' : 'auto_rollback'
    }
    const anyBinding = getAgentNodeBindingRepo().byNode(nodeId).find(b => b.kind === 'dcw')
    return anyBinding ? (anyBinding.mode === 'manual' ? 'approve_rollback' : 'auto_rollback') : 'observe_only'
  }

  private markGoodFromRecord(record: OptimizationRecord): void {
    if (!record.recipeId)
      return
    const run = getActiveLineRun(record.lineId)
    if (run && run.recipeId === record.recipeId)
      getDcwRecipeRepo().markGood(record.recipeId, run.runId)
  }

  private emit(event: 'opened' | 'judged' | 'closed' | 'rolled-back', record: OptimizationRecord): void {
    this.broadcast?.('dcw.optimization.changed', { event, record })
  }
}

const g = globalThis as typeof globalThis & { __recipeRollBackManager?: RecipeRollBackManager }

export function getRecipeRollBackManager(): RecipeRollBackManager {
  g.__recipeRollBackManager ??= new RecipeRollBackManager()
  return g.__recipeRollBackManager
}

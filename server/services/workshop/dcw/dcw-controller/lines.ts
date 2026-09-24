/**
 * DcwControllerLines —— 产线 / 运行 / 查询
 * (拆分层,承 DcwControllerRecipes;方法体与原文件逐行一致)
 */
import { DcwControllerRecipes } from './recipes'
import type { LineInput, LineQueryOpts, LineQueryResult, LineRunState, LineView } from '../../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { clearActiveLineRun, getActiveLineRun, getAllActiveLineRuns, setActiveLineRun } from '../line-run'
import { daqRuntimeSettings } from '../../settings'
import { getDcwLineRepo } from '../dcw-line.repo'
import { getDcwProductRepo } from '../dcw-product.repo'
import { getDcwRecipeRepo } from '../dcw-recipe.repo'
import { getRecipeRollBackManager } from '../recipe-rollback-manager'

export abstract class DcwControllerLines extends DcwControllerRecipes {
  listLines(): LineView[] {
    return getDcwLineRepo().all()
  }

  createLine(input: LineInput): LineView {
    return getDcwLineRepo().create(input)
  }

  updateLine(id: string, patch: Partial<LineInput>): LineView {
    return getDcwLineRepo().update(id, patch)
  }

  /** 删除产线:自动停止运行窗口。purge=true 连同旗下节点(含 Agent 绑定级联)/产品/配方一并删除;
   *  否则仅解除挂载(lineId='' 未分配),节点与历史数据保留 */
  async removeLine(id: string, opts?: { purge?: boolean }): Promise<void> {
    const line = getDcwLineRepo().byId(id)
    if (!line) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${id}`)
    if (getActiveLineRun(id)) this.lineStop(id)
    // 快照迭代:purge 分支的 this.remove 会边遍历边删节点
    for (const n of [...this.repo.all()]) {
      if (n.lineId !== id) continue
      if (opts?.purge) this.remove(n.id)
      else {
        n.lineId = ''
        this.emitNodeChanged('updated', n)
      }
    }
    if (opts?.purge) {
      this.repo.flushNow()
      const productRepo = getDcwProductRepo()
      for (const p of productRepo.all()) {
        if (p.lineId === id) productRepo.remove(p.id)
      }
      const recipeRepo = getDcwRecipeRepo()
      for (const r of recipeRepo.list()) {
        if (r.lineId === id) recipeRepo.remove(r.id)
      }
    }
    else {
      const productRepo = getDcwProductRepo()
      for (const p of productRepo.all()) {
        if (p.lineId === id) productRepo.update(p.id, { lineId: '' })
      }
      const recipeRepo = getDcwRecipeRepo()
      for (const r of recipeRepo.list()) {
        if (r.lineId === id) recipeRepo.detachLine(r.id)
      }
    }
    getDcwLineRepo().remove(id)
    this.broadcast?.('dcw.controller', this.controllerState())
  }

  // ---------- 产线运营(逐产线开跑;开跑必设配方;窗口内数采逐样本打标) ----------

  /**
   * 产线开跑:选定产品+配方 → 下发配方参数 → 创建批次并激活**该产线**窗口。
   * 门控:配方必归属本产线的产品且含工艺参数 —— 未设定配方不可开跑数据采集。
   */
  async lineStart(lineId: string, recipeId: string) {
    this.ensureLoop()
    if (!this.running) {
      throw new AppError(409, ErrorCodes.CONFLICT, '控制网关已暂停(暂停全部控制):开跑需下发配方参数,请先「恢复全部控制」')
    }
    const line = getDcwLineRepo().byId(lineId)
    if (!line) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${lineId}`)
    if (getActiveLineRun(lineId)) {
      throw new AppError(409, ErrorCodes.CONFLICT, `产线「${line.name}」已在运行(批次 ${getActiveLineRun(lineId)!.runId}),请先停止当前数据采集`)
    }
    const repo = getDcwRecipeRepo()
    const recipe = repo.byId(recipeId)
    if (!recipe) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${recipeId}`)
    if (recipe.lineId !== lineId) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `配方「${recipe.name}」不属于产线「${line.name}」,请先将其产品挂载到本产线`)
    }
    if (recipe.params.length === 0) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '开跑前必须先设定配方:当前 Recipe 无工艺参数')
    }
    const product = getDcwProductRepo().byId(recipe.productId)
    if (!product) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '开跑前必须先设定配方:Recipe 未归属有效产品,请先补全产品信息')
    }
    const run = repo.createRun(recipe)
    setActiveLineRun({
      lineId,
      runId: run.id,
      recipeId: recipe.id,
      recipeName: recipe.name,
      productId: product.id,
      productName: product.name,
      startedAt: run.startedAt,
      taggedSamples: 0,
    })
    await this.writeRecipeParams(recipe, run)
    this.broadcast?.('dcw.controller', this.controllerState())
    return run
  }

  /** 产线停止:关闭该产线批次窗口(此后样本不再打标;数据保留可查)+ 该产线数采停摆 */
  lineStop(lineId: string) {
    const line = getDcwLineRepo().byId(lineId)
    if (!line) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${lineId}`)
    const prev = clearActiveLineRun(lineId)
    if (!prev) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `产线「${line.name}」未在运行`)
    const run = getDcwRecipeRepo().closeRun(prev.runId)
    // 调控闭环封窗:该线 open 优化记录随批次窗口关闭(防跨批次污染)
    getRecipeRollBackManager().closeForLine(lineId)
    this.broadcast?.('dcw.controller', this.controllerState())
    // 数采门控联动:该产线无活动配方即停止其节点采集,置 offline 并广播收敛
    void import('../../daq/daq-controller').then(({ getDaqController }) => {
      getDaqController().markLineOffline(lineId)
    }).catch(() => {})
    return run
  }

  /** 单条产线运行状态(活动窗口 + 打标计数) */
  lineState(lineId: string): LineRunState {
    const base: LineRunState = { lineId, active: false, runId: null, recipeId: null, recipeName: null, productId: null, productName: null, startedAt: null, taggedSamples: 0 }
    const r = getActiveLineRun(lineId)
    if (!r) return base
    return {
      ...base,
      active: true,
      runId: r.runId,
      recipeId: r.recipeId,
      recipeName: r.recipeName,
      productId: r.productId,
      productName: r.productName,
      startedAt: r.startedAt,
      taggedSamples: r.taggedSamples,
    }
  }

  /** 全部产线运行状态(产线总览/状态条聚合) */
  allLineStates(): LineRunState[] {
    const lines = getDcwLineRepo().all()
    const seen = new Set(lines.map(l => l.id))
    const states = lines.map(l => this.lineState(l.id))
    // 已删除产线的残留窗口兜底展示(避免批次计数幽灵丢失)
    for (const r of getAllActiveLineRuns()) {
      if (!seen.has(r.lineId)) states.push(this.lineState(r.lineId))
    }
    return states
  }

  /** 是否存在任意活动产线窗口(数采全局快速门) */
  hasAnyActiveLineRun(): boolean {
    return getAllActiveLineRuns().length > 0
  }

  /**
   * 产线数据查询(产品/配方/工艺参数/时间/间隔 五维):
   * 打标样本跨通道聚合;paramKey 限定工艺参数(DAQ 模板),bucketMs 降采样。
   */
  async lineQuery(opts: LineQueryOpts): Promise<LineQueryResult> {
    const { getTsdb, tsdbReady } = await import('../../daq/storage')
    await tsdbReady
    const { getDaqNodeRepo } = await import('../../daq/daq-node.repo')
    const { findDaqTemplate } = await import('../../daq/daq-templates')
    // 时间间隔参数(bucketMs):缺省与下限来自 daq.query.*(live 配置,热重载)
    const { defaultBucketMs, minBucketMs } = daqRuntimeSettings().query
    const bucketMs = opts.bucketMs == null ? defaultBucketMs : Math.max(minBucketMs, Math.min(3_600_000, Math.round(opts.bucketMs)))
    const nodeFilter = opts.nodeId ? opts.nodeId.split(',').map(x => x.trim()).filter(Boolean) : []
    const nodes = getDaqNodeRepo().all().filter((n) => {
      if (opts.paramKey && n.templateKey !== opts.paramKey) return false
      if (opts.lineId && (n.lineId ?? '') !== opts.lineId) return false
      // 节点维过滤(多节点绑定同模板时精确定位;支持多节点逗号分隔)
      if (nodeFilter.length > 0 && !nodeFilter.includes(n.id)) return false
      return true
    })
    const series = await getTsdb().queryTagged({
      productId: opts.productId,
      recipeId: opts.recipeId,
      lineId: opts.lineId,
      nodeIds: nodes.map(n => n.id),
      fromMs: opts.fromMs,
      toMs: opts.toMs,
      bucketMs,
      limit: opts.limit,
    })
    const channels: LineQueryResult['channels'] = []
    for (const n of nodes) {
      const points = series.get(n.id)
      if (!points || points.length === 0) continue
      const tpl = findDaqTemplate(n.templateKey)
      channels.push({
        nodeId: n.id,
        nodeName: n.name,
        templateRef: n.templateRef,
        ch: tpl?.ch ?? n.templateKey,
        unit: n.unit,
        points,
      })
    }
    return { productId: opts.productId ?? null, recipeId: opts.recipeId ?? null, channels }
  }

  // ---------- 产品 ----------
}

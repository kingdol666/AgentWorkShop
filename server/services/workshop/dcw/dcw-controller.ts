/**
 * DcwController —— 数据写控制网关(应用级单例,与 DaqController 对称)。
 *
 * 每个写控制节点一个独立 DcwNodeRuntime(边缘控制运行时),网关统一调度:
 *   - 手动写命令(REST/前端设定)→ 工程量校验 → 驱动写(换算/回读校验在驱动)
 *     → ACK 记账(节点状态/写历史/WS dcw.written 直推)
 *   - 保写心跳(runtime 元数据 holdIntervalMs,PLC 设定恢复语义)
 *   - Recipe 应用:批次(Run)隔离 + 逐参数写 + 结果快照
 * 用户语义 = 工程量;PLC 底层全部由系统封装。
 */

import { randomUUID } from 'node:crypto'
import { applyTransform, inverseTransform, normalizeDataTransform, dcwKeyFromRef } from '../../../../shared/dcw-protocol'
import type { AepDcwNodeChange, DcwDriverKind, DcwNodeView, DataTransform, LineInput, LineQueryOpts, LineQueryResult, LineRunState, LineView, ProductInput, ProductView, RecipeInput, RecipeRunView, RecipeView } from '../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { normalizeDcwDriverKind, resolveDcwDriver } from './drivers'
import { findDcwTemplate } from './dcw-templates'
import { getDeviceTwinRepo } from '../assets/device-twin.repo'
import { DcwNode } from './dcw-node'
import { getDcwNodeRepo } from './dcw-node.repo'
import { DcwNodeRuntime } from './dcw-runtime'
import { getDcwRecipeRepo, type DcwWriteHistoryEntry } from './dcw-recipe.repo'
import { getDcwProductRepo } from './dcw-product.repo'
import { getDcwLineRepo } from './dcw-line.repo'
import { clearActiveLineRun, getActiveLineRun, getAllActiveLineRuns, setActiveLineRun } from './line-run'

type BroadcastFn = (type: string, payload: unknown) => void

export interface DcwCreateInput {
  templateRef?: string
  name?: string
  driver?: DcwDriverKind
  driverConfig?: Record<string, string | number | boolean>
  /** 数据语义标定钩子(encode:物理值 → PLC 设定值) */
  transform?: DataTransform
  holdIntervalMs?: number | null
  unit?: string
  decimals?: number
  min?: number
  max?: number
  enabled?: boolean
  posX?: number
  posZ?: number
  deviceBindingId?: string | null
  /** 所属产线('' = 未分配) */
  lineId?: string
  /** 节点级工艺语义备注(覆盖模板) */
  semantics?: string
}

export interface DcwPatchInput {
  name?: string
  driver?: DcwDriverKind
  driverConfig?: Record<string, string | number | boolean>
  /** 数据语义标定钩子(encode) */
  transform?: DataTransform
  holdIntervalMs?: number | null
  unit?: string
  decimals?: number
  min?: number
  max?: number
  enabled?: boolean
  posX?: number
  posZ?: number
  lineId?: string
  semantics?: string
}

/** 网关扫描周期(ms;保写心跳分辨率) */
const SWEEP_MS = 500

class DcwController {
  private repo = getDcwNodeRepo()
  private broadcast: BroadcastFn | null = null
  private timer: NodeJS.Timeout | null = null
  /** 边缘控制运行时注册表(节点 id → 独立运行时) */
  private runtimes = new Map<string, DcwNodeRuntime>()

  running = true
  private writesTotal = 0
  private writesFailed = 0

  // ---------- 生命周期 ----------

  private ensureLoop(): void {
    this.syncRuntimes()
    if (this.timer) return
    this.timer = setInterval(() => this.sweep(), SWEEP_MS)
    this.timer.unref?.()
  }

  /** 网关统一调度:保写心跳在各运行时内部自治(单节点写事务不波及邻居) */
  private sweep(): void {
    if (!this.running) return
    const now = Date.now()
    for (const rt of this.runtimes.values()) rt.tick(now)
  }

  private syncRuntimes(): void {
    const live = new Set<string>()
    for (const node of this.repo.all()) {
      live.add(node.id)
      if (!this.runtimes.has(node.id)) {
        this.runtimes.set(node.id, new DcwNodeRuntime(node, this.host))
      }
    }
    for (const id of [...this.runtimes.keys()]) {
      if (!live.has(id)) this.runtimes.delete(id)
    }
  }

  // ---------- 网关服务面(runtime host)----------

  private host = {
    running: () => this.running,
    defaults: () => ({ holdIntervalMs: 0 }),
    executeWrite: async (node: DcwNode, eng: number, tolerance: number, recipeRunId: string | null) =>
      this.executeWrite(node, eng, tolerance, recipeRunId),
  }

  /**
   * 核心写执行:驱动写(工程量→原始值换算 + 回读校验在驱动内)
   * → ACK 记账(节点状态/写历史)→ WS 直推。真实/模拟驱动同一路径。
   */
  private async executeWrite(node: DcwNode, eng: number, tolerance: number, recipeRunId: string | null): Promise<{ ok: boolean, message: string, raw: number | null, readback: number | null }> {
    const at = new Date().toISOString()
    // 数据语义标定钩子(encode):物理值 → PLC 设定值。
    // 回读值再经 decoder 换算回物理量做死区校验(容差按标定比例同步缩放)。
    const t = node.transform
    const plcValue = inverseTransform(eng, t)
    const plcTolerance = Math.max(tolerance, 1e-9) / (t?.kind === 'linear' && Math.abs(t.scale ?? 1) > 0 ? Math.abs(t.scale!) : 1)
    let outcome: { ok: boolean, message: string, raw: number | null, readback: number | null }
    try {
      outcome = await resolveDcwDriver(node.driver).write({
        eng: plcValue,
        tolerance: plcTolerance,
        domain: { min: node.min, max: node.max },
        driverConfig: node.driverConfig,
      })
      // 回读换算回物理量(message 保留 PLC 域数值供排查)
      if (outcome.readback != null) outcome.readback = applyTransform(outcome.readback, t)
      if (outcome.ok) outcome.message = `${outcome.message}(标定后物理值 ${Number((outcome.readback ?? eng).toFixed(node.decimals))})`
    }
    catch (err) {
      outcome = { ok: false, message: err instanceof Error ? err.message : String(err), raw: null, readback: null }
    }
    this.writesTotal++
    if (!outcome.ok) this.writesFailed++
    // set 后 hook:节点暴露值 = PLC 回读经 decoder 解码的**真实物理值**(而非指令值);
    // 回读缺失(驱动不支持)才回退指令值。节点对外呈现的始终是处理后的工艺参数。
    node.applyWriteResult(outcome.readback ?? eng, outcome.ok, outcome.message, at)
    // 写值走防抖落盘:保写心跳按 holdIntervalMs 周期触发本方法,同步全量重写
    // dcws.json 会随节点数放大成周期性 fs 抖动;防抖窗内崩溃丢失的设定值可从 PLC 回读恢复
    this.repo.flushDebounced()
    const repo = getDcwRecipeRepo()
    const entry: DcwWriteHistoryEntry = {
      id: `wh-${randomUUID().slice(0, 8)}`,
      nodeId: node.id,
      nodeName: node.name,
      param: findDcwTemplate(node.templateKey)?.ch ?? node.templateKey,
      eng: node.value ?? eng,
      raw: outcome.raw,
      ok: outcome.ok,
      message: outcome.message,
      recipeRunId,
      at,
    }
    repo.appendHistory(entry)
    this.broadcast?.('dcw.written', {
      nodeId: node.id,
      templateRef: node.templateRef,
      value: node.value ?? eng,
      raw: outcome.raw,
      ok: outcome.ok,
      message: outcome.message,
      recipeRunId,
      at,
    })
    this.emitNodeChanged('updated', node)
    return outcome
  }

  private emitNodeChanged(op: AepDcwNodeChange['op'], node: DcwNode | null): void {
    const payload: AepDcwNodeChange = { op, node: node ? node.toView() : null }
    this.broadcast?.('dcw.node.changed', payload)
  }

  setBroadcast(fn: BroadcastFn | null): void {
    this.broadcast = fn
  }

  // ---------- 查询 ----------

  listViews(): DcwNodeView[] {
    this.ensureLoop()
    return this.repo.all().map(n => n.toView())
  }

  byId(id: string): DcwNode | undefined {
    return this.repo.byId(id)
  }

  controllerState() {
    return {
      running: this.running,
      nodesTotal: this.repo.all().length,
      nodesOnline: this.running ? this.repo.all().filter(n => n.enabled).length : 0,
      writesTotal: this.writesTotal,
      writesFailed: this.writesFailed,
    }
  }

  // ---------- 网关全局 ----------

  startAll() {
    this.running = true
    // 恢复控制:因「暂停全部控制」转 offline 的启用节点回待机(暂停态与恢复态对称)
    for (const n of this.repo.all()) {
      if (n.enabled && n.state === 'offline') n.state = 'idle'
    }
    this.ensureLoop()
    this.broadcast?.('dcw.controller', this.controllerState())
    return this.controllerState()
  }

  stopAll() {
    this.running = false
    for (const n of this.repo.all()) {
      if (n.enabled && n.value != null) n.state = 'offline'
    }
    this.broadcast?.('dcw.controller', this.controllerState())
    return this.controllerState()
  }

  // ---------- 节点 CRUD(单点控制入口)----------

  create(input: DcwCreateInput): DcwNode {
    this.ensureLoop()
    if (!input.templateRef) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'templateRef 必填:控制节点必须绑定工艺参数模板')
    }
    const tpl = findDcwTemplate(dcwKeyFromRef(input.templateRef))
    if (!tpl) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, `未知控制模板: ${input.templateRef}`)
    }
    const seq = this.repo.all().filter(n => n.templateKey === dcwKeyFromRef(input.templateRef!)).length + 1
    const node = new DcwNode({
      id: `dw-${randomUUID().slice(0, 8)}`,
      templateRef: input.templateRef,
      name: input.name ?? `${tpl.name} ${String(seq).padStart(2, '0')}`,
      driver: input.driver ? normalizeDcwDriverKind(input.driver) : undefined,
      driverConfig: input.driverConfig ?? {},
      transform: normalizeDataTransform(input.transform),
      enabled: input.enabled,
      holdIntervalMs: input.holdIntervalMs ?? null,
      unit: input.unit,
      decimals: input.decimals,
      min: input.min,
      max: input.max,
      deviceBindingId: input.deviceBindingId ?? null,
      posX: input.posX,
      posZ: input.posZ,
      lineId: input.lineId,
      semantics: input.semantics,
    })
    this.repo.insert(node)
    this.syncRuntimes()
    this.emitNodeChanged('added', node)
    return node
  }

  patch(id: string, patch: DcwPatchInput): DcwNode {
    const node = this.repo.byId(id)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    let rearm = false
    if (patch.name !== undefined) node.name = patch.name
    if (patch.driver !== undefined) node.driver = normalizeDcwDriverKind(patch.driver)
    if (patch.driverConfig !== undefined) node.driverConfig = { ...node.driverConfig, ...patch.driverConfig }
    if (patch.transform !== undefined) {
      if (patch.transform.kind === 'linear' && (!Number.isFinite(Number(patch.transform.scale)) || Number(patch.transform.scale) === 0)) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '标定系数 scale 必须为非零数字(物理值 = scale × PLC值 + offset)')
      }
      node.transform = normalizeDataTransform(patch.transform)
    }
    if (patch.unit !== undefined) node.unit = patch.unit
    if (patch.decimals !== undefined) node.decimals = patch.decimals
    if (patch.min !== undefined) node.min = patch.min
    if (patch.max !== undefined) node.max = patch.max
    if (patch.holdIntervalMs !== undefined) {
      node.holdIntervalMs = patch.holdIntervalMs == null ? null : Math.max(0, Math.min(3_600_000, Math.round(patch.holdIntervalMs)))
      rearm = true
    }
    if (patch.enabled !== undefined) {
      node.enabled = patch.enabled
      // 暂停/恢复的状态同步:暂停 → offline(暂停控制);恢复 → 回到待机(等下次写 ACK 转 ok)
      if (!patch.enabled) node.state = 'offline'
      else if (node.state === 'offline') node.state = 'idle'
      rearm = true
    }
    if (patch.posX !== undefined) node.posX = patch.posX
    if (patch.posZ !== undefined) node.posZ = patch.posZ
    if (patch.lineId !== undefined) {
      const lid = String(patch.lineId)
      if (lid && !getDcwLineRepo().byId(lid)) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${lid}`)
      node.lineId = lid
    }
    if (patch.semantics !== undefined) node.semantics = String(patch.semantics)
    if (rearm) this.runtimes.get(id)?.rearm()
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  remove(id: string): void {
    const node = this.repo.byId(id)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    this.repo.remove(id)
    this.runtimes.delete(id)
    // 级联清理:该节点的 Agent 绑定移除,挂起中的手动审批按失效收敛
    void import('../agents/node-bindings.repo').then(({ getAgentNodeBindingRepo }) => {
      const repo = getAgentNodeBindingRepo()
      for (const b of repo.byNode(id)) {
        void import('../agents/tool-approvals').then(({ getToolApprovals }) => {
          getToolApprovals().cancelPendingFor(b.agentId, id)
        }).catch(() => {})
        repo.removeAgentNode(b.agentId, id, 'dcw')
      }
    }).catch(() => {})
    this.emitNodeChanged('removed', node)
  }

  bind(id: string, deviceId: string | null): DcwNode {
    const node = this.repo.byId(id)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    if (deviceId) {
      const twin = getDeviceTwinRepo().findById(deviceId)
      if (!twin) throw new AppError(404, ErrorCodes.NOT_FOUND, `目标设备不存在: ${deviceId}`)
    }
    node.deviceBindingId = deviceId
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  /** 设备删除级联解绑(device-twins 删除路由调用) */
  unbindDevice(deviceId: string): void {
    for (const node of this.repo.all()) {
      if (node.deviceBindingId !== deviceId) continue
      node.deviceBindingId = null
      this.repo.flushNow()
      this.emitNodeChanged('updated', node)
    }
  }

  // ---------- 写命令(上位机核心操作)----------

  /** 手动设定:用户提交工程量,网关校验/换算/下发/回读校验。
   *  配方联锁:产线运行中,写入值还须落在活动配方对该参数的工艺窗口内
   *  (节点全局量程之外的第二道约束 —— 换配方即换工艺窗口)。 */
  async write(id: string, eng: number, recipeRunId: string | null = null) {
    this.ensureLoop()
    const rt = this.runtimes.get(id)
    if (!rt) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    const node = rt.node
    // 控制暂停双重门控:网关全局暂停(暂停全部控制)或节点级暂停 → 一律拒绝下发。
    // 手动 REST / 配方下发 / 产线开跑 / Agent 工具共用本入口,拒绝语义单点收敛。
    if (!this.running) {
      throw new AppError(409, ErrorCodes.CONFLICT, '控制网关已暂停(暂停全部控制):设定下发被拒绝,请先「恢复全部控制」')
    }
    if (!node.enabled) {
      throw new AppError(409, ErrorCodes.CONFLICT, `当前节点暂停:「${node.name}」控制已暂停,仅开启控制的节点可被设定`)
    }
    // 写联锁按产线:仅当**本节点所属产线**在跑时,叠加该批次配方的工艺窗口
    const run = getActiveLineRun(node.lineId)
    if (run && recipeRunId == null) {
      const recipe = getDcwRecipeRepo().byId(run.recipeId)
      const param = recipe?.params.find(p => p.nodeId === id)
      if (param) {
        if (param.min != null && eng < param.min) {
          throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `设定值 ${eng}${node.unit} 低于当前配方「${run.recipeName}」的工艺下限 ${param.min}${node.unit}(节点全局量程 ${node.min}~${node.max} 不适用于本批次)`)
        }
        if (param.max != null && eng > param.max) {
          throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `设定值 ${eng}${node.unit} 超出当前配方「${run.recipeName}」的工艺上限 ${param.max}${node.unit}(节点全局量程 ${node.min}~${node.max} 不适用于本批次)`)
        }
      }
    }
    return rt.write(eng, recipeRunId)
  }

  /** 连接测试 */
  async testDriver(kind: DcwDriverKind, driverConfig: Record<string, unknown>) {
    return resolveDcwDriver(normalizeDcwDriverKind(kind)).test(driverConfig)
  }

  async testNode(id: string) {
    const node = this.repo.byId(id)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    return this.testDriver(node.driver, node.driverConfig)
  }

  // ---------- Recipe 配方 ----------

  listRecipes() {
    return getDcwRecipeRepo().list()
  }

  createRecipe(input: RecipeInput) {
    return getDcwRecipeRepo().create(input)
  }

  updateRecipe(id: string, patch: Partial<RecipeInput>) {
    return getDcwRecipeRepo().update(id, patch)
  }

  removeRecipe(id: string): void {
    if (!getDcwRecipeRepo().remove(id)) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${id}`)
  }

  listRuns() {
    return getDcwRecipeRepo().listRuns()
  }

  listHistory(limit = 100): DcwWriteHistoryEntry[] {
    return getDcwRecipeRepo().historyList(limit)
  }

  /**
   * 逐参数写核心(apply 与产线开跑共用):**节点级寻址** —— 每个参数显式指向
   * 控制节点(节点才是真实控制 PLC 工艺参数的执行体)→ 逐参数写命令
   * (runId 入写历史)→ 结果快照。节点不存在 → 该参数记失败不阻塞其余。
   */
  private async writeRecipeParams(recipe: RecipeView, run: RecipeRunView): Promise<void> {
    const results: RecipeRunView['results'] = []
    for (const param of recipe.params) {
      const node = param.nodeId ? this.repo.byId(param.nodeId) : undefined
      if (!node) {
        results.push({ templateRef: param.templateRef ?? param.nodeId, nodeId: null, ok: false, message: `目标控制节点不存在(${param.nodeId}),参数未下发`, value: param.value })
        continue
      }
      try {
        const outcome = await this.write(node.id, param.value, run.id)
        results.push({ templateRef: node.templateRef, nodeId: node.id, ok: outcome.ok, message: outcome.message, value: param.value })
      }
      catch (err) {
        results.push({ templateRef: node.templateRef, nodeId: node.id, ok: false, message: err instanceof Error ? err.message : String(err), value: param.value })
      }
    }
    run.results = results
    getDcwRecipeRepo().updateRun(run)
  }

  /** Recipe 手动应用(一键下发工艺参数集;不激活产线窗口) */
  async applyRecipe(recipeId: string) {
    this.ensureLoop()
    const repo = getDcwRecipeRepo()
    const recipe = repo.byId(recipeId)
    if (!recipe) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${recipeId}`)
    if (recipe.params.length === 0) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Recipe 无工艺参数,无可下发内容')
    const run = repo.createRun(recipe)
    await this.writeRecipeParams(recipe, run)
    return run
  }

  closeRun(id: string) {
    return getDcwRecipeRepo().closeRun(id)
  }

  // ---------- 产线(实体 CRUD;节点/产品/配方挂载其下实现隔离) ----------

  listLines(): LineView[] {
    return getDcwLineRepo().all()
  }

  createLine(input: LineInput): LineView {
    return getDcwLineRepo().create(input)
  }

  updateLine(id: string, patch: Partial<LineInput>): LineView {
    return getDcwLineRepo().update(id, patch)
  }

  /** 删除产线:自动停止运行窗口;旗下节点/产品/配方解除挂载(lineId='' 未分配),数据保留 */
  async removeLine(id: string): Promise<void> {
    const line = getDcwLineRepo().byId(id)
    if (!line) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${id}`)
    if (getActiveLineRun(id)) this.lineStop(id)
    for (const n of this.repo.all()) {
      if (n.lineId === id) {
        n.lineId = ''
        this.emitNodeChanged('updated', n)
      }
    }
    this.repo.flushNow()
    const productRepo = getDcwProductRepo()
    for (const p of productRepo.all()) {
      if (p.lineId === id) productRepo.update(p.id, { lineId: '' })
    }
    const recipeRepo = getDcwRecipeRepo()
    for (const r of recipeRepo.list()) {
      if (r.lineId === id) recipeRepo.detachLine(r.id)
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
    this.broadcast?.('dcw.controller', this.controllerState())
    // 数采门控联动:该产线无活动配方即停止其节点采集,置 offline 并广播收敛
    void import('../daq/daq-controller').then(({ getDaqController }) => {
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
    const { getTsdb, tsdbReady } = await import('../daq/storage')
    await tsdbReady
    const { getDaqNodeRepo } = await import('../daq/daq-node.repo')
    const { findDaqTemplate } = await import('../daq/daq-templates')
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
      bucketMs: opts.bucketMs,
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

  listProducts(): ProductView[] {
    return getDcwProductRepo().all()
  }

  createProduct(input: ProductInput): ProductView {
    const lineId = String(input.lineId ?? '')
    if (lineId && !getDcwLineRepo().byId(lineId)) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${lineId}`)
    return getDcwProductRepo().create({ ...input, lineId })
  }

  updateProduct(id: string, patch: Partial<ProductInput>): ProductView {
    if (patch.lineId) {
      const lid = String(patch.lineId)
      if (!getDcwLineRepo().byId(lid)) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${lid}`)
    }
    const prev = getDcwProductRepo().byId(id)
    const updated = getDcwProductRepo().update(id, patch)
    // 产品换线 → 旗下配方产线归属级联(开跑校验按 recipe.lineId)
    if (prev && prev.lineId !== updated.lineId) {
      const recipeRepo = getDcwRecipeRepo()
      for (const r of recipeRepo.list()) {
        if (r.productId === id) recipeRepo.setRecipeLine(r.id, updated.lineId)
      }
    }
    return updated
  }

  removeProduct(id: string): void {
    const product = getDcwProductRepo().byId(id)
    if (!product) throw new AppError(404, ErrorCodes.NOT_FOUND, `产品不存在: ${id}`)
    if (product.lineId && getActiveLineRun(product.lineId)?.productId === id) {
      throw new AppError(409, ErrorCodes.CONFLICT, '产品正在产线运行中,不可删除(请先停止数据采集)')
    }
    getDcwProductRepo().remove(id)
  }

  /**
   * 批次数据视图(产品隔离):批次窗口内的写历史 + 全部数采节点的窗口内汇总
   * (latest/avg/min/max/cnt,窗口 > 60s 时按窗口/100 自动降采样)。
   */
  async runData(id: string) {
    const repo = getDcwRecipeRepo()
    const run = repo.runById(id)
    if (!run) throw new AppError(404, ErrorCodes.NOT_FOUND, `批次不存在: ${id}`)
    const endMs = run.endedAt ? Date.parse(run.endedAt) : Date.now()
    const startMs = Date.parse(run.startedAt)
    const writes = repo.historyInWindow(run.startedAt, run.endedAt, id)
    const { getDaqNodeRepo } = await import('../daq/daq-node.repo')
    const { getTsdb, tsdbReady } = await import('../daq/storage')
    const { findDaqTemplate } = await import('../daq/daq-templates')
    await tsdbReady
    const bucketMs = endMs - startMs > 60_000 ? Math.max(1000, Math.round((endMs - startMs) / 200)) : undefined
    const daq = [] as Array<{ templateRef: string, nodeId: string, nodeName: string, ch: string, unit: string, latest: number | null, avg: number | null, min: number | null, max: number | null, cnt: number }>
    for (const node of getDaqNodeRepo().all()) {
      try {
        const points = await getTsdb().query(node.id, { fromMs: startMs, toMs: endMs, bucketMs, limit: 500 })
        if (points.length === 0) continue
        const values = points.map(p => p.value ?? p.avg ?? 0).filter(v => Number.isFinite(v))
        if (values.length === 0) continue
        const tpl = findDaqTemplate(node.templateKey)
        daq.push({
          templateRef: node.templateRef,
          nodeId: node.id,
          nodeName: node.name,
          ch: tpl?.ch ?? node.templateKey,
          unit: node.unit,
          latest: values[values.length - 1]!,
          avg: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(node.decimals)),
          min: Number(Math.min(...values).toFixed(node.decimals)),
          max: Number(Math.max(...values).toFixed(node.decimals)),
          cnt: values.length,
        })
      }
      catch { /* 单节点查询失败不阻塞整体 */ }
    }
    return { run, daq, writes }
  }
}

// ---------- 单例(HMR 存活) ----------

const g = globalThis as typeof globalThis & { __dcwController?: DcwController }

export function getDcwController(): DcwController {
  g.__dcwController ??= new DcwController()
  return g.__dcwController
}

/** 广播装配(dcw 路由模块加载时调用一次;首访即上电) */
export function bindDcwBroadcast(fn: BroadcastFn | null): void {
  getDcwController().setBroadcast(fn)
}

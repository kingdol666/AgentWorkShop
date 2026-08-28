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
import type { AepDcwNodeChange, DcwDriverKind, DcwNodeView, RecipeInput, RecipeRunView } from '../../../../shared/dcw-protocol'
import { dcwKeyFromRef } from '../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { normalizeDcwDriverKind, resolveDcwDriver } from './drivers'
import { findDcwTemplate } from './dcw-templates'
import { getDeviceTwinRepo } from '../assets/device-twin.repo'
import { DcwNode } from './dcw-node'
import { getDcwNodeRepo } from './dcw-node.repo'
import { DcwNodeRuntime } from './dcw-runtime'
import { getDcwRecipeRepo, type DcwWriteHistoryEntry } from './dcw-recipe.repo'

type BroadcastFn = (type: string, payload: unknown) => void

export interface DcwCreateInput {
  templateRef?: string
  name?: string
  driver?: DcwDriverKind
  driverConfig?: Record<string, string | number | boolean>
  holdIntervalMs?: number | null
  unit?: string
  decimals?: number
  min?: number
  max?: number
  enabled?: boolean
  posX?: number
  posZ?: number
  deviceBindingId?: string | null
}

export interface DcwPatchInput {
  name?: string
  driver?: DcwDriverKind
  driverConfig?: Record<string, string | number | boolean>
  holdIntervalMs?: number | null
  unit?: string
  decimals?: number
  min?: number
  max?: number
  enabled?: boolean
  posX?: number
  posZ?: number
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
    let outcome: { ok: boolean, message: string, raw: number | null, readback: number | null }
    try {
      outcome = await resolveDcwDriver(node.driver).write({
        eng,
        tolerance,
        domain: { min: node.min, max: node.max },
        driverConfig: node.driverConfig,
      })
    }
    catch (err) {
      outcome = { ok: false, message: err instanceof Error ? err.message : String(err), raw: null, readback: null }
    }
    this.writesTotal++
    if (!outcome.ok) this.writesFailed++
    node.applyWriteResult(eng, outcome.ok, outcome.message, at)
    this.repo.flushNow()
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
      enabled: input.enabled,
      holdIntervalMs: input.holdIntervalMs ?? null,
      unit: input.unit,
      decimals: input.decimals,
      min: input.min,
      max: input.max,
      deviceBindingId: input.deviceBindingId ?? null,
      posX: input.posX,
      posZ: input.posZ,
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
      if (!patch.enabled) node.state = 'offline'
      rearm = true
    }
    if (patch.posX !== undefined) node.posX = patch.posX
    if (patch.posZ !== undefined) node.posZ = patch.posZ
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

  /** 手动设定:用户提交工程量,网关校验/换算/下发/回读校验 */
  async write(id: string, eng: number, recipeRunId: string | null = null) {
    this.ensureLoop()
    const rt = this.runtimes.get(id)
    if (!rt) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
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
   * Recipe 应用(一键下发工艺参数集):
   * 创建批次(Run)→ 按 templateRef 匹配控制节点(参数可显式指定 nodeId)→
   * 逐参数写命令(带 runId 入写历史)→ 批次结果快照。无匹配节点 → 该参数记失败不阻塞其余。
   */
  async applyRecipe(recipeId: string) {
    this.ensureLoop()
    const repo = getDcwRecipeRepo()
    const recipe = repo.byId(recipeId)
    if (!recipe) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${recipeId}`)
    if (recipe.params.length === 0) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Recipe 无工艺参数,无可下发内容')
    const run = repo.createRun(recipe)
    const results: RecipeRunView['results'] = []
    for (const param of recipe.params) {
      const key = dcwKeyFromRef(param.templateRef)
      const node = this.repo.all()
        .filter(n => n.templateKey === key && (param.nodeId ? n.id === param.nodeId : true))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      if (!node) {
        results.push({ templateRef: param.templateRef, nodeId: null, ok: false, message: `无匹配的控制节点(模板 ${key}),参数未下发`, value: param.value })
        continue
      }
      try {
        const outcome = await this.write(node.id, param.value, run.id)
        results.push({ templateRef: param.templateRef, nodeId: node.id, ok: outcome.ok, message: outcome.message, value: param.value })
      }
      catch (err) {
        results.push({ templateRef: param.templateRef, nodeId: node.id, ok: false, message: err instanceof Error ? err.message : String(err), value: param.value })
      }
    }
    run.results = results
    repo.updateRun(run)
    return run
  }

  closeRun(id: string) {
    return getDcwRecipeRepo().closeRun(id)
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

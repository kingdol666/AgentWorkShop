/**
 * DaqController —— 数采网关(应用级单例):统一调度全部节点运行时并汇聚管线。
 *
 * 概念模型:每个数采节点一个独立运行时(DaqNodeRuntime,边缘计算节点),
 * 节拍状态(采样/WS 下发/故障节流/在飞互斥)全部驻运行时实例,由节点元数据驱动
 * (intervalMs 采集入库节拍 / publishIntervalMs WS 实时下发节拍,null 跟随网关缺省);
 * 网关 = 总体网关:注册表管理运行时生命周期 + 统一 tick 调度 + 管线汇聚。
 *
 *   [边缘运行时 ×N]                         [队列]                [网关消费泵]
 *   runtime.tick 到期 → 驱动采样 ────────▶ DaqQueuePort ──────▶ 按节点分发回 runtime
 *     (mock/PLC 驱动)                      mqtt|inproc           ├─ 乱序防御 + 越限派生(runtime)
 *                                                                ├─ WS daq.reading 直推(按 publishIntervalMs 门控)
 *                                                                ├─ TSDB 批量落库(每帧必达,Timescale/SQLite)
 *                                                                └─ 绑定设备 telemetry 回写
 *
 * 工业约定:
 *  - 全局缺省(running/defaultIntervalMs/defaultPublishIntervalMs)+ 单节点元数据
 *    独立覆盖(enabled/intervalMs/publishIntervalMs/阈值/驱动/绑定),REST 为控制面;
 *  - 消费端乱序防御:晚于运行时已知游标的迟到帧丢弃(真实 broker 下常见);
 *  - 驱动故障节点置 offline 并按运行时独立节流广播(error 帧);
 *  - 指标(produced/consumed/dropped/samplesStored)随 daq.controller 帧与 meta 暴露。
 */

import { randomUUID } from 'node:crypto'
import { daqKeyFromRef, DAQ_DRIVERS, type AepDaqControllerState, type AepDaqReading, type AepDaqNodeChange, type DaqDriverKind, type DaqNodeView, type DriverTestResult } from '../../../../shared/daq-protocol'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { normalizeDriverKind, resolveDaqDriver, probeDriverAvailability } from './drivers'
import { findDaqTemplate } from './daq-templates'
import { getDeviceTwinRepo, deviceScenePayload, type DeviceTwinRepo } from '../assets/device-twin.repo'
import { DaqNode } from './daq-node'
import { DaqNodeRuntime, type DaqRuntimeHost } from './daq-runtime'
import { getDaqNodeRepo } from './daq-node.repo'
import { getTsdb, tsdbReady } from './storage'
import { getDaqQueue } from './bus'
import { bumpTaggedSamples, getActiveLineRun } from '../dcw/line-run'
import type { DaqSampleEnvelope } from './bus/queue-port'

/** 数采值回写绑定时,映射进设备孪生已有遥测语义键(命中既有告警派生规则) */
const TELEMETRY_KEY_OF: Record<string, string> = {
  'temp-tc': 'temperature',
  'pressure-tx': 'pressure',
}

export interface DaqCreateInput {
  templateRef?: string
  name?: string
  driver?: DaqDriverKind
  driverConfig?: Record<string, string | number | boolean>
  unit?: string
  decimals?: number
  min?: number
  max?: number
  warnLow?: number | null
  warnHigh?: number | null
  intervalMs?: number | null
  /** WS 实时下发间隔(null=跟随全局;0=每帧) */
  publishIntervalMs?: number | null
  enabled?: boolean
  posX?: number
  posZ?: number
  deviceBindingId?: string | null
}

export interface DaqPatchInput {
  name?: string
  driver?: DaqDriverKind
  driverConfig?: Record<string, string | number | boolean>
  unit?: string
  decimals?: number
  min?: number
  max?: number
  warnLow?: number | null
  warnHigh?: number | null
  intervalMs?: number | null
  /** WS 实时下发间隔(null=跟随全局;0=每帧) */
  publishIntervalMs?: number | null
  enabled?: boolean
  posX?: number
  posZ?: number
}

type BroadcastFn = (type: string, payload: unknown) => void

/** TSDB 批量写窗口(ms):消费端攒批再落盘 */
const TSDB_FLUSH_MS = 500
/** TSDB 攒批缓冲上限(背压:满则丢最旧并计数,防慢库拖爆内存) */
const TSDB_BUFFER_CAP = 5000
/** TSDB 写失败重试次数(有限重试后丢弃并计数,不阻塞消费) */
const TSDB_WRITE_RETRIES = 3

class DaqController {
  private repo = getDaqNodeRepo()
  private broadcast: BroadcastFn | null = null
  private timer: NodeJS.Timeout | null = null
  /** 边缘运行时注册表(节点 id → 独立运行时;网关统一管理生命周期) */
  private runtimes = new Map<string, DaqNodeRuntime>()
  /** TSDB 批量缓冲(consumer 攒批 → 定窗刷盘;上限背压,满丢最旧;产线窗口内逐样本打标) */
  private tsdbBuffer: Array<{ nodeId: string, tsMs: number, value: number, state: string, productId?: string | null, recipeId?: string | null, runId?: string | null }> = []
  private tsdbFlushTimer: NodeJS.Timeout | null = null
  /** 单 in-flight 写:写库中不叠写(promise 链串行化) */
  private tsdbWriting = false
  /** 消费侧真实丢弃计数:乱序迟到帧 */
  private lateDropped = 0
  /** 写库侧丢弃计数(重试耗尽/缓冲溢出) */
  private tsdbDropped = 0
  private queueInit: Promise<unknown> | null = null
  /** 当前队列的消费退订(rebuild 后重挂) */
  private queueUnsub: (() => void) | null = null
  /** 管线就绪前生产者静默(队列/消费必须先在位) */
  private pipelineReady = false

  running = true
  defaultIntervalMs = 1000
  /** 全局缺省 WS 下发间隔(节点 publishIntervalMs=null 跟随;0 = 随采样节拍) */
  defaultPublishIntervalMs = 0
  private producedCount = 0
  private consumedCount = 0
  private storedCount = 0

  // ---------- 生命周期 ----------

  private ensureLoop(): void {
    this.syncRuntimes()
    if (!this.queueInit) {
      this.queueInit = (async () => {
        const queue = await getDaqQueue()
        this.queueUnsub?.()
        this.queueUnsub = queue.consume(env => this.onSampleFromQueue(env))
        await queue.init()
        this.pipelineReady = true
      })()
      this.queueInit.catch(err => console.error('[daq] 管线初始化失败:', err instanceof Error ? err.message : err))
    }
    if (this.timer) return
    // 网关扫描周期 250ms(统一调度;节拍判定/互斥在各运行时内部自治)
    this.timer = setInterval(() => this.sweep(), 250)
    this.timer.unref?.()
  }

  // ---------- 网关服务面(runtime host 实现;运行时只依赖此接口) ----------

  private runtimeDefaults(): { intervalMs: number, publishIntervalMs: number } {
    return { intervalMs: this.defaultIntervalMs, publishIntervalMs: this.defaultPublishIntervalMs }
  }

  /** 生产面:驱动采样一次(模板域 + 协议参数解析;mock/PLC 统一走驱动注册表) */
  private async sampleNode(node: DaqNode, now: number): Promise<number | null> {
    const tpl = findDaqTemplate(node.templateKey)
    return resolveDaqDriver(node.driver).sample({
      ctx: { nodeId: node.id, now, ageMs: now - Date.parse(node.createdAt || new Date(now).toISOString()) },
      config: {
        base: tpl?.base ?? (node.min + node.max) / 2,
        amp: tpl?.amp ?? Math.max((node.max - node.min) * 0.04, 0.001),
        min: node.min,
        max: node.max,
      },
      driverConfig: node.driverConfig,
    })
  }

  /** 生产面:样本帧入队 */
  private publishSample(env: DaqSampleEnvelope): void {
    void getDaqQueue().then(q => q.publish(env)).catch(() => {})
    this.producedCount++
  }

  /** 消费面:样本入网关管线(状态派生已在 runtime 完成)。
   *  allowPublish = 通过该节点 WS 下发节拍门控;入库/遥测回写不受门控(每帧必达)。 */
  private ingestNode(node: DaqNode, env: DaqSampleEnvelope, allowPublish: boolean): void {
    if (allowPublish) {
      this.broadcast?.('daq.reading', {
        nodeId: node.id,
        templateRef: node.templateRef,
        value: node.value ?? env.value,
        state: node.state,
        at: env.at,
      } satisfies AepDaqReading)
    }
    this.writeBackTelemetry(node)

    // 时序库批量攒写(定窗刷盘;上限背压:满丢最旧并计数)
    // 产线批次打标:活动 LineRun 窗口内每条样本携带 product/recipe/run id(产品级数据隔离)
    const tsMs = Date.parse(env.at)
    const lineRun = getActiveLineRun()
    if (lineRun) bumpTaggedSamples(1)
    this.tsdbBuffer.push({
      nodeId: node.id,
      tsMs,
      value: env.value,
      state: node.state,
      productId: lineRun?.productId ?? null,
      recipeId: lineRun?.recipeId ?? null,
      runId: lineRun?.runId ?? null,
    })
    if (this.tsdbBuffer.length > TSDB_BUFFER_CAP) {
      this.tsdbBuffer.splice(0, this.tsdbBuffer.length - TSDB_BUFFER_CAP)
      this.tsdbDropped += 1
    }
    if (!this.tsdbFlushTimer && !this.tsdbWriting) {
      this.tsdbFlushTimer = setTimeout(() => {
        this.tsdbFlushTimer = null
        void this.flushTsdb()
      }, TSDB_FLUSH_MS)
      this.tsdbFlushTimer.unref?.()
    }
  }

  private broadcastDriverError(node: DaqNode, message: string): void {
    this.broadcast?.('error', { code: 'DAQ_DRIVER', message: `[${node.name}] ${message}` })
  }

  /** 网关统一调度:250ms 扫描,到期判定与互斥由各运行时私有节拍自治(单节点慢/停不波及邻居) */
  private sweep(): void {
    if (!this.pipelineReady || !this.running) return
    const now = Date.now()
    for (const rt of this.runtimes.values()) {
      void rt.tick(now)
    }
  }

  /** 运行时注册表对账(仓库为权威:增删节点/启动即对齐;返回新建的运行时) */
  private syncRuntimes(): void {
    const live = new Set<string>()
    for (const node of this.repo.all()) {
      live.add(node.id)
      if (!this.runtimes.has(node.id)) {
        this.runtimes.set(node.id, new DaqNodeRuntime(node, this.host))
      }
    }
    for (const id of [...this.runtimes.keys()]) {
      if (!live.has(id)) this.runtimes.delete(id)
    }
  }

  /** runtime host:网关注入的服务面(采样/入队/管线/告警/全局缺省) */
  private host: DaqRuntimeHost = {
    defaults: () => this.runtimeDefaults(),
    sample: (node, now) => this.sampleNode(node, now),
    publishSample: env => this.publishSample(env),
    ingest: (node, env, allowPublish) => this.ingestNode(node, env, allowPublish),
    broadcastError: (node, message) => this.broadcastDriverError(node, message),
  }

  // ---------- 消费者:队列帧 → 存储/广播/回写 ----------

  /** 网关消费泵:队列帧按节点分发回其运行时(乱序防御/状态派生/下发门控在 runtime) */
  private onSampleFromQueue(env: DaqSampleEnvelope): void {
    this.consumedCount++
    const rt = this.runtimes.get(env.nodeId)
    if (!rt) return
    if (rt.onSample(env) === 'late') this.lateDropped++
  }

  /** 单 in-flight 写 + 有限重试:写库中攒批继续,失败保留批退避重试,耗尽丢弃并计数 */
  private async flushTsdb(): Promise<void> {
    if (this.tsdbWriting) return
    this.tsdbWriting = true
    try {
      while (this.tsdbBuffer.length > 0) {
        const batch = this.tsdbBuffer.splice(0, this.tsdbBuffer.length)
        let ok = false
        for (let attempt = 0; attempt < TSDB_WRITE_RETRIES && !ok; attempt++) {
          try {
            await getTsdb().writeSamples(batch)
            this.storedCount += batch.length
            ok = true
          }
          catch (err) {
            if (attempt === TSDB_WRITE_RETRIES - 1) {
              this.tsdbDropped += batch.length
              console.error('[daq] 时序库写入失败(已重试,丢弃计数):', err instanceof Error ? err.message : err)
            }
            else {
              await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
            }
          }
        }
      }
    }
    finally {
      this.tsdbWriting = false
    }
  }

  /** 绑定设备端到端回写:通道值进入 DeviceTwin.telemetry(键名对齐既有告警派生) */
  private pendingBackfill = new Map<string, Record<string, number | string | boolean>>()

  private writeBackTelemetry(node: DaqNode): void {
    if (!node.deviceBindingId || node.value == null) return
    const key = TELEMETRY_KEY_OF[node.templateKey] ?? node.templateKey
    const twins = getDeviceTwinRepo()
    const acc = this.pendingBackfill.get(node.deviceBindingId) ?? {}
    acc[key] = node.value
    this.pendingBackfill.set(node.deviceBindingId, acc)
    try {
      const twin = twins.applyTelemetry(node.deviceBindingId, acc)
      this.pendingBackfill.delete(node.deviceBindingId)
      if (twin) this.pushTwinTelemetry(twin)
    }
    catch {
      // 目标设备已被删除:解绑自身,链路自愈
      node.deviceBindingId = null
      this.emitNodeChanged('updated', node)
    }
  }

  /** 遥测 WS 推送(1s/设备节流):孪生状态/遥测事件化直推,前端全量轮询降级为断线兜底 */
  private twinPushAt = new Map<string, number>()

  private pushTwinTelemetry(twin: NonNullable<ReturnType<DeviceTwinRepo['applyTelemetry']>>): void {
    const now = Date.now()
    if (now - (this.twinPushAt.get(twin.id) ?? 0) < 1000) return
    this.twinPushAt.set(twin.id, now)
    this.broadcast?.('device.updated', deviceScenePayload(twin))
  }

  private emitNodeChanged(op: AepDaqNodeChange['op'], node: DaqNode | null): void {
    const payload: AepDaqNodeChange = { op, node: node ? node.toView() : null }
    this.broadcast?.('daq.node.changed', payload)
  }

  private emitController(): void {
    this.broadcast?.('daq.controller', this.controllerState())
  }

  /** ws.ts 的 broadcastSceneEvent 在此装配(daq 路由模块加载时调用一次) */
  setBroadcast(fn: BroadcastFn | null): void {
    this.broadcast = fn
  }

  onlineCount(): number {
    if (!this.running) return 0
    return this.repo.all().filter(n => n.enabled).length
  }

  controllerState(): AepDaqControllerState & { produced?: number, consumed?: number, dropped?: number, samplesStored?: number, tsdbDropped?: number } {
    // 丢弃 = 队列层真实丢弃(inproc 拥塞/mqtt 断连)+ 消费侧乱序迟到帧(诚实可见)
    const queueLost = g_queueLost()
    return {
      running: this.running,
      defaultIntervalMs: this.defaultIntervalMs,
      defaultPublishIntervalMs: this.defaultPublishIntervalMs,
      nodesTotal: this.repo.all().length,
      nodesOnline: this.onlineCount(),
      produced: this.producedCount,
      consumed: this.consumedCount,
      dropped: Math.max(0, this.producedCount - this.consumedCount) + queueLost + this.lateDropped,
      samplesStored: this.storedCount,
      tsdbDropped: this.tsdbDropped,
    }
  }

  /** infra 重连后重挂消费者到新队列实例(MQTT↔进程内切换) */
  async reattachQueue(): Promise<void> {
    this.pipelineReady = false
    const queue = await getDaqQueue()
    this.queueUnsub?.()
    this.queueUnsub = queue.consume(env => this.onSampleFromQueue(env))
    this.pipelineReady = true
  }

  // ---------- 查询 ----------

  listViews(): DaqNodeView[] {
    this.ensureLoop()
    return this.repo.all().map(n => n.toView())
  }

  byId(id: string): DaqNode | undefined {
    return this.repo.byId(id)
  }

  /** 节点历史(时序库查询透传;raw 或 bucket 聚合形态) */
  async samples(id: string, opts: { fromMs?: number, toMs?: number, bucketMs?: number, limit?: number }) {
    this.ensureLoop()
    await tsdbReady
    const node = this.repo.byId(id)
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
    return getTsdb().query(id, opts)
  }

  /** 后端能力自描述(meta 用) */
  backends(): { tsdb: string, queue: string, drivers: typeof DAQ_DRIVERS } {
    return { tsdb: getTsdb().backend, queue: g_queueBackend ?? 'inproc', drivers: DAQ_DRIVERS }
  }

  // ---------- 控制器全局 ----------

  startAll(): AepDaqControllerState {
    this.running = true
    this.ensureLoop()
    this.emitController()
    return this.controllerState()
  }

  stopAll(): AepDaqControllerState {
    this.running = false
    for (const n of this.repo.all()) {
      if (n.enabled) n.state = 'offline'
    }
    this.emitController()
    return this.controllerState()
  }

  configure(opts: { defaultIntervalMs?: number, defaultPublishIntervalMs?: number }): AepDaqControllerState {
    let changed = false
    if (typeof opts.defaultIntervalMs === 'number' && opts.defaultIntervalMs >= 120) {
      this.defaultIntervalMs = Math.min(60_000, Math.round(opts.defaultIntervalMs))
      changed = true
    }
    if (typeof opts.defaultPublishIntervalMs === 'number' && opts.defaultPublishIntervalMs >= 0) {
      this.defaultPublishIntervalMs = Math.min(60_000, Math.round(opts.defaultPublishIntervalMs))
      changed = true
    }
    if (changed) {
      // 网关缺省变更即刻生效:全部运行时重置节拍(元数据 null 的节点跟随新缺省)
      for (const rt of this.runtimes.values()) rt.rearm()
    }
    this.emitController()
    return this.controllerState()
  }

  // ---------- 节点 CRUD(单点控制入口)----------

  create(input: DaqCreateInput): DaqNode {
    this.ensureLoop()
    // 节点必绑模板:模板是量程/单位/物理语义(ch)的唯一来源,无模板节点在孪生
    // 场景无元信息可展示(UI 全路径经模板创建;直接 REST 裸调在此收口)
    if (!input.templateRef) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'templateRef 必填:数采节点必须绑定信号模板')
    }
    const tpl = findDaqTemplate(daqKeyFromRef(input.templateRef))
    if (!tpl) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, `未知数采模板: ${input.templateRef}`)
    }
    const seq = this.repo.all().filter(n => n.templateKey === daqKeyFromRef(input.templateRef!)).length + 1
    const node = new DaqNode({
      id: `dn-${randomUUID().slice(0, 8)}`,
      templateRef: input.templateRef,
      name: input.name ?? (tpl ? `${tpl.name} ${String(seq).padStart(2, '0')}` : (input.driver && input.driver !== 'mock' ? `${input.driver.toUpperCase()} 通道` : undefined)),
      driver: input.driver ? normalizeDriverKind(input.driver) : undefined,
      driverConfig: input.driverConfig ?? {},
      enabled: input.enabled,
      intervalMs: input.intervalMs ?? null,
      publishIntervalMs: input.publishIntervalMs ?? null,
      unit: input.unit,
      decimals: input.decimals,
      min: input.min,
      max: input.max,
      warnLow: input.warnLow,
      warnHigh: input.warnHigh,
      deviceBindingId: input.deviceBindingId ?? null,
      posX: input.posX,
      posZ: input.posZ,
    })
    this.repo.insert(node)
    this.syncRuntimes() // 新节点即刻入网关注册表(边缘运行时实例化)
    this.emitNodeChanged('added', node)
    return node
  }

  patch(id: string, patch: DaqPatchInput): DaqNode {
    const node = this.repo.byId(id)
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
    if (patch.name !== undefined) node.name = patch.name
    if (patch.driver !== undefined) node.driver = normalizeDriverKind(patch.driver)
    if (patch.driverConfig !== undefined) node.driverConfig = { ...node.driverConfig, ...patch.driverConfig }
    if (patch.unit !== undefined) node.unit = patch.unit
    if (patch.decimals !== undefined) node.decimals = patch.decimals
    if (patch.min !== undefined) node.min = patch.min
    if (patch.max !== undefined) node.max = patch.max
    if (patch.warnLow !== undefined) node.warnLow = patch.warnLow
    if (patch.warnHigh !== undefined) node.warnHigh = patch.warnHigh
    let rearm = false
    if (patch.intervalMs !== undefined) {
      node.intervalMs = patch.intervalMs == null ? null : Math.max(120, Math.min(60_000, patch.intervalMs))
      rearm = true
    }
    if (patch.publishIntervalMs !== undefined) {
      // 下发节拍:null=跟随全局;0=每帧;否则 120ms~60s
      node.publishIntervalMs = patch.publishIntervalMs == null
        ? null
        : Math.max(0, Math.min(60_000, Math.round(patch.publishIntervalMs)))
      rearm = true
    }
    if (patch.enabled !== undefined) {
      node.enabled = patch.enabled
      if (!patch.enabled) node.state = 'offline'
      rearm = true
    }
    if (rearm) this.runtimes.get(id)?.rearm() // 元数据变更即刻生效(独立运行时节拍重置)
    if (patch.posX !== undefined) node.posX = patch.posX
    if (patch.posZ !== undefined) node.posZ = patch.posZ
    if (node.value != null) node.state = node.deriveState(node.value)
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  remove(id: string): void {
    const node = this.repo.byId(id)
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
    this.repo.remove(id)
    this.runtimes.delete(id) // 运行时随节点注销
    this.emitNodeChanged('removed', node)
  }

  bind(id: string, deviceId: string | null): DaqNode {
    const node = this.repo.byId(id)
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
    if (deviceId) {
      const twin = getDeviceTwinRepo().findById(deviceId)
      if (!twin) throw Object.assign(new Error(`目标设备不存在: ${deviceId}`), { status: 404 })
    }
    node.deviceBindingId = deviceId
    this.repo.flushNow()
    this.emitNodeChanged('updated', node)
    return node
  }

  /** 设备删除级联:解绑其全部 DAQ 节点 + 清回写积压 + 广播(链路不再依赖下次回写失败自愈) */
  unbindDevice(deviceId: string): void {
    this.pendingBackfill.delete(deviceId)
    for (const node of this.repo.all()) {
      if (node.deviceBindingId !== deviceId) continue
      node.deviceBindingId = null
      this.repo.flushNow()
      this.emitNodeChanged('updated', node)
    }
  }

  /** 连接测试:按协议参数建连 + 读一次(前端"测试连接"按钮直达) */
  async testDriver(kind: DaqDriverKind, driverConfig: Record<string, unknown>): Promise<DriverTestResult> {
    const drv = resolveDaqDriver(normalizeDriverKind(kind))
    if (!(await drv.available())) {
      return { ok: false, message: `协议栈不可用(包未安装或加载失败): ${kind}` }
    }
    return drv.test(driverConfig)
  }

  /** 存量节点连接测试(用节点已保存参数) */
  async testNode(id: string): Promise<DriverTestResult> {
    const node = this.repo.byId(id)
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
    return this.testDriver(node.driver, node.driverConfig)
  }

  /** 驱动可用性(meta;包缺失 → planned 提示而非硬失败) */
  async driverAvailability(): Promise<Record<string, boolean>> {
    return probeDriverAvailability()
  }

  // ---------- 存量迁移(device-twins kind=daq → DaqNode 幂等供给) ----------

  /**
   * 旧前端把数采实例存成 device-twins(kind='daq');切换为服务端权威实体后,
   * 首次访问把存量孪生逐条升格为 DaqNode(位置/名称沿用)。幂等:确定性主键
   * `dn-lg-<twinId>` —— 重复供给/HMR 双实例都不会产生第二条。
   */
  provisionLegacyTwins(): void {
    this.ensureLoop()
    const twins = getDeviceTwinRepo().listAll()
    for (const t of twins) {
      const isDaq = t.kind === 'daq' || (t.modelRef ?? '').startsWith('daq-')
      if (!isDaq || !t.modelRef) continue
      const stableId = `dn-lg-${t.id}`
      if (this.repo.byId(stableId)) continue
      const node = new DaqNode({
        id: stableId,
        templateRef: t.modelRef,
        name: t.name,
        posX: t.posX,
        posZ: t.posZ,
      })
      ;(node as unknown as { sourceTwinId?: string }).sourceTwinId = t.id
      this.repo.insert(node)
    }
    this.syncRuntimes()
  }
}

// ---------- 单例(HMR 存活) ----------

const g = globalThis as typeof globalThis & { __daqController?: DaqController, __daqQueueBackend?: string }
let g_queueBackend = 'inproc'

/** 当前队列适配器的真实丢弃计数(mqtt 断连/inproc 拥塞) */
function g_queueLost(): number {
  const q = (globalThis as typeof globalThis & { __daqQueue?: { lost?: number } }).__daqQueue
  return q?.lost ?? 0
}

export function getDaqController(): DaqController {
  g.__daqController ??= new DaqController()
  return g.__daqController
}

/**
 * 广播装配(daq REST 路由模块加载时调用):把 ws.ts 的 broadcastSceneEvent
 * 注入控制器 —— 路由模块是 nitro 按需加载,小镇页首访必经 GET /api/workshop/daq,
 * 因此无需常驻插件即可保证采样帧有出口。
 */
export function bindDaqBroadcast(fn: BroadcastFn | null): void {
  getDaqController().setBroadcast(fn)
  // 同时确保管线启动(队列消费在位)——REST 首访即全链路上电
  void getDaqQueue().then((q) => {
    g_queueBackend = q.backend
  }).catch(() => {})
}

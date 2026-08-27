/**
 * DaqController —— 数据采集总控(应用级单例)。
 *
 * 管线(生产者 / 消费者经消息队列解耦):
 *
 *   [采集 生产者]                          [队列]                [消费者]
 *   sweep 到期 → 驱动采样 ──────────────▶ DaqQueuePort ──────▶ 消费泵
 *     (mock/PLC 驱动)                     mqtt|inproc           ├─ 越限派生 ok/warn/alarm/offline
 *                                                              ├─ TSDB 批量落库(Timescale/SQLite)
 *                                                              ├─ WS daq.reading 直推前端
 *                                                              └─ 绑定设备 telemetry 回写
 *
 * 工业约定:
 *  - 全局采集参数(running/defaultIntervalMs)+ 单节点独立控制(enabled/intervalMs/
 *    阈值/驱动/绑定),REST 为控制面;
 *  - 消费端乱序防御:晚于节点已知 lastAt 的迟到帧丢弃(真实 broker 下常见);
 *  - 驱动故障节点置 offline 并节流广播(error 帧);
 *  - 指标(produced/consumed/dropped/samplesStored)随 daq.controller 帧与 meta 暴露。
 */

import { randomUUID } from 'node:crypto'
import { daqKeyFromRef, daqTemplateByKey, DAQ_DRIVERS, type AepDaqControllerState, type AepDaqReading, type AepDaqNodeChange, type DaqDriverKind, type DaqNodeView, type DriverTestResult } from '../../../../shared/daq-protocol'
import { normalizeDriverKind, resolveDaqDriver, probeDriverAvailability } from './drivers'
import { getDeviceTwinRepo } from '../assets/device-twin.repo'
import { DaqNode } from './daq-node'
import { getDaqNodeRepo } from './daq-node.repo'
import { getTsdb, tsdbReady } from './storage'
import { getDaqQueue } from './bus'
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
  enabled?: boolean
  posX?: number
  posZ?: number
}

type BroadcastFn = (type: string, payload: unknown) => void

/** 驱动故障广播节流(ms) */
const ERR_THROTTLE_MS = 30_000
/** TSDB 批量写窗口(ms):消费端攒批再落盘 */
const TSDB_FLUSH_MS = 500

class DaqController {
  private repo = getDaqNodeRepo()
  private broadcast: BroadcastFn | null = null
  private timer: NodeJS.Timeout | null = null
  /** 每节点上次采样时间戳(epoch ms;驱动周期判定) */
  private lastSampleAt = new Map<string, number>()
  /** 已知样本时间轴(乱序防御;epoch ms) */
  private lastIngestAt = new Map<string, number>()
  private errAt = new Map<string, number>()
  /** TSDB 批量缓冲(consumer 攒批 → 定窗落盘) */
  private tsdbBuffer: Array<{ nodeId: string, tsMs: number, value: number, state: string }> = []
  private tsdbFlushTimer: NodeJS.Timeout | null = null
  private queueInit: Promise<unknown> | null = null
  /** 当前队列的消费退订(rebuild 后重挂) */
  private queueUnsub: (() => void) | null = null
  /** 管线就绪前生产者静默(队列/消费必须先在位) */
  private pipelineReady = false

  running = true
  defaultIntervalMs = 1000
  private producedCount = 0
  private consumedCount = 0
  private storedCount = 0

  // ---------- 生命周期 ----------

  private ensureLoop(): void {
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
    // 生产者扫描周期 250ms(工业惯例:调度分辨率低于最快采样周期一个量级即可)
    this.timer = setInterval(() => void this.sweep(), 250)
    this.timer.unref?.()
  }

  /** 生产者:sweep 到期判定 → 驱动采样 → 发布样本帧到队列 */
  private async sweep(): Promise<void> {
    if (!this.pipelineReady || !this.running || !this.queueInit) return
    await this.queueInit.catch(() => {})
    const now = Date.now()
    const isoAt = new Date(now).toISOString()
    const queue = await getDaqQueue()
    for (const node of this.repo.all()) {
      const due = (this.lastSampleAt.get(node.id) ?? Number.NEGATIVE_INFINITY) + node.effectiveInterval(this.defaultIntervalMs)
      if (!node.enabled || now < due) continue
      try {
        const tpl = daqTemplateByKey(node.templateKey)
        const v = await resolveDaqDriver(node.driver).sample({
          ctx: { nodeId: node.id, now, ageMs: now - Date.parse(node.createdAt || isoAt) },
          config: {
            base: tpl?.base ?? (node.min + node.max) / 2,
            amp: tpl?.amp ?? Math.max((node.max - node.min) * 0.04, 0.001),
            min: node.min,
            max: node.max,
          },
          driverConfig: node.driverConfig,
        })
        this.lastSampleAt.set(node.id, now)
        if (v == null || Number.isNaN(v)) continue
        const env: DaqSampleEnvelope = {
          nodeId: node.id,
          templateRef: node.templateRef,
          value: Number(v.toFixed(node.decimals)),
          state: 'ok', // 健康态由消费端按量程派生(生产者只负责读数)
          at: isoAt,
        }
        queue.publish(env)
        this.producedCount++
      }
      catch (err) {
        // 驱动故障(mock 不应发生;PLC 未接入走这里):置 offline 并节流广播
        node.state = 'offline'
        const lastErr = this.errAt.get(node.id) ?? 0
        if (now - lastErr > ERR_THROTTLE_MS) {
          this.errAt.set(node.id, now)
          this.broadcast?.('error', { code: 'DAQ_DRIVER', message: `[${node.name}] ${err instanceof Error ? err.message : String(err)}` })
        }
      }
    }
  }

  // ---------- 消费者:队列帧 → 存储/广播/回写 ----------

  private onSampleFromQueue(env: DaqSampleEnvelope): void {
    this.consumedCount++
    const node = this.repo.byId(env.nodeId)
    if (!node) return
    const tsMs = Date.parse(env.at)
    // 乱序防御(broker 多投递者场景):迟到帧直接丢弃
    const knownAt = this.lastIngestAt.get(env.nodeId) ?? 0
    if (tsMs && tsMs <= knownAt) return
    this.lastIngestAt.set(env.nodeId, tsMs)

    node.applyReading(env.value, env.at)
    this.broadcast?.('daq.reading', {
      nodeId: node.id,
      templateRef: node.templateRef,
      value: node.value,
      state: node.state,
      at: env.at,
    } satisfies AepDaqReading)
    this.writeBackTelemetry(node)

    // 时序库批量攒写(定窗刷盘;读取侧 query 直接命中库)
    this.tsdbBuffer.push({ nodeId: node.id, tsMs, value: env.value, state: node.state })
    if (!this.tsdbFlushTimer) {
      this.tsdbFlushTimer = setTimeout(() => {
        this.tsdbFlushTimer = null
        void this.flushTsdb()
      }, TSDB_FLUSH_MS)
      this.tsdbFlushTimer.unref?.()
    }
  }

  private async flushTsdb(): Promise<void> {
    if (this.tsdbBuffer.length === 0) return
    const batch = this.tsdbBuffer.splice(0, this.tsdbBuffer.length)
    try {
      await getTsdb().writeSamples(batch)
      this.storedCount += batch.length
    }
    catch (err) {
      console.error('[daq] 时序库写入失败:', err instanceof Error ? err.message : err)
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
      twins.applyTelemetry(node.deviceBindingId, acc)
      this.pendingBackfill.delete(node.deviceBindingId)
    }
    catch {
      // 目标设备已被删除:解绑自身,链路自愈
      node.deviceBindingId = null
      this.emitNodeChanged('updated', node)
    }
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

  controllerState(): AepDaqControllerState & { produced?: number, consumed?: number, dropped?: number, samplesStored?: number } {
    return {
      running: this.running,
      defaultIntervalMs: this.defaultIntervalMs,
      nodesTotal: this.repo.all().length,
      nodesOnline: this.onlineCount(),
      produced: this.producedCount,
      consumed: this.consumedCount,
      dropped: Math.max(0, this.producedCount - this.consumedCount),
      samplesStored: this.storedCount,
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

  configure(opts: { defaultIntervalMs?: number }): AepDaqControllerState {
    if (typeof opts.defaultIntervalMs === 'number' && opts.defaultIntervalMs >= 120) {
      this.defaultIntervalMs = Math.min(60_000, Math.round(opts.defaultIntervalMs))
      this.lastSampleAt.clear() // 周期变更即刻生效
    }
    this.emitController()
    return this.controllerState()
  }

  // ---------- 节点 CRUD(单点控制入口)----------

  create(input: DaqCreateInput): DaqNode {
    this.ensureLoop()
    const tpl = input.templateRef ? daqTemplateByKey(daqKeyFromRef(input.templateRef)) : undefined
    if (input.templateRef && !tpl) {
      throw Object.assign(new Error(`未知数采模板: ${input.templateRef}`), { status: 404 })
    }
    const seq = this.repo.all().filter(n => n.templateKey === (input.templateRef ? daqKeyFromRef(input.templateRef) : '')).length + 1
    const node = new DaqNode({
      id: `dn-${randomUUID().slice(0, 8)}`,
      templateRef: input.templateRef ?? '',
      name: input.name ?? (tpl ? `${tpl.name} ${String(seq).padStart(2, '0')}` : (input.driver && input.driver !== 'mock' ? `${input.driver.toUpperCase()} 通道` : undefined)),
      driver: input.driver ? normalizeDriverKind(input.driver) : undefined,
      driverConfig: input.driverConfig ?? {},
      enabled: input.enabled,
      intervalMs: input.intervalMs ?? null,
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
    if (patch.intervalMs !== undefined) {
      node.intervalMs = patch.intervalMs == null ? null : Math.max(120, Math.min(60_000, patch.intervalMs))
      this.lastSampleAt.delete(id)
    }
    if (patch.enabled !== undefined) {
      node.enabled = patch.enabled
      if (!patch.enabled) node.state = 'offline'
      this.lastSampleAt.delete(id)
    }
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
    this.lastSampleAt.delete(id)
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
  }
}

// ---------- 单例(HMR 存活) ----------

const g = globalThis as typeof globalThis & { __daqController?: DaqController, __daqQueueBackend?: string }
let g_queueBackend = 'inproc'

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

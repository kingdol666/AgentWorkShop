/**
 * DaqControllerPush —— 推送式协议(MQTT 等被动订阅)的订阅绑定 / 回收 / 看门狗
 *
 * 与轮询路径的分工:
 *  - 轮询(modbus/opcua/http/mock):sweep 按 intervalMs 调用 runtime.tick → sample()
 *  - 推送(mqtt):本层建立常驻订阅;每条报文经 publishSample → 队列 → runtime.onSample
 *    → 状态派生/告警/打标/入库。**不进入 sweep 轮询**,因此不会把同一条报文
 *    按采样 tick 重复入库,也不会在设备停发后伪造冻值。
 *  - 产线门控与轮询同源:节点所属产线无活动批次时不入库(开线后订阅照常在线,
 *    恢复开跑即刻继续入库,无需重连)。
 */
import { DaqControllerState } from './state'
import type { DaqNode } from '../daq-node'
import type { DaqSampleEnvelope } from '../bus/queue-port'
import type { DaqDriver } from '../drivers'
import { resolveDaqDriver } from '../drivers'
import { getDaqHostPorts } from '../host-ports'
import { MQTT_STALE_DEFAULT_MS } from '../drivers/mqtt'
import { applyTransform, normalizeSignalKind } from '../../../../../shared/daq-protocol'
import { findDaqTemplate } from '../daq-templates'
import { log } from './helpers'

/** 订阅失败后的重试退避(避免 sweep 每 250ms 打一次 broker) */
const PUSH_RETRY_BACKOFF_MS = 5_000

interface PushBinding {
  stop: () => void | Promise<void>
  /** 订阅参数指纹(节点 topic/host/jsonPath 变更 → 重建订阅) */
  fingerprint: string
  startedAt: number
  /** 最近一条报文到达时刻(0 = 尚未收到) */
  lastAt: number
  lastValue: number | null
  /** 当前活动批次 runId(用于识别新一批次开跑) */
  runId: string | null
  /** 本批次是否已把缓存/首条值作为种子入库(未开跑时收到的值在开跑后补种一次) */
  runSeeded: boolean
  /** 故障广播节流 */
  lastWarnAt: number
}

export abstract class DaqControllerPush extends DaqControllerState {
  protected pushBindings = new Map<string, PushBinding>()
  protected pushPending = new Set<string>()
  /** 订阅失败重试时刻(nodeId → epoch ms) */
  protected pushRetryAt = new Map<string, number>()

  /** 样本入队(由 ingest 层实现;push 只负责生产) */
  protected abstract publishSample(env: DaqSampleEnvelope): void
  /** 驱动故障广播(由 ingest 层实现;按节点/运行时节流) */
  protected abstract broadcastDriverError(node: DaqNode, message: string): void

  /** 单节点驱动输入(与 sampleNode 的模板域解析同源) */
  protected pushInputOf(node: DaqNode, now: number) {
    const tpl = findDaqTemplate(node.templateKey)
    return {
      ctx: { nodeId: node.id, now, ageMs: now - Date.parse(node.createdAt || new Date(now).toISOString()) },
      config: {
        base: tpl?.base ?? (node.min + node.max) / 2,
        amp: tpl?.amp ?? Math.max((node.max - node.min) * 0.04, 0.001),
        min: node.min,
        max: node.max,
      },
      driverConfig: node.driverConfig,
      signalKind: normalizeSignalKind(tpl?.signalKind),
      vector: tpl?.vector,
    }
  }

  /** 订阅参数指纹:驱动优先自报(凭据/TLS/主题/QoS),否则按常见字段保守拼接。
   *  指纹计算绝不能抛错 —— 它在 250ms sweep 定时器里执行,异常会被稳定性守卫判 fatal。 */
  private pushFingerprint(node: DaqNode, drv: DaqDriver): string {
    try {
      if (typeof drv.fingerprint === 'function') return drv.fingerprint(node.driverConfig)
    }
    catch (err) {
      return `fingerprint-error:${err instanceof Error ? err.message : String(err)}`
    }
    const c = node.driverConfig ?? {}
    return [node.driver, c.host, c.port, c.topic, c.jsonPath, c.username, c.secure, c.tls].map(v => String(v ?? '')).join('|')
  }

  /** 订阅对账:enabled + 有产线 + 驱动支持 subscribe → 保持一条绑定;否则回收。 */
  syncPushBindings(): void {
    for (const node of this.repo.all()) {
      const drv = resolveDaqDriver(node.driver)
      const want = typeof drv.subscribe === 'function' && node.enabled && Boolean(node.lineId)
      if (!want) {
        if (this.pushBindings.has(node.id)) void this.stopPushBinding(node.id)
        continue
      }
      const existing = this.pushBindings.get(node.id)
      if (existing) {
        // topic/host/凭据/QoS 等订阅参数变更:回收后下一拍按新参数重建
        if (existing.fingerprint !== this.pushFingerprint(node, drv)) void this.stopPushBinding(node.id)
        continue
      }
      if (this.pushPending.has(node.id)) continue
      const retryAt = this.pushRetryAt.get(node.id) ?? 0
      if (retryAt > Date.now()) continue
      this.pushPending.add(node.id)
      void this.startPushBinding(node, drv)
    }
    // 已删除节点的绑定回收
    for (const id of [...this.pushBindings.keys()]) {
      if (!this.repo.byId(id)) void this.stopPushBinding(id)
    }
    for (const id of [...this.pushRetryAt.keys()]) {
      if (!this.repo.byId(id)) this.pushRetryAt.delete(id)
    }
  }

  private async startPushBinding(node: DaqNode, drv: DaqDriver): Promise<void> {
    const nodeId = node.id
    const fingerprint = this.pushFingerprint(node, drv)
    // 先放一个占位绑定再订阅:retained 种子报文可能在 subscribe() 的 SUBACK 之后、
    // Promise 续体之前到达(onPushSample 需要 binding 才入库);占位 stop 在成功后替换。
    const provisional: PushBinding = { stop: () => { /* 订阅尚未建立 */ }, fingerprint, startedAt: Date.now(), lastAt: 0, lastValue: null, runId: null, runSeeded: false, lastWarnAt: 0 }
    this.pushBindings.set(nodeId, provisional)
    try {
      const stop = await drv.subscribe!({
        ...this.pushInputOf(node, Date.now()),
        onSample: sample => this.onPushSample(nodeId, sample.value, sample.atMs),
        onError: err => this.onPushError(nodeId, err),
      })
      provisional.stop = stop
      const live = this.repo.byId(nodeId)
      // 建连期间节点可能被停用/删除/换线/换 topic,或网关被停止:立刻回收,不留孤儿订阅。
      // 也必须确认 map 里仍是本次占位(期间可能已被 stop 并被新一轮 sweep 替换)。
      if (this.pushBindings.get(nodeId) !== provisional
        || !live || !live.enabled || !live.lineId || !this.running
        || this.pushFingerprint(live, resolveDaqDriver(live.driver)) !== fingerprint) {
        if (this.pushBindings.get(nodeId) === provisional) this.pushBindings.delete(nodeId)
        try {
          await stop()
        }
        catch { /* 已停 */ }
        return
      }
      this.pushRetryAt.delete(nodeId)
      live.lastError = null
      log.info(`[daq-push] ${live.name}(${nodeId}) ${live.driver} 被动订阅已建立`)
    }
    catch (err) {
      this.pushBindings.delete(nodeId)
      const msg = err instanceof Error ? err.message : String(err)
      const live = this.repo.byId(nodeId)
      if (live && this.running) {
        live.lastError = `被动订阅建立失败:${msg}`
        if (live.state !== 'alarm') live.state = 'offline'
        const now = Date.now()
        if (now - (this.pushRetryAt.get(nodeId) ?? 0) > 30_000) {
          this.broadcastDriverError(live, `被动订阅建立失败:${msg}`)
        }
      }
      if (this.running) this.pushRetryAt.set(nodeId, Date.now() + PUSH_RETRY_BACKOFF_MS)
      log.warn(`[daq-push] ${node.name}(${nodeId}) 订阅失败(5s 后重试): ${msg}`)
    }
    finally {
      this.pushPending.delete(nodeId)
    }
  }

  private async stopPushBinding(nodeId: string): Promise<void> {
    const b = this.pushBindings.get(nodeId)
    this.pushBindings.delete(nodeId)
    this.pushPending.delete(nodeId)
    this.pushRetryAt.delete(nodeId)
    if (!b) return
    try {
      await b.stop()
    }
    catch { /* 已停 */ }
  }

  /** 停止全部订阅(网关停止/进程退出) */
  async stopAllPushBindings(): Promise<void> {
    const ids = [...this.pushBindings.keys()]
    await Promise.all(ids.map(id => this.stopPushBinding(id)))
  }

  /** 报文回调:解析成功 + 网关运行 + 产线在跑 → 入队(时间戳=到达时刻,单调递增)。
   *  未开跑时缓存最近值(不止丢弃):retained-only 设备在停线期间只收到一条状态,
   *  开跑后由 checkPushLiveness 补种一次,否则整批没有初始值。 */
  private onPushSample(nodeId: string, value: number, atMs: number): void {
    if (!this.running) return
    const bind = this.pushBindings.get(nodeId)
    if (!bind) return
    bind.lastAt = Math.max(bind.lastAt + 1, atMs)
    bind.lastValue = value
    const node = this.repo.byId(nodeId)
    if (!node || !node.enabled) return
    const host = getDaqHostPorts()
    const run = host?.lineRun.activeRun(node.lineId) ?? null
    // 产线门控:未开跑期间订阅保持在线但不入库;记录当前批次,开跑瞬间补种缓存值
    if (!run) {
      bind.runId = null
      bind.runSeeded = false
      return
    }
    if (bind.runId !== run.runId) {
      bind.runId = run.runId
      bind.runSeeded = false
    }
    // 报文恢复即自愈:清掉停发期写入的 lastError(状态由 runtime.onSample 重新派生)
    if (node.lastError) node.lastError = null
    this.publishPushValue(node, value, bind.lastAt)
    bind.runSeeded = true
  }

  /** 推送值经队列进入统一管线(物理量标定 + 节点精度) */
  private publishPushValue(node: DaqNode, value: number, atMs: number): void {
    const phys = applyTransform(value, node.transform)
    this.publishSample({
      nodeId: node.id,
      templateRef: node.templateRef,
      value: Number(phys.toFixed(node.decimals)),
      state: 'ok',
      at: new Date(atMs).toISOString(),
    })
  }

  /** 订阅期错误:落 lastError(是否 offline 交由陈值看门狗判定,避免瞬时解析错误误判链路)。
   *  报文确实到达但解析失败也算"链路有消息"—— 更新 lastAt,避免 watchdog 误报"未收到报文"。 */
  private onPushError(nodeId: string, err: Error): void {
    if (!this.running) return
    const bind = this.pushBindings.get(nodeId)
    if (bind) bind.lastAt = Math.max(bind.lastAt + 1, Date.now())
    const node = this.repo.byId(nodeId)
    if (!node) return
    node.lastError = `被动订阅报文错误:${err.message}`
    if (bind && Date.now() - bind.lastWarnAt > 30_000) {
      bind.lastWarnAt = Date.now()
      this.broadcastDriverError(node, `被动订阅报文错误:${err.message}`)
    }
  }

  /** 陈值看门狗(sweep 调用):产线在跑但订阅长时间无报文 → offline + 可读 lastError。
   *  不写入任何样本 —— 停发期间库里不该出现"冻值新样本"。 */
  checkPushLiveness(now: number): void {
    const host = getDaqHostPorts()
    if (!host) return
    for (const [nodeId, bind] of this.pushBindings) {
      const node = this.repo.byId(nodeId)
      if (!node || !node.enabled) continue
      const run = host.lineRun.activeRun(node.lineId)
      if (!run) {
        bind.runId = null
        bind.runSeeded = false
        continue
      }
      // 新批次开跑:把停线期间缓存的最近值补种一次(retained-only 设备整批只有这一条状态;
      // 时间戳=消息到达时刻,超过 10 分钟的旧值不补,等新报文)
      if (bind.runId !== run.runId) {
        bind.runId = run.runId
        bind.runSeeded = false
      }
      if (!bind.runSeeded && bind.lastValue != null && (now - bind.lastAt) <= 600_000) {
        this.publishPushValue(node, bind.lastValue, bind.lastAt || now)
        bind.runSeeded = true
        if (node.lastError) node.lastError = null
      }
      const staleMs = Number(node.driverConfig?.staleMs ?? MQTT_STALE_DEFAULT_MS)
      if (!(staleMs > 0)) continue
      const since = bind.lastAt || bind.startedAt
      if (now - since <= staleMs) continue
      const msg = bind.lastAt
        ? `MQTT 被动订阅:${Math.round((now - bind.lastAt) / 1000)}s 未收到报文(设备停发/主题无发布/网络分区),节点置 offline(停发期间不写样本)`
        : `MQTT 被动订阅:订阅后 ${Math.round((now - bind.startedAt) / 1000)}s 未收到首条报文(检查 broker/主题/设备发布)`
      node.state = 'offline'
      node.lastError = msg
      if (now - bind.lastWarnAt > 30_000) {
        bind.lastWarnAt = now
        this.broadcastDriverError(node, msg)
      }
    }
  }
}

/**
 * DaqControllerViews —— 视图投影 / 状态与广播装配 / 队列重挂
 * (拆分层,承 DaqControllerTsdbTwin;方法体与原文件逐行一致)
 */
import { DaqControllerTsdbTwin } from './tsdb-twin'
import type { AepDaqControllerState, AepDaqNodeChange, DaqNodeView } from '../../../../../shared/daq-protocol'
import type { BroadcastFn } from './types'
import type { DaqNode } from '../daq-node'
import { g_queueLost } from './helpers'
import { getDaqQueue } from '../bus'
import { getTsdb, tsdbReady } from '../storage'

export abstract class DaqControllerViews extends DaqControllerTsdbTwin {
  protected emitNodeChanged(op: AepDaqNodeChange['op'], node: DaqNode | null): void {
    const payload: AepDaqNodeChange = { op, node: node ? node.toView() : null }
    this.broadcast?.('daq.node.changed', payload)
  }

  protected emitController(): void {
    this.broadcast?.('daq.controller', this.controllerState())
  }

  /** ws.ts 的 broadcastSceneEvent 在此装配(daq 路由模块加载时调用一次) */
  setBroadcast(fn: BroadcastFn | null): void {
    this.broadcast = fn
  }

  /** minIntervalMs / alarmsRaised / framesStored 都是本方法**实际返回**的字段,但 AepDaqControllerState
   *  未收录(协议类型与实现漂移):minIntervalMs 被前端 useDaqStream 消费,alarmsRaised 被
   *  server/api/metrics.ts 消费(framesStored 供管线指标展示)。这里按实现补齐返回面 —— 见报告。 */
  controllerState(): AepDaqControllerState & { minIntervalMs: number, alarmsRaised: number, framesStored: number, produced?: number, consumed?: number, dropped?: number, samplesStored?: number, tsdbDropped?: number } {
    // 丢弃 = 队列层真实丢弃(inproc 拥塞/mqtt 断连)+ 消费侧乱序迟到帧(诚实可见)
    const queueLost = g_queueLost()
    // 单次遍历(hardening PERF-1):status 高频路径不再对全表多次 all()
    const nodes = this.repo.all()
    return {
      running: this.running,
      defaultIntervalMs: this.defaultIntervalMs,
      minIntervalMs: this.minIntervalMs,
      defaultPublishIntervalMs: this.defaultPublishIntervalMs,
      minPublishIntervalMs: this.minPublishIntervalMs,
      queryDisplayIntervalMs: this.queryDisplayIntervalMs,
      minQueryDisplayIntervalMs: this.minQueryDisplayIntervalMs,
      nodesTotal: nodes.length,
      nodesOnline: this.running ? nodes.filter(n => n.enabled).length : 0,
      produced: this.producedCount,
      consumed: this.consumedCount,
      dropped: Math.max(0, this.producedCount - this.consumedCount) + queueLost + this.lateDropped,
      samplesStored: this.storedCount,
      tsdbDropped: this.tsdbDropped,
      alarmsRaised: this.alarmsRaised,
      framesStored: this.framesStored,
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
}

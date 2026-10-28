/**
 * DaqControllerTsdbTwin —— TSDB 落库 / 孪生遥测回写
 * (拆分层,承 DaqControllerSweepAlarms;方法体与原文件逐行一致)
 */
import { DaqControllerSweepAlarms } from './sweep-alarms'
import type { DaqSampleEnvelope } from '../bus/queue-port'
import type { LruLike } from './types'
import type { DaqNode } from '../daq-node'
import { LruMap } from '@/shared/lru.mjs'
import { TSDB_WRITE_RETRIES, log } from './helpers'
import { findDaqTemplate } from '../daq-templates'
import { getDaqHostPorts } from '../host-ports'
import { getTsdb } from '../storage'
import { getDcwNodeRepo } from '../../dcw/dcw-node.repo'

export abstract class DaqControllerTsdbTwin extends DaqControllerSweepAlarms {
  /** 网关消费泵:队列帧按节点分发回其运行时(乱序防御/状态派生/下发门控在 runtime)。
   *  只校验网关运行态:外部 /ingest 是文档化的入库入口,产线门控由来源侧/路由自身判定,
   *  不能在这里静默丢弃(否则 /ingest 返回 accepted 却没有行)。 */
  protected onSampleFromQueue(env: DaqSampleEnvelope): void {
    this.consumedCount++
    if (!this.running) return
    const rt = this.runtimes.get(env.nodeId)
    if (!rt) return
    if (rt.onSample(env) === 'late') this.lateDropped++
  }

  /** 单 in-flight 写 + 有限重试:写库中攒批继续,失败保留批退避重试,耗尽丢弃并计数 */
  protected async flushTsdb(): Promise<void> {
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
              log.error('[daq] 时序库写入失败(已重试,丢弃计数):', err instanceof Error ? err.message : err)
            }
            else {
              await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
            }
          }
        }
      }
      // 帧批(v2:daq_frames;与样本同窗同重试语义)
      // drainFrames 一次性取走并清空索引 —— 索引与缓冲必须同生命周期,否则查询会命中已刷盘的行
      let pendingFrames = this.drainFrames()
      while (pendingFrames.length > 0) {
        const batch = pendingFrames
        let ok = false
        for (let attempt = 0; attempt < TSDB_WRITE_RETRIES && !ok; attempt++) {
          try {
            await getTsdb().writeFrames(batch)
            this.framesStored += batch.length
            ok = true
          }
          catch (err) {
            if (attempt === TSDB_WRITE_RETRIES - 1) {
              this.tsdbDropped += batch.length
              log.error('[daq] 帧写入失败(已重试,丢弃计数):', err instanceof Error ? err.message : err)
            }
            else {
              await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
            }
          }
        }
        pendingFrames = this.drainFrames()
      }
    }
    finally {
      this.tsdbWriting = false
      // 尾批自愈:flush 期间新样本/帧到达时 schedule 被跳过(tsdbWriting 守卫),
      // 若此处不留 timer,停线后的残余批次将无定时器可触发,驻留内存直至进程重启
      if (this.tsdbBuffer.length > 0 || this.frameBuffer.length > 0) this.scheduleTsdbFlush()
    }
  }

  /** 绑定设备端到端回写:通道值进入 DeviceTwin.telemetry(键名 = 模板 telemetryKey 数据,缺省 templateKey);
   *  状态随行:节点 alarm 派生自用户设置的量程/预警带(数据驱动),透传给孪生而非让孪生按硬编码阈值猜 */
  protected pendingBackfill = new Map<string, Record<string, number | string | boolean>>()

  /** 同绑定 siblings 缓存(1s TTL):回写热路径不再逐样本全量 scan,O(N²)→O(N)/周期。
   *  用有界 LRU 而非「超 500 整体 clear()」——后者会造成周期性全量缓存穿透。 */
  protected siblingsCache: LruLike<string, { at: number, list: DaqNode[] }> = new LruMap(500)

  protected siblingsOf(bindingId: string): DaqNode[] {
    const hit = this.siblingsCache.get(bindingId)
    if (hit && Date.now() - hit.at < 1000) return hit.list
    const list = this.repo.all().filter(n => n.deviceIds.includes(bindingId))
    this.siblingsCache.set(bindingId, { at: Date.now(), list })
    return list
  }

  protected writeBackTelemetry(node: DaqNode): void {
    if (node.deviceIds.length === 0 || node.value == null) return
    const host = getDaqHostPorts()
    if (!host) return // 端口未装配(边缘独立/装配前):不攒积压,直接跳过回写
    const key = findDaqTemplate(node.templateKey)?.telemetryKey ?? node.templateKey
    // 多对多绑定:向每台绑定设备回写通道值;同设备多节点取最严重节点态
    // (alarm > warn > ok/offline),避免"最近写者定态"抖动
    for (const deviceId of node.deviceIds) {
      const siblings = this.siblingsOf(deviceId)
      const worst = siblings.some(n => n.state === 'alarm')
        ? 'alarm'
        : siblings.some(n => n.state === 'warn') ? 'warn' : 'ok'
      const acc = this.pendingBackfill.get(deviceId) ?? {}
      acc[key] = node.value
      this.pendingBackfill.set(deviceId, acc)
      const res = host.telemetry.applyTelemetry(deviceId, acc, worst)
      if (!res.ok) {
        // 目标设备已被删除:从本节点解绑该设备(其余绑定保留),链路自愈
        this.pendingBackfill.delete(deviceId)
        node.deviceIds = node.deviceIds.filter(d => d !== deviceId)
        node.deviceBindingId = node.deviceIds[0] ?? null
        this.repo.flushNow()
        this.emitNodeChanged('updated', node)
        continue
      }
      this.pendingBackfill.delete(deviceId)
      if (res.twinId) this.pushTwinTelemetry(res.twinId)
    }
  }

  /** 遥测 WS 推送(1s/设备节流):孪生状态/遥测事件化直推,前端全量轮询降级为断线兜底 */
  protected twinPushAt = new Map<string, number>()

  /** 孪生绑定节点所属产线(唯一时返回;多线/未绑定 → null,保持全局语义) */
  private twinLineId(twinId: string): string | null {
    try {
      const lines = new Set<string>()
      for (const n of this.repo.all()) {
        if (n.lineId && (n.deviceIds ?? []).includes(twinId)) lines.add(n.lineId)
      }
      for (const n of getDcwNodeRepo().all()) {
        if (n.lineId && (n.deviceIds ?? []).includes(twinId)) lines.add(n.lineId)
      }
      return lines.size === 1 ? [...lines][0]! : null
    }
    catch { return null }
  }

  protected pushTwinTelemetry(twinId: string): void {
    const now = Date.now()
    if (now - (this.twinPushAt.get(twinId) ?? 0) < 1000) return
    this.twinPushAt.set(twinId, now)
    const payload = getDaqHostPorts()?.telemetry.scenePayload(twinId)
    if (payload) {
      // S14:补产线归属,让 scene-events 按 peer 可见集过滤;唯一产线才补,多线保持全局
      const lineId = this.twinLineId(twinId)
      this.broadcast?.('device.updated', lineId ? { ...(payload as object), lineId } : payload)
    }
  }
}

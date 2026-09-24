/**
 * DaqControllerIngest —— 样本与帧的入库、发布、告警评估
 * (拆分层,承 DaqControllerState;方法体与原文件逐行一致)
 */
import { DaqControllerState } from './state'
import type { AepDaqFrame, AepDaqReading } from '../../../../../shared/daq-protocol'
import type { DaqSampleEnvelope } from '../bus/queue-port'
import type { DaqNode } from '../daq-node'
import { FRAME_BUFFER_CAP, FRAME_PREVIEW_POINTS, TSDB_BUFFER_CAP, TSDB_FLUSH_MS } from './helpers'
import { emitDaqFrame, emitDaqSample } from '@/server/services/workshop/plugins/host.mjs'
import { findDaqTemplate } from '../daq-templates'
import { getDaqHostPorts } from '../host-ports'
import { getDaqQueue } from '../bus'

export abstract class DaqControllerIngest extends DaqControllerState {
  /** 生产面:样本帧入队 */
  protected publishSample(env: DaqSampleEnvelope): void {
    void getDaqQueue().then(q => q.publish(env)).catch(() => {})
    this.producedCount++
  }

  /** 消费面:样本入网关管线(状态派生已在 runtime 完成)。
   *  allowPublish = 通过该节点 WS 下发节拍门控;入库/遥测回写不受门控(每帧必达)。 */
  /**
   * 活动配方对该节点的数采监控窗口(逐产线:仅本线活动批次的窗口生效)。
   * 不同 Recipe 可设不同窗口 —— 窗口随开跑生效、随停线失效。
   */
  protected recipeDaqWindowFor(node: DaqNode): { min: number | null, max: number | null } | null {
    if (!node.lineId) return null
    const host = getDaqHostPorts()
    if (!host) return null
    const run = host.lineRun.activeRun(node.lineId)
    if (!run) return null
    return host.lineRun.recipeWindow(run.recipeId, node.id)
  }

  protected ingestNode(node: DaqNode, env: DaqSampleEnvelope, allowPublish: boolean): void {
    // 多形态帧(v2):向量/图像走独立帧管线(不入 daq_samples,标量表零污染)
    if (env.frame) {
      this.ingestFrame(node, env, allowPublish)
      return
    }
    // 配方级数采监控窗口的越限判定已前移到运行时 onSample(与量程告警共用边沿语义,
    // 越窗即 raise 落库 + 广播);此处 state 已含窗口结论,仅负责管线汇聚。
    if (allowPublish) {
      const reading = {
        nodeId: node.id,
        templateRef: node.templateRef,
        value: node.value ?? env.value,
        state: node.state,
        at: env.at,
        lineId: node.lineId ?? null,
      } satisfies AepDaqReading
      this.broadcast?.('daq.reading', reading)
      // 插件钩子:下发级采样观察(与 WS daq.reading 同点同节拍;宿主未装载时零开销 no-op)
      emitDaqSample(reading)
    }
    this.writeBackTelemetry(node)

    // 时序库批量攒写(定窗刷盘;上限背压:满丢最旧并计数)
    // 产线批次打标:活动 LineRun 窗口内每条样本携带 product/recipe/run id(产品级数据隔离)
    const tsMs = Date.parse(env.at)
    const lineRun = getDaqHostPorts()?.lineRun.activeRun(node.lineId) ?? null
    if (lineRun) getDaqHostPorts()?.lineRun.bumpTaggedSamples(node.lineId)
    this.tsdbBuffer.push({
      nodeId: node.id,
      tsMs,
      value: env.value,
      state: node.state,
      lineId: lineRun?.lineId ?? null,
      productId: lineRun?.productId ?? null,
      recipeId: lineRun?.recipeId ?? null,
      runId: lineRun?.runId ?? null,
    })
    if (this.tsdbBuffer.length > TSDB_BUFFER_CAP) {
      this.tsdbBuffer.splice(0, this.tsdbBuffer.length - TSDB_BUFFER_CAP)
      this.tsdbDropped += 1
    }
    this.scheduleTsdbFlush()
  }

  /** 刷盘调度(样本与帧共用同一定窗;写库中不重复排程) */
  protected scheduleTsdbFlush(): void {
    if (!this.tsdbFlushTimer && !this.tsdbWriting) {
      this.tsdbFlushTimer = setTimeout(() => {
        this.tsdbFlushTimer = null
        void this.flushTsdb()
      }, TSDB_FLUSH_MS)
      this.tsdbFlushTimer.unref?.()
    }
  }

  protected broadcastDriverError(node: DaqNode, message: string): void {
    this.broadcast?.('error', { code: 'DAQ_DRIVER', message: `[${node.name}] ${message}` })
  }

  // ---------- 帧管线(v2:向量/图像;打标与告警复用标量链路同源机制)----------

  /** 帧消费:元数据攒批落 daq_frames + 指标阈值告警(边沿)+ WS daq.frame(预览/缩略图引用) */
  protected ingestFrame(node: DaqNode, env: DaqSampleEnvelope, allowPublish: boolean): void {
    const f = env.frame!
    const tpl = findDaqTemplate(node.templateKey)
    const tsMs = Date.parse(env.at)
    // 产线批次打标(与标量样本同源取值)
    const lineRun = getDaqHostPorts()?.lineRun.activeRun(node.lineId) ?? null
    if (lineRun) getDaqHostPorts()?.lineRun.bumpTaggedSamples(node.lineId)
    const metrics = f.metrics ?? {}
    this.pushFrame({
      nodeId: node.id,
      tsMs,
      kind: f.kind,
      templateKey: node.templateKey,
      deviceBindingId: node.deviceBindingId,
      lineId: lineRun?.lineId ?? null,
      productId: lineRun?.productId ?? null,
      recipeId: lineRun?.recipeId ?? null,
      runId: lineRun?.runId ?? null,
      points: f.kind === 'vector' ? (f.points?.length ?? 0) : 0,
      meta: f.kind === 'image'
        ? { objectKey: f.objectKey, thumbKey: f.thumbKey, mime: f.mime, width: f.width, height: f.height }
        : { points: f.points ?? [] },
      metrics,
    })
    if (this.frameBuffer.length > FRAME_BUFFER_CAP) {
      if (this.evictFrames(FRAME_BUFFER_CAP) > 0) this.tsdbDropped += 1
    }
    this.scheduleTsdbFlush()
    // 指标阈值告警(模板 metrics 规则;alarm 硬限边沿 → 既有告警链路)
    this.evaluateMetricAlarms(node, tpl, metrics)
    if (!allowPublish) return
    // lineId 是 WS 逐产线扇出的依据(scene-events.payloadLineId 读的就是 payload.lineId,
    // 与 AepDaqReading.lineId 同义);AepDaqFrame 协议类型漏了该字段 —— 见报告。
    const payload: AepDaqFrame & { lineId: string | null } = {
      nodeId: node.id,
      templateRef: node.templateRef,
      kind: f.kind,
      at: env.at,
      lineId: node.lineId ?? null,
      preview: f.kind === 'vector' ? DaqControllerIngest.previewOf(f.points ?? [], FRAME_PREVIEW_POINTS) : undefined,
      metrics,
      thumbUrl: f.kind === 'image' && f.objectKey
        ? `/api/workshop/daq/${node.id}/frames/content?ts=${tsMs}&thumb=1`
        : undefined,
      state: node.state,
    }
    this.broadcast?.('daq.frame', payload)
    // 插件钩子:帧观察(只含元数据/指标/预览,不含 blob —— 防插件侧内存放大)
    emitDaqFrame(payload)
  }

  /** 模板 metrics 规则评估:alarm 硬限沿 → handleAlarm/handleAlarmRecover;warn 只置节点态 */
  protected evaluateMetricAlarms(node: DaqNode, tpl: ReturnType<typeof findDaqTemplate>, metrics: Record<string, number>): void {
    for (const rule of tpl?.metrics ?? []) {
      const v = metrics[rule.key]
      if (v == null || !Number.isFinite(v)) continue
      const key = `${node.id}::${rule.key}`
      const prev = this.metricStates.get(key) ?? 'ok'
      let level: 'ok' | 'warn' | 'alarm' = 'ok'
      if ((rule.alarmLow != null && v < rule.alarmLow) || (rule.alarmHigh != null && v > rule.alarmHigh)) level = 'alarm'
      else if ((rule.warnLow != null && v < rule.warnLow) || (rule.warnHigh != null && v > rule.warnHigh)) level = 'warn'
      this.metricStates.set(key, level)
      if (level === 'alarm' && prev !== 'alarm') {
        const gtMax = rule.alarmHigh != null && v > rule.alarmHigh
        node.state = 'alarm'
        this.handleAlarm(node, v, gtMax ? 'gt-max' : 'lt-min', gtMax ? rule.alarmHigh! : rule.alarmLow!, `${node.templateKey}.${rule.key}`)
      }
      else if (level !== 'alarm' && prev === 'alarm') {
        node.state = level === 'warn' ? 'warn' : 'ok'
        this.handleAlarmRecover(node, v)
      }
      else if (level === 'warn' && node.state === 'ok') {
        node.state = 'warn'
      }
      else if (level === 'ok' && prev !== 'ok' && node.state !== 'alarm') {
        node.state = 'ok'
      }
    }
  }

  /** WS 帧预览:均匀抽点 ≤max(线性抽点,保形) */
  protected static previewOf(points: number[], max: number): number[] {
    if (points.length <= max) return points
    const out: number[] = []
    for (let i = 0; i < max; i++) {
      out.push(points[Math.floor((i * (points.length - 1)) / (max - 1))]!)
    }
    return out
  }
}

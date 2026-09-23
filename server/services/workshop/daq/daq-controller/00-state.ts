/**
 * DaqControllerLayer00 —— 字段 / 采样循环 / 运行时设置 / 单节点采样
 * (分层 1/9,承 DaqControllerContracts;方法体与原文件逐行一致)
 */
import { DaqControllerContracts } from './contracts'
import type { BroadcastFn } from './types'
import type { DaqFrameRow } from '../storage/tsdb-port'
import type { DaqFrameSample } from '../drivers'
import type { DaqFrameWorking } from '../frames'
import type { DaqSampleEnvelope } from '../bus/queue-port'
import type { DaqNode } from '../daq-node'
import type { DaqNodeRuntime } from '../daq-runtime'
import { daqObjectKey } from '../objectstore/objectstore-port'
import { daqRuntimeSettings } from '../../settings'
import { findDaqTemplate } from '../daq-templates'
import { getDaqNodeRepo } from '../daq-node.repo'
import { getDaqQueue } from '../bus'
import { getObjectStore } from '../objectstore'
import { getSystemConfigService } from '../../../system-config'
import { log } from './helpers'
import { normalizeSignalKind } from '../../../../../shared/daq-protocol'
import { resolveDaqDriver } from '../drivers'
import { runSinkPipeline } from '../frames'

export abstract class DaqControllerLayer00 extends DaqControllerContracts {
  protected repo = getDaqNodeRepo()
  protected broadcast: BroadcastFn | null = null
  protected timer: NodeJS.Timeout | null = null
  /** 边缘运行时注册表(节点 id → 独立运行时;网关统一管理生命周期) */
  protected runtimes = new Map<string, DaqNodeRuntime>()
  /** TSDB 批量缓冲(consumer 攒批 → 定窗刷盘;上限背压,满丢最旧;产线窗口内逐样本打标) */
  protected tsdbBuffer: Array<{ nodeId: string, tsMs: number, value: number, state: string, lineId?: string | null, productId?: string | null, recipeId?: string | null, runId?: string | null }> = []
  /** 帧攒批缓冲(v2:向量/图像元数据;与样本同窗刷盘) */
  protected frameBuffer: DaqFrameRow[] = []
  /** 帧指标告警态(nodeId::metricKey → ok/warn/alarm;边沿触发) */
  protected metricStates = new Map<string, 'ok' | 'warn' | 'alarm'>()
  protected tsdbFlushTimer: NodeJS.Timeout | null = null
  /** 单 in-flight 写:写库中不叠写(promise 链串行化) */
  protected tsdbWriting = false
  /** 消费侧真实丢弃计数:乱序迟到帧 */
  protected lateDropped = 0
  /** 写库侧丢弃计数(重试耗尽/缓冲溢出) */
  protected tsdbDropped = 0
  protected queueInit: Promise<unknown> | null = null
  /** 当前队列的消费退订(rebuild 后重挂) */
  protected queueUnsub: (() => void) | null = null
  /** 在飞采样数(sweep 并发闸门;防同拍 N 节点齐发打爆驱动连接) */
  protected samplingInFlight = 0
  /** 管线就绪前生产者静默(队列/消费必须先在位) */
  protected pipelineReady = false
  /** 配置同步/订阅状态(daq.sampling live 配置 → 网关节拍;仅挂一次) */
  protected settingsSynced = false
  protected settingsUnsub: (() => void) | null = null

  running = true
  /** 全局缺省采集间隔(节点 intervalMs=null 跟随;来源 = daq.sampling 配置,live 可调) */
  defaultIntervalMs = 5000
  /** 采样节拍下限(create/patch/存量收敛统一钳制;来源 = daq.sampling.minIntervalMs) */
  minIntervalMs = 1000
  /** 全局缺省 WS 下发间隔(节点 publishIntervalMs=null 跟随;0 = 随采样节拍) */
  defaultPublishIntervalMs = 1000
  /** WS 下发节拍下限(create/patch 钳制;来源 = daq.publish.minIntervalMs,0=允许每帧) */
  minPublishIntervalMs = 0
  /** 前端趋势图自动拉取(时序库查询+重绘)间隔默认值(来源 = daq.query.displayIntervalMs) */
  queryDisplayIntervalMs = 5000
  /** 前端趋势图刷新间隔下限(来源 = daq.query.minDisplayIntervalMs,前端钳制) */
  minQueryDisplayIntervalMs = 500
  /** sweep 轮转游标(派发额度有限时保证全表轮转,避免表尾节点饿死) */
  protected sweepCursor = 0
  protected producedCount = 0
  protected consumedCount = 0
  protected storedCount = 0
  /** 帧入库计数(v2:daq_frames 行数) */
  protected framesStored = 0

  // ---------- 生命周期 ----------

  protected ensureLoop(): void {
    this.applyRuntimeSettings()
    this.syncRuntimes()
    if (!this.queueInit) {
      this.queueInit = (async () => {
        const queue = await getDaqQueue()
        this.queueUnsub?.()
        this.queueUnsub = queue.consume(env => this.onSampleFromQueue(env))
        await queue.init()
        this.pipelineReady = true
      })()
      this.queueInit.catch(err => log.error('[daq] 管线初始化失败:', err instanceof Error ? err.message : err))
    }
    if (this.timer) return
    // 网关扫描周期 250ms(统一调度;节拍判定/互斥在各运行时内部自治)
    this.timer = setInterval(() => this.sweep(), 250)
    this.timer.unref?.()
  }

  // ---------- 网关服务面(runtime host 实现;运行时只依赖此接口) ----------

  /** 从运行时设置(daq.sampling.* / daq.publish.* / daq.query.* )同步三个独立节拍:
   *  采集周期(publish 与 sampling 解耦)、WS 下发间隔、趋势图拉取间隔,以及各自下限。
   *  live 配置链:config.yml < runtime-settings.json < 环境变量 < 设置页/CLI;
   *  设置变更经 system-config 订阅即时回流到这里(热重载,无需重启)。 */
  applyRuntimeSettings(): void {
    if (!this.settingsSynced) {
      this.settingsSynced = true
      try {
        this.settingsUnsub = getSystemConfigService().subscribe(() => this.applyRuntimeSettings())
      }
      catch { /* 设置系统不可用(单测) → 用字段默认值 */ }
    }
    const before = `${this.defaultIntervalMs}|${this.minIntervalMs}|${this.defaultPublishIntervalMs}|${this.minPublishIntervalMs}|${this.queryDisplayIntervalMs}|${this.minQueryDisplayIntervalMs}`
    try {
      const s = daqRuntimeSettings()
      // 三组节拍统一「下限优先」:缺省低于下限时抬到下限(下限被配置成下限才成立),
      // 三组各自独立——改一组的下限不影响另一组的缺省,反之亦然。
      if (Number.isFinite(s.sampling.minIntervalMs) && s.sampling.minIntervalMs > 0) this.minIntervalMs = Math.max(100, Math.min(60_000, s.sampling.minIntervalMs))
      if (Number.isFinite(s.sampling.defaultIntervalMs) && s.sampling.defaultIntervalMs > 0) {
        this.defaultIntervalMs = Math.max(this.minIntervalMs, Math.min(60_000, s.sampling.defaultIntervalMs))
      }
      // WS 下发节拍:与采集间隔解耦的独立缺省/下限(live 可调)
      if (Number.isFinite(s.publish.minIntervalMs) && s.publish.minIntervalMs >= 0) this.minPublishIntervalMs = Math.min(60_000, s.publish.minIntervalMs)
      if (Number.isFinite(s.publish.defaultIntervalMs) && s.publish.defaultIntervalMs >= 0) {
        this.defaultPublishIntervalMs = Math.max(this.minPublishIntervalMs, Math.min(60_000, s.publish.defaultIntervalMs))
      }
      // 趋势图刷新节拍(仅下发前端;服务端不参与调度)
      if (Number.isFinite(s.query.minDisplayIntervalMs) && s.query.minDisplayIntervalMs > 0) this.minQueryDisplayIntervalMs = Math.max(100, s.query.minDisplayIntervalMs)
      if (Number.isFinite(s.query.displayIntervalMs) && s.query.displayIntervalMs > 0) {
        this.queryDisplayIntervalMs = Math.max(this.minQueryDisplayIntervalMs, Math.min(600_000, s.query.displayIntervalMs))
      }
    }
    catch { /* settings 未就绪 → 保持当前值 */ }
    // 节拍变化经 daq.controller 帧回流前端(前端据此重排「趋势图刷新/WS 展示」节拍)
    if (`${this.defaultIntervalMs}|${this.minIntervalMs}|${this.defaultPublishIntervalMs}|${this.minPublishIntervalMs}|${this.queryDisplayIntervalMs}|${this.minQueryDisplayIntervalMs}` !== before) {
      this.emitController()
    }
  }

  protected runtimeDefaults(): { intervalMs: number, publishIntervalMs: number, minIntervalMs: number } {
    return { intervalMs: this.defaultIntervalMs, publishIntervalMs: this.defaultPublishIntervalMs, minIntervalMs: this.minIntervalMs }
  }

  /** 生产面:驱动采样一次(模板域 + 协议参数解析;mock/PLC 统一走驱动注册表)。
   *  多形态模板(vector/image)在采样后执行 sink 下沉管线;图像 blob 就地落
   *  对象存储(blob 不进队列 —— MQTT 256KB 上限不可承载像素,队列只传引用)。 */
  protected async sampleNode(node: DaqNode, now: number): Promise<number | DaqFrameSample | { frame: NonNullable<DaqSampleEnvelope['frame']> } | null> {
    const tpl = findDaqTemplate(node.templateKey)
    const signalKind = normalizeSignalKind(tpl?.signalKind)
    const res = await resolveDaqDriver(node.driver).sample({
      ctx: { nodeId: node.id, now, ageMs: now - Date.parse(node.createdAt || new Date(now).toISOString()) },
      config: {
        base: tpl?.base ?? (node.min + node.max) / 2,
        amp: tpl?.amp ?? Math.max((node.max - node.min) * 0.04, 0.001),
        min: node.min,
        max: node.max,
      },
      driverConfig: node.driverConfig,
      signalKind,
      vector: tpl?.vector,
    })
    if (res == null || typeof res !== 'object' || !('frame' in res) || res.frame == null) return res
    // 下沉管线(生产侧;单步失败保留原帧,永不抛出 —— 见 frames.ts runSinkPipeline)
    const raw = res.frame
    // 契约守卫:帧联合只有 vector/image;驱动返回未知 kind(如误包 scalar)直接丢帧,
    // 绝不蒙成 image 走 blob 管线(会在 sink 派生处炸出 undefined.length)
    if (raw.kind !== 'vector' && raw.kind !== 'image') return null
    let wf: DaqFrameWorking = raw.kind === 'vector'
      ? { kind: 'vector', points: raw.points, metrics: raw.metrics }
      : { kind: 'image', blob: raw.blob, mime: raw.mime, width: raw.width, height: raw.height, metrics: raw.metrics }
    wf = runSinkPipeline(wf, tpl?.sink?.processors, node.id)
    if (wf.kind === 'vector') {
      return { frame: { kind: 'vector', points: (wf.points ?? []).slice(0, 4096), metrics: wf.metrics } }
    }
    // 图像:主图 + 缩略图落对象存储(失败抛出 → tick 按驱动故障节流,采集不中断)
    const os = getObjectStore()
    const objectKey = daqObjectKey(node.id, now, '.png')
    await os.put(objectKey, wf.blob!, wf.mime ?? 'image/png')
    let thumbKey: string | undefined
    if (wf.thumbBlob) {
      thumbKey = daqObjectKey(node.id, now, '.thumb.png')
      await os.put(thumbKey, wf.thumbBlob, 'image/png')
    }
    return {
      frame: {
        kind: 'image',
        objectKey,
        thumbKey,
        mime: wf.mime ?? 'image/png',
        width: wf.width,
        height: wf.height,
        metrics: wf.metrics,
      },
    }
  }
}

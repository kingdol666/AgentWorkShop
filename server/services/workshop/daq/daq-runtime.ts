/**
 * DaqNodeRuntime —— 单节点边缘运行时(每个数采节点独立实例化,元数据驱动)。
 *
 * 概念模型:节点 = 边缘计算节点,控制器(DaqController)= 总体网关。
 * 运行时持有该节点全部私有节拍状态(采样时点/下发时点/乱序游标/故障节流/在飞互斥),
 * 由节点元数据驱动:
 *   - intervalMs        采集入库节拍(null = 跟随网关缺省;每个采样必入库)
 *   - publishIntervalMs WS 实时下发节拍(null = 跟随网关缺省;0 = 每帧随采样)
 * 节拍状态独立 → 单节点慢驱动/停用/重配不波及邻居;网关只做统一调度与管线汇聚。
 */

import { applyTransform } from '../../../../shared/daq-protocol'
import type { DaqNode } from './daq-node'
import type { DaqSampleEnvelope } from './bus/queue-port'

/** 驱动故障广播节流(ms;每运行时独立计时) */
const ERR_THROTTLE_MS = 30_000

/** WS 下发间隔上限(与采样周期同界,防误配) */
export const PUBLISH_INTERVAL_MAX = 60_000

/** 网关注入的服务面(运行时只依赖此接口;管线汇聚在网关侧) */
export interface DaqRuntimeHost {
  /** 网关全局缺省(节点元数据为 null 时回退) */
  defaults(): { intervalMs: number, publishIntervalMs: number }
  /** 生产面:驱动采样一次(网关实现协议解析与模板域) */
  sample(node: DaqNode, now: number): Promise<number | null>
  /** 生产面:样本帧入队 */
  publishSample(env: DaqSampleEnvelope): void
  /**
   * 消费面:样本入网关管线(状态派生已完成)。
   * allowPublish = 本帧通过该节点的 WS 下发节拍门控(入库/回写不受门控,每帧必达)。
   */
  ingest(node: DaqNode, env: DaqSampleEnvelope, allowPublish: boolean): void
  /** 驱动故障告警(网关节流广播) */
  broadcastError(node: DaqNode, message: string): void
  /** S5:越限进入 alarm(带触发量与越限方向) */
  onAlarm?(node: DaqNode, value: number, rule: 'lt-min' | 'gt-max', threshold: number): void
  /** S5:alarm 恢复(回到限内;报警仍待人工 ack) */
  onAlarmRecover?(node: DaqNode, value: number): void
  /** 活动配方对该节点的数采监控窗口(null = 无活动批次/未设窗口;越窗视同 alarm) */
  recipeWindowFor?(node: DaqNode): { min: number | null, max: number | null } | null
}

/** onSample 结果(网关据此计指标) */
export type ConsumeVerdict = 'late' | 'ok' | 'unknown-node'

export class DaqNodeRuntime {
  /** 采样时点(epoch ms;-Inf = 立即到期) */
  private lastSampleAt = Number.NEGATIVE_INFINITY
  /** WS 下发时点(0 = 立即可发) */
  private lastPublishAt = 0
  /** 已消费样本时间轴(乱序防御游标) */
  private lastIngestAt = 0
  /** 上次故障广播时刻 */
  private errAt = 0
  /** 采样在飞互斥(本节点串行;慢驱动不叠采也不阻塞邻居) */
  private sampling = false

  constructor(
    /** 绑定的领域节点(元数据权威:enabled/intervalMs/publishIntervalMs/decimals 等) */
    public readonly node: DaqNode,
    private readonly host: DaqRuntimeHost,
  ) {}

  /** 元数据变更/网关重配后重置节拍(变化即刻生效,不等旧周期到期) */
  rearm(): void {
    this.lastSampleAt = Number.NEGATIVE_INFINITY
    this.lastPublishAt = 0
    this.lastIngestAt = 0
  }

  /** 仅重置下发游标(全局下发间隔变更时,让新缺省立刻可观测) */
  republish(): void {
    this.lastPublishAt = 0
  }

  /**
   * 生产面 tick(网关 250ms 扫描驱动):到期判定 → 驱动采样 → 样本入队。
   * 到期/互斥/启停判定基于本运行时私有状态;lastSampleAt 取采样完成时刻(慢驱动周期顺延)。
   */
  async tick(now: number): Promise<void> {
    const node = this.node
    if (this.sampling || !node.enabled) return
    if (now < this.lastSampleAt + node.effectiveInterval(this.host.defaults().intervalMs)) return
    this.sampling = true
    try {
      let v: number | null = null
      try {
        v = await this.host.sample(node, now)
      }
      finally {
        // 采样完成时刻入账:采样耗时计入周期,慢驱动自然降频
        this.lastSampleAt = Date.now()
      }
      if (v == null || Number.isNaN(v)) return
      // 数据语义标定钩子(decoder):PLC 采集值 → 真实物理参数。
      // 状态派生/入库/WS 下发全部使用物理值(节点元数据 transform 驱动)。
      const phys = applyTransform(v, node.transform)
      this.host.publishSample({
        nodeId: node.id,
        templateRef: node.templateRef,
        value: Number(phys.toFixed(node.decimals)),
        state: 'ok', // 健康态由消费端按量程派生(生产者只负责读数)
        at: new Date(now).toISOString(),
      })
    }
    catch (err) {
      // 驱动故障(mock 不应发生;PLC 未接入走这里):置 offline + 独立节流广播
      node.state = 'offline'
      if (now - this.errAt > ERR_THROTTLE_MS) {
        this.errAt = now
        this.host.broadcastError(node, err instanceof Error ? err.message : String(err))
      }
    }
    finally {
      this.sampling = false // 互斥复位(成功/失败都要,否则节点采样一次即停)
    }
  }

  /**
   * 消费面:队列样本 → 乱序防御 → 状态派生 → WS 下发节拍门控 → 交网关管线。
   * 入库与遥测回写不受门控(每帧必达);仅实时展示按 publishIntervalMs 限频。
   */
  onSample(env: DaqSampleEnvelope): ConsumeVerdict {
    const node = this.node
    const tsMs = Date.parse(env.at)
    // 乱序防御(broker 多投递者场景):迟到帧直接丢弃
    if (tsMs && tsMs <= this.lastIngestAt) return 'late'
    this.lastIngestAt = tsMs

    // S5:alarm 进入/恢复沿(边沿触发,非每帧;恢复不自动 ack,仍待人工确认)
    // 配方监控窗口(活动批次)在派生后叠加:越窗视同 alarm,沿语义与量程告警一致
    const prevState = node.state
    node.applyReading(env.value, env.at)
    const rw = this.host.recipeWindowFor?.(node) ?? null
    if (rw && node.state !== 'alarm') {
      if ((rw.min != null && env.value < rw.min) || (rw.max != null && env.value > rw.max))
        node.state = 'alarm'
    }
    if (node.state === 'alarm' && prevState !== 'alarm') {
      let rule: 'lt-min' | 'gt-max' = 'gt-max'
      let threshold = node.max
      if (rw && rw.max != null && env.value > rw.max) {
        rule = 'gt-max'
        threshold = rw.max
      }
      else if (rw && rw.min != null && env.value < rw.min) {
        rule = 'lt-min'
        threshold = rw.min
      }
      else if (env.value < node.min) {
        rule = 'lt-min'
        threshold = node.min
      }
      this.host.onAlarm?.(node, env.value, rule, threshold)
    }
    else if (node.state !== 'alarm' && prevState === 'alarm') {
      this.host.onAlarmRecover?.(node, env.value)
    }
    const pubMs = Math.max(0, Math.min(PUBLISH_INTERVAL_MAX, node.publishIntervalMs ?? this.host.defaults().publishIntervalMs))
    const now = Date.now()
    const allowPublish = pubMs <= 0 || now - this.lastPublishAt >= pubMs
    if (allowPublish) this.lastPublishAt = now
    this.host.ingest(node, env, allowPublish)
    return 'ok'
  }
}

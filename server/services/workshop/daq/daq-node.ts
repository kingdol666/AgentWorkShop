/**
 * DaqNode —— 数据采集节点领域对象(class 封装)。
 *
 * 一个实例 = 一条物理采集通道:模板域(量程/单位/精度)+ 运行配置(驱动/周期/启停)
 * + 绑定关系(deviceBindingId → DeviceTwin)+ 实时状态(value/state/lastAt)。
 * 序列化经 toRow/fromRow 与持久化仓库对接(daqs.json,对象快照落盘);
 * 采样历史仅驻内存(环形缓冲),不进磁盘快照 —— 磁盘只存"配置 + 最近一次读数"。
 */

import { daqKeyFromRef, type DaqDriverKind, type DaqNodeState, type DaqNodeView, type DataTransform } from '../../../../shared/daq-protocol'
import { findDaqTemplate } from './daq-templates'

/** 采样历史环形缓冲长度(前端趋势图/火花线消费;1s 周期 ≈ 5 分钟窗口) */
export const DAQ_HIST_CAP = 60

interface DaqNodeOptions {
  id: string
  templateRef: string
  name?: string
  driver?: DaqDriverKind
  enabled?: boolean
  intervalMs?: number | null
  /** WS 实时下发间隔(null=跟随全局;0=每帧) */
  publishIntervalMs?: number | null
  unit?: string
  decimals?: number
  min?: number
  max?: number
  warnLow?: number | null
  warnHigh?: number | null
  deviceBindingId?: string | null
  /** 数据语义标定钩子(decoder:采集值 → 物理值) */
  transform?: DataTransform
  posX?: number
  posZ?: number
  /** 所属产线('' = 未分配;采集门控/场景光晕按产线隔离) */
  lineId?: string
  /** 节点级采集语义备注(覆盖模板 semantics;注入 Agent 上下文) */
  semantics?: string
  /** 驱动连接参数(modbus-tcp/opcua 协议参数;mock 空) */
  driverConfig?: Record<string, string | number | boolean>
  createdAt?: string
}

export class DaqNode {
  readonly id: string
  /** 模板引用(daq-<key> 形态;域缺省来源) */
  templateRef: string
  name: string
  driver: DaqDriverKind
  enabled: boolean
  /** null = 跟随 controller 全局周期 */
  intervalMs: number | null
  /** WS 实时下发(消费)间隔;null = 跟随全局,0 = 每帧(随采样节拍) */
  publishIntervalMs: number | null
  unit: string
  decimals: number
  min: number
  max: number
  warnLow: number | null
  warnHigh: number | null
  deviceBindingId: string | null
  driverConfig: Record<string, string | number | boolean>
  transform?: DataTransform
  posX?: number
  posZ?: number
  /** 所属产线('' = 未分配;采集门控/场景光晕按产线隔离) */
  lineId = ''
  /** 节点级采集语义备注(覆盖模板 semantics) */
  semantics?: string
  value: number | null
  state: DaqNodeState = 'offline'
  lastAt: string | null = null
  /** 去抖候选态(连续 3 帧一致才切换;alarm/offline 立即生效,安全优先) */
  private stateCand: DaqNodeState | null = null
  private stateCandN = 0
  readonly createdAt: string

  constructor(o: DaqNodeOptions) {
    const tpl = findDaqTemplate(daqKeyFromRef(o.templateRef))
    this.id = o.id
    this.templateRef = o.templateRef
    this.name = o.name ?? (tpl ? `${tpl.name}` : '数采节点')
    this.driver = o.driver ?? 'mock'
    this.enabled = o.enabled ?? true
    this.intervalMs = o.intervalMs ?? null
    this.publishIntervalMs = o.publishIntervalMs ?? null
    this.unit = o.unit ?? tpl?.unit ?? ''
    this.decimals = o.decimals ?? tpl?.decimals ?? 2
    this.min = o.min ?? tpl?.min ?? 0
    this.max = o.max ?? tpl?.max ?? 100
    // 预警带缺省 = 量程两端各收 8%(越带即 warn,越硬限即 alarm)
    this.warnLow = o.warnLow !== undefined ? o.warnLow : this.min !== undefined && tpl ? +(this.min + (this.max - this.min) * 0.08).toFixed(this.decimals) : null
    this.warnHigh = o.warnHigh !== undefined ? o.warnHigh : tpl ? +(this.max - (this.max - this.min) * 0.08).toFixed(this.decimals) : null
    this.deviceBindingId = o.deviceBindingId ?? null
    this.driverConfig = o.driverConfig ?? {}
    if (o.transform) this.transform = o.transform
    if (o.posX !== undefined) this.posX = o.posX
    if (o.posZ !== undefined) this.posZ = o.posZ
    this.lineId = o.lineId ?? ''
    this.semantics = o.semantics
    this.value = null
    this.createdAt = o.createdAt ?? new Date().toISOString()
  }

  /** 模板 key(`daq-<key>` 中提取;未知模板返回原 ref) */
  get templateKey(): string {
    return daqKeyFromRef(this.templateRef)
  }

  /** 有效采样周期(ms):节点覆盖 > 全局缺省 */
  effectiveInterval(defaultIntervalMs: number): number {
    return Math.max(120, this.intervalMs ?? defaultIntervalMs)
  }

  /** 越限派生:硬限外 = alarm;预警带 2% 滞回(退出需越过内缩边界,防临界抖动)。
   *  注意:滞回依赖当前 state,故仅在 applyReading 的稳态链路中语义正确。 */
  deriveState(v: number): DaqNodeState {
    if (!this.enabled) return 'offline'
    if (v < this.min || v > this.max) return 'alarm'
    const margin = (this.max - this.min) * 0.02
    if (this.state === 'warn') {
      // 已在预警:回到"内缩边界内"才算恢复
      if (this.warnLow != null && v < this.warnLow + margin) return 'warn'
      if (this.warnHigh != null && v > this.warnHigh - margin) return 'warn'
      return 'ok'
    }
    if ((this.warnLow != null && v < this.warnLow) || (this.warnHigh != null && v > this.warnHigh)) return 'warn'
    return 'ok'
  }

  /** 记录一次采样(controller 采样循环调用):去抖 + 滞回后落状态 */
  applyReading(v: number, at: string): void {
    this.value = v
    const raw = this.deriveState(v)
    // alarm/offline 立即切换(安全事件不等去抖);ok↔warn 需连续 3 帧一致
    if (raw === 'alarm' || raw === 'offline' || raw === this.state) {
      this.state = raw
      this.stateCand = null
      this.stateCandN = 0
    }
    else if (raw === this.stateCand) {
      if (++this.stateCandN >= 3) {
        this.state = raw
        this.stateCand = null
        this.stateCandN = 0
      }
    }
    else {
      this.stateCand = raw
      this.stateCandN = 1
    }
    this.lastAt = at
  }

  /**
   * 帧触活(v2 多形态信号):只更新展示值(avg 派生指标)与活跃时点,
   * 不做标量量程状态派生(向量/图像无单点越限语义;帧告警由模板
   * metrics 规则在网关侧边沿判定)。告警态由网关显式置位/恢复。
   */
  touchReading(displayValue: number, at: string): void {
    this.value = Number.isFinite(displayValue) ? displayValue : null
    this.lastAt = at
  }

  /** 对象快照(磁盘形态:配置 + 最近读数;无运行时缓冲) */
  toRow(): Record<string, unknown> {
    return {
      id: this.id,
      templateRef: this.templateRef,
      name: this.name,
      driver: this.driver,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      publishIntervalMs: this.publishIntervalMs,
      unit: this.unit,
      decimals: this.decimals,
      min: this.min,
      max: this.max,
      warnLow: this.warnLow,
      warnHigh: this.warnHigh,
      deviceBindingId: this.deviceBindingId,
      driverConfig: this.driverConfig,
      transform: this.transform,
      posX: this.posX,
      posZ: this.posZ,
      lineId: this.lineId,
      semantics: this.semantics,
      value: this.value,
      state: this.state,
      lastAt: this.lastAt,
      createdAt: this.createdAt,
    }
  }

  static fromRow(row: Record<string, unknown>): DaqNode {
    const node = new DaqNode({
      id: String(row.id),
      templateRef: String(row.templateRef ?? ''),
      name: row.name != null ? String(row.name) : undefined,
      driver: (row.driver as DaqDriverKind) ?? undefined,
      enabled: row.enabled === undefined ? undefined : Boolean(row.enabled),
      intervalMs: row.intervalMs == null ? null : Number(row.intervalMs),
      publishIntervalMs: row.publishIntervalMs == null ? null : Number(row.publishIntervalMs),
      unit: row.unit != null ? String(row.unit) : undefined,
      decimals: row.decimals != null ? Number(row.decimals) : undefined,
      min: row.min != null ? Number(row.min) : undefined,
      max: row.max != null ? Number(row.max) : undefined,
      warnLow: row.warnLow === undefined ? undefined : (row.warnLow == null ? null : Number(row.warnLow)),
      warnHigh: row.warnHigh === undefined ? undefined : (row.warnHigh == null ? null : Number(row.warnHigh)),
      deviceBindingId: row.deviceBindingId === undefined ? undefined : (row.deviceBindingId == null ? null : String(row.deviceBindingId)),
      driverConfig: (row.driverConfig as Record<string, string | number | boolean>) ?? {},
      transform: (row.transform as DataTransform | undefined) ?? undefined,
      posX: row.posX == null ? undefined : Number(row.posX),
      posZ: row.posZ == null ? undefined : Number(row.posZ),
      lineId: row.lineId == null ? '' : String(row.lineId),
      semantics: row.semantics == null ? undefined : String(row.semantics),
      createdAt: row.createdAt != null ? String(row.createdAt) : undefined,
    })
    if (row.value != null && !Number.isNaN(Number(row.value))) {
      node.value = Number(row.value)
      node.state = node.deriveState(node.value)
    }
    if (row.lastAt != null) node.lastAt = String(row.lastAt)
    return node
  }

  /** AEP/REST 投影(view 同构载荷) */
  toView(): DaqNodeView {
    return {
      id: this.id,
      templateRef: this.templateRef,
      name: this.name,
      driver: this.driver,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      publishIntervalMs: this.publishIntervalMs,
      unit: this.unit,
      decimals: this.decimals,
      min: this.min,
      max: this.max,
      warnLow: this.warnLow,
      warnHigh: this.warnHigh,
      deviceBindingId: this.deviceBindingId,
      driverConfig: this.driverConfig,
      transform: this.transform,
      posX: this.posX,
      posZ: this.posZ,
      lineId: this.lineId,
      semantics: this.semantics,
      value: this.value,
      state: this.state,
      lastAt: this.lastAt,
      createdAt: this.createdAt,
    }
  }
}

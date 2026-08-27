/**
 * DaqNode —— 数据采集节点领域对象(class 封装)。
 *
 * 一个实例 = 一条物理采集通道:模板域(量程/单位/精度)+ 运行配置(驱动/周期/启停)
 * + 绑定关系(deviceBindingId → DeviceTwin)+ 实时状态(value/state/lastAt)。
 * 序列化经 toRow/fromRow 与持久化仓库对接(daqs.json,对象快照落盘);
 * 采样历史仅驻内存(环形缓冲),不进磁盘快照 —— 磁盘只存"配置 + 最近一次读数"。
 */

import { daqKeyFromRef, daqTemplateByKey, type DaqDriverKind, type DaqNodeState, type DaqNodeView } from '../../../../shared/daq-protocol'

/** 采样历史环形缓冲长度(前端趋势图/火花线消费;1s 周期 ≈ 5 分钟窗口) */
export const DAQ_HIST_CAP = 60

interface DaqNodeOptions {
  id: string
  templateRef: string
  name?: string
  driver?: DaqDriverKind
  enabled?: boolean
  intervalMs?: number | null
  unit?: string
  decimals?: number
  min?: number
  max?: number
  warnLow?: number | null
  warnHigh?: number | null
  deviceBindingId?: string | null
  posX?: number
  posZ?: number
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
  unit: string
  decimals: number
  min: number
  max: number
  warnLow: number | null
  warnHigh: number | null
  deviceBindingId: string | null
  driverConfig: Record<string, string | number | boolean>
  posX?: number
  posZ?: number
  value: number | null
  state: DaqNodeState = 'offline'
  lastAt: string | null = null
  readonly createdAt: string

  constructor(o: DaqNodeOptions) {
    const tpl = daqTemplateByKey(daqKeyFromRef(o.templateRef))
    this.id = o.id
    this.templateRef = o.templateRef
    this.name = o.name ?? (tpl ? `${tpl.name}` : '数采节点')
    this.driver = o.driver ?? 'mock'
    this.enabled = o.enabled ?? true
    this.intervalMs = o.intervalMs ?? null
    this.unit = o.unit ?? tpl?.unit ?? ''
    this.decimals = o.decimals ?? tpl?.decimals ?? 2
    this.min = o.min ?? tpl?.min ?? 0
    this.max = o.max ?? tpl?.max ?? 100
    // 预警带缺省 = 量程两端各收 8%(越带即 warn,越硬限即 alarm)
    this.warnLow = o.warnLow !== undefined ? o.warnLow : this.min !== undefined && tpl ? +(this.min + (this.max - this.min) * 0.08).toFixed(this.decimals) : null
    this.warnHigh = o.warnHigh !== undefined ? o.warnHigh : tpl ? +(this.max - (this.max - this.min) * 0.08).toFixed(this.decimals) : null
    this.deviceBindingId = o.deviceBindingId ?? null
    this.driverConfig = o.driverConfig ?? {}
    if (o.posX !== undefined) this.posX = o.posX
    if (o.posZ !== undefined) this.posZ = o.posZ
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

  /** 越限派生:硬限外 = alarm,预警带外 = warn */
  deriveState(v: number): DaqNodeState {
    if (!this.enabled) return 'offline'
    if (v < this.min || v > this.max) return 'alarm'
    if ((this.warnLow != null && v < this.warnLow) || (this.warnHigh != null && v > this.warnHigh)) return 'warn'
    return 'ok'
  }

  /** 记录一次采样(controller 采样循环调用) */
  applyReading(v: number, at: string): void {
    this.value = v
    this.state = this.deriveState(v)
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
      unit: this.unit,
      decimals: this.decimals,
      min: this.min,
      max: this.max,
      warnLow: this.warnLow,
      warnHigh: this.warnHigh,
      deviceBindingId: this.deviceBindingId,
      driverConfig: this.driverConfig,
      posX: this.posX,
      posZ: this.posZ,
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
      unit: row.unit != null ? String(row.unit) : undefined,
      decimals: row.decimals != null ? Number(row.decimals) : undefined,
      min: row.min != null ? Number(row.min) : undefined,
      max: row.max != null ? Number(row.max) : undefined,
      warnLow: row.warnLow === undefined ? undefined : (row.warnLow == null ? null : Number(row.warnLow)),
      warnHigh: row.warnHigh === undefined ? undefined : (row.warnHigh == null ? null : Number(row.warnHigh)),
      deviceBindingId: row.deviceBindingId === undefined ? undefined : (row.deviceBindingId == null ? null : String(row.deviceBindingId)),
      driverConfig: (row.driverConfig as Record<string, string | number | boolean>) ?? {},
      posX: row.posX == null ? undefined : Number(row.posX),
      posZ: row.posZ == null ? undefined : Number(row.posZ),
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
      unit: this.unit,
      decimals: this.decimals,
      min: this.min,
      max: this.max,
      warnLow: this.warnLow,
      warnHigh: this.warnHigh,
      deviceBindingId: this.deviceBindingId,
      driverConfig: this.driverConfig,
      posX: this.posX,
      posZ: this.posZ,
      value: this.value,
      state: this.state,
      lastAt: this.lastAt,
      createdAt: this.createdAt,
    }
  }
}

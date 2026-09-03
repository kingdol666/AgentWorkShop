/**
 * DcwNode —— 数据写控制节点领域对象(与 DaqNode 对称)。
 *
 * 一个实例 = 一条工艺参数写通道:模板域(物理含义/单位/工艺安全量程)+ 驱动配置
 * (连接 + 工程量→原始值线性换算,系统封装)+ 绑定关系 + 写状态(value/lastAckAt/
 * writeState)。用户只操作工程量;PLC 原始值的换算/回读校验由运行时完成。
 * 序列化经 toRow/fromRow 对接持久化仓库(dcws.json)。
 */

import { dcwKeyFromRef, type DcwDriverKind, type DcwNodeState, type DcwNodeView, type DataTransform } from '../../../../shared/dcw-protocol'
import { findDcwTemplate } from './dcw-templates'

interface DcwNodeOptions {
  id: string
  templateRef: string
  name?: string
  driver?: DcwDriverKind
  enabled?: boolean
  /** 保写周期 ms(心跳重下发;null = 仅手动下发) */
  holdIntervalMs?: number | null
  unit?: string
  decimals?: number
  min?: number
  max?: number
  deviceBindingId?: string | null
  driverConfig?: Record<string, string | number | boolean>
  /** 数据语义标定钩子(encode:物理值 → PLC 设定值;回读经 decoder 校验) */
  transform?: DataTransform
  posX?: number
  posZ?: number
  /** 所属产线('' = 未分配) */
  lineId?: string
  /** 节点级工艺语义备注(覆盖模板 semantics;注入 Agent 上下文) */
  semantics?: string
  /** 周期读间隔 ms(null = 走网关默认;0 = 关闭周期读,仅手动读取) */
  readIntervalMs?: number | null
  createdAt?: string
}

export class DcwNode {
  readonly id: string
  templateRef: string
  name: string
  driver: DcwDriverKind
  enabled: boolean
  holdIntervalMs: number | null
  unit: string
  decimals: number
  min: number
  max: number
  deviceBindingId: string | null
  driverConfig: Record<string, string | number | boolean>
  transform?: DataTransform
  posX?: number
  posZ?: number
  /** 当前设定值(工程量;null = 从未下发) */
  value: number | null = null
  /** PLC 当前读数(工程量物理值;null = 从未读到或驱动不支持读) */
  readValue: number | null = null
  lastReadAt: string | null = null
  lastReadError: string | null = null
  /** 周期读间隔 ms(null = 走网关默认;0 = 仅手动读取) */
  readIntervalMs: number | null = null
  lastAckAt: string | null = null
  lastWriteAt: string | null = null
  state: DcwNodeState = 'idle'
  /** 所属产线('' = 未分配;采集门控/写联锁/场景光晕按产线隔离) */
  lineId = ''
  /** 节点级工艺语义备注(覆盖模板 semantics) */
  semantics?: string
  lastError: string | null = null
  readonly createdAt: string

  constructor(o: DcwNodeOptions) {
    const tpl = findDcwTemplate(dcwKeyFromRef(o.templateRef))
    this.id = o.id
    this.templateRef = o.templateRef
    this.name = o.name ?? (tpl ? `${tpl.name}` : '控制节点')
    this.driver = o.driver ?? 'mock'
    this.enabled = o.enabled ?? true
    this.holdIntervalMs = o.holdIntervalMs ?? null
    this.unit = o.unit ?? tpl?.unit ?? ''
    this.decimals = o.decimals ?? tpl?.decimals ?? 2
    this.min = o.min ?? tpl?.min ?? 0
    this.max = o.max ?? tpl?.max ?? 100
    this.deviceBindingId = o.deviceBindingId ?? null
    this.driverConfig = o.driverConfig ?? {}
    if (o.transform) this.transform = o.transform
    if (o.posX !== undefined) this.posX = o.posX
    if (o.posZ !== undefined) this.posZ = o.posZ
    this.lineId = o.lineId ?? ''
    this.semantics = o.semantics
    this.readIntervalMs = o.readIntervalMs ?? null
    this.createdAt = o.createdAt ?? new Date().toISOString()
  }

  get templateKey(): string {
    return dcwKeyFromRef(this.templateRef)
  }

  /** 写入值工艺安全校验(越界即拒绝;返回错误消息或 null) */
  validateEng(v: number): string | null {
    if (!Number.isFinite(v)) return '设定值需为数字'
    if (v < this.min || v > this.max) {
      return `设定值 ${v}${this.unit} 越出工艺安全量程 [${this.min}, ${this.max}] ${this.unit}`
    }
    return null
  }

  /** 记录一次写 ACK(成功)/失败 */
  applyWriteResult(eng: number, ok: boolean, message: string, at: string): void {
    this.value = Number(eng.toFixed(this.decimals))
    this.lastWriteAt = at
    if (ok) {
      this.lastAckAt = at
      this.state = 'ok'
      this.lastError = null
    }
    else {
      this.state = 'error'
      this.lastError = message
    }
  }

  /** 记录一次读数(成功回填物理值;失败仅记原因,旧读数保留供展示) */
  applyReadResult(eng: number | null, raw: number | null, ok: boolean, message: string, at: string): void {
    this.lastReadAt = at
    if (ok && eng != null) {
      this.readValue = Number(eng.toFixed(this.decimals))
      this.lastReadError = null
    }
    else {
      this.lastReadError = message
    }
  }

  toRow(): Record<string, unknown> {
    return {
      id: this.id,
      templateRef: this.templateRef,
      name: this.name,
      driver: this.driver,
      enabled: this.enabled,
      holdIntervalMs: this.holdIntervalMs,
      readIntervalMs: this.readIntervalMs,
      unit: this.unit,
      decimals: this.decimals,
      min: this.min,
      max: this.max,
      deviceBindingId: this.deviceBindingId,
      driverConfig: this.driverConfig,
      transform: this.transform,
      posX: this.posX,
      posZ: this.posZ,
      lineId: this.lineId,
      semantics: this.semantics,
      value: this.value,
      readValue: this.readValue,
      lastReadAt: this.lastReadAt,
      lastReadError: this.lastReadError,
      lastAckAt: this.lastAckAt,
      lastWriteAt: this.lastWriteAt,
      state: this.state,
      lastError: this.lastError,
      createdAt: this.createdAt,
    }
  }

  static fromRow(row: Record<string, unknown>): DcwNode {
    const node = new DcwNode({
      id: String(row.id),
      templateRef: String(row.templateRef ?? ''),
      name: row.name != null ? String(row.name) : undefined,
      driver: (row.driver as DcwDriverKind) ?? undefined,
      enabled: row.enabled === undefined ? undefined : Boolean(row.enabled),
      holdIntervalMs: row.holdIntervalMs == null ? null : Number(row.holdIntervalMs),
      unit: row.unit != null ? String(row.unit) : undefined,
      decimals: row.decimals != null ? Number(row.decimals) : undefined,
      min: row.min != null ? Number(row.min) : undefined,
      max: row.max != null ? Number(row.max) : undefined,
      deviceBindingId: row.deviceBindingId === undefined ? undefined : (row.deviceBindingId == null ? null : String(row.deviceBindingId)),
      driverConfig: (row.driverConfig as Record<string, string | number | boolean>) ?? {},
      transform: (row.transform as DataTransform | undefined) ?? undefined,
      posX: row.posX == null ? undefined : Number(row.posX),
      lineId: row.lineId == null ? '' : String(row.lineId),
      semantics: row.semantics == null ? undefined : String(row.semantics),
      readIntervalMs: row.readIntervalMs == null ? null : Number(row.readIntervalMs),
      posZ: row.posZ == null ? undefined : Number(row.posZ),
      createdAt: row.createdAt != null ? String(row.createdAt) : undefined,
    })
    if (row.value != null && !Number.isNaN(Number(row.value))) node.value = Number(row.value)
    if (row.readValue != null && !Number.isNaN(Number(row.readValue))) node.readValue = Number(row.readValue)
    if (row.lastReadAt != null) node.lastReadAt = String(row.lastReadAt)
    if (row.lastReadError != null) node.lastReadError = String(row.lastReadError)
    if (row.lastAckAt != null) node.lastAckAt = String(row.lastAckAt)
    if (row.lastWriteAt != null) node.lastWriteAt = String(row.lastWriteAt)
    if (row.state != null) node.state = String(row.state) as DcwNodeState
    if (row.lastError != null) node.lastError = String(row.lastError)
    return node
  }

  toView(): DcwNodeView {
    return {
      id: this.id,
      templateRef: this.templateRef,
      name: this.name,
      driver: this.driver,
      enabled: this.enabled,
      holdIntervalMs: this.holdIntervalMs,
      unit: this.unit,
      decimals: this.decimals,
      min: this.min,
      max: this.max,
      deviceBindingId: this.deviceBindingId,
      driverConfig: this.driverConfig,
      transform: this.transform,
      posX: this.posX,
      posZ: this.posZ,
      lineId: this.lineId,
      semantics: this.semantics,
      value: this.value,
      readValue: this.readValue,
      lastReadAt: this.lastReadAt,
      lastReadError: this.lastReadError,
      readIntervalMs: this.readIntervalMs,
      lastAckAt: this.lastAckAt,
      lastWriteAt: this.lastWriteAt,
      state: this.state,
      lastError: this.lastError,
      createdAt: this.createdAt,
    }
  }
}

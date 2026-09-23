/**
 * 产线(顶层隔离维度)+ 节点视图(REST/WS 同构载荷)
 * (由 shared/dcw-protocol.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DataTransform } from '../daq-protocol'
import type { DcwDriverKind } from './catalog'

// ============================================================
// 产线(Line)—— 节点/产品/配方/批次的顶层隔离维度
// ============================================================

/** 产线光晕色板(数字孪生场景:同产线节点同色光环;1号蓝 2号黄…) */
export const DCW_LINE_COLORS = ['#3aa0ff', '#f4c542', '#35e0a0', '#41c8f4', '#b58cff', '#ff8a5c'] as const

export const dcwLineColorFor = (index: number): string =>
  DCW_LINE_COLORS[index % DCW_LINE_COLORS.length]!

/** 产线(节点/产品/配方挂载其下;开跑/采集/场景光晕按产线隔离) */
export interface LineView {
  id: string
  name: string
  /** 场景光晕/界面身份色(Hex;缺省按创建序取色板) */
  color: string
  description: string
  createdAt: string
}

export interface LineInput {
  name: string
  color?: string
  description?: string
}

// ============================================================
// 节点视图(REST/WS 同构载荷)
// ============================================================

/** 写通道健康态(writing 写入进行中 / ok 最近一次写 ACK / error 最近一次失败 / offline 停用或网关暂停) */
export type DcwNodeState = 'idle' | 'writing' | 'ok' | 'error' | 'offline'

/** 服务端 DcwNode 投影(REST 列表与 WS 变更帧同构) */
export interface DcwNodeView {
  id: string
  templateRef: string
  name: string
  driver: DcwDriverKind
  enabled: boolean
  /** 保写周期 ms(心跳重下发;null = 仅手动下发) */
  holdIntervalMs: number | null
  /** 数据语义标定钩子(encode:物理值 → PLC 设定值) */
  transform?: DataTransform
  /** 节点级工艺语义备注(覆盖模板 semantics;注入 Agent 上下文) */
  semantics?: string
  unit: string
  decimals: number
  /** 工艺安全量程(写入值硬校验) */
  min: number
  max: number
  deviceBindingId: string | null
  /** 多对多设备绑定(权威;去重有序;deviceBindingId=首个,兼容别名) */
  deviceIds: string[]
  driverConfig: Record<string, string | number | boolean>
  posX?: number
  posZ?: number
  /** 所属产线('' = 未分配;采集/场景光晕按产线隔离) */
  lineId: string
  /** 当前设定值(工程量;null = 从未下发) */
  value: number | null
  /** PLC 当前读数(工程量物理值;周期读/手动读回填,null = 从未读到或不支持) */
  readValue: number | null
  /** 最近一次读到 PLC 值的时刻 */
  lastReadAt: string | null
  /** 最近一次读失败原因(成功后清空) */
  lastReadError: string | null
  /** 周期读间隔 ms(null = 走网关默认;0 = 关闭周期读,仅手动读取) */
  readIntervalMs: number | null
  /**
   * 保写周期秒数(节点级:每次写命令后在该窗口内维持设定值;0 = 不保写)。
   * 与 `DcwNode.toView()` 同源;前端节点详情据此显示保写倒计时。
   */
  writeLockSeconds?: number
  /** 最近一次成功下发时刻 / 最近一次写尝试时刻 */
  lastAckAt: string | null
  lastWriteAt: string | null
  state: DcwNodeState
  lastError: string | null
  createdAt: string
}

/** dcw.written 帧载荷(每次写命令 ACK 直推) */
export interface AepDcwWritten {
  nodeId: string
  templateRef: string
  /** 工程值(用户语义) */
  value: number
  /** 原始值(PLC 语义,换算后) */
  raw: number | null
  ok: boolean
  message: string
  /** 关联的配方批次(单发/保写为 null) */
  recipeRunId: string | null
  at: string
}

/** dcw.node.changed 帧载荷 */
export interface AepDcwNodeChange {
  op: 'added' | 'updated' | 'removed'
  node: DcwNodeView | null
}

/** dcw.read 帧载荷(每次 PLC 读数直推;周期读 + 手动读共用) */
export interface AepDcwRead {
  nodeId: string
  templateRef: string
  /** 工程量物理值(读回原始值经换算/标定解码;读失败为 null) */
  value: number | null
  /** 原始值(PLC 语义,换算后;非寄存器驱动与 value 同源) */
  raw: number | null
  ok: boolean
  message: string
  at: string
}

/** dcw.controller 帧载荷 */
export interface AepDcwControllerState {
  running: boolean
  nodesTotal: number
  nodesOnline: number
  writesTotal: number
  writesFailed: number
}

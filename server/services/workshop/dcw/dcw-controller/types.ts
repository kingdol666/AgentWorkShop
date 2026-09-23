/**
 * DcwController 的依赖类型与对外 DTO(原 server/services/workshop/dcw/dcw-controller.ts 顶部模块级类型声明)。纯类型。
 */
import type { DataTransform, DcwDriverKind } from '../../../../../shared/dcw-protocol'

export type BroadcastFn = (type: string, payload: unknown) => void

export interface DcwCreateInput {
  templateRef?: string
  name?: string
  driver?: DcwDriverKind
  driverConfig?: Record<string, string | number | boolean>
  /** 数据语义标定钩子(encode:物理值 → PLC 设定值) */
  transform?: DataTransform
  holdIntervalMs?: number | null
  /** 周期读间隔 ms(null = 网关默认;0 = 仅手动读取) */
  readIntervalMs?: number | null
  unit?: string
  decimals?: number
  min?: number
  max?: number
  enabled?: boolean
  posX?: number
  posZ?: number
  deviceBindingId?: string | null
  deviceIds?: string[]
  /** 所属产线('' = 未分配) */
  lineId?: string
  /** 节点级工艺语义备注(覆盖模板) */
  semantics?: string
  /** 写入保持窗秒数(写成功后锁定节点防震荡;0 = 不锁;默认 30) */
  writeLockSeconds?: number
}

export interface DcwPatchInput {
  name?: string
  driver?: DcwDriverKind
  driverConfig?: Record<string, string | number | boolean>
  /** 数据语义标定钩子(encode) */
  transform?: DataTransform
  holdIntervalMs?: number | null
  /** 周期读间隔 ms(null = 网关默认;0 = 仅手动读取) */
  readIntervalMs?: number | null
  unit?: string
  decimals?: number
  min?: number
  max?: number
  enabled?: boolean
  posX?: number
  posZ?: number
  lineId?: string
  semantics?: string
  /** 写入保持窗秒数(0 = 不锁) */
  writeLockSeconds?: number
}

/** 网关扫描周期(ms;保写心跳分辨率) */

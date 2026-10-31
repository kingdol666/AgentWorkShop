/**
 * DaqController 的依赖类型与对外 DTO(原 server/services/workshop/daq/daq-controller.ts 顶部模块级类型声明)。纯类型。
 */
import type { DaqDriverKind, DataTransform } from '../../../../../shared/daq-protocol'

export interface DaqCreateInput {
  templateRef?: string
  name?: string
  driver?: DaqDriverKind
  driverConfig?: Record<string, string | number | boolean>
  /** 数据语义标定钩子(decoder) */
  transform?: DataTransform
  unit?: string
  decimals?: number
  min?: number
  max?: number
  warnLow?: number | null
  warnHigh?: number | null
  intervalMs?: number | null
  /** WS 实时下发间隔(null=跟随全局;0=每帧) */
  publishIntervalMs?: number | null
  enabled?: boolean
  posX?: number
  posZ?: number
  /** 所属产线('' = 未分配) */
  lineId?: string
  /** 节点级采集语义备注(覆盖模板) */
  semantics?: string
  deviceBindingId?: string | null
  /** MQTT 单 topic 多字段:声明后展开为多个子信号节点(每字段一个,独立量程/告警)。
   *  也可放在 driverConfig.fields(前端动态表单的文本域形态) */
  fields?: unknown
  /** 多字段路径公共前缀(可选;与 fields 的 path 拼接) */
  fieldsBase?: string
}

export interface DaqPatchInput {
  name?: string
  driver?: DaqDriverKind
  driverConfig?: Record<string, string | number | boolean>
  /** 数据语义标定钩子(decoder) */
  transform?: DataTransform
  unit?: string
  decimals?: number
  min?: number
  max?: number
  warnLow?: number | null
  warnHigh?: number | null
  intervalMs?: number | null
  /** WS 实时下发间隔(null=跟随全局;0=每帧) */
  publishIntervalMs?: number | null
  enabled?: boolean
  posX?: number
  posZ?: number
  /** 所属产线('' = 未分配;采集门控按产线) */
  lineId?: string
  /** 节点级采集语义备注(覆盖模板) */
  semantics?: string
  /** E8 上下文扩展:设备/腔室名与层级路径(纯标签) */
  chamber?: string
  unitPath?: string
}

export type BroadcastFn = (type: string, payload: unknown) => void

/** 有界 LRU 的最小泛型面:shared/lru.mjs 是 allowJs 推断出的**非泛型**类(JS 里没有 @template),
 *  直接 `new LruMap<K, V>()` 无处安放类型参数。这里按实际使用面(get/set/delete/size)声明键值类型,
 *  调用点即可拿到准确的读写类型;运行时仍是同一个 LruMap(纯类型声明,零运行时差异)。 */
export interface LruLike<K, V> {
  readonly size: number
  get(key: K): V | undefined
  set(key: K, value: V): unknown
  delete(key: K): unknown
}

/** TSDB 批量写窗口(ms):消费端攒批再落盘 */

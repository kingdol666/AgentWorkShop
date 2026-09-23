/**
 * 模块头 / 依赖注入类型 / 驱动接口(DaqDriver 等)
 * (由 server/services/workshop/daq/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DaqDriverKind, DriverTestResult } from '../../../../../shared/daq-protocol'
import { createLogger } from '../../logger'
import { createRequire } from 'node:module'

export const log = createLogger('daq.drivers')

/** createRequire 加载原生/重型协议栈(nitro Windows 动态 import external 的 'd:' scheme 规避) */
export const reqNative = createRequire(import.meta.url)

/** 采样上下文(controller 注入) */
export interface DaqSampleCtx {
  nodeId: string
  now: number
  ageMs: number
}

/** 驱动配置:模板域(采样波形/兜底量程)+ 协议连接参数(driverConfig) */
export interface DaqDriverInput {
  ctx: DaqSampleCtx
  config: { base: number, amp: number, min: number, max: number }
  /** 节点保存的协议连接参数(host/register/endpoint/nodeId...) */
  driverConfig: Record<string, unknown>
  /** 模板信号形态(v2 帧管线;缺省 scalar —— 既有驱动零感知) */
  signalKind?: 'scalar' | 'vector' | 'image'
  /** vector 声明(模板;mock 生成点列/校验依据) */
  vector?: { points: number, min: number, max: number }
}

/**
 * 帧采样值(v2 多形态信号):驱动 sample() 可返回标量(既有契约)或帧信封。
 *  - vector:多点工程量轮廓(≤4096 点,经队列 JSON 传输)
 *  - image :像素 blob(仅生产侧管线内存续;controller 落对象存储后剥离为 objectKey)
 */
export type DaqFrameSample = {
  frame:
    | { kind: 'vector', points: number[], metrics?: Record<string, number> }
    | {
      kind: 'image'
      blob: Buffer
      mime: string
      width: number
      height: number
      metrics?: Record<string, number>
      /** 驱动侧通常未设;controller 落对象存储后回填引用(队列信封只传引用) */
      objectKey?: string
      thumbKey?: string
    }
}

export interface DaqDriver {
  readonly kind: DaqDriverKind
  /** 协议栈是否可用(包缺失时 false,节点测试连接给出可行动提示) */
  available(): Promise<boolean>
  sample(input: DaqDriverInput): Promise<number | DaqFrameSample | null> | number | DaqFrameSample | null
  test(driverConfig: Record<string, unknown>): Promise<DriverTestResult>
}

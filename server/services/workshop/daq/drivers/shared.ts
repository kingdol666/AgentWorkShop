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
      /** 像素完整性指纹(P0-2;生产侧信封携带,驱动侧通常未设) */
      sha256?: string
      size?: number
    }
}

/** 推送式驱动的报文回调样本:标量值或已解码帧(向量/图像)+ 到达时刻 */
export type DaqPushSample
  = | { value: number, atMs: number, frame?: undefined }
    | { frame: DaqFrameSample['frame'], atMs: number, value?: undefined }

/**
 * 推送式协议(MQTT 等)常驻订阅契约。
 * 控制器在节点启用且归属产线存在时建立一次订阅,每条设备报文回调一次(PASSIVE,非轮询);
 * 返回 stop —— 节点停用/删除/网关停止时调用(必须幂等)。
 */
export interface DaqPushInput extends DaqDriverInput {
  /** 报文到达(解析成功)回调;控制器负责产线门控/状态派生/入库 */
  onSample: (sample: DaqPushSample) => void
  /** 订阅期错误(解析失败/连接断开等);控制器落节点 lastError 并节流广播 */
  onError?: (err: Error) => void
}

export interface DaqDriver {
  readonly kind: DaqDriverKind
  /** 协议栈是否可用(包缺失时 false,节点测试连接给出可行动提示) */
  available(): Promise<boolean>
  sample(input: DaqDriverInput): Promise<number | DaqFrameSample | null> | number | DaqFrameSample | null
  /** 连接测试;signalKind 可选(节点测试传模板形态,按参数测试则自动识别载荷) */
  test(driverConfig: Record<string, unknown>, signalKind?: 'scalar' | 'vector' | 'image'): Promise<DriverTestResult>
  /**
   * 可选:建立常驻订阅(推送式协议)。存在此方法的驱动由控制器按「事件驱动」采集,
   * 不再进入 intervalMs 轮询 —— MQTT 的语义是连上 broker 后被动收报文,
   * 轮询订阅缓存会把同一条报文按采样 tick 重复入库、并在停发后伪造冻值。
   */
  subscribe?(input: DaqPushInput): Promise<() => void | Promise<void>>
  /**
   * 可选:订阅参数指纹(凭据/TLS/主题/QoS 等)。控制器发现指纹变化会重建订阅,
   * 避免改密码/换主题后仍挂在旧连接上。缺省由控制器按常见字段拼一个保守指纹。
   */
  fingerprint?(driverConfig: Record<string, unknown>): string
}

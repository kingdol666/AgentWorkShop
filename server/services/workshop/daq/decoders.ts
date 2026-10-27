/**
 * DAQ 载荷解码器注册表 —— 结构化报文 → 单个类型化样本(scalar/vector/image)的统一接口。
 *
 * 两层扩展点:
 *  1) 声明式(节点 driverConfig):jsonPath / pointsPath / imagePath 等，覆盖常见 JSON 结构；
 *  2) 自定义解码器(本注册表):插件经 ctx.daq.registerDecoder(name, fn) 注册，
 *     节点 driverConfig.decoder = name 即启用 —— 复杂协议/自定义 sink 解析交给用户。
 *
 * 解码器必须是**同步纯函数**(报文解析不应异步等待)：入参含原始文本、原始字节、
 * 已解析 JSON(可能为 null)、节点配置与模板信号形态；返回且仅返回一种类型化样本。
 * 形态必须与节点模板 signalKind 一致(控制器会校验)，避免把数组写进标量链路。
 */

export type DaqDecoded =
  | { kind: 'scalar', value: number }
  | { kind: 'vector', points: number[], metrics?: Record<string, number> }
  | { kind: 'image', blob: Buffer, mime: string, width?: number, height?: number, metrics?: Record<string, number> }

export interface DaqDecodeInput {
  /** 报文文本(UTF-8;二进制图像请用 bytes) */
  raw: string
  /** 原始报文字节(二进制图像/自定义协议用) */
  bytes: Buffer
  /** 已解析 JSON(非 JSON 报文为 null;解析失败由注册表调用方给出可读错误) */
  json: unknown
  /** 节点 driverConfig */
  config: Record<string, unknown>
  /** 节点模板信号形态(scalar/vector/image;解码结果必须一致) */
  signalKind: 'scalar' | 'vector' | 'image'
  nodeId: string
}

export type DaqDecoder = (input: DaqDecodeInput) => DaqDecoded

const registry = new Map<string, DaqDecoder>()

/** 注册/覆盖自定义解码器(插件热重载同名覆盖) */
export function registerDecoder(name: string, fn: DaqDecoder): void {
  const key = String(name ?? '').trim()
  if (!key) throw new Error('解码器名称必填')
  if (typeof fn !== 'function') throw new Error(`解码器 ${key} 必须是函数`)
  registry.set(key, fn)
}

export function resolveDecoder(name: string): DaqDecoder | undefined {
  return registry.get(String(name ?? '').trim())
}

export function listDecoders(): string[] {
  return [...registry.keys()].sort()
}

/** 测试/插件卸载用(清空自定义解码器;内置声明式解码不受影响) */
export function clearDecoders(): void {
  registry.clear()
}

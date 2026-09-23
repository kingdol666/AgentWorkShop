/**
 * DaqController 的模块级纯工具/常量(原 server/services/workshop/daq/daq-controller.ts 类外声明,含类体之后与类无关的部分)。
 */
import { attachDaqPluginBridge } from '../plugin-bridge'
import { createLogger } from '../../logger'

export const log = createLogger('daq.controller')

// 插件桥接管(host.mjs ctx.daq 排队注册的驱动/处理器在此回放;幂等)
attachDaqPluginBridge()

export const TSDB_FLUSH_MS = 500
/** TSDB 攒批缓冲上限(背压:满则丢最旧并计数,防慢库拖爆内存) */
export const TSDB_BUFFER_CAP = 5000
/** 帧攒批缓冲上限(向量/图像元数据;量级远小于标量) */
export const FRAME_BUFFER_CAP = 2000
/** TSDB 写失败重试次数(有限重试后丢弃并计数,不阻塞消费) */
export const TSDB_WRITE_RETRIES = 3
/** WS 帧预览点数上限(AepDaqFrame.preview;完整点列经 REST frames 查询) */
export const FRAME_PREVIEW_POINTS = 64
/**
 * sweep 采样并发闸门。
 * 早先 sweep 对每个到期运行时直接 void rt.tick() —— 节点自互斥只防「同节点重入」,
 * 不防「N 个节点同拍齐发」。250ms 扫描 + 相同 intervalMs 会让大量节点在同一个 tick 到期,
 * 瞬时并发打满 Modbus/OPC UA/MQTT 连接,既拖慢本拍也冲击 PLC。
 * 限量后超出的节点顺延到下一拍(250ms 后),到期判定用 lastSampleAt,不会丢采样、
 * 只会把洪峰摊平成稳定节拍。
 *
 * 额度取值:只约束「本拍真正派发多少个到期采样」。现场 282 节点、周期 1~5s 时
 * 稳态需求约 110 采样/秒(≈28/拍),8 会让大量到期节点永远排不上队 —— 实测只有
 * 最先入表的 5 个节点在采(其余长期 lastAt 不动)。64/拍 = 256/拍秒,留 2 倍余量;
 * 且 sweep 已按到期预判派发,未到期节点不占额度,故提高额度不会放大瞬时洪峰。
 */
export const SWEEP_MAX_CONCURRENCY = 64

let g_queueBackend = 'inproc'

/** 读取当前队列后端(供分层读取;写入口见 setQueueBackend) */
export function getQueueBackend(): string {
  return g_queueBackend
}

/** 当前队列适配器的真实丢弃计数(mqtt 断连/inproc 拥塞) */
export function g_queueLost(): number {
  const q = (globalThis as typeof globalThis & { __daqQueue?: { lost?: number } }).__daqQueue
  return q?.lost ?? 0
}

/** 供 facade 侧写回 g_queueBackend(import 绑定只读,故用 setter) */
export function setQueueBackend(v: string): void {
  g_queueBackend = v
}

/**
 * DaqQueuePort 工厂 —— 配置驱动(DAQ_MQTT_URL 由 infra 提供),缺省进程内 mock 队列。
 * 单例 globalThis;rebuildDaqQueue() 支持重连时切回真实 MQTT。
 */
import { InProcQueueAdapter } from './inproc.adapter'
import { MqttQueueAdapter } from './mqtt.adapter'
import type { DaqQueuePort } from './queue-port'

const g = globalThis as typeof globalThis & { __daqQueue?: DaqQueuePort }

export async function getDaqQueue(): Promise<DaqQueuePort> {
  if (!g.__daqQueue) {
    g.__daqQueue = new InProcQueueAdapter()
    await g.__daqQueue.init()
    console.log('[daq-queue] 进程内 mock 队列就绪(启动插件将按 infra 状态装配 MQTT)')
  }
  return g.__daqQueue
}

/** 重连/初始装配:按 infra 判定结果(重新)构建 MQTT 或进程内队列 */
export async function rebuildDaqQueue(online: boolean, url?: string | null): Promise<DaqQueuePort> {
  if (!online || !url) {
    if (g.__daqQueue?.backend !== 'inproc') {
      g.__daqQueue = new InProcQueueAdapter()
      await g.__daqQueue.init()
      console.warn('[daq-queue] 降级进程内队列')
    }
    return g.__daqQueue
  }
  try {
    const adapter = new MqttQueueAdapter(url)
    await adapter.init()
    g.__daqQueue = adapter
    console.log('[daq-queue] MQTT 队列就绪:', url)
    return adapter
  }
  catch (err) {
    console.error('[daq-queue] MQTT 初始化失败,回退进程内队列:', err instanceof Error ? err.message : err)
    g.__daqQueue = new InProcQueueAdapter()
    await g.__daqQueue.init()
    return g.__daqQueue
  }
}

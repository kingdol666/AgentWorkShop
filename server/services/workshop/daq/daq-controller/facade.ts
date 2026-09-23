/**
 * DaqController —— 组合各分层后的最终类(可见性/继承/实现接口与拆分前一致)
 * + 原文件类体之后引用本类的模块级代码(单例/工厂/广播装配)。
 */
import { DaqControllerLayer08 } from './08-driver-probe'
import { setQueueBackend } from './helpers'
import type { BroadcastFn } from './types'
import { getDaqQueue } from '../bus'

class DaqController extends DaqControllerLayer08 {}
const g = globalThis as typeof globalThis & { __daqController?: DaqController, __daqQueueBackend?: string }
export function getDaqController(): DaqController {
  g.__daqController ??= new DaqController()
  return g.__daqController
}

/**
 * 广播装配(daq REST 路由模块加载时调用):把 ws.ts 的 broadcastSceneEvent
 * 注入控制器 —— 路由模块是 nitro 按需加载,小镇页首访必经 GET /api/workshop/daq,
 * 因此无需常驻插件即可保证采样帧有出口。
 */
export function bindDaqBroadcast(fn: BroadcastFn | null): void {
  getDaqController().setBroadcast(fn)
  // 同时确保管线启动(队列消费在位)——REST 首访即全链路上电
  void getDaqQueue().then((q) => {
    setQueueBackend(q.backend)
  }).catch(() => {})
}

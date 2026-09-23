/**
 * DcwController —— 组合各分层后的最终类(可见性/继承/实现接口与拆分前一致)
 * + 原文件类体之后引用本类的模块级代码(单例/工厂/广播装配)。
 */
import { DcwControllerLayer09 } from './09-products'
import type { BroadcastFn } from './types'

class DcwController extends DcwControllerLayer09 {}
const g = globalThis as typeof globalThis & { __dcwController?: DcwController }

export function getDcwController(): DcwController {
  g.__dcwController ??= new DcwController()
  return g.__dcwController
}

/** 广播装配(dcw 路由模块加载时调用一次;首访即上电) */
export function bindDcwBroadcast(fn: BroadcastFn | null): void {
  getDcwController().setBroadcast(fn)
}

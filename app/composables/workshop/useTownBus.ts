/**
 * TownBus — Workshop AEP 事件旁路总线(单例)。
 *
 * 职责:把 `useWorkshopWs` ingest 的每一个 AEP 信封**旁路广播**给小镇场景(以及任何
 * 需要与时间线同源实时事件流的消费方)。不改变既有 store 分发 —— 只在 ingest 尾部
 * 追加 emit,幂等、可注释一行即完全回退。
 *
 * 核心契约:与 AepEnvelope 同构;subscribe 返回退订函数。单例挂 globalThis,
 * 跨组件安全挂载/卸载(与 useWorkshopWs 的 session 单例同策略)。
 */
import type { AepEnvelope } from '#shared/workshop-protocol'

export interface TownBus {
  /** 广播一帧 AEP(useWorkshopWs ingest 尾部调用;订阅方异常不影响其它) */
  emit(e: AepEnvelope): void
  /** 订阅实时事件;返回退订函数(组件卸载时必须调用,防泄漏) */
  subscribe(fn: (e: AepEnvelope) => void): () => void
}

/** 全局单例句柄键(避免多实例重复订阅) */
const GLOBAL_KEY = '__townBus'

function createBus(): TownBus {
  const subs = new Set<(e: AepEnvelope) => void>()
  return {
    emit(e) {
      for (const fn of subs) {
        try {
          fn(e)
        }
        catch {
          /* 单个订阅方异常不阻断广播 */
        }
      }
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

export function useTownBus(): TownBus {
  const g = globalThis as unknown as Record<string, TownBus | undefined>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createBus()
  return g[GLOBAL_KEY]!
}

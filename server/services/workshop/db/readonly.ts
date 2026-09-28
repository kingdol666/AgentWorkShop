/**
 * 主库只读侧门 —— 跨域快照读取(AML binding-snapshot 等)直接打开 workshop.sqlite 的
 * **唯一许可入口**。快照读取刻意绕过 repo 单例:在不装配服务/不触碰运行时状态的前提下
 * 读取已持久化的一致状态(只读打开、调用方即用即关)。
 * 业务读写一律走 db/*.repo 工厂注入,不得自行 new DatabaseSync;运维性直开
 * (如 retention 清理、serialize 备份)另行集中,不走本模块。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { dataDirFor } from '@/shared/config/home.mjs'

export function openWorkshopDbReadonly(): DatabaseSync {
  return new DatabaseSync(join(dataDirFor(), 'workshop.sqlite'), { readOnly: true })
}

/** 只读打开 → 执行 fn → 确保关闭;任何异常(含打开失败/close 失败)落 onError 兜底 */
export function withWorkshopDbReadonly<T>(fn: (db: DatabaseSync) => T, onError: () => T): T {
  try {
    const db = openWorkshopDbReadonly()
    try {
      return fn(db)
    }
    finally {
      db.close()
    }
  }
  catch {
    return onError()
  }
}

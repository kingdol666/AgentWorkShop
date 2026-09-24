/**
 * SystemConfigServiceDispose —— 销毁
 * (拆分层,承 SystemConfigServiceMutate;方法体与原文件逐行一致)
 */
import { SystemConfigServiceMutate } from './mutate'

export abstract class SystemConfigServiceDispose extends SystemConfigServiceMutate {
  dispose(): void {
    this.disposed = true
    for (const w of this.watcher) {
      try {
        w.close()
      }
      catch { /* 忽略 */ }
    }
    this.watcher = []
    this.listeners.clear()
  }
}

/**
 * SystemConfigServiceLayer07 —— 销毁
 * (分层 8/8,承 SystemConfigServiceLayer06;方法体与原文件逐行一致)
 */
import { SystemConfigServiceLayer06 } from './06-mutate'

export abstract class SystemConfigServiceLayer07 extends SystemConfigServiceLayer06 {
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

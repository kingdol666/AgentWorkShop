/**
 * SystemConfigService —— 组合各分层后的最终类(可见性/继承/实现接口与拆分前一致)
 * + 原文件类体之后引用本类的模块级代码(单例/工厂/广播装配)。
 */
import { SystemConfigServiceDispose } from './dispose'
import type { PublicSnapshot } from './types'

export class SystemConfigService extends SystemConfigServiceDispose {}
/** 取服务单例；未初始化时惰性创建（幂等） */
export function getSystemConfigService(root = process.cwd()): SystemConfigService {
  if (!globalThis.__systemConfig) {
    const service = new SystemConfigService(root)
    globalThis.__systemConfig = service
  }
  return globalThis.__systemConfig
}

/** 便捷：读取当前快照（返回 null 表示不可用） */
export function useSystemConfig(): PublicSnapshot | null {
  try {
    return getSystemConfigService().snapshot()
  }
  catch {
    return null
  }
}

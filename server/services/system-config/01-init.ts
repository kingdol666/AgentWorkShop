/**
 * SystemConfigServiceLayer01 —— 构造 / 初始化 / 描述符索引重建
 * (分层 2/8,承 SystemConfigServiceLayer00;方法体与原文件逐行一致)
 */
import { SystemConfigServiceLayer00 } from './00-state'
import { envOverridesFromEnv, loadDescriptorMap, loadDescriptors } from '@/shared/config/engine.mjs'
import { readGroups } from '@/shared/config/groups.mjs'

export abstract class SystemConfigServiceLayer01 extends SystemConfigServiceLayer00 {
  /** Nitro 启动时调用：加载覆盖 → 应用到 runtimeConfig → 挂文件监听 */
  init(): void {
    this.descriptors = loadDescriptors()
    this.userGroups = readGroups(this.groupsPath)
    this.rebuildMap()
    this.envOverrides = envOverridesFromEnv(process.env, this.descriptors)
    this.reloadFromDisk()
    // 插件设置若在 host 装载先于本服务 init 时已登记 → 此刻补跑旧键迁移
    this.migrateLegacyPluginKeys()
    this.watchFiles()
  }

  /** 重建 key → 描述符映射(全局 + 插件;插件键在 plugins.<plugin>.<key> 命名空间,天然不冲突) */
  protected rebuildMap(): void {
    this.map = loadDescriptorMap(this.allDescriptors)
  }
}

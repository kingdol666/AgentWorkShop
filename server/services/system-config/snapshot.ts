/**
 * SystemConfigServiceSnapshot —— 文件监听 / 快照 / 路径访问器
 * (拆分层,承 SystemConfigServiceRecompute;方法体与原文件逐行一致)
 */
import { SystemConfigServiceRecompute } from './recompute'
import type { PublicSnapshot } from './types'
import { maskSecretSettings } from './secrets'
import { errorText } from './helpers'
import { existsSync, watch } from 'node:fs'
import { join } from 'node:path'

export abstract class SystemConfigServiceSnapshot extends SystemConfigServiceRecompute {
  protected watchFiles(): void {
    const dataDir = join(this.root, 'data')
    const handler = (eventType: string, filename: string | null) => {
      const name = filename ?? ''
      const isSettings = name.includes('runtime-settings.json')
      const isConfig = name.includes('config.yml')
      if (!isSettings && !isConfig) return
      // atomic 写（tmp+rename）在 Windows 上会以 rename/unlink 触发；防抖合并
      if (this.reloadTimer) clearTimeout(this.reloadTimer)
      this.reloadTimer = setTimeout(() => {
        if (this.disposed) return
        const { changed } = this.reloadFromDisk()
        this.broadcast({ type: 'config:reloaded', changed, ...this.eventTail() })
      }, 300)
    }
    try {
      if (existsSync(dataDir)) this.watcher.push(watch(dataDir, { persistent: false }, handler))
      if (existsSync(this.root)) this.watcher.push(watch(this.root, { persistent: false }, handler))
    }
    catch (err) {
      console.warn('[system-config] 文件监听不可用（外部写入将不热重载）:', errorText(err))
    }
  }

  /* ---------------- 公共 API ---------------- */

  snapshot(): PublicSnapshot {
    // 凭据类键一律掩码出口(admin 也只看 ***):明文只在服务端内部使用。
    return {
      descriptors: this.allDescriptors,
      groups: this.listGroups(),
      effective: maskSecretSettings(this.effective),
      overrides: maskSecretSettings(this.overrides),
      sources: { ...this.sources },
      settingsPath: this.settingsPath,
      configPath: this.configPath,
    }
  }

  /** 分组注册文件路径(设置页展示用) */
  get groupRegistryPath(): string {
    return this.groupsPath
  }

  /**
   * 内部消费面:未掩码的 effective(仅进程内调用方,如插件宿主 ctx.config)。
   * 与 snapshot() 的出口掩码语义严格区分 —— 插件桥接出站凭据需要真值;
   * 任何 HTTP/WS 出口必须继续走 snapshot()/eventTail() 的掩码面。
   */
  internalEffective(): Record<string, unknown> {
    return { ...this.effective }
  }

  /** 生效的运行时设置文件路径(启动日志/排障用;经 resolveRunMode 解析,非写死的 <cwd>/data) */
  get effectiveSettingsPath(): string {
    return this.settingsPath
  }
}

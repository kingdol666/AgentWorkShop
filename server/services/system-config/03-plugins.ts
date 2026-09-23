/**
 * SystemConfigServiceLayer03 —— 插件描述符注入 / 旧键迁移 / 取值与运行时应用
 * (分层 4/8,承 SystemConfigServiceLayer02;方法体与原文件逐行一致)
 */
import { SystemConfigServiceLayer02 } from './02-groups'
import type { ConfigGroup, RuntimeConfigView } from './types'
import type { SettingsDescriptor } from '@/shared/config/engine.mjs'
import { DAQ_PREFIX, PUBLIC_FIELDS, ROOT_FIELDS, daqView } from './helpers'
import { getPath, readSettings, saveSettings, setPath } from '@/shared/config/engine.mjs'
import { useRuntimeConfig } from '#imports'

export abstract class SystemConfigServiceLayer03 extends SystemConfigServiceLayer02 {
  /**
   * 插件宿主装载/热重载后注入插件设置描述符 + 插件声明的配置分组。
   * 合并进 map/snapshot/effective 后,前端设置页自动渲染、PATCH 自动校验、
   * 保存即热生效(与全局设置同一条链路);并触发一次遗留键迁移(plugins.kb.* 等)。
   */
  setPluginDescriptors(descs: SettingsDescriptor[], groups?: ConfigGroup[], labels?: Map<string, string>): void {
    this.pluginDescriptors = Array.isArray(descs) ? descs : []
    if (Array.isArray(groups)) this.pluginGroups = groups
    if (labels instanceof Map) this.pluginLabels = labels
    this.rebuildMap()
    if (!this.ready) return // init 尚未执行:init() 末尾会补跑迁移与重载
    const { changed } = this.migrateLegacyPluginKeys()
    const { changed: reloaded } = this.reloadFromDisk()
    this.broadcast({ type: 'config:reloaded', changed: [...changed, ...reloaded, 'plugin-settings', 'config-groups'], ...this.eventTail() })
  }

  /** 一次性迁移:0.7.28 前写死在 schema.json 的 plugins.kb / plugins.diag 键 → 插件命名空间键 */
  protected migrateLegacyPluginKeys(): { changed: string[] } {
    const legacyMap: Record<string, string> = {
      'plugins.kb.base_url': 'plugins.rag-bridge.base_url',
      'plugins.kb.web_url': 'plugins.rag-bridge.web_url',
      'plugins.kb.token': 'plugins.rag-bridge.token',
      'plugins.diag.base_url': 'plugins.diag-bridge.base_url',
      'plugins.diag.token': 'plugins.diag-bridge.token',
      'plugins.diag.harness': 'plugins.diag-bridge.harness',
      'plugins.diag.max_turns': 'plugins.diag-bridge.max_turns',
      'plugins.diag.max_minutes': 'plugins.diag-bridge.max_minutes',
      'plugins.diag.auto_enabled': 'plugins.diag-bridge.auto_enabled',
      'plugins.diag.auto_rules': 'plugins.diag-bridge.auto_rules',
    }
    const raw = readSettings(this.settingsPath) as Record<string, unknown>
    const moved: Record<string, unknown> = {}
    const removed: string[] = []
    for (const [oldKey, newKey] of Object.entries(legacyMap)) {
      if (raw[oldKey] === undefined) continue
      // 新键已注册才搬移并删旧键;否则保留旧键等下一次 pass(插件宿主装载后再触发),
      // 绝不抢先删数据 —— nitro 插件顺序里本服务可能先于插件宿主初始化
      if (raw[newKey] === undefined && this.map[newKey]) {
        moved[newKey] = raw[oldKey]
        removed.push(oldKey)
      }
    }
    if (!removed.length) return { changed: [] }
    const next: Record<string, unknown> = { ...raw }
    for (const k of removed) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- 迁移语义:旧键必须从覆盖文件移除
      delete next[k]
    }
    Object.assign(next, moved)
    saveSettings(next, this.settingsPath)
    console.log(`[system-config] 插件设置键已迁移: ${removed.join(', ')} → ${Object.keys(moved).join(', ') || '(丢弃,新键未注册)'}`)
    return { changed: [...removed, ...Object.keys(moved)] }
  }

  /* ---------------- 私有:base / apply ---------------- */

  /** 从当前 runtimeConfig 读取某 key 的构建期基准值 */
  protected readBase(key: string): unknown {
    const rc = useRuntimeConfig() as RuntimeConfigView
    // 保留 ?.:public 缺失时按 undefined 处理(与改动前一致,不引入抛错路径)
    if (PUBLIC_FIELDS[key]) return rc.public?.[PUBLIC_FIELDS[key]]
    if (ROOT_FIELDS[key]) return rc[ROOT_FIELDS[key]]
    if (key.startsWith(DAQ_PREFIX)) return getPath(rc.daq, key.slice(DAQ_PREFIX.length))
    return undefined
  }

  /** 把某 key 的生效值写入 runtimeConfig（live 应用；restart 键仅改内存视图供展示）。
   *  Nitro 4 中 runtimeConfig.public 为只读对象 → 赋值抛错；此处降级:
   *  视图以本服务内存 effective 为唯一实时源，前端经 SSE 消费；SSR 读取在下次启动后对齐。 */
  protected applyToRuntime(key: string, value: unknown): void {
    try {
      const rc = useRuntimeConfig() as RuntimeConfigView
      if (PUBLIC_FIELDS[key]) {
        rc.public[PUBLIC_FIELDS[key]] = value
        return
      }
      if (ROOT_FIELDS[key]) {
        rc[ROOT_FIELDS[key]] = value
        return
      }
      if (key.startsWith(DAQ_PREFIX)) {
        setPath(daqView(rc), key.slice(DAQ_PREFIX.length), value)
      }
    }
    catch {
      if (!this.applyWarned) {
        this.applyWarned = true
        console.warn('[system-config] runtimeConfig 只读 → live 应用降级为服务内存视图 + SSE 广播(前端实时;服务端 SSR 完整生效需重启)')
      }
    }
  }
}

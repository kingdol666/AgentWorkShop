/**
 * SystemConfigServiceState —— 状态字段与派生视图
 * (拆分层,承 SystemConfigServiceContracts;方法体与原文件逐行一致)
 */
import { SystemConfigServiceContracts } from './contracts'
import type { ConfigGroup, Listener } from './types'
import type { SettingsDescriptor } from '@/shared/config/engine.mjs'
import type { watch } from 'node:fs'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { errorText } from './helpers'
import { groupsPathFor } from '@/shared/config/groups.mjs'
import { resolveRunMode } from '@/shared/config/home.mjs'

export abstract class SystemConfigServiceState extends SystemConfigServiceContracts {
  protected descriptors: SettingsDescriptor[] = []
  /** 插件贡献的设置描述符(host 装载/热重载后注入;key 编址 plugins.<plugin>.<key>) */
  protected pluginDescriptors: SettingsDescriptor[] = []
  /** 插件声明的配置分组(host 装载/热重载后注入;卸载即摘除) */
  protected pluginGroups: ConfigGroup[] = []
  /** 插件名 → 展示名(自动生成插件分组标题用) */
  protected pluginLabels = new Map<string, string>()
  /** 管理员定制 + 自建分组的持久化副本 */
  protected userGroups: ConfigGroup[] = []
  /** key → 描述符(loadDescriptorMap 返回普通对象,非 Map;下标访问;含插件描述符) */
  protected map: Record<string, SettingsDescriptor> = {}
  protected overrides: Record<string, unknown> = {}
  protected envOverrides: Record<string, unknown> = {}
  protected effective: Record<string, unknown> = {}
  protected sources: Record<string, 'config.yml' | 'runtime' | 'env'> = {}
  protected listeners = new Set<Listener>()
  protected configPath = ''
  protected settingsPath = ''
  protected groupsPath = ''
  protected watcher: ReturnType<typeof watch>[] = []
  protected reloadTimer: NodeJS.Timeout | null = null
  protected disposed = false
  protected applyWarned = false

  /** 是否已完成 init()(descriptors 装载完毕;settings.ts 据此决定消费内存权威还是文件链) */
  get ready(): boolean {
    return this.descriptors.length > 0
  }

  /** 全量描述符 = 全局 schema + 插件声明(插件项以 plugins.<plugin>.<key> 编址,不与全局键冲突) */
  protected get allDescriptors(): SettingsDescriptor[] {
    return this.pluginDescriptors.length ? [...this.descriptors, ...this.pluginDescriptors] : this.descriptors
  }

  constructor(readonly root: string) {
    super()
    this.configPath = join(root, 'config.yml')
    // 设置文件必须与 CLI(aw config set)/start/dev-guard 同源(resolveRunMode 单一入口):
    // 原先写死 <cwd>/data/runtime-settings.json 造成"API 写 A、子系统读 B"的脑裂 —— 备份
    // 周期/保留期/DAQ 覆盖等运行时设置对服务端静默无效。
    const rm = resolveRunMode({ cwd: root, packageRoot: process.env.AW_PACKAGE_ROOT, env: process.env })
    this.configPath = rm.configPath ?? this.configPath
    this.settingsPath = rm.settingsPath ?? this.settingsPath
    // 分组注册表与 runtime-settings.json 同目录(同为运行时状态,随配置根走)
    this.groupsPath = groupsPathFor(dirname(this.settingsPath))
    // 一次性收敛:遗留 <cwd>/data/runtime-settings.json 且目标不存在 → 迁移;两者并存 → 告警遗留被忽略
    try {
      const legacy = join(root, 'data', 'runtime-settings.json')
      if (existsSync(legacy) && legacy !== this.settingsPath) {
        if (!existsSync(this.settingsPath)) {
          mkdirSync(dirname(this.settingsPath), { recursive: true })
          copyFileSync(legacy, this.settingsPath)
          console.log(`[system-config] 遗留设置已迁移: ${legacy} -> ${this.settingsPath}`)
        }
        else {
          console.warn(`[system-config] 检测到遗留设置文件 ${legacy}(现以 ${this.settingsPath} 为准,该文件被忽略)`)
        }
      }
    }
    catch (err) {
      console.warn('[system-config] 遗留设置迁移失败(不阻断启动):', errorText(err))
    }
  }
}

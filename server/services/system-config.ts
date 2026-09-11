/**
 * 系统配置单例服务 —— 运行时设置（持久化 + 热重载 + SSE 广播）。
 *
 * 单一事实来源与优先级（与 CLI / 构建期完全一致）：
 *   config.yml 默认  <  data/runtime-settings.json 运行时覆盖  <  环境变量(AW_*)
 *
 * 生效语义（由 shared/config/schema.json 描述符的 applies 决定）：
 *   live    —— 保存即改内存 runtimeConfig + SSE 广播，前端实时生效（无需刷新）
 *   restart —— 落盘持久化，在下一次以对应模式启动时生效（aw dev / aw start）
 *
 * 文件监听：外部写入（aw config set / 手工编辑）runtime-settings.json 或 config.yml
 *   → 自动重载 + 广播。前端、CLI、文件三条写入路径最终收敛到同一份覆盖文件。
 *
 * 使用：server/plugins/system-config.ts 在 Nitro 启动时 init()；
 * 业务经 getSystemConfigService() 读取（不存在则惰性初始化，幂等）。
 */
import { watch, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { useRuntimeConfig } from '#imports'
import { resolveRunMode } from '@/shared/config/home.mjs'
import { AppError } from '../utils/errors'
import {
  loadDescriptors,
  loadDescriptorMap,
  readSettings,
  saveSettings,
  validateValue,
  envOverridesFromEnv,
  getPath,
  setPath,
  type SettingsDescriptor,
} from '@/shared/config/engine.mjs'
import {
  mergeGroups,
  normalizeGroup,
  readGroups,
  saveGroups,
  groupsPathFor,
} from '@/shared/config/groups.mjs'

/** 配置分组(设置页分区:后端下发元数据,前端只负责渲染) */
export interface ConfigGroup {
  id: string
  label: string
  labelKey?: string
  description: string
  /** 排序权重(小在前);内置分组按 schema 声明顺序 ×10 */
  order: number
  /** 前端默认折叠态(用户本地展开偏好优先) */
  collapsed: boolean
  collapsible: boolean
  icon: string
  source: 'builtin' | 'user' | 'plugin'
  /** source=plugin 时的插件名 */
  plugin?: string
  /** 该分组下的字段数(只读,由服务端按当前描述符实时计算) */
  fieldCount?: number
}

/* ---------- 描述符 key → runtimeConfig 字段映射 ----------
 * nuxt.config runtimeConfig 的结构：
 *   public.appTitle/appTitle/description/mode/apiBase/apiTimeout/primaryColor/themeMode/...
 *   apiPageSize / apiMaxPageSize / approvalGate / daq.{...}
 */
const PUBLIC_FIELDS: Record<string, string> = {
  'server.host': 'serverHost',
  'server.dev.port': 'devPort',
  'server.prod.port': 'prodPort',
  'app.title': 'appTitle',
  'app.description': 'description',
  'api.baseURL': 'apiBase',
  'api.timeout': 'apiTimeout',
  'theme.primaryColor': 'primaryColor',
  'theme.mode': 'themeMode',
  'i18n.defaultLocale': 'defaultLocale',
}
const ROOT_FIELDS: Record<string, string> = {
  'api.pageSize': 'apiPageSize',
  'api.maxPageSize': 'apiMaxPageSize',
  'security.approvalGate': 'approvalGate',
}
const DAQ_PREFIX = 'daq.'

export interface PublicSnapshot {
  descriptors: SettingsDescriptor[]
  /** 有序分组(后端权威;前端据此渲染分区、顺序、折叠态) */
  groups: ConfigGroup[]
  effective: Record<string, unknown>
  overrides: Record<string, unknown>
  sources: Record<string, 'config.yml' | 'runtime' | 'env'>
  settingsPath: string
  configPath: string
}

/** 广播载荷 */
export interface ConfigEventPayload {
  type: 'config:changed' | 'config:reset' | 'config:reloaded'
  changed: string[]
  restartRequired: string[]
  effective: Record<string, unknown>
  sources: Record<string, unknown>
  overrides: Record<string, unknown>
  at: string
}

type Listener = (payload: ConfigEventPayload) => void

declare global {
  var __systemConfig: SystemConfigService | undefined
}

export class SystemConfigService {
  private descriptors: SettingsDescriptor[] = []
  /** 插件贡献的设置描述符(host 装载/热重载后注入;key 编址 plugins.<plugin>.<key>) */
  private pluginDescriptors: SettingsDescriptor[] = []
  /** 插件声明的配置分组(host 装载/热重载后注入;卸载即摘除) */
  private pluginGroups: ConfigGroup[] = []
  /** 插件名 → 展示名(自动生成插件分组标题用) */
  private pluginLabels = new Map<string, string>()
  /** 管理员定制 + 自建分组的持久化副本 */
  private userGroups: ConfigGroup[] = []
  /** key → 描述符(loadDescriptorMap 返回普通对象,非 Map;下标访问;含插件描述符) */
  private map: Record<string, SettingsDescriptor> = {}
  private overrides: Record<string, unknown> = {}
  private envOverrides: Record<string, unknown> = {}
  private effective: Record<string, unknown> = {}
  private sources: Record<string, 'config.yml' | 'runtime' | 'env'> = {}
  private listeners = new Set<Listener>()
  private configPath = ''
  private settingsPath = ''
  private groupsPath = ''
  private watcher: ReturnType<typeof watch>[] = []
  private reloadTimer: NodeJS.Timeout | null = null
  private disposed = false
  private applyWarned = false

  /** 是否已完成 init()(descriptors 装载完毕;settings.ts 据此决定消费内存权威还是文件链) */
  get ready(): boolean {
    return this.descriptors.length > 0
  }

  /** 全量描述符 = 全局 schema + 插件声明(插件项以 plugins.<plugin>.<key> 编址,不与全局键冲突) */
  private get allDescriptors(): SettingsDescriptor[] {
    return this.pluginDescriptors.length ? [...this.descriptors, ...this.pluginDescriptors] : this.descriptors
  }

  constructor(readonly root: string) {
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
      console.warn('[system-config] 遗留设置迁移失败(不阻断启动):', String(err?.message ?? err))
    }
  }

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
  private rebuildMap(): void {
    this.map = loadDescriptorMap(this.allDescriptors)
  }

  /**
   * 当前生效的有序分组(唯一渲染权威)。
   * 每次读取都重新合并:描述符/插件声明/持久化定制三者任一变化即刻反映,无需缓存失效。
   */
  listGroups(): ConfigGroup[] {
    const groups = mergeGroups({
      descriptors: this.allDescriptors,
      persisted: this.userGroups,
      pluginGroups: this.pluginGroups,
      pluginLabelById: this.pluginLabels,
    }) as ConfigGroup[]
    // fieldCount 实时统计(空分组前端可隐藏/提示)
    const counts = new Map<string, number>()
    for (const d of this.allDescriptors) {
      const g = String(d.group ?? '')
      if (g) counts.set(g, (counts.get(g) ?? 0) + 1)
    }
    return groups.map(g => ({ ...g, fieldCount: counts.get(g.id) ?? 0 }))
  }

  private persistUserGroups(): void {
    // 只持久化「非插件」来源:插件分组的权威是插件声明,落盘会与卸载摘除打架
    const toSave = this.userGroups.filter(g => g.source !== 'plugin')
    try {
      saveGroups(toSave, this.groupsPath)
    }
    catch (err) {
      console.warn('[system-config] 分组注册表落盘失败(本次仅内存生效):', String(err?.message ?? err))
    }
  }

  private broadcastGroups(): void {
    this.broadcast({ type: 'config:reloaded', changed: ['config-groups'], ...this.eventTail() })
  }

  /** 创建分组(source=user;插件请走 setPluginDescriptors 的声明式通道) */
  createGroup(def: Record<string, unknown>): ConfigGroup {
    const n = normalizeGroup(def, { source: 'user', fallbackOrder: this.nextGroupOrder() })
    if (!n.ok) throw new AppError(400, 'VALIDATION_ERROR', n.error)
    if (this.listGroups().some(g => g.id === n.group.id)) {
      throw new AppError(409, 'CONFLICT', `分组已存在: ${n.group.id}`)
    }
    this.userGroups = [...this.userGroups, n.group]
    this.persistUserGroups()
    this.broadcastGroups()
    return n.group
  }

  /** 更新分组(内置组允许改标题/说明/排序/折叠;source 不可改) */
  updateGroup(id: string, patch: Record<string, unknown>): ConfigGroup {
    const existing = this.listGroups().find(g => g.id === id)
    if (!existing) throw new AppError(404, 'NOT_FOUND', `分组不存在: ${id}`)
    if (existing.source === 'plugin') {
      throw new AppError(409, 'CONFLICT', `分组 ${id} 由插件「${existing.plugin ?? '?'}」声明,请在插件侧修改`)
    }
    const merged = { ...existing, ...patch, id }
    const n = normalizeGroup(merged, { source: existing.source, fallbackOrder: existing.order })
    if (!n.ok) throw new AppError(400, 'VALIDATION_ERROR', n.error)
    const next = { ...n.group, source: existing.source }
    const idx = this.userGroups.findIndex(g => g.id === id)
    if (idx >= 0) this.userGroups = this.userGroups.map(g => (g.id === id ? next : g))
    else this.userGroups = [...this.userGroups, next]
    this.persistUserGroups()
    this.broadcastGroups()
    return next
  }

  /**
   * 删除分组。仅允许删 user 组,且组内必须无字段(除非 reassignTo 指定迁往的分组)。
   * @param reassignTo 把组内字段迁到该分组后再删(字段的 group 由描述符声明,不可运行时改,
   *                   故这里只做「拒绝 + 提示」,不静默丢字段)
   */
  deleteGroup(id: string, reassignTo?: string): { removed: string, moved: number } {
    const existing = this.listGroups().find(g => g.id === id)
    if (!existing) throw new AppError(404, 'NOT_FOUND', `分组不存在: ${id}`)
    if (existing.source !== 'user') {
      throw new AppError(409, 'CONFLICT', `分组「${existing.label}」来源为 ${existing.source},不可删除`)
    }
    const owned = this.allDescriptors.filter(d => String(d.group) === id)
    if (owned.length && !reassignTo) {
      throw new AppError(409, 'CONFLICT', `分组「${existing.label}」仍有 ${owned.length} 个字段,请先移走或改用 reassignTo(字段的分组由描述符声明,运行时不可改写)`)
    }
    if (reassignTo && !this.listGroups().some(g => g.id === reassignTo)) {
      throw new AppError(404, 'NOT_FOUND', `目标分组不存在: ${reassignTo}`)
    }
    this.userGroups = this.userGroups.filter(g => g.id !== id)
    this.persistUserGroups()
    this.broadcastGroups()
    return { removed: id, moved: 0 }
  }

  /** 下一个可用排序权重(自建分组追加到末尾) */
  private nextGroupOrder(): number {
    const orders = this.userGroups.map(g => Number(g.order) || 0)
    return (orders.length ? Math.max(...orders) : 900) + 10
  }

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
  private migrateLegacyPluginKeys(): { changed: string[] } {
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
  private readBase(key: string): unknown {
    const rc = useRuntimeConfig() as Record<string, unknown>
    if (PUBLIC_FIELDS[key]) return rc.public?.[PUBLIC_FIELDS[key]]
    if (ROOT_FIELDS[key]) return rc[ROOT_FIELDS[key]]
    if (key.startsWith(DAQ_PREFIX)) return getPath(rc.daq, key.slice(DAQ_PREFIX.length))
    return undefined
  }

  /** 把某 key 的生效值写入 runtimeConfig（live 应用；restart 键仅改内存视图供展示）。
   *  Nitro 4 中 runtimeConfig.public 为只读对象 → 赋值抛错；此处降级:
   *  视图以本服务内存 effective 为唯一实时源，前端经 SSE 消费；SSR 读取在下次启动后对齐。 */
  private applyToRuntime(key: string, value: unknown): void {
    try {
      const rc = useRuntimeConfig() as Record<string, unknown>
      if (PUBLIC_FIELDS[key]) {
        rc.public[PUBLIC_FIELDS[key]] = value
        return
      }
      if (ROOT_FIELDS[key]) {
        rc[ROOT_FIELDS[key]] = value
        return
      }
      if (key.startsWith(DAQ_PREFIX)) {
        if (!rc.daq || typeof rc.daq !== 'object') rc.daq = {}
        setPath(rc.daq, key.slice(DAQ_PREFIX.length), value)
      }
    }
    catch {
      if (!this.applyWarned) {
        this.applyWarned = true
        console.warn('[system-config] runtimeConfig 只读 → live 应用降级为服务内存视图 + SSE 广播(前端实时;服务端 SSR 完整生效需重启)')
      }
    }
  }

  /** 全部描述符重算 effective + sources（base = runtimeConfig 构建值）
   *  并可选地把 live 键应用到 runtimeConfig */
  private recompute({ applyLive = true } = {}): void {
    const effective: Record<string, unknown> = {}
    const sources: Record<string, 'config.yml' | 'runtime' | 'env'> = {}
    for (const desc of this.allDescriptors) {
      let value: unknown
      let source: 'config.yml' | 'runtime' | 'env'
      if (this.envOverrides[desc.key] !== undefined) {
        value = this.envOverrides[desc.key]
        source = 'env'
      }
      else if (this.overrides[desc.key] !== undefined) {
        value = this.overrides[desc.key]
        source = 'runtime'
      }
      else {
        const base = this.readBase(desc.key)
        value = base !== undefined ? base : desc.default
        source = 'config.yml'
      }
      effective[desc.key] = value
      sources[desc.key] = source
      if (applyLive || this.overrides[desc.key] !== undefined) this.applyToRuntime(desc.key, value)
    }
    this.effective = effective
    this.sources = sources
  }

  /** 从磁盘重读设置文件 → 校验 → recompute → 广播 */
  reloadFromDisk(): { changed: string[] } {
    const before = this.overrides
    const raw = readSettings(this.settingsPath)
    const validated: Record<string, unknown> = {}
    const changed: string[] = []
    for (const [key, value] of Object.entries(raw)) {
      const desc = this.map[key]
      if (!desc) continue // 未知键：忽略（schema 演进容错）
      const errs = validateValue(desc, value)
      if (errs.length) {
        console.warn(`[system-config] 忽略无效运行时覆盖 ${key}=${JSON.stringify(value)}: ${errs.join('; ')}`)
        continue
      }
      validated[key] = value
      if (before[key] !== value) changed.push(key)
    }
    for (const key of Object.keys(before)) {
      if (!(key in validated) && key in before) changed.push(key)
    }
    this.overrides = validated
    this.recompute()
    // 运行语义设置读取层(settings.ts effective 3s TTL)即时失效:live 键热重载零延迟
    void import('./workshop/settings').then(m => m.invalidateRuntimeSettingsCache()).catch(() => {})
    return { changed }
  }

  /* ---------------- 文件监听（外部写入热重载） ---------------- */
  private watchFiles(): void {
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
      console.warn('[system-config] 文件监听不可用（外部写入将不热重载）:', String(err?.message ?? err))
    }
  }

  /* ---------------- 公共 API ---------------- */

  snapshot(): PublicSnapshot {
    return {
      descriptors: this.allDescriptors,
      groups: this.listGroups(),
      effective: { ...this.effective },
      overrides: { ...this.overrides },
      sources: { ...this.sources },
      settingsPath: this.settingsPath,
      configPath: this.configPath,
    }
  }

  /** 分组注册文件路径(设置页展示用) */
  get groupRegistryPath(): string {
    return this.groupsPath
  }

  /** 生效的运行时设置文件路径(启动日志/排障用;经 resolveRunMode 解析,非写死的 <cwd>/data) */
  get effectiveSettingsPath(): string {
    return this.settingsPath
  }

  /**
   * 应用一批覆盖（PATCH 语义）。
   * @param patch { [key]: value }  value === null 表示清除该键覆盖（回落 config.yml/base）
   * @returns { changed, restartRequired, effective, sources }
   */
  patch(patch: Record<string, unknown>): { changed: string[], restartRequired: string[], effective: Record<string, unknown>, sources: Record<string, unknown> } {
    const errors: Record<string, string[]> = {}
    const next = { ...this.overrides }
    const changed: string[] = []
    for (const [key, rawValue] of Object.entries(patch)) {
      const desc = this.map[key]
      if (!desc) {
        errors[key] = ['未知设置项（不在 shared/config/schema.json 中）']
        continue
      }
      // null → 清除覆盖
      if (rawValue === null || rawValue === undefined) {
        if (key in next) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- 撤销覆盖语义
          delete next[key]
          changed.push(key)
        }
        continue
      }
      const errs = validateValue(desc, rawValue)
      if (errs.length) {
        errors[key] = errs
        continue
      }
      if (next[key] !== rawValue) changed.push(key)
      next[key] = rawValue
    }
    if (Object.keys(errors).length) {
      throw new AppError(400, 'VALIDATION_ERROR', `设置校验失败: ${Object.entries(errors).map(([k, e]) => `${k}: ${e.join('; ')}`).join(' | ')}`)
    }
    if (changed.length) {
      this.overrides = next
      saveSettings(next, this.settingsPath)
      this.recompute()
    }
    return this.result(changed)
  }

  /** 清空全部运行时覆盖（回落 config.yml/base + env） */
  reset(): { changed: string[], restartRequired: string[] } {
    const changed = Object.keys(this.overrides)
    this.overrides = {}
    saveSettings({}, this.settingsPath)
    this.recompute()
    const res = this.result(changed)
    this.broadcast({ type: 'config:reset', changed, ...this.eventTail() })
    return res
  }

  /** 手动重载（外部已改文件）并广播 */
  reload(): { changed: string[], restartRequired: string[] } {
    const { changed } = this.reloadFromDisk()
    const res = this.result(changed)
    this.broadcast({ type: 'config:reloaded', changed, ...this.eventTail() })
    return res
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private eventTail() {
    return { restartRequired: this.restartRequiredKeys(), effective: { ...this.effective }, sources: { ...this.sources }, overrides: { ...this.overrides }, at: new Date().toISOString() }
  }

  private result(changed: string[]): { changed: string[], restartRequired: string[], effective: Record<string, unknown>, sources: Record<string, unknown> } {
    const out = this.eventTail()
    const res = { changed, restartRequired: out.restartRequired as string[], effective: out.effective, sources: out.sources }
    if (changed.length) this.broadcast({ type: 'config:changed', changed, ...out })
    return res
  }

  private restartRequiredKeys(): string[] {
    return this.allDescriptors.filter(d => d.applies === 'restart' && this.overrides[d.key] !== undefined).map(d => d.key)
  }

  private broadcast(payload: ConfigEventPayload): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(payload)
      }
      catch (err) {
        console.error('[system-config] 广播监听器异常:', err)
      }
    }
  }

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

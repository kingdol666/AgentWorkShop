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
  private map = new Map<string, SettingsDescriptor>()
  private overrides: Record<string, unknown> = {}
  private envOverrides: Record<string, unknown> = {}
  private effective: Record<string, unknown> = {}
  private sources: Record<string, 'config.yml' | 'runtime' | 'env'> = {}
  private listeners = new Set<Listener>()
  private configPath = ''
  private settingsPath = ''
  private watcher: ReturnType<typeof watch>[] = []
  private reloadTimer: NodeJS.Timeout | null = null
  private disposed = false
  private applyWarned = false

  constructor(readonly root: string) {
    this.configPath = join(root, 'config.yml')
    // 设置文件必须与 CLI(aw config set)/start/dev-guard 同源(resolveRunMode 单一入口):
    // 原先写死 <cwd>/data/runtime-settings.json 造成"API 写 A、子系统读 B"的脑裂 —— 备份
    // 周期/保留期/DAQ 覆盖等运行时设置对服务端静默无效。
    const rm = resolveRunMode({ cwd: root, packageRoot: process.env.AW_PACKAGE_ROOT, env: process.env })
    this.configPath = rm.configPath ?? this.configPath
    this.settingsPath = rm.settingsPath ?? this.settingsPath
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
    this.map = loadDescriptorMap(this.descriptors)
    this.envOverrides = envOverridesFromEnv(process.env, this.descriptors)
    this.reloadFromDisk()
    this.watchFiles()
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
    for (const desc of this.descriptors) {
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
      const desc = this.map.get(key)
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
      descriptors: this.descriptors,
      effective: { ...this.effective },
      overrides: { ...this.overrides },
      sources: { ...this.sources },
      settingsPath: this.settingsPath,
      configPath: this.configPath,
    }
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
      const desc = this.map.get(key)
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
    return this.descriptors.filter(d => d.applies === 'restart' && this.overrides[d.key] !== undefined).map(d => d.key)
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

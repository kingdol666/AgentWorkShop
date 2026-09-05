/**
 * 运行语义设置读取(服务端唯一入口;配置驱动 first)。
 *
 * 与构建期 loadConfig(app/config)解耦:server 树内引用树外模块会触发 nitro dev
 * 的外部化缺陷(相对路径溢出盘符根),故本模块走 @/shared 别名 + 描述符体系。
 *
 * 值的解析链(shared/config/schema.json 描述符为单一事实来源):
 *   描述符默认 < config.yml < <configRoot>/runtime-settings.json < 环境变量(AW_<键> / 历史别名)
 * 键=描述符 key(config.yml 中同形;zod 于构建期校验,运行时以描述符默认兜底)。
 * 结果进程内缓存 3s(键均为 restart 级;热改配置重启生效,无需更低延迟)。
 */
import { join } from 'node:path'
import {
  loadEffective,
} from '@/shared/config/engine.mjs'
import { resolveRunMode } from '@/shared/config/home.mjs'

let cache: { at: number, effective: Record<string, unknown> } | null = null
const TTL_MS = 3000

function effective(): Record<string, unknown> {
  // 首选:SystemConfigService 内存权威(设置页/CLI/文件监听三路写入的同一份即时状态,
  // 热重载零延迟)。未装配(restart 键生效前的极早期/单测)回落文件链 + 3s TTL 缓存。
  try {
    const svc = (globalThis as { __systemConfig?: { ready?: boolean, snapshot?: () => { effective: Record<string, unknown> } } }).__systemConfig
    if (svc?.ready && svc.snapshot) {
      const snap = svc.snapshot()
      if (Object.keys(snap.effective).length > 0) return snap.effective
    }
  }
  catch { /* 服务不可用 → 文件链 */ }
  if (cache && Date.now() - cache.at < TTL_MS) return cache.effective
  const runMode = resolveRunMode({
    cwd: process.cwd(),
    packageRoot: process.env.AW_PACKAGE_ROOT ?? process.cwd(),
    env: process.env,
  })
  const eff = loadEffective({
    configPath: runMode.configPath,
    settingsPath: runMode.settingsPath ?? join(runMode.configRoot, 'runtime-settings.json'),
    env: process.env,
  })
  cache = { at: Date.now(), effective: eff.effective }
  return eff.effective
}

/** 主动失效进程内缓存:settings 写路径(PATCH/CLI/文件监听)变更后调用,使 live 键即时可见 */
export function invalidateRuntimeSettingsCache(): void {
  cache = null
}

/** 按描述符键读单值(键必已注册 schema.json;缺键 = 描述符默认) */
export function settingOf(key: string): unknown {
  return effective()[key]
}

/** 聚合组(前缀匹配;dotted 键 → 平铺键名,如 memory.primer_tokens → { primer_tokens }) */
function section<G extends string>(group: string): G {
  const out: Record<string, unknown> = {}
  const prefix = `${group}.`
  for (const [k, v] of Object.entries(effective())) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v
  }
  return out as G
}

// ---------- 类型化组(形状与 app/config zod、schema.json 描述符三处一致) ----------

export interface MemorySettings {
  primer_tokens: number
  inject_total: number
  maintenance_ms: number
  expire_days: number
  expire_session_days: number
  cap: number
  reflect_trigger: number
  embed_base_url: string
  embed_model: string
  embed_api_key: string
}
export interface OmpSettings {
  compact_enabled: boolean
  compact_threshold: number
  compact_min_interval_ms: number
  compact_wait_ms: number
}
export interface HarnessSettings {
  opencode_command: string
  codex_command: string
  dsh_command: string
  hitl_timeout_ms: number
}
export interface DcwSettings {
  rollback_cooldown_ms: number
  rollback_min_window_ms: number
  rollback_baseline_ms: number
  rollback_stale_ms: number
}
export interface WorkshopSettings {
  idle_sweep_ms: number
  idle_grace_ms: number
}
export interface BackupSettings {
  disabled: boolean
  interval_hours: number
  keep: number
}
export interface RetentionSettings {
  disabled: boolean
  events_days: number
  messages_days: number
  audit_days: number
  approval_days: number
}
export interface LogSettings {
  level: 'debug' | 'info' | 'warn' | 'error'
}
export interface DaqRuntimeSettings {
  mqtt: {
    host: string
    port: number
    username: string
    password: string
    secure: boolean
    caFile: string
    qos: number
    rejectUnauthorized: boolean
  }
  /** 采样节拍(节点 intervalMs 未显式指定时的默认值与可配置下限;live 可调) */
  sampling: {
    defaultIntervalMs: number
    minIntervalMs: number
  }
  /** 时序查询节拍(bucketMs 缺省值与下限;samples/产线查询/Agent daq_query 共用) */
  query: {
    defaultBucketMs: number
    minBucketMs: number
  }
  tsRetentionH: number
  frameRetentionH: number
  alarmWebhookUrl: string
  alarmEscalateMinutes: number
}

export const memorySettings = (): MemorySettings => section<MemorySettings>('memory')
export const ompSettings = (): OmpSettings => section<OmpSettings>('omp')
export const harnessSettings = (): HarnessSettings => section<HarnessSettings>('harness')
export const dcwSettings = (): DcwSettings => section<DcwSettings>('dcw')
export const workshopSettings = (): WorkshopSettings => section<WorkshopSettings>('workshop')
export const backupSettings = (): BackupSettings => section<BackupSettings>('backup')
export const retentionSettings = (): RetentionSettings => section<RetentionSettings>('retention')
export const logSettings = (): LogSettings => section<LogSettings>('log')
export function daqRuntimeSettings(): DaqRuntimeSettings {
  const e = effective()
  const get = (k: string, dflt: unknown): unknown => (e[`daq.${k}`] === undefined ? dflt : e[`daq.${k}`])
  return {
    mqtt: {
      host: String(get('mqtt.host', '127.0.0.1')),
      port: Number(get('mqtt.port', 1883)),
      username: String(get('mqtt.username', '')),
      password: String(get('mqtt.password', '')),
      secure: Boolean(get('mqtt.secure', false)),
      caFile: String(get('mqtt.caFile', '')),
      qos: Number(get('mqtt.qos', 0)),
      rejectUnauthorized: Boolean(get('mqtt.rejectUnauthorized', true)),
    },
    tsRetentionH: Number(get('tsRetentionH', 168)),
    frameRetentionH: Number(get('frameRetentionH', 720)),
    alarmWebhookUrl: String(get('alarmWebhookUrl', '')),
    alarmEscalateMinutes: Number(get('alarmEscalateMinutes', 15)),
    sampling: {
      defaultIntervalMs: Number(get('sampling.defaultIntervalMs', 5000)),
      minIntervalMs: Number(get('sampling.minIntervalMs', 1000)),
    },
    query: {
      defaultBucketMs: Number(get('query.defaultBucketMs', 15000)),
      minBucketMs: Number(get('query.minBucketMs', 1000)),
    },
  }
}
export function securityHitlTimeoutMs(): number {
  return Number(effective()['security.hitl_timeout_ms'] ?? 180_000)
}

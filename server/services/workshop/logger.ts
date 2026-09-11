/**
 * 极简结构化日志(R4):级别 + JSON 行,配置驱动。
 * - log.level(设置描述符;env AWSHOP_LOG_LEVEL 兼容别名)= debug|info|warn|error(默认 info)
 * - 输出:单行 JSON(t/level/scope/msg/args),error/warn 走 stderr,其余 stdout
 * - 范围收敛:仅替换 server/services/workshop 目录的 console 直出
 *   (request-log、plugins、mcp 的 console 保留,见计划 R4-2,避免全量替换的回归面)
 * - 同指纹限流(opt-in:warnThrottled / rateLimited):同 scope + 归一化后同文本在一个窗口内
 *   只出首条,其余计数,窗口关闭补一条摘要 —— 防止单条消息刷盘淹没真实错误。
 *   P0 背景:opcua 驱动每建连告警一条 securityMode=None,实测约 7 行/秒把生产日志灌到
 *   18MB 且 100% 为同一句。基础四方法(debug/info/warn/error)语义不变。
 */
import { settingOf } from './settings'
// 必须走 @ 别名(与 shared/config/engine.mjs 一致):裸相对路径在 nitro dev 的
// 服务端 bundle 里按输出目录重算,Windows 上 ../../.. 会溢出盘符根
// → 'Cannot find module D:\shared\lru.mjs'(构建期 inline 兜不住 dev)。
import { LruMap } from '@/shared/lru.mjs'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** 同指纹限流窗口(ms):窗口内同 scope + 同归一化文本只出首条 */
export const THROTTLE_WINDOW_MS = 60_000
/** 指纹表容量上限(必须 > 0;LruMap 逐出最久未用,表永不无界增长) */
export const THROTTLE_MAX_FINGERPRINTS = 512
/** 过期窗口惰性结算的最小间隔(ms;避免每次调用都全表扫描) */
const THROTTLE_SWEEP_MS = 1_000

function minLevel(): LogLevel {
  // 配置未就绪/解析失败回落 info(日志层永不因配置抛错)
  try {
    const v = settingOf('log.level') as LogLevel
    return v && v in LEVELS ? v : 'info'
  }
  catch {
    return 'info'
  }
}

/** 安全序列化:Error → stack,循环引用降级为 [Circular],序列化失败降级 String */
function safe(value: unknown): unknown {
  if (value instanceof Error) return value.stack ?? String(value)
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.parse(JSON.stringify(value))
    }
    catch {
      return '[Unserializable]'
    }
  }
  return value
}

/** 行输出槽:默认真实 stdout/stderr(生产行为不变);测试/嵌入方注入自有 sink */
export interface LogSink {
  /** 非 error/warn 级别(默认 stdout) */
  out(line: string): void
  /** error/warn 级别(默认 stderr) */
  err(line: string): void
}

const consoleSink: LogSink = {
  out: line => console.log(line),
  err: line => console.error(line),
}

/**
 * 归一化指纹文本:ISO 时间戳与数字串 → 占位符。
 * 'poll 1234 ms' 与 'poll 5678 ms' 归为同键;键是廉价字符串,不做对象序列化。
 */
export function normalizeFingerprint(msg: string): string {
  return msg
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\d+/g, '<n>')
}

/** 单指纹窗口状态(仅 suppressed>0 的条目会在窗口关闭时补摘要) */
interface ThrottleEntry {
  level: LogLevel
  windowStart: number
  suppressed: number
}

/** 有界指纹表的最小类型面(LruMap 为树外 .mjs,无类型声明) */
interface FingerprintTable {
  readonly size: number
  get(key: string): ThrottleEntry | undefined
  set(key: string, value: ThrottleEntry): unknown
  delete(key: string): unknown
  entries(): Iterable<[string, ThrottleEntry]>
  values(): Iterable<ThrottleEntry>
  stats(): { size: number, max: number, evictions: number }
}

/** 限流器内部状态(回归测试断言表有界;不参与业务) */
export interface ThrottleStats {
  /** 当前指纹条目数(恒 ≤ max) */
  size: number
  max: number
  /** 当前窗口内尚未结算的抑制计数合计 */
  suppressed: number
  /** 已结算(已补摘要)的窗口数 */
  windows: number
  /** 因容量上限被逐出的指纹数(逐出即丢弃其未结算计数) */
  evictions: number
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
  /** opt-in 同指纹限流(任意级别;上面四个方法不经过此路径) */
  rateLimited(level: LogLevel, msg: string, ...args: unknown[]): void
  /** warn 级同指纹限流(高频告警点收口:首条全量,窗口内其余计数,窗口关闭补摘要) */
  warnThrottled(msg: string, ...args: unknown[]): void
  /** 结算已到期窗口的抑制摘要(true = 连未到期窗口一并结算;进程退出/测试用) */
  flushThrottled(force?: boolean): void
  /** 限流器状态快照 */
  throttleStats(): ThrottleStats
}

export function createLogger(scope: string, sink: LogSink = consoleSink): Logger {
  const emit = (level: LogLevel, msg: string, args: unknown[]): void => {
    if (LEVELS[level] < LEVELS[minLevel()]) return
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      scope,
      msg,
      ...(args.length ? { args: args.map(safe) } : {}),
    })
    if (level === 'error' || level === 'warn') sink.err(line)
    else sink.out(line)
  }

  // ---------- opt-in 同指纹限流(表有界;基础四方法不经过此路径) ----------
  const table = new LruMap(THROTTLE_MAX_FINGERPRINTS) as unknown as FingerprintTable
  let lastSweep = 0
  let windows = 0

  /** 结算一个窗口:有抑制则补一条摘要,并移除条目(下次调用重建窗口,表随用随收) */
  const settle = (key: string, entry: ThrottleEntry): void => {
    table.delete(key)
    if (entry.suppressed <= 0) return
    windows += 1
    emit(entry.level, `[log-throttle] 同指纹消息在 ${THROTTLE_WINDOW_MS}ms 窗口内被抑制 ${entry.suppressed} 条(scope=${scope})`, [])
  }

  /** 惰性结算已到期窗口(最多每秒一次;顺带回收条目,长时间静默的指纹不占表) */
  const sweep = (now: number): void => {
    if (now - lastSweep < THROTTLE_SWEEP_MS) return
    lastSweep = now
    for (const [key, entry] of table.entries()) {
      if (entry.suppressed > 0 && now - entry.windowStart >= THROTTLE_WINDOW_MS) settle(key, entry)
    }
  }

  const throttledEmit = (level: LogLevel, msg: string, args: unknown[]): void => {
    if (LEVELS[level] < LEVELS[minLevel()]) return
    const now = Date.now()
    sweep(now)
    const key = `${scope}\u0000${level}\u0000${normalizeFingerprint(msg)}`
    const hit = table.get(key)
    if (hit === undefined) {
      table.set(key, { level, windowStart: now, suppressed: 0 })
      emit(level, msg, args)
      return
    }
    if (now - hit.windowStart < THROTTLE_WINDOW_MS) {
      hit.suppressed += 1
      return
    }
    // 窗口关闭:先补摘要,本条即新窗口首条(全量输出)
    settle(key, hit)
    table.set(key, { level, windowStart: now, suppressed: 0 })
    emit(level, msg, args)
  }

  const flushThrottled = (force = false): void => {
    const now = Date.now()
    lastSweep = now
    const due: [string, ThrottleEntry][] = []
    for (const [key, entry] of table.entries()) {
      if (entry.suppressed > 0 && (force || now - entry.windowStart >= THROTTLE_WINDOW_MS)) due.push([key, entry])
    }
    for (const [key, entry] of due) settle(key, entry)
  }

  const throttleStats = (): ThrottleStats => {
    let suppressed = 0
    for (const entry of table.values()) suppressed += entry.suppressed
    const s = table.stats()
    return { size: s.size, max: s.max, suppressed, windows, evictions: s.evictions }
  }

  return {
    debug: (msg, ...args) => emit('debug', msg, args),
    info: (msg, ...args) => emit('info', msg, args),
    warn: (msg, ...args) => emit('warn', msg, args),
    error: (msg, ...args) => emit('error', msg, args),
    rateLimited: (level, msg, ...args) => throttledEmit(level, msg, args),
    warnThrottled: (msg, ...args) => throttledEmit('warn', msg, args),
    flushThrottled,
    throttleStats,
  }
}

/**
 * 极简结构化日志(R4):级别 + JSON 行,配置驱动。
 * - log.level(设置描述符;env AWSHOP_LOG_LEVEL 兼容别名)= debug|info|warn|error(默认 info)
 * - 输出:单行 JSON(t/level/scope/msg/args),error/warn 走 stderr,其余 stdout
 * - 范围收敛:仅替换 server/services/workshop 目录的 console 直出
 *   (request-log、plugins、mcp 的 console 保留,见计划 R4-2,避免全量替换的回归面)
 */
import { settingOf } from './settings'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

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

export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel, msg: string, args: unknown[]): void => {
    if (LEVELS[level] < LEVELS[minLevel()]) return
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      scope,
      msg,
      ...(args.length ? { args: args.map(safe) } : {}),
    })
    if (level === 'error' || level === 'warn') console.error(line)
    else console.log(line)
  }
  return {
    debug: (msg, ...args) => emit('debug', msg, args),
    info: (msg, ...args) => emit('info', msg, args),
    warn: (msg, ...args) => emit('warn', msg, args),
    error: (msg, ...args) => emit('error', msg, args),
  }
}

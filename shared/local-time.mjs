/**
 * 配置时区时间底座(单一事实来源)。
 * 人读时间/文本记录按系统 IANA 时区输出带偏移 ISO；DAQ/Timescale 等机器时间轴
 * 仍使用 epoch/timestamptz。installLocalIso() 保留旧 API 名称，但读取 globalThis
 * 上的可热更新配置，确保 Nitro bundle 中多个模块副本共享同一时区。
 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const TIME_ZONE_KEY = '__awConfiguredTimeZone'

// Intl.DateTimeFormat 构造是最贵的 Intl 操作;热路径(每条日志/WS 帧/DB 行都带时间戳)
// 必须按 timeZone 缓存 formatter、缓存时区校验结果,否则高频时间戳会把 CPU 打满。
const partsFormatterCache = new Map()
function partsFormatter(timeZone) {
  let f = partsFormatterCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    })
    partsFormatterCache.set(timeZone, f)
  }
  return f
}
const offsetFormatterCache = new Map()
function offsetFormatter(timeZone) {
  let f = offsetFormatterCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
    offsetFormatterCache.set(timeZone, f)
  }
  return f
}

function configuredTimeZoneValue() {
  const g = globalThis
  return typeof g[TIME_ZONE_KEY] === 'string' ? g[TIME_ZONE_KEY] : DEFAULT_TIME_ZONE
}

const validTimeZoneCache = new Set()
export function isValidTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  if (validTimeZoneCache.has(value)) return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    validTimeZoneCache.add(value)
    return true
  }
  catch {
    return false
  }
}

export function supportedTimeZones() {
  let values = []
  try {
    if (typeof Intl.supportedValuesOf === 'function') values = Intl.supportedValuesOf('timeZone')
  }
  catch {
    values = []
  }
  const fallback = [
    'UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Seoul',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/Los_Angeles',
    'America/Denver', 'America/Chicago', 'America/New_York', 'Australia/Sydney',
  ]
  return [...new Set([DEFAULT_TIME_ZONE, 'UTC', ...values, ...fallback])].filter(isValidTimeZone).sort()
}

export function getConfiguredTimeZone() {
  return configuredTimeZoneValue()
}

export function setConfiguredTimeZone(value) {
  if (!isValidTimeZone(value)) throw new RangeError(`Invalid IANA time zone: ${value}`)
  globalThis[TIME_ZONE_KEY] = value
  return value
}

function pad(value, width) {
  return String(value).padStart(width, '0')
}

function dateParts(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) throw new RangeError('Invalid time value')
  const parts = partsFormatter(timeZone).formatToParts(d)
  const values = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]))
  const offsetText = offsetFormatter(timeZone).formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? 'GMT'
  const match = offsetText.match(/^GMT([+-])(\d{2}):(\d{2})$/)
  const offsetMinutes = match
    ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3]))
    : 0
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
    millisecond: d.getMilliseconds(), offsetMinutes,
  }
}

export function formatIsoInTimeZone(date, timeZone = configuredTimeZoneValue()) {
  if (!isValidTimeZone(timeZone)) throw new RangeError(`Invalid IANA time zone: ${timeZone}`)
  const parts = dateParts(date, timeZone)
  const sign = parts.offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(parts.offsetMinutes)
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`
    + `T${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}`
    + `.${pad(parts.millisecond, 3)}${sign}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`
}

export function formatPartsInTimeZone(date, timeZone = configuredTimeZoneValue()) {
  if (!isValidTimeZone(timeZone)) throw new RangeError(`Invalid IANA time zone: ${timeZone}`)
  return dateParts(date, timeZone)
}

export function configuredTimeZoneOffset(date = new Date(), timeZone = configuredTimeZoneValue()) {
  return dateParts(date, timeZone).offsetMinutes
}

/** 兼容旧入口:重复安装不覆盖原始实现;后续 setter 影响所有新调用。 */
export function installLocalIso() {
  const proto = Date.prototype
  if (proto.__origToISOString) return
  const orig = proto.toISOString
  proto.__origToISOString = orig
  proto.toISOString = function () {
    return formatIsoInTimeZone(this, configuredTimeZoneValue())
  }
}

export function nowConfiguredIso() {
  return formatIsoInTimeZone(new Date(), configuredTimeZoneValue())
}

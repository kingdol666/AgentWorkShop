/**
 * 系统时区格式化入口。
 * 服务端通过 /api/system/timezone 提供 IANA 时区；SSR/首屏默认 Asia/Shanghai，
 * 客户端 mounted 后同步当前设置。历史 ISO(带 Z/任意 offset)始终按绝对时刻解析。
 */
const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
let systemTimeZone = DEFAULT_TIME_ZONE
let loaded = false

export function getSystemTimeZone(): string {
  return systemTimeZone
}

export function setSystemTimeZone(value: string): string {
  if (!value) return systemTimeZone
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    systemTimeZone = value
  }
  catch { /* 非法/未知 IANA 名称保持当前值 */ }
  return systemTimeZone
}

export function useSystemTimeZone() {
  const timeZone = useState('system-time-zone', () => systemTimeZone)
  const loading = useState('system-time-zone-loading', () => false)
  const refresh = async () => {
    if (loading.value) return
    loading.value = true
    try {
      const fetchTimezone = $fetch as unknown as (url: string) => Promise<{ timeZone?: string }>
      const data = await fetchTimezone('/api/system/timezone')
      if (data?.timeZone) {
        setSystemTimeZone(data.timeZone)
        timeZone.value = systemTimeZone
      }
    }
    finally {
      loading.value = false
      loaded = true
    }
  }
  if (import.meta.client && !loaded) void refresh()
  return { timeZone, loading, refresh }
}

function parseDate(iso: string | undefined | null): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

function partsFor(iso: string | undefined | null): Record<string, string> | null {
  const d = parseDate(iso)
  if (!d) return null
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: systemTimeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).filter(p => p.type !== 'literal').map(p => [p.type, p.value]))
}

/** ISO 绝对时刻 → 系统时区 HH:MM:SS */
export function formatLocalClock(iso: string | undefined | null, withSeconds = true): string {
  const p = partsFor(iso)
  if (!p) return ''
  return `${p.hour}:${p.minute}${withSeconds ? `:${p.second}` : ''}`
}

/** ISO 绝对时刻 → 系统时区 YYYY-MM-DD HH:MM */
export function formatLocalStamp(iso: string | undefined | null): string {
  const p = partsFor(iso)
  if (!p) return ''
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

export const formatSystemClock = formatLocalClock
export const formatSystemStamp = formatLocalStamp

/** 当前绝对时刻 → 系统时区带偏移 ISO。浏览器上报字段与服务端格式一致。 */
export function nowLocalIso(): string {
  const d = new Date()
  const p = partsFor(d.toISOString())
  if (!p) return d.toISOString()
  const offsetText = new Intl.DateTimeFormat('en-US', { timeZone: systemTimeZone, timeZoneName: 'longOffset', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).find(x => x.type === 'timeZoneName')?.value ?? 'GMT'
  const match = offsetText.match(/^GMT([+-])(\d{2}):(\d{2})$/)
  const offsetMinutes = match ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3])) : 0
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${String(d.getMilliseconds()).padStart(3, '0')}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

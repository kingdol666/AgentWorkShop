/**
 * 本地时间格式化 — 服务端时间以 UTC ISO 8601(`toISOString()` 带 Z 后缀)存储,
 * 前端展示须转成用户本地时区。直接对 ISO 字符串 `.slice(11, 19)` 会拿到 UTC 时刻
 * (当地时间 = UTC + 时区偏移),导致聊天/工具/事件时间偏移。
 *
 * 统一入口:把 ISO 绝对时刻 → 本地 `HH:MM:SS` 或 `HH:MM`。
 * 空值/非法输入返回 ''(调用方按空处理,不渲染幽灵时间)。
 */

/** ISO 绝对时刻 → 本地 `HH:MM:SS`(秒时+秒,精确到秒) */
export function formatLocalClock(iso: string | undefined | null, withSeconds = true): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (!withSeconds) return `${hh}:${mm}`
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** ISO 绝对时刻 → 本地 `YYYY-MM-DD HH:MM`(跨日分隔/完整时间戳用,含日期更稳妥) */
export function formatLocalStamp(iso: string | undefined | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${da} ${hh}:${mi}`
}

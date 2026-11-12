/**
 * 告警呈现的纯函数(第二轮 E1)。
 *
 * 仪表盘告警卡原先直接显示 `nodeName`、`metric`、`rule` 与 6 位 id,
 * 对操作者是内部编码而不是一句人话。这里只做与语言无关的拆分/格式化,
 * 文案由组件按 i18n 组装。
 */

export interface AlarmRuleView {
  relation: 'high' | 'low' | 'other'
  operator: string
  value: string
  threshold: string
}

export interface AlarmAge {
  unit: 'now' | 'minute' | 'hour' | 'day' | 'unknown'
  n: number
}

/** 未确认告警数:单一来源是 `daq.alarms`,不按节点状态推断。 */
export function alarmCountOf(alarms: readonly unknown[] | null | undefined): number {
  return Array.isArray(alarms) ? alarms.length : 0
}

/**
 * `演示·出水水质检测站(HTTP)·CodOut` → { device: '出水水质检测站', channel: 'CodOut' }
 * 设备名的协议括号是接入细节,通道名才是操作者要看的测点。
 */
export function splitAlarmNode(nodeName: string): { device: string, channel: string } {
  const raw = String(nodeName ?? '').trim()
  if (!raw) return { device: '', channel: '' }
  const parts = raw.split('·').map(s => s.trim()).filter(s => s && s !== '演示')
  let device = parts.length > 1 ? parts.slice(0, -1).join('·') : parts[0] ?? ''
  const channel = parts.length > 1 ? parts[parts.length - 1] ?? '' : ''
  device = device.replace(/^演示·/, '').replace(/\s*\([^)]*\)\s*$/, '').trim()
  return { device, channel }
}

function num(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** 规则句的数值部分:gt-max/lt-min 是目前服务端会产生的两类;其它规则保留原文。 */
export function alarmRuleView(rule: string, value: number | null, threshold: number | null): AlarmRuleView {
  if (rule === 'gt-max') {
    return { relation: 'high', operator: '>', value: num(value), threshold: num(threshold) }
  }
  if (rule === 'lt-min') {
    return { relation: 'low', operator: '<', value: num(value), threshold: num(threshold) }
  }
  return { relation: 'other', operator: '', value: num(value), threshold: num(threshold) }
}

/** 相对时间:卡片右上角一眼判断新旧,精确时间留给 title。 */
export function alarmAge(at: string, now: number = Date.now()): AlarmAge {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return { unit: 'unknown', n: 0 }
  const diff = Math.max(now - t, 0)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return { unit: 'now', n: 0 }
  if (min < 60) return { unit: 'minute', n: min }
  const hour = Math.floor(min / 60)
  if (hour < 24) return { unit: 'hour', n: hour }
  return { unit: 'day', n: Math.floor(hour / 24) }
}

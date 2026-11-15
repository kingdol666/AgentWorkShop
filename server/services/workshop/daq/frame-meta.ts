/**
 * 帧 meta / metrics 递归净化(2026-11-15 测评 P2)。
 *
 * 帧信封来自驱动/插件(process-inproc/mqtt/opcua…),metrics 的 TS 类型虽为
 * Record<string, number>,运行时并不保证:插件可能塞入嵌套对象、NaN/Infinity、
 * 超长数组、循环引用或 `__proto__` 键。这些值直接 JSON.stringify 落库会:
 *  - 循环引用/过大对象抛错 → 整批帧写失败;
 *  - NaN/Infinity 变成 null,前端图表出现空洞;
 *  - 原型污染键进入对象后再被消费面合并。
 *
 * 本模块递归收敛为 JSON-safe 的纯数据:限深/限键/限数组/限字符串,
 * 丢弃非有限数字与危险键,循环引用直接跳过。
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_DEPTH = 4
const MAX_KEYS = 64
const MAX_ARRAY = 256
const MAX_STRING = 512

function safeKey(key: string): boolean {
  return !DANGEROUS_KEYS.has(key) && key.length <= 128
}

/** JSON-safe 标量/数组/对象净化;无法表示的值返回 undefined(调用方丢弃该键)。 */
function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
  if (typeof value !== 'object') return undefined
  if (depth >= MAX_DEPTH) return undefined
  if (seen.has(value)) return undefined
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = []
      for (const item of value.slice(0, MAX_ARRAY)) {
        const clean = sanitizeValue(item, depth + 1, seen)
        if (clean !== undefined) out.push(clean)
      }
      return out
    }
    const out: Record<string, unknown> = {}
    let count = 0
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (count >= MAX_KEYS) break
      if (!safeKey(key)) continue
      const clean = sanitizeValue(item, depth + 1, seen)
      if (clean !== undefined) {
        out[key] = clean
        count += 1
      }
    }
    return out
  }
  finally {
    seen.delete(value)
  }
}

/** 帧 meta(图像对象键/向量点列等)净化;非对象输入 → {}。 */
export function sanitizeFrameMeta(value: unknown): Record<string, unknown> {
  const clean = sanitizeValue(value, 0, new WeakSet())
  return clean && typeof clean === 'object' && !Array.isArray(clean)
    ? clean as Record<string, unknown>
    : {}
}

/**
 * 指标净化:只保留有限数字。
 * metrics 的消费面(告警规则/图表)只认数值,嵌套对象/字符串没有语义。
 */
export function sanitizeFrameMetrics(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  let count = 0
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_KEYS) break
    if (!safeKey(key)) continue
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n)) continue
    out[key] = n
    count += 1
  }
  return out
}

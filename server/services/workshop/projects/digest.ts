/**
 * Project 层请求摘要：write_intent 的 args_digest 单一实现。
 *
 * 稳定序列化（键排序）保证同一参数对象在「申请审批」与「执行消费」两端
 * 得到同一个 sha256；数组顺序保留（参数语义可能依赖顺序）。
 */
import { createHash } from 'node:crypto'

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function argsDigest(args: Record<string, unknown> | undefined): string {
  return createHash('sha256').update(stableStringify(args ?? {})).digest('hex')
}

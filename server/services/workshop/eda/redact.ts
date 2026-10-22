/**
 * redact —— 请求模板回显的凭据脱敏(MES 调试台 req 回显专用,plan1 BLOCKER B3)。
 *
 * historyMap.read/write/history 的 headers/query 是声明式 JSON,放
 * Authorization/Cookie/api-key 是这类驱动的常规用法;调试台把请求模板回显给
 * 前端时必须按 key 黑名单剔除值,且绝不回显 driverConfig 原文。
 */

/** 敏感 key 黑名单(headers 与 query 共用;大小写/连写下划线不敏感) */
const SENSITIVE_KEY = /(authorization|cookie|set-cookie|token|secret|api[-_]?key|x-api[-_]?key|password|credential|signature)/i

/** 逐 key 脱敏:命中黑名单的值替换为 '***',key 名保留(用户仍能看到"这里有个头") */
export function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = SENSITIVE_KEY.test(k) ? '***' : String(v ?? '')
  }
  return out
}

/** query 同口径脱敏(from/to 等普通参数原样保留) */
export function redactQuery(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(query ?? {})) {
    out[k] = SENSITIVE_KEY.test(k) ? '***' : String(v ?? '')
  }
  return out
}

/**
 * 基址与令牌解析 / JSON 请求 / 规则解析 / CSV 与数值格式化
 * (由 server/plugins-builtin/diag-bridge/index.mjs 按职责拆出;内容逐行原文搬运)
 */
import { DEFAULT_BASE } from './constants.mjs'

export function baseOf(ctx) {
  const raw = String(ctx.config?.get?.('plugins.diag-bridge.base_url') || ctx.kv.get('diag.base_url') || DEFAULT_BASE).trim()
  try {
    const u = new URL(raw)
    const okProto = u.protocol === 'http:' || u.protocol === 'https:'
    const okHost = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
    if (!okProto || !okHost) return null
    return raw.replace(/\/+$/, '')
  }
  catch {
    return null
  }
}

/** 诊断服务鉴权 token(系统配置 plugins.diag-bridge.token 优先,kv diag.token 兜底;空=匿名)。
 *  诊断服务 v4 起默认强制 Bearer(AUTH_ENABLED!==0),401 AUTH_REQUIRED 时先查这里。 */
export function diagTokenOf(ctx) {
  return String(ctx.config?.get?.('plugins.diag-bridge.token') || ctx.kv.get('diag.token') || '').trim()
}

export function authHeadersOf(ctx) {
  const t = diagTokenOf(ctx)
  return t ? { authorization: `Bearer ${t}` } : {}
}

// ── 配置读取(系统配置优先,kv 兜底;前端全局设置→运行配置→插件组可改,保存即热生效) ──

export const harnessOf = ctx => String(ctx.config?.get?.('plugins.diag-bridge.harness') || ctx.kv.get('diag.harness') || 'omp')
export const maxTurnsOf = ctx => Number(ctx.config?.get?.('plugins.diag-bridge.max_turns')) || Number(ctx.kv.get('diag.max_turns')) || 220
export const maxMinutesOf = ctx => Number(ctx.config?.get?.('plugins.diag-bridge.max_minutes')) || Number(ctx.kv.get('diag.max_minutes')) || 40
/** 自动诊断开关:系统配置布尔或 kv 'true'(kv 为历史字符串语义) */
export const autoEnabledOf = ctx => ctx.config?.get?.('plugins.diag-bridge.auto_enabled') === true || ctx.kv.get('auto_diag_enabled') === 'true'
export const autoRulesOf = ctx => String(ctx.config?.get?.('plugins.diag-bridge.auto_rules') || ctx.kv.get('auto_rules') || '')

export const runKey = id => `run:${id}`

/** kv 中全部 run 记录 → [{ id, meta }] */
export function kvRuns(ctx) {
  const out = []
  for (const [k, v] of Object.entries(ctx.kv.all())) {
    if (k.startsWith('run:') && v && typeof v === 'object') out.push({ id: k.slice(4), meta: v })
  }
  return out
}

/** 该产线是否有运行中的诊断 */
export function runningOfLine(ctx, line) {
  return kvRuns(ctx).find(r => r.meta?.status === 'running' && r.meta?.line === line) ?? null
}

/** 短 JSON 摘要(错误信息用) */
export function short(body) {
  try {
    return JSON.stringify(body).slice(0, 200)
  }
  catch {
    return String(body)
  }
}

/** 401 时给可操作的修复指引(生产最常见故障:会话 token 随诊断服务重启失效) */
export function authHint(status, msg) {
  if (status !== 401) return msg
  return `${msg};修复:在 系统设置→运行配置→插件 更新「诊断 API Token」(推荐使用诊断服务侧的持久化 API Token,idd_ 前缀,服务重启不失效)`
}

/** JSON GET:断言 HTTP ok 且 body.success===true,返回 body */
export async function jget(ctx, url, timeoutMs = 8000) {
  const res = await ctx.http.get(url, { timeoutMs, headers: authHeadersOf(ctx) })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(authHint(res.status, `HTTP ${res.status} ${short(body)}`))
  if (!body || body.success !== true) throw new Error(`success!=true ${short(body)}`)
  return body
}

/** JSON POST:断言 HTTP ok 且 body.success===true,返回 body(extraHeaders 供 KB 端点叠加鉴权) */
export async function jpost(ctx, url, body, timeoutMs = 15000, extraHeaders = {}) {
  const res = await ctx.http.post(url, body, { timeoutMs, headers: { ...authHeadersOf(ctx), ...extraHeaders } })
  const out = await res.json().catch(() => null)
  if (!res.ok) throw new Error(authHint(res.status, `HTTP ${res.status} ${short(out)}`))
  if (!out || out.success !== true) throw new Error(`success!=true ${short(out)}`)
  return out
}

/** 解析 auto_rules(kv 存 JSON 字符串 {nodeId:{op:'gt'|'lt',value}}) */
export function parseAutoRules(raw) {
  if (!raw) return {}
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    return obj && typeof obj === 'object' ? obj : {}
  }
  catch {
    return {}
  }
}

/** CSV 单元格转义(含逗号/引号/换行时加引号) */
export function csvCell(v) {
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 数值格式化(保留 6 位小数,去尾零;非有限值 → 空) */
export function fmtNum(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ''
  return String(Math.round(v * 1e6) / 1e6)
}

/** 快照文件名(ASCII 安全,避免 multipart filename 编码问题) */
export function safeName(line, toMs) {
  const s = String(line).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'line'
  return `snap-${s}-${toMs}.csv`
}

// ── 快照导出器 ───────────────────────────────────────────────────────────

/**
 * 导出产线时窗快照:daq 节点过滤 → 时序查询 → 时间戳 pivot → CSV → multipart 上传。
 * 成功返回 { ok:true, csvPath, rows, nodes, fromMs, toMs };失败返回 { ok:false, error }。
 */

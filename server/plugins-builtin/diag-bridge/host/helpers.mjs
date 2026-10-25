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

/** 未终态(仍占用产线单飞锁):queued 与 running 同等对待 */
export const ACTIVE_RUN_STATUSES = new Set(['queued', 'running'])

/** 该产线是否有未终态的诊断(queued 也占用,否则同线会并发两个任务) */
export function runningOfLine(ctx, line) {
  return kvRuns(ctx).find(r => ACTIVE_RUN_STATUSES.has(r.meta?.status) && r.meta?.line === line) ?? null
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

// ── 分析结果库(Results Library §16)适配层 ─────────────────────────────────
// 设计决策见 docs/plans/2026-10-25-idd-results-library-integration.md §3:
// 默认关闭/角色收敛/双闸门写面/上下文保护/跨机只回 URL/版本探测。

/** JSON PATCH:与 jpost 同构(ctx.http.patch 由 SDK 提供) */
export async function jpatch(ctx, url, body, timeoutMs = 15000) {
  const res = await ctx.http.patch(url, body, { timeoutMs, headers: authHeadersOf(ctx) })
  const out = await res.json().catch(() => null)
  if (!res.ok) throw new Error(authHint(res.status, `HTTP ${res.status} ${short(out)}`))
  if (!out || out.success !== true) throw new Error(`success!=true ${short(out)}`)
  return out
}

/** 结果库总开关(默认关闭:IDD token 是平台级单 token,结果面 = token 属主可见面) */
export const resultsEnabledOf = ctx => ctx.config?.get?.('plugins.diag-bridge.results_enabled') === true || ctx.kv.get('diag.results_enabled') === 'true'
/** 元数据编辑开关(写面双闸门之一;另一道是 lead 角色 + IDD 属主校验) */
export const resultsAllowAnnotateOf = ctx => ctx.config?.get?.('plugins.diag-bridge.results_allow_annotate') === true || ctx.kv.get('diag.results_allow_annotate') === 'true'
/** worker 是否可用读工具(默认 false:只给 lead) */
export const resultsAllowWorkerOf = ctx => ctx.config?.get?.('plugins.diag-bridge.results_allow_worker') === true || ctx.kv.get('diag.results_allow_worker') === 'true'
/** 索引缺省页大小(1-200) */
export function resultsDefaultLimitOf(ctx) {
  const n = Number(ctx.config?.get?.('plugins.diag-bridge.results_default_limit')) || Number(ctx.kv.get('diag.results_default_limit')) || 20
  return Math.min(200, Math.max(1, Math.round(n)))
}
/** report.md 截断上限(500-50000;0 档=完全不带 md) */
export function resultsMdMaxOf(ctx) {
  const n = Number(ctx.config?.get?.('plugins.diag-bridge.results_md_max_chars')) || Number(ctx.kv.get('diag.results_md_max_chars')) || 4000
  return Math.min(50000, Math.max(500, Math.round(n)))
}

/** 结果库能力探测(5 分钟缓存):旧版 IDD 无 §16 时给可行动降级,不冒充空结果 */
export async function probeResults(ctx) {
  const cached = ctx.kv.get('diag.results_probe')
  if (cached) {
    try {
      const parsed = JSON.parse(cached)
      if (Date.now() - parsed.at < 5 * 60_000) return parsed
    }
    catch { /* 缓存损坏则重探 */ }
  }
  const base = baseOf(ctx)
  if (!base) return { ok: false, reason: 'base_url 非法(仅允许 http/https 且 host 为 127.0.0.1/localhost);请到 系统设置→运行配置→插件 修正「诊断服务地址」。' }
  let verdict
  try {
    const res = await ctx.http.get(`${base}/api/external/v1/results?limit=1&brief=true`, { timeoutMs: 6000, headers: authHeadersOf(ctx) })
    if (res.status === 404) {
      verdict = { ok: false, reason: '当前 IDD 版本不含分析结果库(§16);请升级 IDD 后再启用 results_enabled。' }
    }
    else if (res.status === 401) {
      verdict = { ok: false, reason: 'IDD Token 无效或过期;请到 系统设置→运行配置→插件 更新「诊断 API Token」(idd_ 前缀的持久 API Token)。' }
    }
    else if (res.ok) {
      verdict = { ok: true }
    }
    else {
      verdict = { ok: false, reason: `结果库探测失败:HTTP ${res.status};请检查 IDD 服务日志。` }
    }
  }
  catch (err) {
    verdict = { ok: false, reason: `诊断服务不可达(${err?.message ?? err});检查 base_url 与服务状态。` }
  }
  try {
    ctx.kv.set('diag.results_probe', JSON.stringify({ ...verdict, at: Date.now() }))
  }
  catch { /* kv 不可写不影响主流程 */ }
  return verdict
}

/** IDD 错误 → 中文可行动回执(§16.4 全表) */
export function mapResultsError(err) {
  const msg = String(err?.message ?? err)
  if (msg.includes('AUTH_REQUIRED')) return 'IDD Token 无效/过期;请到 系统设置→运行配置→插件 更新「诊断 API Token」。'
  if (msg.includes('RESULTS_QUERY_INVALID')) return '查询参数非法(支持 intent=deep-diagnosis/stability-report/quick-screen/doe-analysis/experience-mining/optimizer-campaign;sort=created_desc/created_asc/score_desc;min_score 为数字)。'
  if (msg.includes('RESULT_PATCH_INVALID')) return '编辑体不合法:至少给 description/tags/title 之一,且 description≤2000 字符、tags≤16 项且单项≤40 字符、title≤200 字符。'
  if (msg.includes('SUMMARY_READONLY')) return 'summary 是系统生成的只读字段;请改 description(用户可读可写的描述)。'
  if (msg.includes('RESULT_FORBIDDEN')) return '该结果不属于当前 Token 的属主;编辑需换成创建它的账号 Token,或由 IDD 管理员操作。'
  if (msg.includes('RESULT_NOT_FOUND')) return 'result_id 不存在、已软删除或对应分析未完成;用 diag_results 重新确认 id。'
  return msg
}

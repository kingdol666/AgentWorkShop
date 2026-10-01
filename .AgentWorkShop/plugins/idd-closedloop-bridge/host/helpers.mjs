/** HTTP 与配置辅助（idd-closedloop-bridge；形态对齐 diag-bridge/helpers.mjs） */

export function baseOf(ctx) {
  const raw = String(ctx.config.get('plugins.idd-closedloop-bridge.base_url') ?? '').trim()
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(raw)) return ''
  return raw.replace(/\/+$/, '')
}

export function tokenOf(ctx) {
  return String(ctx.config.get('plugins.idd-closedloop-bridge.token') ?? '').trim()
}

export function authHeadersOf(ctx) {
  const t = tokenOf(ctx)
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export async function jget(ctx, url, timeoutMs = 10000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: authHeadersOf(ctx), signal: ctrl.signal })
    const body = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

export async function jpost(ctx, url, payload, timeoutMs = 30000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeadersOf(ctx) },
      body: JSON.stringify(payload ?? {}),
      signal: ctrl.signal,
    })
    const body = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

/** 异步任务 KV 跟踪（diag-bridge 同款 kvRuns/runKey 语义） */
const RUNS_KEY = 'idd_closedloop_runs'

export function kvRuns(ctx) {
  try {
    return ctx.kv.get(RUNS_KEY) ?? []
  } catch {
    return []
  }
}

export function kvSaveRuns(ctx, runs) {
  ctx.kv.set(RUNS_KEY, runs)
}

export function runKey(id) {
  return `iddcl:${id}`
}

export function trackTask(ctx, { taskId, kind, meta }) {
  const runs = kvRuns(ctx).filter(r => r.id !== taskId)
  runs.push({ id: taskId, kind, meta: { status: 'running', createdAt: Date.now(), ...meta } })
  kvSaveRuns(ctx, runs.slice(-200))
}

export function text(result) {
  return { text: result }
}

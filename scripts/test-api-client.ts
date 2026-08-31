/** apiClient 单测:信封解析 / ApiError 归一化 / GET 重试 / POST 不重试 / 网络错误映射 */
import { apiFetch, ApiError } from '../app/composables/workshop/apiClient'

interface StubStep { status?: number, body?: unknown, network?: boolean }
let failed = 0
const okIf = (m: string, c: boolean) => {
  if (c) console.log(`PASS ${m}`)
  else {
    console.log(`FAIL ${m}`)
    failed++
  }
}

/** fetch 桩:按脚本逐次返回;记录调用次数 */
function stubFetch(script: StubStep[]): { calls: () => number } {
  let calls = 0
  const g = globalThis as { fetch?: unknown }
  // 全局桩:type 与原生 fetch 不完全兼容,单测内可控
  g.fetch = async () => {
    const step = script[Math.min(calls, script.length - 1)]!
    calls++
    if (step.network) throw new TypeError('Failed to fetch')
    const status = step.status ?? 200
    const body = step.body ?? (status >= 400 ? { code: 'HTTP', message: `http ${status}` } : { code: 0, message: 'ok', data: { v: calls } })
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
  }
  return { calls: () => calls }
}

/** 捕获 apiFetch 抛出的 ApiError */
async function capture(p: Promise<unknown>): Promise<ApiError | null> {
  try {
    await p
    return null
  }
  catch (e) {
    return e instanceof ApiError ? e : null
  }
}

const restore = (orig: unknown) => {
  (globalThis as { fetch?: unknown }).fetch = orig
}
const origFetch = globalThis.fetch

// ── 1. 成功信封 ──
{
  const s = stubFetch([{ body: { code: 0, message: 'ok', data: { v: 7 } } }])
  const d = await apiFetch<{ v: number }>({ base: '/api/x', retries: 2 })
  okIf(`成功信封解包: data.v=${d.v}`, d.v === 7 && s.calls() === 1)
}

// ── 2. 业务错误(code!==0)→ ApiError 保留 code/message,不重试 ──
{
  const s = stubFetch([{ status: 400, body: { code: 'VALIDATION_ERROR', message: '模板必填', data: null } }])
  const err = await capture(apiFetch({ base: '/api/x', retries: 2, init: { method: 'POST', body: '{}' } }))
  okIf(`业务错误归一化: ${err?.code}/${err?.message}`, err instanceof ApiError && err.code === 'VALIDATION_ERROR' && err.status === 400 && s.calls() === 1)
}

// ── 3. 非 2xx 无信封 → HTTP_xxx 兜底 ──
{
  const s = stubFetch([{ status: 502, body: 'Bad Gateway(html)' }])
  const err = await capture(apiFetch({ base: '/api/x' }))
  okIf(`非 JSON 非 2xx: ${err?.code}/${err?.message}`, err instanceof ApiError && err.code === 'HTTP_502' && s.calls() === 1)
}

// ── 4. 网络错误 → NETWORK ──
{
  const s = stubFetch([{ network: true }])
  const err = await capture(apiFetch({ base: '/api/x' }))
  okIf(`网络错误映射: ${err?.code}/${err?.message}`, err instanceof ApiError && err.code === 'NETWORK')
  okIf(`网络错误不重试(默认 retries=0): 调用 ${s.calls()} 次`, s.calls() === 1)
}

// ── 5. GET 5xx 自动重试:失败一次后成功 ──
{
  const s = stubFetch([
    { status: 500, body: { code: 'INTERNAL_ERROR', message: '服务器内部错误', data: null } },
    { body: { code: 0, message: 'ok', data: { v: 1 } } },
  ])
  const d = await apiFetch<{ v: number }>({ base: '/api/x', retries: 2 })
  okIf(`GET 重试成功: data.v=${d.v}, 调用 ${s.calls()} 次(重试 1 次)`, d.v === 1 && s.calls() === 2)
}

// ── 6. GET 重试耗尽:retries=2 → 共 3 次调用后抛错 ──
{
  const s = stubFetch([{ status: 500, body: { code: 'INTERNAL_ERROR', message: 'boom', data: null } }])
  const err = await capture(apiFetch({ base: '/api/x', retries: 2 }))
  okIf(`GET 重试耗尽: 调用 ${s.calls()} 次, code=${err?.code}`, s.calls() === 3 && err instanceof ApiError)
}

// ── 7. POST 永不重试(即使 retries 传了) ──
{
  const s = stubFetch([{ status: 500, body: { code: 'INTERNAL_ERROR', message: 'boom', data: null } }])
  const err = await capture(apiFetch({ base: '/api/x', retries: 2, init: { method: 'POST', body: '{}' } }))
  okIf(`POST 不重试: 调用 ${s.calls()} 次`, s.calls() === 1 && err instanceof ApiError)
}

// ── 8. 4xx 不重试(非 5xx) ──
{
  const s = stubFetch([{ status: 404, body: { code: 'NOT_FOUND', message: '接口不存在', data: null } }])
  const err = await capture(apiFetch({ base: '/api/x', retries: 2 }))
  okIf(`4xx 不重试: 调用 ${s.calls()} 次, code=${err?.code}`, s.calls() === 1 && err?.code === 'NOT_FOUND')
}

restore(origFetch)
console.log(failed ? `API-CLIENT TEST FAILED(${failed})` : 'API-CLIENT TEST ALL PASS')
process.exit(failed ? 1 : 0)

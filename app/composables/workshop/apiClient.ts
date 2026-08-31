/**
 * 统一 API 客户端 —— 全部手写 fetch 的单一收口。
 * - 信封解析:{code, message, data};code !== 0 或非 2xx 一律抛 ApiError
 * - ApiError 保留业务码与 HTTP 状态(调用方可分支),message 为后端可读文案
 * - 网络层失败(TypeError/断网)→ ApiError('NETWORK'),不再裸奔 "Failed to fetch"
 * - 幂等 GET 可选自动重试(5xx/网络错误;400ms 起退避);写操作永不重试
 */

export class ApiError extends Error {
  readonly code: string | number
  readonly status: number

  constructor(code: string | number, status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/** 鉴权头(cookie token → Bearer;与既有会话契约同源) */
function authHeaders(json = true): Record<string, string> {
  const cookieToken = typeof document !== 'undefined'
    ? (document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1] ?? '')
    : ''
  const h: Record<string, string> = {}
  if (cookieToken) h.authorization = `Bearer ${decodeURIComponent(cookieToken)}`
  if (json) h['content-type'] = 'application/json'
  return h
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function isIdempotent(init?: RequestInit): boolean {
  const method = (init?.method ?? 'GET').toUpperCase()
  return method === 'GET' || method === 'HEAD'
}

/** 单次请求:信封解析 + 错误归一化(所有失败路径都抛 ApiError) */
async function attemptOnce<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(base + path, { ...init, headers: { ...authHeaders(!!init?.body), ...init?.headers } })
  }
  catch {
    throw new ApiError('NETWORK', 0, '无法连接服务器，请检查网络或服务状态')
  }
  let json: { code?: string | number, message?: string, data?: T } | null = null
  try {
    json = await res.json()
  }
  catch {
    // 非 JSON 响应(代理/网关 HTML 错误页等)——按状态码归一化
  }
  if (!res.ok) {
    throw new ApiError(
      json?.code ?? `HTTP_${res.status}`,
      res.status,
      json?.message || `请求失败(HTTP ${res.status})`,
    )
  }
  if (json?.code !== 0) {
    throw new ApiError(json?.code ?? 'REQUEST_ERROR', res.status, json?.message || '请求失败')
  }
  return json.data as T
}

/**
 * 统一请求入口。
 * @param opts.base   API 前缀(如 '/api/workshop/daq')
 * @param opts.path   路径后缀(如 '/:id/bind')
 * @param opts.init   fetch RequestInit(body 由调用方 JSON.stringify)
 * @param opts.retries 幂等请求额外重试次数(仅 5xx/网络错误;默认 0)
 */
export async function apiFetch<T>(opts: { base: string, path?: string, init?: RequestInit, retries?: number }): Promise<T> {
  const { base, path = '', init, retries = 0 } = opts
  const idempotent = isIdempotent(init)
  const attempts = idempotent ? retries + 1 : 1
  let lastError: ApiError | undefined
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await attemptOnce<T>(base, path, init)
    }
    catch (err) {
      const apiErr = err instanceof ApiError
        ? err
        : new ApiError('INTERNAL_ERROR', 0, err instanceof Error ? err.message : String(err))
      const retryable = idempotent && (apiErr.code === 'NETWORK' || apiErr.status >= 500)
      lastError = apiErr
      if (!retryable || attempt === attempts - 1) throw apiErr
      await sleep(400 * (attempt + 1))
    }
  }
  throw lastError ?? new ApiError('INTERNAL_ERROR', 0, '请求失败')
}

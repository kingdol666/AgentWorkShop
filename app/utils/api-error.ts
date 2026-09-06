/**
 * 统一错误文案解析 —— 任何 fetch/axios/业务异常 → 面向用户的可读提示。
 *
 * 项目约定:API 错误一律走 {code, message} 信封(defineApiHandler/AppError),
 * 服务端 message 本就是人话;但 ofetch/axios 抛出的错误对象把 "[POST] /api/x
 * 403 (forbidden)" 这类码式文本放在 err.message 上,信封在 err.data 里。
 * 本解析器统一取值顺序:
 *   1. 服务端信封 message(人话,优先);
 *   2. HTTP 状态码 → 本地化映射(errors.* i18n,取不到回退内置中文);
 *   3. 网络层失败特征 → "无法连接服务器";
 *   4. 原始 message(最后兜底,通常已可读)。
 * 永远返回非空字符串;message.error(messageError(err)) 即可替换一切裸 err.message 渲染。
 */
interface ErrLike {
  data?: unknown
  statusCode?: number
  status?: number
  message?: string
  code?: string | number
}

/** i18n 取不到时的内置回退(与 locales errors.* 保持一致,zh 优先项目) */
const FALLBACK: Record<string, string> = {
  http400: '请求参数有误,请检查后重试',
  http401: '登录已过期,请重新登录',
  http403: '权限不足:该操作需要管理员权限',
  http404: '目标不存在或已被删除',
  http409: '操作冲突:资源已存在或状态不允许',
  http5xx: '服务器内部错误,请稍后重试',
  network: '无法连接服务器,请检查网络与服务状态',
  fallback: '操作失败,请稍后重试',
}

/** 事件回调里 useI18n 不可靠,经 nuxt app 取 $i18n;任何失败静默回退内置文案 */
function tt(key: string): string | null {
  try {
    const nuxt = useNuxtApp()
    const i18n = (nuxt as { $i18n?: { t?: (k: string) => string } }).$i18n
    const v = i18n?.t?.(key)
    return typeof v === 'string' && v && !v.startsWith('errors.') ? v : null
  }
  catch {
    return null
  }
}

function statusKey(status: number): keyof typeof FALLBACK | null {
  if (status === 400) return 'http400'
  if (status === 401) return 'http401'
  if (status === 403) return 'http403'
  if (status === 404) return 'http404'
  if (status === 409) return 'http409'
  if (status >= 500) return 'http5xx'
  return null
}

export function apiErrorMessage(err: unknown, fallback?: string): string {
  const e = (err ?? {}) as ErrLike
  // 1. 服务端信封(ofetch: err.data = {code,message};axios: err.response.data)
  const data = (e.data ?? null) as { message?: unknown } | null
  if (data && typeof data.message === 'string' && data.message.trim()) return data.message.trim()
  // 2. HTTP 状态码 → 本地化映射
  const status = Number(e.statusCode ?? e.status ?? 0)
  const key = statusKey(status)
  if (key) return tt(`errors.${key}`) ?? FALLBACK[key]
  // 3. 网络层失败(fetch failed / ECONNREFUSED / 超时)
  const raw = String(e.message ?? '')
  if (/fetch failed|network|ECONNREFUSED|ENOTFOUND|ECONNRESET|aborted|timeout/i.test(raw)) {
    return tt('errors.network') ?? FALLBACK.network
  }
  // 4. 原始 message 兜底(裸 Error 等通常已可读;剥掉 "Error: " 前缀)
  const cleaned = raw.replace(/^Error:\s*/, '').trim()
  if (cleaned) return cleaned
  return fallback ?? tt('errors.fallback') ?? FALLBACK.fallback
}

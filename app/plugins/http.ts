import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { message } from 'ant-design-vue'
import { useUserStore } from '~/stores/workshop/user'
import { useAuthUiStore } from '~/stores/workshop/auth-ui'

const g = globalThis as typeof globalThis & { __awShown401?: boolean }

/**
 * HTTP 请求层（基于 axios 封装）
 * - baseURL / timeout 由 config.yml -> api 驱动
 * - 统一请求/响应拦截：注入 token、统一错误提示
 * - 通过 nuxt provide 暴露 $http，并提供 useHttp 组合式入口
 */
export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig().public

  const instance: AxiosInstance = axios.create({
    baseURL: config.apiBase as string,
    timeout: config.apiTimeout as number,
  })

  // token 多通道读取:useCookie → document.cookie → localStorage。
  // 背景:cookie 罐在部分环境(嵌入式浏览器/宿主隔离策略)会被异步驱逐,而 Nuxt 上下文
  // 未就绪时 useCookie 也拿不到值——单通道会导致首批请求或运行中请求裸奔 → 401 级联。
  const readToken = (): string | null => {
    try {
      const v = useCookie<string | null>('token').value
      if (v) return v
    }
    catch { /* Nuxt 上下文未就绪 */ }
    if (typeof document !== 'undefined') {
      const m = document.cookie.match(/(?:^|;\s*)token=([^;]*)/)
      if (m?.[1]) {
        try {
          return decodeURIComponent(m[1])
        }
        catch {
          return m[1]
        }
      }
    }
    try {
      const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('aw.token') : null
      if (ls) return ls
    }
    catch { /* 隐私模式等 localStorage 不可用 */ }
    return null
  }

  // 请求拦截：注入鉴权头
  instance.interceptors.request.use(
    (req: InternalAxiosRequestConfig) => {
      const token = readToken()
      if (token) {
        req.headers.Authorization = `Bearer ${token}`
      }
      return req
    },
    error => Promise.reject(error),
  )

  // 响应拦截：统一解包 + 错误提示
  instance.interceptors.response.use(
    (res: AxiosResponse) => res.data,
    (error) => {
      const status = error?.response?.status
      const msg = error?.response?.data?.message || error.message || '请求失败'

      if (status === 401) {
        // 单次自愈重试:cookie 罐驱逐/上下文时序导致的瞬时 401,重读 token 重放一次;
        // 仍 401 才认定凭据真的失效,进入收尾。__awRetry 挂在原 config 上防重试循环。
        const cfg = error?.config as (InternalAxiosRequestConfig & { __awRetry?: boolean }) | undefined
        const retryToken = readToken()
        const sentToken = cfg?.headers?.Authorization?.toString().replace(/^Bearer\s+/i, '')
        if (cfg && !cfg.__awRetry && retryToken && retryToken !== sentToken) {
          cfg.__awRetry = true
          cfg.headers = { ...(cfg.headers ?? {}), Authorization: `Bearer ${retryToken}` } as InternalAxiosRequestConfig['headers']
          return instance.request(cfg)
        }
        // 死 token 收尾:清登录态(cookie+pinia)防 401 toast 风暴;toast 3s 去重
        try {
          useCookie<string | null>('token').value = null
          try {
            localStorage.removeItem('aw.token')
          }
          catch { /* localStorage 不可用 */ }
          useUserStore(nuxtApp.$pinia).$reset()
        }
        catch { /* 无 pinia 上下文(极端时序) */ }
        if (!g.__awShown401) {
          g.__awShown401 = true
          // SSR 安全:ant-design message 依赖 DOM,服务端调用会炸掉渲染进程
          if (import.meta.client) message.error('登录已过期,请重新登录')
          setTimeout(() => {
            g.__awShown401 = false
          }, 3000)
        }
        // F2 修复:401 不再只弹 toast —— 弹出全局登录对话框给出进门通道
        try {
          if (import.meta.client) useAuthUiStore(nuxtApp.$pinia).openLogin('expired')
        }
        catch { /* 无 pinia 上下文(极端时序) */ }
      }
      else if (status >= 500) {
        if (import.meta.client) message.error('服务器异常，请稍后重试')
      }
      else {
        if (import.meta.client) message.error(msg)
      }

      return Promise.reject(error)
    },
  )

  return {
    provide: {
      http: {
        get: <T = unknown>(url: string, params?: object, cfg?: AxiosRequestConfig) =>
          instance.get<unknown, T>(url, { params, ...cfg }),
        post: <T = unknown>(url: string, data?: object, cfg?: AxiosRequestConfig) =>
          instance.post<unknown, T>(url, data, cfg),
        put: <T = unknown>(url: string, data?: object, cfg?: AxiosRequestConfig) =>
          instance.put<unknown, T>(url, data, cfg),
        patch: <T = unknown>(url: string, data?: object, cfg?: AxiosRequestConfig) =>
          instance.patch<unknown, T>(url, data, cfg),
        delete: <T = unknown>(url: string, cfg?: AxiosRequestConfig) =>
          instance.delete<unknown, T>(url, cfg),
        request: <T = unknown>(cfg: AxiosRequestConfig) => instance.request<unknown, T>(cfg),
      },
    },
  }
})

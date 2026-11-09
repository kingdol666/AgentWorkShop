import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { message } from 'ant-design-vue'
import { readAuthToken, handleAuthExpired } from '~/utils/auth-session'

/**
 * HTTP 请求层（基于 axios 封装）
 * - baseURL / timeout 由 config.yml -> api 驱动
 * - 统一请求/响应拦截：注入 token、统一错误提示
 * - 通过 nuxt provide 暴露 $http，并提供 useHttp 组合式入口
 */
export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig().public

  const instance: AxiosInstance = axios.create({
    baseURL: config.apiBase as string,
    timeout: config.apiTimeout as number,
  })

  // 请求拦截：注入鉴权头(token 多通道读取见 app/utils/auth-session.ts,与 apiFetch 共用)
  instance.interceptors.request.use(
    (req: InternalAxiosRequestConfig) => {
      const token = readAuthToken()
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
        const retryToken = readAuthToken()
        const sentToken = cfg?.headers?.Authorization?.toString().replace(/^Bearer\s+/i, '')
        if (cfg && !cfg.__awRetry && retryToken && retryToken !== sentToken) {
          cfg.__awRetry = true
          cfg.headers = { ...(cfg.headers ?? {}), Authorization: `Bearer ${retryToken}` } as InternalAxiosRequestConfig['headers']
          return instance.request(cfg)
        }
        // 死 token 收尾(与 apiFetch 共用同一实现:清登录态 + 去重 toast + 登录框)
        handleAuthExpired()
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

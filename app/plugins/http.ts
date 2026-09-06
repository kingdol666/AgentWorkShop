import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { message } from 'ant-design-vue'
import { useUserStore } from '~/stores/workshop/user'

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

  // 请求拦截：注入鉴权头
  instance.interceptors.request.use(
    (req: InternalAxiosRequestConfig) => {
      const token = useCookie<string | null>('token')
      if (token.value) {
        req.headers.Authorization = `Bearer ${token.value}`
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
        // 死 token 收尾:清登录态(cookie+pinia)防 401 toast 风暴;toast 3s 去重
        try {
          const cookie = useCookie<string | null>('token')
          cookie.value = null
          useUserStore(nuxtApp.$pinia).$reset()
        }
        catch { /* 无 pinia 上下文(极端时序) */ }
        if (!g.__awShown401) {
          g.__awShown401 = true
          message.error('登录已过期,请重新登录')
          setTimeout(() => {
            g.__awShown401 = false
          }, 3000)
        }
      }
      else if (status >= 500) {
        message.error('服务器异常，请稍后重试')
      }
      else {
        message.error(msg)
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
        delete: <T = unknown>(url: string, cfg?: AxiosRequestConfig) =>
          instance.delete<unknown, T>(url, cfg),
        request: <T = unknown>(cfg: AxiosRequestConfig) => instance.request<unknown, T>(cfg),
      },
    },
  }
})

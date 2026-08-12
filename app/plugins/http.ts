import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { message } from 'ant-design-vue'

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
        message.error('登录已过期，请重新登录')
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

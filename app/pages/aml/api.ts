import { apiFetch } from '@/app/composables/workshop/apiClient'

/** 统一客户端:信封 {code,message,data} 解析取 .data(与 daq 页请求写法同源) */
export function amlApi<T>(path: string, init?: RequestInit): Promise<T> {
  return apiFetch<T>({ base: '/api/workshop/aml', path, init })
}

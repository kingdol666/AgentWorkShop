import { message } from 'ant-design-vue'
import { useUserStore } from '~/stores/workshop/user'
import { useAuthUiStore } from '~/stores/workshop/auth-ui'
import { readApiToken, setApiToken } from './api-token'

const g = globalThis as typeof globalThis & { __awShown401?: boolean }

/** 只返回显式 API-token 登录的内存凭据；浏览器 session 由 HttpOnly cookie 自动发送。 */
export function readAuthToken(): string | null {
  return readApiToken()
}

/** API token 登录成功时由用户 store 设置；不写入浏览器存储。 */
export function setApiAuthToken(token: string | null): void {
  setApiToken(token)
}

export function handleAuthExpired(): void {
  setApiAuthToken(null)
  try {
    useUserStore(useNuxtApp().$pinia).$reset()
  }
  catch { /* 无 pinia 上下文(极端时序) */ }
  if (!g.__awShown401) {
    g.__awShown401 = true
    if (import.meta.client) {
      message.error('登录已过期,请重新登录')
    }
    setTimeout(() => {
      g.__awShown401 = false
    }, 3000)
  }
  try {
    if (import.meta.client) useAuthUiStore(useNuxtApp().$pinia).openLogin('expired')
  }
  catch { /* 无 pinia 上下文(极端时序) */ }
}

/**
 * 登录对话框全局状态(独立于 user store):401 拦截器 / 访客菜单 / 登出 /
 * 匿名横幅 四路共用同一开关。不并入 workshop.user —— 401 处理会对 user store
 * 执行 $reset(),放里面会被一并清掉。
 */
import { defineStore } from 'pinia'

export type LoginReason = 'manual' | 'expired' | 'anonymous'

interface AuthUiState {
  open: boolean
  reason: LoginReason
}

export const useAuthUiStore = defineStore('workshop.authUi', {
  state: (): AuthUiState => ({ open: false, reason: 'manual' }),
  actions: {
    openLogin(reason: LoginReason = 'manual'): void {
      this.reason = reason
      this.open = true
    },
    closeLogin(): void {
      this.open = false
    },
  },
})

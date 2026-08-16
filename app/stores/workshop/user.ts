/**
 * 用户身份(P2 用户级隔离):register/login/logout;token 写入 cookie 'token'
 * 供 $http 拦截器全局注入(Authorization: Bearer <用户token>)。
 * WS sub / 手写 fetch 场景直接读 store.token。
 */
import { defineStore } from 'pinia'

export interface CurrentUser {
  id: string
  name: string
  token: string
}

export const useUserStore = defineStore('workshop.user', {
  state: () => ({
    user: null as CurrentUser | null,
  }),
  getters: {
    isLoggedIn: state => state.user !== null,
    token: state => state.user?.token ?? '',
  },
  actions: {
    applyCookie(): void {
      const cookie = useCookie<string | null>('token', { maxAge: 60 * 60 * 24 * 365 })
      cookie.value = this.user?.token ?? null
    },
    async register(name: string): Promise<CurrentUser> {
      const trimmed = name.trim()
      if (!trimmed) throw new Error('用户名不能为空')
      const res = await $fetch<{ code: number | string, message?: string, data?: CurrentUser }>('/api/workshop/users/register', {
        method: 'POST',
        body: { name: trimmed },
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '注册失败')
      this.user = { id: res.data.id, name: res.data.name, token: res.data.token }
      this.applyCookie()
      return this.user
    },
    async loginWithToken(token: string): Promise<CurrentUser> {
      const trimmed = token.trim()
      if (!trimmed) throw new Error('token 不能为空')
      const res = await $fetch<{ code: number | string, message?: string, data?: { id: string, name: string } }>('/api/workshop/users/me', {
        headers: { authorization: `Bearer ${trimmed}` },
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? 'token 无效')
      this.user = { id: res.data.id, name: res.data.name, token: trimmed }
      this.applyCookie()
      return this.user
    },
    async refresh(): Promise<void> {
      if (!this.user) return
      try {
        await this.loginWithToken(this.user.token)
      }
      catch {
        this.logout()
      }
    },
    logout(): void {
      this.user = null
      this.applyCookie()
    },
  },
  persist: {
    pick: ['user'],
  },
})

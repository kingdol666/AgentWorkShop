/**
 * 用户身份（全局用户系统集成）：register/login/logout/多 token CRUD；
 * token 写入 cookie 'token' 供 $http 拦截器全局注入(Authorization: Bearer)。
 * WS sub / 手写 fetch 场景直接读 store.token。
 * 身份源：/api/users/*（data/users.sqlite 全局用户系统，非 workshop 本地用户）。
 */
import { defineStore } from 'pinia'

export interface CurrentUser {
  id: string
  name: string
  email: string
  role: string
  createdAt: string
  token: string
  /** 当前会话 token 的 id（吊销会话时比对用） */
  tokenId: string
}

export interface TokenMeta {
  id: string
  label: string
  createdAt: string
  lastUsedAt: string | null
}

export interface AuthPayload {
  user: Omit<CurrentUser, 'token' | 'tokenId'>
  token: string
}

interface ApiEnvelope<T = unknown> {
  code: number | string
  message: string
  data: T | null
}

export const useUserStore = defineStore('workshop.user', {
  state: () => ({
    user: null as CurrentUser | null,
  }),
  getters: {
    isLoggedIn: state => state.user !== null,
    token: state => state.user?.token ?? '',
    /** admin 角色(最高管理权限:全量监控/任意模板/用户管理) */
    isAdmin: state => state.user?.role === 'admin',
  },
  actions: {
    applyCookie(): void {
      const cookie = useCookie<string | null>('token', { maxAge: 60 * 60 * 24 * 365 })
      cookie.value = this.user?.token ?? null
    },
    /** 以 me 响应补全 tokenId（注册/登录签发的新 token 尚未绑定 id） */
    async _attachTokenId(token: string): Promise<void> {
      const res = await $fetch<ApiEnvelope<Omit<CurrentUser, 'token'> & { tokenId: string }>>('/api/users/me', {
        headers: { authorization: `Bearer ${token}` },
      })
      if (res.code === 0 && res.data && this.user) {
        this.user.tokenId = res.data.tokenId
      }
    },
    async register(name: string, email: string, password: string): Promise<CurrentUser> {
      const res = await $fetch<ApiEnvelope<AuthPayload>>('/api/users/register', {
        method: 'POST',
        body: { name: name.trim(), email: email.trim(), password },
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '注册失败')
      this.user = { ...res.data.user, token: res.data.token, tokenId: '' }
      this.applyCookie()
      await this._attachTokenId(res.data.token)
      return this.user
    },
    async login(email: string, password: string): Promise<CurrentUser> {
      const res = await $fetch<ApiEnvelope<AuthPayload>>('/api/users/login', {
        method: 'POST',
        body: { email: email.trim(), password },
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '登录失败')
      this.user = { ...res.data.user, token: res.data.token, tokenId: '' }
      this.applyCookie()
      await this._attachTokenId(res.data.token)
      return this.user
    },
    async loginWithToken(token: string): Promise<CurrentUser> {
      const trimmed = token.trim()
      if (!trimmed) throw new Error('token 不能为空')
      const res = await $fetch<ApiEnvelope<Omit<CurrentUser, 'token'> & { tokenId: string }>>('/api/users/me', {
        headers: { authorization: `Bearer ${trimmed}` },
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? 'token 无效')
      this.user = { ...res.data, token: trimmed }
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
    async logout(): Promise<void> {
      const t = this.user?.token
      this.user = null
      this.applyCookie()
      if (t) {
        try {
          await $fetch('/api/users/logout', { method: 'POST', headers: { authorization: `Bearer ${t}` } })
        }
        catch {
          // 吊销失败不阻塞本地登出
        }
      }
    },
    // ===== API Token CRUD（仅本人；$fetch 不走 axios 拦截器，需显式携带当前会话 Bearer）=====
    authHeaders(): Record<string, string> {
      const t = this.user?.token
      return t ? { authorization: `Bearer ${t}` } : {}
    },
    async listTokens(): Promise<TokenMeta[]> {
      const res = await $fetch<ApiEnvelope<TokenMeta[]>>('/api/users/tokens', { headers: this.authHeaders() })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '获取 token 列表失败')
      return res.data
    },
    async createToken(label: string): Promise<{ id: string, label: string, token: string }> {
      const res = await $fetch<ApiEnvelope<{ id: string, label: string, token: string }>>('/api/users/tokens', {
        method: 'POST',
        body: { label: label.trim() },
        headers: this.authHeaders(),
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '创建 token 失败')
      return res.data
    },
    async renameToken(id: string, label: string): Promise<TokenMeta> {
      const res = await $fetch<ApiEnvelope<TokenMeta>>(`/api/users/tokens/${id}`, {
        method: 'PATCH',
        body: { label: label.trim() },
        headers: this.authHeaders(),
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '更新 token 失败')
      return res.data
    },
    async revokeToken(id: string): Promise<void> {
      const res = await $fetch<ApiEnvelope<{ id: string }>>(`/api/users/tokens/${id}`, {
        method: 'DELETE',
        headers: this.authHeaders(),
      })
      if (res.code !== 0) throw new Error(res.message ?? '删除 token 失败')
      // 吊销的是当前会话 token → 本地登出
      if (this.user && id === this.user.tokenId) {
        this.logout()
      }
    },
  },
  persist: {
    pick: ['user'],
  },
})

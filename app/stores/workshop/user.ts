/**
 * 用户身份：浏览器使用服务端 HttpOnly session；显式 API token 仅在当前内存会话中
 * 保留，供外部 API/Agent 兼容路径使用，绝不写入 cookie 或 localStorage。
 */
import { defineStore } from 'pinia'
import { readApiToken, setApiToken } from '~/utils/api-token'

export interface CurrentUser {
  id: string
  name: string
  email: string
  role: string
  createdAt: string
  /** 外部 API token；浏览器从 HttpOnly session 恢复时为空。 */
  token?: string
  /** 当前 API token 的 id；浏览器 session 恢复时为空。 */
  tokenId: string
  mustChangePassword?: boolean
}

export interface TokenMeta {
  id: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  preview: string | null
  hasPlain: boolean
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

type NarrowFetch = <T>(url: string, opts?: Record<string, unknown>) => Promise<T>
const http = (globalThis as unknown as { $fetch: NarrowFetch }).$fetch

type BrowserSessionPayload = {
  user: Omit<CurrentUser, 'token' | 'tokenId'>
  expiresAt?: string
}

export const useUserStore = defineStore('workshop.user', {
  state: () => ({
    user: null as CurrentUser | null,
    /** 客户端会话恢复是否已尝试完成（SSR 恒 false → 首帧骨架，避免 auth 分支水合错位） */
    sessionReady: false,
  }),
  getters: {
    isLoggedIn: state => state.user !== null,
    token: state => readApiToken() ?? state.user?.token ?? '',
    isAdmin: state => state.user?.role === 'admin',
  },
  actions: {
    setUser(user: BrowserSessionPayload['user'], token?: string): CurrentUser {
      this.user = { ...user, ...(token ? { token } : {}), tokenId: '' }
      setApiToken(token ?? null)
      return this.user
    },

    async establishBrowserSession(bearer: string): Promise<BrowserSessionPayload> {
      const res = await http<ApiEnvelope<BrowserSessionPayload>>('/api/users/session', {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}` },
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '建立浏览器会话失败')
      return res.data
    },

    async restoreBrowserSession(): Promise<void> {
      const session = await this.restoreBrowserSessionPayload()
      if (!session?.user) {
        this.user = null
        setApiToken(null)
        return
      }
      this.setUser(session.user)
    },

    async restoreBrowserSessionPayload(): Promise<BrowserSessionPayload | null> {
      const res = await http<ApiEnvelope<BrowserSessionPayload | null>>('/api/users/session')
      return res.code === 0 ? res.data : null
    },

    async clearBrowserSession(): Promise<void> {
      try {
        await http('/api/users/session', { method: 'DELETE' })
      }
      finally {
        this.user = null
        setApiToken(null)
      }
    },

    async attachTokenId(token: string): Promise<void> {
      const res = await http<ApiEnvelope<Omit<CurrentUser, 'token'> & { tokenId: string }>>('/api/users/me', {
        headers: { authorization: `Bearer ${token}` },
      })
      if (res.code === 0 && res.data && this.user) this.user.tokenId = res.data.tokenId
    },

    async register(name: string, email: string, password: string): Promise<CurrentUser> {
      const res = await http<ApiEnvelope<AuthPayload>>('/api/users/register', {
        method: 'POST',
        headers: { 'x-aw-browser': '1' },
        body: { name: name.trim(), email: email.trim(), password },
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '注册失败')
      const session = await this.restoreBrowserSessionPayload()
      if (!session?.user) throw new Error('浏览器会话未建立')
      return this.setUser(session.user)
    },

    async login(email: string, password: string): Promise<CurrentUser> {
      const res = await http<ApiEnvelope<AuthPayload>>('/api/users/login', {
        method: 'POST',
        headers: { 'x-aw-browser': '1' },
        body: { email: email.trim(), password },
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '登录失败')
      const session = await this.restoreBrowserSessionPayload()
      if (!session?.user) throw new Error('浏览器会话未建立')
      return this.setUser(session.user)
    },

    /** 显式 API token 登录：建立浏览器 session 后只在当前内存中保留 token。 */
    async loginWithToken(token: string): Promise<CurrentUser> {
      const trimmed = token.trim()
      if (!trimmed) throw new Error('token 不能为空')
      const res = await http<ApiEnvelope<Omit<CurrentUser, 'token'> & { tokenId: string }>>('/api/users/me', {
        headers: { authorization: `Bearer ${trimmed}` },
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? 'token 无效')
      const session = await this.establishBrowserSession(trimmed)
      const user = this.setUser(session.user, trimmed)
      if (this.user) this.user.tokenId = res.data.tokenId
      return user
    },

    async refresh(): Promise<void> {
      if (this.user?.token) {
        try {
          await this.loginWithToken(this.user.token)
          return
        }
        catch {
          this.user = null
          setApiToken(null)
        }
      }
      await this.restoreBrowserSession()
    },

    async logout(): Promise<void> {
      const token = this.user?.token
      this.user = null
      setApiToken(null)
      try {
        await http('/api/users/session', { method: 'DELETE' })
      }
      catch {
        // session 已在本地清除，服务端失败由下次过期收敛
      }
      if (token) {
        try {
          await http('/api/users/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } })
        }
        catch {
          // 兼容 API token 吊销失败不阻塞浏览器登出
        }
      }
    },

    async changePassword(currentPassword: string, newPassword: string): Promise<void> {
      const res = await http<ApiEnvelope<{ ok: boolean, mustChangePassword: boolean }>>('/api/users/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
        headers: this.authHeaders(),
      })
      if (res.code !== 0 || !res.data?.ok) throw new Error(res.message ?? '修改密码失败')
      if (this.user) this.user.mustChangePassword = false
    },

    authHeaders(): Record<string, string> {
      return this.user?.token ? { authorization: `Bearer ${this.user.token}` } : {}
    },

    async listTokens(): Promise<TokenMeta[]> {
      const res = await http<ApiEnvelope<TokenMeta[]>>('/api/users/tokens', { headers: this.authHeaders() })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '获取 token 列表失败')
      return res.data
    },

    async createToken(label: string): Promise<{ id: string, label: string, token: string }> {
      const res = await http<ApiEnvelope<{ id: string, label: string, token: string }>>('/api/users/tokens', {
        method: 'POST', body: { label: label.trim() }, headers: this.authHeaders(),
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '创建 token 失败')
      return res.data
    },

    async renameToken(id: string, label: string): Promise<TokenMeta> {
      const res = await http<ApiEnvelope<TokenMeta>>(`/api/users/tokens/${id}`, {
        method: 'PATCH', body: { label: label.trim() }, headers: this.authHeaders(),
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '更新 token 失败')
      return res.data
    },

    async revealToken(id: string): Promise<string | null> {
      const res = await http<ApiEnvelope<{ token: string | null }>>(`/api/users/tokens/${id}/token`, { headers: this.authHeaders() })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '查看 token 失败')
      return res.data.token
    },

    async revokeToken(id: string): Promise<void> {
      const res = await http<ApiEnvelope<{ id: string }>>(`/api/users/tokens/${id}`, {
        method: 'DELETE', headers: this.authHeaders(),
      })
      if (res.code !== 0) throw new Error(res.message ?? '删除 token 失败')
      if (this.user && id === this.user.tokenId) await this.logout()
    },
  },
})

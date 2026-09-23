/**
 * Workspace 会话隔离层(P2 起服务端持久化;按用户隔离)。
 * 数据源:GET/POST/DELETE /api/workshop/workspaces;挂载关系服务端存储。
 * activeChannelId 为纯前端态(localStorage 映射,不入库)。
 */
import { defineStore } from 'pinia'
import { useUserStore } from './user'

/**
 * 用户态 $fetch:管理面 API 统一携带用户 token(envelope 解包为 unknown,调用侧窄化)。
 *
 * 窄化原因同 app/stores/workshop/user.ts:Nuxt 的 `$fetch` 带全量路由类型推导,
 * 在这些深层 action 里求值会触发 TS2589「Type instantiation is excessively deep」
 * (v17 之前 `pnpm typecheck` 就一直红在这一处 —— 既有未修复项)。
 * 把 `$fetch` 窄化成本地函数签名绕开泛型展开,**运行时是同一个函数**。
 */
type NarrowFetch = <T>(url: string, init?: Record<string, unknown>) => Promise<T>
const rawFetch = (globalThis as unknown as { $fetch: NarrowFetch }).$fetch

async function authFetch<T = unknown>(url: string, init: Record<string, unknown> = {}): Promise<{ code: number | string, message?: string, data?: T }> {
  const token = useUserStore().token
  const res = await rawFetch<unknown>(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
  })
  return res as { code: number | string, message?: string, data?: T }
}

export interface WorkspaceMeta {
  id: string
  name: string
  channelIds: string[]
  activeChannelId?: string
}

interface ServerWorkspace {
  id: string
  name: string
  channelIds?: string[]
}

const ACTIVE_KEY = 'workshop.activeChannel'
const ACTIVE_WS_KEY = 'workshop.activeWorkspace'

/**
 * localStorage 只在浏览器存在。这几个读写点都在 **store 的初始化路径**上
 * (load() → saveActiveMap()),而 load() 完全可能被服务端调用 ——
 * 少了守卫,一次 SSR 调用就会抛 "localStorage is not defined",
 * 被 stability-guard 当成 fatal unhandledRejection **直接结束进程**
 * (实测:生产实例在 /town 刷新后静默退出,日志只有一行 ReferenceError)。
 *
 * 约定与 app/stores/app.ts 一致:持久化层自己保证 SSR 安全,调用方不必先判断环境。
 */
const hasLocalStorage = (): boolean => typeof localStorage !== 'undefined'

function loadActiveMap(): Record<string, string> {
  if (!hasLocalStorage()) return {}
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? '{}') as Record<string, string>
  }
  catch {
    return {}
  }
}

function saveActiveMap(map: Record<string, string>): void {
  if (!hasLocalStorage()) return
  localStorage.setItem(ACTIVE_KEY, JSON.stringify(map))
}

export const useWorkspacesStore = defineStore('workshop.workspaces', {
  state: () => ({
    workspaces: [] as WorkspaceMeta[],
    loaded: false,
  }),
  getters: {
    activeWorkspaceId(state): string | null {
      if (!hasLocalStorage()) return state.workspaces[0]?.id ?? null
      return localStorage.getItem(ACTIVE_WS_KEY) ?? state.workspaces[0]?.id ?? null
    },
  },
  actions: {
    setActiveWorkspaceId(id: string | null): void {
      if (!hasLocalStorage()) return
      localStorage.setItem(ACTIVE_WS_KEY, id ?? '')
    },
    /** 拉取服务端 workspace 列表(合并本地 activeChannelId) */
    async load(): Promise<void> {
      const res = await authFetch<ServerWorkspace[]>('/api/workshop/workspaces')
      if (res.code !== 0) throw new Error(res.message ?? '加载失败')
      const active = loadActiveMap()
      this.workspaces = (res.data ?? []).map((w) => {
        const ids = w.channelIds ?? []
        // 本地持久化的 activeChannelId 可能已过期(channel 被卸载/删除/换设备变更):
        // 不在服务端挂载清单内的一律丢弃,回退首频道——否则前端会订阅死频道,
        // 快照永不到达,右栏/列表长时间呈现"空数据"假象
        const stored = active[w.id]
        const activeChannelId = stored && ids.includes(stored) ? stored : undefined
        if (stored !== activeChannelId) {
          if (activeChannelId) active[w.id] = activeChannelId
          else Reflect.deleteProperty(active, w.id)
        }
        return { id: w.id, name: w.name, channelIds: ids, activeChannelId }
      })
      saveActiveMap(active)
      this.loaded = true
    },
    async create(name: string): Promise<WorkspaceMeta> {
      const res = await authFetch<ServerWorkspace>('/api/workshop/workspaces', {
        method: 'POST',
        body: { name },
      })
      if (res.code !== 0 || !res.data) throw new Error(res.message ?? '创建失败')
      const ws: WorkspaceMeta = { id: res.data.id, name: res.data.name, channelIds: [] }
      this.workspaces.push(ws)
      return ws
    },
    async remove(id: string): Promise<void> {
      await authFetch(`/api/workshop/workspaces/${id}`, { method: 'DELETE' })
      this.workspaces = this.workspaces.filter(w => w.id !== id)
    },
    async rename(id: string, name: string): Promise<void> {
      // 服务端暂无 PATCH;本地展示名(重进后以服务端为准)
      const ws = this.workspaces.find(w => w.id === id)
      if (ws) ws.name = name
    },
    async mountChannel(id: string, channelId: string): Promise<void> {
      const ws = this.workspaces.find(w => w.id === id)
      if (!ws || ws.channelIds.includes(channelId)) return
      await authFetch(`/api/workshop/workspaces/${id}/channels/${channelId}`, { method: 'POST' })
      ws.channelIds.push(channelId)
      if (!ws.activeChannelId) {
        ws.activeChannelId = channelId
        this.persistActive(ws)
      }
    },
    async unmountChannel(id: string, channelId: string): Promise<void> {
      const ws = this.workspaces.find(w => w.id === id)
      if (!ws) return
      await authFetch(`/api/workshop/workspaces/${id}/channels/${channelId}`, { method: 'DELETE' })
      ws.channelIds = ws.channelIds.filter(c => c !== channelId)
      if (ws.activeChannelId === channelId) ws.activeChannelId = ws.channelIds[0]
      this.persistActive(ws)
    },
    setActiveChannel(id: string, channelId: string): void {
      const ws = this.workspaces.find(w => w.id === id)
      if (ws && ws.channelIds.includes(channelId)) {
        ws.activeChannelId = channelId
        this.persistActive(ws)
      }
    },
    persistActive(ws: WorkspaceMeta): void {
      const map = loadActiveMap()
      if (ws.activeChannelId) map[ws.id] = ws.activeChannelId
      else Reflect.deleteProperty(map, ws.id)
      saveActiveMap(map)
    },
  },
})

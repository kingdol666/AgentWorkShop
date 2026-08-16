/**
 * Workspace 会话隔离层(P2 起服务端持久化;按用户隔离)。
 * 数据源:GET/POST/DELETE /api/workshop/workspaces;挂载关系服务端存储。
 * activeChannelId 为纯前端态(localStorage 映射,不入库)。
 */
import { defineStore } from 'pinia'
import { useUserStore } from './user'

/** 用户态 $fetch:管理面 API 统一携带用户 token(envelope 解包为 unknown,调用侧窄化) */
async function authFetch<T = unknown>(url: string, init: Record<string, unknown> = {}): Promise<{ code: number | string, message?: string, data?: T }> {
  const token = useUserStore().token
  const res = await $fetch<unknown>(url, {
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

function loadActiveMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? '{}') as Record<string, string>
  }
  catch {
    return {}
  }
}

function saveActiveMap(map: Record<string, string>): void {
  localStorage.setItem(ACTIVE_KEY, JSON.stringify(map))
}

export const useWorkspacesStore = defineStore('workshop.workspaces', {
  state: () => ({
    workspaces: [] as WorkspaceMeta[],
    loaded: false,
  }),
  getters: {
    activeWorkspaceId(state): string | null {
      return localStorage.getItem('workshop.activeWorkspace') ?? state.workspaces[0]?.id ?? null
    },
  },
  actions: {
    setActiveWorkspaceId(id: string | null): void {
      localStorage.setItem('workshop.activeWorkspace', id ?? '')
    },
    /** 拉取服务端 workspace 列表(合并本地 activeChannelId) */
    async load(): Promise<void> {
      const res = await authFetch<ServerWorkspace[]>('/api/workshop/workspaces')
      if (res.code !== 0) throw new Error(res.message ?? '加载失败')
      const active = loadActiveMap()
      this.workspaces = (res.data ?? []).map(w => ({
        id: w.id,
        name: w.name,
        channelIds: w.channelIds ?? [],
        activeChannelId: active[w.id],
      }))
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

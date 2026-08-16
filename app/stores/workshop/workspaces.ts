/**
 * Workspace 会话隔离层(纯前端,localStorage 持久化)。
 * Workspace = 用户定义的工作区容器,持有若干 Channel 引用;
 * 不同 Workspace 的 WS 订阅、事件缓冲与 UI 状态互不干扰。
 */
import { defineStore } from 'pinia'

export interface WorkspaceMeta {
  id: string
  name: string
  createdAt: number
  channelIds: string[]
  activeChannelId?: string
}

export const useWorkspacesStore = defineStore('workshop.workspaces', {
  state: () => ({
    workspaces: [] as WorkspaceMeta[],
    activeWorkspaceId: null as string | null,
  }),
  getters: {
    activeWorkspace(state): WorkspaceMeta | undefined {
      return state.workspaces.find(w => w.id === state.activeWorkspaceId)
    },
  },
  actions: {
    create(name: string): WorkspaceMeta {
      const ws: WorkspaceMeta = { id: crypto.randomUUID(), name, createdAt: Date.now(), channelIds: [] }
      this.workspaces.push(ws)
      this.activeWorkspaceId = ws.id
      return ws
    },
    rename(id: string, name: string): void {
      const ws = this.workspaces.find(w => w.id === id)
      if (ws) ws.name = name
    },
    remove(id: string): void {
      this.workspaces = this.workspaces.filter(w => w.id !== id)
      if (this.activeWorkspaceId === id) this.activeWorkspaceId = this.workspaces[0]?.id ?? null
    },
    mountChannel(id: string, channelId: string): void {
      const ws = this.workspaces.find(w => w.id === id)
      if (ws && !ws.channelIds.includes(channelId)) {
        ws.channelIds.push(channelId)
        if (!ws.activeChannelId) ws.activeChannelId = channelId
      }
    },
    unmountChannel(id: string, channelId: string): void {
      const ws = this.workspaces.find(w => w.id === id)
      if (!ws) return
      ws.channelIds = ws.channelIds.filter(c => c !== channelId)
      if (ws.activeChannelId === channelId) ws.activeChannelId = ws.channelIds[0]
    },
    setActiveChannel(id: string, channelId: string): void {
      const ws = this.workspaces.find(w => w.id === id)
      if (ws && ws.channelIds.includes(channelId)) ws.activeChannelId = channelId
    },
  },
  persist: {
    pick: ['workspaces', 'activeWorkspaceId'],
  },
})

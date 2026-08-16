/**
 * 实体归一化:channel/agent/task 快照 + AEP 增量 upsert(幂等)。
 * REST 命令后的状态以 WS 事件回流为准(REST 返回值不直接写状态,避免双源)。
 */
import { defineStore } from 'pinia'
import type { AepEnvelope, AepSnapshot } from '#shared/workshop-protocol'

export interface AgentView {
  agentId: string
  name: string
  role: 'lead' | 'worker'
  harness: string
  state: 'idle' | 'busy' | 'stopped'
  currentTaskId?: string | null
  queued?: number
  completed?: number
}

export interface TaskView {
  id: string
  parentId?: string
  title: string
  state: string
  progress: number
  assigneeId: string
  artifacts: number
  updatedAt?: string
}

export const useEntitiesStore = defineStore('workshop.entities', {
  state: () => ({
    channels: {} as Record<string, AepSnapshot['channel'] & { loadedAt: number }>,
    agents: {} as Record<string, AgentView[]>,
    tasks: {} as Record<string, TaskView[]>,
  }),
  getters: {
    agentById(state) {
      return (channelId: string, agentId: string): AgentView | undefined =>
        state.agents[channelId]?.find(a => a.agentId === agentId)
    },
    rootTasks(state) {
      return (channelId: string): TaskView[] =>
        (state.tasks[channelId] ?? []).filter(t => !t.parentId)
    },
    taskById(state) {
      return (channelId: string, taskId: string): TaskView | undefined =>
        state.tasks[channelId]?.find(t => t.id === taskId)
    },
    busyCount(state) {
      return (channelId: string): number =>
        (state.agents[channelId] ?? []).filter(a => a.state === 'busy').length
    },
  },
  actions: {
    applySnapshot(payload: AepSnapshot): void {
      const { channelId } = payload
      this.channels[channelId] = { ...payload.channel, loadedAt: Date.now() }
      this.agents[channelId] = payload.agents.map(a => ({ ...a }))
      this.tasks[channelId] = payload.tasks.map(t => this.toTaskView(t))
    },
    applyEvent(e: AepEnvelope): void {
      const cid = e.channelId
      switch (e.type) {
        case 'agent.status': {
          const list = this.agents[cid] ?? []
          const p = e.payload as { agentId: string, state: AgentView['state'], currentTaskId?: string | null, queued?: number, completed?: number }
          const idx = list.findIndex(a => a.agentId === p.agentId)
          if (idx >= 0) list[idx] = { ...list[idx], ...p }
          else list.push({ agentId: p.agentId, name: p.agentId.slice(0, 8), role: 'worker', harness: '-', ...p })
          this.agents[cid] = [...list]
          break
        }
        case 'task.status': {
          const p = e.payload as { taskId: string, state: string, assigneeId?: string }
          const list = this.tasks[cid] ?? []
          const idx = list.findIndex(t => t.id === p.taskId)
          if (idx >= 0) list[idx] = { ...list[idx], state: p.state, assigneeId: p.assigneeId ?? list[idx].assigneeId }
          else list.push({ id: p.taskId, title: p.taskId.slice(0, 8), state: p.state, progress: 0, assigneeId: p.assigneeId ?? '', artifacts: 0 })
          this.tasks[cid] = [...list]
          break
        }
        case 'task.progress': {
          const p = e.payload as { taskId: string, progress: number }
          const list = this.tasks[cid] ?? []
          const idx = list.findIndex(t => t.id === p.taskId)
          if (idx >= 0) list[idx] = { ...list[idx], progress: p.progress }
          this.tasks[cid] = [...list]
          break
        }
        case 'a2a.artifact': {
          const p = e.payload as { taskId?: string }
          if (!p.taskId) break
          const list = this.tasks[cid] ?? []
          const idx = list.findIndex(t => t.id === p.taskId)
          if (idx >= 0) list[idx] = { ...list[idx], artifacts: list[idx].artifacts + 1 }
          this.tasks[cid] = [...list]
          break
        }
      }
    },
    toTaskView(t: AepSnapshot['tasks'][number]): TaskView {
      return {
        id: t.id,
        parentId: t.parentId,
        title: t.title,
        state: t.state,
        progress: t.progress,
        assigneeId: t.assigneeId,
        artifacts: t.artifacts.length,
        updatedAt: t.updatedAt,
      }
    },
    /** WS 断连后的 REST 兜底刷新(命令后立即对齐用) */
    refreshChannel(channelId: string, snapshot: AepSnapshot): void {
      this.applySnapshot(snapshot)
    },
  },
})

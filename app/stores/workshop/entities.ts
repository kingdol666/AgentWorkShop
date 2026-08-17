/**
 * 实体归一化:channel/agent/task 快照 + AEP 增量 upsert(幂等)。
 * REST 命令后的状态以 WS 事件回流为准(REST 返回值不直接写状态,避免双源)。
 */
import { defineStore } from 'pinia'
import { useUserStore } from './user'
import type { AepEnvelope, AepSnapshot } from '#shared/workshop-protocol'

export interface AgentView {
  agentId: string
  name: string
  role: 'lead' | 'worker'
  harness: string
  /** 实例启停(1 启用 / 0 禁用;缺省视为启用) */
  enabled?: number
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
    /** refreshTasks 进行中标志(节流) */
    refreshing: {} as Record<string, boolean>,
    /** refreshAgents 进行中标志(节流) */
    refreshingAgents: {} as Record<string, boolean>,
  }),
  getters: {
    agentById(state) {
      return (channelId: string, agentId: string): AgentView | undefined =>
        state.agents[channelId]?.find(a => a.agentId === agentId)
    },
    /** agent 名字解析(事件渲染用):已知成员取名字,否则 id 前 8 位 */
    agentName(state) {
      return (channelId: string, agentId?: string | null): string => {
        if (!agentId) return 'system'
        const a = state.agents[channelId]?.find(x => x.agentId === agentId)
        return a?.name ?? agentId.slice(0, 8)
      }
    },
    /** 任务标题解析(事件渲染用):已知任务取标题,否则 id 前 8 位 */
    taskTitle(state) {
      return (channelId: string, taskId?: string | null): string => {
        if (!taskId) return ''
        const t = state.tasks[channelId]?.find(x => x.id === taskId)
        return t?.title ?? taskId.slice(0, 8)
      }
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
    }, applyEvent(e: AepEnvelope): void {
      const cid = e.channelId
      switch (e.type) {
        case 'agent.status': {
          const list = this.agents[cid] ?? []
          const p = e.payload as { agentId: string, state: AgentView['state'], currentTaskId?: string | null, queued?: number, completed?: number }
          const idx = list.findIndex(a => a.agentId === p.agentId)
          const prev = idx >= 0 ? list[idx] : undefined
          if (prev) list[idx] = { ...prev, ...p }
          else {
            // 新 agent 只能从事件构建(无快照)→ 补默认名/角色/harness;显式构造避免 spread 覆盖
            const fresh: AgentView = {
              agentId: p.agentId,
              state: p.state,
              currentTaskId: p.currentTaskId ?? null,
              queued: p.queued,
              completed: p.completed,
              name: p.agentId.slice(0, 8),
              role: 'worker',
              harness: '-',
            }
            list.push(fresh)
            // 事件缺名字/角色等元信息 → 节流 REST 对齐补全(与任务同策略)
            this.refreshAgents(cid)
          }
          this.agents[cid] = [...list]
          break
        }
        case 'agent.member': {
          // 团队成员增/改/删(lead 执行中自主管理或用户 REST):实体列表实时增删改
          const p = e.payload as {
            op: 'added' | 'updated' | 'removed'
            agentId: string
            name: string
            role: 'lead' | 'worker'
            harness: string
            enabled?: number
            by: string
            reason?: string
          }
          const list = this.agents[cid] ?? []
          const idx = list.findIndex(a => a.agentId === p.agentId)
          if (p.op === 'added') {
            if (idx < 0) {
              list.push({
                agentId: p.agentId,
                name: p.name,
                role: p.role,
                harness: p.harness,
                enabled: p.enabled,
                state: 'idle',
                currentTaskId: null,
                queued: 0,
                completed: 0,
              })
            }
          }
          else if (p.op === 'updated') {
            if (idx >= 0) {
              list[idx] = {
                ...list[idx]!,
                name: p.name,
                harness: p.harness,
                enabled: p.enabled,
                // 禁用成员置 stopped(不再接新任务);重新启用回 idle
                state: p.enabled === 0 ? 'stopped' : (list[idx]!.state === 'stopped' ? 'idle' : list[idx]!.state),
              }
            }
          }
          else if (p.op === 'removed') {
            if (idx >= 0) list.splice(idx, 1)
          }
          this.agents[cid] = [...list]
          break
        }
        case 'task.status': {
          const p = e.payload as { taskId: string, state: string, assigneeId?: string }
          const list = this.tasks[cid] ?? []
          const idx = list.findIndex(t => t.id === p.taskId)
          const prev = idx >= 0 ? list[idx] : undefined
          if (prev) list[idx] = { ...prev, state: p.state, assigneeId: p.assigneeId ?? prev.assigneeId }
          else {
            // 订阅后新建的任务只能从事件构建(无标题)→ 触发节流 REST 对齐补全
            list.push({ id: p.taskId, title: p.taskId.slice(0, 8), state: p.state, progress: 0, assigneeId: p.assigneeId ?? '', artifacts: 0 })
            this.refreshTasks(cid)
          }
          this.tasks[cid] = [...list]
          break
        }
        case 'task.progress': {
          const p = e.payload as { taskId: string, progress: number }
          const list = this.tasks[cid] ?? []
          const idx = list.findIndex(t => t.id === p.taskId)
          const prev = idx >= 0 ? list[idx] : undefined
          if (prev) list[idx] = { ...prev, progress: p.progress }
          this.tasks[cid] = [...list]
          break
        }
        case 'a2a.artifact': {
          const p = e.payload as { taskId?: string }
          if (!p.taskId) break
          const list = this.tasks[cid] ?? []
          const idx = list.findIndex(t => t.id === p.taskId)
          const prev = idx >= 0 ? list[idx] : undefined
          if (prev) list[idx] = { ...prev, artifacts: prev.artifacts + 1 }
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
    /**
     * 节流 REST 成员对齐:事件流里冒出的未知 agent 缺 name/role/harness 元信息,
     * 拉一次成员列表 upsert(以 REST 为准;事件流继续增量更新 state)。
     */
    refreshAgents(channelId: string): void {
      if (this.refreshingAgents[channelId]) return
      this.refreshingAgents[channelId] = true
      $fetch<{ data?: Array<{ id: string, name: string, role: 'lead' | 'worker', harness: string }> }>(
        `/api/workshop/channels/${channelId}/agents`,
        { headers: { authorization: `Bearer ${useUserStore().token}` } },
      )
        .then((res) => {
          const fresh = res.data ?? []
          const merged = [...(this.agents[channelId] ?? [])]
          for (const m of fresh) {
            const idx = merged.findIndex(a => a.agentId === m.id)
            if (idx >= 0) merged[idx] = { ...merged[idx]!, name: m.name, role: m.role, harness: m.harness }
            else merged.push({ agentId: m.id, name: m.name, role: m.role, harness: m.harness, state: 'idle', currentTaskId: null, queued: 0, completed: 0 })
          }
          this.agents[channelId] = merged
        })
        .catch(() => {})
        .finally(() => {
          this.refreshingAgents[channelId] = false
        })
    },
    /**
     * 节流 REST 任务对齐:订阅后新建任务从事件构建时缺标题/父子关系,
     * 拉一次任务列表 upsert(以 REST 为准;事件流继续增量更新)。
     */
    refreshTasks(channelId: string): void {
      if (this.refreshing[channelId]) return
      this.refreshing[channelId] = true
      $fetch<{ data?: AepSnapshot['tasks'] }>(`/api/workshop/channels/${channelId}/tasks`, {
        headers: { authorization: `Bearer ${useUserStore().token}` },
      })
        .then((res) => {
          const fresh = res.data ?? []
          const current = this.tasks[channelId] ?? []
          const byId = new Map(current.map(t => [t.id, t]))
          this.tasks[channelId] = fresh.map((t) => {
            const prev = byId.get(t.id)
            const next = this.toTaskView(t)
            // 事件流可能已推进到更新的 state/progress:保留较新值
            return prev && (prev.state !== next.state || prev.progress > next.progress)
              ? { ...next, state: prev.state, progress: Math.max(prev.progress, next.progress) }
              : next
          })
        })
        .catch(() => {})
        .finally(() => {
          this.refreshing[channelId] = false
        })
    },
  },
})

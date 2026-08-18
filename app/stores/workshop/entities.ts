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
  /** 场景配置(含 systemPromptPrefix 等;由 WS 快照下发) */
  config?: Record<string, unknown>
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
          // 协议字段 queued/completed 为准;兼容旧帧(queuedCount/completedCount),避免 undefined 覆写实体
          const raw = e.payload as {
            agentId: string
            state: AgentView['state']
            currentTaskId?: string | null
            queued?: number
            completed?: number
            queuedCount?: number
            completedCount?: number
          }
          const p = {
            agentId: raw.agentId,
            state: raw.state,
            currentTaskId: raw.currentTaskId ?? null,
            queued: raw.queued ?? raw.queuedCount ?? 0,
            completed: raw.completed ?? raw.completedCount ?? 0,
          }
          const idx = list.findIndex(a => a.agentId === p.agentId)
          if (idx >= 0) {
            list[idx] = { ...list[idx]!, ...p }
          }
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
            config?: Record<string, unknown>
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
                config: p.config,
                state: 'idle',
                currentTaskId: null,
                queued: 0,
                completed: 0,
              })
            }
          }
          else if (p.op === 'updated') {
            if (idx >= 0) {
              const prev = list[idx]!
              list[idx] = {
                ...prev,
                name: p.name ?? prev.name,
                role: p.role ?? prev.role,
                harness: p.harness ?? prev.harness,
                enabled: p.enabled ?? prev.enabled,
                config: p.config ?? prev.config,
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
          // 事件正文携带标题/父级/进度/交付数(ws.ts 随任务行直推)→ 事件即实体,任务无需 REST 即可全量渲染
          const p = e.payload as {
            taskId: string
            state: string
            assigneeId?: string
            title?: string
            parentId?: string
            progress?: number
            artifacts?: number
          }
          const list = this.tasks[cid] ?? []
          const idx = list.findIndex(t => t.id === p.taskId)
          if (idx >= 0) {
            const prev = list[idx]!
            list[idx] = {
              ...prev,
              state: p.state,
              assigneeId: p.assigneeId ?? prev.assigneeId,
              title: p.title ?? prev.title,
              parentId: p.parentId ?? prev.parentId,
              progress: Math.max(prev.progress, p.progress ?? 0),
              artifacts: Math.max(prev.artifacts, p.artifacts ?? 0),
            }
          }
          else {
            const fresh: TaskView = {
              id: p.taskId,
              title: p.title ?? p.taskId.slice(0, 8),
              state: p.state,
              progress: p.progress ?? 0,
              assigneeId: p.assigneeId ?? '',
              artifacts: p.artifacts ?? 0,
            }
            if (p.parentId) fresh.parentId = p.parentId
            list.push(fresh)
            // 旧服务端帧不含正文(title 缺失)→ 兜底节流 REST 补全(新帧已自足,此路径不再触发)
            if (p.title === undefined) this.refreshTasks(cid)
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
      $fetch<{ data?: Array<{ id: string, name: string, role: 'lead' | 'worker', harness: string, config?: Record<string, unknown> }> }>(
        `/api/workshop/channels/${channelId}/agents`,
        { headers: { authorization: `Bearer ${useUserStore().token}` } },
      )
        .then((res) => {
          const fresh = res.data ?? []
          const merged = [...(this.agents[channelId] ?? [])]
          for (const m of fresh) {
            const idx = merged.findIndex(a => a.agentId === m.id)
            if (idx >= 0) merged[idx] = { ...merged[idx]!, name: m.name, role: m.role, harness: m.harness, config: m.config }
            else merged.push({ agentId: m.id, name: m.name, role: m.role, harness: m.harness, config: m.config, state: 'idle', currentTaskId: null, queued: 0, completed: 0 })
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
          // upsert 合并(不整表替换):REST 为准补全已知任务;WS 已知但 REST 尚未
          // 返回的极新任务保留(防丢失);重叠任务 progress 取两侧较大(state/title 以 REST 为准,
          // 避免旧事件帧状态黏附——REST 与 WS 同源于 DB,REST 至少不旧于已消费事件)
          const freshIds = new Set(fresh.map(t => t.id))
          const merged = fresh.map((t) => {
            const prev = byId.get(t.id)
            const next = this.toTaskView(t)
            return prev && prev.progress > next.progress
              ? { ...next, progress: prev.progress }
              : next
          })
          for (const t of current) {
            if (!freshIds.has(t.id)) merged.push(t)
          }
          this.tasks[channelId] = merged
        })
        .catch(() => {})
        .finally(() => {
          this.refreshing[channelId] = false
        })
    },
  },
})

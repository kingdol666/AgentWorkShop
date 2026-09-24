/**
 * 实体归一化:channel/agent/task 快照 + AEP 增量 upsert(幂等)。
 * REST 命令后的状态以 WS 事件回流为准(REST 返回值不直接写状态,避免双源)。
 */
import { defineStore } from 'pinia'
import { useUserStore } from './user'
import { narrowFetch } from './narrow-fetch'
import type { AepEnvelope, AepSnapshot, RootQueueView, AgentContextStats, HarnessContinuityView, SupervisionAttemptView } from '#shared/workshop-protocol'

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
  /** 执行中任务标题(lead 观察 worker 在干什么) */
  currentTaskTitle?: string | null
  /** 执行中任务进度 0-100(空闲/未上报为 null) */
  currentTaskProgress?: number | null
  /** 用户给该角色绑定的自定义模型(assetId;缺省用内置员工模型) */
  modelRef?: string | null
  queued?: number
  completed?: number
  /** 上下文用量(omp 有;进程内 harness 缺省) */
  context?: AgentContextStats | null
  /** 监督尝试状态(§2.3;watchdog / Lead 最后决策的可观测面) */
  supervision?: SupervisionAttemptView
  /** Harness 连续性租约(§2.4;continuity mode / pid / session / reuse / 重启原因) */
  continuity?: HarnessContinuityView
}

export interface TaskView {
  id: string
  parentId?: string
  rootQueueSeq?: number
  title: string
  state: string
  progress: number
  assigneeId: string
  artifacts: number
  retryCount?: number
  /** 派发路由理由(lead 审计决策) */
  routeReason?: string
  sourceChatMessageId?: string
  sourceChatDeliveryId?: string
  closeReason?: string
  deadlineAt?: string
  createdAt?: string
  updatedAt?: string
}

/** 终态判定(与后端 TERMINAL_TASK_STATES 同口径) */
function isTerminalState(state: string): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELED'
}

/** 空根队列投影(未收到快照/队列帧时的安全缺省) */
function emptyRootQueue(): RootQueueView {
  return { activeRootId: null, queuedRoots: [], completedRoots: 0, activeRootCount: 0, queuedRootCount: 0 }
}

/**
 * 快照缺 rootQueue 字段时的兜底推导(旧服务端帧/测试)。
 * 排序口径与后端一致:rootQueueSeq ASC,再 created_at ASC。
 */
function deriveRootQueue(tasks: AepSnapshot['tasks']): RootQueueView {
  const roots = tasks
    .filter(t => !t.parentId && t.rootQueueSeq != null)
    .sort((a, b) => (a.rootQueueSeq ?? 0) - (b.rootQueueSeq ?? 0)
      || String(a.createdAt).localeCompare(String(b.createdAt)))
  const open = roots.filter(t => !isTerminalState(t.state))
  return {
    activeRootId: open[0]?.id ?? null,
    queuedRoots: open.slice(1).map((t, i) => ({
      taskId: t.id,
      title: t.title,
      position: i + 2,
      state: t.state,
      createdAt: t.createdAt,
    })),
    completedRoots: roots.length - open.length,
    activeRootCount: open.length > 0 ? 1 : 0,
    queuedRootCount: Math.max(0, open.length - 1),
  }
}

export const useEntitiesStore = defineStore('workshop.entities', { state: () => ({
  channels: {} as Record<string, AepSnapshot['channel'] & { loadedAt: number }>,
  agents: {} as Record<string, AgentView[]>,
  tasks: {} as Record<string, TaskView[]>,
  /**
     * 根任务队列(§2.2/§8):**后端权威投影**,前端不再自行推导 active root。
     * 来源 = channel.snapshot.rootQueue + `root.queue` 增量帧。
     */
  rootQueues: {} as Record<string, RootQueueView>,
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
  /** 根任务队列(§2.2;后端权威投影 + 本地兜底推导) */
  rootQueue(state) {
    return (channelId: string): RootQueueView =>
      state.rootQueues[channelId] ?? emptyRootQueue()
  },
  /** active root id(前端所有"当前根任务"判断的**唯一**来源) */
  activeRootId(state) {
    return (channelId: string): string | null =>
      state.rootQueues[channelId]?.activeRootId
      ?? (state.tasks[channelId] ?? []).filter(t => !t.parentId && !isTerminalState(t.state))[0]?.id
      ?? null
  },
},
actions: {
  applySnapshot(payload: AepSnapshot): void {
    const { channelId } = payload
    this.channels[channelId] = { ...payload.channel, loadedAt: Date.now() }
    // 快照 agents 携带 config(server buildSnapshot);换装元数据 modelRef 从 config 派生,
    // 保证「再次进入直接加载用户选择的模型」——与 agent.member 事件路径同一语义。
    this.agents[channelId] = payload.agents.map(a => ({
      ...a,
      modelRef: (a as { config?: Record<string, unknown> }).config?.modelRef as string | undefined
        ?? (a as { modelRef?: string | null }).modelRef
        ?? null,
    }))
    this.tasks[channelId] = payload.tasks.map(t => this.toTaskView(t))
    // §2.2:根任务队列以后端投影为准(快照缺省时用任务列表兜底推导,避免 UI 空窗)
    this.rootQueues[channelId] = payload.rootQueue ?? deriveRootQueue(payload.tasks)
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
          currentTaskTitle?: string | null
          currentTaskProgress?: number | null
          queued?: number
          completed?: number
          queuedCount?: number
          completedCount?: number
          context?: AgentContextStats | null
          supervision?: SupervisionAttemptView
          continuity?: HarnessContinuityView
        }
        const p: Partial<AgentView> & { agentId: string, state: AgentView['state'], queued: number, completed: number } = {
          agentId: raw.agentId,
          state: raw.state,
          currentTaskId: raw.currentTaskId ?? null,
          currentTaskTitle: raw.currentTaskTitle ?? null,
          currentTaskProgress: raw.currentTaskProgress ?? null,
          queued: raw.queued ?? raw.queuedCount ?? 0,
          completed: raw.completed ?? raw.completedCount ?? 0,
          /** §8:监督 / 连续性帧必须落 store —— 旧实现丢弃 supervision,watchdog 只闪首帧 */
          ...(raw.context !== undefined ? { context: raw.context } : {}),
          ...(raw.supervision ? { supervision: raw.supervision } : {}),
          ...(raw.continuity ? { continuity: raw.continuity } : {}),
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
            ...(raw.supervision ? { supervision: raw.supervision } : {}),
            ...(raw.continuity ? { continuity: raw.continuity } : {}),
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
              modelRef: (p.config as { modelRef?: string } | undefined)?.modelRef ?? null,
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
            const nextConfig = p.config ?? prev.config
            list[idx] = {
              ...prev,
              name: p.name ?? prev.name,
              role: p.role ?? prev.role,
              harness: p.harness ?? prev.harness,
              enabled: p.enabled ?? prev.enabled,
              config: nextConfig,
              modelRef: (nextConfig as { modelRef?: string } | undefined)?.modelRef ?? prev.modelRef ?? null,
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
          rootQueueSeq?: number
          progress?: number
          routeReason?: string
          closeReason?: string
          deadlineAt?: string
          retryCount?: number
          createdAt?: string
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
            rootQueueSeq: p.rootQueueSeq ?? prev.rootQueueSeq,
            progress: Math.max(prev.progress, p.progress ?? 0),
            routeReason: p.routeReason ?? prev.routeReason,
            closeReason: p.closeReason ?? prev.closeReason,
            deadlineAt: p.deadlineAt ?? prev.deadlineAt,
            retryCount: p.retryCount ?? prev.retryCount,
            createdAt: p.createdAt ?? prev.createdAt,
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
          // §8 D4 修复:新建任务经 task.status 首现时必须带上 rootQueueSeq,
          // 否则前端排序/FIFO 展示与后端队列序号脱节。
          if (p.rootQueueSeq != null) fresh.rootQueueSeq = p.rootQueueSeq
          if (p.routeReason) fresh.routeReason = p.routeReason
          if (p.closeReason) fresh.closeReason = p.closeReason
          if (p.deadlineAt) fresh.deadlineAt = p.deadlineAt
          if (p.retryCount != null) fresh.retryCount = p.retryCount
          if (p.createdAt) fresh.createdAt = p.createdAt
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
      case 'root.queue': {
        // §3.4-3:后端权威根任务队列(active/queued/completed/位置)
        this.rootQueues[cid] = e.payload as RootQueueView
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
      rootQueueSeq: t.rootQueueSeq,
      title: t.title,
      state: t.state,
      progress: t.progress,
      assigneeId: t.assigneeId,
      artifacts: t.artifacts.length,
      routeReason: t.routeReason,
      sourceChatMessageId: t.sourceChatMessageId,
      sourceChatDeliveryId: t.sourceChatDeliveryId,
      retryCount: (t as { retryCount?: number }).retryCount,
      closeReason: (t as { closeReason?: string }).closeReason,
      deadlineAt: (t as { deadlineAt?: string }).deadlineAt,
      createdAt: t.createdAt,
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
    narrowFetch<{ data?: Array<{ id: string, name: string, role: 'lead' | 'worker', harness: string, config?: Record<string, unknown> }> }>(
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
    narrowFetch<{ data?: AepSnapshot['tasks'] }>(`/api/workshop/channels/${channelId}/tasks`, {
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

/**
 * TaskEngineViews —— 队列视图(全量/精简/单智能体/监督)
 * (拆分层,承 TaskEngineContracts;方法体与原文件逐行一致)
 */
import { TaskEngineContracts } from './contracts'
import type { A2AArtifact } from '../../types/a2a'
import type { AgentTaskQueueView, RootQueueView, TaskState, WorkspaceTask } from '../../types/task'
import type { MessageRepo } from '../../db/message.repo'
import type { TaskRepo } from '../../db/task.repo'
import { rowToTask, rowToTaskLite } from './helpers'
import { isChannelRecoveryBlocked, isLegacyRecoveryHeld, LEGACY_RECOVERY_MARKER } from './legacy-recovery'
import { AppError } from '../../../../utils/errors'
import { audit } from '../../ops/ops'

export abstract class TaskEngineViews extends TaskEngineContracts {
  /**
   * hooks.onTaskChange:任务状态迁移的统一通知点(monitor/WS 消费)。
   * 所有迁移必经 transition(),故状态事件不漏发;create/dispatch 的初始态直接落库,单独补发。
   */
  constructor(
    protected readonly repos: { tasks: TaskRepo, messages: MessageRepo },
    protected readonly hooks?: {
      /**
       * 任务变更广播(状态迁移带 state;进度变化带 progress;终态迁移经 transition
       * 统一触发)。状态/进度的实时同步唯一出口 —— 前端/WS/monitor 据此对齐实体。
       */
      onTaskChange?(e: { taskId: string, channelId: string, state?: TaskState, progress?: number, agentId?: string, task?: WorkspaceTask, artifactName?: string, artifactId?: string, reassignFrom?: string, reason?: string }): void
      /**
       * 开工栅栏（H0）：project 来源任务进入 WORKING 前由组合根校验项目/工作项/attempt
       * 仍可执行。返回 false 时 transition 抛 PROJECT_NOT_ACTIVE，任务保持原状态，
       * 防止"取消/终止后才被领取"的任务真正执行。未注入时保持既有行为（测试替身）。
       */
      guardProjectTaskStart?(task: WorkspaceTask): boolean
    },
  ) {
    super()
  }

  /** 单 agent 任务队列视图(queued FIFO / current / completed;派生只读投影,无第二份状态) */
  /**
   * FIFO 根任务队列视图(§2.2 RootQueueView)。
   *
   * 后端统一派生,前端不自行推导(前后端对 active root 的判断必须同源):
   *  - `activeRoot`:最早的非终态 root(状态非 COMPLETED/FAILED/CANCELED,root_queue_seq ASC,id 稳定次级序);
   *  - `queuedRoots`:其余非终态 root,`position` 从 2 起(1 = active);
   *  - `completedRoots`:终态 root **计数**(§2.2 口径)。
   */
  rootQueueView(channelId: string): RootQueueView {
    const queue = this.rootQueue(channelId)
    return {
      activeRootId: queue.activeRoot?.id ?? null,
      activeRoot: queue.activeRoot,
      queuedRoots: queue.queuedRoots.map((task, i) => ({ task, position: i + 2 })),
      completedRoots: queue.completedRoots.length,
      activeRootCount: queue.activeRoot ? 1 : 0,
      queuedRootCount: queue.queuedRoots.length,
    }
  }

  /** A hold is durable until an explicit operator disposition; terminal nodes count too. */
  hasLegacyRecoveryHold(channelId: string): boolean {
    return this.repos.tasks.listByChannelMeta(channelId).some(isLegacyRecoveryHeld)
  }

  /** Held trees and roots behind a held root cannot enter execution. */
  isLegacyRecoveryBlocked(taskId: string): boolean {
    const task = this.repos.tasks.findById(taskId)
    if (!task) return true
    const rows = this.repos.tasks.listByChannelMeta(task.channelId)
    if (isChannelRecoveryBlocked(taskId, rows)) return true
    return this.repos.tasks.projectRecoveryBlocked?.(taskId) ?? false
  }

  /** 运维面:当前全部恢复保留任务(含树内消息计数,供处置前调查)。 */
  listLegacyRecoveryHolds(): Array<{ taskId: string, channelId: string, assigneeId: string, title: string, state: string, closeReason: string, createdAt: string, messages: { pending: number, consuming: number, dead: number } }> {
    return this.repos.tasks.listRecoveryHolds(LEGACY_RECOVERY_MARKER).map((row) => {
      const counts = this.repos.tasks.recoveryHoldMessageCounts(row.id)
      return {
        taskId: row.id, channelId: row.channelId, assigneeId: row.assigneeId,
        title: row.title, state: row.state, closeReason: row.closeReason ?? '',
        createdAt: row.createdAt, messages: counts,
      }
    })
  }

  /**
   * 运维面:显式处置(释放)恢复保留。只清 marker + 复位在飞消息投递预算,
   * 不自动重放任何执行 —— 重新执行必须由操作员走显式 retry/reopen。
   * 全程写审计;失败静默的 audit() 不影响处置主路径。
   */
  disposeLegacyRecoveryHold(taskId: string, actor: { id: string, name?: string }, note?: string): { released: string[], requeued: number, unblockedPending: number } {
    const result = this.repos.tasks.disposeLegacyRecoveryHold(taskId, LEGACY_RECOVERY_MARKER)
    if (!result) {
      const task = this.repos.tasks.findById(taskId)
      if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
      throw new AppError(409, 'NOT_HELD', `任务 ${taskId} 不在 legacy 恢复保留中`)
    }
    audit({
      actor: actor.id,
      actorName: actor.name ?? '',
      actorKind: 'user',
      action: 'task.recovery_disposition',
      targetKind: 'task',
      targetId: taskId,
      detail: { released: result.released, requeued: result.requeued, unblockedPending: result.unblockedPending, note: note ?? '' },
      summary: `释放 legacy 恢复保留:${result.released.length} 个任务,复位 ${result.requeued} 条在飞消息(待投 ${result.unblockedPending})`,
      level: 'warn',
    })
    return result
  }

  protected assertLegacyRecoveryAdmission(taskId: string): void {
    if (this.isLegacyRecoveryBlocked(taskId)) {
      throw new AppError(409, 'LEGACY_EXECUTION_RECOVERY_REQUIRED', `Task ${taskId} requires operator investigation; execution was not replayed`)
    }
  }

  /** FIFO root queue: only the oldest non-terminal root is active. */
  rootQueue(channelId: string): { activeRoot: WorkspaceTask | null, queuedRoots: WorkspaceTask[], completedRoots: WorkspaceTask[] } {
    const roots = this.repos.tasks.listRoots(channelId).map(rowToTask)
    const terminal = (t: WorkspaceTask) => t.state === 'COMPLETED' || t.state === 'FAILED' || t.state === 'CANCELED'
    const open = roots.filter(t => !terminal(t))
    return { activeRoot: open[0] ?? null, queuedRoots: open.slice(1), completedRoots: roots.filter(terminal) }
  }

  activeRootOf(channelId: string): WorkspaceTask | null {
    return this.rootQueue(channelId).activeRoot
  }

  /** 批量队列视图:一次 list(channel) 聚合全部成员(调度快照热路径,消除 O(M) 次查询) */
  queueViewsOf(channelId: string): Map<string, AgentTaskQueueView> {
    const rows = this.repos.tasks.listByChannel(channelId)
    const views = new Map<string, AgentTaskQueueView>()
    for (const row of rows) {
      const task = rowToTask(row)
      let v = views.get(task.assigneeId)
      if (!v) {
        v = { agentId: task.assigneeId, channelId, queued: [], completed: [] }
        views.set(task.assigneeId, v)
      }
      if (task.state === 'SUBMITTED' || task.state === 'ASSIGNED') v.queued.push(task)
      else if (task.state === 'WORKING') v.current = task
      else if (task.state === 'COMPLETED') v.completed.push(task)
      // WAITING(等子任务)/FAILED/CANCELED 不计入队列
    }
    return views
  }

  /** 批量队列视图 lite 版(调度快照热路径):元数据投影,免 artifacts/history JSON 大列解析 */
  queueViewsOfLite(channelId: string): Map<string, AgentTaskQueueView> {
    const rows = this.repos.tasks.listByChannelMeta(channelId)
    const views = new Map<string, AgentTaskQueueView>()
    for (const row of rows) {
      const task = rowToTaskLite(row)
      let v = views.get(task.assigneeId)
      if (!v) {
        v = { agentId: task.assigneeId, channelId, queued: [], completed: [] }
        views.set(task.assigneeId, v)
      }
      if (task.state === 'SUBMITTED' || task.state === 'ASSIGNED') v.queued.push(task)
      else if (task.state === 'WORKING') v.current = task
      else if (task.state === 'COMPLETED') v.completed.push(task)
    }
    return views
  }

  /** 任务列表 lite 版(调度快照热路径):元数据投影,免 artifacts/history JSON 大列解析。
   *  调度决策/规则引擎/LLM 快照仅消费 id/state/parent/assignee/progress/title/description/retry;
   *  artifacts 置空 → LLM 交付预览行降级为无交付摘要(状态/进度/标题仍完整)。 */
  listLite(channelId: string): WorkspaceTask[] {
    return this.repos.tasks.listByChannelMeta(channelId).map(rowToTaskLite)
  }

  /**
   * 调度监督快照：轻量任务元数据 + Lead root 的用户输入 + 未结父任务下已完成子任务的有界交付物。
   * artifacts 是 Lead 验收的必要事实，history 不是；每个子任务最多 4KB 文本，
   * 最多取 24 个交付，防止长跑 Channel 把整段历史/无限产物塞入每轮 Lead prompt。
   * 超限仍可由 Lead 通过 get_task 读取单个任务完整交付物。
   */
  listForSupervision(channelId: string, leadAgentId: string): WorkspaceTask[] {
    const rows = this.repos.tasks.listByChannelMeta(channelId)
    const artifactsByTask = new Map<string, A2AArtifact[]>()
    for (const row of this.repos.tasks.listActiveSupervisionArtifacts(channelId, leadAgentId, 40)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.artifactsJson)
      }
      catch {
        parsed = []
      }
      if (!Array.isArray(parsed)) continue
      let remaining = 4_000
      const bounded = (parsed as A2AArtifact[]).slice(0, 8).map((artifact) => {
        const parts = (Array.isArray(artifact.parts) ? artifact.parts : []).flatMap((part) => {
          if ('text' in part) {
            if (remaining <= 0) return []
            const text = part.text.slice(0, remaining)
            remaining -= text.length
            return [{ ...part, text }]
          }
          // Non-text payloads can be arbitrarily large; expose only a bounded descriptor.
          const descriptor = JSON.stringify(part)
          if (remaining <= 0) return []
          const text = descriptor.slice(0, Math.min(remaining, 512))
          remaining -= text.length
          return [{ text: `[non-text artifact omitted] ${text}` }]
        })
        return { ...artifact, parts }
      })
      artifactsByTask.set(row.taskId, bounded)
    }

    return rows.map((row) => {
      const task = rowToTaskLite(row)
      return { ...task, artifacts: artifactsByTask.get(task.id) ?? [] }
    })
  }

  queueViewOf(channelId: string, agentId: string): AgentTaskQueueView {
    // META 投影:本视图在每次 agent 状态广播/队列上下文/调度收口时触发,
    // 全历史整行取回(含 artifacts/history 大 JSON 解析)是最高频的重复解析 ——
    // 队列消费方仅需 id/state/progress/title 等元数据,artifacts 置空即可
    const rows = this.repos.tasks.listByChannelAssigneeMeta(channelId, agentId)
    const queued: WorkspaceTask[] = []
    let current: WorkspaceTask | undefined
    const completed: WorkspaceTask[] = []
    for (const row of rows) {
      const task = rowToTaskLite(row)
      if (task.state === 'SUBMITTED' || task.state === 'ASSIGNED') queued.push(task)
      else if (task.state === 'WORKING') current = task
      else if (task.state === 'COMPLETED') completed.push(task)
      // WAITING(等子任务)/FAILED/CANCELED 不计入队列
    }
    return { agentId, channelId, queued, current, completed }
  }
}

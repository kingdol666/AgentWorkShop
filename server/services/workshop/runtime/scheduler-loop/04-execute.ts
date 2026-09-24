/**
 * SchedulerLoopLayer04 —— 决策执行 / 唤醒 / 空闲刷新 / 协作完成判定
 * (分层 5/5,承 SchedulerLoopLayer03;方法体与原文件逐行一致)
 */
import { SchedulerLoopLayer03 } from './03-rules'
import type { A2AMessage } from '../../types/a2a'
import type { AgentWorkspace, SupervisionSnapshot } from '../../agents/agent-interface'
import type { SchedulerDecision } from './types'
import { AppError } from '../../../../utils/errors'
import { LoopController, extractTaskMode, isGoalSummaryArtifact } from '../execution-mode'
import { log } from './helpers'
import { randomUUID } from 'node:crypto'
import { TERMINAL_TASK_STATES } from '../../types/task'
import { rootQueueEnabled } from '../../settings'

export abstract class SchedulerLoopLayer04 extends SchedulerLoopLayer03 {
  /** 执行单条决策(身份=lead,经 TaskEngine 与 ChannelRuntime) */
  protected execute(decision: SchedulerDecision): void {
    switch (decision.kind) {
      case 'wait': {
        // wait is an explicit, auditable Lead decision. It must not be treated as
        // an empty/failed supervise turn and must not mutate the task.
        log.info(`[SchedulerLoop:${this.lead.agentId}] Lead wait: ${decision.rootId ?? '-'} ${decision.reason ?? ''}`)
        this.noteLeadDecision({ decision: 'wait', rootId: decision.rootId, reason: decision.reason })
        break
      }
      case 'guide': {
        const task = this.lead.taskEngine.get(decision.taskId)
        if (!task || TERMINAL_TASK_STATES[task.state]) break
        const target = this.channelRuntime.listChannelAgents().find(a => a.agentId === decision.toAgentId)
        if (!target) break
        const message: A2AMessage = {
          messageId: randomUUID(),
          contextId: this.channelRuntime.channelId,
          role: 'ROLE_AGENT',
          taskId: task.id,
          parts: [{ text: decision.message }],
          metadata: {
            'x-aw-target-agent': decision.toAgentId,
            'x-aw-from-agent': this.lead.agentId,
            'x-aw-task-id': task.id,
            'x-aw-task-kind': 'guide',
          },
        }
        this.channelRuntime.route(message)
        this.wakeAgent(decision.toAgentId)
        this.noteLeadDecision({ decision: 'guide', taskId: task.id, toAgentId: decision.toAgentId, reason: decision.message.slice(0, 200) })
        break
      }
      case 'dispatch': {
        if (!decision.parentTaskId) {
          throw new AppError(400, 'INVALID_DECISION', 'dispatch 决策缺少 parentTaskId')
        }
        // HITL 竞态守卫:快照后成员可能已被用户/lead 移除,目标不存在则跳过本轮
        // (任务保持 SUBMITTED/WORKING,下一轮快照重新决策;避免派发给幽灵成员)
        // listChannelAgents 仅返回 enabled=1 成员,存在即可用
        const target = this.channelRuntime.listChannelAgents().find(a => a.agentId === decision.assigneeId)
        if (!target || !this.channelRuntime.isAgentEnabled(decision.assigneeId)) {
          log.warn(`[SchedulerLoop:${this.lead.agentId}] dispatch 目标成员已不存在/禁用,跳过: ${decision.assigneeId}`)
          break
        }
        const parent = this.lead.taskEngine.get(decision.parentTaskId)
        // FIFO root admission: a stale Lead decision for a queued root is ignored
        // silently. Do not turn a normal queue handoff into an execution error.
        // §11 root_queue_enabled=false 时退回多根并发(不做队列准入)。
        const root = parent?.parentId ? this.lead.taskEngine.get(parent.parentId) : parent
        const activeRoot = rootQueueEnabled() ? this.lead.taskEngine.activeRootOf(this.channelRuntime.channelId) : null
        if (activeRoot && root?.rootQueueSeq != null && root.id !== activeRoot.id) break
        // 快照后的陈旧派发决策不得重新打开已收口/超时的父任务。
        if (!parent || TERMINAL_TASK_STATES[parent.state] || parent.closeReason === 'ROOT_TIMEOUT') break
        // lead 自动接取:SUBMITTED → WORKING(§2.2 状态机,dispatch 需父任务处于 WORKING/WAITING)
        if (parent.state === 'SUBMITTED') {
          this.lead.taskEngine.transition(parent.id, 'WORKING', this.lead.agentId)
        }
        this.lead.taskEngine.dispatch(parent, {
          assigneeId: decision.assigneeId,
          title: decision.title,
          description: decision.description,
          parts: decision.parts,
        })
        this.wakeAgent(decision.assigneeId)
        break
      }
      case 'reassign': {
        const current = this.lead.taskEngine.get(decision.taskId)
        if (!current || current.state === 'COMPLETED' || current.state === 'CANCELED' || current.closeReason === 'ROOT_TIMEOUT') break
        // HITL 竞态守卫:目标成员被移除/禁用时跳过重派(任务保持 FAILED,留待 lead/用户重试)
        // listChannelAgents 仅返回 enabled=1 成员,存在即可用
        const target = this.channelRuntime.listChannelAgents().find(a => a.agentId === decision.toAgentId)
        if (!target) {
          log.warn(`[SchedulerLoop:${this.lead.agentId}] reassign 目标成员已不存在/禁用,跳过: ${decision.toAgentId}`)
          break
        }
        if (current.state === 'WORKING' || current.state === 'WAITING') {
          // §5.2 运行中重分配:撤销旧 lease + generation+1 + 新 assign,
          // 再对旧 worker 执行 task-local abort(只中它这一条任务,不误杀其它任务)。
          const { previousAssigneeId } = this.lead.taskEngine.reassignRunning(
            decision.taskId,
            decision.toAgentId,
            this.lead.agentId,
            decision.reason ?? 'LEAD_REASSIGN',
          )
          this.channelRuntime.getAgents().find(a => a.agentId === previousAssigneeId)?.abortTask?.(decision.taskId)
          log.info(`[SchedulerLoop:${this.lead.agentId}] 运行中重分配 task=${decision.taskId.slice(0, 8)} ${previousAssigneeId.slice(0, 8)} → ${decision.toAgentId.slice(0, 8)}`)
        }
        else {
          this.lead.taskEngine.reassign(decision.taskId, decision.toAgentId, decision.reason)
        }
        this.wakeAgent(decision.toAgentId)
        this.noteLeadDecision({ decision: 'reassign', taskId: decision.taskId, toAgentId: decision.toAgentId, reason: decision.reason })
        break
      }
      case 'cancel': {
        const task = this.lead.taskEngine.get(decision.taskId)
        // 快照后的陈旧取消决策不得再次操作终态任务(包括已超时/已收口任务)。
        if (!task || TERMINAL_TASK_STATES[task.state] || task.closeReason === 'ROOT_TIMEOUT') break
        this.lead.taskEngine.cancel(decision.taskId, this.lead.agentId, decision.reason ?? 'LEAD_CANCEL')
        // lead 终态同步:经调度器判定取消同样不经 processMessage,重广播队列上下文
        this.lead.refreshStatus()
        const assignee = this.channelRuntime.getAgents().find(a => a.agentId === task.assigneeId)
        assignee?.abortTask?.(task.id)
        this.noteLeadDecision({ decision: 'cancel', taskId: task.id, reason: decision.reason ?? 'LEAD_CANCEL' })
        break
      }
      case 'complete': {
        // 幂等守卫:LLM lead 可能对已终态任务重复 complete(快照滞后/重复决策)——
        // 静默跳过而非报错,避免调度噪音(正确性不受影响:终态即目标状态)
        const existing = this.lead.taskEngine.get(decision.taskId)
        if (!existing || TERMINAL_TASK_STATES[existing.state] || existing.closeReason === 'ROOT_TIMEOUT') {
          break
        }
        const completed = this.lead.taskEngine.complete(decision.taskId, decision.artifacts)
        // lead 状态同步:complete 由调度器直接收口(不经 processMessage),终态迁移后
        // 重广播 lead 队列上下文(current→null/completed+1),前端实时反映 lead 判定完成
        this.lead.refreshStatus()
        // 汇总成果走统一事件流(与 harness 事件同构,monitor/WS 可见)
        for (const artifact of decision.artifacts ?? []) {
          this.lead.emitExternal({ kind: 'artifact', artifact }, this.lead.agentId)
        }
        // goal 保底合成产物(lead 未自带总结时 taskEngine 追加)同样广播
        const knownArtifacts = new Set((decision.artifacts ?? []).map(a => a.artifactId))
        for (const artifact of completed.artifacts) {
          if (isGoalSummaryArtifact(artifact) && !knownArtifacts.has(artifact.artifactId)) {
            this.lead.emitExternal({ kind: 'artifact', artifact }, this.lead.agentId)
          }
        }
        // lead 终态记忆沉淀:调度器直接收口不经过 processMessage,此处补齐 harvest(异常不阻塞调度)
        void this.lead.recordTaskMemory(completed).catch(() => {})
        if (completed.parentId) {
          this.lead.taskEngine.onChildCompleted(completed)
          const parent = this.lead.taskEngine.get(completed.parentId)
          if (parent) this.wakeAgent(parent.assigneeId)
        }
        break
      }
      case 'notify': {
        const message: A2AMessage = {
          messageId: randomUUID(),
          contextId: this.channelRuntime.channelId,
          role: 'ROLE_AGENT',
          parts: decision.parts,
          metadata: {
            'x-aw-target-agent': decision.toAgentId,
            'x-aw-from-agent': this.lead.agentId,
          },
        }
        this.channelRuntime.route(message)
        break
      }
      // 团队成员管理决策(lead 自主扩容/调参/裁撤;经 AgentWorkspace 与工具桥同源路径)。
      // fire-and-forget:成员落库即刻对下一轮快照可见,dispatch 在后续 tick 自然衔接。
      case 'spawn_agent': {
        const ws: AgentWorkspace = this.lead.workspace
        void ws.createTeamMember({
          name: decision.name,
          harness: decision.harness,
          config: decision.config,
          templateId: decision.templateId,
          reason: decision.reason,
        }).catch((err) => {
          log.error(`[SchedulerLoop:${this.lead.agentId}] spawn_agent 决策执行失败:`, err)
        })
        break
      }
      case 'update_agent': {
        const ws: AgentWorkspace = this.lead.workspace
        void ws.updateTeamMember(decision.agentId, {
          name: decision.name,
          config: decision.config,
          enabled: decision.enabled === undefined ? undefined : (decision.enabled ? 1 : 0),
          reason: decision.reason,
        }).catch((err) => {
          log.error(`[SchedulerLoop:${this.lead.agentId}] update_agent 决策执行失败:`, err)
        })
        break
      }
      case 'remove_agent': {
        const ws: AgentWorkspace = this.lead.workspace
        void ws.removeTeamMember(decision.agentId, decision.reason).catch((err) => {
          log.error(`[SchedulerLoop:${this.lead.agentId}] remove_agent 决策执行失败:`, err)
        })
        break
      }
    }
  }

  protected wakeAgent(agentId: string): void {
    this.channelRuntime.wakeAgent(agentId)
  }

  protected refreshIdle(members: SupervisionSnapshot['members'], now: number): void {
    const liveIds = new Set(members.map(m => m.agentId))
    // 修剪已删除成员的残留条目(成员删除时正 idle → 不在 liveIds,不清会永久残留)
    for (const id of this.idleSince.keys()) {
      if (!liveIds.has(id)) this.idleSince.delete(id)
    }
    for (const m of members) {
      if (m.state === 'idle') {
        if (!this.idleSince.has(m.agentId)) this.idleSince.set(m.agentId, now)
      }
      else {
        this.idleSince.delete(m.agentId)
      }
    }
  }

  /**
   * 从本轮空闲池选最优 worker 并消费(选中即移出,一轮不重复用):
   * 队列最短优先(负载均衡),空闲最久次之(FIFO 兜底)。
   */
  protected pickWorker(pool: SupervisionSnapshot['members'], now: number, exclude?: string) {
    const idx = pool.findIndex(w => w.agentId !== exclude)
    if (idx < 0) return undefined
    let best = idx
    for (let i = idx + 1; i < pool.length; i++) {
      const a = pool[i]!
      const b = pool[best]!
      const byQueue = (a.queued ?? 0) - (b.queued ?? 0)
      const byIdle = (this.idleSince.get(a.agentId) ?? now) - (this.idleSince.get(b.agentId) ?? now)
      if (byQueue < 0 || (byQueue === 0 && byIdle < 0)) best = i
    }
    return pool.splice(best, 1)[0]
  }

  /** loop 模式:检测主任务完成 → 启动循环控制器重放 */
  protected checkLoopCompletion(snapshot: SupervisionSnapshot): void {
    if (this.activeMode !== 'loop') return

    // 找到当前循环新完成的 COMPLETED 主任务(尚未通知过控制器)。
    // bootAt 过滤:loopCompletedTaskIds 是内存态,进程重启后为空 —— 不过滤会把
    // 重启前已完成的主任务再识别一次并 resubmit(多跑一轮);只认本进程生命
    // 周期内完成的任务,重启前的历史 loop 由用户/上游重新提交
    const current = snapshot.tasks.find((t) => {
      if (t.assigneeId !== this.lead.agentId) return false
      if (t.state !== 'COMPLETED') return false
      if (this.loopCompletedTaskIds.has(t.id)) return false
      if (Date.parse(t.updatedAt) < this.bootAt) return false
      const modeInfo = extractTaskMode(t)
      return !!modeInfo && modeInfo.mode === 'loop'
    })
    if (!current) {
      // 无新的完成事件,但控制器可能已达到最大次数:清空以允许后续新 loop 任务重新开始
      if (this.loopController?.exhausted) {
        this.loopController = null
      }
      return
    }

    // 同一主任务只通知一次(防每轮 tick 重复计数)
    this.loopCompletedTaskIds.add(current.id)

    // 已有控制器 → 让控制器推进下一轮
    if (this.loopController) {
      this.loopController.onTaskCompleted()
      return
    }

    // 创建 loop 控制器 → 每次主任务完成后等待 intervalMs 再重新提交相同任务
    const modeInfo = extractTaskMode(current)!
    const intervalMs = Math.min(86_400_000, Math.max(100, Math.floor(modeInfo.config.intervalMs ?? 60_000)))
    const maxIterations = modeInfo.config.maxIterations ?? Number.POSITIVE_INFINITY
    if (this.onLoopResubmit) {
      this.loopController = new LoopController(
        this.channelRuntime.channelId,
        current.title,
        current.description ?? '',
        intervalMs,
        maxIterations,
        modeInfo.config.maxDurationMs,
        this.onLoopResubmit,
      )
      this.loopController.onTaskCompleted()
    }
  }
}

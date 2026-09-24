/**
 * AgentRuntimeLayer02 —— 监督回合接续 / 任务记忆 / 执行锁 / 消费循环
 * (分层 3/4,承 AgentRuntimeLayer01;方法体与原文件逐行一致)
 */
import { AgentRuntimeLayer01 } from './01-lifecycle'
import type { AgentRunContext, SupervisionDecision, SupervisionSnapshot } from '../../agents/agent-interface'
import { randomUUID } from 'node:crypto'
import type { WorkspaceTask } from '../../types/task'
import { log } from './helpers'
import { superviseWatchdogOnly, workshopSettings } from '../../settings'

export abstract class AgentRuntimeLayer02 extends AgentRuntimeLayer01 {
  async supervise(snapshot: SupervisionSnapshot): Promise<SupervisionDecision[] | null> {
    if (!this.impl.supervise) return null
    // §6.2/§2.4:监督回合与 worker 回合共用同一 harness 进程/会话 —— 先观测租约,
    // 身份变化(重建)在此时归因,复用则 reuseCount+1。
    this.noteHarnessUse()
    // lead 调度记忆:非终态/失败任务标题 + 成员名构造查询;touch:false 防 tick 通胀
    let memoryBlock: string | undefined
    try {
      const query = [
        ...snapshot.tasks.filter(t => t.state === 'SUBMITTED' || t.state === 'FAILED' || t.state === 'WAITING').map(t => t.title),
        ...snapshot.members.map(m => m.name),
      ].join(' ')
      memoryBlock = (await this.deps.memory?.recall(query, { touch: false })) ?? undefined
    }
    catch (err) {
      log.error(`[AgentRuntime:${this.agentId}] supervise 记忆召回失败:`, err)
    }
    const controller = new AbortController()
    this.superviseController = controller
    const policy = this.impl.getSupervisionPolicy?.() ?? {
      watchdogMs: Number(workshopSettings().supervise_watchdog_ms) || 90_000,
      hardTimeoutMs: Number(workshopSettings().supervise_hard_timeout_ms) || 900_000,
    }
    const attemptId = randomUUID()
    const startedAt = new Date().toISOString()
    this.supervisionAttempt = {
      attemptId,
      channelId: this.channelId,
      leadAgentId: this.agentId,
      state: 'RUNNING',
      startedAt,
      watchdogAt: null,
      completedAt: null,
      snapshotRevision: snapshot.tick,
      activeRootId: snapshot.activeRootId ?? null,
      watchdogCount: 0,
      lastSignalAt: null,
      lastDecisionKind: null,
    }
    // §11 supervise_watchdog_only=false 时回退旧行为:watchdog 即中止回合。
    // 默认(true)下 watchdog 只记录信号 + 提示同一会话,绝不 abort/kill/重建 Harness。
    const watchdogOnly = superviseWatchdogOnly()
    const watchdogTimer = setTimeout(() => {
      markWatchdog()
      if (!watchdogOnly) {
        this.supervisionAttempt = { ...this.supervisionAttempt, state: 'ABORT_REQUESTED' }
        this.refreshStatus()
        controller.abort()
        return
      }
      this.supervisionAttempt = { ...this.supervisionAttempt, state: 'WAITING_FOR_RESULT' }
      this.refreshStatus()
    }, Math.max(1_000, policy.watchdogMs))
    const hardTimer = policy.hardTimeoutMs > 0
      ? setTimeout(() => {
          this.supervisionAttempt = { ...this.supervisionAttempt, state: 'ABORT_REQUESTED' }
          this.refreshStatus()
          controller.abort()
        }, Math.max(policy.watchdogMs + 1_000, policy.hardTimeoutMs))
      : null
    let watchdogFired = false
    const markWatchdog = (at = Date.now()): void => {
      if (watchdogFired) return
      watchdogFired = true
      const iso = new Date(at).toISOString()
      this.supervisionAttempt = {
        ...this.supervisionAttempt,
        state: 'WATCHDOG_SIGNALED',
        watchdogAt: iso,
        lastSignalAt: iso,
        watchdogCount: this.supervisionAttempt.watchdogCount + 1,
      }
      this.refreshStatus()
      // §7.1 supervise.watchdog:监督信号必须可观测、可记忆 —— 交给 manager 写共享记忆。
      this.deps.onSupervisionSignal?.({
        agentId: this.agentId,
        channelId: this.channelId,
        attemptId,
        kind: 'watchdog',
        activeRootId: this.supervisionAttempt.activeRootId,
        snapshotRevision: this.supervisionAttempt.snapshotRevision ?? null,
        watchdogCount: this.supervisionAttempt.watchdogCount,
        at: iso,
      })
      // Watchdog is an observational control signal. If the harness can steer,
      // inject into the same session; if not, the current turn continues and the
      // signal remains visible to the next supervision result.
      void this.impl.steer?.('[系统监督 watchdog] 当前调度回合已超过观察阈值。请基于真实 worker 进度判断 wait、guide、reassign、cancel 或 complete；不要创建重复任务。')
        .catch(() => {})
    }
    const ctx: AgentRunContext = {
      agentId: this.agentId,
      channelId: this.channelId,
      role: this.role,
      workspace: this.deps.workspace,
      signal: controller.signal,
      memory: memoryBlock,
    }
    let decisions: SupervisionDecision[] | null = null
    try {
      decisions = await this.impl.supervise(snapshot, ctx, { signal: controller.signal, onWatchdog: at => markWatchdog(at) })
      return decisions
    }
    catch (err) {
      // 监督回合失败是 Harness 重建的候选归因(§6.2 prompt fail / RPC 断裂)
      this.pendingHarnessFailure = 'PROMPT_FAIL'
      throw err
    }
    finally {
      if (watchdogTimer) clearTimeout(watchdogTimer)
      if (hardTimer) clearTimeout(hardTimer)
      if (this.superviseController === controller) this.superviseController = null
      const settled = controller.signal.aborted ? 'ABORTED' : 'DECISION_APPLIED'
      // §2.3:落定审计 —— 完成时刻 + 最后决策类型(§8「Lead 最后决策」的数据源)
      const lastDecisionKind = decisions && decisions.length > 0
        ? decisions.map(d => d.kind).join(',')
        : (watchdogFired ? 'none_after_watchdog' : 'none')
      this.supervisionAttempt = {
        ...this.supervisionAttempt,
        state: settled,
        completedAt: new Date().toISOString(),
        lastDecisionKind,
      }
      this.refreshStatus()
      // §4.1 状态机:IDLE → RUNNING → … → DECISION_APPLIED → IDLE。
      // attempt 落定即结束 —— 回到 IDLE 才能让 §6.1 的「无 active supervise attempt」
      // 卸载闸门重新成立(审计信息保留在 completedAt/lastDecisionKind/watchdogCount)。
      this.supervisionAttempt = { ...this.supervisionAttempt, state: 'IDLE' }
      this.refreshStatus()
      // 调度回合落定:lead 的 supervise 是上下文膨胀大户,同样走 post-settle 压缩检查
      this.maybePostSettle()
    }
  }

  /**
   * 平台侧任务记忆沉淀(调度器直接执行决策的收口路径):
   * lead 经 supervise 决策 complete/cancel 任务时不经过 processMessage,
   * 由 SchedulerLoop 调用此方法补齐终态 harvest(与 worker 路径同源)。
   */
  async recordTaskMemory(task: WorkspaceTask): Promise<void> {
    await this.deps.memory?.recordTaskOutcome(task)
  }

  /** run/supervise 互斥执行(promise 链;供消费循环与 SchedulerLoop 串行化) */
  withExecLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.execLock
    let release!: () => void
    this.execLock = new Promise<void>((r) => {
      release = r
    })
    return (async () => {
      await prev
      try {
        return await fn()
      }
      finally {
        release()
      }
    })()
  }

  /** 消费循环:空闲自动接取,执行中不打断 */
  protected async consumeLoop(): Promise<void> {
    while (this.state !== 'stopped') {
      const msg = await this.deps.mailbox.dequeue()
      if (this.getState() === 'stopped' || msg === null) break
      // 单条 run 抛错不阻塞下一条
      try {
        await this.withExecLock(() => this.processMessage(msg))
      }
      catch (err) {
        log.error(`[AgentRuntime:${this.agentId}] run 失败:`, err)
      }
    }
  }
}

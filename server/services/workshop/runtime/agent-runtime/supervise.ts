/**
 * AgentRuntimeSupervise —— 监督回合接续 / 任务记忆 / 执行锁 / 消费循环
 * (拆分层,承 AgentRuntimeLifecycle;方法体与原文件逐行一致)
 */
import { AgentRuntimeLifecycle } from './lifecycle'
import type { AgentRunContext, SupervisionDecision, SupervisionSnapshot } from '../../agents/agent-interface'
import { randomUUID } from 'node:crypto'
import type { WorkspaceTask } from '../../types/task'
import { log } from './helpers'
import { MESSAGE_WATCHDOG_TICK_MS, shouldFireMessageWatchdog } from './message-watchdog'
import { superviseWatchdogOnly, workshopSettings } from '../../settings'
import { TERMINAL_TASK_STATES } from '../../types/task'
import type { ExecutionScope } from '../../agents/execution-scope'

export abstract class AgentRuntimeSupervise extends AgentRuntimeLifecycle {
  /** 当前消息看门狗的活动上报句柄(processMessage 事件循环逐事件调用;回合外为 null) */
  protected messageWatchdogBump: (() => void) | null = null

  /** 事件驱动的活动上报:任何 harness 事件(delta/工具调用/状态)都视为"回合活着" */
  protected bumpMessageActivity(): void {
    this.messageWatchdogBump?.()
  }

  /** 看门狗单次巡检(async:审批面动态导入;判定语义在 ./message-watchdog.ts 纯函数) */
  private async messageWatchdogTick(
    msg: { messageId: string },
    w: { stallMs: number, getLast: () => number, bump: () => void, isFired: () => boolean, markFired: () => void, stop: () => void },
  ): Promise<void> {
    if (w.isFired()) return
    let hasPendingApprovals = false
    try {
      // 动态导入取审批面(避免 tool-approvals → platform-notice → manager 静态环);
      // 审批面未装配(单测/降级)按"无合法等待"处理。
      const { getToolApprovals } = await import('../../agents/tool-approvals')
      hasPendingApprovals = getToolApprovals().listPending(this.agentId).length > 0
    }
    catch { /* 按无等待处理 */ }
    if (w.isFired()) return
    const now = Date.now()
    if (hasPendingApprovals) {
      // 有人在裁:暂停无活动窗口。审批解除后由下一次巡检从当前时刻重新起算,
      // 避免长时间等人后刚拿到结果就被旧时间戳立即误杀。
      w.bump()
      return
    }
    if (!shouldFireMessageWatchdog({ state: this.state, lastActivityAt: w.getLast(), now, stallMs: w.stallMs, hasPendingApprovals })) return
    w.markFired()
    w.stop()
    log.warn(`[AgentRuntime:${this.agentId}] 消息 ${msg.messageId.slice(0, 8)} 超过无活动阈值(${w.stallMs}ms)未结束且无挂起审批 → abort 当前回合并重投(state=${this.state})`)
    // 带结构化 reason:omp 侧 normalizeSupervisionAbortReason 把 watchdog 视为非硬中止,
    // 不合成 cancel 决策 —— 不会连坐取消频道内其它 active 任务(2026-11-16 复现回归)。
    // 重投由旧回合 finally 完成，确保它停止处理后新回合才可认领该消息。
    this.abortCurrent('message watchdog')
  }

  async supervise(snapshot: SupervisionSnapshot): Promise<SupervisionDecision[] | null> {
    if (!this.impl.supervise || this.getState() === 'stopped') return null
    const rootId = snapshot.activeRootId ?? null
    const root = rootId ? snapshot.tasks.find(task => task.id === rootId) : undefined
    const rootGeneration = root?.assignmentGeneration
    const rootLeaseId = root?.executionLeaseId
    const rootSnapshotValid = Boolean(root && root.channelId === this.channelId && root.assigneeId === this.agentId
      && !TERMINAL_TASK_STATES[root.state] && !root.executionLeaseRevokedAt
      && root.executionLeaseAgentId === this.agentId
      && Number.isSafeInteger(rootGeneration) && (rootGeneration ?? -1) >= 0 && rootLeaseId)
    const controller = new AbortController()
    this.superviseController = controller
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
    // 监督回合本身是「在途工作」:过去只在 processMessage 里置 busy,lead 长监督
    // 期间对外恒 idle,Channel 配置重装会据此把它当空闲卸载并 abort 根任务。
    // 进入监督即置 busy,落定后恢复 idle;若期间已被 stop 则保持 stopped。
    const restoreIdleOnSettle = this.state === 'idle'
    if (restoreIdleOnSettle) {
      this.state = 'busy'
      this.refreshStatus()
    }
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
      const recall = this.deps.memory?.recall(query, { touch: false, signal: controller.signal })
      if (recall) {
        let onAbort!: () => void
        const aborted = new Promise<undefined>((resolve) => {
          onAbort = () => resolve(undefined)
          if (controller.signal.aborted) onAbort()
          else controller.signal.addEventListener('abort', onAbort, { once: true })
        })
        try {
          memoryBlock = (await Promise.race([recall, aborted])) ?? undefined
        }
        finally {
          controller.signal.removeEventListener('abort', onAbort)
        }
      }
    }
    catch (err) {
      log.error(`[AgentRuntime:${this.agentId}] supervise 记忆召回失败:`, err)
    }
    if (controller.signal.aborted || this.getState() === 'stopped') {
      if (this.superviseController === controller) this.superviseController = null
      this.supervisionAttempt = { ...this.supervisionAttempt, state: 'IDLE', completedAt: new Date().toISOString(), lastDecisionKind: 'aborted' }
      if (restoreIdleOnSettle && this.state === 'busy' && this.currentTaskId == null) this.state = 'idle'
      this.refreshStatus()
      return null
    }
    const policy = this.impl.getSupervisionPolicy?.() ?? {
      watchdogMs: Number(workshopSettings().supervise_watchdog_ms) || 90_000,
      hardTimeoutMs: Number(workshopSettings().supervise_hard_timeout_ms) || 900_000,
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
          // 传 reason:impl 据此区分「硬超时」与「外部取消」,不再把超时伪装成
          // external cancel 并合成 cancel 决策(2026-11-10 P1:项目 root 每 6 分钟被
          // 中止一次、cancel 被治理护栏拦截、40 分钟不推进)。
          controller.abort(new Error(`supervise hard timeout(${policy.hardTimeoutMs}ms)`))
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
    const validRoot = (): boolean => {
      if (!rootId || !rootSnapshotValid) return false
      if (this.deps.taskEngine.isLegacyRecoveryBlocked?.(rootId)) return false
      const current = this.deps.taskEngine.get(rootId)
      return Boolean(current && current.channelId === this.channelId && current.assigneeId === this.agentId
        && !TERMINAL_TASK_STATES[current.state] && !current.executionLeaseRevokedAt
        && current.executionLeaseAgentId === this.agentId
        && current.assignmentGeneration === rootGeneration
        && current.executionLeaseId === rootLeaseId)
    }
    const executionScope: ExecutionScope | undefined = rootId && rootGeneration != null && rootLeaseId && validRoot()
      ? {
          taskId: rootId,
          agentId: this.agentId,
          channelId: this.channelId,
          assignmentGeneration: rootGeneration,
          executionLeaseId: rootLeaseId,
          signal: controller.signal,
          assertActive: () => {
            if (controller.signal.aborted || !validRoot()) throw new Error('supervision task execution lease is stale')
          },
        }
      : undefined
    if (rootId && !executionScope) controller.abort(new Error('task abort'))
    // Session Context:克隆身份优先;supervision 的根任务可能带 task.sessionId
    // (task-instance/project 实例会话)—— native 监督回合的工具记忆归属依赖它。
    const trustedSessionId = this.deps.trustedSessionId || undefined
    if (trustedSessionId && root?.sessionId && root.sessionId !== trustedSessionId) {
      log.warn(`[AgentRuntime:${this.agentId}] supervision 根任务会话(${root.sessionId})与成员会话(${trustedSessionId})不一致,按成员会话收口`)
    }
    const sessionId = trustedSessionId ?? (root?.sessionId || undefined)
    const runtimeSession = sessionId ? { id: sessionId, block: this.getSessionContext(sessionId)?.block ?? '' } : undefined
    const ctx: AgentRunContext = {
      agentId: this.agentId,
      channelId: this.channelId,
      role: this.role,
      workspace: this.deps.workspace,
      signal: controller.signal,
      memory: memoryBlock,
      ...(executionScope ? { executionScope } : {}),
      ...(runtimeSession ? { session: runtimeSession } : {}),
    }
    let decisions: SupervisionDecision[] | null = null
    try {
      if (controller.signal.aborted) return null
      decisions = await this.impl.supervise(snapshot, ctx, { signal: controller.signal, onWatchdog: at => markWatchdog(at) })
      if (!controller.signal.aborted && executionScope && !validRoot()) controller.abort(new Error('task abort'))
      if (controller.signal.aborted) return null
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
      const aborted = controller.signal.aborted
      const settled = aborted ? 'ABORTED' : 'DECISION_APPLIED'
      if (!aborted) controller.abort(new Error('supervision settled'))
      // §2.3:落定审计 —— 完成时刻 + 最后决策类型(§8「Lead 最后决策」的数据源)
      const lastDecisionKind = aborted
        ? 'aborted'
        : decisions && decisions.length > 0
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
      // 监督落定后归还 busy;若期间已被 stop(stopped)或已有任务回合接管(currentTaskId),
      // 不覆盖它们的状态。
      if (restoreIdleOnSettle && this.state === 'busy' && this.currentTaskId == null) {
        this.state = 'idle'
      }
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
      if (msg === null) break
      const claimToken = this.deps.mailbox.claimToken(msg)
      if (!claimToken) {
        log.error(`[AgentRuntime:${this.agentId}] 消息认领缺少 token,拒绝执行: ${msg.messageId}`)
        continue
      }
      if (this.getState() === 'stopped') {
        this.deps.mailbox.releaseClaim(msg.messageId, claimToken)
        break
      }
      // 单条 run 抛错不阻塞下一条。
      // 看门狗必须在拿到 execLock **之后**才起表(2026-11-16 复现):否则前一条消息的
      // 长回合会吃掉本消息的整个排队窗口,fire 时杀的是别人的回合、重投的是还没开跑的消息。
      let turnGeneration = this.turnGeneration
      try {
        await this.withExecLock(() => {
          turnGeneration = this.turnGeneration
          if (this.getState() === 'stopped') {
            this.deps.mailbox.releaseClaim(msg.messageId, claimToken)
            return Promise.resolve()
          }
          return this.withMessageWatchdog(msg, claimToken, () => {
            if (!this.deps.mailbox.beginProcessing(msg.messageId, claimToken)) return Promise.resolve()
            return this.processMessage(msg, claimToken)
          })
        })
      }
      catch (err) {
        log.error(`[AgentRuntime:${this.agentId}] run 失败:`, err)
        if (this.turnGeneration === turnGeneration) {
          // Stop before releasing to prevent an immediate, unbounded preflight retry loop.
          void this.stop()
          this.deps.mailbox.releaseClaim(msg.messageId, claimToken)
          break
        }
        else if (this.deps.mailbox.ownsClaim(msg.messageId, claimToken)) {
          // Execution may have produced side effects: retain the claim and halt replay.
          log.error(`[AgentRuntime:${this.agentId}] 回合收尾失败,保留认领并停止消费以避免重复执行`)
          void this.stop()
          break
        }
      }
    }
  }

  /**
   * 消息级活性看门狗(P1 修复,2026-11-10;2026-11-16 重设计为「活动窗口」):
   * 被 claim 的消息若超过**无活动阈值**仍未结束回合 → abort 当前 run/监督回合 +
   * 消息重投(attempts+1,≥3→dead,与 P3-4 同语义)。
   *
   * 旧实现是固定 600s 从 claim 起算:实测把 16 分钟的健康治理回合(含 4 分钟 HITL
   * 人工等待)连续 abort+重投 3 次直到 dead,同一 message_id 被整段重放三轮,还把
   * 频道内其它 active 任务连坐取消。新语义(判定在 ./message-watchdog.ts,纯函数):
   *  - 回合内任何 harness 事件都重置活动时间(message.ts 事件循环逐事件上报);
   *  - 本 agent 有挂起 HITL 审批 → 不算停滞("有人在裁"是合法等待);
   *  - fire 时 abort 必须带 'message watchdog' reason —— omp 侧据此不合成 cancel
   *    决策(硬中止只有 external cancel),不会连坐取消别的任务。
   * race 败者不清理状态:原回合若最终完成,按其自身路径 markConsumed
   * (repo requeue/markConsumed 的 WHERE state='consuming' 守卫使双重消费收敛为 no-op)。
   */
  protected async withMessageWatchdog(msg: { messageId: string }, claimToken: string, fn: () => Promise<void>): Promise<void> {
    const stallMs = Math.max(60_000, Number(workshopSettings().harness_stall_timeout_ms) || 600_000)
    let lastActivityAt = Date.now()
    let fired = false
    let unsubscribe = () => {}
    this.messageWatchdogBump = () => {
      lastActivityAt = Date.now()
    }
    try {
      const { getToolApprovals } = await import('../../agents/tool-approvals')
      unsubscribe = getToolApprovals().subscribeApprovalChanges(this.agentId, () => {
        lastActivityAt = Date.now()
      })
    }
    catch { /* 审批面未装配时继续使用活动事件 */ }
    if (this.getState() === 'stopped') {
      unsubscribe()
      this.messageWatchdogBump = null
      this.deps.mailbox.releaseClaim(msg.messageId, claimToken)
      return
    }
    const timer = setInterval(() => {
      void this.messageWatchdogTick(msg, {
        stallMs,
        getLast: () => lastActivityAt,
        bump: () => {
          lastActivityAt = Date.now()
        },
        isFired: () => fired,
        markFired: () => {
          fired = true
        },
        stop: () => clearInterval(timer),
      })
    }, MESSAGE_WATCHDOG_TICK_MS)
    timer.unref?.()
    try {
      await fn()
    }
    finally {
      fired = true
      clearInterval(timer)
      unsubscribe()
      this.messageWatchdogBump = null
    }
  }
}

/**
 * AgentRuntimeLayer02 —— 监督回合接续 / 任务记忆 / 执行锁 / 消费循环
 * (分层 3/4,承 AgentRuntimeLayer01;方法体与原文件逐行一致)
 */
import { AgentRuntimeLayer01 } from './01-lifecycle'
import type { AgentRunContext, SupervisionDecision, SupervisionSnapshot } from '../../agents/agent-interface'
import type { WorkspaceTask } from '../../types/task'
import { log } from './helpers'

export abstract class AgentRuntimeLayer02 extends AgentRuntimeLayer01 {
  async supervise(snapshot: SupervisionSnapshot): Promise<SupervisionDecision[] | null> {
    if (!this.impl.supervise) return null
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
    const ctx: AgentRunContext = {
      agentId: this.agentId,
      channelId: this.channelId,
      role: this.role,
      workspace: this.deps.workspace,
      signal: controller.signal,
      memory: memoryBlock,
    }
    try {
      return await this.impl.supervise(snapshot, ctx, { signal: controller.signal })
    }
    finally {
      if (this.superviseController === controller) this.superviseController = null
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

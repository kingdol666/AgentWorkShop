/**
 * AgentRuntimeLayer01 —— 启动停止 / 信箱唤醒 / 进程面 / 宿主工具与 HITL 转发
 * (分层 2/4,承 AgentRuntimeLayer00;方法体与原文件逐行一致)
 */
import { AgentRuntimeLayer00 } from './00-state'
import type { AgentWorkspace } from '../../agents/agent-interface'
import type { TaskEngine } from './types'
import { log } from './helpers'

export abstract class AgentRuntimeLayer01 extends AgentRuntimeLayer00 {
  /** 启动消费循环 */
  start(): void {
    if (this.started) return
    this.started = true
    this.state = 'idle'
    this.loopPromise = this.consumeLoop()
  }

  /** 停止:中断当前 run + 等当前事件流结束 + dispose impl(杀子进程等) */
  async stop(): Promise<void> {
    log.warn(`[AgentRuntime:${this.agentId}] runtime.stop() 调用(卸载/停用)`)
    this.state = 'stopped'
    this.abortController?.abort()
    this.deps.mailbox.close()
    // 状态广播:前端经 WS agent.status 实时反映 stopped
    this.deps.bus.notifyAgent({ agentId: this.agentId, state: 'stopped', ...this.queueContext() })
    // 宽限等待消费循环退出,但**不无限等**:impl 若不响应 abort(如长 sleep 的
    // mock/外部进程卡死),HTTP stop 请求会无限悬挂(实测 30s×8 全超时)。
    // 超过宽限即放行 —— loop 自身的 finally 稍后自行收尾,dispose 照常执行。
    await Promise.race([
      this.loopPromise?.catch(() => { }),
      new Promise(r => setTimeout(r, 10_000)),
    ])
    // 清理 impl 持有的资源(omp 子进程等);容错:impl.dispose 可能不存在
    try {
      await this.impl.dispose?.()
    }
    catch (err) {
      log.error(`[AgentRuntime:${this.agentId}] dispose 失败:`, err)
    }
  }

  /** 唤醒 mailbox(供 manager 在 taskEngine 直接落库投递后唤醒消费) */
  wakeMailbox(): void {
    this.deps.mailbox.wake()
  }

  /**
   * 状态重广播:调度器收口(complete/cancel 等不经 processMessage 的终态迁移)
   * 直接改动了本 agent 的队列上下文(current/completed),重新广播 agent.status,
   * 前端实时反映 lead 判定完成后的最新状态(不刷新即可见)。
   */
  refreshStatus(): void {
    this.deps.bus.notifyAgent({ agentId: this.agentId, state: this.state, ...this.queueContext() })
  }

  /** harness 进程资源信息(运行时资源监控;进程内 harness 无外部进程 → null) */
  getProcessInfo(): { pid: number, alive: boolean, command: string } | null {
    return this.impl.getProcessInfo?.() ?? null
  }

  /**
   * 强制终止 harness 进程(不等优雅退出)。
   * 调用方(manager terminateRuntimeProcess)终止后随即 stop 本运行时。
   */
  killProcess(): void {
    this.impl.killProcess?.()
  }

  /** harness 进程存活校准(manager sweeper 周期性调用;休眠/强杀后校准 alive 失真;异常不抛出) */
  reconcileProcess(): void {
    try {
      this.impl.reconcileProcess?.()
    }
    catch (err) {
      log.error(`[AgentRuntime:${this.agentId}] 进程存活校准失败:`, err)
    }
  }

  /**
   * harness 无关工具直调面(REST agent-tools / stdio MCP 桥回程)。
   * impl 未实现(老引擎/进程内 mock)返回 null,调用方回退协作工具族。
   */
  async dispatchHostTool(toolName: string, args: Record<string, unknown>): Promise<{ text: string, isError?: boolean } | null> {
    if (!this.impl.dispatchHostTool) return null
    return await this.impl.dispatchHostTool(toolName, args)
  }

  /** HITL 应答传导:impl 未实现返回 false(上层据此 409);异常上抛由 HTTP 层收口 */
  async respondHitl(kind: string, id: string, outcome: {
    confirmed?: boolean
    cancelled?: boolean
    value?: string
    response?: string
    comment?: string
  }): Promise<boolean> {
    if (!this.impl.respondHitl) return false
    await this.impl.respondHitl(kind, id, outcome)
    return true
  }

  /** 暴露 TaskEngine(供 SchedulerLoop 收集快照与执行调度决策) */
  get taskEngine(): TaskEngine {
    return this.deps.taskEngine
  }

  /** 暴露 AgentWorkspace(供 SchedulerLoop 执行 lead 成员管理决策) */
  get workspace(): AgentWorkspace {
    return this.deps.workspace
  }

  /**
   * lead 调度决策(供 SchedulerLoop 调用):转发 impl.supervise。
   * 未实现 supervise 时返回 null(调用方回退内置规则引擎);
   * 与 run 的互斥由调用方通过 withExecLock 保证。
   */
  /** 当前 supervise 回合的控制器(abortCurrent 经此打断 LLM 调度回合) */
  protected superviseController: AbortController | null = null
}

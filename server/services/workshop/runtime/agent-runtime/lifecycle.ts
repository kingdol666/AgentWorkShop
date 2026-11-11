/**
 * AgentRuntimeLifecycle —— 启动停止 / 信箱唤醒 / 进程面 / 宿主工具与 HITL 转发
 * (拆分层,承 AgentRuntimeState;方法体与原文件逐行一致)
 */
import { AgentRuntimeState } from './state'
import type { AgentWorkspace } from '../../agents/agent-interface'
import type { TaskEngine } from './types'
import { log } from './helpers'
import { getToolApprovals } from '../../agents/tool-approvals'
import { sendHitlNote } from '../platform-notice'

export abstract class AgentRuntimeLifecycle extends AgentRuntimeState {
  /** 启动消费循环 */
  start(): void {
    if (this.started) return
    this.started = true
    this.state = 'idle'
    this.loopPromise = this.consumeLoop()
  }

  /**
   * 停止:中断当前 run + 等当前事件流/回合收尾结束 + dispose impl。
   * 这是数据库生命周期屏障：manager.shutdown() 只有在本 promise 完成后才可关闭 DB。
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.stopInternal()
    return this.stopPromise
  }

  private async stopInternal(): Promise<void> {
    log.warn(`[AgentRuntime:${this.agentId}] runtime.stop() 调用(卸载/停用)`)
    this.state = 'stopped'
    // 挂起审批先收敛再停:回合被中止后,等待中的审批单若不落定会变成悬空
    // Promise——人类稍后的批准/拒绝无人接收,附言蒸发。收敛为拒绝(绝不自动批准)
    // 并经平台通告补送说明,Agent 下次装配即可从信箱得知发生了什么。
    try {
      const settled = getToolApprovals().cancelAllForAgent(this.agentId, '回合已被中止(运行时停止),审批失效,指令未执行')
      if (settled.length > 0) {
        sendHitlNote({
          agentId: this.agentId,
          title: '运行时中止,挂起审批已收敛',
          summary: `本次停止时有 ${settled.length} 条挂起审批随回合中止被收敛为拒绝(未执行、未自动批准):\n- ${settled.join('\n- ')}\n如仍需执行请重新发起,人类的新决议会随新审批单实时回流。`,
        })
      }
    }
    catch (err) {
      log.error(`[AgentRuntime:${this.agentId}] 挂起审批收敛失败(继续停止):`, err)
    }
    this.abortController?.abort()
    this.deps.mailbox.close()
    // 状态广播:前端经 WS agent.status 实时反映 stopped
    this.deps.bus.notifyAgent({ agentId: this.agentId, state: 'stopped', ...this.queueContext() })

    await this.disposeInBackground()
  }

  /** stop() 等待的收尾屏障：消费循环、回合收尾和 harness dispose 全部完成后返回。 */
  private async disposeInBackground(): Promise<void> {
    try {
      // 消费循环退出前，当前消息的 finally 仍可能写 messages/聊天回执。
      await this.loopPromise?.catch((err) => {
        log.error(`[AgentRuntime:${this.agentId}] 消费循环收尾失败:`, err)
      })
      await this.postSettlePromise?.catch((err) => {
        log.error(`[AgentRuntime:${this.agentId}] 回合收尾失败:`, err)
      })
      await this.impl.dispose?.()
    }
    catch (err) {
      log.error(`[AgentRuntime:${this.agentId}] dispose 失败:`, err)
    }
    finally {
      try {
        this.deps.bus.notifyAgent({ agentId: this.agentId, state: 'stopped', ...this.queueContext() })
      }
      catch { /* 广播失败不影响收尾 */ }
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

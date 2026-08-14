/**
 * WorkshopMonitor — Channel 运行过程监控器(设计文档 §6.4 观察面,服务端可编程版)。
 *
 * 事件源(全部满足项目自定义协议数据结构):
 *  - agent.event   AgentEvent 流(五变体:status/message/artifact/error/done)——
 *                  所有 harness(真实或 mock)的统一流式出口;后续接入 omp/claude
 *                  等真实 harness 时同样经 ChannelBus.emit 流出,monitor 零改动
 *  - task.status   任务状态迁移(SUBMITTED/ASSIGNED/WORKING/WAITING/COMPLETED/FAILED/CANCELED)
 *  - task.progress 任务进度变化(0-100)
 *  - agent.status  成员 idle/busy/stopped 变化(轻量轮询 diff)
 *  - lifecycle     monitor 自身生命周期(启动/停止)
 *
 * 用法:
 *   const mon = monitorChannel(manager, channelId)
 *   mon.subscribe(e => console.log(e.kind))
 *   await mon.waitFor(e => e.kind === 'task.status' && e.state === 'COMPLETED', 10_000)
 *   console.log(mon.summary())   // 人类可读时间线
 *   mon.stop()
 */
import type { AgentChannelManager } from './manager'
import type { AgentEvent } from '../agents/agent-interface'
import type { A2AMessage } from '../types/a2a'
import type { TaskState } from '../types/task'

/** 监控事件:统一自定义协议流(monitor 观察到的全部运行事实) */
export type MonitorEvent
  = | { kind: 'agent.event', seq: number, at: string, channelId: string, agentId: string | null, event: AgentEvent }
    | { kind: 'task.status', seq: number, at: string, channelId: string, taskId: string, agentId?: string, state: TaskState }
    | { kind: 'task.progress', seq: number, at: string, channelId: string, taskId: string, agentId?: string, progress: number }
    | { kind: 'agent.status', seq: number, at: string, channelId: string, agentId: string, state: 'idle' | 'busy' | 'stopped' }
    | { kind: 'lifecycle', seq: number, at: string, channelId: string, message: string }

export interface MonitorOptions {
  /** 预留扩展位(全部事件源均为事件驱动,无轮询) */
  pollMs?: number
}

export interface WorkshopMonitor {
  readonly channelId: string
  /** 已捕获的事件(append-only) */
  readonly events: MonitorEvent[]
  /** 实时订阅;返回退订函数 */
  subscribe(fn: (e: MonitorEvent) => void): () => void
  /** 等待首个满足条件的事件(轮询 events;超时返回 null) */
  waitFor(pred: (e: MonitorEvent) => boolean, timeoutMs: number): Promise<MonitorEvent | null>
  /** 等待条件在任意事件上成立(如任务终态) */
  waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean>
  /** 人类可读时间线(每事件一行) */
  summary(): string
  /** 停止监控(退订全部源) */
  stop(): void
}

/** 从事件源消息推断产出 agent(产出者优先,其次目标,再次发送者) */
function agentIdOf(source: A2AMessage): string | null {
  const producing = source.metadata?.['x-aw-producing-agent']
  const to = source.metadata?.['x-aw-target-agent']
  const from = source.metadata?.['x-aw-from-agent']
  if (typeof producing === 'string') return producing
  if (typeof to === 'string') return to
  if (typeof from === 'string') return from
  return null
}

function brief(event: AgentEvent): string {
  switch (event.kind) {
    case 'status': return `status(${event.status.state})`
    case 'message': return `message(${event.message.parts.length} parts)`
    case 'artifact': return `artifact(${event.artifact.name ?? event.artifact.artifactId.slice(0, 8)}${event.append ? ' +' : ''}${event.lastChunk ? ' last' : ''})`
    case 'error': return `error(${event.error.code})`
    case 'done': return 'done'
  }
}
/** 分布式 Omit:对判别联合逐成员省略键(保持判别能力) */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

export function monitorChannel(manager: AgentChannelManager, channelId: string, options: MonitorOptions = {}): WorkshopMonitor {
  void options // 预留扩展位(事件驱动,无轮询参数)
  const events: MonitorEvent[] = []
  const listeners = new Set<(e: MonitorEvent) => void>()
  let seq = 0
  const startedAt = Date.now()

  /** 分布式 Omit(泛型参数触发逐成员分布;push 入参无 seq/at,push 内补齐) */
  type MonitorEventInput = DistributiveOmit<MonitorEvent, 'seq' | 'at'>
  const push = (e: MonitorEventInput): void => {
    const full = { ...e, seq: (seq += 1), at: new Date().toISOString() } as MonitorEvent
    events.push(full)
    for (const fn of listeners) {
      try {
        fn(full)
      }
      catch (err) {
        console.error('[monitor] listener error:', err)
      }
    }
  }

  // 源 1:AgentEvent 流(harness 统一出口)
  const unsubEvents = manager.subscribeChannelEvents(channelId, (event, source) => {
    push({ kind: 'agent.event', channelId, agentId: agentIdOf(source), event })
  })

  // 源 2:任务事件(状态迁移/进度;TaskEngine hooks 与 reportTask 处广播)
  manager.subscribeTaskEvents(channelId, (e) => {
    if (e.state !== undefined) {
      push({ kind: 'task.status', channelId, taskId: e.taskId, agentId: e.agentId, state: e.state })
    }
    if (e.progress !== undefined) {
      push({ kind: 'task.progress', channelId, taskId: e.taskId, agentId: e.agentId, progress: e.progress })
    }
  })
  // 源 3:成员状态(idle/busy/stopped;AgentRuntime 转换处主动通知,事件驱动无轮询)
  manager.subscribeAgentStatus(channelId, (e) => {
    push({ kind: 'agent.status', channelId, agentId: e.agentId, state: e.state })
  })

  push({ kind: 'lifecycle', channelId, message: `monitor started(channel=${channelId.slice(0, 8)}…)` })

  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

  return {
    channelId,
    events,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    async waitFor(pred, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const hit = events.find(pred)
        if (hit) return hit
        await sleep(20)
      }
      return events.find(pred) ?? null
    },
    async waitUntil(pred, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (pred()) return true
        await sleep(20)
      }
      return pred()
    },
    summary() {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      const lines = [`monitor summary: channel=${channelId.slice(0, 8)}… events=${events.length} elapsed=${elapsed}s`]
      for (const e of events) {
        const t = e.at.slice(11, 23)
        switch (e.kind) {
          case 'agent.event':
            lines.push(`  [${t}] #${e.seq} agent.event  ${e.agentId?.slice(0, 8) ?? '-'} ${brief(e.event)}`)
            break
          case 'task.status':
            lines.push(`  [${t}] #${e.seq} task.status ${e.taskId.slice(0, 8)} → ${e.state}${e.agentId ? ` (by ${e.agentId.slice(0, 8)})` : ''}`)
            break
          case 'task.progress':
            lines.push(`  [${t}] #${e.seq} task.progress ${e.taskId.slice(0, 8)} = ${e.progress}%`)
            break
          case 'agent.status':
            lines.push(`  [${t}] #${e.seq} agent.status ${e.agentId.slice(0, 8)} → ${e.state}`)
            break
          case 'lifecycle':
            lines.push(`  [${t}] #${e.seq} lifecycle ${e.message}`)
            break
        }
      }
      return lines.join('\n')
    },
    stop() {
      unsubEvents()
      push({ kind: 'lifecycle', channelId, message: 'monitor stopped' })
    },
  }
}

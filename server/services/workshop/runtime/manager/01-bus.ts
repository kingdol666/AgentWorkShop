/**
 * ManagerBus —— ChannelBus 装配与订阅面(事件/任务/成员/群聊/记忆)
 * (分层 2/19,承 ManagerState)
 */
import { ManagerState } from './00-state'
import type { A2AMessage } from '../../types/a2a'
import type { AgentEvent } from '../../agents/agent-interface'
import type { ChannelBus, MemberChangeEvent, TaskEventTask } from '../agent-runtime'
import type { TaskState } from '../../types/task'
import type { ChannelRuntime } from '../channel-runtime'
import { log } from './helpers'

export abstract class ManagerBus extends ManagerState {
  protected buildBus(cr: ChannelRuntime): ChannelBus {
    const eventListeners = new Set<(event: AgentEvent, source: A2AMessage) => void>()
    const taskListeners = new Set<(e: { taskId: string, state?: TaskState, progress?: number }) => void>()
    const agentListeners = new Set<(e: { agentId: string, state: 'idle' | 'busy' | 'stopped' }) => void>()
    const messageListeners = new Set<(message: A2AMessage) => void>()
    const memoryListeners = new Set<(e: { agentId: string, scope: 'private' | 'shared', title: string, dedupKey: string }) => void>()
    const memberListeners = new Set<(e: MemberChangeEvent) => void>()
    /** v17 群聊事件订阅者(ws hub 建流时挂接;chat.message / chat.delivery.status / chat.member / chat.settings) */
    const chatListeners = new Set<(e: { type: string, payload: unknown }) => void>()
    return {
      emit: (event, source) => {
        for (const fn of eventListeners) {
          try {
            fn(event, source)
          }
          catch (err) {
            log.error('[ChannelBus] event listener error:', err)
          }
        }
        cr.wakeScheduler()
      },
      onEvent: (fn) => {
        eventListeners.add(fn)
        return () => eventListeners.delete(fn)
      },
      notifyTask: (e: { taskId: string, state?: TaskState, progress?: number, agentId?: string, task?: TaskEventTask }) => {
        for (const fn of taskListeners) {
          try {
            fn(e)
          }
          catch (err) {
            log.error('[ChannelBus] task listener error:', err)
          }
        }
      },
      onTaskEvent: (fn) => {
        taskListeners.add(fn)
        return () => taskListeners.delete(fn)
      },
      notifyAgent: (e) => {
        for (const fn of agentListeners) {
          try {
            fn(e)
          }
          catch (err) {
            log.error('[ChannelBus] agent listener error:', err)
          }
        }
      },
      onAgentStatus: (fn) => {
        agentListeners.add(fn)
        return () => agentListeners.delete(fn)
      },
      notifyMessage: (message) => {
        for (const fn of messageListeners) {
          try {
            fn(message)
          }
          catch (err) {
            log.error('[ChannelBus] message listener error:', err)
          }
        }
      },
      onMessage: (fn) => {
        messageListeners.add(fn)
        return () => messageListeners.delete(fn)
      },
      notifyMemory: (e) => {
        for (const fn of memoryListeners) {
          try {
            fn(e)
          }
          catch (err) {
            log.error('[ChannelBus] memory listener error:', err)
          }
        }
      },
      onMemoryEvent: (fn) => {
        memoryListeners.add(fn)
        return () => memoryListeners.delete(fn)
      },
      notifyMember: (e) => {
        for (const fn of memberListeners) {
          try {
            fn(e)
          }
          catch (err) {
            log.error('[ChannelBus] member listener error:', err)
          }
        }
      },
      onMemberEvent: (fn) => {
        memberListeners.add(fn)
        return () => memberListeners.delete(fn)
      },
      notifyChat: (e) => {
        for (const fn of chatListeners) {
          try {
            fn(e)
          }
          catch (err) {
            log.error('[ChannelBus] chat listener error:', err)
          }
        }
      },
      onChatEvent: (fn) => {
        chatListeners.add(fn)
        return () => chatListeners.delete(fn)
      },
      wakeScheduler: () => {
        cr.wakeScheduler()
      },
    }
  }

  subscribeAgentStatus(channelId: string, fn: (e: Parameters<ChannelBus['notifyAgent']>[0]) => void): () => void {
    // 先确保 bus 存在:channel 尚未激活时订阅会被静默丢弃(monitor 先订阅后提交任务的场景)
    // 返回 bus 的真实退订函数:stream 重绑时必须可退订,否则同一 bus 上订阅两份 → 事件双发
    this.ensureChannelRuntime(channelId)
    return this.buses.get(channelId)?.onAgentStatus(fn) ?? (() => {})
  }

  subscribeChannelEvents(channelId: string, fn: (event: AgentEvent, source: A2AMessage) => void): () => void {
    this.ensureChannelRuntime(channelId)
    return this.buses.get(channelId)?.onEvent(fn) ?? (() => {})
  }

  subscribeTaskEvents(channelId: string, fn: (e: { taskId: string, state?: TaskState, progress?: number, agentId?: string, task?: TaskEventTask }) => void): () => void {
    // 真实退订(同上:防 stream 重绑泄漏导致 task.status 双发落库)
    this.ensureChannelRuntime(channelId)
    return this.buses.get(channelId)?.onTaskEvent(fn) ?? (() => {})
  }

  /** 订阅 channel 内消息投递(AEP a2a.message 事件源;route 汇流点触发) */
  subscribeChannelMessages(channelId: string, fn: (message: A2AMessage) => void): () => void {
    this.ensureChannelRuntime(channelId)
    return this.buses.get(channelId)?.onMessage(fn) ?? (() => {})
  }

  /** 订阅 channel 内记忆写入(AEP memory.saved 事件源) */
  subscribeMemoryEvents(channelId: string, fn: (e: { agentId: string, scope: 'private' | 'shared', title: string, dedupKey: string }) => void): () => void {
    this.ensureChannelRuntime(channelId)
    return this.buses.get(channelId)?.onMemoryEvent(fn) ?? (() => {})
  }

  /** 订阅 channel 内团队成员增/改/删(AEP agent.member 事件源;lead 工具桥与 REST 入口共用汇流点) */
  subscribeMemberEvents(channelId: string, fn: (e: MemberChangeEvent) => void): () => void {
    this.ensureChannelRuntime(channelId)
    return this.buses.get(channelId)?.onMemberEvent(fn) ?? (() => {})
  }

  /** v17 订阅 channel 内群聊事件(chat.message / chat.delivery.status / chat.member / chat.settings) */
  subscribeChatEvents(channelId: string, fn: (e: { type: string, payload: unknown }) => void): () => void {
    this.ensureChannelRuntime(channelId)
    return this.buses.get(channelId)?.onChatEvent?.(fn) ?? (() => {})
  }

  protected notifyTask(
    channelId: string,
    e: { taskId: string, state?: TaskState, progress?: number, agentId?: string, task?: TaskEventTask },
  ): void {
    this.buses.get(channelId)?.notifyTask(e)
  }

  /** 团队成员变更广播(AEP agent.member 事件源;lead 工具桥与 REST 入口共用) */
  protected notifyMember(channelId: string, e: MemberChangeEvent): void {
    this.buses.get(channelId)?.notifyMember(e)
  }
}

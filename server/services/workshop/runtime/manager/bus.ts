/**
 * ManagerBus —— ChannelBus 装配与订阅面(事件/任务/成员/群聊/记忆)
 * (拆分层,承 ManagerState)
 */
import { ManagerState } from './state'
import type { A2AMessage } from '../../types/a2a'
import type { AgentEvent } from '../../agents/agent-interface'
import type { ChannelBus, MemberChangeEvent, TaskEventTask } from '../agent-runtime'
import type { TaskState } from '../../types/task'
import { log } from './helpers'

export abstract class ManagerBus extends ManagerState {
  /**
   * 频道级总线只按 channelId 构造:生命期 = 频道(见 ensureChannelBus),
   * 不持有 ChannelRuntime 引用 —— 运行时可能因空闲被卸载/重建,wakeScheduler
   * 必须每次现查 channels 映射(无运行时 → no-op,不影响事件录制与广播)。
   */
  protected buildBus(channelId: string): ChannelBus {
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
        this.channels.get(channelId)?.wakeScheduler()
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
        this.channels.get(channelId)?.wakeScheduler()
      },
    }
  }

  /**
   * 频道级总线(生命期 = 频道,不随 ChannelRuntime 空闲卸载)。
   *
   * 事件录制与 UI 订阅面必须在"无成员/无订阅者"时也存在:录制流若订阅在
   * 运行时总线上,空闲卸载会连总线一起销毁 → 之后的事件全部丢失。这里把总线
   * 与运行时解耦,只在频道删除(removeChannel)与 manager 停机(shutdown)时释放;
   * 团队记忆沉淀的 task 事件订阅随总线**只挂一次**。
   */
  protected ensureChannelBus(channelId: string): ChannelBus {
    const existing = this.buses.get(channelId)
    if (existing) return existing
    const bus = this.buildBus(channelId)
    this.buses.set(channelId, bus)
    // 团队记忆沉淀(任务终态事件单点收口):team-task 共享行 + 编年史滚动重写。
    // 事件总线保证每次状态迁移恰好一次通知——worker/lead 各自私有域 harvest 之外
    // 的团队域写入不存在双写;失败仅记日志,绝不影响任务流。
    bus.onTaskEvent(e => this.recordTeamTaskEvent(channelId, e))
    return bus
  }

  subscribeAgentStatus(channelId: string, fn: (e: Parameters<ChannelBus['notifyAgent']>[0]) => void): () => void {
    // 只确保 bus 存在(不激活运行时):录制流订阅不得因无人作业而装配 ChannelRuntime
    // 返回 bus 的真实退订函数:stream 重绑时必须可退订,否则同一 bus 上订阅两份 → 事件双发
    this.ensureChannelBus(channelId)
    return this.buses.get(channelId)?.onAgentStatus(fn) ?? (() => {})
  }

  subscribeChannelEvents(channelId: string, fn: (event: AgentEvent, source: A2AMessage) => void): () => void {
    this.ensureChannelBus(channelId)
    return this.buses.get(channelId)?.onEvent(fn) ?? (() => {})
  }

  subscribeTaskEvents(channelId: string, fn: (e: { taskId: string, state?: TaskState, progress?: number, agentId?: string, task?: TaskEventTask }) => void): () => void {
    // 真实退订(同上:防 stream 重绑泄漏导致 task.status 双发落库)
    this.ensureChannelBus(channelId)
    return this.buses.get(channelId)?.onTaskEvent(fn) ?? (() => {})
  }

  /** 订阅 channel 内消息投递(AEP a2a.message 事件源;route 汇流点触发) */
  subscribeChannelMessages(channelId: string, fn: (message: A2AMessage) => void): () => void {
    this.ensureChannelBus(channelId)
    return this.buses.get(channelId)?.onMessage(fn) ?? (() => {})
  }

  /** 订阅 channel 内记忆写入(AEP memory.saved 事件源) */
  subscribeMemoryEvents(channelId: string, fn: (e: { agentId: string, scope: 'private' | 'shared', title: string, dedupKey: string }) => void): () => void {
    this.ensureChannelBus(channelId)
    return this.buses.get(channelId)?.onMemoryEvent(fn) ?? (() => {})
  }

  /** 订阅 channel 内团队成员增/改/删(AEP agent.member 事件源;lead 工具桥与 REST 入口共用汇流点) */
  subscribeMemberEvents(channelId: string, fn: (e: MemberChangeEvent) => void): () => void {
    this.ensureChannelBus(channelId)
    return this.buses.get(channelId)?.onMemberEvent(fn) ?? (() => {})
  }

  /** v17 订阅 channel 内群聊事件(chat.message / chat.delivery.status / chat.member / chat.settings) */
  subscribeChatEvents(channelId: string, fn: (e: { type: string, payload: unknown }) => void): () => void {
    this.ensureChannelBus(channelId)
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

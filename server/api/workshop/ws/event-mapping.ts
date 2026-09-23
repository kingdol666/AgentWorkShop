/**
 * AgentEvent → AEP 帧映射
 * (由 server/api/workshop/ws.ts 按职责拆出;内容逐行原文搬运)
 */
import type { A2AMessage } from '../../../services/workshop/types/a2a'
import type { AgentChannelManager } from '../../../services/workshop/runtime/manager'
import type { AgentEvent } from '../../../services/workshop/agents/agent-interface'
import type { ChannelStream } from './shared'
import { publish } from './publish'

export function mapAgentEvent(manager: AgentChannelManager, stream: ChannelStream, event: AgentEvent, source: A2AMessage): void {
  const agentId = (source.metadata?.['x-aw-producing-agent'] as string | undefined)
    ?? (source.metadata?.['x-aw-from-agent'] as string | undefined)
    ?? undefined
  const taskId = source.taskId ?? (source.metadata?.['x-aw-task-id'] as string | undefined) ?? undefined
  switch (event.kind) {
    case 'message':
      publish(manager, stream, 'agent.message', event.message, { agentId, taskId: event.message.taskId ?? taskId })
      break
    case 'delta':
      // 空增量不下发(reasoning 流的空白差额帧):客户端会聚出空白流块
      if (event.delta.text) publish(manager, stream, 'agent.delta', { delta: event.delta.text }, { agentId, taskId })
      break
    case 'status':
      if (event.status.message) {
        // 纯空白文本(换行/空格拼接)同样不下发:聚合出"思考/中间输出 (空)"空白块
        const text = event.status.message.parts.map(p => ('text' in p ? p.text : '')).join(' ')
        if (text.trim()) publish(manager, stream, 'agent.status.message', { text }, { agentId, taskId })
      }
      break
    case 'artifact':
      publish(manager, stream, 'a2a.artifact', { taskId, artifact: event.artifact }, { agentId, taskId })
      break
    case 'error':
      publish(manager, stream, 'error', { code: event.error.code, message: event.error.message }, { agentId, taskId })
      break
    case 'done':
      // 终态由 notifyAgent/notifyTask 驱动,done 不单独成帧
      break
  }
}

/**
 * stream 的 ChannelBus 订阅装配(六类事件 → AEP 帧)。
 * 订阅解析的是"订阅时刻"的总线对象;channel 空闲卸载后总线被管理器销毁,
 * 重激活时新建总线——同一 stream 必须重订到当前总线,否则事件不再产生 WS 帧。
 */

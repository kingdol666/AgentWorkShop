/**
 * AgentEvent → AEP 帧映射
 * (由 server/api/workshop/ws.ts 按职责拆出;内容逐行原文搬运)
 */
import type { A2AMessage } from '../../../services/workshop/types/a2a'
import type { AgentChannelManager } from '../../../services/workshop/runtime/manager'
import type { AgentEvent } from '../../../services/workshop/agents/agent-interface'
import type { ChannelStream } from './shared'
import { publish } from './publish'
import { selectStatusFrame } from '@/shared/agent-blocks'

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
        // AgentBlock v1(2026-11-08 生产审计·指控6):结构化工具块与文本帧并行下发。
        // 帧计划 = 纯函数 selectStatusFrame(原生块优先;无原生块按 🔧 文本签名归一兜底;
        // harness 由 agentId 反查实例行归因,未知留空串)。帧序:blocks → status.message → derived。
        const harness = harnessOfAgent(manager, agentId)
        const { blocks, derived, text } = selectStatusFrame(event.status.message.parts, harness)
        for (const block of blocks) {
          publish(manager, stream, 'agent.block', { block }, { agentId, taskId })
        }
        // 纯空白文本(换行/空格拼接)同样不下发:聚合出"思考/中间输出 (空)"空白块
        if (text.trim()) {
          publish(manager, stream, 'agent.status.message', { text }, { agentId, taskId })
          if (derived) publish(manager, stream, 'agent.block', { block: derived }, { agentId, taskId })
        }
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
 * Agent 实例 id → harness id(派生块归因;与 manager.channelIdOfAgent 同源查询面)。
 * duck-typing 访问:测试替身/旧 manager 无此方法时回空串(块照发,归因留空)。
 */
function harnessOfAgent(manager: AgentChannelManager, agentId: string | undefined): string {
  if (!agentId) return ''
  const fn = (manager as unknown as { harnessOfAgent?: (id: string) => string | null }).harnessOfAgent
  return (typeof fn === 'function' ? fn.call(manager, agentId) : '') ?? ''
}

/**
 * stream 的 ChannelBus 订阅装配(六类事件 → AEP 帧)。
 * 订阅解析的是"订阅时刻"的总线对象;channel 空闲卸载后总线被管理器销毁,
 * 重激活时新建总线——同一 stream 必须重订到当前总线,否则事件不再产生 WS 帧。
 */

/**
 * OmpRpcAgentImplLayer04 —— omp 事件 → AgentEvent 映射与上下文治理事件
 * (分层 5/6,承 OmpRpcAgentImplLayer03;方法体与原文件逐行一致)
 */
import { OmpRpcAgentImplLayer03 } from './03-tools-steer'
import type { A2AMessage } from '../../types/a2a'
import type { AgentEvent } from '../agent-interface'
import type { AgentSessionEvent, CompactionResult } from '../adapters/omp-rpc-client'
import { log } from './helpers'
import { randomUUID } from 'node:crypto'
import { toolArgsPreview } from '../prompt-builder'

export abstract class OmpRpcAgentImplLayer04 extends OmpRpcAgentImplLayer03 {
  protected mapOmpEvent(event: AgentSessionEvent, taskId: string | undefined): AgentEvent[] {
    switch (event.type) {
      case 'agent_start':
        return [{
          kind: 'status',
          status: { state: 'WORKING', timestamp: new Date().toISOString() },
        }]
      case 'message_end': {
        // 消息完成:如果有 message 内容,产出为 status 事件(任务历史追踪)
        const msg = event.message
        if (msg && Array.isArray(msg.content)) {
          const text = (msg.content as Array<{ type?: string, text?: string }>)
            .filter(c => c.type === 'text')
            .map(c => c.text ?? '')
            .join('')
          if (text) {
            const a2aMsg: A2AMessage = {
              messageId: randomUUID(),
              contextId: this.channelId,
              role: 'ROLE_AGENT',
              parts: [{ text }],
            }
            return [{
              kind: 'status',
              status: { state: 'WORKING', message: a2aMsg, timestamp: new Date().toISOString() },
            }]
          }
        }
        return []
      }

      case 'tool_execution_start': {
        const toolName = event.toolName ?? 'tool'
        return [{
          kind: 'status',
          status: {
            state: 'WORKING',
            message: {
              messageId: randomUUID(),
              contextId: this.channelId,
              role: 'ROLE_AGENT',
              parts: [{ text: `🔧 ${toolName}${toolArgsPreview(event.args)}` }],
            },
            timestamp: new Date().toISOString(),
          },
        }]
      }

      case 'agent_end': {
        if (event.isTerminal === false) return []
        const events: AgentEvent[] = []
        // 提取最终 assistant 文本作为 artifact
        const messages = event.messages ?? []
        const assistantText = messages
          .filter(m => m.role === 'assistant')
          .flatMap(m => m.content.filter(c => c.type === 'text').map(c => c.text ?? ''))
          .join('')
        // 回合内的 provider/API 失败(限额 429、鉴权、上游 5xx 等):omp 把错误挂在最后一条
        // assistant 消息上(stopReason='error' + errorStatus/errorMessage)而非 __error__ 帧。
        // 不映射出来,上层只能看到「回合结束无产出」,真实原因彻底丢失(且照常重试到耗尽)。
        const failure = [...messages].reverse().find((m) => {
          const mm = m as { role?: string, stopReason?: string, errorMessage?: string }
          return mm.role === 'assistant' && (mm.stopReason === 'error' || typeof mm.errorMessage === 'string')
        }) as { errorStatus?: number, errorMessage?: string } | undefined
        if (failure) {
          const code = failure.errorStatus != null ? `OMP_LLM_${failure.errorStatus}` : 'OMP_LLM_ERROR'
          const detail = failure.errorMessage ?? 'harness 回合以错误结束(无错误详情)'
          log.error(`[OmpRpcAgent:${this.selfAgentId}] harness 回合失败 ${code}: ${detail}`)
          // error 事件即回合终点(队列侧据此收口),不再追加 done
          return [{ kind: 'error', error: { code, message: detail } }]
        }
        if (assistantText) {
          events.push({
            kind: 'artifact',
            artifact: {
              artifactId: randomUUID(),
              name: 'output',
              parts: [{ text: assistantText }],
            },
            lastChunk: true,
            totalChunks: 1,
          })
        }
        events.push({ kind: 'done', final: taskId ? { taskId } : undefined })
        return events
      }

      case '__process_exit__':
        return [{
          kind: 'error',
          error: { code: 'OMP_PROCESS_EXIT', message: 'omp 子进程意外退出' },
        }]

      // ===== 上下文治理事件(回合中到达的原生阈值/overflow 压缩;不污染事件流)=====
      case 'compaction_start':
        this.compacting = true
        return []

      case 'compaction_end': {
        this.compacting = false
        const result = (event as { result?: CompactionResult }).result
        if (result?.summary) {
          void this.harvestCompaction(
            result.summary,
            result.tokensBefore,
            result.tokensAfter ?? result.estimatedTokensAfter,
            (event as { reason?: string }).reason,
          )
        }
        return []
      }

      // 回合完全落定(无自动重试/压缩重试/排队续跑):后续压缩检查由 AgentRuntime 驱动
      case 'agent_settled':
        return []

      case '__error__':
        return [{
          kind: 'error',
          error: { code: 'OMP_ERROR', message: (event as { error?: string }).error ?? 'omp 未知错误' },
        }]

      default:
        return []
    }
  }

  // ===== 内部:omp 客户端管理 =====
}

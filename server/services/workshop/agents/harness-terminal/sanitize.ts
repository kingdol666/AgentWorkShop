/**
 * 帧净化:内容抽取 / 截断 / 预览 / 敏感字段清洗
 * (由 server/services/workshop/agents/harness-terminal.ts 按职责拆出;内容逐行原文搬运)
 */
import { TERM_FRAME_TEXT_PREVIEW_MAX } from '../../../../../shared/terminal-protocol'

// ===== 帧净化 =====

/** 提取 message.content 数组中的纯文本(AgentMessage.content 子集) */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      if (c && typeof c === 'object' && 'type' in c) {
        const part = c as { type?: string, text?: string, thinking?: string }
        if (part.type === 'text' && typeof part.text === 'string') return part.text
        if (part.type === 'thinking' && typeof part.thinking === 'string') return part.thinking
      }
      return ''
    })
    .join('')
}

export function clip(text: string, max = TERM_FRAME_TEXT_PREVIEW_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text
}

/** 任意值 → 诊断预览字符串(工具参数/结果用) */
export function preview(value: unknown, max = TERM_FRAME_TEXT_PREVIEW_MAX): string {
  if (typeof value === 'string') return clip(value, max)
  try {
    return clip(JSON.stringify(value) ?? String(value), max)
  }
  catch {
    return clip(String(value), max)
  }
}

/**
 * 净化单帧:剥离/截断重字段(agent_end.messages 整体丢弃、工具参数只留预览、
 * available_commands 全丢),保留渲染所需结构。未知帧超预算整体截断。
 */
export function sanitizeFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const type = frame.type as string
  switch (type) {
    case 'ready':
      return { type, protocolVersion: frame.protocolVersion }
    case 'available_commands_update':
      return { type }
    case 'response':
      return { type, command: frame.command, success: frame.success, error: frame.error }
    case 'agent_start':
      return { type }
    case 'agent_end':
      return {
        type,
        isTerminal: frame.isTerminal,
        messageCount: Array.isArray(frame.messages) ? frame.messages.length : 0,
      }
    case 'message_start':
    case 'message_end': {
      const msg = frame.message as { role?: string, content?: unknown } | undefined
      const text = contentText(msg?.content)
      return {
        type,
        role: msg?.role,
        // follow_up 路径 omp 会回显 user 消息;与 __human_input 同文时前端去重
        text: clip(text),
      }
    }
    case 'message_update':
      // delta 帧本身很小;丢弃累计 message(每帧全量 assistant 消息)
      return { type, assistantMessageEvent: frame.assistantMessageEvent }
    case 'tool_execution_start':
      return { type, toolCallId: frame.toolCallId, toolName: frame.toolName, args: preview(frame.args), intent: frame.intent }
    case 'tool_execution_update':
      return { type, toolCallId: frame.toolCallId, toolName: frame.toolName, update: preview(frame.partialResult) }
    case 'tool_execution_end':
      return { type, toolCallId: frame.toolCallId, toolName: frame.toolName, isError: frame.isError, result: preview(frame.result) }
    case 'host_tool_call':
      return { type, id: frame.id, toolName: frame.toolName, args: preview(frame.arguments) }
    case 'extension_ui_request':
      // 对话框本体(小帧;select 的 options 列表保留)
      return { ...frame }
    case 'command_output':
      return { type, text: clip(String(frame.text ?? '')) }
    default: {
      try {
        const json = JSON.stringify(frame) ?? ''
        if (json.length <= TERM_FRAME_TEXT_PREVIEW_MAX) return frame
      }
      catch {
        /* fallthrough */
      }
      return { type, __truncated: true }
    }
  }
}

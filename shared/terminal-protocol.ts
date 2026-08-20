/**
 * Harness 终端协议(权威定义,前后端共用)。
 *
 * 通道:WS /api/system/monitor/terminal/ws?pid=<pid>&token=<userToken>[&lastSeq=<n>]
 * 语义:服务端 terminal-hub 镜像 omp `--mode rpc(-ui)` 子进程的全部 JSONL 帧
 * (会话事件 / host_tool_call / extension_ui_request),前端按帧渲染 TUI 终端,
 * 并通过 input / abort / ui_response 实现Human-in-the-loop 控制。
 */

// ===== 下行(服务端 → 前端) =====

/** 终端会话元信息(omp 进程归属) */
export interface TermSessionMeta {
  pid: number
  harness: string
  agentId: string | null
  channelId: string | null
  name: string | null
  role: 'lead' | 'worker' | null
  startedAt: number
}

/** 一帧已净化的 RPC 帧(重字段截断/剥离后入环形缓冲) */
export interface TermFrame {
  seq: number
  at: string
  frame: Record<string, unknown>
}

export type TerminalServerMessage
  = | { type: 'term.init', meta: TermSessionMeta, alive: boolean, streaming: boolean, running: boolean, lastSeq: number, hitl: TerminalHitlDialog | null }
    | { type: 'term.frames', frames: TermFrame[] }
    | { type: 'term.state', alive: boolean, streaming: boolean, running: boolean }
    | { type: 'term.notice', message: string, level?: 'info' | 'warning' | 'error' }
    | { type: 'term.error', code: string, message: string }
    | { type: 'pong' }

/** 待应答的 HITL 对话框(extension_ui_request 净化视图) */
export interface TerminalHitlDialog {
  id: string
  method: 'select' | 'confirm' | 'input' | 'editor'
  title: string
  /** select: 选项列表 */
  options?: string[]
  message?: string
  placeholder?: string
  prefill?: string
  at: string
}

// ===== 上行(前端 → 服务端) =====

export type TerminalClientMessage
  = | { type: 'ping' }
    /** 文本输入:流式中 → steer 注入当前回合;空闲 → follow_up 开新回合 */
    | { type: 'input', text: string }
    /** 中止当前回合(等价 omp abort) */
    | { type: 'abort' }
    /** HITL 对话框应答(extension_ui_response) */
    | { type: 'ui_response', id: string, value?: string, confirmed?: boolean, cancelled?: boolean }

// ===== 服务端帧净化规则(镜像侧执行,前端无需感知) =====

/**
 * 重字段预算:单帧 JSON.stringify 超限则截断 payload 字符串字段。
 * agent_end.messages 整体剥离(只留 messageCount);message_start/end 的
 * content 文本保留前 TEXT_PREVIEW_MAX 字符;工具 args/result 序列化后截断。
 */
export const TERM_FRAME_TEXT_PREVIEW_MAX = 4000
export const TERM_RING_CAPACITY = 4000

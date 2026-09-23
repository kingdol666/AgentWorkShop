/**
 * OmpRpcClient 的依赖类型与对外 DTO(原 server/services/workshop/agents/adapters/omp-rpc-client.ts 顶部模块级类型声明)。纯类型。
 */

export type RpcCommand
  = | { id?: string, type: 'prompt', message: string, streamingBehavior?: 'steer' | 'followUp' }
    | { id?: string, type: 'steer', message: string }
    | { id?: string, type: 'follow_up', message: string }
    | { id?: string, type: 'abort' }
    | { id?: string, type: 'set_host_tools', tools: RpcHostToolDefinition[] }
    | { id?: string, type: 'set_todos', phases: unknown[] }
    | { id?: string, type: 'negotiate_protocol', protocolVersion: number }
    | { id?: string, type: 'set_model', provider: string, modelId: string }
    | { id?: string, type: 'get_state' }
    | { id?: string, type: 'new_session' }
    // ===== 上下文治理(70% 压缩环;协议权威 omp://rpc.md)=====
    | { id?: string, type: 'get_session_stats' }
    | { id?: string, type: 'compact', customInstructions?: string }
    | { id?: string, type: 'set_auto_compaction', enabled: boolean }

/** compaction 结果(compaction_end 事件 / compact 响应 data.result 共用形状) */
export interface CompactionResult {
  summary?: string
  tokensBefore?: number
  tokensAfter?: number
  estimatedTokensAfter?: number
}

/** provider 用量(被动上下文跟踪源;message_update 等帧携带的累计值) */
export interface RpcUsage {
  /** input tokens ≈ 当前上下文长度(本回合 LLM 调用的 prompt 规模) */
  input: number
  output?: number
  cacheRead?: number
  at: number
}
/** host 工具定义(omp 端可见的工具 schema) */
export interface RpcHostToolDefinition {
  name: string
  label?: string
  description: string
  parameters: Record<string, unknown>
  hidden?: boolean
}

/** RPC 响应(命令执行结果) */
export interface RpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
  code?: string
}

/** omp AgentSession 事件(本项目消费的子集) */
export interface AgentSessionEvent {
  type: string
  // message_update
  assistantMessageEvent?: {
    type: 'text_delta' | 'text_start' | 'text_end' | 'thinking_delta' | 'tool_call' | 'tool_result' | string
    delta?: string
    text?: string
    toolName?: string
    toolCallId?: string
    [k: string]: unknown
  }
  message?: { role: string, content: unknown[] }
  // agent_end
  messages?: Array<{ role: string, content: Array<{ type: string, text?: string }> }>
  isTerminal?: boolean
  // tool_execution
  toolName?: string
  toolCallId?: string
  [k: string]: unknown
}

/** omp 向宿主发起的 host_tool_call 请求 */
export interface HostToolCallRequest {
  id: string
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
}

/** 宿主工具 handler:接收 omp 的工具调用,返回结果 */
export type HostToolHandler = (req: HostToolCallRequest) => Promise<{ text: string, isError?: boolean }>

/** RPC 客户端配置 */
export interface OmpRpcClientOptions {
  /** omp 可执行文件路径(默认 'omp') */
  command?: string
  /**
   * 输出模式:'rpc' = 纯协议(无 UI);'rpc-ui' = 协议 + UI 上下文
   * (ask 工具 / extension_ui_request 对话框可用 —— HITL 通道;强制 noPty)。默认 'rpc'。
   */
  mode?: 'rpc' | 'rpc-ui'
  /** 额外 CLI 参数 */
  args?: string[]
  /** 工作目录 */
  cwd?: string
  /** 环境变量 */
  env?: Record<string, string>
  /** 进程退出回调(运行时资源监控登记/标记用;pid 为 -1 表示无法取得) */
  onExit?: (pid: number, code: number | null) => void
}

export interface PendingRequest {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** 流式缓冲上限(超限截断并计数,防大输出/异常流拖爆内存) */

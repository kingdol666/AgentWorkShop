/**
 * OmpRpcAgentImpl 的依赖类型与对外 DTO(原 server/services/workshop/agents/omp-agent.ts 顶部模块级类型声明)。纯类型。
 */
import { attachOmpPluginBridge } from '../plugin-tools'

export interface OmpAgentConfig {
  /** omp 可执行文件路径(默认 'omp',从 PATH 查找) */
  command?: string
  /** 额外 CLI 参数 */
  args?: string[]
  /** omp 工作目录(默认 process.cwd()) */
  cwd?: string
  /** 模型 provider(如 'anthropic'/'openai'/'zhipu');省略则用 omp 默认 */
  provider?: string
  /** 模型 ID;省略则用 omp 默认 */
  model?: string
  /** thinking level: off/minimal/low/medium/high/xhigh/max */
  thinkingLevel?: string
  /** 自定义系统 prompt 前缀(拼接到 agent 系统指令之前) */
  systemPromptPrefix?: string
  /** 限制 omp 仅使用指定内置工具(null = 全部) */
  toolNames?: string[]
  /** 每轮停滞超时(ms,默认 300000):整轮无任何 omp 事件才中止;工具内阻塞(poll_messages ≤180s)有 tool 事件刷新计时 */
  promptTimeoutMs?: number
  /** supervise 轮超时(ms,默认 150000) */
  superviseTimeoutMs?: number
  /**
   * omp 输出模式:'rpc-ui'(默认)= RPC 协议 + UI 上下文 —— ask 工具与
   * extension_ui_request 对话框可用(监控终端 HITL 通道,强制 noPty);
   * 'rpc' = 纯协议(无 UI,ask 不可用)。
   */
  rpcMode?: 'rpc' | 'rpc-ui'
  /** channel 级作业场景 prompt(manager 装配时注入;用户场景规范,全员共享) */
  scenarioPrompt?: string
  /** agent 身份(由 factory 从 AgentInfo 注入) */
  agentId?: string
  name?: string
  role?: 'lead' | 'worker'
  channelId?: string
}

// 插件桥接管(host.mjs ctx.omp 排队注册的工具在此回放;幂等)
attachOmpPluginBridge()

/** 在跑 agent 实例表(工具注册表变更 → 热重发 set_host_tools,运行时注入无需重spawn) */

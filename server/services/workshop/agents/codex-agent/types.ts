/**
 * CodexAgentImpl 的依赖类型与对外 DTO(原 server/services/workshop/agents/codex-agent.ts 顶部模块级类型声明)。纯类型。
 */

export interface CodexAgentConfig {
  /** codex 可执行文件(默认取 harness.codex_command 设置) */
  command?: string
  /** 额外 CLI 参数(app-server 之前) */
  args?: string[]
  cwd?: string
  /** 模型(如 gpt-5.2) */
  model?: string
  /** 审批策略(默认 on-request:沙箱内自由,越界请求审批 → HITL) */
  approvalPolicy?: 'untrusted' | 'on-request' | 'never'
  /** 沙箱(默认 workspace-write) */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** CODEX_HOME(缺省进程环境;配置隔离/多账户时按 agent 指定;effort 未指定 home 时自动种子化) */
  codexHome?: string
  /** 思考 effort(model_reasoning_effort;需 CODEX_HOME 配置面,未指定 home 时自动种子化) */
  effort?: string
  /** 上下文窗口(usage 百分比计算) */
  contextWindow?: number
  /** 压缩阈值(0-1,默认 0.7) */
  compactThreshold?: number
  /**
   * 回合停滞上限(ms):整轮无任何事件(推理模型静默思考也不产 delta)达到该时长才中止。
   * 默认 1800000(30 分钟):codex 0.154 的推理档在负载下可静默思考 >10 分钟,
   * 600s 会把健康的沉默推理误杀为 CODEX_TURN_STALLED(任务 FAILED→重试→CANCELED)。
   * 有事件(delta/status/工具轨迹)即刷新计时,不放大真实卡死的发现延迟。
   */
  promptTimeoutMs?: number
  superviseTimeoutMs?: number
  systemPromptPrefix?: string
  scenarioPrompt?: string
  agentId?: string
  name?: string
  role?: 'lead' | 'worker'
  channelId?: string
  token?: string
  baseUrl?: string
  mcpBridgePath?: string
}

/**
 * ClaudeSdkAgentImpl — claude harness 适配骨架(T8)。
 * run():读取 config(apiKey/model 等);缺失 apiKey 时以 {kind:'error'} 首事件优雅失败
 * (HARNESS_NOT_CONFIGURED),平台随即结束事件流并把消息置 consumed 不重试(§9 错误处理)。
 * 已配置时 TODO 标记真实 Claude Agent SDK 流 → AgentEvent 的映射接入点
 * (本期不实现真实 SDK 调用)。
 * supervise 未实现:lead 调度决策由平台内置规则引擎兜底(§5.6)。
 * 权威契约见 docs/superpowers/specs/2026-08-13-agent-workshop-multi-agent-design.md §4/§9。
 */
import type {
  AgentEvent,
  AgentInterface,
  AgentRunContext,
  AgentRunRequest,
} from './agent-interface'

export class ClaudeSdkAgentImpl implements AgentInterface {
  private readonly apiKey: string | undefined
  private readonly model: string | undefined

  constructor(config: Record<string, unknown> = {}) {
    this.apiKey = typeof config.apiKey === 'string' ? config.apiKey : undefined
    this.model = typeof config.model === 'string' ? config.model : undefined
  }

  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    if (!this.apiKey) {
      yield {
        kind: 'error',
        error: { code: 'HARNESS_NOT_CONFIGURED', message: 'Claude harness 未配置(缺 apiKey)' },
      }
      return
    }
    // TODO(接入点):config 齐备时,在此将 Claude Agent SDK 的流式输出映射为统一 AgentEvent——
    //   1. SDK 会话初始化:apiKey/model 取自 config,contextId=request.contextId 关联 channel
    //   2. 任务消息(request.message.parts + metadata['x-aw-task-kind']/['x-aw-task-id'])
    //      组装为首轮用户输入;SDK tool_use 工具映射到 ctx.workspace 的进程内直调能力面
    //      (dispatchTask/reportTask/completeTask/sendMessage 等,见 §4.1 AgentWorkspace)
    //   3. 事件映射:SDK 文本增量 → {kind:'status', status:{state,message,timestamp}};
    //      工具执行产出 → {kind:'artifact'}(分块用 append+totalChunks,平台按块数折算进度);
    //      会话结束 → {kind:'done', final:{taskId}}
    //   4. 错误 → {kind:'error'}(A2AError);取消由 ctx.signal.abort() 传导中断 SDK 流
    // 本期骨架不发起真实 SDK 调用;配置齐备时返回空事件流(消息随即 consumed)。
    void request
    void ctx
  }
}

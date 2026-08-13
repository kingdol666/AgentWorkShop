/**
 * OmpRpcAgentImpl — omp harness 适配骨架(T8)。
 * run():读取 config(endpoint/token);缺失任一时以 {kind:'error'} 首事件优雅失败
 * (HARNESS_NOT_CONFIGURED),平台随即结束事件流并把消息置 consumed 不重试(§9 错误处理)。
 * 已配置时 TODO 标记 OmpRpcTransport 抽象与接入点——omp 对接走「RPC transport 抽象 + Mock 先行」,
 * 具体端点信息后续提供后再填 adapter(已确认决策)。
 * supervise 未实现:lead 调度决策由平台内置规则引擎兜底(§5.6)。
 * 权威契约见 docs/superpowers/specs/2026-08-13-agent-workshop-multi-agent-design.md §4/§9。
 */
import type {
  AgentEvent,
  AgentInterface,
  AgentRunContext,
  AgentRunRequest,
} from './agent-interface'

/**
 * omp RPC 传输抽象:对 omp 端点的单次调用契约,由 config 注入实现(具体端点信息待填)。
 * call():发起一次 RPC 调用,逐条产出增量帧(对齐统一事件流的流式语义);signal 用于取消传导。
 */
export interface OmpRpcTransport {
  call(method: string, params: unknown, signal: AbortSignal): AsyncIterable<unknown>
}

export class OmpRpcAgentImpl implements AgentInterface {
  private readonly endpoint: string | undefined
  private readonly token: string | undefined

  constructor(config: Record<string, unknown> = {}) {
    this.endpoint = typeof config.endpoint === 'string' ? config.endpoint : undefined
    this.token = typeof config.token === 'string' ? config.token : undefined
  }

  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    if (!this.endpoint || !this.token) {
      yield {
        kind: 'error',
        error: { code: 'HARNESS_NOT_CONFIGURED', message: 'Omp harness 未配置(缺 endpoint/token)' },
      }
      return
    }
    // TODO(接入点):config.endpoint/token 齐备时,在此装配 OmpRpcTransport 并驱动 omp Agent——
    //   - transport 由 config 注入(实现方待填:基于 endpoint/token 的 HTTP/WS RPC 客户端,
    //     认证头携带 token;接口见上方 OmpRpcTransport)
    //   - 任务消息 → transport.call('tasks/run', { message, contextId, taskId }, ctx.signal)
    //   - 增量帧 → AgentEvent 映射:文本帧 → {kind:'status'};工具帧 → ctx.workspace 直调
    //     (dispatchTask/reportTask/completeTask/sendMessage 等)并产出 {kind:'artifact'};
    //     结束帧 → {kind:'done', final:{taskId}};错误帧 → {kind:'error'}
    //   - 取消:ctx.signal.abort() 经 transport.call 的 signal 传导终止 RPC 流
    // 本期骨架不发起真实 RPC;端点信息提供后在此实现。
    void request
    void ctx
  }
}

/**
 * OmpRpcClientState —— 状态字段 / 构造 / 进程与上下文窗口查询
 * (拆分层,承 OmpRpcClientContracts;方法体与原文件逐行一致)
 */
import { OmpRpcClientContracts } from './contracts'
import type { AgentSessionEvent, HostToolHandler, OmpRpcClientOptions, PendingRequest, RpcUsage } from './types'
import type { ChildProcess } from 'node:child_process'

export abstract class OmpRpcClientState extends OmpRpcClientContracts {
  protected child: ChildProcess | null = null
  protected stdoutBuf = ''
  protected stderrBuf = ''
  protected stderrTruncated = 0
  protected ready = false
  protected disposed = false
  /** 子进程是否已退出(资源监控/优雅 dispose 用) */
  protected exited = false
  protected exitCode: number | null = null

  protected readonly pending = new Map<string, PendingRequest>()
  protected seq = 0

  /** 被动上下文跟踪:最近一次帧携带的累计 provider usage(get_session_stats 不可用时的兜底源) */
  protected lastUsage: RpcUsage | null = null
  /** 上下文窗口大小(外部经 get_state 探测后注入;null = 未知,percent 不可算) */
  protected contextWindow: number | null = null

  protected readonly eventListeners = new Set<(event: AgentSessionEvent) => void>()
  /** 原始帧 tap(chunk 重组后的每一帧,含 response/host_tool_call/extension_ui_request) */
  protected readonly rawFrameListeners = new Set<(frame: Record<string, unknown>) => void>()
  protected hostToolHandler: HostToolHandler | null = null

  /** v2 chunk 重组缓冲(带最近活跃时间;TTL 清理残缺分片) */
  protected readonly chunkBuffers = new Map<string, { count: number, parts: Map<number, string>, at: number }>()

  constructor(protected readonly options: OmpRpcClientOptions = {}) {
    super()
  }

  /** 子进程 pid(spawn 前/失败为 undefined;已退出仍保留) */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /** 子进程是否存活(spawn 前或已退出 → false) */
  get alive(): boolean {
    return !!this.child && !this.exited
  }

  /** 注入上下文窗口大小(get_state 探测 model.contextWindow 后调用;幂等) */
  setContextWindow(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.contextWindow = tokens
  }

  /** 被动上下文用量快照(无探测 RPC;数据来自最近一次携带 usage 的帧) */
  getContextUsage(): { tokens: number, contextWindow: number | null, percent: number | null } | null {
    if (!this.lastUsage) return null
    const window = this.contextWindow
    return {
      tokens: this.lastUsage.input,
      contextWindow: window,
      percent: window && window > 0 ? Math.min(1, this.lastUsage.input / window) : null,
    }
  }
}

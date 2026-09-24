/**
 * OmpRpcClientStdout —— 内部:stdout 分帧与帧分发
 * (拆分层,承 OmpRpcClientApi;方法体与原文件逐行一致)
 */
import { OmpRpcClientApi } from './api'
import type { AgentSessionEvent, RpcResponse } from './types'
import type { HostToolCallFrame, RpcChunkFrame } from './helpers'
import { STDOUT_LINE_CAP } from './helpers'

export abstract class OmpRpcClientStdout extends OmpRpcClientApi {
  /** stdout 数据处理:逐行 JSON 解析 → 分发 */
  protected onStdout(data: string): void {
    this.stdoutBuf += data
    if (this.stdoutBuf.length > STDOUT_LINE_CAP) {
      // 半行缓冲异常膨胀(对端异常流):丢弃已积累部分,防内存无界增长
      this.stdoutBuf = ''
    }
    const lines = this.stdoutBuf.split('\n')
    this.stdoutBuf = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const frame = JSON.parse(trimmed)
        this.dispatchFrame(frame)
      }
      catch {
        // 非 JSON 行(理论上不应出现):忽略
      }
    }
  }

  /** 分发单个 JSON 帧 */
  protected dispatchFrame(frame: Record<string, unknown>): void {
    const type = frame.type as string

    // 被动上下文跟踪:任何帧携带累计 usage 都刷新最近值(零额外请求)
    const usage = this.extractUsage(frame)
    if (usage) this.lastUsage = usage

    // 原始帧镜像(终端 hub;listener 异常不影响协议处理)
    for (const fn of this.rawFrameListeners) {
      try {
        fn(frame)
      }
      catch {
        /* ignore */
      }
    }

    // v2 chunk 重组
    if (type === 'rpc_chunk') {
      this.handleChunk(frame as unknown as RpcChunkFrame)
      return
    }

    // 命令响应
    if (type === 'response') {
      const resp = frame as unknown as RpcResponse
      const id = resp.id
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!
        clearTimeout(p.timer)
        this.pending.delete(id)
        if (resp.success) p.resolve(resp)
        else p.reject(new Error(resp.error ?? `omp RPC 命令失败: ${resp.command}`))
      }
      return
    }

    // host_tool_call:转发到宿主 handler
    if (type === 'host_tool_call') {
      void this.handleHostToolCall(frame as unknown as HostToolCallFrame)
      return
    }

    // host_tool_cancel:忽略(当前实现不支持中途取消 host tool)
    if (type === 'host_tool_cancel') return

    // extension_ui_request / available_commands_update / 其他事件:作为 session event 转发
    for (const fn of this.eventListeners) {
      try {
        fn(frame as unknown as AgentSessionEvent)
      }
      catch (err) {
        // listener 异常不影响协议处理
        void err
      }
    }
  }
}

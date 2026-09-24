/**
 * OmpRpcClientFrames —— 内部:宿主工具调用 / 分块装配 / 退出与错误通知
 * (拆分层,承 OmpRpcClientStdout;方法体与原文件逐行一致)
 */
import { OmpRpcClientStdout } from './stdout'
import type { AgentSessionEvent } from './types'
import type { HostToolCallFrame, RpcChunkFrame } from './helpers'
import { CHUNK_TTL_MS } from './helpers'

export abstract class OmpRpcClientFrames extends OmpRpcClientStdout {
  /** 处理 host_tool_call:调 handler → 发 host_tool_result */
  protected async handleHostToolCall(req: HostToolCallFrame): Promise<void> {
    const { id, toolCallId, toolName, arguments: args } = req
    let result: { text: string, isError?: boolean }

    if (this.hostToolHandler) {
      try {
        result = await this.hostToolHandler({ id, toolCallId, toolName, arguments: args ?? {} })
      }
      catch (err) {
        result = { text: `工具执行异常: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    }
    else {
      result = { text: `无 host tool handler 注册(toolName=${toolName})`, isError: true }
    }

    // 发送 host_tool_result
    const resultFrame = {
      type: 'host_tool_result' as const,
      id,
      result: {
        content: [{ type: 'text' as const, text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      },
    }
    try {
      this.child?.stdin?.write(JSON.stringify(resultFrame) + '\n')
    }
    catch {
      // 进程可能已关闭
    }
  }

  /** v2 chunk 重组 */
  protected handleChunk(frame: RpcChunkFrame): void {
    const { chunkId, index, count, byteLength, data } = frame
    if (!chunkId || typeof index !== 'number' || typeof count !== 'number') return

    // TTL 清扫:残缺分片(丢失/乱序未收齐)30s 后释放
    const now = Date.now()
    for (const [cid, b] of this.chunkBuffers) {
      if (now - b.at > CHUNK_TTL_MS) this.chunkBuffers.delete(cid)
    }

    let buf = this.chunkBuffers.get(chunkId)
    if (!buf) {
      buf = { count, parts: new Map(), at: now }
      this.chunkBuffers.set(chunkId, buf)
    }
    buf.at = now
    buf.parts.set(index, data ?? '')

    // 全部分片到齐 → 重组
    if (buf.parts.size === buf.count) {
      const sorted = [...buf.parts.entries()].sort((a, b) => a[0] - b[0])
      const b64 = sorted.map(([, d]) => d).join('')
      this.chunkBuffers.delete(chunkId)
      try {
        const json = Buffer.from(b64, 'base64').toString('utf-8')
        const frame = JSON.parse(json)
        void byteLength
        this.dispatchFrame(frame)
      }
      catch {
        // chunk 重组失败:忽略
      }
    }
  }

  /** 子进程退出处理(exit 事件 / OS 存活校准 reconcile 共用;幂等) */
  protected handleExit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    this.options.onExit?.(this.child?.pid ?? -1, code)
    // 拒绝所有 pending
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`omp 子进程退出(code=${code})`))
    }
    this.pending.clear()

    // 通知事件监听器
    for (const fn of this.eventListeners) {
      try {
        fn({ type: '__process_exit__', isTerminal: true } as unknown as AgentSessionEvent)
      }
      catch { /* ignore */ }
    }
  }

  protected notifyError(err: Error): void {
    for (const fn of this.eventListeners) {
      try {
        fn({ type: '__error__', isTerminal: true, messages: [], ...(err.message ? { error: err.message } : {}) } as unknown as AgentSessionEvent)
      }
      catch { /* ignore */ }
    }
  }
}

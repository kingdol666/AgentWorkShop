/**
 * OmpRpcClientLayer03 —— 发送命令 / 事件与原始帧订阅 / 宿主工具回调 / 释放
 * (分层 4/6,承 OmpRpcClientLayer02;方法体与原文件逐行一致)
 */
import { OmpRpcClientLayer02 } from './02-start'
import type { AgentSessionEvent, HostToolHandler, RpcCommand, RpcResponse } from './types'

export abstract class OmpRpcClientLayer03 extends OmpRpcClientLayer02 {
  /** 发送命令,等待关联响应 */
  async send<T = RpcResponse>(command: RpcCommand): Promise<T & RpcResponse> {
    if (!this.child?.stdin?.writable) throw new Error('omp 子进程未就绪或已关闭')
    if (this.disposed) throw new Error('omp RPC 客户端已 dispose')

    const id = command.id ?? `req_${++this.seq}`
    const frame = JSON.stringify({ ...command, id }) + '\n'

    return new Promise<T & RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`omp RPC 命令超时: ${command.type} (id=${id})`))
      }, 60_000)

      this.pending.set(id, {
        resolve: resolve as (r: RpcResponse) => void,
        reject,
        timer,
      })

      this.child!.stdin!.write(frame, (err) => {
        if (err) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(new Error(`omp RPC 写入失败: ${err.message}`))
        }
      })
    })
  }

  /** 订阅 AgentSessionEvent 流 */
  onEvent(fn: (event: AgentSessionEvent) => void): () => void {
    this.eventListeners.add(fn)
    return () => {
      this.eventListeners.delete(fn)
    }
  }

  /**
   * 订阅原始帧流(chunk 重组后的每一帧,含 response / host_tool_call /
   * extension_ui_request / 全部会话事件)。终端镜像(harness-terminal)的事实源。
   */
  onRawFrame(fn: (frame: Record<string, unknown>) => void): () => void {
    this.rawFrameListeners.add(fn)
    return () => {
      this.rawFrameListeners.delete(fn)
    }
  }

  /**
   * 写入原始 stdin 帧(不走命令/响应关联)——用于 side-channel 帧
   * (extension_ui_response 等)。
   */
  writeRaw(frame: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) throw new Error('omp 子进程未就绪或已关闭')
    this.child.stdin.write(JSON.stringify(frame) + '\n')
  }

  /** 注册 host 工具 handler(omp 调用宿主工具时回调) */
  onHostToolCall(handler: HostToolHandler): void {
    this.hostToolHandler = handler
  }

  /** 优雅关闭:中止当前 prompt → 等待退出 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    // 尝试优雅关闭(stdin close → omp 排空后 exit 0)
    try {
      if (this.child?.stdin && !this.child.stdin.destroyed) {
        this.child.stdin.end()
      }
    }
    catch {
      // ignore
    }

    // 等待退出,最多 3s
    await new Promise<void>((resolve) => {
      if (!this.child || this.child.killed || this.exited) return resolve()
      const timer = setTimeout(() => {
        this.child?.kill('SIGKILL')
        resolve()
      }, 3_000)
      this.child!.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })

    // 清理 pending
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('omp RPC 客户端已 dispose'))
    }
    this.pending.clear()
    this.eventListeners.clear()
    this.rawFrameListeners.clear()
  }

  // ===== 内部 =====
}

/**
 * OmpRpcClientStart —— 启动子进程与握手
 * (拆分层,承 OmpRpcClientUsage;方法体与原文件逐行一致)
 */
import { OmpRpcClientUsage } from './usage'
import type { AgentSessionEvent } from './types'
import { STDERR_CAP } from './helpers'
import { spawn } from 'node:child_process'

export abstract class OmpRpcClientStart extends OmpRpcClientUsage {
  /** spawn omp 子进程,等待 ready frame */
  async start(): Promise<void> {
    const command = this.options.command ?? 'omp'
    const mode = this.options.mode ?? 'rpc'
    const args = ['--mode', mode, ...(this.options.args ?? [])]

    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd ?? process.cwd(),
      env: { ...process.env, ...this.options.env },
      windowsHide: true,
    })

    this.child.stdout?.setEncoding('utf-8')
    this.child.stderr?.setEncoding('utf-8')
    // stdio 流级 error 兜底监听:进程被强杀(terminate/进程树 kill)后写 stdin 会
    // 触发流 'error'(EPIPE);无监听者会升级为 uncaughtException。真实失败语义
    // 由 send 回调 / exit 事件传导,这里仅吞流级噪声。
    this.child.stdin?.on('error', () => {})
    this.child.stdout?.on('error', () => {})
    this.child.stderr?.on('error', () => {})

    return new Promise<void>((resolve, reject) => {
      const onReady = (frame: AgentSessionEvent): void => {
        if (frame.type === 'ready' && !this.ready) {
          this.ready = true
          resolve()
        }
      }
      this.eventListeners.add(onReady as (event: AgentSessionEvent) => void)

      this.child!.stdout!.on('data', (data: string) => this.onStdout(data))
      this.child!.stderr!.on('data', (data: string) => {
        this.stderrBuf += data
        if (this.stderrBuf.length > STDERR_CAP) {
          // 保留尾部(诊断价值最高),截断部分计数可见
          this.stderrTruncated += this.stderrBuf.length - STDERR_CAP
          this.stderrBuf = this.stderrBuf.slice(-STDERR_CAP)
        }
      })
      this.child!.on('error', (err: Error) => {
        if (!this.ready) reject(err)
        else this.notifyError(err)
      })
      this.child!.on('exit', (code: number | null) => {
        if (!this.ready) {
          reject(new Error(`omp 子进程在 ready 前退出(code=${code})${this.stderrBuf ? `\nstderr: ${this.stderrBuf.slice(-500)}` : ''}`))
        }
        else {
          this.handleExit(code)
        }
      })

      // 超时保护
      setTimeout(() => {
        if (!this.ready) reject(new Error('omp RPC ready 超时(10s)'))
      }, 10_000)
    })
  }
}

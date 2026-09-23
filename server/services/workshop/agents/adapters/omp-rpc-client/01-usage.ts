/**
 * OmpRpcClientLayer01 —— 用量提取 / 存活核对 / 终止
 * (分层 2/6,承 OmpRpcClientLayer00;方法体与原文件逐行一致)
 */
import { OmpRpcClientLayer00 } from './00-state'
import type { RpcUsage } from './types'
import { isProcessAlive } from '../../harness-process'

export abstract class OmpRpcClientLayer01 extends OmpRpcClientLayer00 {
  /**
   * 从帧中防御性提取累计 usage(顶层 frame.usage 或 frame.message.usage;
   * input 兼容 input/inputTokens/promptTokens 命名;无有效 input 返回 null)。
   */
  protected extractUsage(frame: Record<string, unknown>): RpcUsage | null {
    const raw = (frame.usage ?? (frame.message as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined
    if (!raw || typeof raw !== 'object') return null
    const input = Number(raw.input ?? raw.inputTokens ?? raw.promptTokens)
    if (!Number.isFinite(input) || input <= 0) return null
    const output = Number(raw.output ?? raw.outputTokens)
    const cacheRead = Number(raw.cacheRead)
    return {
      input,
      output: Number.isFinite(output) ? output : undefined,
      cacheRead: Number.isFinite(cacheRead) ? cacheRead : undefined,
      at: Date.now(),
    }
  }

  /**
   * OS 级存活校准(系统休眠/强杀后 exit 事件可能不达,alive 会失真):
   * 按 PID 探 OS 实际存在性,进程已死则收敛为已退出(与 exit 事件同路径:
   * onExit 登记、拒绝 pending、广播 __process_exit__),在途回合据此归位,
   * 后续 ensureClient 得以重生子进程。幂等;进程健在/未 spawn 时无操作。
   */
  reconcile(): boolean {
    const pid = this.child?.pid
    if (!pid || this.exited || this.disposed) return true
    if (isProcessAlive(pid)) return true
    this.handleExit(null)
    return false
  }

  /** 强制终止子进程(不等优雅退出;进程树终止由监控层 killHarnessProcess 负责) */
  kill(): void {
    this.child?.kill('SIGKILL')
  }
}

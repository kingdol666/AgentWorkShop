/**
 * OpenCodeAgentImplLayer01 —— 生命周期 / 进程面
 * (分层 2/6,承 OpenCodeAgentImplLayer00;方法体与原文件逐行一致)
 */
import { OpenCodeAgentImplLayer00 } from './00-core'
import { isProcessAlive, killHarnessProcess, markHarnessProcessExit } from '../harness-process'

export abstract class OpenCodeAgentImplLayer01 extends OpenCodeAgentImplLayer00 {
  getProcessInfo(): { pid: number, alive: boolean, command: string } | null {
    const pid = this.child?.pid
    if (!pid || !this.child) return null
    return { pid, alive: !this.exited, command: 'opencode serve' }
  }

  killProcess(): void {
    const pid = this.child?.pid
    if (pid) killHarnessProcess(pid)
    this.child = null
  }

  reconcileProcess(): void {
    const pid = this.child?.pid
    if (!pid || this.exited) return
    if (!isProcessAlive(pid)) this.handleServerExit(null)
  }

  async dispose(): Promise<void> {
    this.sseAbort?.abort()
    const pid = this.child?.pid
    if (pid) {
      killHarnessProcess(pid)
      markHarnessProcessExit(pid, null)
    }
    this.child = null
    this.exited = true
    this.serverStarting = null
    for (const [id, p] of this.pendingHitl) {
      if (p.timer) clearTimeout(p.timer)
      this.pendingHitl.delete(id)
    }
  }

  // ===== 引擎无关面 =====
}

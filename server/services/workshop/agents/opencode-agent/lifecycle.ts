/**
 * OpenCodeAgentImplLifecycle —— 生命周期 / 进程面
 * (拆分层,承 OpenCodeAgentImplCore;方法体与原文件逐行一致)
 */
import { OpenCodeAgentImplCore } from './core'
import { isProcessAlive, killHarnessProcess, markHarnessProcessExit } from '../harness-process'

export abstract class OpenCodeAgentImplLifecycle extends OpenCodeAgentImplCore {
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

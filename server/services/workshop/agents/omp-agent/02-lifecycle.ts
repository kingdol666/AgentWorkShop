/**
 * OmpRpcAgentImplLayer02 —— 生命周期(dispose / 进程对账)
 * (分层 3/6,承 OmpRpcAgentImplLayer01;方法体与原文件逐行一致)
 */
import { OmpRpcAgentImplLayer01 } from './01-context-governance'
import { hostToolsForRole } from '../host-tool-bridge'
import { killHarnessProcess, markHarnessProcessExit } from '../harness-process'
import { liveAgents } from './helpers'
import { markTerminalSessionExit } from '../harness-terminal'

export abstract class OmpRpcAgentImplLayer02 extends OmpRpcAgentImplLayer01 {
  async dispose(): Promise<void> {
    liveAgents().delete(this)
    if (this.client) {
      const pid = this.client.pid
      await this.client.dispose()
      this.client = null
      if (pid) {
        markHarnessProcessExit(pid, null)
        markTerminalSessionExit(pid, null)
      }
    }
    this.hostToolsRegistered = false
  }

  /** 工具注册表变更 → 热重发 set_host_tools(在跑会话立即获得插件新工具,无需重spawn) */
  refreshPluginTools(): void {
    const client = this.client
    if (!client || !client.alive) return
    void client.send({ type: 'set_host_tools', tools: hostToolsForRole(this.agentRole, this.channelId) }).catch(() => {})
  }

  /** harness 会话身份(§2.4;get_state 探测到才有;未探测到返回 null) */
  getSessionId(): string | null {
    return this.sessionId
  }

  /** 消费一次上次 Harness 重建原因(§6.2 lastRestartReason;取出即清空) */
  takeHarnessRestartReason(): string | null {
    const reason = this.harnessRestartReason
    this.harnessRestartReason = null
    return reason
  }

  /** harness 进程资源信息(运行时资源监控;进程未 spawn/已回收 → null) */
  getProcessInfo(): { pid: number, alive: boolean, command: string } | null {
    const client = this.client
    const pid = client?.pid
    if (!pid || !client) return null
    return { pid, alive: client.alive, command: `omp --mode ${this.rpcMode}` }
  }

  /** 强制终止 harness 进程(进程树;终止后由调用方停止对应 AgentRuntime) */
  killProcess(): void {
    const pid = this.client?.pid
    if (pid) {
      markTerminalSessionExit(pid, null)
      killHarnessProcess(pid)
    }
    else {
      this.client?.kill()
    }
  }

  /**
   * harness 进程存活校准(manager sweeper 周期性调用;休眠/强杀后 exit 事件
   * 可能不达父进程):按 PID 探 OS 实际存在性,进程已死 → 客户端收敛为已退出,
   * 在途回合经 __process_exit__ 归位,下一回合 ensureClient 重生子进程。
   */
  reconcileProcess(): void {
    this.client?.reconcile()
  }

  /** omp 输出模式(rpc-ui = 默认,启用 HITL 对话框) */
  protected get rpcMode(): 'rpc' | 'rpc-ui' {
    return this.config.rpcMode === 'rpc' ? 'rpc' : 'rpc-ui'
  }

  // ===== 工具桥(共享分发)=====
}

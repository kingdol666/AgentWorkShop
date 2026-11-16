/**
 * OmpRpcAgentImplLifecycle —— 生命周期(dispose / 进程对账)
 * (拆分层,承 OmpRpcAgentImplContextGovernance;方法体与原文件逐行一致)
 */
import { OmpRpcAgentImplContextGovernance } from './context-governance'
import { hostToolsForAgent } from '../host-tool-bridge'
import { killHarnessProcess, markHarnessProcessExit } from '../harness-process'
import { liveAgents } from './helpers'
import { markTerminalSessionExit } from '../harness-terminal'
import { createHash, randomBytes } from 'node:crypto'
import type { OmpRpcClient } from '../adapters/omp-rpc-client'
import type { ExecutionScope } from '../execution-scope'

export abstract class OmpRpcAgentImplLifecycle extends OmpRpcAgentImplContextGovernance {
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
    this.hostToolAliases = null
    this.hostToolsRegistered = false
  }

  /** Register aliases in a single ordered queue, including plugin hot reloads. */
  protected registerTurnTools(client: OmpRpcClient, scope: ExecutionScope, rotate: boolean): Promise<void> {
    if (rotate) {
      this.hostToolAliases = { client, scope, nonce: randomBytes(16).toString('hex'), revision: 0, byAlias: new Map(), byName: new Map() }
    }
    const turn = this.hostToolAliases
    if (!turn || turn.client !== client || turn.scope !== scope) return Promise.reject(new Error('OMP turn tool scope unavailable'))
    const revision = ++turn.revision
    if (!rotate) {
      turn.nonce = randomBytes(16).toString('hex')
      turn.byAlias.clear()
      turn.byName.clear()
    }
    const nonce = turn.nonce
    const update = this.hostToolRegistration.catch(() => {}).then(async () => {
      if (this.hostToolAliases !== turn || this.client !== client || scope.signal.aborted) throw new Error('OMP turn tool scope expired')
      const tools = hostToolsForAgent(this.selfAgentId, this.agentRole, this.channelId)
      const nextByAlias = new Map<string, string>()
      const nextByName = new Map<string, string>()
      const aliased = tools.map((tool) => {
        const digest = createHash('sha256').update(tool.name).digest('hex').slice(0, 16)
        const prefix = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 11) || 'tool'
        const alias = `aw_${nonce}_${digest}_${prefix}`
        if (nextByAlias.has(alias)) throw new Error(`OMP host tool alias collision: ${tool.name}`)
        nextByAlias.set(alias, tool.name)
        nextByName.set(tool.name, alias)
        return { ...tool, name: alias, description: `Canonical tool: ${tool.name}. ${tool.description}` }
      })
      // Revoke the old snapshot while registration is in flight; a failed or
      // ambiguous update must never leave any alias dispatchable.
      turn.byAlias.clear()
      await client.send({ type: 'set_host_tools', tools: aliased })
      if (this.hostToolAliases !== turn || this.client !== client || scope.signal.aborted) throw new Error('OMP turn tool scope expired')
      if (turn.revision !== revision) return
      turn.byAlias = nextByAlias
      turn.byName = nextByName
      this.hostToolsRegistered = true
    })
    this.hostToolRegistration = update
    return update
  }

  protected async prepareTurnTools(client: OmpRpcClient, scope: ExecutionScope): Promise<void> {
    await this.registerTurnTools(client, scope, true)
    let pending: Promise<void>
    do {
      pending = this.hostToolRegistration
      await pending
    } while (pending !== this.hostToolRegistration)
    if (this.hostToolAliases?.client !== client || this.hostToolAliases.scope !== scope || this.client !== client || scope.signal.aborted) {
      throw new Error('OMP turn tool scope expired')
    }
  }

  protected clearTurnTools(scope: ExecutionScope): void {
    if (this.hostToolAliases?.scope === scope) this.hostToolAliases = null
  }

  /** 工具注册表变更 → 回收旧别名并热更新。 */
  refreshPluginTools(): void {
    const turn = this.hostToolAliases
    if (!turn || turn.client !== this.client || !turn.client.alive || turn.scope.signal.aborted) return
    void this.registerTurnTools(turn.client, turn.scope, false).catch((err) => {
      // A failed refresh leaves no potentially revoked alias dispatchable.
      if (this.hostToolAliases === turn) turn.byAlias.clear()
      console.warn('[omp] host tool refresh failed:', err instanceof Error ? err.message : err)
    })
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

/**
 * CodexAgentImplLayer00 —— 字段 / 构造 / 配置面 / 进程面
 * (分层 1/4,承 BaseAgentImpl;方法体与原文件逐行一致)
 *
 * 本层还声明了 2 个跨层契约抽象方法(原类已有基类,无法再挂 contracts.ts)。
 */
import { BaseAgentImpl } from '../base-agent'
import type { AepHitlQuestion } from '../../../../../shared/workshop-protocol'
import type { AgentContextStats } from '../../types/task'
import type { AgentInfo, AgentRunContext } from '../agent-interface'
import type { BaseAgentConfigView } from '../base-agent'
import type { CodexAgentConfig } from './types'
import type { StdioJsonRpcClient } from '../adapters/stdio-jsonrpc'
import { killHarnessProcess, markHarnessProcessExit } from '../harness-process'

export abstract class CodexAgentImplLayer00 extends BaseAgentImpl {
  // ── 跨层能力契约(由后面的层实现;见本文件头部说明)──
  protected abstract ensureClient(ctx: AgentRunContext): Promise<void>
  protected abstract respondUserInput(
    rpcId: string | number,
    id: string,
    outcome: { cancelled?: boolean, value?: string, answers?: Array<{ id?: string, answer: string }> },
  ): Promise<void>

  protected readonly config: CodexAgentConfig
  protected agentInfo: AgentInfo | null = null
  // 不要重新声明 bridgeCtx / agentRole(由 BaseAgentImpl 持有)。
  // 子类字段初始化器在 super() 之后执行,会用空 identity 遮蔽基类已装配好的 bridgeCtx,
  // 使 host tool 桥的 agentId 恒为 '' → 按 agentId 的鉴权全部误判(节点绑定/工业工具)。
  // 同理 agentRole 会被重置为 'worker',lead 身份丢失。

  protected client: StdioJsonRpcClient | null = null
  protected clientStarting: Promise<void> | null = null
  protected threadId: string | null = null
  protected turnId: string | null = null

  // 回合状态
  protected turnActive = false
  protected deltaBuf = ''
  protected deltaTimer: ReturnType<typeof setTimeout> | null = null
  protected lastUsage: { input: number, at: number } | null = null
  protected compacting = false
  protected lastCompactAt = 0
  /**
   * 待应答 HITL(approval request id → JSON-RPC id)。
   * v17:`type` 区分 approval 与 question —— 二者**原生应答载荷不同**
   * (approval → `{decision: accept|decline|cancel}`;question → `{answers:[…]}`),
   * 原先只有一张表且 respondHitl 恒发 `{decision}`,导致 tool/requestUserInput
   * 的提问只能靠超时取消(§13.5 必修复项)。
   */
  protected pendingApprovals = new Map<string, {
    rpcId: string | number
    timer: ReturnType<typeof setTimeout> | null
    type: 'approval' | 'question'
    /** question 型:全量问题(多问题按序回传 answers[]) */
    questions: AepHitlQuestion[]
  }>()

  constructor(config: Record<string, unknown> = {}) {
    super({
      agentId: typeof config.agentId === 'string' ? config.agentId : '',
      name: typeof config.name === 'string' ? config.name : undefined,
      role: config.role === 'lead' ? 'lead' : 'worker',
      channelId: typeof config.channelId === 'string' ? config.channelId : '',
    })
    this.config = config as CodexAgentConfig
  }

  protected get harnessId(): string {
    return 'codex'
  }

  protected configRecord(): BaseAgentConfigView {
    return this.config
  }

  async dispose(): Promise<void> {
    const client = this.client
    this.client = null
    this.threadId = null
    if (client) {
      const pid = client.pid
      await client.dispose().catch(() => {})
      if (pid) markHarnessProcessExit(pid, null)
    }
    for (const [id, p] of this.pendingApprovals) {
      if (p.timer) clearTimeout(p.timer)
      this.pendingApprovals.delete(id)
    }
  }

  getProcessInfo(): { pid: number, alive: boolean, command: string } | null {
    const client = this.client
    const pid = client?.pid
    if (!pid || !client) return null
    return { pid, alive: client.alive, command: 'codex app-server' }
  }

  killProcess(): void {
    const pid = this.client?.pid
    if (pid) killHarnessProcess(pid)
    else this.client?.kill()
  }

  reconcileProcess(): void {
    this.client?.reconcile()
  }

  getContextStats(): AgentContextStats | null {
    if (!this.lastUsage) return null
    const window = this.config.contextWindow ?? null
    return {
      usedTokens: this.lastUsage.input,
      contextWindow: window,
      percent: window && window > 0 ? Math.min(1, this.lastUsage.input / window) : null,
      compacting: this.compacting,
    }
  }
}

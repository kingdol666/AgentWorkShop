/**
 * OpenCodeAgentImplLayer00 —— 字段与构造
 * (分层 1/6,承 BaseAgentImpl;方法体与原文件逐行一致)
 *
 * 本层还声明了 8 个跨层契约抽象方法(原类已有基类,无法再挂 contracts.ts)。
 */
import { BaseAgentImpl } from '../base-agent'
import type { AgentEvent, AgentInfo, AgentRunContext } from '../agent-interface'
import type { BaseAgentConfigView } from '../base-agent'
import type { OpenCodeAgentConfig, PendingHitl } from './types'
import type { spawnLineProcess } from '../adapters/line-spawn'

export abstract class OpenCodeAgentImplLayer00 extends BaseAgentImpl {
  // ── 跨层能力契约(由后面的层实现;见本文件头部说明)──
  protected abstract api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>>
  protected abstract ensureServer(ctx: AgentRunContext): Promise<void>
  protected abstract handleServerExit(code: number | null): void
  protected abstract onEngineEvent(fn: (ev: Record<string, unknown>) => void): () => void
  protected abstract promptAsync(text: string): Promise<void>
  protected abstract registerPermissionHitl(v2: boolean, props: Record<string, unknown>): void
  protected abstract registerQuestionHitl(props: Record<string, unknown>): void
  protected abstract runTurn(
    prompt: string,
    taskId: string | undefined,
    opts: { timeoutMs: number, signal?: AbortSignal, beforeStart?: () => void, onDone?: () => void },
  ): AsyncGenerator<AgentEvent, void, unknown>

  protected readonly config: OpenCodeAgentConfig
  protected agentInfo: AgentInfo | null = null
  // 注意:不要在本类重新声明 bridgeCtx / agentRole —— 它们由 BaseAgentImpl 持有。
  // 子类字段初始化器在 super() **之后**执行,会用一个空的 identity 覆盖基类已装配好的
  // bridgeCtx(class field 遮蔽),导致 host tool 桥拿到的 agentId 恒为 '' ——
  // 所有按 agentId 的鉴权(节点绑定/工业工具)都会误判为"未绑定"。
  // 同理 agentRole 被重置为 'worker',lead 身份传不到桥里。

  // 服务进程与 API 面
  protected child: ReturnType<typeof spawnLineProcess> | null = null
  protected baseUrl = ''
  protected basicAuth = ''
  protected sessionId: string | null = null
  protected serverStarting: Promise<void> | null = null
  protected exited = false
  protected stderrTail = ''
  protected sseAbort: AbortController | null = null

  // 回合状态
  protected turnActive = false
  protected aborted = false
  /** 助手正文(partId → 全文;message.part.updated 携带全量文本) */
  protected partTexts = new Map<string, string>()
  protected partOrder: string[] = []
  protected lastUsage: { input: number, at: number } | null = null
  protected compacting = false
  protected lastCompactAt = 0
  /** 待应答 HITL(id → 定位信息) */
  protected pendingHitl = new Map<string, PendingHitl>()

  constructor(config: Record<string, unknown> = {}) {
    super({
      agentId: typeof config.agentId === 'string' ? config.agentId : '',
      name: typeof config.name === 'string' ? config.name : undefined,
      role: config.role === 'lead' ? 'lead' : 'worker',
      channelId: typeof config.channelId === 'string' ? config.channelId : '',
    })
    this.config = config as OpenCodeAgentConfig
  }

  protected get harnessId(): string {
    return 'opencode'
  }

  protected configRecord(): BaseAgentConfigView {
    return this.config
  }

  // ===== 生命周期 / 进程面 =====
}

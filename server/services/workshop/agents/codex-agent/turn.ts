/**
 * CodexAgentImplTurn —— 回合:steer / onTurnSettled / 事件流桥接
 * (拆分层,承 CodexAgentImplCore;方法体与原文件逐行一致)
 */
import { CodexAgentImplCore } from './core'
import type { AgentEvent, AgentRunContext, AgentRunRequest } from '../agent-interface'
import { CODEX_TURN_STALL_MS, log } from './helpers'
import { getHitlRegistry } from '../hitl-registry'
import { peerPrompt, systemManual, toolArgsPreview, workerPrompt } from '../prompt-builder'
import { randomUUID } from 'node:crypto'

export abstract class CodexAgentImplTurn extends CodexAgentImplCore {
  /** 实时注入:turn 运行中 → turn/steer;否则 'deferred'(消息保持 pending) */
  async steer(text: string): Promise<'steer' | 'deferred'> {
    const client = this.client
    if (!client?.alive || !this.threadId || !this.turnActive) return 'deferred'
    try {
      await client.request('turn/steer', {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
      }, 15_000)
      return 'steer'
    }
    catch {
      // 无 active turn / 引擎拒绝 → 消息保持 pending 由消费循环处理
      return 'deferred'
    }
  }

  /**
   * HITL 应答(hitl-decision 传导入口)。
   * - question(requestUserInput)→ respondUserInput(`{answers:[…]}` / respondError 取消);
   * - approval → JSON-RPC 应答 `{decision: accept|decline|cancel}`。
   * 显式 `response` 枚举(accept|decline|cancel)优先于 confirmed 布尔;未知值由
   * hitl-decision 在入口 400 拒绝,此处不再兜底"放行"。
   */
  override async respondHitl(kind: string, id: string, outcome: {
    confirmed?: boolean
    cancelled?: boolean
    value?: string
    response?: string
    comment?: string
  }): Promise<void> {
    if (kind !== 'codex-approval') return
    const pending = this.pendingApprovals.get(id)
    if (!pending) throw new Error(`待办不存在或已处理: ${id}`)
    // 提问型:必须走 answers 协议(此前落到 {decision} 分支 → 引擎无法解析提问答案)
    if (pending.type === 'question') {
      await this.respondUserInput(pending.rpcId, id, {
        cancelled: outcome.cancelled === true,
        value: outcome.value ?? outcome.comment,
      })
      return
    }
    const client = this.client
    if (!client) throw new Error('codex 会话已关闭')
    // 显式枚举 > 布尔;cancel 优先于一切(取消绝不等价于同意)
    const decision = outcome.cancelled === true || outcome.response === 'cancel'
      ? 'cancel'
      : outcome.response === 'accept' || outcome.response === 'decline'
        ? outcome.response
        : outcome.confirmed === true ? 'accept' : 'decline'
    client.respond(pending.rpcId, { decision })
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingApprovals.delete(id)
    getHitlRegistry().resolve(kind, id, decision === 'cancel' ? 'cancelled' : 'answered')
  }

  /** 上下文治理(post-settle):越阈值 → thread/compact/start */
  async onTurnSettled(): Promise<void> {
    const client = this.client
    if (!client?.alive || !this.threadId || this.compacting) return
    const stats = this.getContextStats()
    const threshold = this.config.compactThreshold ?? 0.7
    if (!stats?.percent || stats.percent < threshold) return
    if (Date.now() - this.lastCompactAt < 5 * 60_000) return
    this.compacting = true
    this.lastCompactAt = Date.now()
    try {
      await client.request('thread/compact/start', { threadId: this.threadId }, 30_000)
      log.info(`[CodexAgent:${this.selfAgentId}] 上下文压缩已触发(percent=${(stats.percent * 100).toFixed(0)}%)`)
    }
    catch (err) {
      log.warn(`[CodexAgent:${this.selfAgentId}] compact 发起失败(放行):`, err instanceof Error ? err.message : err)
    }
    finally {
      this.compacting = false
    }
  }

  protected async* workerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const taskId = request.taskId ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (!taskId) return
    this.toolState.currentTaskId = taskId
    try {
      await this.ensureClient(ctx)
      const taskText = request.message.parts.map((p) => {
        if ('text' in p) return p.text
        if ('data' in p) return JSON.stringify(p.data)
        if ('url' in p) return p.url
        if ('raw' in p) return p.raw
        return ''
      }).join('\n')
      const prompt = workerPrompt({
        agentName: this.agentName,
        channelId: this.channelId,
        taskId,
        taskText,
        memory: request.memory,
        ctxPrefix: await this.contextPrefix(),
        manual: systemManual(),
      })
      yield* this.streamTurn(prompt, taskId, this.config.promptTimeoutMs ?? CODEX_TURN_STALL_MS, ctx.signal)
    }
    finally {
      this.toolState.currentTaskId = null
    }
  }

  protected async* peerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    await this.ensureClient(ctx)
    const msg = request.message
    const fromId = request.fromAgentId
      ?? (typeof msg.metadata?.['x-aw-from-label'] === 'string' ? msg.metadata['x-aw-from-label'] : undefined)
      ?? 'unknown'
    const requireReply = msg.metadata?.['x-aw-require-reply'] === 'true'
    const crossChannel = msg.metadata?.['x-aw-cross-channel'] === 'true'
    this.toolState.replyContext = requireReply && request.fromAgentId && !crossChannel
      ? { fromId: request.fromAgentId, messageId: msg.messageId }
      : null
    const msgText = msg.parts.map((p) => {
      if ('text' in p) return p.text
      if ('data' in p) return JSON.stringify(p.data)
      if ('url' in p) return p.url
      if ('raw' in p) return p.raw
      return ''
    }).join('\n')
    const prompt = peerPrompt({
      agentName: this.agentName,
      role: this.agentRole,
      channelId: this.channelId,
      ctxPrefix: await this.contextPrefix(),
      manual: systemManual(),
      memory: request.memory,
      fromId,
      messageId: msg.messageId,
      requireReply,
      isReply: typeof msg.metadata?.['x-aw-in-reply-to'] === 'string',
      crossChannel,
      fromChannel: typeof msg.metadata?.['x-aw-from-channel'] === 'string' ? String(msg.metadata['x-aw-from-channel']) : '',
      msgText,
    })
    yield* this.streamTurn(prompt, undefined, this.config.promptTimeoutMs ?? CODEX_TURN_STALL_MS, ctx.signal)
  }

  // ===== 回合执行 =====

  /**
   * 流式回合:turn/start → 逐事件产出(delta/status)→ turn/completed 收口。
   * artifact 在 done 前注入(item/completed agentMessage 聚合文本)。
   */
  protected async* streamTurn(prompt: string, taskId: string | undefined, timeoutMs: number, signal?: AbortSignal): AsyncGenerator<AgentEvent, void, unknown> {
    const client = this.client
    if (!client || !this.threadId) {
      yield { kind: 'error', error: { code: 'CODEX_NOT_READY', message: 'codex 会话未就绪' } }
      return
    }
    const queue: AgentEvent[] = []
    let isDone = false
    let resolveWait: (() => void) | null = null
    let lastActivity = Date.now()
    let agentText = ''
    this.turnActive = true
    this.turnId = null

    const enqueue = (e: AgentEvent): void => {
      if (e.kind === 'done' && !isDone) {
        if (agentText.trim()) {
          queue.push({
            kind: 'artifact',
            artifact: { artifactId: randomUUID(), name: 'output', parts: [{ text: agentText.trim() }] },
            lastChunk: true,
            totalChunks: 1,
          })
        }
        this.turnActive = false
      }
      if (e.kind === 'done' || e.kind === 'error') {
        isDone = true
        this.turnActive = false
        flushDelta()
      }
      queue.push(e)
      lastActivity = Date.now()
      resolveWait?.()
      resolveWait = null
    }

    const flushDelta = (): void => {
      if (this.deltaTimer) {
        clearTimeout(this.deltaTimer)
        this.deltaTimer = null
      }
      if (!this.deltaBuf) return
      const text = this.deltaBuf
      this.deltaBuf = ''
      queue.push({ kind: 'delta', delta: { text } })
    }
    const pushDelta = (text: string): void => {
      this.deltaBuf += text
      this.deltaTimer ??= setTimeout(() => {
        this.deltaTimer = null
        flushDelta()
      }, 50)
    }

    // 通知订阅(审批请求处理器已在 startClient 挂接,此处只处理回合通知)
    const unsub = client.onNotification((method, params) => {
      const p = (params ?? {}) as Record<string, unknown>
      lastActivity = Date.now()
      if (method === 'item/agentMessage/delta') {
        const delta = typeof p.delta === 'string' ? p.delta : ''
        if (delta) {
          this.turnActive = true
          pushDelta(delta)
        }
        return
      }
      if (method === 'turn/started') {
        const turn = p.turn as Record<string, unknown> | undefined
        this.turnId = typeof turn?.id === 'string' ? turn.id : this.turnId
        this.turnActive = true
        enqueue({ kind: 'status', status: { state: 'WORKING', timestamp: new Date().toISOString() } })
        return
      }
      if (method === 'item/started') {
        const item = p.item as Record<string, unknown> | undefined
        const t = String(item?.type ?? '')
        if (['commandExecution', 'mcpToolCall', 'fileChange', 'dynamicToolCall', 'webSearch', 'collabToolCall'].includes(t)) {
          const label = t === 'commandExecution'
            ? String(item?.command ?? 'command')
            : String(item?.tool ?? item?.title ?? t)
          enqueue({
            kind: 'status',
            status: {
              state: 'WORKING',
              message: {
                messageId: randomUUID(),
                contextId: this.channelId,
                role: 'ROLE_AGENT',
                parts: [{ text: `🔧 ${label}${toolArgsPreview(item?.input ?? item?.arguments ?? item?.command)}` }],
              },
              timestamp: new Date().toISOString(),
            },
          })
        }
        if (t === 'contextCompaction') this.compacting = true
        return
      }
      if (method === 'item/completed') {
        const item = p.item as Record<string, unknown> | undefined
        if (String(item?.type ?? '') === 'agentMessage' && typeof item?.text === 'string') {
          agentText += item.text
        }
        if (String(item?.type ?? '') === 'contextCompaction') this.compacting = false
        return
      }
      if (method === 'thread/tokenUsage/updated') {
        const usage = (p.usage ?? p.tokenUsage ?? p) as Record<string, unknown>
        const input = Number(usage.input_tokens ?? usage.inputTokens ?? usage.total_tokens ?? usage.totalTokens)
        if (Number.isFinite(input) && input > 0) this.lastUsage = { input, at: Date.now() }
        return
      }
      if (method === 'turn/completed') {
        const turn = (p.turn ?? {}) as Record<string, unknown>
        const status = String(turn.status ?? 'completed')
        if (status === 'failed') {
          const err = (turn.error ?? {}) as Record<string, unknown>
          const info = String(err.codexErrorInfo ?? '')
          enqueue({
            kind: 'error',
            error: {
              code: info ? `CODEX_${info}` : 'CODEX_LLM_ERROR',
              message: String(err.message ?? 'codex 回合失败'),
            },
          })
        }
        else {
          // completed / interrupted:中断按 done 收口(消息按已处理落账)
          enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
        }
        return
      }
      if (method === 'error') {
        enqueue({
          kind: 'error',
          error: { code: 'CODEX_ERROR', message: String(p.message ?? p.error ?? JSON.stringify(params).slice(0, 300)) },
        })
      }
    })

    // abort 传导
    const onAbort = (): void => {
      log.warn(`[CodexAgent:${this.selfAgentId}] run 被 abort → turn/interrupt,taskId=${taskId ?? '-'}`)
      void client.request('turn/interrupt', { threadId: this.threadId, ...(this.turnId ? { turnId: this.turnId } : {}) }, 15_000).catch(() => {})
      setTimeout(() => {
        if (!isDone) enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
      }, 5000)
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    // 投递 turn
    try {
      await client.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text: prompt }],
      }, 60_000)
    }
    catch (err) {
      unsub()
      signal?.removeEventListener('abort', onAbort)
      this.turnActive = false
      yield {
        kind: 'error',
        error: {
          code: 'CODEX_PROMPT_FAILED',
          message: `codex turn/start 失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
      return
    }

    try {
      while (!isDone || queue.length > 0) {
        if (queue.length === 0 && !isDone) {
          const remaining = timeoutMs - (Date.now() - lastActivity)
          if (remaining <= 0) {
            void client.request('turn/interrupt', { threadId: this.threadId }, 15_000).catch(() => {})
            enqueue({
              kind: 'error',
              error: { code: 'CODEX_TURN_STALLED', message: `回合停滞 ${Math.round(timeoutMs / 1000)}s 无事件,已中止` },
            })
            continue
          }
          await new Promise<void>((r) => {
            resolveWait = r
            setTimeout(() => {
              resolveWait = null
              r()
            }, remaining + 100)
          })
        }
        while (queue.length > 0) {
          yield queue.shift()!
        }
      }
    }
    finally {
      flushDelta()
      unsub()
      signal?.removeEventListener('abort', onAbort)
      this.turnActive = false
      this.turnId = null
    }
  }
}

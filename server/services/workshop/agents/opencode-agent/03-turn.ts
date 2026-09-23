/**
 * OpenCodeAgentImplLayer03 —— 回合执行(prompt → SSE → AgentEvent)
 * (分层 4/6,承 OpenCodeAgentImplLayer02;方法体与原文件逐行一致)
 */
import { OpenCodeAgentImplLayer02 } from './02-engine-agnostic'
import type { AgentEvent } from '../agent-interface'
import { log } from './helpers'
import { randomUUID } from 'node:crypto'
import { toolArgsPreview } from '../prompt-builder'

export abstract class OpenCodeAgentImplLayer03 extends OpenCodeAgentImplLayer02 {
  protected runTurn(
    prompt: string,
    taskId: string | undefined,
    opts: { timeoutMs: number, signal?: AbortSignal, beforeStart?: () => void, onDone?: () => void },
  ): AsyncGenerator<AgentEvent, void, unknown> {
    return this._runTurn(prompt, taskId, opts)
  }

  protected async* _runTurn(
    prompt: string,
    taskId: string | undefined,
    opts: { timeoutMs: number, signal?: AbortSignal, beforeStart?: () => void, onDone?: () => void },
  ): AsyncGenerator<AgentEvent, void, unknown> {
    if (!this.sessionId) {
      yield { kind: 'error', error: { code: 'OPENCODE_NOT_READY', message: 'opencode 会话未就绪' } }
      return
    }
    opts.beforeStart?.()
    const queue: AgentEvent[] = []
    let isDone = false
    let resolveWait: (() => void) | null = null
    let lastActivity = Date.now()
    this.turnActive = true
    this.aborted = false
    this.partTexts = new Map()
    this.partOrder = []

    const enqueue = (e: AgentEvent): void => {
      // done 事件前先收口 artifact(助手正文聚合),保证事件序 artifact → done
      if (e.kind === 'done' && !isDone) {
        const text = this.partOrder.map(id => this.partTexts.get(id) ?? '').join('').trim()
        if (text) {
          queue.push({
            kind: 'artifact',
            artifact: { artifactId: randomUUID(), name: 'output', parts: [{ text }] },
            lastChunk: true,
            totalChunks: 1,
          })
        }
        this.turnActive = false
        opts.onDone?.()
      }
      if (e.kind === 'done' || e.kind === 'error') {
        isDone = true
        this.turnActive = false
      }
      queue.push(e)
      lastActivity = Date.now()
      resolveWait?.()
      resolveWait = null
    }

    // 事件订阅(SSE → 队列)
    const unsub = this.onEngineEvent((ev) => {
      for (const mapped of this.mapEngineEvent(ev, taskId)) enqueue(mapped)
    })

    // 停滞看门狗
    let stallTimer: ReturnType<typeof setTimeout> | null = null

    const finishTurn = (): void => {
      if (isDone) return
      const text = this.partOrder.map(id => this.partTexts.get(id) ?? '').join('').trim()
      if (text) {
        enqueue({
          kind: 'artifact',
          artifact: { artifactId: randomUUID(), name: 'output', parts: [{ text }] },
          lastChunk: true,
          totalChunks: 1,
        })
      }
      enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
      this.turnActive = false
      opts.onDone?.()
    }

    const onAbort = (): void => {
      log.warn(`[OpenCodeAgent:${this.selfAgentId}] run 被 abort → POST abort,taskId=${taskId ?? '-'}`)
      this.aborted = true
      void this.api('POST', `/session/${this.sessionId}/abort`, {}).catch(() => {})
      // 引擎将回 session.idle → finishTurn;兜底 5s 后强制收口
      setTimeout(() => finishTurn(), 5000)
    }
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

    // 投递 prompt
    try {
      await this.promptAsync(prompt)
      enqueue({ kind: 'status', status: { state: 'WORKING', timestamp: new Date().toISOString() } })
    }
    catch (err) {
      unsub()
      opts.signal?.removeEventListener('abort', onAbort)
      this.turnActive = false
      yield {
        kind: 'error',
        error: {
          code: 'OPENCODE_PROMPT_FAILED',
          message: `opencode prompt 失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
      return
    }

    try {
      while (!isDone || queue.length > 0) {
        if (queue.length === 0 && !isDone) {
          const remaining = opts.timeoutMs - (Date.now() - lastActivity)
          if (remaining <= 0) {
            this.aborted = true
            void this.api('POST', `/session/${this.sessionId}/abort`, {}).catch(() => {})
            enqueue({
              kind: 'error',
              error: {
                code: 'OPENCODE_TURN_STALLED',
                message: `回合停滞 ${Math.round(opts.timeoutMs / 1000)}s 无事件,已中止(消息按已处理落账)`,
              },
            })
            this.turnActive = false
            continue
          }
          await new Promise<void>((r) => {
            resolveWait = r
            stallTimer = setTimeout(() => {
              resolveWait = null
              r()
            }, remaining + 100)
          })
          if (stallTimer) {
            clearTimeout(stallTimer)
            stallTimer = null
          }
        }
        while (queue.length > 0) {
          yield queue.shift()!
        }
      }
    }
    finally {
      if (stallTimer) clearTimeout(stallTimer)
      unsub()
      opts.signal?.removeEventListener('abort', onAbort)
      this.turnActive = false
    }
  }

  /** 引擎事件 → AgentEvent(适配器核心) */
  protected mapEngineEvent(ev: Record<string, unknown>, taskId: string | undefined): AgentEvent[] {
    const type = String(ev.type ?? '')
    const props = (ev.properties ?? {}) as Record<string, unknown>
    const sid = props.sessionID ?? props.sessionId
    if (sid && sid !== this.sessionId) return [] // 多会话实例隔离(本 impl 一会话,防御)

    const now = new Date().toISOString()
    const statusEvent = (text: string): AgentEvent => ({
      kind: 'status',
      status: {
        state: 'WORKING',
        message: { messageId: randomUUID(), contextId: this.channelId, role: 'ROLE_AGENT', parts: [{ text }] },
        timestamp: now,
      },
    })

    switch (type) {
      case 'message.part.delta': {
        if (props.field === 'text' && typeof props.delta === 'string' && props.delta) {
          return [{ kind: 'delta', delta: { text: props.delta } }]
        }
        return []
      }
      case 'message.part.updated': {
        const part = props.part as Record<string, unknown> | undefined
        if (!part) return []
        const partId = String(part.id ?? '')
        const partType = String(part.type ?? '')
        if (partType === 'text' && typeof part.text === 'string' && partId) {
          if (!this.partOrder.includes(partId)) this.partOrder.push(partId)
          this.partTexts.set(partId, part.text)
        }
        else if (partType === 'tool') {
          const state = (part.state ?? {}) as Record<string, unknown>
          const tool = String(part.tool ?? 'tool')
          const statusStr = String(state.status ?? '')
          if (statusStr === 'pending' || statusStr === 'running') {
            const input = state.input ?? part.input
            return [statusEvent(`🔧 ${tool}${toolArgsPreview(input)}`)]
          }
          if (statusStr === 'error') {
            return [statusEvent(`🔧 ${tool} 失败: ${String(state.error ?? '未知错误').slice(0, 200)}`)]
          }
        }
        else if (partType === 'compaction') {
          this.lastCompactAt = Date.now()
        }
        return []
      }
      case 'message.updated': {
        const info = props.info as Record<string, unknown> | undefined
        if (info?.role === 'assistant') {
          const tokens = info.tokens as Record<string, unknown> | undefined
          const input = Number(tokens?.input)
          if (Number.isFinite(input) && input > 0) this.lastUsage = { input, at: Date.now() }
          const err = info.error as Record<string, unknown> | undefined
          if (err && this.turnActive) {
            const code = String(err.name ?? 'UnknownError')
            return [{
              kind: 'error',
              error: { code: `OPENCODE_LLM_${code}`, message: String(err.message ?? 'opencode 回合错误') },
            }]
          }
        }
        return []
      }
      case 'session.error': {
        const err = props.error as Record<string, unknown> | undefined
        if (!this.turnActive) return []
        const data = (err?.data ?? {}) as Record<string, unknown>
        const detail = String(data.message ?? err?.message ?? 'opencode 会话错误')
        return [{
          kind: 'error',
          error: {
            code: `OPENCODE_ERROR_${String(err?.name ?? 'UNKNOWN')}`,
            message: `${detail}${data.statusCode != null ? ` (HTTP ${data.statusCode})` : ''}`,
          },
        }]
      }
      case 'session.status': {
        const status = props.status as Record<string, unknown> | undefined
        if (String(status?.type ?? '') === 'idle' && this.turnActive) {
          return [{ kind: 'done', final: taskId ? { taskId } : undefined }]
        }
        return []
      }
      case 'session.idle': {
        if (this.turnActive) {
          return [{ kind: 'done', final: taskId ? { taskId } : undefined }]
        }
        return []
      }
      // ===== HITL =====
      case 'permission.asked':
      case 'permission.v2.asked': {
        this.registerPermissionHitl(type === 'permission.v2.asked', props)
        return []
      }
      case 'question.asked': {
        this.registerQuestionHitl(props)
        return []
      }
      case 'permission.replied':
      case 'permission.v2.replied':
      case 'question.replied':
      case 'question.rejected': {
        const id = String(props.id ?? '')
        if (id && this.pendingHitl.has(id)) {
          const p = this.pendingHitl.get(id)!
          if (p.timer) clearTimeout(p.timer)
          this.pendingHitl.delete(id)
        }
        return []
      }
      default:
        return []
    }
  }
}

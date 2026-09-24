/**
 * OpenCodeAgentImplLayer02 —— 引擎无关面(状态/上下文/steer/回合结算)
 * (分层 3/6,承 OpenCodeAgentImplLayer01;方法体与原文件逐行一致)
 */
import { OpenCodeAgentImplLayer01 } from './01-lifecycle'
import type { AgentContextStats } from '../../types/task'
import type { AgentEvent, AgentRunContext, AgentRunRequest, SupervisionDecision, SupervisionSnapshot } from '../agent-interface'
import { decodeHitlAnswers, getHitlRegistry } from '../hitl-registry'
import { extractJsonArray, peerPrompt, supervisePrompt, systemManual, workerPrompt } from '../prompt-builder'
import { log } from './helpers'

export abstract class OpenCodeAgentImplLayer02 extends OpenCodeAgentImplLayer01 {
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

  /**
   * 实时注入:回合运行中再投一条 prompt(opencode 引擎 admit 为 steer/queue,
   * 内容必然到达模型)→ 'steer';空闲 → 'deferred'(消费循环起回合处理)。
   */
  async steer(text: string): Promise<'steer' | 'deferred'> {
    if (!this.sessionId || !this.turnActive) return 'deferred'
    try {
      await this.promptAsync(text)
      return 'steer'
    }
    catch (err) {
      log.warn(`[OpenCodeAgent:${this.selfAgentId}] steer 投递失败(消息保持 pending):`, err instanceof Error ? err.message : err)
      return 'deferred'
    }
  }

  /**
   * HITL 应答(codex/opencode/dsh 统一入口;本 impl 处理 opencode-permission)。
   *
   * 原生协议:
   *  - permission.asked → `POST /session/:id/permissions/:permissionId {response: once|always|reject}`
   *  - question.asked   → 每个问题一条 `POST /question/:questionId/reply {answer}`;
   *                       取消 → `POST /question/:questionId/reject {}`
   *
   * 修复要点(§13.5):
   *  - 旧映射 `response === 'always' || 'once' ? response : 'once'` 会把显式 **reject 降级为 once**
   *    (静默放行),现已按白名单原样透传,未知枚举直接抛错;
   *  - 旧实现只答第一题,现按 questions 全量逐题应答(fallback:用请求集 id);
   *  - cancelled 优先于一切:取消绝不等价于同意。
   */
  override async respondHitl(kind: string, id: string, outcome: {
    confirmed?: boolean
    cancelled?: boolean
    value?: string
    response?: string
    comment?: string
  }): Promise<void> {
    if (kind !== 'opencode-permission') return
    const pending = this.pendingHitl.get(id)
    if (!pending) throw new Error(`待办不存在或已处理: ${id}`)
    const response = typeof outcome.response === 'string' && outcome.response !== '' ? outcome.response : undefined
    if (response && response !== 'once' && response !== 'always' && response !== 'reject') {
      // 未知枚举不得回落为 once(allow);在传导层再兜一道,防决策服务被绕过
      throw new Error(`未知 permission 应答枚举「${response}」:仅允许 once|always|reject`)
    }
    // fail-closed 双分支:
    //  - permission:只有显式 confirmed=true / once / always 才放行;其余(含字段缺失)一律 reject
    //    (与旧实现差别仅在"显式 reject 不再被降级为 once");
    //  - question:答案是**内容**,但空答案同样不得当成有效回答 → 走 reject(取消语义)。
    const explicitCancel = outcome.cancelled === true || response === 'reject'
    const allow = outcome.confirmed === true || response === 'once' || response === 'always'
    const cancelled = pending.type === 'permission'
      ? explicitCancel || !allow
      : explicitCancel || (outcome.value ?? outcome.comment ?? '').trim() === ''
    if (pending.type === 'permission') {
      // 显式 reject 原样透传;未给 response 时按 confirmed 布尔(缺省拒绝,fail-closed)
      const native = cancelled ? 'reject' : (response === 'always' ? 'always' : 'once')
      await this.api('POST', `/session/${pending.sessionId}/permissions/${encodeURIComponent(id)}`, { response: native })
    }
    else {
      const questions = pending.questions
      if (cancelled) {
        // 取消:每个问题各发一次 reject(引擎按问题 id 收敛整组提问)
        if (questions.length === 0) {
          await this.api('POST', `/question/${encodeURIComponent(id)}/reject`, {})
        }
        else {
          for (const q of questions) {
            await this.api('POST', `/question/${encodeURIComponent(q.id || id)}/reject`, {})
          }
        }
      }
      else {
        // 逐题应答:信封解出结构化答案,按问题 id 对齐(缺省回落裸文本)
        const answers = decodeHitlAnswers(outcome.value)
        const fallback = outcome.value ?? outcome.comment ?? ''
        if (questions.length === 0) {
          await this.api('POST', `/question/${encodeURIComponent(id)}/reply`, { answer: fallback })
        }
        else {
          for (const q of questions) {
            const answer = answers?.find(a => a.id === q.id)?.answer
              ?? (questions.length === 1 ? fallback : '')
            await this.api('POST', `/question/${encodeURIComponent(q.id || id)}/reply`, { answer })
          }
        }
      }
    }
    // 原为 clearTimeout(p.timer):p 在本作用域不存在(ReferenceError,且仅当计时器非空时触发),
    // 该待办条目在此处就是 pending(与 dsh/codex/hermes 的同名分支写法一致)。
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingHitl.delete(id)
    getHitlRegistry().resolve(kind, id, cancelled ? 'cancelled' : 'answered')
  }

  /** 上下文治理(post-settle 钩子):越阈值 → summarize;异常不抛出 */
  async onTurnSettled(): Promise<void> {
    if (this.compacting || !this.sessionId) return
    const stats = this.getContextStats()
    const threshold = this.config.compactThreshold ?? 0.7
    if (!stats?.percent || stats.percent < threshold) return
    if (Date.now() - this.lastCompactAt < 5 * 60_000) return
    this.compacting = true
    this.lastCompactAt = Date.now()
    try {
      await this.api('POST', `/session/${this.sessionId}/summarize`, {})
      log.info(`[OpenCodeAgent:${this.selfAgentId}] 上下文压缩已触发(percent=${(stats.percent * 100).toFixed(0)}%)`)
    }
    catch (err) {
      log.warn(`[OpenCodeAgent:${this.selfAgentId}] summarize 失败(放行):`, err instanceof Error ? err.message : err)
    }
    finally {
      this.compacting = false
    }
  }

  // supervising 由 BaseAgentImpl 持有(protected):同名私有声明会与基类形成"两个私有声明"(TS2415)。

  override async supervise(snapshot: SupervisionSnapshot, ctx: AgentRunContext, opts?: import('../agent-interface').SupervisionOptions): Promise<SupervisionDecision[]> {
    // 引擎/会话不可用 → 本轮监督降级为空(调度器回退规则引擎);绝不让引擎故障
    // 以 unhandledRejection 形态逃逸(dev-stability-guard 会据此杀掉整个服务端)
    try {
      await this.ensureServer(ctx)
    }
    catch (err) {
      log.warn(`[OpenCodeAgent:${this.selfAgentId}] supervise 引擎不可用,跳过本轮:`, err instanceof Error ? err.message : err)
      return []
    }
    if (!this.sessionId) return []
    if (this.supervising) return []
    const prompt = supervisePrompt({
      snapshot,
      agentName: this.agentName,
      channelId: this.channelId,
      ctxPrefix: await this.contextPrefix(),
      manual: systemManual(),
      memory: ctx.memory,
    })
    const timeoutMs = this.getSupervisionPolicy().hardTimeoutMs
    // runTurn 是 async generator(返回 AsyncGenerator,不是 Promise),必须以异步迭代消费完整个回合。
    // (原实现写 .then(...)/.catch(...):运行时是 "then is not a function" 的 TypeError,supervise 整条路径实际不可用。)
    try {
      const events: AgentEvent[] = []
      for await (const e of this.runTurn(prompt, undefined, {
        timeoutMs,
        signal: opts?.signal,
        onDone: async () => {
          this.supervising = false
        },
        beforeStart: () => {
          this.supervising = true
        },
      })) {
        events.push(e)
      }
      // 从事件流提取最终文本 → JSON 决策兜底(工具直执行路径返回空)
      let text = ''
      for (const e of events) {
        if (e.kind === 'artifact') {
          text += e.artifact.parts.map(p => 'text' in p ? p.text : '').join('')
        }
      }
      const parsed = extractJsonArray(text)
      return parsed && parsed.length > 0 ? parsed as SupervisionDecision[] : []
    }
    catch {
      this.supervising = false
      return []
    }
  }

  /** supervise 用:收齐整个回合的事件(基类抽象成员;本类 supervise 自行消费并需 beforeStart/onDone 钩子) */
  protected async collectTurnEvents(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    for await (const e of this.runTurn(prompt, undefined, { timeoutMs, signal })) {
      events.push(e)
      if (e.kind === 'error') break
    }
    return events
  }

  protected async* workerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const taskId = request.taskId ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (!taskId) return
    this.toolState.currentTaskId = taskId
    try {
      await this.ensureServer(ctx)
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
      yield* this.runTurn(prompt, taskId, {
        timeoutMs: this.config.promptTimeoutMs ?? 600_000,
        signal: ctx.signal,
      })
    }
    finally {
      this.toolState.currentTaskId = null
    }
  }

  protected async* peerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    await this.ensureServer(ctx)
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
    yield* this.runTurn(prompt, undefined, { timeoutMs: this.config.promptTimeoutMs ?? 600_000, signal: ctx.signal })
  }

  // ===== 回合执行(prompt → SSE 事件 → AgentEvent)=====
}

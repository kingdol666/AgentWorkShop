/**
 * OmpRpcAgentImplLayer03 —— 工具桥、prompt 组合与 steer()(含其内部分节的 452 行方法体)
 * (分层 4/6,承 OmpRpcAgentImplLayer02;方法体与原文件逐行一致)
 */
import { OmpRpcAgentImplLayer02 } from './02-lifecycle'
import type { AgentEvent, AgentRunContext, AgentRunRequest, SupervisionDecision, SupervisionSnapshot } from '../agent-interface'
import type { HostToolCallRequest } from '../adapters/omp-rpc-client'
import { extractJsonArray, parseSteerBanner, peerPrompt, supervisePrompt, systemManual, workerPrompt } from '../prompt-builder'
import { log } from './helpers'

export abstract class OmpRpcAgentImplLayer03 extends OmpRpcAgentImplLayer02 {
  /** 引擎无关工具面:REST/MCP 桥直调与 omp 内部 host_tool_call 共用同一实现 */
  protected async handleHostTool(req: HostToolCallRequest): Promise<{ text: string, isError?: boolean }> {
    return this.dispatchHostTool(req.toolName, req.arguments ?? {})
  }

  // ===== prompt 组合 =====

  /** 前置上下文(场景 × 身份 × 工业简报 × 名册;共享 prompt-builder) */
  protected systemManual(): string {
    return systemManual()
  }

  /**
   * 实时消息注入(送达模式协议):
   *  - 回合 streaming 中 → 立即 steer,返回 'steer'(同轮可见,唯一可标记消费的路径)
   *  - 回合活跃但尚未 streaming(prompt 排队窗口,上限 20s)→ 等 streaming 开始后 steer
   *  - 回合被 host 工具阻塞(如 poll_messages 等待)/空闲/发送失败 → 返回 'deferred':
   *    消息保持 pending,poll_messages 的 Mailbox 到信回调即时取走(毫秒级),或本回合
   *    结束后由消费循环按 FIFO 起回合处理。
   */
  async steer(text: string): Promise<'steer' | 'deferred'> {
    // 从确定性触发横幅提取回执上下文(AgentRuntime.injectSteer 生成,格式固定):
    // "[实时消息 from <id>]: ..." + "[系统触发器] 本消息要求回复(reply_to=<messageId>)。"
    const banner = parseSteerBanner(text)
    if (banner) {
      this.toolState.replyContext = banner
    }
    const client = this.client
    if (!client) return 'deferred'
    try {
      if (this.streaming) {
        await client.send({ type: 'steer', message: text })
        return 'steer'
      }
      if (this.turnActive) {
        // prompt 排队窗口:等 streaming 开始(上限 20s);工具阻塞的回合等不到 → deferred
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline && this.turnActive && !this.streaming) {
          const { promise, resolve } = Promise.withResolvers()
          setTimeout(resolve, 150)
          await promise
        }
        if (this.streaming && this.turnActive) {
          await client.send({ type: 'steer', message: text })
          return 'steer'
        }
        return 'deferred'
      }
      // 空闲/回合已结束:deferred(消息 pending,消费循环 dequeue 即起回合)
      return 'deferred'
    }
    catch (err) {
      log.error(`[OmpRpcAgent:${this.selfAgentId}] steer 注入失败(消息保持 pending):`, err instanceof Error ? err.message : err)
      return 'deferred'
    }
  }

  // ===== supervise() =====

  /**
   * supervise 单飞守卫:同一 client 不并发 LLM 回合(残留回合与下一 prompt 混流的根因)。
   * 守卫位由 BaseAgentImpl 的 protected supervising 承载 —— 本类原先的私有重复声明与基类构成
   * "两个私有声明"(TS2415),而 JS 只有一个实例字段,故删除后语义与运行时完全一致。
   */

  override async supervise(snapshot: SupervisionSnapshot, ctx: AgentRunContext, opts?: { signal?: AbortSignal }): Promise<SupervisionDecision[]> {
    await this.ensureClient(ctx)
    if (!this.client) return []
    if (this.supervising) return [] // 上一轮 supervise 未收口:跳过本拍(节流即正确)

    // 上下文门控(≥70% 先压缩再调度;回合间隙发起,失败放行)
    await this.contextGate('supervise')

    const prompt = supervisePrompt({
      snapshot,
      agentName: this.agentName,
      channelId: this.channelId,
      ctxPrefix: await this.contextPrefix(),
      manual: this.systemManual(),
      memory: ctx.memory,
    })
    // 150s 上界:supervise 持 lead.execLock 期间信箱消费停顿(更久会拖垮 worker 回执处理);
    // supervise 是一次真实 LLM 回合:omp 冷启动(插件/MCP 加载 30~90s)+ 慢 provider
    // 单步可能 >60s,过紧会把正常回合掐成 "Interrupted by user"。默认 150s,
    // 仅拦真僵死(更紧的预算由调用方 config.superviseTimeoutMs 显式传入);真 abort 已实现。
    const timeoutMs = this.config.superviseTimeoutMs ?? 150_000

    return new Promise<SupervisionDecision[]>((resolve) => {
      let assistantText = ''
      let resolved = false

      const finish = (decisions: SupervisionDecision[]) => {
        if (resolved) return
        resolved = true
        this.supervising = false
        unsub()
        clearTimeout(timer)
        signalUnsub?.()
        resolve(decisions)
      }

      const abortTurn = (): void => {
        // 超时/外部取消:真正中止 omp 当前回合 —— 只 resolve 不 abort 会让残留回合
        // 与下一个 prompt 在同一 client 混流(决策错位 + token 空烧)
        log.warn(`[OmpRpcAgent:${this.selfAgentId}] supervise 超时(${timeoutMs}ms)→ abort 当前调度回合`)
        void this.client?.send({ type: 'abort' }).catch(() => {})
        finish([])
      }

      const unsub = this.client!.onEvent((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          assistantText += event.assistantMessageEvent.delta ?? ''
        }
        if (event.type === 'agent_end' && event.isTerminal !== false) {
          // 尝试从文本解析 JSON 决策(备用:如果 agent 没用 host tools 而是输出 JSON)
          const parsed = extractJsonArray(assistantText)
          if (parsed && parsed.length > 0) {
            finish(parsed as SupervisionDecision[])
          }
          else {
            // agent 可能已通过 host tools 直接执行了调度,返回空(已执行)
            finish([])
          }
        }
        if (event.type === '__process_exit__' || event.type === '__error__') {
          finish([])
        }
      })

      const timer = setTimeout(abortTurn, timeoutMs)

      // 外部取消(调度器 cancel 路径)传导:abort 当前 LLM 回合并立即收口
      let signalUnsub: (() => void) | undefined
      if (opts?.signal) {
        if (opts.signal.aborted) {
          unsub()
          resolve([])
          return
        }
        const onAbort = (): void => abortTurn()
        opts.signal.addEventListener('abort', onAbort, { once: true })
        signalUnsub = () => opts.signal?.removeEventListener('abort', onAbort)
      }

      this.supervising = true
      this.client!.send({ type: 'prompt', message: prompt }).catch(() => finish([]))
    })
  }

  // ===== 内部:worker 执行 =====

  protected async* workerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const taskId = request.taskId
      ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (!taskId) return

    this.toolState.currentTaskId = taskId

    try {
      await this.ensureClient(ctx)
    }
    catch (err) {
      yield {
        kind: 'error',
        error: {
          code: 'OMP_SPAWN_FAILED',
          message: `omp 子进程启动失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
      return
    }

    if (!this.client) {
      yield { kind: 'error', error: { code: 'OMP_NOT_READY', message: 'omp 客户端未就绪' } }
      return
    }

    // 构建 prompt
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
      manual: this.systemManual(),
    })

    // 流式执行 + 事件映射
    yield* this.promptAndStream(prompt, taskId, ctx.signal)
  }

  /**
   * 点对点消息处理(实时通信驱动;lead 与 worker 通用)。
   * 触发器语义:metadata['x-aw-require-reply']='true' → 必须经 send_message_to_agent
   * 回给发送者:执行结果 + 对方所需内容,in_reply_to 关联原消息,并声明是否需再响应。
   */
  protected async* peerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    try {
      await this.ensureClient(ctx)
    }
    catch (err) {
      // spawn 失败必须显式报错:静默 return 会让 sawRunError=false → 消息被
      // 直接 markConsumed,实时消息一次性丢失且无任何重试;产出 error 事件
      // 走消息 requeue(≤2 次),与 workerRun 同口径
      yield {
        kind: 'error',
        error: {
          code: 'OMP_SPAWN_FAILED',
          message: `omp 子进程启动失败(peer 消息未消费,将重试): ${err instanceof Error ? err.message : String(err)}`,
        },
      }
      return
    }
    if (!this.client) {
      yield { kind: 'error', error: { code: 'OMP_NOT_READY', message: 'omp 客户端未就绪(peer 消息未消费,将重试)' } }
      return
    }

    const msg = request.message
    // 显示名:agent 同事用 id(名册可解析);人类发送者用 fromLabel;兜底 unknown
    const fromId = request.fromAgentId
      ?? (typeof msg.metadata?.['x-aw-from-label'] === 'string' ? msg.metadata['x-aw-from-label'] : undefined)
      ?? 'unknown'
    const msgText = msg.parts.map((p) => {
      if ('text' in p) return p.text
      if ('data' in p) return JSON.stringify(p.data)
      if ('url' in p) return p.url
      if ('raw' in p) return p.raw
      return ''
    }).join('\n')
    const requireReply = msg.metadata?.['x-aw-require-reply'] === 'true'
    const isReply = typeof msg.metadata?.['x-aw-in-reply-to'] === 'string'
    // 跨 Channel 来信:发送方是其他 channel 的 lead,回执必须走 send_cross_channel_message
    const crossChannel = msg.metadata?.['x-aw-cross-channel'] === 'true'
    const fromChannel = typeof msg.metadata?.['x-aw-from-channel'] === 'string'
      ? String(msg.metadata['x-aw-from-channel'])
      : ''
    // 回执自动关联仅对真实 agent 发送者生效(人类无 agentId 可回投;
    // 对人类的回复经事件流/时间线可见)
    this.toolState.replyContext = requireReply && request.fromAgentId && !crossChannel
      ? { fromId: request.fromAgentId, messageId: msg.messageId }
      : null

    const prompt = peerPrompt({
      agentName: this.agentName,
      role: this.agentRole,
      channelId: this.channelId,
      ctxPrefix: await this.contextPrefix(),
      manual: this.systemManual(),
      memory: request.memory,
      fromId,
      messageId: msg.messageId,
      requireReply,
      isReply,
      crossChannel,
      fromChannel,
      msgText,
    })

    yield* this.promptAndStream(prompt, undefined, ctx.signal)
  }

  // ===== 内部:prompt 发送 + 事件流桥接 =====

  protected async* promptAndStream(
    prompt: string,
    taskId: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const client = this.client
    if (!client) {
      throw new Error('omp 客户端未就绪')
    }
    // 上下文门控(≥70% 时在回合间隙先压缩再发 prompt;等待有界,失败放行)
    await this.contextGate('pre-prompt')
    const queue: AgentEvent[] = []
    let resolveWait: (() => void) | null = null
    let isDone = false
    // 回合生命周期:prompt 已发出 → turnActive;首条 message_update → streaming;message_end/turn_end → 结束
    this.turnActive = true
    this.streaming = false
    this.turnText = ''
    // 正文流式差额账本:contentIndex → 已流出长度。部分 provider(reasoning 模型/
    // openai-completions)的 text 块不走 text_delta(只有换行),全文在 text_end.content
    // 落定 —— 差额兜底把未流出部分补发为 delta,保证前端流式不缺正文。
    const textSent = new Map<number, number>()
    const unsubState = client.onEvent((event) => {
      if (event.type === 'message_update') {
        const ev = event.assistantMessageEvent as
          | { type?: string, delta?: string, content?: string, contentIndex?: number }
          | undefined
        if (ev?.type === 'text_delta') {
          this.streaming = true
          const text = ev.delta ?? ''
          const ci = typeof ev.contentIndex === 'number' ? ev.contentIndex : 0
          textSent.set(ci, (textSent.get(ci) ?? 0) + text.length)
          this.turnText += text
          // LLM 流式增量透出(AEP agent.delta 事件源):仅 worker/peer 转本走生成器
          if (text) enqueueDelta(text)
        }
        else if (ev?.type === 'text_end' && typeof ev.content === 'string') {
          const ci = typeof ev.contentIndex === 'number' ? ev.contentIndex : 0
          const sent = textSent.get(ci) ?? 0
          if (ev.content.length > sent) {
            const chunk = ev.content.slice(sent)
            textSent.set(ci, ev.content.length)
            this.streaming = true
            this.turnText += chunk
            enqueueDelta(chunk)
          }
        }
      }
      if (event.type === 'message_end' || event.type === 'turn_end') {
        this.streaming = false
        flushDelta()
      }
      if (event.type === 'agent_end' && event.isTerminal !== false) {
        this.turnActive = false
        this.streaming = false
        flushDelta()
      }
      if (event.type === '__process_exit__' || event.type === '__error__') {
        this.turnActive = false
        this.streaming = false
      }
    })

    const enqueue = (event: AgentEvent): void => {
      queue.push(event)
      if (event.kind === 'done' || event.kind === 'error') isDone = true
      lastActivity = Date.now()
      resolveWait?.()
      resolveWait = null
    }

    // 停滞看门狗:整轮无任何 omp 事件(挂死的 LLM 调用/子进程僵死)时中止回合,
    // 否则消息永久卡 consuming、队友消息无限堆积。host 工具内阻塞
    // (poll_messages 最长 180s)与慢 provider(实测单步可 >5min)都有
    // tool/状态事件刷新计时;默认 600s 覆盖慢回合,只拦真僵死。
    const idleTimeoutMs = this.config.promptTimeoutMs ?? 600_000
    let lastActivity = Date.now()
    let stallTimer: ReturnType<typeof setTimeout> | null = null

    // LLM 流式增量缓冲:50ms 批量合并为一帧 delta(防高频 text_delta 洪泛 WS)
    let deltaBuf = ''
    let deltaTimer: ReturnType<typeof setTimeout> | null = null
    const flushDelta = (): void => {
      if (deltaTimer) {
        clearTimeout(deltaTimer)
        deltaTimer = null
      }
      if (!deltaBuf) return
      const text = deltaBuf
      deltaBuf = ''
      enqueue({ kind: 'delta', delta: { text } })
    }
    const enqueueDelta = (text: string): void => {
      deltaBuf += text
      deltaTimer ??= setTimeout(() => {
        deltaTimer = null
        flushDelta()
      }, 50)
    }

    // 订阅 omp 事件流
    const unsub = client.onEvent((event) => {
      for (const mapped of this.mapOmpEvent(event, taskId)) {
        enqueue(mapped)
      }
    })

    // abort 传导
    const onAbort = (): void => {
      log.warn(`[OmpRpcAgent:${this.selfAgentId}] run 被 abort(signal)→ 中止 omp 回合,taskId=${taskId ?? '-'}`)
      client.send({ type: 'abort' }).catch(() => {})
      if (!isDone) {
        enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
      }
    }
    if (signal.aborted) {
      onAbort()
    }
    else {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    // 发送 prompt
    try {
      await client.send({ type: 'prompt', message: prompt })
    }
    catch (err) {
      unsub()
      signal.removeEventListener('abort', onAbort)
      // 僵死进程回收:prompt send 失败 = stdio 断裂或 60s 命令确认超时 —— 进程
      // "活着但不干活"(alive-but-wedged)。若仅报错不清理,消息重试(≤2 次)会
      // 复用同一僵死 stdio 每次空转 60s;必须杀掉并置空,下回合 ensureClient
      // 全新重生(host tools/模型/终端 tap 随重建)。
      log.warn(`[OmpRpcAgent:${this.selfAgentId}] prompt 失败 → 回收可疑僵死进程 pid=${client.pid}`)
      this.killProcess()
      this.client = null
      this.hostToolsRegistered = false
      yield {
        kind: 'error',
        error: {
          code: 'PROMPT_FAILED',
          message: `omp prompt 失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
      return
    }

    // 产出事件直到 done/error
    try {
      while (!isDone || queue.length > 0) {
        if (queue.length === 0 && !isDone) {
          const remaining = idleTimeoutMs - (Date.now() - lastActivity)
          if (remaining <= 0) {
            client.send({ type: 'abort' }).catch(() => {})
            // 子进程大概率已僵死:击杀并清引用,下回合 ensureClient 全新重生
            this.killProcess()
            this.client = null
            this.hostToolsRegistered = false
            enqueue({
              kind: 'error',
              error: {
                code: 'TURN_STALLED',
                message: `回合停滞 ${Math.round(idleTimeoutMs / 1000)}s 无 omp 事件,已中止重置(消息按已处理落账,后续消息继续)`,
              },
            })
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
      // 事件监听必须全部解除:本 client 跨回合长期复用,残留的 mapOmpEvent
      // 闭包会在后续每一帧继续执行并把事件 push 进孤儿队列(内存/CPU 随
      // 回合数线性劣化,直接违背进程常驻的稳定性目标)
      unsubState()
      unsub()
      signal.removeEventListener('abort', onAbort)
      this.turnActive = false
      this.streaming = false
      this.toolState.currentTaskId = null
    }
  }

  // ===== 内部:omp 事件 → AgentEvent 映射 =====
}

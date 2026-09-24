/**
 * AgentRuntimeLayer03 —— 单条消息处理(回合执行 / 事件流 / 交付兜底)与投影辅助
 * (分层 4/4,承 AgentRuntimeLayer02;方法体与原文件逐行一致)
 */
import { AgentRuntimeLayer02 } from './02-supervise'
import type { A2AMessage } from '../../types/a2a'
import type { AgentContextStats, AgentStatusView } from '../../types/task'
import type { AgentRunContext, AgentRunRequest } from '../../agents/agent-interface'
import { TERMINAL_TASK_STATES } from '../../types/task'
import { log, partsToText } from './helpers'
import { fenceFromMetadata } from '../task-engine/lease'
import type { ExecutionFence } from '../task-engine/lease'
import { randomUUID } from 'node:crypto'

export abstract class AgentRuntimeLayer03 extends AgentRuntimeLayer02 {
  protected async processMessage(msg: A2AMessage): Promise<void> {
    const taskId = this.taskIdOf(msg)
    const taskKind = msg.metadata?.['x-aw-task-kind']
    // §5.1 执行代次栅栏:任务消息携带 assignment generation + execution lease。
    // 运行中 reassign 之后,旧 worker 信箱里残留/被重投的 assign 与它会话中继续吐出的
    // 事件都带旧代次 —— 一律丢弃,绝不覆盖新执行结果。
    const fence = fenceFromMetadata(msg.metadata)
    // cancel 只是控制消息:它负责让已在运行的回合收口,本身不得再启动一次 worker turn。
    if (taskKind === 'cancel') {
      this.deps.mailbox.markConsumed(msg.messageId)
      return
    }
    // 过期任务投递检查:任务已终态(cancel/reassign 后残留的旧 assign/child-completed)→ 跳过执行,
    // 否则 worker/lead 会对着已终态任务的旧投递真的再跑一轮 harness。
    if ((taskKind === 'assign' || taskKind === 'child-completed') && taskId) {
      const task = this.deps.taskEngine.get(taskId)
      if (!task || TERMINAL_TASK_STATES[task.state]) {
        this.deps.mailbox.markConsumed(msg.messageId)
        return
      }
      if (!this.assignmentFenceOk(taskId, fence)) {
        log.warn(`[AgentRuntime:${this.agentId}] 丢弃过期任务投递(旧执行代次):task=${taskId.slice(0, 8)} kind=${taskKind}`)
        this.deps.mailbox.markConsumed(msg.messageId)
        return
      }
    }
    this.state = 'busy'
    this.currentTaskId = taskId ?? null
    this.deps.bus.notifyAgent({ agentId: this.agentId, state: 'busy', ...this.queueContext() })
    // 回合失败标记(须在 try 外声明,finally 依据它决定重投还是消费)
    let sawRunError = false
    try {
      // 任务消息联动:assign → WORKING(自动接取;状态事件由 TaskEngine transition hooks 广播)
      // 仅 SUBMITTED/ASSIGNED 自动接取:WAITING(已有子任务)的任务由 SchedulerLoop/子任务汇总推进,
      // 此处不得把父任务从 WAITING 翻回 WORKING(否则父任务在子任务执行期间虚挂 WORKING,
      // 会被 stall 检测误判为停滞而 cancel)。
      if (msg.metadata?.['x-aw-task-kind'] === 'assign' && taskId) {
        const task = this.deps.taskEngine.get(taskId)
        if (task && (task.state === 'SUBMITTED' || task.state === 'ASSIGNED')) {
          await this.deps.taskEngine.transition(taskId, 'WORKING', this.agentId)
        }
      }
      // 每次 run 新建 AbortController;abort 后事件流终止
      this.abortController = new AbortController()
      // §2.4/§6.2:worker 回合与 Lead supervise 共用同一 harness 进程/会话 ——
      // 回合起点观测租约(复用计数 / 重建归因)。
      this.noteHarnessUse()
      // 记忆召回(异常不阻塞):查询=消息原文(title 首词天然显著)+ 任务关联加权
      let memoryBlock: string | undefined
      try {
        memoryBlock = (await this.deps.memory?.recall(partsToText(msg.parts), {
          relatedTaskIds: this.relatedTaskIdsOf(taskId),
        })) ?? undefined
      }
      catch (err) {
        log.error(`[AgentRuntime:${this.agentId}] 记忆召回失败:`, err)
      }
      const request: AgentRunRequest = this.toRequest(msg, memoryBlock)
      const ctx: AgentRunContext = {
        agentId: this.agentId,
        channelId: msg.contextId,
        role: this.role,
        workspace: this.deps.workspace,
        signal: this.abortController.signal,
      }
      // 补入产出者 agentId(monitor 据此归属事件;不改原 msg,用浅拷贝)
      const enrichedSource = { ...msg, metadata: { ...msg.metadata, 'x-aw-producing-agent': this.agentId } }
      // 回复文本收集(V9:omp 不产 message 事件,聚合三类源——message 事件 / status.message / 终态 artifact 'output')
      let replyText = ''
      // 纯文本回合留底:模型以最终输出作答时只有 delta 事件,回执代投从这里取
      let deltaText = ''
      const cap = (text: string): void => {
        // peerPrompt 整段回显不是回复(status/message 事件会携带),以签名开头即忽略
        if (text.startsWith('You are "')) return
        if (replyText.length < 400) replyText += text.slice(0, 400 - replyText.length)
      }
      try {
        for await (const event of this.impl.run(request, ctx)) {
          this.deps.bus.emit(event, enrichedSource)
          // LLM 流式增量:只走事件流(AEP agent.delta),不进任务引擎/交付兜底管道;
          // 但要单独留底 —— 纯文本回合(模型以最终输出作答,不调工具)的回执全靠它
          if (event.kind === 'delta') {
            const t = event.delta?.text ?? ''
            if (deltaText.length < 8000 && t) deltaText += t
            continue
          }
          if (event.kind === 'error') sawRunError = true
          // 无原生工具面的 harness(codex/dsh 等)以 shell/文本方式作业:回合 error 收束
          // 但已有实质输出时,不落入 FAILED(交由回合结束后的交付兜底按最终输出隐式收口)——
          // 否则「工作已做完、流断在收尾」的任务全部 FAILED→重试→CANCELED(实测 dsh)。
          if (event.kind === 'error' && taskId && replyText.trim().length >= 40) {
            const cur = this.deps.taskEngine.get(taskId)
            if (cur && cur.state === 'WORKING') continue
          }
          if (taskId) await this.deps.taskEngine.applyEvent(taskId, event, fence)
          if (event.kind === 'message') {
            // 只聚合 assistant/agent 输出:ROLE_USER 是 prompt 回显,聚进去会把整段
            // 提示词当成"回复"代投到时间线(实测回执变成 prompt 前缀)。
            // 注:原判定写的是小写 'user',与 A2AMessage.role 的 'ROLE_USER'|'ROLE_AGENT'
            // 永不相交 → 该护栏从未生效(v17 类型收敛时修正)。
            if (event.message.role === 'ROLE_USER') deltaText = ''
            else cap(partsToText(event.message.parts))
          }
          else if (event.kind === 'status' && event.status.message) cap(partsToText(event.status.message.parts))
          else if (event.kind === 'artifact' && event.artifact.name === 'output') cap(partsToText(event.artifact.parts))
        }
      }
      catch (err) {
        // run 生成器抛错(如 omp 子进程 spawn 失败):按回合失败走重投,不外抛断循环
        sawRunError = true
        // Harness 重建归因(§6.2):下回合若换了 client/进程,原因取自此处
        this.pendingHarnessFailure = 'RPC_BROKEN'
        log.error(`[AgentRuntime:${this.agentId}] 回合异常:`, err)
      }
      // 人类 requireReply 的平台兜底回执:实测部分引擎/模型不遵从 send_message_to_agent
      // (回合只产 artifact 文本),请求方将收不到任何应答。平台把回合聚合文本代投回
      // 时间线(in_reply_to 关联 + x-aw-relayed 标记),保证"要求回复"必有确定应答;
      // 模型已自行回执时时间线会出现两条,属可接受的冗余(宁多勿丢)。
      // 纯文本回合(replyText 空、只有 delta)同样代投 —— 否则模型按提示"以最终输出
      // 作答"的回执被结构性丢弃(实测 omp lead 回执不落时间线)。
      // delta 流优先(模型最终输出以增量到达,最贴近真实回复);replyText 兜底
      let relayText = deltaText.trim() || replyText.trim()
      // 内容级去污:部分引擎的事件流会把 prompt 原文(整段或前缀)混进文本事件,
      // 角色字段拦不住 —— 此时文本**以 prompt 原文开头**,切除前言、保留其后的真正回复。
      //
      // 判据必须限定为「开头」(startsWith),不能是「包含就切到最后一处」(includes +
      // split().pop())。原因(实测):Agent 的正当回复**可以引用问题原文**,例如
      // mock 替身与不少真实模型的回执形如
      //   `@bob 已处理「[群聊] bob 提问:@demo-worker 请报告A线温度」;source=xxxx`
      // 用 includes 判据时,这条正当回复命中"引用了 prompt",于是被切到最后一个匹配之后,
      // 正文只剩 `」;source=xxxx` —— 回复内容被自己的去污逻辑销毁(群聊里看到空回复)。
      // 泄露的 prompt 一定出现在输出**最前面**,引用则出现在回复内容之中,故用前缀判定。
      // 另:清洗后为空则保留原文,绝不把回复变成空串。
      const promptEcho = partsToText(msg.parts).trim().slice(0, 80)
      if (promptEcho && relayText.startsWith(promptEcho)) {
        const remainder = relayText.slice(promptEcho.length).trim()
        if (remainder) relayText = remainder
      }
      relayText = relayText.trim().slice(0, 4000)
      if (msg.metadata?.['x-aw-require-reply'] === 'true'
        && typeof msg.metadata?.['x-aw-from-label'] === 'string'
        && relayText) {
        const relayMeta = {
          'x-aw-in-reply-to': msg.messageId,
          'x-aw-to-label': String(msg.metadata['x-aw-from-label']),
          'x-aw-relayed': 'true',
        }
        this.emitExternal({
          kind: 'message',
          message: {
            messageId: randomUUID(),
            contextId: this.channelId,
            role: 'ROLE_AGENT',
            parts: [{ text: relayText }],
            metadata: relayMeta,
          },
        })
        // 落时间线:emitExternal 只广播不持久化,回执必须可回溯(时间线 API 可查)
        // v17:全链路关联 ID 原样回传(sourceChatMessageId/requesterUserId/replyToId),
        // 由 platformReply 适配层写入群聊事实表并自动 @提问者 —— 绝不使用"最近发言者"推断。
        this.deps.platformReply?.({
          text: relayText,
          inReplyTo: msg.messageId,
          toLabel: String(msg.metadata['x-aw-from-label']),
          agentId: this.agentId,
          agentName: this.name,
          channelId: this.channelId,
          sourceChatMessageId: typeof msg.metadata['x-aw-source-chat-message-id'] === 'string'
            ? msg.metadata['x-aw-source-chat-message-id']
            : undefined,
          requesterUserId: typeof msg.metadata['x-aw-requester-user-id'] === 'string'
            ? msg.metadata['x-aw-requester-user-id']
            : (typeof msg.metadata['x-aw-from-user-id'] === 'string' ? msg.metadata['x-aw-from-user-id'] : undefined),
          replyToId: typeof msg.metadata['x-aw-reply-to'] === 'string' ? msg.metadata['x-aw-reply-to'] : undefined,
          deliveryId: typeof msg.metadata['x-aw-delivery-id'] === 'string' ? msg.metadata['x-aw-delivery-id'] : undefined,
        })
      }
      // 交付兜底(harness 回合结束 ≠ 任务完成):
      //  - 回合产出过实质 artifact(LLM 完成了工作但跳过 complete_task 工具)→ 隐式完成,
      //    交付物即回合规避的输出,平台代为收口(进度 100)。
      //  - 无 artifact 但回合有最终文本输出(部分 harness 不支持回合内调工具,只能把
      //    结果写在答复里,如 codex/dsh 的 MCP 桥未就绪/未被模型使用)→ 同样隐式完成,
      //    最终文本作为交付物;否则这类引擎的所有任务都会「工作做完了却停滞被回收」。
      //  - 两者皆无(LLM 空转)→ FAILED 交给调度器 retry/reassign。
      // 仅 worker 的 assign 执行消息生效:lead 由 supervise 协调;WAITING 父任务不属此列。
      if (taskId && this.role === 'worker' && taskKind === 'assign'
        && this.assignmentFenceOk(taskId, fence)) {
        const after = this.deps.taskEngine.get(taskId)
        if (after && after.assigneeId === this.agentId && after.state === 'WORKING') {
          const deliverable = after.artifacts.find(a => a.name !== 'input' && a.parts.some(p => ('text' in p ? p.text.trim().length : 1) > 0))
          const fallbackText = deliverable ? '' : replyText.trim()
          if (deliverable || fallbackText) {
            // 取消/超时可能在 harness 收尾期间先把任务推进到终态;终态任务不得隐式完成。
            const current = this.deps.taskEngine.get(taskId)
            if (current && current.assigneeId === this.agentId && current.state === 'WORKING') {
              if (!deliverable) {
                // 回合最终文本 → 平台代录交付物(与 complete_task 的 deliverable 同构)
                this.deps.taskEngine.applyEvent(taskId, {
                  kind: 'artifact',
                  artifact: {
                    artifactId: randomUUID(),
                    name: 'deliverable',
                    parts: [{ text: fallbackText.slice(0, 20_000) }],
                  },
                  lastChunk: true,
                  totalChunks: 1,
                }, fence)
              }
              const latest = this.deps.taskEngine.get(taskId)
              if (latest && latest.assigneeId === this.agentId && latest.state === 'WORKING') {
                const completed = this.deps.taskEngine.complete(taskId)
                this.emitExternal({
                  kind: 'status',
                  status: {
                    state: 'COMPLETED',
                    message: {
                      messageId: randomUUID(),
                      contextId: this.channelId,
                      role: 'ROLE_AGENT',
                      parts: [{ text: `任务 ${taskId} 回合已产出交付物但未调用完成工具,平台隐式收口为 COMPLETED${deliverable ? '' : '(交付物取自回合最终输出)'}` }],
                    },
                    timestamp: new Date().toISOString(),
                  },
                })
                // 子任务隐式完成 → 通知父任务(lead 汇总/WAITING→WORKING 接续):
                // 与 manager.completeTask 的显式收口同构,否则父任务 WAITING 永挂
                // (无 child-completed 事件、父任务不翻转,lead 无感知)。
                if (completed.parentId) {
                  const parent = this.deps.taskEngine.get(completed.parentId)
                  if (parent && !TERMINAL_TASK_STATES[parent.state]) {
                    this.deps.taskEngine.onChildCompleted(completed)
                    const updatedParent = this.deps.taskEngine.get(completed.parentId)
                    if (updatedParent && !TERMINAL_TASK_STATES[updatedParent.state]) this.deps.bus.wakeScheduler()
                  }
                }
              }
            }
          }
          else {
            const current = this.deps.taskEngine.get(taskId)
            if (current && current.assigneeId === this.agentId && current.state === 'WORKING') {
              this.deps.taskEngine.transition(taskId, 'FAILED', this.agentId)
              this.emitExternal({
                kind: 'status',
                status: {
                  state: 'FAILED',
                  message: {
                    messageId: randomUUID(),
                    contextId: this.channelId,
                    role: 'ROLE_AGENT',
                    parts: [{ text: `任务 ${taskId} 执行结束但无交付(harness 回合结束未产出),标记 FAILED 待重试` }],
                  },
                  timestamp: new Date().toISOString(),
                },
              })
            }
          }
        }
      }

      // 记忆沉淀:终态任务 harvest;无 taskId 的点对点消息记协作(异常不阻塞)
      if (this.deps.memory) {
        try {
          const task = taskId ? this.deps.taskEngine.get(taskId) : undefined
          if (task && TERMINAL_TASK_STATES[task.state]) {
            await this.deps.memory.recordTaskOutcome(task)
          }
          else if (!taskId) {
            const fromAgentId = (msg.metadata?.['x-aw-from-agent'] as string | undefined) ?? null
            if (fromAgentId) await this.deps.memory.recordPeerExchange(msg, replyText)
          }
        }
        catch (err) {
          log.error(`[AgentRuntime:${this.agentId}] 记忆写入失败:`, err)
        }
      }
    }
    finally {
      this.abortController = null
      this.currentTaskId = null
      if (this.state === 'busy') {
        this.state = 'idle'
        this.deps.bus.notifyAgent({ agentId: this.agentId, state: 'idle', ...this.queueContext() })
      }
      // 回合失败(harness 错误/停滞看门狗中止/子进程异常):重投消息而非静默消费,
      // 内容不丢,重试回合(通常已是全新子进程)再处理;每消息最多重投 2 次防毒消息死循环。
      // 任务已终态(取消/收口后 abort 让回合报错)则不再重投 —— 消息依任务终态
      // 由调度器 reassign/新 assign 驱动,重投只会空转(启动即被终态检查消费)。
      const taskNow = taskId ? this.deps.taskEngine.get(taskId) : undefined
      const taskDone = !!taskNow && TERMINAL_TASK_STATES[taskNow.state]
      if (sawRunError && !taskDone && (this.runErrorRetries.get(msg.messageId) ?? 0) < 2
        && this.deps.mailbox.requeue(msg.messageId)) {
        const attempt = (this.runErrorRetries.get(msg.messageId) ?? 0) + 1
        this.runErrorRetries.set(msg.messageId, attempt)
        this.emitExternal({
          kind: 'status',
          status: {
            state: 'WORKING',
            message: {
              messageId: randomUUID(),
              contextId: this.channelId,
              role: 'ROLE_AGENT',
              parts: [{ text: `消息 ${msg.messageId.slice(0, 8)} 回合失败,已重投信箱待重试(第 ${attempt} 次)` }],
            },
            timestamp: new Date().toISOString(),
          },
        })
      }
      else {
        this.runErrorRetries.delete(msg.messageId)
        this.deps.mailbox.markConsumed(msg.messageId)
      }
      // 回合落定:信箱空 → 后台压缩检查(post-settle 路径;impl 自守卫不阻塞)
      this.maybePostSettle()
    }
  }

  /**
   * §5.1 执行代次栅栏校验(带能力探测)。
   *
   * 生产装配下 `deps.taskEngine` 恒为 TaskEngine(必带 assertAssignmentFence);
   * 但测试替身/极简构造点可能只实现 run 路径所需的最小子集 —— 缺方法时按
   * 「无栅栏能力」放行,而不是在消费循环里抛 TypeError 把整条消息链打断。
   */
  protected assignmentFenceOk(taskId: string, fence?: ExecutionFence): boolean {
    const engine = this.deps.taskEngine as { assertAssignmentFence?: (id: string, f?: ExecutionFence) => boolean }
    if (typeof engine.assertAssignmentFence !== 'function') return true
    return engine.assertAssignmentFence(taskId, fence)
  }

  /** 状态通知的队列上下文(实时:当前任务/待执行数/已完成数/harness 上下文用量/监督/连续性) */
  protected queueContext(): Pick<AgentStatusView, 'currentTaskId' | 'currentTaskTitle' | 'currentTaskProgress' | 'queuedCount' | 'completedCount' | 'supervision' | 'continuity'> & { context?: AgentContextStats | null } {
    const status = this.getStatus()
    return {
      currentTaskId: status.currentTaskId,
      currentTaskTitle: status.currentTaskTitle,
      currentTaskProgress: status.currentTaskProgress,
      queuedCount: status.queuedCount,
      completedCount: status.completedCount,
      context: status.context ?? null,
      supervision: status.supervision,
      continuity: status.continuity,
    }
  }

  /**
   * 任务关联集(自身+父+兄弟,≤20):related-task boost 数据源。
   * 同父兄弟任务的记忆(前几个子任务做了什么)在引子中必然置顶——
   * 纯内存 id 判断,零检索开销。
   */
  protected relatedTaskIdsOf(taskId: string | undefined): string[] | undefined {
    if (!taskId) return undefined
    const task = this.deps.taskEngine.get(taskId)
    if (!task) return undefined
    const ids = new Set<string>([taskId])
    if (task.parentId) {
      ids.add(task.parentId)
      for (const t of this.deps.taskEngine.list(this.channelId)) {
        if (t.parentId === task.parentId) ids.add(t.id)
        if (ids.size >= 20) break
      }
    }
    return [...ids]
  }

  /**
   * post-settle 压缩检查:仅信箱无排队消息时触发(排队消息的 pre-prompt gate 兜底)。
   * impl 自守卫(回合间隙才压缩、异常不抛出);本方法自身也不阻塞消费循环。
   */
  protected maybePostSettle(): void {
    if (!this.impl.onTurnSettled) return
    void this.deps.mailbox.peek(1)
      .then((pending) => {
        if (pending.length > 0) return undefined
        return this.impl.onTurnSettled?.()
      })
      .catch(() => {})
  }

  protected toRequest(msg: A2AMessage, memory?: string): AgentRunRequest {
    return {
      message: msg,
      taskId: msg.taskId,
      contextId: msg.contextId,
      fromAgentId: (msg.metadata?.['x-aw-from-agent'] as string | undefined) ?? null,
      toAgentId: this.agentId,
      memory,
    }
  }

  protected taskIdOf(msg: A2AMessage): string | undefined {
    return msg.taskId ?? (msg.metadata?.['x-aw-task-id'] as string | undefined)
  }
}

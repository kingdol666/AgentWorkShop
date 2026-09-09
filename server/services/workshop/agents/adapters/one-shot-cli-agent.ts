/**
 * OneShotCliAgentImpl —— 「一次性 CLI 流式 JSON」引擎家族共享基座。
 *
 * 适用面:gemini / copilot / cursor / crush / goose 等以「spawn 一次 → 逐行 JSON 事件 →
 * 进程退出收口」为进程模型的 CLI 引擎。每回合一个子进程(lazy;进程登记/强杀/存活校准
 * 复用 harness-process);prompt 经 stdin 或单参数投递;事件映射由引擎 spec 声明。
 *
 * 平台语义对齐(与 omp/codex/dsh 同一契约):
 *  - 消息分流按 metadata['x-aw-task-kind'](assign/peer);prompt 组装走共享 prompt-builder
 *  - steer:一次性进程模型无同轮注入 → 恒 'deferred'(信箱语义,与 dsh 一致)
 *  - 错误即事件:spawn 失败/非 0 退出/停滞超时/解析期致命错误都产出 {kind:'error'}
 *  - 工具:引擎侧经 MCP 桥(aw-mcp-bridge.mjs)回程 HTTP → impl.dispatchHostTool → 共享桥;
 *    agent 身份(AW_AGENT_ID/AW_AGENT_TOKEN)随引擎进程 env 注入,由 MCP 子进程继承
 *  - 上下文:usage 从引擎事件被动聚合(spec.mapLine 调 sink.usage);平台不主动压缩
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { createLogger } from '../../logger'
import type {
  AgentEvent,
  AgentRunContext,
  AgentRunRequest,
} from '../agent-interface'
import type { AgentContextStats } from '../../types/task'
import { registerHarnessProcess, bindHarnessProcess, markHarnessProcessExit, killHarnessProcess, isProcessAlive } from '../harness-process'
import { workerPrompt, peerPrompt, systemManual } from '../prompt-builder'
import { generateMcpBridgeEnv } from '../harness-env'
import { spawnLineProcess } from './line-spawn'
import { BaseAgentImpl } from '../base-agent'

const log = createLogger('workshop.one-shot')

/** 引擎事件装配器(mapLine 回调面) */
export interface OneShotEventSink {
  /** 流式文本增量(自动累积为回合 artifact) */
  delta(text: string): void
  /** 工具/阶段状态(🔧 行) */
  status(text: string): void
  /** usage 透传(inputTokens 缺省取 totalTokens) */
  usage(u: { inputTokens?: number, outputTokens?: number }): void
  /** 会话 id 捕获(resume 用) */
  session(id: string): void
}

/** 单回合引擎 spec:命令/参数/事件映射的引擎差异面 */
export interface OneShotEngineSpec {
  harnessId: string
  /** 引擎可执行命令(config.command → harnessSettings → 内置缺省,由 impl 侧解析后注入) */
  resolveCommand(config: Record<string, unknown>): string
  /** 组装回合参数(prompt 不含在内;promptDelivery=arg 时基座追加为最后一个参数) */
  buildArgs(ctx: { resumeSessionId: string | null, config: Record<string, unknown> }): string[]
  /** prompt 投递方式:stdin(默认,无长度/引号限制)、arg(单参数;引号/换行被消毒)、
   *  argFile(写临时文件后以 @<path> 位置参数投递 —— 规避 Windows cmd ~8K 命令行上限,pi 用) */
  promptDelivery?: 'stdin' | 'arg' | 'argFile'
  /** promptDelivery=arg 时的旗标(如 goose 的 '-t';缺省 = 裸位置参数) */
  promptArgFlag?: string
  /** 回合前置钩子(确保 MCP 配置文件存在等);异常 → 回合报错 */
  prepare?(config: Record<string, unknown>): Promise<void> | void
  /** 引擎鉴权/运行环境增量(config 驱动;缺省继承进程环境) */
  engineEnv?(config: Record<string, unknown>): Record<string, string>
  /** 逐行事件映射(非 JSON 行已过滤;异常不得抛出,返回即可) */
  mapLine(json: Record<string, unknown>, raw: string, state: OneShotTurnState, sink: OneShotEventSink): void
  /** 非 JSON 的 stdout 行按纯文本增量处理(无结构化输出面的引擎,如 crush v0.92 run -q) */
  plainTextStdout?: boolean
  /** stdout 为单个(可能多行美化打印的)JSON 对象,进程退出后整段解析(zcode -p --json) */
  wholeJsonAtExit?: boolean
  /** 非 0 退出码 → 错误消息(缺省 `<ID>_EXIT_<code>` + stderr 尾部) */
  exitErrorMessage?(code: number, stderrTail: string): string
  /** 上下文窗口(usage 百分比;缺省不报百分比) */
  contextWindow?(config: Record<string, unknown>): number
}

/** 回合期间的可变状态(mapLine 可读写) */
export interface OneShotTurnState {
  agentText: string
  sessionId: string | null
  usage: { inputTokens: number, at: number } | null
  sawEngineFrame: boolean
}

export interface OneShotCliConfig {
  command?: string
  cwd?: string
  model?: string
  promptTimeoutMs?: number
  superviseTimeoutMs?: number
  /** 会话延续(引擎支持且捕获到 sessionId 时追加 resume 参数;默认关——跨 agent 会话串扰防护) */
  resumeSession?: boolean
  contextWindow?: number
  systemPromptPrefix?: string
  scenarioPrompt?: string
  agentId?: string
  name?: string
  role?: 'lead' | 'worker'
  channelId?: string
  token?: string
  baseUrl?: string
  mcpBridgePath?: string
  [key: string]: unknown
}

/** arg 投递消毒:cmd 包装链拒绝引号/控制字符;prompt 为自由文本,此处降级替换 */
export function sanitizePromptArg(prompt: string): string {
  return prompt.replace(/\r\n|\r|\n/g, ' ').replace(/"/g, '\'').replace(/[\0\b\t\v\f]/g, ' ')
}

function tryParse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>
  }
  catch {
    return null
  }
}

export class OneShotCliAgentImpl extends BaseAgentImpl implements AgentInterface {
  protected readonly config: OneShotCliConfig
  protected readonly spec: OneShotEngineSpec

  /** 当前回合子进程(一 agent 同时最多一回合;上层 mailbox 已保证串行) */
  private child: ChildProcess | null = null
  private childPid: number | null = null
  private turnActive = false
  private lastUsage: { inputTokens: number, at: number } | null = null
  private lastSessionId: string | null = null
  private disposed = false

  constructor(config: Record<string, unknown>, spec: OneShotEngineSpec) {
    super({
      agentId: typeof config.agentId === 'string' ? config.agentId : '',
      name: typeof config.name === 'string' ? config.name : undefined,
      role: config.role === 'lead' ? 'lead' : 'worker',
      channelId: typeof config.channelId === 'string' ? config.channelId : '',
    })
    this.config = config as OneShotCliConfig
    this.spec = spec
  }

  protected get harnessId(): string {
    return this.spec.harnessId
  }

  protected configRecord(): Record<string, unknown> {
    return this.config
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.killChild()
  }

  getProcessInfo(): { pid: number, alive: boolean, command: string } | null {
    const pid = this.childPid
    if (!pid) return null
    return { pid, alive: isProcessAlive(pid), command: this.spec.resolveCommand(this.config) }
  }

  killProcess(): void {
    this.killChild()
  }

  reconcileProcess(): void {
    if (this.childPid && !isProcessAlive(this.childPid) && this.turnActive) {
      // OS 级已死但 exit 事件未达(休眠/强杀):收敛回合,避免幽灵占用
      this.turnActive = false
    }
  }

  getContextStats(): AgentContextStats | null {
    if (!this.lastUsage) return null
    const window = this.config.contextWindow ?? this.spec.contextWindow?.(this.config) ?? 0
    return {
      usedTokens: this.lastUsage.inputTokens,
      contextWindow: window,
      percent: window > 0 ? Math.min(1, this.lastUsage.inputTokens / window) : null,
      compacting: false,
    }
  }

  async steer(_text: string): Promise<'steer' | 'deferred'> {
    return 'deferred'
  }

  /** HITL:一次性 CLI 家族无程序化审批面(能力面如实声明 hitl:false) */
  async respondHitl(): Promise<void> {
    throw new Error(`${this.spec.harnessId} 无 HITL 应答面`)
  }

  // ===== 回合实现(基类 run/supervise 模板回调) =====

  protected async* workerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const taskId = request.taskId ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (!taskId) return
    this.toolState.currentTaskId = taskId
    try {
      const prompt = workerPrompt({
        agentName: this.agentName,
        channelId: this.channelId,
        taskId,
        taskText: this.partsText(request.message),
        memory: request.memory,
        ctxPrefix: await this.contextPrefix(),
        manual: systemManual(),
      })
      yield* this.streamTurn(prompt, taskId, this.config.promptTimeoutMs ?? 600_000, ctx.signal)
    }
    finally {
      this.toolState.currentTaskId = null
    }
  }

  protected async* peerTurn(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const msg = request.message
    const fromId = request.fromAgentId
      ?? (typeof msg.metadata?.['x-aw-from-label'] === 'string' ? msg.metadata['x-aw-from-label'] : undefined)
      ?? 'unknown'
    const requireReply = msg.metadata?.['x-aw-require-reply'] === 'true'
    const crossChannel = msg.metadata?.['x-aw-cross-channel'] === 'true'
    this.toolState.replyContext = requireReply && request.fromAgentId && !crossChannel
      ? { fromId: request.fromAgentId, messageId: msg.messageId }
      : null
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
      msgText: this.partsText(msg),
    })
    yield* this.streamTurn(prompt, undefined, this.config.promptTimeoutMs ?? 600_000, ctx.signal)
  }

  /** supervise 用:收齐整个回合 */
  protected async collectTurnEvents(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    for await (const e of this.streamTurn(prompt, undefined, timeoutMs, signal)) {
      events.push(e)
      if (e.kind === 'error') break
    }
    return events
  }

  // ===== 回合执行(spawn 一次 → 行事件 → 退出收口) =====

  private killChild(): void {
    const child = this.child
    this.child = null
    if (!child) return
    const pid = child.pid
    if (pid) {
      killHarnessProcess(pid)
      markHarnessProcessExit(pid, null)
    }
    else {
      child.kill('SIGKILL')
    }
  }

  private async* streamTurn(prompt: string, taskId: string | undefined, timeoutMs: number, signal?: AbortSignal): AsyncGenerator<AgentEvent, void, unknown> {
    if (this.turnActive) {
      yield { kind: 'error', error: { code: 'TURN_BUSY', message: `${this.spec.harnessId} 上一回合尚未收口` } }
      return
    }
    if (this.disposed) {
      yield { kind: 'error', error: { code: 'HARNESS_DISPOSED', message: `${this.spec.harnessId} 实例已释放` } }
      return
    }
    this.turnActive = true

    const command = this.spec.resolveCommand(this.config)
    const resumeSessionId = this.config.resumeSession === true ? this.lastSessionId : null
    const args = this.spec.buildArgs({ resumeSessionId, config: this.config })
    const delivery = this.spec.promptDelivery ?? 'stdin'
    let promptFile: string | null = null
    if (delivery === 'arg') {
      const sanitized = sanitizePromptArg(prompt)
      if (this.spec.promptArgFlag) args.push(this.spec.promptArgFlag, sanitized)
      else args.push(sanitized)
    }
    else if (delivery === 'argFile') {
      const { writeFile } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      promptFile = join(tmpdir(), `aw-prompt-${randomUUID().slice(0, 8)}.txt`)
      await writeFile(promptFile, prompt, 'utf-8')
      args.push(`@${promptFile}`)
    }

    const bridge = generateMcpBridgeEnv({
      agentId: this.selfAgentId,
      token: this.config.token,
      baseUrl: this.config.baseUrl,
      bridgePath: this.config.mcpBridgePath,
    })
    if (this.spec.prepare) {
      try {
        await this.spec.prepare(this.config)
      }
      catch (err) {
        this.turnActive = false
        yield {
          kind: 'error',
          error: { code: 'HARNESS_PREPARE_FAILED', message: `${this.spec.harnessId} 回合准备失败: ${err instanceof Error ? err.message : String(err)}` },
        }
        return
      }
    }
    const env = {
      ...bridge.bridgeEnv,
      ...(this.spec.engineEnv?.(this.config) ?? {}),
    }

    const state: OneShotTurnState = { agentText: '', sessionId: null, usage: null, sawEngineFrame: false }
    const queue: AgentEvent[] = []
    let isDone = false
    let resolveWait: (() => void) | null = null
    let lastActivity = Date.now()
    let stderrTail = ''

    const enqueue = (e: AgentEvent): void => {
      lastActivity = Date.now()
      queue.push(e)
      resolveWait?.()
      resolveWait = null
    }
    const sink: OneShotEventSink = {
      delta: (text) => {
        if (!text) return
        state.agentText += text
        enqueue({ kind: 'delta', delta: { text } })
      },
      status: (text) => {
        enqueue({
          kind: 'status',
          status: {
            state: 'WORKING',
            message: { messageId: randomUUID(), contextId: this.channelId, role: 'ROLE_AGENT', parts: [{ text }] },
            timestamp: new Date().toISOString(),
          },
        })
      },
      usage: (u) => {
        const input = Number(u.inputTokens ?? u.outputTokens ?? 0)
        if (Number.isFinite(input) && input > 0) {
          state.usage = { inputTokens: input, at: Date.now() }
          this.lastUsage = state.usage
        }
      },
      session: (id) => {
        if (id) {
          state.sessionId = id
          this.lastSessionId = id
        }
      },
    }

    let child: ChildProcess
    try {
      child = spawnLineProcess(command, args, { cwd: this.config.cwd ?? process.cwd(), env })
    }
    catch (err) {
      this.turnActive = false
      yield {
        kind: 'error',
        error: {
          code: 'HARNESS_NOT_CONFIGURED',
          message: `${this.spec.harnessId} 进程拉起失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
      return
    }
    this.child = child
    this.childPid = child.pid ?? null
    if (child.pid) {
      registerHarnessProcess(child.pid, { harness: this.spec.harnessId, command, args })
      bindHarnessProcess(child.pid, { agentId: this.selfAgentId, channelId: this.channelId, name: this.agentName, role: this.agentRole })
    }

    const finishTurn = (result: { kind: 'done' } | { kind: 'error', code: string, message: string }): void => {
      if (isDone) return
      isDone = true
      if (result.kind === 'done' && state.agentText.trim()) {
        queue.push({
          kind: 'artifact',
          artifact: { artifactId: randomUUID(), name: 'output', parts: [{ text: state.agentText.trim() }] },
          lastChunk: true,
          totalChunks: 1,
        })
      }
      queue.push(result.kind === 'done'
        ? { kind: 'done', final: taskId ? { taskId } : undefined }
        : { kind: 'error', error: { code: result.code, message: result.message } })
      resolveWait?.()
      resolveWait = null
    }

    child.stdout?.setEncoding('utf-8')
    let stdoutAll = ''
    child.stdout?.on('data', (chunk: string) => {
      if (this.spec.wholeJsonAtExit === true) {
        stdoutAll += chunk
        return
      }
      for (const rawLine of chunk.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line) continue
        const json = tryParse(line)
        if (json === null) {
          // 无结构化输出面的引擎:stdout 纯文本行即回复增量;其余(横幅/告警)忽略
          if (this.spec.plainTextStdout === true) sink.delta(line)
          continue
        }
        state.sawEngineFrame = true
        try {
          this.spec.mapLine(json, line, state, sink)
        }
        catch (err) {
          log.warn(`[${this.spec.harnessId}:${this.selfAgentId}] mapLine 异常(忽略): ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-8000)
    })

    const onAbort = (): void => {
      log.warn(`[${this.spec.harnessId}:${this.selfAgentId}] run 被 abort → 杀进程树,taskId=${taskId ?? '-'}`)
      this.killChild()
      finishTurn({ kind: 'done' })
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      finishTurn({ kind: 'error', code: 'HARNESS_NOT_CONFIGURED', message: `${this.spec.harnessId} 进程错误: ${err.message}` })
    })
    child.on('exit', (code) => {
      if (child.pid) markHarnessProcessExit(child.pid, code)
      this.child = null
      // 整段 JSON 模式:退出后解析完整 stdout(取最后一个顶层对象)
      if (this.spec.wholeJsonAtExit === true && stdoutAll.trim()) {
        const text = stdoutAll.trim()
        const start = text.lastIndexOf('\n{')
        const candidate = start >= 0 ? text.slice(start + 1) : text
        try {
          const obj = JSON.parse(candidate) as Record<string, unknown>
          state.sawEngineFrame = true
          try {
            this.spec.mapLine(obj, candidate, state, sink)
          }
          catch (err) {
            log.warn(`[${this.spec.harnessId}:${this.selfAgentId}] mapLine(whole) 异常(忽略): ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        catch {
          // 非法 JSON:按纯文本交付
          const extracted = candidate.slice(0, 4000)
          if (extracted) sink.delta(extracted)
        }
      }
      if (code === 0) {
        finishTurn({ kind: 'done' })
      }
      else {
        const custom = this.spec.exitErrorMessage?.(code ?? -1, stderrTail)
        finishTurn({
          kind: 'error',
          code: `${this.spec.harnessId.toUpperCase()}_EXIT_${code ?? -1}`,
          message: custom ?? `${this.spec.harnessId} 退出码 ${code}:${stderrTail.trim().slice(-600) || '(无 stderr)'}`,
        })
      }
    })

    if (delivery === 'stdin') {
      child.stdin?.write(prompt)
      child.stdin?.end()
    }
    else {
      // arg/argFile 投递:仍需关闭 stdin —— 等待 stdin EOF 的引擎(如 crush)否则永久挂起
      child.stdin?.end()
    }

    try {
      while (!isDone || queue.length > 0) {
        if (queue.length === 0 && !isDone) {
          const remaining = timeoutMs - (Date.now() - lastActivity)
          if (remaining <= 0) {
            this.killChild()
            finishTurn({
              kind: 'error',
              code: 'TURN_STALLED',
              message: `${this.spec.harnessId} 回合停滞 ${Math.round(timeoutMs / 1000)}s 无事件,已终止`,
            })
            continue
          }
          await new Promise<void>((r) => {
            resolveWait = r
            setTimeout(() => {
              resolveWait = null
              r()
            }, Math.min(remaining + 100, 5000))
          })
        }
        while (queue.length > 0) {
          const e = queue.shift()!
          if (e.kind === 'error') isDone = true
          yield e
          if (e.kind === 'error') return
        }
      }
    }
    finally {
      signal?.removeEventListener('abort', onAbort)
      this.turnActive = false
      if (this.child) this.killChild()
      if (promptFile) {
        const { unlink } = await import('node:fs/promises')
        await unlink(promptFile).catch(() => {})
      }
    }
  }
}

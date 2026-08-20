/**
 * Harness 终端 Hub —— omp 子进程的原生会话流镜像 + Human-in-the-loop 控制。
 *
 * 每个 omp(`--mode rpc-ui`)子进程在 ensureClient 时挂一个原始帧 tap
 * (OmpRpcClient.onRawFrame):全部 JSONL 帧(会话事件 / host_tool_call /
 * extension_ui_request)经净化后写入 per-pid 环形缓冲,并微批广播给 WS 订阅者
 * (前端 xterm TUI 渲染)。反向通道:WS 输入 → steer/follow_up 注入会话;
 * abort 中止回合;ui_response 应答 HITL 对话框(extension_ui_response)。
 *
 * HITL 语义:extension_ui_request(select/confirm/input/editor)到达时
 *  - 有 WS 订阅者(有人在看终端)→ 等待人类应答,无超时(真 HITL);
 *  - 无订阅者 → 自动 cancelled(等价 TUI 按 Esc;agent 的 ask 回合中止),
 *    并落一条 notice 帧让事后接入的观众可见。
 *
 * 定位:模块级单例(globalThis 跨 HMR 存活,与 workshop ws hub 同风格);
 * omp-agent 装配时 attach,manager 监控层读取 hasTerminalSession 标记进程行。
 */
import type { OmpRpcClient } from './adapters/omp-rpc-client'
import {
  TERM_FRAME_TEXT_PREVIEW_MAX,
  TERM_RING_CAPACITY,
  type TerminalHitlDialog,
  type TermFrame,
  type TermSessionMeta,
  type TerminalServerMessage,
} from '../../../../shared/terminal-protocol'

/** 终端会话(一个 pid 一份;进程退出后保留缓冲供事后查看) */
interface TerminalSession {
  meta: TermSessionMeta
  client: OmpRpcClient
  seq: number
  ring: TermFrame[]
  /** WS 订阅者(收到微批后的 term.frames / term.state / term.notice) */
  listeners: Set<(msg: TerminalServerMessage) => void>
  /** 回合状态(agent_start..agent_end 终态) */
  running: boolean
  /** 流式状态(当前回合是否正在输出 —— steer 生效窗口) */
  streaming: boolean
  alive: boolean
  exitCode: number | null
  pendingHitl: TerminalHitlDialog | null
  unsubRaw: (() => void) | null
  /** 微批缓冲 + 定时器(50ms 合并 delta 帧,防 WS 洪泛) */
  batch: TermFrame[]
  batchTimer: ReturnType<typeof setTimeout> | null
}

interface HubState {
  sessions: Map<number, TerminalSession>
}
const hubGlobal = globalThis as typeof globalThis & { __harnessTerminalHub?: HubState }
const hub: HubState = hubGlobal.__harnessTerminalHub
  ?? (hubGlobal.__harnessTerminalHub = { sessions: new Map() })
const sessions = hub.sessions

// ===== 帧净化 =====

/** 提取 message.content 数组中的纯文本(AgentMessage.content 子集) */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      if (c && typeof c === 'object' && 'type' in c) {
        const part = c as { type?: string, text?: string, thinking?: string }
        if (part.type === 'text' && typeof part.text === 'string') return part.text
        if (part.type === 'thinking' && typeof part.thinking === 'string') return part.thinking
      }
      return ''
    })
    .join('')
}

function clip(text: string, max = TERM_FRAME_TEXT_PREVIEW_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text
}

/** 任意值 → 诊断预览字符串(工具参数/结果用) */
function preview(value: unknown, max = TERM_FRAME_TEXT_PREVIEW_MAX): string {
  if (typeof value === 'string') return clip(value, max)
  try {
    return clip(JSON.stringify(value) ?? String(value), max)
  }
  catch {
    return clip(String(value), max)
  }
}

/**
 * 净化单帧:剥离/截断重字段(agent_end.messages 整体丢弃、工具参数只留预览、
 * available_commands 全丢),保留渲染所需结构。未知帧超预算整体截断。
 */
function sanitizeFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const type = frame.type as string
  switch (type) {
    case 'ready':
      return { type, protocolVersion: frame.protocolVersion }
    case 'available_commands_update':
      return { type }
    case 'response':
      return { type, command: frame.command, success: frame.success, error: frame.error }
    case 'agent_start':
      return { type }
    case 'agent_end':
      return {
        type,
        isTerminal: frame.isTerminal,
        messageCount: Array.isArray(frame.messages) ? frame.messages.length : 0,
      }
    case 'message_start':
    case 'message_end': {
      const msg = frame.message as { role?: string, content?: unknown } | undefined
      const text = contentText(msg?.content)
      return {
        type,
        role: msg?.role,
        // follow_up 路径 omp 会回显 user 消息;与 __human_input 同文时前端去重
        text: clip(text),
      }
    }
    case 'message_update':
      // delta 帧本身很小;丢弃累计 message(每帧全量 assistant 消息)
      return { type, assistantMessageEvent: frame.assistantMessageEvent }
    case 'tool_execution_start':
      return { type, toolCallId: frame.toolCallId, toolName: frame.toolName, args: preview(frame.args), intent: frame.intent }
    case 'tool_execution_update':
      return { type, toolCallId: frame.toolCallId, toolName: frame.toolName, update: preview(frame.partialResult) }
    case 'tool_execution_end':
      return { type, toolCallId: frame.toolCallId, toolName: frame.toolName, isError: frame.isError, result: preview(frame.result) }
    case 'host_tool_call':
      return { type, id: frame.id, toolName: frame.toolName, args: preview(frame.arguments) }
    case 'extension_ui_request':
      // 对话框本体(小帧;select 的 options 列表保留)
      return { ...frame }
    case 'command_output':
      return { type, text: clip(String(frame.text ?? '')) }
    default: {
      try {
        const json = JSON.stringify(frame) ?? ''
        if (json.length <= TERM_FRAME_TEXT_PREVIEW_MAX) return frame
      }
      catch {
        /* fallthrough */
      }
      return { type, __truncated: true }
    }
  }
}

// ===== 会话内部 =====

function pushFrame(session: TerminalSession, sanitized: Record<string, unknown>): TermFrame {
  session.seq += 1
  const f: TermFrame = { seq: session.seq, at: new Date().toISOString(), frame: sanitized }
  session.ring.push(f)
  if (session.ring.length > TERM_RING_CAPACITY) session.ring.splice(0, session.ring.length - TERM_RING_CAPACITY)
  session.batch.push(f)
  scheduleFlush(session)
  return f
}

/** 微批广播:50ms 合并窗口内帧一次发出(text_delta 洪泛保护) */
function scheduleFlush(session: TerminalSession): void {
  if (session.batchTimer) return
  session.batchTimer = setTimeout(() => {
    session.batchTimer = null
    const frames = session.batch
    session.batch = []
    if (frames.length === 0) return
    broadcast(session, { type: 'term.frames', frames })
  }, 50)
}

function flushNow(session: TerminalSession): void {
  if (session.batchTimer) {
    clearTimeout(session.batchTimer)
    session.batchTimer = null
  }
  const frames = session.batch
  session.batch = []
  if (frames.length > 0) broadcast(session, { type: 'term.frames', frames })
}

function broadcast(session: TerminalSession, msg: TerminalServerMessage): void {
  for (const fn of session.listeners) {
    try {
      fn(msg)
    }
    catch {
      /* listener 异常不影响 hub */
    }
  }
}

function setState(session: TerminalSession, patch: { running?: boolean, streaming?: boolean }): void {
  let changed = false
  if (patch.running !== undefined && patch.running !== session.running) {
    session.running = patch.running
    changed = true
  }
  if (patch.streaming !== undefined && patch.streaming !== session.streaming) {
    session.streaming = patch.streaming
    changed = true
  }
  if (changed) broadcastState(session)
}

function broadcastState(session: TerminalSession): void {
  broadcast(session, {
    type: 'term.state',
    alive: session.alive,
    streaming: session.streaming,
    running: session.running,
  })
}

/** 当前待应答 HITL 对话框视图(下发 init 用) */
function hitlViewOf(frame: Record<string, unknown> | null): TerminalHitlDialog | null {
  if (!frame || frame.type !== 'extension_ui_request') return null
  const method = frame.method as TerminalHitlDialog['method']
  if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor') return null
  return {
    id: String(frame.id ?? ''),
    method,
    title: String(frame.title ?? ''),
    options: Array.isArray(frame.options) ? frame.options.map(String) : undefined,
    message: typeof frame.message === 'string' ? frame.message : undefined,
    placeholder: typeof frame.placeholder === 'string' ? frame.placeholder : undefined,
    prefill: typeof frame.prefill === 'string' ? frame.prefill : undefined,
    at: new Date().toISOString(),
  }
}

/** HITL 对话框到达:登记 pending;无订阅者 → 自动 cancelled */
function handleUiRequest(session: TerminalSession, frame: Record<string, unknown>): void {
  const method = frame.method as string
  if (method === 'cancel') {
    // omp 主动撤销对话框(如回合中止):清 pending
    const targetId = String(frame.targetId ?? '')
    if (session.pendingHitl && session.pendingHitl.id === targetId) session.pendingHitl = null
    return
  }
  const view = hitlViewOf(frame)
  if (!view) return
  session.pendingHitl = view
  if (session.listeners.size === 0) {
    // 无人观看:自动取消(Esc 语义),事后观众通过 notice 帧可见
    respondUi(session, { id: view.id, cancelled: true })
    pushFrame(session, {
      type: '__terminal_notice',
      level: 'warning',
      message: `HITL 对话框(${view.method} "${view.title.slice(0, 40)}")无人接入,已自动取消`,
    })
  }
}

// ===== 对外 API =====

/**
 * 给已 spawn 的 omp 客户端挂终端镜像 tap(omp-agent ensureClient 调用)。
 * 同 pid 重复 attach(进程复用)幂等:先卸旧 tap。
 */
export function attachTerminalTap(
  client: OmpRpcClient,
  meta: { pid: number, harness: string, agentId: string, channelId: string, name: string, role: 'lead' | 'worker' },
): void {
  detachTerminalTap(meta.pid)
  const session: TerminalSession = {
    meta: {
      pid: meta.pid,
      harness: meta.harness,
      agentId: meta.agentId,
      channelId: meta.channelId,
      name: meta.name,
      role: meta.role,
      startedAt: Date.now(),
    },
    client,
    seq: 0,
    ring: [],
    listeners: new Set(),
    running: false,
    streaming: false,
    alive: true,
    exitCode: null,
    pendingHitl: null,
    unsubRaw: null,
    batch: [],
    batchTimer: null,
  }

  session.unsubRaw = client.onRawFrame((frame) => {
    const type = frame.type as string
    // 回合/流式状态机(输入路由依据)
    if (type === 'agent_start') {
      setState(session, { running: true })
    }
    if (type === 'message_update') {
      setState(session, { running: true, streaming: true })
    }
    if (type === 'message_end' || type === 'turn_end') {
      setState(session, { streaming: false })
    }
    if (type === 'agent_end' && frame.isTerminal !== false) {
      setState(session, { running: false, streaming: false })
    }
    if (type === 'extension_ui_request') {
      handleUiRequest(session, frame)
    }
    pushFrame(session, sanitizeFrame(frame))
  })

  sessions.set(meta.pid, session)
  pushFrame(session, {
    type: '__terminal_notice',
    level: 'info',
    message: `终端镜像已接入 omp PID ${meta.pid}(${meta.role} ${meta.name}@${meta.channelId?.slice(0, 8) ?? '?'})`,
  })
}

/** 卸载 tap(客户端 dispose / 进程复用;保留缓冲供事后查看) */
export function detachTerminalTap(pid: number): void {
  const session = sessions.get(pid)
  if (!session) return
  session.unsubRaw?.()
  session.unsubRaw = null
  session.client = null as unknown as OmpRpcClient
}

/** 进程退出标记(exit 事件 / 强杀路径共用;幂等,缓冲保留) */
export function markTerminalSessionExit(pid: number, exitCode: number | null): void {
  const session = sessions.get(pid)
  if (!session || !session.alive) return
  detachTerminalTap(pid)
  session.alive = false
  session.exitCode = exitCode
  session.pendingHitl = null
  session.running = false
  session.streaming = false
  flushNow(session)
  pushFrame(session, {
    type: '__terminal_notice',
    level: 'error',
    message: `omp 进程已退出(code=${exitCode ?? '?'})`,
  })
  broadcastState(session)
}

export function hasTerminalSession(pid: number): boolean {
  return sessions.has(pid)
}

/**
 * 按 agent 解析其当前存活的终端会话 pid(omp lazy spawn:进程随首个任务启动,
 * 未 spawn 时返回 null)。同 agent 多进程残留时取最新 attach 的。
 */
export function findLiveTerminalPidByAgent(channelId: string, agentId: string): number | null {
  let best: { pid: number, at: number } | null = null
  for (const [pid, s] of sessions) {
    if (!s.alive || s.meta.agentId !== agentId) continue
    if (channelId && s.meta.channelId !== channelId) continue
    if (!best || s.meta.startedAt > best.at) best = { pid, at: s.meta.startedAt }
  }
  return best?.pid ?? null
}

/** 终端会话轻量视图(lanes / 监控面轮询用) */
export interface TerminalSessionView {
  pid: number
  agentId: string | null
  channelId: string | null
  name: string | null
  role: 'lead' | 'worker' | null
  harness: string
  alive: boolean
  running: boolean
  streaming: boolean
  startedAt: number
}

/** 全部(或指定 channel 的)终端会话列表 */
export function listTerminalSessions(channelId?: string): TerminalSessionView[] {
  return [...sessions.values()]
    .filter(s => !channelId || s.meta.channelId === channelId)
    .map(s => ({
      pid: s.meta.pid,
      agentId: s.meta.agentId,
      channelId: s.meta.channelId,
      name: s.meta.name,
      role: s.meta.role,
      harness: s.meta.harness,
      alive: s.alive,
      running: s.running,
      streaming: s.streaming,
      startedAt: s.meta.startedAt,
    }))
}

/** 惰性清理:退出超过 retentionMs 的会话(防泄漏;monitor 快照时调用) */
export function sweepTerminalSessions(retentionMs = 10 * 60_000): void {
  const now = Date.now()
  for (const [pid, s] of sessions) {
    if (!s.alive) {
      const lastAt = s.ring.length > 0 ? Date.parse(s.ring[s.ring.length - 1]!.at) : s.meta.startedAt
      if (Number.isFinite(lastAt) && now - lastAt > retentionMs && s.listeners.size === 0) {
        sessions.delete(pid)
      }
    }
  }
}

/** 快照式读取:meta + 状态 + 重放缓冲(WS open 用) */
export function terminalSessionSnapshot(pid: number): {
  meta: TermSessionMeta
  alive: boolean
  streaming: boolean
  running: boolean
  lastSeq: number
  hitl: TerminalHitlDialog | null
  replay: TermFrame[]
} | null {
  const session = sessions.get(pid)
  if (!session) return null
  return {
    meta: session.meta,
    alive: session.alive,
    streaming: session.streaming,
    running: session.running,
    lastSeq: session.seq,
    hitl: session.pendingHitl,
    replay: [...session.ring],
  }
}

/** WS 订阅(先回放缓冲,再接实时流) */
export function subscribeTerminal(
  pid: number,
  listener: (msg: TerminalServerMessage) => void,
): (() => void) | null {
  const session = sessions.get(pid)
  if (!session) return null
  session.listeners.add(listener)
  return () => {
    session.listeners.delete(listener)
    // 订阅者归零时若还有待应答对话框 → 自动取消(观看者离开 = 放弃应答权)
    if (session.listeners.size === 0 && session.pendingHitl) {
      const hitl = session.pendingHitl
      respondUi(session, { id: hitl.id, cancelled: true })
      pushFrame(session, {
        type: '__terminal_notice',
        level: 'warning',
        message: `观看者已全部离开,HITL 对话框(${hitl.method} "${hitl.title.slice(0, 40)}")自动取消`,
      })
    }
  }
}

/**
 * Human 文本输入(可靠注入,与 OmpRpcAgentImpl.steer 同兜底链):
 *  - 空闲/回合已结束 → follow_up 开新回合;
 *  - 回合流式中 → steer 同轮注入;
 *  - 回合已开始但尚未输出(prompt 排队窗口)→ 短等输出开始再 steer,
 *    期间回合结束则转 follow_up。
 */
export async function sendTerminalInput(pid: number, text: string): Promise<void> {
  const session = sessions.get(pid)
  if (!session || !session.alive) throw new Error('终端会话不可用(进程未启动或已退出)')
  pushFrame(session, { type: '__human_input', text })
  try {
    if (session.streaming) {
      await session.client.send({ type: 'steer', message: text })
      return
    }
    if (session.running) {
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline && session.running && !session.streaming) {
        const { promise, resolve } = Promise.withResolvers()
        setTimeout(resolve, 150)
        await promise
      }
      if (session.streaming && session.running) {
        await session.client.send({ type: 'steer', message: text })
        return
      }
    }
    await session.client.send({ type: 'follow_up', message: text })
  }
  catch (err) {
    pushFrame(session, {
      type: '__terminal_notice',
      level: 'error',
      message: `输入注入失败: ${err instanceof Error ? err.message : String(err)}`,
    })
    throw err
  }
}

/** 中止当前回合(omp abort) */
export async function abortTerminal(pid: number): Promise<void> {
  const session = sessions.get(pid)
  if (!session || !session.alive) throw new Error('终端会话不可用')
  pushFrame(session, { type: '__terminal_notice', level: 'warning', message: '人类中止了当前回合(abort)' })
  await session.client.send({ type: 'abort' })
}

/** HITL 对话框应答(extension_ui_response side-channel 直写 stdin) */
export function respondTerminalUi(
  pid: number,
  response: { id: string, value?: string, confirmed?: boolean, cancelled?: boolean },
): void {
  const session = sessions.get(pid)
  if (!session) throw new Error('终端会话不可用')
  respondUi(session, response)
  pushFrame(session, {
    type: '__terminal_notice',
    level: 'info',
    message: `HITL 应答已提交(${response.cancelled ? '取消' : response.confirmed !== undefined ? String(response.confirmed) : `"${preview(response.value ?? '', 80)}"`})`,
  })
}

function respondUi(
  session: TerminalSession,
  response: { id: string, value?: string, confirmed?: boolean, cancelled?: boolean },
): void {
  if (session.pendingHitl && session.pendingHitl.id === response.id) session.pendingHitl = null
  const frame: Record<string, unknown> = { type: 'extension_ui_response', id: response.id }
  if (response.cancelled) {
    frame.cancelled = true
  }
  else if (response.confirmed !== undefined) {
    frame.confirmed = response.confirmed
  }
  else {
    frame.value = response.value ?? ''
  }
  try {
    session.client.writeRaw(frame)
  }
  catch (err) {
    console.error(`[harness-terminal] extension_ui_response 写入失败(pid=${session.meta.pid}):`, err)
  }
}

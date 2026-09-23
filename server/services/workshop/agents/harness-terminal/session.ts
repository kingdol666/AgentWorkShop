/**
 * 会话内部:入帧缓冲 / 定时刷帧 / 广播 / 状态与 HITL 视图
 * (由 server/services/workshop/agents/harness-terminal.ts 按职责拆出;内容逐行原文搬运)
 */
import type { TermFrame, TerminalHitlDialog, TerminalServerMessage } from '../../../../../shared/terminal-protocol'
import type { TerminalSession } from './shared'
import { TERM_RING_CAPACITY } from '../../../../../shared/terminal-protocol'
import { armParkTimer, clearParkTimer } from './park'
import { getHitlRegistry } from '../hitl-registry'

// ===== 会话内部 =====

export function pushFrame(session: TerminalSession, sanitized: Record<string, unknown>): TermFrame {
  session.seq += 1
  const f: TermFrame = { seq: session.seq, at: new Date().toISOString(), frame: sanitized }
  session.ring.push(f)
  if (session.ring.length > TERM_RING_CAPACITY) session.ring.splice(0, session.ring.length - TERM_RING_CAPACITY)
  session.batch.push(f)
  scheduleFlush(session)
  return f
}

/** 微批广播:50ms 合并窗口内帧一次发出(text_delta 洪泛保护) */
export function scheduleFlush(session: TerminalSession): void {
  if (session.batchTimer) return
  session.batchTimer = setTimeout(() => {
    session.batchTimer = null
    const frames = session.batch
    session.batch = []
    if (frames.length === 0) return
    broadcast(session, { type: 'term.frames', frames })
  }, 50)
}

export function flushNow(session: TerminalSession): void {
  if (session.batchTimer) {
    clearTimeout(session.batchTimer)
    session.batchTimer = null
  }
  const frames = session.batch
  session.batch = []
  if (frames.length > 0) broadcast(session, { type: 'term.frames', frames })
}

export function broadcast(session: TerminalSession, msg: TerminalServerMessage): void {
  for (const fn of session.listeners) {
    try {
      fn(msg)
    }
    catch {
      /* listener 异常不影响 hub */
    }
  }
}

export function setState(session: TerminalSession, patch: { running?: boolean, streaming?: boolean }): void {
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

export function broadcastState(session: TerminalSession): void {
  broadcast(session, {
    type: 'term.state',
    alive: session.alive,
    streaming: session.streaming,
    running: session.running,
  })
}

/** 当前待应答 HITL 对话框视图(下发 init 用) */
export function hitlViewOf(frame: Record<string, unknown> | null): TerminalHitlDialog | null {
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

/** HITL 对话框到达:登记 pending + hitl-registry;零订阅时进入 park 倒计时 */
export function handleUiRequest(session: TerminalSession, frame: Record<string, unknown>): void {
  const method = frame.method as string
  if (method === 'cancel') {
    // omp 主动撤销对话框(如回合中止):清 pending + 落定全局待办
    const targetId = String(frame.targetId ?? '')
    if (session.pendingHitl && session.pendingHitl.id === targetId) {
      session.pendingHitl = null
      clearParkTimer(session)
      getHitlRegistry().resolve('omp-dialog', targetId, 'cancelled')
    }
    return
  }
  const view = hitlViewOf(frame)
  if (!view) return
  session.pendingHitl = view
  getHitlRegistry().register({
    kind: 'omp-dialog',
    id: view.id,
    agentId: session.meta.agentId,
    agentName: session.meta.name,
    channelId: session.meta.channelId,
    pid: session.meta.pid,
    method: view.method,
    title: view.title,
    options: view.options,
    message: view.message,
  })
  if (session.listeners.size === 0) armParkTimer(session)
}

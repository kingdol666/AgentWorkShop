/**
 * 对外 API:挂接/摘除 tap、退出标记、查询与快照
 * (由 server/services/workshop/agents/harness-terminal.ts 按职责拆出;内容逐行原文搬运)
 */
import type { OmpRpcClient } from '../adapters/omp-rpc-client'
import type { TermFrame, TermSessionMeta, TerminalHitlDialog } from '../../../../../shared/terminal-protocol'
import type { TerminalSession } from './shared'
import { broadcastState, flushNow, handleUiRequest, pushFrame, setState } from './session'
import { clearParkTimer } from './park'
import { getHitlRegistry } from '../hitl-registry'
import { sanitizeFrame } from './sanitize'
import { sessions } from './shared'

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
    parkTimer: null,
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
  if (session.pendingHitl) {
    getHitlRegistry().resolve('omp-dialog', session.pendingHitl.id, 'cancelled')
    session.pendingHitl = null
  }
  clearParkTimer(session)
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

/** 惰性清理:退出超过 retentionMs 且无订阅者的会话(防泄漏;monitor 快照时调用) */
export function sweepTerminalSessions(retentionMs = 60_000): void {
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

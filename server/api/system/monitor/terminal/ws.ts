/**
 * WebSocket 端点: /api/system/monitor/terminal/ws?pid=<pid>&token=<userToken>
 *
 * harness 终端通道(协议权威 #shared/terminal-protocol):
 *  - 下行:term.init(会话元信息+状态) → term.frames(重放缓冲 + 实时帧微批)
 *          / term.state(回合·流式状态) / term.notice / term.error / pong
 *  - 上行:ping / input(steer·follow_up 注入 omp 会话)/ abort(中止回合)/
 *          ui_response(HITL 对话框应答 → extension_ui_response)
 *
 * 鉴权:用户 token(?token= 查询参数,与管理 API 同口径)——终端可向
 * 真实 agent 会话注入输入(HITL),必须认证。
 */
import { defineWebSocketHandler } from 'h3'
import { resolveUserByToken } from '../../../../services/user.service'
import {
  abortTerminal,
  findLiveTerminalPidByAgent,
  respondTerminalUi,
  sendTerminalInput,
  subscribeTerminal,
  terminalSessionSnapshot,
} from '../../../../services/workshop/agents/harness-terminal'
import type { TerminalClientMessage, TerminalServerMessage } from '../../../../../shared/terminal-protocol'

/** 最小 peer 接口(h3 2.x 未 re-export crossws 类型,duck typing;与 workshop ws.ts 同风格) */
interface WsPeer {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

function resolveQueryParam(peer: WsPeer, name: string): string | undefined {
  const req = (peer as unknown as { request?: Request }).request
  if (!req) return undefined
  return new URL(req.url).searchParams.get(name) ?? undefined
}

function send(peer: WsPeer, msg: TerminalServerMessage): void {
  try {
    peer.send(JSON.stringify(msg))
  }
  catch { /* 死连接 */ }
}

function fail(peer: WsPeer, code: string, message: string, wsCode = 4400): void {
  send(peer, { type: 'term.error', code, message })
  peer.close(wsCode, message)
}

export default defineWebSocketHandler({
  open(peer) {
    const ws = peer as unknown as WsPeer

    // 鉴权:?token= 用户 token(管理面同口径)
    const token = resolveQueryParam(ws, 'token')
    if (!token || !resolveUserByToken(token)) {
      fail(ws, 'USER_UNAUTHORIZED', '需要有效用户 token(?token= 查询参数)', 4401)
      return
    }

    // 寻址:优先 pid;否则 agentId(+可选 channelId)解析当前存活进程
    // (omp lazy spawn:进程随首个任务启动;agent 寻址下前端断线重连/进程
    // 重启后自动落到新会话)
    const pidRaw = Number.parseInt(resolveQueryParam(ws, 'pid') ?? '', 10)
    const agentId = resolveQueryParam(ws, 'agentId')
    let pid: number
    if (Number.isInteger(pidRaw) && pidRaw > 0) {
      pid = pidRaw
    }
    else if (agentId) {
      const resolved = findLiveTerminalPidByAgent(resolveQueryParam(ws, 'channelId') ?? '', agentId)
      if (!resolved) {
        fail(ws, 'NO_SESSION', `agent ${agentId.slice(0, 8)} 的 omp 进程尚未启动(等待首个任务触发 spawn)`, 4404)
        return
      }
      pid = resolved
    }
    else {
      fail(ws, 'BAD_PID', '缺少有效 pid 或 agentId 查询参数', 4400)
      return
    }

    const snap = terminalSessionSnapshot(pid)
    if (!snap) {
      fail(ws, 'NO_SESSION', `PID ${pid} 无终端镜像会话(进程未启动或非 omp harness)`, 4404)
      return
    }

    send(ws, {
      type: 'term.init',
      meta: snap.meta,
      alive: snap.alive,
      streaming: snap.streaming,
      running: snap.running,
      lastSeq: snap.lastSeq,
      hitl: snap.hitl,
    })
    // 重放缓冲(全量;环形缓冲上限内,前端按 seq 渲染)
    if (snap.replay.length > 0) {
      send(ws, { type: 'term.frames', frames: snap.replay })
    }

    const unsub = subscribeTerminal(pid, msg => send(ws, msg))
    if (!unsub) {
      fail(ws, 'NO_SESSION', `PID ${pid} 终端会话已消失`, 4404)
      return
    }
    const holder = peer as unknown as { __unsub?: () => void, __termPid?: number }
    holder.__unsub = unsub
    holder.__termPid = pid
  },

  message(peer, message) {
    const ws = peer as unknown as WsPeer
    const raw = message.text()
    if (!raw) return
    let parsed: TerminalClientMessage
    try {
      parsed = JSON.parse(raw) as TerminalClientMessage
    }
    catch {
      send(ws, { type: 'term.error', code: 'BAD_MESSAGE', message: '无法解析的上行消息(需 JSON)' })
      return
    }

    // open 时解析并缓存的 pid(pid 直连或 agentId 解析结果)
    const pid = (peer as unknown as { __termPid?: number }).__termPid
    if (!Number.isInteger(pid)) return
    const targetPid = pid as number

    switch (parsed.type) {
      case 'ping':
        send(ws, { type: 'pong' })
        return
      case 'input': {
        const text = parsed.text?.trim()
        if (!text) return
        sendTerminalInput(targetPid, text).catch((err: unknown) => {
          send(ws, { type: 'term.error', code: 'INPUT_FAILED', message: err instanceof Error ? err.message : String(err) })
        })
        return
      }
      case 'abort': {
        abortTerminal(targetPid).catch((err: unknown) => {
          send(ws, { type: 'term.error', code: 'ABORT_FAILED', message: err instanceof Error ? err.message : String(err) })
        })
        return
      }
      case 'ui_response': {
        if (!parsed.id) return
        try {
          respondTerminalUi(targetPid, {
            id: parsed.id,
            value: typeof parsed.value === 'string' ? parsed.value : undefined,
            confirmed: typeof parsed.confirmed === 'boolean' ? parsed.confirmed : undefined,
            cancelled: parsed.cancelled === true,
          })
        }
        catch (err) {
          send(ws, { type: 'term.error', code: 'UI_RESPONSE_FAILED', message: err instanceof Error ? err.message : String(err) })
        }
        return
      }
      default:
        send(ws, { type: 'term.error', code: 'UNKNOWN_COMMAND', message: `未知上行消息类型: ${(parsed as { type?: string }).type}` })
    }
  },

  close(peer) {
    (peer as unknown as { __unsub?: () => void }).__unsub?.()
  },

  error(peer, error) {
    console.error('[terminal-ws] connection error:', error)
    const holder = peer as unknown as { __unsub?: () => void }
    holder.__unsub?.()
  },
})

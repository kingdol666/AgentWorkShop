/**
 * 对外 IO:订阅 / 输入 / 中断 / UI 应答
 * (由 server/services/workshop/agents/harness-terminal.ts 按职责拆出;内容逐行原文搬运)
 */
import type { TerminalServerMessage } from '../../../../../shared/terminal-protocol'
import type { TerminalSession } from './shared'
import { armParkTimer, clearParkTimer } from './park'
import { getHitlRegistry } from '../hitl-registry'
import { log, sessions } from './shared'
import { preview } from './sanitize'
import { pushFrame } from './session'

export function subscribeTerminal(
  pid: number,
  listener: (msg: TerminalServerMessage) => void,
): (() => void) | null {
  const session = sessions.get(pid)
  if (!session) return null
  const wasEmpty = session.listeners.size === 0
  session.listeners.add(listener)
  if (wasEmpty && session.pendingHitl) {
    // 有人观看:暂停 park 倒计时(真 HITL 等待无上限;观看者离开后重新计时)
    clearParkTimer(session)
    getHitlRegistry().setParkDeadline('omp-dialog', session.pendingHitl.id, null)
  }
  return () => {
    session.listeners.delete(listener)
    // 订阅者归零时若还有待应答对话框:park 倒计时(超时自动取消;不再是秒取消)
    if (session.listeners.size === 0 && session.pendingHitl) armParkTimer(session)
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

export function respondUi(
  session: TerminalSession,
  response: { id: string, value?: string, confirmed?: boolean, cancelled?: boolean },
): void {
  if (session.pendingHitl && session.pendingHitl.id === response.id) session.pendingHitl = null
  clearParkTimer(session)
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
    log.error(`[harness-terminal] extension_ui_response 写入失败(pid=${session.meta.pid}):`, err)
  }
  // 全局待办落定(expired 收敛路径已先行 resolve,此处幂等 no-op)
  getHitlRegistry().resolve('omp-dialog', response.id, response.cancelled ? 'cancelled' : 'answered')
}

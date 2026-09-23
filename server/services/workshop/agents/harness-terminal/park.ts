/**
 * park 倒计时(无人观看挂起 / 接入暂停 / 待办过期)
 * (由 server/services/workshop/agents/harness-terminal.ts 按职责拆出;内容逐行原文搬运)
 */
import type { TerminalSession } from './shared'
import { getHitlRegistry } from '../hitl-registry'
import { pushFrame } from './session'
import { respondUi } from './io'
import { securityHitlTimeoutMs } from '../../settings'

// ===== park 倒计时(无人观看时挂起等待;有人接入暂停) =====

/** 零订阅 park 窗口(security.hitl_timeout_ms;0 = 恢复旧的"无人即秒取消") */
export const HITL_PARK_MS = (): number => securityHitlTimeoutMs()

export function clearParkTimer(session: TerminalSession): void {
  if (session.parkTimer) {
    clearTimeout(session.parkTimer)
    session.parkTimer = null
  }
}

/** 进入 park(仅零订阅且有待答对话框时生效;TTL<=0 立即取消 = 旧行为) */
export function armParkTimer(session: TerminalSession): void {
  clearParkTimer(session)
  if (!session.pendingHitl || session.listeners.size > 0) return
  const ttl = HITL_PARK_MS()
  if (ttl <= 0) {
    expirePendingHitl(session, true)
    return
  }
  getHitlRegistry().setParkDeadline('omp-dialog', session.pendingHitl.id, new Date(Date.now() + ttl).toISOString())
  session.parkTimer = setTimeout(() => {
    session.parkTimer = null
    if (session.pendingHitl && session.listeners.size === 0) expirePendingHitl(session)
  }, ttl)
  session.parkTimer.unref?.()
}

/** park 到期(或 TTL=0 立即):超时收敛 —— 先落定 expired,再走 cancelled 应答写 omp stdin */
export function expirePendingHitl(session: TerminalSession, immediate = false): void {
  const hitl = session.pendingHitl
  if (!hitl) return
  session.pendingHitl = null
  clearParkTimer(session)
  getHitlRegistry().resolve('omp-dialog', hitl.id, 'expired')
  respondUi(session, { id: hitl.id, cancelled: true })
  pushFrame(session, {
    type: '__terminal_notice',
    level: 'warning',
    message: immediate
      ? `HITL 对话框(${hitl.method} "${hitl.title.slice(0, 40)}")无人接入,已自动取消`
      : `HITL 对话框(${hitl.method} "${hitl.title.slice(0, 40)}")park 超时无人处理,已自动取消`,
  })
}

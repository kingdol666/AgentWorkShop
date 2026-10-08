/**
 * line-notify —— 线域定向通知(生产化 2026-10-08)。
 *
 * 为什么不走频道通告(platform-notice):审批/写控错误是**产线域**事件,触达对象应是
 * "对该线有 operate 授权的运营者"(权限模型 v3 user_line_grants),他们不一定在
 * Agent 作业频道里。本模块把「线 id → 授权用户」的反查 + 用户级定向通知
 * (持久化 + WS,复用 manager.notifyUser 的 user_notifications 通道)收敛成一处。
 *
 * 失败静默:通知永不击穿业务主链路(与 recordOps 同口径)。
 */
import { userRepository } from '@/server/repositories/user.repository'
import { createLogger } from '../logger'

const log = createLogger('workshop.line-notify')

/** 运行时通知面(hitl-registry.HitlRuntimePort.notifyUser 的结构子集) */
interface NotifyUserPort {
  notifyUser(input: {
    recipientUserId: string
    channelId?: string | null
    type: 'mention' | 'agent_reply' | 'hitl_request' | 'hitl_resolved' | 'member'
    eventId: string
    title?: string
    body?: string
    hitlKind?: string | null
    hitlId?: string | null
    payload?: Record<string, unknown>
  }): { id: string, inserted: boolean }
}

function notifyPort(): NotifyUserPort | null {
  const g = globalThis as typeof globalThis & { __workshopManager?: NotifyUserPort }
  return g.__workshopManager ?? null
}

/**
 * 向一条产线的全部 operate 授权用户投递定向通知(已持久化 + 在线 WS 直推)。
 * @returns 实际插入的通知条数(重复 eventId 幂等去重后)
 */
export function notifyLineOperators(lineId: string, input: {
  eventId: string
  title: string
  body?: string
  hitlKind?: string
  hitlId?: string
  payload?: Record<string, unknown>
}): number {
  if (!lineId) return 0
  const manager = notifyPort()
  if (!manager) return 0
  let n = 0
  try {
    const operators = userRepository.usersOfLine(lineId).filter(op => op.mode === 'operate')
    for (const op of operators) {
      try {
        const r = manager.notifyUser({
          recipientUserId: op.userId,
          channelId: null,
          type: 'hitl_request',
          eventId: input.eventId,
          title: input.title,
          body: input.body ?? '',
          hitlKind: input.hitlKind ?? null,
          hitlId: input.hitlId ?? null,
          payload: input.payload,
        })
        if (r.inserted) n++
      }
      catch { /* 单个用户失败不影响扇出 */ }
    }
  }
  catch (err) {
    log.warn('[line-notify] 线域通知投递失败(不影响主流程):', err instanceof Error ? err.message : err)
  }
  return n
}

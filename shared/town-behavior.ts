/**
 * TownBehavior — 小镇 AI 角色行为纯决策层。
 *
 * 标准 AI 控制游戏架构的事件 → 决策 → 动作链的「决策」部分:
 *  - parseActionFromEnvelope(e):AEP 通信/任务事件 → ActionContext(发送方/接收方/类型/是否等待回复)。
 *    纯函数,零 Phaser 依赖,可单测。
 *  - stepToward(cur, target, speed, dt):匀速移动一步,返回下一个位置 + 是否到达 + 朝向。
 *    物理运动由场景执行,这里只做确定性步进计算(可单测)。
 *
 * ActionContext 语义:
 *  - sender(发送方)需跑到 recipient(接收方)身边「下发」;
 *  - 若 requireReply 或 kind=task → sender 在接收方附近「等待回复/执行结果」;
 *  - 否则送达即返回。
 */
import type { AepEnvelope } from './workshop-protocol'

/** 行为动作类别 */
export type ActionKind = 'task' | 'message' | 'reply'

/** 一次「跑去对面下发/通信」的上下文 */
export interface ActionContext {
  channelId: string
  /** 发送方(sender 跑去 recipient 身边) */
  fromId: string
  /** 接收方(recipient) */
  toId: string
  kind: ActionKind
  /** 任务类投递(assign/cancel/child-completed 等) */
  taskKind?: string
  /** 是否需要等待回复(require_reply) */
  requireReply: boolean
  /** 下发/通信文本(bubble 内容) */
  text: string
}

/** 一帧 AEP 的文本(与 town-protocol.partsToText 同口径) */
function partsToText(parts: Array<{ text?: string } | { data?: unknown }>): string {
  return parts
    .map(p => 'text' in p ? (p.text ?? '') : 'data' in p ? JSON.stringify(p.data) : '')
    .join('\n')
    .trim()
}

/**
 * 从 AEP 信封解析出行为动作。
 * 命中「点对点通信/任务投递」类事件才返回;未命中返回 null。
 * 依赖 metadata 的 from/target/task-kind/require-reply 字段(与 service 层投递契约一致)。
 *
 * 注意:mock harness 的任务投递消息 metadata 只带 x-aw-task-kind + x-aw-from-agent,
 * 收件方由 route 从任务的 assigneeId 解析,x-aw-target-agent 可能缺省。
 * 因此传入 opts.resolveTaskAssignee 用于任务类消息按 taskId 反查收件方。
 */
export function parseActionFromEnvelope(
  e: AepEnvelope,
  opts?: { resolveTaskAssignee?: (taskId: string) => string | null },
): ActionContext | null {
  switch (e.type) {
    case 'a2a.message': {
      const msg = e.payload as { parts?: Array<{ text?: string } | { data?: unknown }>, metadata?: Record<string, unknown>, contextId?: string }
      const meta = msg.metadata ?? {}
      const fromId = typeof meta['x-aw-from-agent'] === 'string' ? meta['x-aw-from-agent'] as string : (e.agentId ?? '')
      let toId = typeof meta['x-aw-target-agent'] === 'string' ? meta['x-aw-target-agent'] as string : ''
      const taskKind = typeof meta['x-aw-task-kind'] === 'string' ? meta['x-aw-task-kind'] as string : undefined
      const taskId = typeof meta['x-aw-task-id'] === 'string' ? meta['x-aw-task-id'] as string : (e.taskId ?? '')
      // 任务投递缺 target-agent 时按 taskId 反查 assignee
      if (!toId && taskKind && taskId && opts?.resolveTaskAssignee) {
        toId = opts.resolveTaskAssignee(taskId) ?? ''
      }
      // 消息类事件必须有明确收件方,否则无法驱动「跑去下发」
      if (!toId) return null
      const requireReply = meta['x-aw-require-reply'] === 'true' || taskKind === 'assign'
      const text = partsToText(msg.parts ?? [])
      const kind: ActionKind = taskKind ? 'task' : 'message'
      return {
        channelId: e.channelId,
        fromId,
        toId,
        kind,
        taskKind,
        requireReply,
        text: text || (taskKind === 'assign' ? '下发任务' : '发送消息'),
      }
    }
    case 'agent.message': {
      const msg = e.payload as { parts?: Array<{ text?: string } | { data?: unknown }>, metadata?: Record<string, unknown> }
      const meta = msg.metadata ?? {}
      const fromId = e.agentId ?? ''
      const toId = typeof meta['x-aw-target-agent'] === 'string' ? meta['x-aw-target-agent'] as string : ''
      if (!toId) return null
      const requireReply = meta['x-aw-require-reply'] === 'true'
      return {
        channelId: e.channelId,
        fromId,
        toId,
        kind: 'message',
        requireReply,
        text: partsToText(Array.isArray(msg.parts) ? msg.parts : []),
      }
    }
    default:
      return null
  }
}

/** 到达判定距离(px;两个角色的 arcade body 约 12~14px 宽 + 间距,需略大于 body 尺寸,
 *  否则角色被彼此 body 挡住,卡在"就差 1~2px"的位置永远到不了,呈停滞 approach) */
export const ARRIVE_DIST = 48

/**
 * 匀速移动一步:从 cur 朝 target 前进 speed*dt 像素。
 * 返回下一个位置、是否到达、水平朝向(供 sprite flip)。
 */
export function stepToward(
  cur: { x: number, y: number },
  target: { x: number, y: number },
  speed: number,
  dt: number,
): { x: number, y: number, arrived: boolean, dir: 'left' | 'right' | 'none' } {
  const dx = target.x - cur.x
  const dy = target.y - cur.y
  const dist = Math.hypot(dx, dy)
  const dir: 'left' | 'right' | 'none' = dx < -1 ? 'left' : dx > 1 ? 'right' : 'none'
  if (dist <= ARRIVE_DIST || dist === 0) {
    return { x: cur.x, y: cur.y, arrived: true, dir }
  }
  const stepLen = speed * dt
  if (stepLen >= dist) {
    return { x: target.x, y: target.y, arrived: true, dir }
  }
  return {
    x: cur.x + (dx / dist) * stepLen,
    y: cur.y + (dy / dist) * stepLen,
    arrived: false,
    dir,
  }
}

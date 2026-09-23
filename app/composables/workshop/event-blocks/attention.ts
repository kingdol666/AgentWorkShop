/**
 * 注意力档位(open-tag deliveryTier 移植)。
 */
import type { AepEnvelope } from '#shared/workshop-protocol'

/**
 * 四级注意力档位:一条事件"该不该打断人"的一锤定音。
 * 多智能体时间线里 agent 中间态噪声是最大痛点——工具调用/打字机增量归入
 * silent,状态迁移归 status,只有"需要决策/等待回应"浮到 attention,
 * "最终结果/交付/终态"浮到 terminal。渲染与过滤都消费本档位,不再各自硬编码。
 */
export type AttentionTier = 'silent' | 'status' | 'attention' | 'terminal'

const TIER_ORDER: Record<AttentionTier, number> = { silent: 0, status: 1, attention: 2, terminal: 3 }

/** 事件 → 注意力档位 */
export function envelopeTier(e: AepEnvelope): AttentionTier {
  switch (e.type) {
    case 'error':
      return 'attention'
    case 'a2a.artifact':
    case 'agent.message':
      // 交付物 / 落定的完整回复 = 终局产出
      return 'terminal'
    case 'task.status': {
      const s = String((e.payload as { state?: string }).state ?? '')
      // 终态浮顶层;WAITING(等待子任务/外部条件)是需要人知悉的注意级
      if (s === 'COMPLETED' || s === 'FAILED' || s === 'CANCELED') return 'terminal'
      if (s === 'WAITING') return 'attention'
      return 'status'
    }
    case 'a2a.message': {
      const meta = (e.payload as { metadata?: Record<string, unknown> }).metadata ?? {}
      // 要求回复的协作消息 = 等待对方响应(注意级)
      return meta['x-aw-require-reply'] === 'true' ? 'attention' : 'status'
    }
    case 'agent.delta':
    case 'agent.status.message':
    case 'task.progress':
    case 'memory.saved':
      // 过程性噪声:打字机增量 / 工具文本 / 进度 / 记忆沉淀
      return 'silent'
    case 'agent.status':
    case 'agent.member':
    default:
      return 'status'
  }
}

/** 块 → 注意力档位(块内最高档;终局产出块不被同块 silent 帧拉低) */
export function blockTier(events: AepEnvelope[]): AttentionTier {
  let best: AttentionTier = 'silent'
  for (const e of events) {
    const t = envelopeTier(e)
    if (TIER_ORDER[t] > TIER_ORDER[best]) best = t
  }
  return best
}
